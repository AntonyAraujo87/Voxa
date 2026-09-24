use super::{Inner, StreamRole};
use std::{
    collections::{HashMap, VecDeque},
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicI64, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use tokio::{net::UdpSocket, sync::broadcast, time};
use voxa_native_core::{
    congestion::CongestionController,
    loss::LossEstimator,
    protocol::{self, Kind, Meta, ReplayGuard, StreamConfig, VideoCodec},
    reassembly::Reassembler,
};

pub struct TransportControl {
    stop: Arc<AtomicBool>,
    outgoing: Arc<Mutex<Option<EncodedFrame>>>,
    incoming: Arc<Mutex<Option<EncodedFrame>>>,
    outgoing_audio: Arc<Mutex<VecDeque<AudioPacket>>>,
    incoming_audio: Arc<Mutex<VecDeque<AudioPacket>>>,
    outgoing_cursor: Arc<Mutex<Option<CursorPacket>>>,
    incoming_cursor: Arc<Mutex<Option<CursorPacket>>>,
    outgoing_config: Arc<Mutex<Option<StreamConfig>>>,
    incoming_config: Arc<Mutex<Option<StreamConfig>>>,
    force_keyframe: Arc<AtomicBool>,
    request_remote_keyframe: Arc<AtomicBool>,
    bitrate_bps: Arc<AtomicU32>,
    peer_codecs: Arc<AtomicU32>,
    clock_offset_us: Arc<AtomicI64>,
    tasks: Vec<JoinHandle<()>>,
    native_thread: Option<std::thread::JoinHandle<()>>,
}

pub struct PeerTransport {
    pub endpoint: SocketAddr,
    pub relay: Option<(SocketAddr, u64, u64)>,
    pub id: String,
    pub codecs: u8,
}

#[derive(Clone)]
pub struct TransportHandle {
    stop: Arc<AtomicBool>,
    outgoing: Arc<Mutex<Option<EncodedFrame>>>,
    incoming: Arc<Mutex<Option<EncodedFrame>>>,
    outgoing_audio: Arc<Mutex<VecDeque<AudioPacket>>>,
    incoming_audio: Arc<Mutex<VecDeque<AudioPacket>>>,
    outgoing_cursor: Arc<Mutex<Option<CursorPacket>>>,
    incoming_cursor: Arc<Mutex<Option<CursorPacket>>>,
    outgoing_config: Arc<Mutex<Option<StreamConfig>>>,
    incoming_config: Arc<Mutex<Option<StreamConfig>>>,
    force_keyframe: Arc<AtomicBool>,
    request_remote_keyframe: Arc<AtomicBool>,
    bitrate_bps: Arc<AtomicU32>,
    peer_codecs: Arc<AtomicU32>,
    clock_offset_us: Arc<AtomicI64>,
}

#[derive(Clone)]
pub struct DatagramHub {
    socket: Arc<UdpSocket>,
    sender: broadcast::Sender<(Arc<Vec<u8>>, SocketAddr)>,
    stop: Arc<AtomicBool>,
}

impl DatagramHub {
    pub fn new(socket: Arc<UdpSocket>) -> Self {
        let (sender, _) = broadcast::channel(4_096);
        let stop = Arc::new(AtomicBool::new(false));
        let read_socket = socket.clone();
        let read_sender = sender.clone();
        let read_stop = stop.clone();
        tauri::async_runtime::spawn(async move {
            let mut buffer = [0u8; protocol::MAX_DATAGRAM];
            while !read_stop.load(Ordering::Acquire) {
                match time::timeout(
                    Duration::from_millis(100),
                    read_socket.recv_from(&mut buffer),
                )
                .await
                {
                    Ok(Ok((len, source)))
                        if len >= protocol::HEADER_LEN
                            && buffer[..4] == *b"VOXA"
                            && buffer[4] == 1 =>
                    {
                        let _ = read_sender.send((Arc::new(buffer[..len].to_vec()), source));
                    }
                    Ok(Ok(_)) => {}
                    Ok(Err(_)) => time::sleep(Duration::from_millis(25)).await,
                    Err(_) => {}
                }
            }
        });
        Self {
            socket,
            sender,
            stop,
        }
    }

    fn subscribe(&self) -> broadcast::Receiver<(Arc<Vec<u8>>, SocketAddr)> {
        self.sender.subscribe()
    }

    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
    }
}

