use super::{Inner, StreamRole};
use std::{
    collections::HashMap,
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use tokio::{net::UdpSocket, sync::broadcast, time};
use voxa_native_core::{
    congestion::CongestionController,
    loss::LossEstimator,
    protocol::{self, Kind, Meta, ReplayGuard, StreamConfig},
    reassembly::Reassembler,
};

pub struct TransportControl {
    stop: Arc<AtomicBool>,
    outgoing: Arc<Mutex<Option<EncodedFrame>>>,
    incoming: Arc<Mutex<Option<EncodedFrame>>>,
    outgoing_config: Arc<Mutex<Option<StreamConfig>>>,
    incoming_config: Arc<Mutex<Option<StreamConfig>>>,
    force_keyframe: Arc<AtomicBool>,
    request_remote_keyframe: Arc<AtomicBool>,
    bitrate_bps: Arc<AtomicU32>,
    assigned_tier: Arc<AtomicU32>,
    tasks: Vec<JoinHandle<()>>,
    native_thread: Option<std::thread::JoinHandle<()>>,
}

#[derive(Clone)]
pub struct TransportHandle {
    stop: Arc<AtomicBool>,
    outgoing: Arc<Mutex<Option<EncodedFrame>>>,
    incoming: Arc<Mutex<Option<EncodedFrame>>>,
    outgoing_config: Arc<Mutex<Option<StreamConfig>>>,
    incoming_config: Arc<Mutex<Option<StreamConfig>>>,
    force_keyframe: Arc<AtomicBool>,
    request_remote_keyframe: Arc<AtomicBool>,
    bitrate_bps: Arc<AtomicU32>,
    assigned_tier: Arc<AtomicU32>,
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
    configs: Arc<Mutex<HashMap<VideoTier, StreamConfig>>>,
    force_keyframe: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum VideoTier {
    Low,
    High,
}

impl VideoTier {
    fn for_bitrate(bitrate: u32) -> Self {
        if bitrate < 4_000_000 {
            Self::Low
        } else {
            Self::High
        }
    }

    fn code(self) -> u32 {
        match self {
            Self::Low => 1,
            Self::High => 2,
        }
    }
}

impl HostTransportHandle {
    pub fn add(&self, peer_id: String, handle: TransportHandle) {
        let tier = VideoTier::for_bitrate(handle.target_bitrate());
        if let Some(config) = self
            .configs
            .lock()
            .ok()
            .and_then(|configs| configs.get(&tier).copied())
        {
            handle.queue_config(config);
        }
        handle.assigned_tier.store(tier.code(), Ordering::Release);
        if let Ok(mut peers) = self.peers.lock() {
            peers.insert(peer_id, handle);
        }
        self.force_keyframe.store(true, Ordering::Release);
    }
    pub fn remove(&self, peer_id: &str) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.remove(peer_id);
        }
    }
    pub fn clear(&self) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.clear();
        }
    }
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.clear();
    }
    pub fn queue_video(&self, tier: VideoTier, frame: EncodedFrame) -> bool {
        let config = self
            .configs
            .lock()
            .ok()
            .and_then(|configs| configs.get(&tier).copied());
        let handles = self
            .peers
            .lock()
            .map(|peers| peers.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        handles.into_iter().fold(false, |dropped, handle| {
            if VideoTier::for_bitrate(handle.target_bitrate()) != tier {
                return dropped;
            }
            let changed = handle.assigned_tier.swap(tier.code(), Ordering::AcqRel) != tier.code();
            if changed {
                if let Some(config) = config {
                    handle.queue_config(config);
                }
                self.force_keyframe.store(true, Ordering::Release);
                if !frame.keyframe {
                    return true;
                }
            }
            dropped | handle.queue_video(frame.clone())
        })
    }
    pub fn queue_config(&self, tier: VideoTier, config: StreamConfig) {
        if let Ok(mut current) = self.configs.lock() {
            current.insert(tier, config);
        }
        if let Ok(peers) = self.peers.lock() {
            for handle in peers.values() {
                if VideoTier::for_bitrate(handle.target_bitrate()) == tier {
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
    pub fn active_tiers(&self) -> Vec<(VideoTier, u32)> {
        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        [VideoTier::Low, VideoTier::High]
            .into_iter()
            .filter_map(|tier| {
                peers
                    .values()
                    .filter(|handle| VideoTier::for_bitrate(handle.target_bitrate()) == tier)
                    .map(TransportHandle::target_bitrate)
                    .min()
                    .map(|bitrate| (tier, bitrate))
            })
            .collect()
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
            outgoing_config: self.outgoing_config.clone(),
            incoming_config: self.incoming_config.clone(),
            force_keyframe: self.force_keyframe.clone(),
            request_remote_keyframe: self.request_remote_keyframe.clone(),
            bitrate_bps: self.bitrate_bps.clone(),
            assigned_tier: self.assigned_tier.clone(),
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

    pub fn take_keyframe_request(&self) -> bool {
        self.force_keyframe.swap(false, Ordering::AcqRel)
    }

    pub fn request_keyframe(&self) {
        self.request_remote_keyframe.store(true, Ordering::Release);
    }

    pub fn target_bitrate(&self) -> u32 {
        self.bitrate_bps.load(Ordering::Acquire)
    }
}

pub async fn spawn_receiver(
    hub: DatagramHub,
    peer: SocketAddr,
    relay: Option<(SocketAddr, u64, u64)>,
    base_key: [u8; 32],
    role: StreamRole,
    peer_id: String,
    state: Arc<Mutex<Inner>>,
) -> Result<TransportControl, String> {
    if peer_id.is_empty() {
        return Err("Identidade do par ausente".into());
    }
    let route = Arc::new(Route {
        socket: hub.socket.clone(),
        direct: peer,
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
    let outgoing_config = Arc::new(Mutex::new(None::<StreamConfig>));
    let incoming_config = Arc::new(Mutex::new(None::<StreamConfig>));
    let force_keyframe = Arc::new(AtomicBool::new(false));
    let request_remote_keyframe = Arc::new(AtomicBool::new(false));
    let bitrate_bps = Arc::new(AtomicU32::new(12_000_000));
    let assigned_tier = Arc::new(AtomicU32::new(0));
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
    let recv_config = incoming_config.clone();
    let recv_feedback_rtt = feedback_rtt_ms.clone();
    let recv_feedback_loss = feedback_loss_bits.clone();
    let recv_feedback_at = feedback_at_us.clone();
    let recv_measured_rtt = measured_rtt_ms;
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
                        last_authenticated = Instant::now();
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
                        if !replay.accept(packet.meta.stream_id, packet.meta.sequence) {
                            continue;
                        }
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
                                let _ = send(
                                    &recv_route,
                                    &send_key,
                                    Kind::Pong,
                                    next_meta(&recv_sequence, stream_id),
                                    &packet.payload,
                                )
                                .await;
                            }
                            Kind::Pong if packet.payload.len() == 8 => {
                                let sent =
                                    u64::from_be_bytes(packet.payload[..8].try_into().unwrap());
                                let rtt = now_us().saturating_sub(sent) / 1000;
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
                            Kind::Input => { /* Input permanece desativado até consentimento local explícito. */
                            }
                            Kind::Pong => {}
                        }
                        if last_feedback.elapsed() >= Duration::from_millis(500) {
                            let rtt = recv_measured_rtt.load(Ordering::Acquire);
                            let mut feedback = Vec::with_capacity(8);
                            feedback.extend_from_slice(&rtt.to_be_bytes());
                            feedback
                                .extend_from_slice(&loss.take_percent().to_bits().to_be_bytes());
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
        outgoing_config,
        incoming_config,
        force_keyframe,
        request_remote_keyframe,
        bitrate_bps,
        assigned_tier,
        tasks: vec![receiver, video_sender, heartbeat],
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
