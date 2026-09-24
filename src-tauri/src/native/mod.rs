mod transport;

#[cfg(target_os = "windows")]
pub mod capture;
#[cfg(target_os = "windows")]
pub mod converter;
#[cfg(target_os = "windows")]
pub mod decoder;
#[cfg(target_os = "windows")]
pub mod encoder;
#[cfg(target_os = "windows")]
pub mod pipeline;
#[cfg(target_os = "windows")]
pub mod presenter;
pub mod renderer;
#[cfg(target_os = "windows")]
pub mod viewer;

use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Manager, State};
use tokio::net::UdpSocket;
use transport::{spawn_receiver, DatagramHub, HostTransportHandle, TransportControl};
use voxa_native_core::{protocol, stun};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamRole {
    Host,
    Viewer,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetId {
    pub adapter_index: u32,
    pub output_index: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetInfo {
    pub id: CaptureTargetId,
    pub gpu: String,
    pub monitor: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerVerification {
    peer_id: String,
    code: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMetric {
    peer_id: String,
    endpoint: Option<String>,
    phase: &'static str,
    rtt_ms: u32,
    loss_pct: f32,
    bitrate_kbps: u32,
    received_frames: u64,
    dropped_frames: u64,
}

impl PeerMetric {
    fn waiting(peer_id: String) -> Self {
        Self {
            peer_id,
            endpoint: None,
            phase: "punching",
            rtt_ms: 0,
            loss_pct: 0.0,
            bitrate_kbps: 12_000,
            received_frames: 0,
            dropped_frames: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    phase: &'static str,
    role: Option<StreamRole>,
    local_endpoint: Option<String>,
    public_endpoint: Option<String>,
    peer_endpoint: Option<String>,
    rtt_ms: u32,
    loss_pct: f32,
    bitrate_kbps: u32,
    received_frames: u64,
    encoded_frames: u64,
    dropped_frames: u64,
    keyframe_requests: u64,
    renderer: &'static str,
    capture: &'static str,
    encoder: &'static str,
    decoder: &'static str,
    decoded_frames: u64,
    verification_code: Option<String>,
    connected_peers: usize,
    max_peers: usize,
    peer_verifications: Vec<PeerVerification>,
    peer_metrics: Vec<PeerMetric>,
    last_error: Option<String>,
}

impl Default for EngineStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            role: None,
            local_endpoint: None,
            public_endpoint: None,
            peer_endpoint: None,
            rtt_ms: 0,
            loss_pct: 0.0,
            bitrate_kbps: 12_000,
            received_frames: 0,
            encoded_frames: 0,
            dropped_frames: 0,
            keyframe_requests: 0,
            renderer: "closed",
            capture: "idle",
            encoder: "idle",
            decoder: "idle",
            decoded_frames: 0,
            verification_code: None,
            connected_peers: 0,
            max_peers: 4,
            peer_verifications: Vec::new(),
            peer_metrics: Vec::new(),
            last_error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedEndpoint {
    local: String,
    public: Option<String>,
    public_key: String,
}

#[derive(Default)]
struct Inner {
    status: EngineStatus,
    socket: Option<Arc<UdpSocket>>,
    datagrams: Option<DatagramHub>,
    transports: HashMap<String, TransportControl>,
    host_fanout: HostTransportHandle,
    host_pipeline: Option<std::thread::JoinHandle<()>>,
    verification_codes: HashMap<String, String>,
    peer_metrics: HashMap<String, PeerMetric>,
    key_exchange: Option<protocol::EphemeralKey>,
    capture_target: Option<CaptureTargetId>,
}

#[derive(Default)]
pub struct NativeEngine {
    inner: Arc<Mutex<Inner>>,
}

#[tauri::command]
pub fn engine_capture_targets() -> Result<Vec<CaptureTargetInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        capture::enumerate_targets()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Err("Captura nativa disponível somente no Windows".into())
    }
}

#[tauri::command]
pub async fn engine_prepare(
    app: AppHandle,
    role: StreamRole,
    capture_target: Option<CaptureTargetId>,
    engine: State<'_, NativeEngine>,
) -> Result<PreparedEndpoint, String> {
    engine_stop(app, engine.clone()).await?;
    {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        inner.status.phase = "binding";
        inner.status.role = Some(role);
    }
    let socket = Arc::new(
        UdpSocket::bind("0.0.0.0:0")
            .await
            .map_err(|e| format!("Não foi possível abrir UDP: {e}"))?,
    );
    let bound = socket.local_addr().map_err(|e| e.to_string())?;
    let local = stun::local_endpoint(bound.port())
        .unwrap_or(bound)
        .to_string();
    let public = stun::discover_any(
        &socket,
        &[
            "stun.cloudflare.com:3478",
            "stun.l.google.com:19302",
            "stun1.l.google.com:19302",
        ],
    )
    .await
    .ok()
    .map(|endpoint| endpoint.to_string());
    let key_exchange = protocol::EphemeralKey::generate()?;
    let public_key = key_exchange.public_base64();
    #[cfg(target_os = "windows")]
    let (capture_state, encoder_state) = if role == StreamRole::Host {
        let capture_state = if capture::probe(capture_target).is_ok() {
            "dxgi-ready"
        } else {
            "dxgi-unavailable"
        };
        let encoder_state = match encoder::hardware_h264_encoder_count() {
            Ok(count) if count > 0 => "hardware-detected",
            _ => "hardware-unavailable",
        };
        (capture_state, encoder_state)
    } else {
        ("disabled", "decoder-pending")
    };
    #[cfg(not(target_os = "windows"))]
    let (capture_state, encoder_state) = if role == StreamRole::Host {
        ("unsupported-os", "hardware-unavailable")
    } else {
        ("disabled", "decoder-pending")
    };
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.datagrams = Some(DatagramHub::new(socket.clone()));
    inner.socket = Some(socket);
    inner.key_exchange = Some(key_exchange);
    inner.capture_target = capture_target;
    inner.status.phase = "waiting";
    inner.status.local_endpoint = Some(local.clone());
    inner.status.public_endpoint = public.clone();
    inner.status.capture = capture_state;
    inner.status.encoder = encoder_state;
    Ok(PreparedEndpoint {
        local,
        public,
        public_key,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    endpoint: String,
    peer_public_key: String,
    peer_id: String,
    relay_endpoint: Option<String>,
    relay_session: Option<String>,
    relay_auth: Option<String>,
}

#[tauri::command]
pub async fn engine_connect_peer(
    app: AppHandle,
    request: ConnectRequest,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    let ConnectRequest {
        endpoint,
        peer_public_key,
        peer_id,
        relay_endpoint,
        relay_session,
        relay_auth,
    } = request;
    if peer_id.is_empty() || peer_id.len() > 128 {
        return Err("Identidade do computador inválida".into());
    }
    let peer = endpoint.parse().map_err(|_| "Endpoint UDP inválido")?;
    let relay = match (relay_endpoint, relay_session, relay_auth) {
        (Some(endpoint), Some(session), Some(auth)) => {
            let endpoint = endpoint
                .parse()
                .map_err(|_| "Endpoint do relay UDP inválido")?;
            let session =
                u64::from_str_radix(&session, 16).map_err(|_| "Sessão do relay inválida")?;
            let auth =
                u64::from_str_radix(&auth, 16).map_err(|_| "Credencial do relay inválida")?;
            Some((endpoint, session, auth))
        }
        (None, None, None) => None,
        _ => return Err("Configuração do relay incompleta".into()),
    };
    let (datagrams, role, previous, key, verification_code) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        let role = inner.status.role.ok_or("Modo ausente")?;
        if role == StreamRole::Host
            && !inner.transports.contains_key(&peer_id)
            && inner.transports.len() >= inner.status.max_peers
        {
            return Err("Limite de espectadores atingido".into());
        }
        if role == StreamRole::Viewer
            && !inner.transports.is_empty()
            && !inner.transports.contains_key(&peer_id)
        {
            return Err("O espectador já está conectado a um host".into());
        }
        inner.status.phase = "punching";
        inner.status.peer_endpoint = Some(endpoint.clone());
        let agreement = inner
            .key_exchange
            .as_ref()
            .ok_or("Troca X25519 ausente; prepare a conexão novamente")?
            .agree(&peer_public_key);
        let (key, verification) = match agreement {
            Ok(result) => result,
            Err(error) => {
                inner.status.phase = connection_failure_phase(role, inner.transports.len());
                return Err(error);
            }
        };
        (
            inner
                .datagrams
                .clone()
                .ok_or("Inicialize o motor primeiro")?,
            role,
            inner.transports.remove(&peer_id),
            key,
            verification,
        )
    };
    if let Some(previous) = previous {
        if let Ok(mut inner) = engine.inner.lock() {
            inner.host_fanout.remove(&peer_id);
            inner.verification_codes.remove(&peer_id);
            refresh_peer_list(&mut inner);
        }
        previous.stop();
    }
    let mut control = match spawn_receiver(
        datagrams,
        peer,
        relay,
        key,
        role,
        peer_id.clone(),
        engine.inner.clone(),
    )
    .await
    {
        Ok(control) => control,
        Err(error) => {
            if let Ok(mut inner) = engine.inner.lock() {
                inner.status.phase = connection_failure_phase(role, inner.transports.len());
            }
            return Err(error);
        }
    };
    #[cfg(target_os = "windows")]
    if role == StreamRole::Host {
        let handle = control.handle();
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        inner.host_fanout.add(peer_id.clone(), handle);
        if inner.host_pipeline.is_none() {
            let capture_target = inner.capture_target;
            inner.host_pipeline = Some(pipeline::spawn(
                inner.host_fanout.clone(),
                engine.inner.clone(),
                capture_target,
            ));
        }
    } else {
        let hwnd = match renderer::open(&app).and_then(|_| renderer::hwnd(&app)) {
            Ok(hwnd) => hwnd.0 as isize,
            Err(error) => {
                control.stop();
                if let Ok(mut inner) = engine.inner.lock() {
                    inner.status.phase = "failed";
                }
                return Err(error);
            }
        };
        let pipeline = viewer::spawn(control.handle(), engine.inner.clone(), app.clone(), hwnd);
        control.attach_native_thread(pipeline);
    }
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner
        .verification_codes
        .insert(peer_id.clone(), verification_code.clone());
    inner
        .peer_metrics
        .entry(peer_id.clone())
        .or_insert_with(|| PeerMetric::waiting(peer_id.clone()));
    inner.transports.insert(peer_id, control);
    refresh_peer_list(&mut inner);
    inner.status.verification_code = if role == StreamRole::Viewer || inner.transports.len() == 1 {
        Some(verification_code)
    } else {
        None
    };
    inner.status.phase = "connected";
    Ok(())
}

#[tauri::command]
pub async fn engine_disconnect_peer(
    app: AppHandle,
    peer_id: String,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    let (control, role, remaining) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        let role = inner.status.role;
        let control = inner.transports.remove(&peer_id);
        inner.host_fanout.remove(&peer_id);
        inner.verification_codes.remove(&peer_id);
        inner.peer_metrics.remove(&peer_id);
        let remaining = inner.transports.len();
        refresh_peer_list(&mut inner);
        inner.status.peer_endpoint = None;
        inner.status.verification_code = if remaining == 1 {
            inner.verification_codes.values().next().cloned()
        } else {
            None
        };
        inner.status.phase = if remaining > 0 {
            "streaming"
        } else if inner.socket.is_some() {
            "waiting"
        } else {
            "idle"
        };
        (control, role, remaining)
    };
    if let Some(control) = control {
        control.stop();
    }
    if role == Some(StreamRole::Viewer) && remaining == 0 {
        if let Some(window) = app.get_window("stream") {
            let _ = window.hide();
        }
    }
    Ok(())
}

#[tauri::command]
pub fn engine_set_max_peers(
    max_peers: usize,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    if !(1..=16).contains(&max_peers) {
        return Err("Limite de espectadores invalido".into());
    }
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponivel")?;
    if inner.transports.len() > max_peers {
        return Err("O novo limite e menor que o numero de espectadores conectados".into());
    }
    inner.status.max_peers = max_peers;
    Ok(())
}

fn connection_failure_phase(role: StreamRole, connected_peers: usize) -> &'static str {
    match (role, connected_peers) {
        (StreamRole::Host, 0) => "waiting",
        (StreamRole::Host, _) => "streaming",
        (StreamRole::Viewer, 0) => "failed",
        (StreamRole::Viewer, _) => "connected",
    }
}

fn refresh_peer_list(inner: &mut Inner) {
    inner.status.connected_peers = inner.transports.len();
    inner.status.peer_verifications = inner
        .verification_codes
        .iter()
        .map(|(peer_id, code)| PeerVerification {
            peer_id: peer_id.clone(),
            code: code.clone(),
        })
        .collect();
    inner
        .status
        .peer_verifications
        .sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
    inner.status.peer_metrics = inner.peer_metrics.values().cloned().collect();
    inner
        .status
        .peer_metrics
        .sort_by(|a, b| a.peer_id.cmp(&b.peer_id));
}

#[tauri::command]
pub async fn engine_stop(app: AppHandle, engine: State<'_, NativeEngine>) -> Result<(), String> {
    let (controls, datagrams, fanout, pipeline) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        let controls = std::mem::take(&mut inner.transports)
            .into_values()
            .collect::<Vec<_>>();
        let datagrams = inner.datagrams.take();
        let fanout = inner.host_fanout.clone();
        let pipeline = inner.host_pipeline.take();
        *inner = Inner::default();
        inner.status.phase = "stopped";
        (controls, datagrams, fanout, pipeline)
    };
    fanout.stop();
    if let Some(datagrams) = datagrams {
        datagrams.stop();
    }
    for control in controls {
        control.stop();
    }
    if let Some(pipeline) = pipeline {
        let _ = pipeline.join();
    }
    if let Some(window) = app.get_window("stream") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
pub fn engine_status(engine: State<'_, NativeEngine>) -> Result<EngineStatus, String> {
    Ok(engine
        .inner
        .lock()
        .map_err(|_| "Estado indisponível")?
        .status
        .clone())
}

#[tauri::command]
pub fn engine_toggle_fullscreen(app: AppHandle) -> Result<bool, String> {
    renderer::toggle_fullscreen(&app)
}

#[tauri::command]
pub fn minimize_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[tauri::command]
pub fn hide_main(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
        crate::lifecycle::release_memory();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_engine_is_idle() {
        assert_eq!(EngineStatus::default().phase, "idle");
    }

    #[test]
    fn prepared_endpoint_uses_the_frontend_contract() {
        let json = serde_json::to_value(PreparedEndpoint {
            local: "192.168.1.2:40000".into(),
            public: Some("203.0.113.2:50000".into()),
            public_key: "A".repeat(43),
        })
        .unwrap();
        assert_eq!(json["publicKey"], "A".repeat(43));
        assert!(json.get("public_key").is_none());
    }
}