#[derive(Clone, Default)]
pub struct HostTransportHandle {
    peers: Arc<Mutex<HashMap<String, TransportHandle>>>,
    configs: Arc<Mutex<HashMap<(String, VideoCodec), StreamConfig>>>,
    supported_codecs: Arc<AtomicU32>,
    force_keyframe: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

fn negotiated_codec(local: u8, remote: u8) -> Option<VideoCodec> {
    VideoCodec::best_common(local, remote)
}

fn opus_bitrate_for_video(video_bitrate: u32) -> i32 {
    match video_bitrate {
        0..=1_499_999 => 64_000,
        1_500_000..=3_999_999 => 80_000,
        4_000_000..=7_999_999 => 96_000,
        _ => 128_000,
    }
}

impl HostTransportHandle {
    pub fn add(&self, peer_id: String, handle: TransportHandle) {
        if let Some(codec) = self.codec_for(&handle) {
            if let Some(config) = self
                .configs
                .lock()
                .ok()
                .and_then(|configs| configs.get(&(peer_id.clone(), codec)).copied())
            {
                handle.queue_config(config);
            }
        }
        if let Ok(mut peers) = self.peers.lock() {
            peers.insert(peer_id, handle);
        }
        self.force_keyframe.store(true, Ordering::Release);
    }
    pub fn remove(&self, peer_id: &str) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.remove(peer_id);
        }
        if let Ok(mut configs) = self.configs.lock() {
            configs.retain(|(configured_peer, _), _| configured_peer != peer_id);
        }
    }
    pub fn clear(&self) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.clear();
        }
        if let Ok(mut configs) = self.configs.lock() {
            configs.clear();
        }
    }
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
    pub fn has_peers(&self) -> bool {
        self.peers
            .lock()
            .map(|peers| !peers.is_empty())
            .unwrap_or(false)
    }
    pub fn audio_bitrate_bps(&self) -> i32 {
        let video = self
            .peers
            .lock()
            .ok()
            .and_then(|peers| peers.values().map(TransportHandle::target_bitrate).min())
            .unwrap_or(12_000_000);
        opus_bitrate_for_video(video)
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.clear();
    }
    pub fn set_supported_codecs(&self, codecs: u8) {
        self.supported_codecs
            .store(u32::from(codecs), Ordering::Release);
    }
    fn codec_for(&self, handle: &TransportHandle) -> Option<VideoCodec> {
        negotiated_codec(
            self.supported_codecs.load(Ordering::Acquire) as u8,
            handle.peer_codecs.load(Ordering::Acquire) as u8,
        )
    }
    pub fn peers_support_any(&self, local_codecs: u8) -> bool {
        self.peers
            .lock()
            .map(|peers| {
                peers.values().all(|handle| {
                    negotiated_codec(
                        local_codecs,
                        handle.peer_codecs.load(Ordering::Acquire) as u8,
                    )
                    .is_some()
                })
            })
            .unwrap_or(false)
    }
    pub fn queue_video(&self, peer_id: &str, codec: VideoCodec, frame: EncodedFrame) -> bool {
        let handle = self
            .peers
            .lock()
            .ok()
            .and_then(|peers| peers.get(peer_id).cloned());
        handle
            .filter(|handle| self.codec_for(handle) == Some(codec))
            .map(|handle| handle.queue_video(frame))
            .unwrap_or(false)
    }
    pub fn queue_config(&self, peer_id: &str, config: StreamConfig) {
        if let Ok(mut current) = self.configs.lock() {
            current.insert((peer_id.to_owned(), config.codec), config);
        }
        if let Ok(peers) = self.peers.lock() {
            if let Some(handle) = peers.get(peer_id) {
                if self.codec_for(handle) == Some(config.codec) {
                    handle.queue_config(config);
                }
            }
        }
    }
    pub fn take_keyframe_request(&self) -> bool {
        self.force_keyframe.swap(false, Ordering::AcqRel)
            || self
                .peers
                .lock()
                .map(|peers| peers.values().any(TransportHandle::take_keyframe_request))
                .unwrap_or(false)
    }
    pub fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::Release);
    }
    pub fn active_lanes(&self) -> Vec<(String, VideoCodec, u32)> {
        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        peers
            .iter()
            .filter_map(|(peer_id, handle)| {
                self.codec_for(handle)
                    .map(|codec| (peer_id.clone(), codec, handle.target_bitrate()))
            })
            .collect()
    }
    pub fn queue_audio(&self, packet: AudioPacket) {
        if let Ok(peers) = self.peers.lock() {
            for handle in peers.values() {
                handle.queue_audio(packet.clone());
            }
        }
    }
    pub fn queue_cursor(&self, cursor: CursorPacket) {
        if let Ok(peers) = self.peers.lock() {
            for handle in peers.values() {
                handle.queue_cursor(cursor.clone());
            }
        }
    }
}

#[derive(Clone)]
pub struct EncodedFrame {
    pub id: u64,
    pub timestamp_us: u64,
    pub keyframe: bool,
    // O bitstream e imutavel. Arc evita copiar um frame H.264 inteiro para
    // cada espectador no fanout do host.
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct AudioPacket {
    pub timestamp_us: u64,
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorPacket {
    pub timestamp_us: u64,
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub source_width: u32,
    pub source_height: u32,
}

impl CursorPacket {
    const WIRE_LEN: usize = 17;

    fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut bytes = [0u8; Self::WIRE_LEN];
        bytes[0] = u8::from(self.visible);
        bytes[1..5].copy_from_slice(&self.x.to_be_bytes());
        bytes[5..9].copy_from_slice(&self.y.to_be_bytes());
        bytes[9..13].copy_from_slice(&self.source_width.to_be_bytes());
        bytes[13..17].copy_from_slice(&self.source_height.to_be_bytes());
        bytes
    }

    fn decode(timestamp_us: u64, bytes: &[u8]) -> Option<Self> {
        if bytes.len() != Self::WIRE_LEN || bytes[0] > 1 {
            return None;
        }
        let cursor = Self {
            timestamp_us,
            visible: bytes[0] == 1,
            x: i32::from_be_bytes(bytes[1..5].try_into().ok()?),
            y: i32::from_be_bytes(bytes[5..9].try_into().ok()?),
            source_width: u32::from_be_bytes(bytes[9..13].try_into().ok()?),
            source_height: u32::from_be_bytes(bytes[13..17].try_into().ok()?),
        };
        (cursor.source_width > 0 && cursor.source_height > 0).then_some(cursor)
    }
}

const RELAY_MAGIC: &[u8; 4] = b"VRLY";
const RELAY_HEADER: usize = 22;

struct Route {
    socket: Arc<UdpSocket>,
    direct: SocketAddr,
    relay: Option<(SocketAddr, u64, u64, u8)>,
    selected: AtomicU32,
}

impl Route {
    async fn send(&self, bytes: &[u8]) -> Result<(), String> {
        match self.selected.load(Ordering::Acquire) {
            1 => self
                .socket
                .send_to(bytes, self.direct)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            2 => self.send_relay(bytes).await,
            _ => {
                let direct = self
                    .socket
                    .send_to(bytes, self.direct)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                let relayed = if self.relay.is_some() {
                    self.send_relay(bytes).await
                } else {
                    Ok(())
                };
                direct.or(relayed)
            }
        }
    }

