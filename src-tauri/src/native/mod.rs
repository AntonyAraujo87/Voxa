mod transport;

#[cfg(target_os = "windows")]
pub mod capture;
pub mod renderer;

use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State};
use tokio::net::UdpSocket;
use transport::{spawn_receiver, TransportControl};
use voxa_native_core::{protocol, stun};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamRole {
    Host,
    Viewer,
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
    dropped_frames: u64,
    keyframe_requests: u64,
    renderer: &'static str,
    capture: &'static str,
    encoder: &'static str,
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
            dropped_frames: 0,
            keyframe_requests: 0,
            renderer: "closed",
            capture: "idle",
            encoder: "idle",
        }
    }
}

#[derive(Serialize)]
pub struct PreparedEndpoint {
    local: String,
    public: Option<String>,
}

#[derive(Default)]
struct Inner {
    status: EngineStatus,
    socket: Option<Arc<UdpSocket>>,
    transport: Option<TransportControl>,
}

#[derive(Default)]
pub struct NativeEngine {
    inner: Arc<Mutex<Inner>>,
}

#[tauri::command]
pub async fn engine_prepare(
    role: StreamRole,
    engine: State<'_, NativeEngine>,
) -> Result<PreparedEndpoint, String> {
    engine_stop(engine.clone()).await?;
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
    let public = stun::discover(&socket, "stun.l.google.com:19302")
        .await
        .map_err(|error| format!("Não foi possível descobrir a rota UDP pública: {error}"))?
        .to_string();
    #[cfg(target_os = "windows")]
    let capture_state = if role == StreamRole::Host {
        if capture::probe().is_ok() {
            "dxgi-ready"
        } else {
            "dxgi-unavailable"
        }
    } else {
        "disabled"
    };
    #[cfg(not(target_os = "windows"))]
    let capture_state = if role == StreamRole::Host {
        "unsupported-os"
    } else {
        "disabled"
    };
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.socket = Some(socket);
    inner.status.phase = "waiting";
    inner.status.local_endpoint = Some(local.clone());
    inner.status.public_endpoint = Some(public.clone());
    inner.status.capture = capture_state;
    inner.status.encoder = if role == StreamRole::Host {
        "hardware-pending"
    } else {
        "decoder-pending"
    };
    Ok(PreparedEndpoint {
        local,
        public: Some(public),
    })
}

#[tauri::command]
pub async fn engine_connect_peer(
    endpoint: String,
    session_key: String,
    peer_id: String,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    let peer = endpoint.parse().map_err(|_| "Endpoint UDP inválido")?;
    let (socket, role, previous) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        inner.status.phase = "punching";
        inner.status.peer_endpoint = Some(endpoint);
        (
            inner.socket.clone().ok_or("Inicialize o motor primeiro")?,
            inner.status.role.ok_or("Modo ausente")?,
            inner.transport.take(),
        )
    };
    if let Some(previous) = previous {
        previous.stop();
    }
    let key = protocol::session_key(&session_key)?;
    let control = match spawn_receiver(socket, peer, key, role, peer_id, engine.inner.clone()).await
    {
        Ok(control) => control,
        Err(error) => {
            if let Ok(mut inner) = engine.inner.lock() {
                inner.status.phase = "failed";
            }
            return Err(error);
        }
    };
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.transport = Some(control);
    inner.status.phase = if role == StreamRole::Host {
        "streaming"
    } else {
        "connected"
    };
    Ok(())
}

#[tauri::command]
pub async fn engine_disconnect_peer(engine: State<'_, NativeEngine>) -> Result<(), String> {
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if let Some(control) = inner.transport.take() {
        control.stop();
    }
    inner.status.peer_endpoint = None;
    inner.status.phase = if inner.socket.is_some() {
        "waiting"
    } else {
        "idle"
    };
    Ok(())
}

#[tauri::command]
pub async fn engine_stop(engine: State<'_, NativeEngine>) -> Result<(), String> {
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if let Some(control) = inner.transport.take() {
        control.stop();
    }
    inner.socket = None;
    inner.status = EngineStatus {
        phase: "stopped",
        ..Default::default()
    };
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
pub async fn engine_open_renderer(
    app: AppHandle,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    renderer::open(&app)?;
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.status.renderer = "native-window";
    Ok(())
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
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn default_engine_is_idle() {
        assert_eq!(EngineStatus::default().phase, "idle");
    }
}
