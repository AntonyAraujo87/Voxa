use super::{Inner, StreamRole};
use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use tokio::{net::UdpSocket, time};
use voxa_native_core::{
    congestion::CongestionController,
    loss::LossEstimator,
    protocol::{self, Kind, Meta, ReplayGuard},
    reassembly::Reassembler,
};

pub struct TransportControl {
    stop: Arc<AtomicBool>,
    tasks: Vec<JoinHandle<()>>,
}
impl TransportControl {
    pub fn stop(self) {
        self.stop.store(true, Ordering::Release);
        for task in self.tasks {
            task.abort();
        }
    }
}

pub async fn spawn_receiver(
    socket: Arc<UdpSocket>,
    peer: SocketAddr,
    base_key: [u8; 32],
    role: StreamRole,
    peer_id: String,
    state: Arc<Mutex<Inner>>,
) -> Result<TransportControl, String> {
    if peer_id.is_empty() {
        return Err("Identidade do par ausente".into());
    }
    socket
        .connect(peer)
        .await
        .map_err(|e| format!("Falha ao preparar a rota UDP: {e}"))?;
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
    for _ in 0..3 {
        send(
            &socket,
            &send_key,
            Kind::Hello,
            next_meta(&sequence, stream_id),
            peer_id.as_bytes(),
        )
        .await?;
    }

    let recv_socket = socket.clone();
    let recv_stop = stop.clone();
    let recv_sequence = sequence.clone();
    let recv_state = state.clone();
    let receiver = tauri::async_runtime::spawn(async move {
        let mut buffer = [0u8; protocol::MAX_DATAGRAM];
        let mut frames = Reassembler::default();
        let mut replay = ReplayGuard::default();
        let mut loss = LossEstimator::default();
        let mut last_feedback = Instant::now();
        let mut last_keyframe_request = Instant::now() - Duration::from_secs(1);
        while !recv_stop.load(Ordering::Acquire) {
            match time::timeout(Duration::from_millis(20), recv_socket.recv(&mut buffer)).await {
                Ok(Ok(len)) => {
                    if let Ok(packet) = protocol::open(&receive_key, &buffer[..len]) {
                        if !replay.accept(packet.meta.stream_id, packet.meta.sequence) {
                            continue;
                        }
                        loss.observe(packet.meta.sequence);
                        match packet.kind {
                            Kind::Hello => {
                                let _ = send(
                                    &recv_socket,
                                    &send_key,
                                    Kind::HelloAck,
                                    next_meta(&recv_sequence, stream_id),
                                    b"ok",
                                )
                                .await;
                                mark_connected(&recv_state, role);
                            }
                            Kind::HelloAck => mark_connected(&recv_state, role),
                            Kind::Ping => {
                                let _ = send(
                                    &recv_socket,
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
                                if let Ok(mut inner) = recv_state.lock() {
                                    inner.status.rtt_ms = rtt.min(u32::MAX as u64) as u32;
                                }
                            }
                            Kind::Video => match frames.push(
                                packet.meta.frame_id,
                                packet.meta.fragment_index,
                                packet.meta.fragment_count,
                                packet.meta.keyframe,
                                &packet.payload,
                            ) {
                                Ok(Some(frame)) => {
                                    if let Ok(mut inner) = recv_state.lock() {
                                        inner.status.received_frames += 1;
                                        inner.status.phase = "streaming";
                                        let _ = (frame.id, frame.keyframe, frame.bytes.len());
                                    }
                                }
                                Ok(None) => {}
                                Err(_) => {
                                    request_keyframe(
                                        &recv_socket,
                                        &send_key,
                                        &recv_sequence,
                                        stream_id,
                                        &recv_state,
                                        &mut last_keyframe_request,
                                    )
                                    .await
                                }
                            },
                            Kind::Keyframe => {
                                if let Ok(mut inner) = recv_state.lock() {
                                    inner.status.keyframe_requests += 1;
                                }
                            }
                            Kind::Feedback => apply_feedback(&recv_state, &packet.payload),
                            Kind::Input => { /* Input permanece desativado até consentimento local explícito. */
                            }
                            Kind::Pong => {}
                        }
                        if last_feedback.elapsed() >= Duration::from_millis(500) {
                            let rtt = recv_state
                                .lock()
                                .map(|inner| inner.status.rtt_ms)
                                .unwrap_or_default();
                            let mut feedback = Vec::with_capacity(8);
                            feedback.extend_from_slice(&rtt.to_be_bytes());
                            feedback
                                .extend_from_slice(&loss.take_percent().to_bits().to_be_bytes());
                            let _ = send(
                                &recv_socket,
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
                Ok(Err(_)) => break,
                Err(_) => {
                    let expired = frames.expire();
                    if expired > 0 {
                        if let Ok(mut inner) = recv_state.lock() {
                            inner.status.dropped_frames += expired as u64;
                        }
                        request_keyframe(
                            &recv_socket,
                            &send_key,
                            &recv_sequence,
                            stream_id,
                            &recv_state,
                            &mut last_keyframe_request,
                        )
                        .await;
                    }
                }
            }
        }
    });

    let ping_socket = socket;
    let ping_stop = stop.clone();
    let ping_sequence = sequence;
    let ping_state = state;
    let heartbeat = tauri::async_runtime::spawn(async move {
        let mut interval = time::interval(Duration::from_millis(500));
        let mut congestion = CongestionController::new(12_000_000, 800_000, 35_000_000);
        while !ping_stop.load(Ordering::Acquire) {
            interval.tick().await;
            let stamp = now_us().to_be_bytes();
            if send(
                &ping_socket,
                &send_key,
                Kind::Ping,
                next_meta(&ping_sequence, stream_id),
                &stamp,
            )
            .await
            .is_err()
            {
                break;
            }
            if let Ok(mut inner) = ping_state.lock() {
                let bitrate = congestion.update(inner.status.loss_pct, inner.status.rtt_ms);
                inner.status.bitrate_kbps = bitrate / 1000;
            }
        }
    });
    Ok(TransportControl {
        stop,
        tasks: vec![receiver, heartbeat],
    })
}

fn mark_connected(state: &Arc<Mutex<Inner>>, role: StreamRole) {
    if let Ok(mut inner) = state.lock() {
        inner.status.phase = if role == StreamRole::Host {
            "streaming"
        } else {
            "connected"
        };
    }
}
fn apply_feedback(state: &Arc<Mutex<Inner>>, payload: &[u8]) {
    if payload.len() >= 8 {
        if let Ok(mut inner) = state.lock() {
            inner.status.rtt_ms = u32::from_be_bytes(payload[..4].try_into().unwrap());
            inner.status.loss_pct =
                f32::from_bits(u32::from_be_bytes(payload[4..8].try_into().unwrap()))
                    .clamp(0.0, 100.0);
        }
    }
}
async fn request_keyframe(
    socket: &UdpSocket,
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
        socket,
        key,
        Kind::Keyframe,
        next_meta(sequence, stream_id),
        b"loss",
    )
    .await;
}
async fn send(
    socket: &UdpSocket,
    key: &[u8; 32],
    kind: Kind,
    meta: Meta,
    payload: &[u8],
) -> Result<(), String> {
    let bytes = protocol::seal(key, kind, meta, payload)?;
    socket.send(&bytes).await.map_err(|e| e.to_string())?;
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