    async fn send_relay(&self, bytes: &[u8]) -> Result<(), String> {
        let (endpoint, session, auth, role) = self.relay.ok_or("Relay UDP indisponível")?;
        let mut packet = Vec::with_capacity(RELAY_HEADER + bytes.len());
        packet.extend_from_slice(RELAY_MAGIC);
        packet.extend_from_slice(&[1, role]);
        packet.extend_from_slice(&session.to_be_bytes());
        packet.extend_from_slice(&auth.to_be_bytes());
        packet.extend_from_slice(bytes);
        self.socket
            .send_to(&packet, endpoint)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    fn select(&self, source: SocketAddr) -> u32 {
        let current = self.selected.load(Ordering::Acquire);
        if current != 0 {
            return current;
        }
        let route = if self.relay.is_some_and(|relay| relay.0 == source) {
            2
        } else if source == self.direct {
            1
        } else {
            0
        };
        if route != 0 {
            let _ = self
                .selected
                .compare_exchange(0, route, Ordering::AcqRel, Ordering::Acquire);
        }
        self.selected.load(Ordering::Acquire)
    }

    fn reset(&self) {
        self.selected.store(0, Ordering::Release);
    }
}

impl TransportControl {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Release);
        for task in self.tasks {
            task.abort();
        }
        if let Some(thread) = self.native_thread.take() {
            let _ = thread.join();
        }
    }
    pub fn handle(&self) -> TransportHandle {
        TransportHandle {
            stop: self.stop.clone(),
            outgoing: self.outgoing.clone(),
            incoming: self.incoming.clone(),
            outgoing_audio: self.outgoing_audio.clone(),
            incoming_audio: self.incoming_audio.clone(),
            outgoing_cursor: self.outgoing_cursor.clone(),
            incoming_cursor: self.incoming_cursor.clone(),
            outgoing_config: self.outgoing_config.clone(),
            incoming_config: self.incoming_config.clone(),
            force_keyframe: self.force_keyframe.clone(),
            request_remote_keyframe: self.request_remote_keyframe.clone(),
            bitrate_bps: self.bitrate_bps.clone(),
            peer_codecs: self.peer_codecs.clone(),
            clock_offset_us: self.clock_offset_us.clone(),
        }
    }
    pub fn attach_native_thread(&mut self, thread: std::thread::JoinHandle<()>) {
        self.native_thread = Some(thread);
    }
}

impl TransportHandle {
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
    pub fn queue_video(&self, frame: EncodedFrame) -> bool {
        self.outgoing
            .lock()
            .map(|mut slot| slot.replace(frame).is_some())
            .unwrap_or(true)
    }
    pub fn queue_config(&self, config: StreamConfig) {
        if let Ok(mut slot) = self.outgoing_config.lock() {
            *slot = Some(config);
        }
    }
    pub fn current_config(&self) -> Option<StreamConfig> {
        self.incoming_config.lock().ok().and_then(|slot| *slot)
    }
    pub fn take_video(&self) -> Option<EncodedFrame> {
        self.incoming.lock().ok().and_then(|mut slot| slot.take())
    }
    pub fn queue_audio(&self, packet: AudioPacket) {
        if let Ok(mut queue) = self.outgoing_audio.lock() {
            if queue.len() >= 4 {
                queue.pop_front();
            }
            queue.push_back(packet);
        }
    }
    pub fn take_audio(&self) -> Option<AudioPacket> {
        self.incoming_audio
            .lock()
            .ok()
            .and_then(|mut queue| queue.pop_front())
    }
    pub fn queue_cursor(&self, cursor: CursorPacket) {
        if let Ok(mut slot) = self.outgoing_cursor.lock() {
            *slot = Some(cursor);
        }
    }
    pub fn current_cursor(&self) -> Option<CursorPacket> {
        self.incoming_cursor
            .lock()
            .ok()
            .and_then(|slot| slot.clone())
    }

    pub fn take_keyframe_request(&self) -> bool {
        self.force_keyframe.swap(false, Ordering::AcqRel)
    }

    pub fn request_keyframe(&self) {
        self.request_remote_keyframe.store(true, Ordering::Release);
    }

    pub fn target_bitrate(&self) -> u32 {
        self.bitrate_bps.load(Ordering::Acquire)
    }
    pub fn capture_to_display_ms(&self, remote_timestamp_us: u64) -> Option<u32> {
        let offset = self.clock_offset_us.load(Ordering::Acquire);
        if offset == i64::MIN {
            return None;
        }
        let latency = i128::from(now_us()) + i128::from(offset) - i128::from(remote_timestamp_us);
        Some(latency.clamp(0, 60_000_000) as u32 / 1_000)
    }
}

pub async fn spawn_receiver(
    hub: DatagramHub,
    peer: PeerTransport,
    base_key: [u8; 32],
    role: StreamRole,
    state: Arc<Mutex<Inner>>,
) -> Result<TransportControl, String> {
    let PeerTransport {
        endpoint,
        relay,
        id: peer_id,
        codecs: peer_codecs,
    } = peer;
    if peer_id.is_empty() {
        return Err("Identidade do par ausente".into());
    }
    let route = Arc::new(Route {
        socket: hub.socket.clone(),
        direct: endpoint,
        relay: relay.map(|(endpoint, session, auth)| {
            (
                endpoint,
                session,
                auth,
                if role == StreamRole::Host { 0 } else { 1 },
            )
        }),
        selected: AtomicU32::new(0),
    });
    let (host_to_viewer, viewer_to_host) = protocol::directional_keys(&base_key);
    let (send_key, receive_key) = if role == StreamRole::Host {
        (host_to_viewer, viewer_to_host)
    } else {
        (viewer_to_host, host_to_viewer)
    };
    let mut stream_bytes = [0u8; 4];
    getrandom::fill(&mut stream_bytes).map_err(|e| format!("Entropia indisponível: {e}"))?;
    let stream_id = u32::from_ne_bytes(stream_bytes).max(1);
    let stop = Arc::new(AtomicBool::new(false));
    let sequence = Arc::new(AtomicU64::new(1));
    let outgoing = Arc::new(Mutex::new(None::<EncodedFrame>));
    let incoming = Arc::new(Mutex::new(None::<EncodedFrame>));
    let outgoing_audio = Arc::new(Mutex::new(VecDeque::<AudioPacket>::with_capacity(4)));
    let incoming_audio = Arc::new(Mutex::new(VecDeque::<AudioPacket>::with_capacity(8)));
    let outgoing_cursor = Arc::new(Mutex::new(None::<CursorPacket>));
    let incoming_cursor = Arc::new(Mutex::new(None::<CursorPacket>));
    let outgoing_config = Arc::new(Mutex::new(None::<StreamConfig>));
    let incoming_config = Arc::new(Mutex::new(None::<StreamConfig>));
    let force_keyframe = Arc::new(AtomicBool::new(false));
    let request_remote_keyframe = Arc::new(AtomicBool::new(false));
    let bitrate_bps = Arc::new(AtomicU32::new(12_000_000));
    let peer_codecs = Arc::new(AtomicU32::new(u32::from(peer_codecs)));
    let clock_offset_us = Arc::new(AtomicI64::new(i64::MIN));
    // Feedback pertence a este par. Guardar RTT/perda apenas no status global
    // fazia um espectador lento reduzir (ou acelerar) os demais transportes.
    let feedback_rtt_ms = Arc::new(AtomicU32::new(0));
    let feedback_loss_bits = Arc::new(AtomicU32::new(0.0f32.to_bits()));
    let feedback_at_us = Arc::new(AtomicU64::new(0));
    let measured_rtt_ms = Arc::new(AtomicU32::new(0));
    let mut datagrams = hub.subscribe();
    for _ in 0..3 {
        send(
            &route,
            &send_key,
            Kind::Hello,
            next_meta(&sequence, stream_id),
            peer_id.as_bytes(),
        )
        .await?;
    }

    let recv_route = route.clone();
    let recv_stop = stop.clone();
    let recv_sequence = sequence.clone();
    let recv_state = state.clone();
    let recv_force_keyframe = force_keyframe.clone();
    let recv_incoming = incoming.clone();
    let recv_audio = incoming_audio.clone();
    let recv_cursor = incoming_cursor.clone();
    let recv_config = incoming_config.clone();
    let recv_feedback_rtt = feedback_rtt_ms.clone();
    let recv_feedback_loss = feedback_loss_bits.clone();
    let recv_feedback_at = feedback_at_us.clone();
    let recv_measured_rtt = measured_rtt_ms;
    let recv_clock_offset = clock_offset_us.clone();
    let recv_peer_id = peer_id.clone();
    let receiver = tauri::async_runtime::spawn(async move {
        let mut frames = Reassembler::default();
        let mut replay = ReplayGuard::default();
        let mut loss = LossEstimator::default();
        let mut last_feedback = Instant::now();
        let mut last_authenticated = Instant::now();
        let mut last_keyframe_request = Instant::now() - Duration::from_secs(1);
        while !recv_stop.load(Ordering::Acquire) {
            if last_authenticated.elapsed() >= Duration::from_secs(2) {
                recv_route.reset();
                if let Ok(mut inner) = recv_state.lock() {
                    inner.status.phase = "recovering";
                    if role == StreamRole::Viewer
                        && recv_route.relay.is_none()
                        && last_authenticated.elapsed() >= Duration::from_secs(8)
                    {
                        inner.status.rejoin_required = true;
                    }
                }
                update_peer(&recv_state, &recv_peer_id, |metric| {
                    metric.phase = "recovering"
                });
            }
            let expired = frames.expire();
            if expired > 0 {
                if let Ok(mut inner) = recv_state.lock() {
                    inner.status.dropped_frames += expired as u64;
                }
                request_keyframe(
                    &recv_route,
                    &send_key,
                    &recv_sequence,
                    stream_id,
                    &recv_state,
                    &mut last_keyframe_request,
                )
                .await;
            }
            match time::timeout(Duration::from_millis(20), datagrams.recv()).await {
                Ok(Ok((buffer, source))) => {
                    if let Ok(packet) = protocol::open(&receive_key, &buffer) {
                        if !replay.accept(packet.meta.stream_id, packet.meta.sequence) {
                            continue;
                        }
                        // Duplicatas vindas da corrida direta/relay e replays antigos
                        // nao provam que a rota atual continua viva. Atualizar estes
                        // marcadores antes do antirreplay impediria a recuperacao.
                        last_authenticated = Instant::now();
                        if let Ok(mut inner) = recv_state.lock() {
                            inner.status.rejoin_required = false;
                        }
                        let selected = recv_route.select(source);
                        let observed_endpoint = if selected == 2 {
                            format!("relay://{}", source)
                        } else {
                            source.to_string()
                        };
                        if let Ok(mut inner) = recv_state.lock() {
                            inner.status.peer_endpoint = Some(observed_endpoint.clone());
                        }
                        update_peer(&recv_state, &recv_peer_id, |metric| {
                            metric.endpoint = Some(observed_endpoint);
                        });
                        loss.observe(packet.meta.sequence);
                        match packet.kind {
                            Kind::Hello => {
                                let _ = send(
                                    &recv_route,
                                    &send_key,
                                    Kind::HelloAck,
                                    next_meta(&recv_sequence, stream_id),
                                    b"ok",
                                )
                                .await;
                                mark_connected(&recv_state, role, &recv_peer_id);
                            }
                            Kind::HelloAck => mark_connected(&recv_state, role, &recv_peer_id),
                            Kind::Ping => {
                                let mut pong = packet.payload;
                                if pong.len() == 8 {
                                    pong.extend_from_slice(&now_us().to_be_bytes());
                                }
                                let _ = send(
                                    &recv_route,
                                    &send_key,
                                    Kind::Pong,
                                    next_meta(&recv_sequence, stream_id),
                                    &pong,
                                )
                                .await;
                            }
                            Kind::Pong
                                if packet.payload.len() == 8 || packet.payload.len() == 16 =>
                            {
                                let sent =
                                    u64::from_be_bytes(packet.payload[..8].try_into().unwrap());
                                let received = now_us();
                                let rtt = received.saturating_sub(sent) / 1000;
                                if packet.payload.len() == 16 {
                                    let remote = u64::from_be_bytes(
                                        packet.payload[8..16].try_into().unwrap(),
                                    );
                                    let midpoint =
                                        sent.saturating_add(received.saturating_sub(sent) / 2);
                                    let offset = i128::from(remote) - i128::from(midpoint);
                                    recv_clock_offset.store(
                                        offset.clamp(i128::from(i64::MIN + 1), i128::from(i64::MAX))
                                            as i64,
                                        Ordering::Release,
                                    );
                                }
                                recv_measured_rtt
                                    .store(rtt.min(u32::MAX as u64) as u32, Ordering::Release);
                                if let Ok(mut inner) = recv_state.lock() {
                                    inner.status.rtt_ms = rtt.min(u32::MAX as u64) as u32;
                                }
                                update_peer(&recv_state, &recv_peer_id, |metric| {
                                    metric.rtt_ms = rtt.min(u32::MAX as u64) as u32;
                                });
                            }
                            Kind::Video => match frames.push(
                                packet.meta.frame_id,
                                packet.meta.fragment_index,
                                packet.meta.fragment_count,
                                packet.meta.keyframe,
                                packet.meta.timestamp_us,
                                &packet.payload,
                            ) {
                                Ok(Some(frame)) => {
                                    let replaced = recv_incoming
                                        .lock()
                                        .map(|mut slot| {
                                            slot.replace(EncodedFrame {
                                                id: frame.id,
                                                timestamp_us: frame.timestamp_us,
                                                keyframe: frame.keyframe,
                                                bytes: Arc::new(frame.bytes),
                                            })
                                            .is_some()
                                        })
                                        .unwrap_or(true);
                                    if let Ok(mut inner) = recv_state.lock() {
                                        inner.status.received_frames += 1;
                                        inner.status.dropped_frames += u64::from(replaced);
                                        inner.status.phase = "streaming";
                                    }
                                    update_peer(&recv_state, &recv_peer_id, |metric| {
                                        metric.received_frames += 1;
                                        metric.dropped_frames += u64::from(replaced);
                                        metric.phase = "streaming";
                                    });
                                }
                                Ok(None) => {}
                                Err(_) => {
                                    request_keyframe(
                                        &recv_route,
                                        &send_key,
                                        &recv_sequence,
                                        stream_id,
                                        &recv_state,
                                        &mut last_keyframe_request,
                                    )
                                    .await
                                }
                            },
                            Kind::VideoFec => match frames.push_fec(
                                packet.meta.frame_id,
                                packet.meta.fragment_index,
                                packet.meta.fragment_count,
                                packet.meta.timestamp_us,
                                &packet.payload,
                            ) {
                                Ok(Some(frame)) => {
                                    let replaced = recv_incoming
                                        .lock()
                                        .map(|mut slot| {
                                            slot.replace(EncodedFrame {
                                                id: frame.id,
                                                timestamp_us: frame.timestamp_us,
                                                keyframe: true,
                                                bytes: Arc::new(frame.bytes),
                                            })
                                            .is_some()
                                        })
                                        .unwrap_or(true);
                                    if let Ok(mut inner) = recv_state.lock() {
                                        inner.status.received_frames += 1;
                                        inner.status.dropped_frames += u64::from(replaced);
                                    }
                                    update_peer(&recv_state, &recv_peer_id, |metric| {
                                        metric.received_frames += 1;
                                        metric.dropped_frames += u64::from(replaced);
                                        metric.phase = "streaming";
                                    });
                                }
                                Ok(None) => {}
                                Err(_) => mark_dropped(&recv_state),
                            },
                            Kind::Keyframe => {
                                recv_force_keyframe.store(true, Ordering::Release);
                                if let Ok(mut inner) = recv_state.lock() {
                                    inner.status.keyframe_requests += 1;
                                }
                            }
                            Kind::Feedback => apply_feedback(
                                &recv_state,
                                &recv_feedback_rtt,
                                &recv_feedback_loss,
                                &recv_feedback_at,
                                &recv_peer_id,
                                &packet.payload,
                            ),
                            Kind::Config => {
                                if let Ok(config) = StreamConfig::decode(&packet.payload) {
                                    if let Ok(mut slot) = recv_config.lock() {
                                        *slot = Some(config);
                                    }
                                }
                            }
                            Kind::Audio => {
                                if packet.payload.len() <= protocol::MAX_PAYLOAD {
                                    if let Ok(mut queue) = recv_audio.lock() {
                                        if queue.len() >= 8 {
                                            queue.pop_front();
                                        }
                                        queue.push_back(AudioPacket {
                                            timestamp_us: packet.meta.timestamp_us,
                                            bytes: Arc::new(packet.payload),
                                        });
                                    }
                                }
                            }
                            Kind::Cursor => {
                                if let Some(cursor) =
                                    CursorPacket::decode(packet.meta.timestamp_us, &packet.payload)
                                {
                                    if let Ok(mut slot) = recv_cursor.lock() {
                                        *slot = Some(cursor);
                                    }
                                }
                            }
                            Kind::Input => { /* Input permanece desativado até consentimento local explícito. */
                            }
                            Kind::Pong => {}
                        }
                        if last_feedback.elapsed() >= Duration::from_millis(500) {
                            let rtt = recv_measured_rtt.load(Ordering::Acquire);
                            let mut feedback = Vec::with_capacity(20);
                            feedback.extend_from_slice(&rtt.to_be_bytes());
                            feedback
                                .extend_from_slice(&loss.take_percent().to_bits().to_be_bytes());
                            if let Ok(inner) = recv_state.lock() {
                                feedback
                                    .extend_from_slice(&inner.status.latency_p50_ms.to_be_bytes());
                                feedback
                                    .extend_from_slice(&inner.status.latency_p95_ms.to_be_bytes());
                                feedback
                                    .extend_from_slice(&inner.status.latency_p99_ms.to_be_bytes());
                            }
                            let _ = send(
                                &recv_route,
                                &send_key,
                                Kind::Feedback,
                                next_meta(&recv_sequence, stream_id),
                                &feedback,
                            )
                            .await;
                            last_feedback = Instant::now();
                        }
                    }
                }
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => {
                    mark_dropped(&recv_state);
                    update_peer(&recv_state, &recv_peer_id, |metric| {
                        metric.dropped_frames += 1
                    });
                }
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Err(_) => {}
            }
        }
    });

    let video_route = route.clone();
    let video_stop = stop.clone();
    let video_sequence = sequence.clone();
    let video_outgoing = outgoing.clone();
    let video_config = outgoing_config.clone();
    let video_bitrate = bitrate_bps.clone();
    let video_keyframe_request = request_remote_keyframe.clone();
    let video_state = state.clone();
    let video_sender = tauri::async_runtime::spawn(async move {
        let mut last_config = None::<StreamConfig>;
        let mut last_config_sent = Instant::now() - Duration::from_secs(1);
        while !video_stop.load(Ordering::Acquire) {
            if video_keyframe_request.swap(false, Ordering::AcqRel)
                && send(
                    &video_route,
                    &send_key,
                    Kind::Keyframe,
                    next_meta(&video_sequence, stream_id),
                    b"decode",
                )
                .await
                .is_err()
            {
                mark_failed(&video_state);
            }
            let queued_config = video_config.lock().ok().and_then(|mut slot| slot.take());
            let repetitions = if let Some(config) = queued_config {
                last_config = Some(config);
                3
            } else if last_config.is_some() && last_config_sent.elapsed() >= Duration::from_secs(1)
            {
                1
            } else {
                0
            };
            if let Some(config) = last_config.filter(|_| repetitions > 0) {
                if let Ok(payload) = config.encode() {
                    for _ in 0..repetitions {
                        if send(
                            &video_route,
                            &send_key,
                            Kind::Config,
                            next_meta(&video_sequence, stream_id),
                            &payload,
                        )
                        .await
                        .is_err()
                        {
                            mark_failed(&video_state);
                            break;
                        }
                    }
                    last_config_sent = Instant::now();
                }
            }
            let frame = video_outgoing.lock().ok().and_then(|mut slot| slot.take());
            let Some(frame) = frame else {
                time::sleep(Duration::from_millis(1)).await;
                continue;
            };
            let chunk_size = if frame.keyframe {
                protocol::FEC_DATA_PAYLOAD
            } else {
                protocol::MAX_PAYLOAD
            };
            let count = frame.bytes.len().saturating_add(chunk_size - 1) / chunk_size;
            if count == 0 || count > protocol::MAX_FRAGMENTS {
                mark_dropped(&video_state);
                continue;
            }
            let fragment_count = count as u16;
            let chunks = frame.bytes.chunks(chunk_size).collect::<Vec<_>>();
            let mut deadline = time::Instant::now();
            for (index, payload) in chunks.iter().copied().enumerate() {
                if !frame.keyframe
                    && video_outgoing
                        .lock()
                        .map(|slot| slot.is_some())
                        .unwrap_or(false)
                {
                    mark_dropped(&video_state);
                    break;
                }
                let meta = Meta {
                    stream_id,
                    sequence: video_sequence.fetch_add(1, Ordering::Relaxed),
                    frame_id: frame.id,
                    fragment_index: index as u16,
                    fragment_count,
                    timestamp_us: frame.timestamp_us,
                    keyframe: frame.keyframe,
                };
                if send(&video_route, &send_key, Kind::Video, meta, payload)
                    .await
                    .is_err()
                {
                    mark_failed(&video_state);
                    break;
                }
                let bitrate = video_bitrate.load(Ordering::Acquire).max(800_000) as u64;
                let nanos = (protocol::MAX_DATAGRAM as u64 * 8 * 1_000_000_000) / bitrate;
                deadline += Duration::from_nanos(nanos);
                time::sleep_until(deadline).await;
                if frame.keyframe
                    && ((index + 1).is_multiple_of(protocol::FEC_GROUP_SIZE)
                        || index + 1 == chunks.len())
                {
                    let start = index / protocol::FEC_GROUP_SIZE * protocol::FEC_GROUP_SIZE;
                    let group = &chunks[start..=index];
                    let parity_len = group.iter().map(|part| part.len()).max().unwrap_or(0);
                    let mut fec = Vec::with_capacity(protocol::FEC_HEADER_LEN + parity_len);
                    fec.extend_from_slice(
                        &(chunks.last().map_or(0, |part| part.len()) as u16).to_be_bytes(),
                    );
                    fec.resize(protocol::FEC_HEADER_LEN + parity_len, 0);
                    for part in group {
                        for (offset, byte) in part.iter().enumerate() {
                            fec[protocol::FEC_HEADER_LEN + offset] ^= byte;
                        }
                    }
                    let meta = Meta {
                        stream_id,
                        sequence: video_sequence.fetch_add(1, Ordering::Relaxed),
                        frame_id: frame.id,
                        fragment_index: start as u16,
                        fragment_count,
                        timestamp_us: frame.timestamp_us,
                        keyframe: true,
                    };
                    if send(&video_route, &send_key, Kind::VideoFec, meta, &fec)
                        .await
                        .is_err()
                    {
                        mark_failed(&video_state);
                        break;
                    }
                    deadline += Duration::from_nanos(nanos);
                    time::sleep_until(deadline).await;
                }
            }
        }
    });

    // Áudio tem um transmissor próprio. Um keyframe grande pode ocupar dezenas
    // de milissegundos no sender de vídeo e não deve causar estalos no som.
    let audio_route = route.clone();
    let audio_stop = stop.clone();
    let audio_sequence = sequence.clone();
    let audio_outgoing = outgoing_audio.clone();
    let audio_state = state.clone();
    let audio_sender = tauri::async_runtime::spawn(async move {
        while !audio_stop.load(Ordering::Acquire) {
            let packet = audio_outgoing
                .lock()
                .ok()
                .and_then(|mut queue| queue.pop_front());
            let Some(packet) = packet else {
                time::sleep(Duration::from_millis(1)).await;
                continue;
            };
            if send(
                &audio_route,
                &send_key,
                Kind::Audio,
                Meta {
                    stream_id,
                    sequence: audio_sequence.fetch_add(1, Ordering::Relaxed),
                    timestamp_us: packet.timestamp_us,
                    ..Default::default()
                },
                &packet.bytes,
            )
            .await
            .is_err()
            {
                audio_route.reset();
                mark_failed(&audio_state);
            }
        }
    });

    let cursor_route = route.clone();
    let cursor_stop = stop.clone();
    let cursor_sequence = sequence.clone();
    let cursor_outgoing = outgoing_cursor.clone();
    let cursor_sender = tauri::async_runtime::spawn(async move {
        while !cursor_stop.load(Ordering::Acquire) {
            let cursor = cursor_outgoing.lock().ok().and_then(|mut slot| slot.take());
            let Some(cursor) = cursor else {
                time::sleep(Duration::from_millis(4)).await;
                continue;
            };
            let payload = cursor.encode();
            let _ = send(
                &cursor_route,
                &send_key,
                Kind::Cursor,
                Meta {
                    stream_id,
                    sequence: cursor_sequence.fetch_add(1, Ordering::Relaxed),
                    timestamp_us: cursor.timestamp_us,
                    ..Default::default()
                },
                &payload,
            )
            .await;
        }
    });

    let ping_route = route;
    let ping_stop = stop.clone();
    let ping_sequence = sequence;
    let ping_state = state;
    let ping_bitrate = bitrate_bps.clone();
    let ping_feedback_rtt = feedback_rtt_ms;
    let ping_feedback_loss = feedback_loss_bits;
    let ping_feedback_at = feedback_at_us;
    let ping_peer_id = peer_id;
    let heartbeat = tauri::async_runtime::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(500));
        let mut congestion = CongestionController::new(12_000_000, 800_000, 35_000_000);
        while !ping_stop.load(Ordering::Acquire) {
            interval.tick().await;
            let stamp = now_us().to_be_bytes();
            if send(
                &ping_route,
                &send_key,
                Kind::Ping,
                next_meta(&ping_sequence, stream_id),
                &stamp,
            )
            .await
            .is_err()
            {
                ping_route.reset();
                if let Ok(mut inner) = ping_state.lock() {
                    inner.status.phase = "recovering";
                }
                update_peer(&ping_state, &ping_peer_id, |metric| {
                    metric.phase = "recovering"
                });
                time::sleep(Duration::from_millis(100)).await;
                continue;
            }
            let feedback_rtt = ping_feedback_rtt.load(Ordering::Acquire);
            let feedback_loss = f32::from_bits(ping_feedback_loss.load(Ordering::Acquire));
            let feedback_at = ping_feedback_at.load(Ordering::Acquire);
            let feedback_is_fresh =
                feedback_at > 0 && now_us().saturating_sub(feedback_at) < 2_000_000;
            let bitrate = if feedback_is_fresh {
                congestion.update(feedback_loss, feedback_rtt)
            } else {
                ping_bitrate.load(Ordering::Acquire)
            };
            ping_bitrate.store(bitrate, Ordering::Release);
            if let Ok(mut inner) = ping_state.lock() {
                if role == StreamRole::Viewer {
                    inner.status.bitrate_kbps = bitrate / 1000;
                }
            }
            update_peer(&ping_state, &ping_peer_id, |metric| {
                metric.bitrate_kbps = bitrate / 1000;
            });
        }
    });
    Ok(TransportControl {
        stop,
        outgoing,
        incoming,
        outgoing_audio,
        incoming_audio,
        outgoing_cursor,
        incoming_cursor,
        outgoing_config,
        incoming_config,
        force_keyframe,
        request_remote_keyframe,
        bitrate_bps,
        peer_codecs,
        clock_offset_us,
        tasks: vec![
            receiver,
            video_sender,
            audio_sender,
            cursor_sender,
            heartbeat,
        ],
        native_thread: None,
    })
}
fn mark_dropped(state: &Arc<Mutex<Inner>>) {
    if let Ok(mut inner) = state.lock() {
        inner.status.dropped_frames += 1;
    }
}
fn mark_failed(state: &Arc<Mutex<Inner>>) {
    if let Ok(mut inner) = state.lock() {
        // Um erro de envio e recuperavel: a rota e reavaliada pelo heartbeat.
        // No host, ele tambem nao pode derrubar os demais espectadores.
        inner.status.phase = if inner.status.role == Some(StreamRole::Host) {
            "recovering"
        } else {
            "failed"
        };
    }
}

fn mark_connected(state: &Arc<Mutex<Inner>>, role: StreamRole, peer_id: &str) {
    if let Ok(mut inner) = state.lock() {
        inner.status.phase = if role == StreamRole::Host {
            "streaming"
        } else {
            "connected"
        };
    }
    update_peer(state, peer_id, |metric| metric.phase = "connected");
}
fn apply_feedback(
    state: &Arc<Mutex<Inner>>,
    feedback_rtt_ms: &AtomicU32,
    feedback_loss_bits: &AtomicU32,
    feedback_at_us: &AtomicU64,
    peer_id: &str,
    payload: &[u8],
) {
    if payload.len() >= 8 {
        let rtt = u32::from_be_bytes(payload[..4].try_into().unwrap());
        let loss = f32::from_bits(u32::from_be_bytes(payload[4..8].try_into().unwrap()));
        let loss = if loss.is_finite() {
            loss.clamp(0.0, 100.0)
        } else {
            100.0
        };
        feedback_rtt_ms.store(rtt, Ordering::Release);
        feedback_loss_bits.store(loss.to_bits(), Ordering::Release);
        feedback_at_us.store(now_us(), Ordering::Release);
        if let Ok(mut inner) = state.lock() {
            inner.status.rtt_ms = rtt;
            inner.status.loss_pct = loss;
        }
        update_peer(state, peer_id, |metric| {
            metric.rtt_ms = rtt;
            metric.loss_pct = loss;
            if payload.len() >= 20 {
                metric.latency_p50_ms = u32::from_be_bytes(payload[8..12].try_into().unwrap());
                metric.latency_p95_ms = u32::from_be_bytes(payload[12..16].try_into().unwrap());
                metric.latency_p99_ms = u32::from_be_bytes(payload[16..20].try_into().unwrap());
            }
        });
    }
}

fn update_peer(
    state: &Arc<Mutex<Inner>>,
    peer_id: &str,
    update: impl FnOnce(&mut super::PeerMetric),
) {
    if let Ok(mut inner) = state.lock() {
        let snapshot = {
            let metric = inner
                .peer_metrics
                .entry(peer_id.to_string())
                .or_insert_with(|| super::PeerMetric::waiting(peer_id.to_string()));
            update(metric);
            metric.clone()
        };
        if let Some(metric) = inner
            .status
            .peer_metrics
            .iter_mut()
            .find(|metric| metric.peer_id == peer_id)
        {
            *metric = snapshot;
        } else {
            inner.status.peer_metrics.push(snapshot);
        }
    }
}
async fn request_keyframe(
    route: &Route,
    key: &[u8; 32],
    sequence: &AtomicU64,
    stream_id: u32,
    state: &Arc<Mutex<Inner>>,
    last: &mut Instant,
) {
    if last.elapsed() < Duration::from_millis(250) {
        return;
    }
    *last = Instant::now();
    if let Ok(mut inner) = state.lock() {
        inner.status.keyframe_requests += 1;
    }
    let _ = send(
        route,
        key,
        Kind::Keyframe,
        next_meta(sequence, stream_id),
        b"loss",
    )
    .await;
}
async fn send(
    route: &Route,
    key: &[u8; 32],
    kind: Kind,
    meta: Meta,
    payload: &[u8],
) -> Result<(), String> {
    let bytes = protocol::seal(key, kind, meta, payload)?;
    route.send(&bytes).await?;
    Ok(())
}
fn next_meta(sequence: &AtomicU64, stream_id: u32) -> Meta {
    Meta {
        stream_id,
        sequence: sequence.fetch_add(1, Ordering::Relaxed),
        timestamp_us: now_us(),
        fragment_count: 1,
        ..Default::default()
    }
}
fn now_us() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_bitrate_tracks_constrained_video() {
        assert_eq!(opus_bitrate_for_video(800_000), 64_000);
        assert_eq!(opus_bitrate_for_video(2_000_000), 80_000);
        assert_eq!(opus_bitrate_for_video(5_000_000), 96_000);
        assert_eq!(opus_bitrate_for_video(12_000_000), 128_000);
    }

    #[test]
    fn codec_negotiation_never_invents_h264() {
        assert_eq!(
            negotiated_codec(VideoCodec::Av1.bit(), VideoCodec::H264.bit()),
            None
        );
    }

    #[test]
    fn cursor_packet_round_trips() {
        let packet = CursorPacket {
            timestamp_us: 42,
            visible: true,
            x: -12,
            y: 345,
            source_width: 2560,
            source_height: 1440,
        };
        let encoded = packet.encode();
        let decoded = CursorPacket::decode(packet.timestamp_us, &encoded).unwrap();
        assert_eq!(decoded.timestamp_us, packet.timestamp_us);
        assert_eq!(decoded.visible, packet.visible);
        assert_eq!(decoded.x, packet.x);
        assert_eq!(decoded.y, packet.y);
        assert_eq!(decoded.source_width, packet.source_width);
        assert_eq!(decoded.source_height, packet.source_height);
    }
}
