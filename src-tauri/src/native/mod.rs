mod diagnostics;
mod identity;
mod model;
mod pake;
mod transport;

#[cfg(target_os = "windows")]
mod audio;
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

use model::Inner;
pub use model::{
    AudioProcessInfo, CaptureTargetId, CaptureTargetInfo, EngineStatus, GraphicsAdapterInfo,
    NativeEngine, PeerMetric, PeerVerification, PreparedEndpoint, StreamRole,
};
use serde::Deserialize;
use std::{
    fs,
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager, State};
use tokio::net::UdpSocket;
use transport::{spawn_receiver, DatagramHub, PeerTransport};
use voxa_native_core::{protocol, stun};

fn effective_max_peers(signaling_max: usize, encoder_capacity: usize) -> usize {
    signaling_max.clamp(1, 16).min(encoder_capacity.max(1))
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
pub fn engine_audio_processes() -> Result<Vec<AudioProcessInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        audio::enumerate_processes()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn engine_graphics_adapters() -> Result<Vec<GraphicsAdapterInfo>, String> {
    #[cfg(target_os = "windows")]
    {
        capture::enumerate_adapters()
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

#[tauri::command]
pub fn engine_switch_capture(
    capture_target: CaptureTargetId,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let capture = capture::DxgiCapture::open(Some(capture_target))
            .map_err(|error| format!("O novo monitor não pode ser capturado: {error}"))?;
        let available =
            encoder::hardware_encoder_codecs_for_device(&capture.device).unwrap_or_default();
        let codecs = protocol::VideoCodec::mask(available.iter().copied());
        let encoder_capacity =
            encoder::hardware_encoder_capacity_for_device(&capture.device, &available, 4).max(1);
        if codecs == 0 {
            return Err("A GPU do novo monitor não possui encoder compatível".into());
        }
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        if inner.status.role != Some(StreamRole::Host) || inner.socket.is_none() {
            return Err("Inicie uma hospedagem antes de trocar o monitor".into());
        }
        if !inner.host_fanout.peers_support_any(codecs) {
            return Err(
                "A GPU do novo monitor não possui codec em comum com todos os espectadores".into(),
            );
        }
        if inner.transports.len() > encoder_capacity {
            return Err(format!(
                "A nova GPU suporta somente {encoder_capacity} encoder(es) simultâneo(s)"
            ));
        }
        inner.capture_target = Some(capture_target);
        inner.supported_codecs = codecs;
        inner.hardware_encoder_capacity = encoder_capacity;
        inner.host_fanout.set_supported_codecs(codecs);
        inner.status.capture = "switching-monitor";
        inner.status.encoder = "restarting";
        inner.status.encoder_capacity = encoder_capacity;
        inner.status.max_peers = effective_max_peers(inner.signaling_max_peers, encoder_capacity);
        inner.status.hdr = capture.hdr;
        inner.host_fanout.request_keyframe();
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (capture_target, engine);
        Err("Captura nativa disponível somente no Windows".into())
    }
}

#[tauri::command]
pub fn engine_switch_audio(
    audio_process_id: Option<u32>,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if inner.status.role != Some(StreamRole::Host) || inner.socket.is_none() {
        return Err("Inicie uma hospedagem antes de trocar a origem de áudio".into());
    }
    inner.audio_process_id = audio_process_id;
    inner.status.audio = "switching-source";
    inner.status.audio_error = None;
    Ok(())
}

#[tauri::command]
pub fn engine_set_cursor_visible(
    visible: bool,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.cursor_visible = visible;
    inner.status.cursor_visible = visible;
    Ok(())
}

#[tauri::command]
pub fn engine_export_diagnostic(
    app: AppHandle,
    engine: State<'_, NativeEngine>,
) -> Result<String, String> {
    let (status, capture_target, audio_process_id, supported_codecs, capacity, recent_events) = {
        let inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        (
            inner.status.clone(),
            inner.capture_target,
            inner.audio_process_id,
            inner.supported_codecs,
            inner.hardware_encoder_capacity,
            inner.diagnostics.snapshot(),
        )
    };
    let codec_names = protocol::VideoCodec::ALL
        .into_iter()
        .filter(|codec| supported_codecs & codec.bit() != 0)
        .map(protocol::VideoCodec::name)
        .collect::<Vec<_>>();
    #[cfg(target_os = "windows")]
    let (targets, adapters) = (
        capture::enumerate_targets().unwrap_or_default(),
        capture::enumerate_adapters().unwrap_or_default(),
    );
    #[cfg(not(target_os = "windows"))]
    let (targets, adapters): (Vec<CaptureTargetInfo>, Vec<GraphicsAdapterInfo>) =
        (Vec::new(), Vec::new());
    let generated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let report = serde_json::json!({
        "product": "Voxa",
        "version": env!("CARGO_PKG_VERSION"),
        "generatedAtUnix": generated_at,
        "system": { "os": std::env::consts::OS, "arch": std::env::consts::ARCH },
        "status": status,
        "selectedCaptureTarget": capture_target,
        "audioProcessId": audio_process_id,
        "supportedCodecs": codec_names,
        "encoderCapacity": capacity,
        "captureTargets": targets,
        "graphicsAdapters": adapters,
        "recentEvents": recent_events,
        "panicLog": crate::diagnostico::read_panic_log(app.clone()),
        "privacy": "Sem senha da sala, chaves de mídia ou conteúdo transmitido"
    });
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Pasta Documentos indisponível: {error}"))?;
    let directory = documents.join("Voxa");
    fs::create_dir_all(&directory)
        .map_err(|error| format!("Não foi possível criar a pasta de diagnóstico: {error}"))?;
    let path = directory.join(format!("voxa-diagnostico-{generated_at}.json"));
    fs::write(
        &path,
        serde_json::to_vec_pretty(&report).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("Não foi possível salvar o diagnóstico: {error}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn engine_prepare(
    app: AppHandle,
    role: StreamRole,
    capture_target: Option<CaptureTargetId>,
    audio_process_id: Option<u32>,
    decoder_adapter_index: Option<u32>,
    reuse_identity: bool,
    engine: State<'_, NativeEngine>,
) -> Result<PreparedEndpoint, String> {
    let preserved_identity = if reuse_identity {
        engine
            .inner
            .lock()
            .map_err(|_| "Estado indisponível")?
            .key_exchange
            .take()
    } else {
        None
    };
    engine_stop(app, engine.clone()).await?;
    {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        inner.status.phase = "binding";
        inner.status.role = Some(role);
        inner
            .diagnostics
            .record("session", "binding", serde_json::json!({ "role": role }));
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
    let key_exchange = match preserved_identity {
        Some(identity) => identity,
        None => identity::load_or_create()?,
    };
    let public_key = key_exchange.public_base64();
    #[cfg(target_os = "windows")]
    let (capture_state, encoder_state, codecs, encoder_capacity, hdr) = if role == StreamRole::Host
    {
        let capture = capture::DxgiCapture::open(capture_target)
            .map_err(|error| format!("O monitor selecionado não pode ser capturado: {error}"))?;
        let capture_state = "dxgi-ready";
        let available =
            encoder::hardware_encoder_codecs_for_device(&capture.device).unwrap_or_default();
        let encoder_capacity =
            encoder::hardware_encoder_capacity_for_device(&capture.device, &available, 4).max(1);
        let encoder_state = if available.is_empty() {
            "hardware-unavailable"
        } else {
            "hardware-detected"
        };
        (
            capture_state,
            encoder_state,
            protocol::VideoCodec::mask(available),
            encoder_capacity,
            capture.hdr,
        )
    } else {
        let available = viewer::hardware_decoder_codecs(decoder_adapter_index).unwrap_or_default();
        (
            "disabled",
            "decoder-pending",
            protocol::VideoCodec::mask(available),
            1,
            false,
        )
    };
    #[cfg(not(target_os = "windows"))]
    let (capture_state, encoder_state, codecs, encoder_capacity, hdr) = if role == StreamRole::Host
    {
        ("unsupported-os", "hardware-unavailable", 0, 1, false)
    } else {
        ("disabled", "decoder-pending", 0, 1, false)
    };
    if codecs == 0 {
        return Err("Nenhum codec de vídeo por hardware compatível foi encontrado".into());
    }
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    inner.datagrams = Some(DatagramHub::new(socket.clone()));
    inner.socket = Some(socket);
    inner.key_exchange = Some(key_exchange);
    inner.capture_target = capture_target;
    inner.audio_process_id = audio_process_id.filter(|_| role == StreamRole::Host);
    inner.decoder_adapter_index = decoder_adapter_index.filter(|_| role == StreamRole::Viewer);
    inner.supported_codecs = codecs;
    inner.hardware_encoder_capacity = encoder_capacity;
    inner.signaling_max_peers = 4;
    inner.cursor_visible = true;
    inner.host_fanout.set_supported_codecs(codecs);
    inner.status.phase = "waiting";
    inner.status.local_endpoint = Some(local.clone());
    inner.status.public_endpoint = public.clone();
    inner.status.capture = capture_state;
    inner.status.encoder = encoder_state;
    inner.status.encoder_capacity = encoder_capacity;
    inner.status.max_peers = effective_max_peers(inner.signaling_max_peers, encoder_capacity);
    inner.status.cursor_visible = true;
    inner.status.hdr = hdr;
    inner.diagnostics.record(
        "session",
        "prepared",
        serde_json::json!({
            "role": role,
            "publicRouteAvailable": public.is_some(),
            "codecs": codecs,
            "encoderCapacity": encoder_capacity,
        }),
    );
    Ok(PreparedEndpoint {
        local,
        public,
        public_key,
        codecs,
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectRequest {
    endpoint: String,
    peer_public_key: String,
    peer_codecs: u8,
    peer_id: String,
    relay_endpoint: Option<String>,
    relay_session: Option<String>,
    relay_auth: Option<String>,
}

#[tauri::command]
pub fn engine_pake_begin(
    peer_id: String,
    room: String,
    room_secret: String,
    engine: State<'_, NativeEngine>,
) -> Result<pake::PakeStart, String> {
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    let role = inner.status.role.ok_or("Modo de conexão ausente")?;
    if inner.socket.is_none() {
        return Err("Prepare a conexão antes de autenticar o computador".into());
    }
    inner.pake.begin(&peer_id, role, &room, &room_secret)
}

#[tauri::command]
pub fn engine_pake_finish(
    peer_id: String,
    remote_share: String,
    engine: State<'_, NativeEngine>,
) -> Result<String, String> {
    engine
        .inner
        .lock()
        .map_err(|_| "Estado indisponível")?
        .pake
        .finish(&peer_id, &remote_share)
}

#[tauri::command]
pub fn engine_pake_confirm(
    peer_id: String,
    remote_confirmation: String,
    engine: State<'_, NativeEngine>,
) -> Result<(), String> {
    engine
        .inner
        .lock()
        .map_err(|_| "Estado indisponível")?
        .pake
        .confirm(&peer_id, &remote_confirmation)
}

#[tauri::command]
pub fn engine_is_trusted(peer_public_key: String) -> Result<bool, String> {
    identity::is_trusted(&peer_public_key)
}

#[tauri::command]
pub fn engine_trust_peer(
    peer_id: String,
    peer_public_key: String,
    engine: State<'_, NativeEngine>,
) -> Result<usize, String> {
    let inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if inner.status.role != Some(StreamRole::Host) || inner.pake.binding_key(&peer_id).is_none() {
        return Err("Autentique o espectador antes de confiar neste computador".into());
    }
    if inner.peer_public_keys.get(&peer_id) != Some(&peer_public_key) {
        return Err("A chave do computador não corresponde ao par autenticado".into());
    }
    drop(inner);
    identity::trust(&peer_public_key)
}

#[tauri::command]
pub fn engine_clear_trusted() -> Result<(), String> {
    identity::clear_trusted()
}

#[tauri::command]
pub fn engine_preview_peer(
    peer_id: String,
    peer_public_key: String,
    engine: State<'_, NativeEngine>,
) -> Result<String, String> {
    if peer_id.is_empty() || peer_id.len() > 128 {
        return Err("Identidade do computador inválida".into());
    }
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if inner.status.role != Some(StreamRole::Host) || inner.socket.is_none() {
        return Err("Aprovação disponível somente para o host ativo".into());
    }
    let binding = inner
        .pake
        .binding_key(&peer_id)
        .ok_or("A senha da sala ainda não foi autenticada por SPAKE2")?;
    let (_, verification) = inner
        .key_exchange
        .as_ref()
        .ok_or("Troca X25519 ausente; prepare a conexão novamente")?
        .agree_bound(&peer_public_key, Some(&binding))?;
    inner.peer_public_keys.insert(peer_id, peer_public_key);
    Ok(verification)
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
        peer_codecs,
        peer_id,
        relay_endpoint,
        relay_session,
        relay_auth,
    } = request;
    if peer_id.is_empty() || peer_id.len() > 128 {
        return Err("Identidade do computador inválida".into());
    }
    if peer_codecs == 0 || peer_codecs & !0b111 != 0 {
        return Err("Lista de codecs do computador remoto inválida".into());
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
    let relay_configured = relay.is_some();
    let (datagrams, role, generation, previous, key, verification_code) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        let role = inner.status.role.ok_or("Modo ausente")?;
        if protocol::VideoCodec::best_common(inner.supported_codecs, peer_codecs).is_none() {
            return Err("Os computadores não possuem um codec de vídeo em comum".into());
        }
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
        let binding = inner
            .pake
            .binding_key(&peer_id)
            .ok_or("A senha da sala ainda não foi autenticada por SPAKE2")?;
        let agreement = inner
            .key_exchange
            .as_ref()
            .ok_or("Troca X25519 ausente; prepare a conexão novamente")?
            .agree_bound(&peer_public_key, Some(&binding));
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
            inner.generation,
            inner.transports.remove(&peer_id),
            key,
            verification,
        )
    };
    if let Some(previous) = previous {
        if let Ok(mut inner) = engine.inner.lock() {
            if session_is_current(&inner, generation, role) {
                inner.host_fanout.remove(&peer_id);
                inner.verification_codes.remove(&peer_id);
                refresh_peer_list(&mut inner);
            }
        }
        previous.stop();
    }
    let mut control = match spawn_receiver(
        datagrams,
        PeerTransport {
            endpoint: peer,
            relay,
            id: peer_id.clone(),
            codecs: peer_codecs,
        },
        key,
        role,
        engine.inner.clone(),
    )
    .await
    {
        Ok(control) => control,
        Err(error) => {
            if let Ok(mut inner) = engine.inner.lock() {
                if session_is_current(&inner, generation, role) {
                    inner.status.phase = connection_failure_phase(role, inner.transports.len());
                }
            }
            return Err(error);
        }
    };
    if !engine
        .inner
        .lock()
        .map(|inner| session_is_current(&inner, generation, role))
        .unwrap_or(false)
    {
        control.stop();
        return Err("A sessão foi encerrada durante a conexão".into());
    }
    #[cfg(target_os = "windows")]
    if role == StreamRole::Host {
        let handle = control.handle();
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        if !session_is_current(&inner, generation, role) {
            drop(inner);
            control.stop();
            return Err("A sessão foi encerrada durante a conexão".into());
        }
        inner.host_fanout.add(peer_id.clone(), handle);
        if inner.host_pipeline.is_none() {
            inner.host_pipeline = Some(pipeline::spawn(
                inner.host_fanout.clone(),
                engine.inner.clone(),
            ));
        }
        if inner.host_audio.is_none() {
            inner.host_audio = Some(audio::spawn_capture(
                inner.host_fanout.clone(),
                engine.inner.clone(),
            ));
        }
    } else {
        let hwnd = match renderer::open(&app).and_then(|_| renderer::hwnd(&app)) {
            Ok(hwnd) => hwnd.0 as isize,
            Err(error) => {
                control.stop();
                if let Ok(mut inner) = engine.inner.lock() {
                    if session_is_current(&inner, generation, role) {
                        inner.status.phase = "failed";
                    }
                }
                return Err(error);
            }
        };
        if !engine
            .inner
            .lock()
            .map(|inner| session_is_current(&inner, generation, role))
            .unwrap_or(false)
        {
            control.stop();
            return Err("A sessão foi encerrada durante a conexão".into());
        }
        let decoder_adapter_index = engine
            .inner
            .lock()
            .ok()
            .and_then(|inner| inner.decoder_adapter_index);
        let pipeline = viewer::spawn(
            control.handle(),
            engine.inner.clone(),
            app.clone(),
            hwnd,
            decoder_adapter_index,
        );
        control.attach_native_thread(pipeline);
    }
    let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    if !session_is_current(&inner, generation, role) {
        drop(inner);
        control.stop();
        return Err("A sessão foi encerrada durante a conexão".into());
    }
    inner
        .verification_codes
        .insert(peer_id.clone(), verification_code.clone());
    inner
        .peer_public_keys
        .insert(peer_id.clone(), peer_public_key);
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
    inner.diagnostics.record(
        "peer",
        "connected",
        serde_json::json!({
            "role": role,
            "codecMask": peer_codecs,
            "relayConfigured": relay_configured,
            "connectedPeers": inner.transports.len(),
        }),
    );
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
        inner.peer_public_keys.remove(&peer_id);
        inner.peer_metrics.remove(&peer_id);
        inner.pake.remove(&peer_id);
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
        inner.diagnostics.record(
            "peer",
            "disconnected",
            serde_json::json!({
                "remainingPeers": remaining,
            }),
        );
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
    let effective = effective_max_peers(max_peers, inner.hardware_encoder_capacity);
    if inner.transports.len() > effective {
        return Err("O novo limite e menor que o numero de espectadores conectados".into());
    }
    inner.signaling_max_peers = max_peers;
    inner.status.max_peers = effective;
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

fn session_is_current(inner: &Inner, generation: u64, role: StreamRole) -> bool {
    inner.generation == generation && inner.status.role == Some(role) && inner.socket.is_some()
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
    let (controls, datagrams, fanout, pipeline, audio, generation) = {
        let mut inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
        let controls = std::mem::take(&mut inner.transports)
            .into_values()
            .collect::<Vec<_>>();
        let datagrams = inner.datagrams.take();
        let fanout = inner.host_fanout.clone();
        let pipeline = inner.host_pipeline.take();
        let audio = inner.host_audio.take();
        let next_generation = inner.generation.wrapping_add(1);
        let diagnostics = inner.diagnostics.clone();
        *inner = Inner::default();
        inner.diagnostics = diagnostics;
        inner.generation = next_generation;
        inner.status.phase = "stopped";
        inner
            .diagnostics
            .record("session", "stopped", serde_json::json!({}));
        (
            controls,
            datagrams,
            fanout,
            pipeline,
            audio,
            next_generation,
        )
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
    if let Some(audio) = audio {
        let _ = audio.join();
    }
    if let Some(window) = app.get_window("stream") {
        let _ = window.hide();
    }
    if let Ok(mut inner) = engine.inner.lock() {
        if inner.generation == generation && inner.socket.is_none() {
            inner.status = EngineStatus::default();
            inner.status.phase = "stopped";
        }
    }
    Ok(())
}

#[tauri::command]
pub fn engine_status(engine: State<'_, NativeEngine>) -> Result<EngineStatus, String> {
    let inner = engine.inner.lock().map_err(|_| "Estado indisponível")?;
    let status = inner.status.clone();
    inner.diagnostics.record_status(&status);
    Ok(status)
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
    fn peer_limit_recovers_after_switching_to_a_more_capable_gpu() {
        assert_eq!(effective_max_peers(4, 1), 1);
        assert_eq!(effective_max_peers(4, 4), 4);
        assert_eq!(effective_max_peers(2, 4), 2);
    }

    #[test]
    fn prepared_endpoint_uses_the_frontend_contract() {
        let json = serde_json::to_value(PreparedEndpoint {
            local: "192.168.1.2:40000".into(),
            public: Some("203.0.113.2:50000".into()),
            public_key: "A".repeat(43),
            codecs: protocol::VideoCodec::H264.bit(),
        })
        .unwrap();
        assert_eq!(json["publicKey"], "A".repeat(43));
        assert_eq!(json["codecs"], 1);
        assert!(json.get("public_key").is_none());
    }

    #[tokio::test]
    async fn stopped_generation_rejects_late_peer_connection() {
        let mut inner = Inner {
            generation: 7,
            ..Default::default()
        };
        inner.status.role = Some(StreamRole::Host);
        assert!(!session_is_current(&inner, 7, StreamRole::Host));
        inner.socket = Some(Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap()));
        assert!(session_is_current(&inner, 7, StreamRole::Host));
        inner.generation += 1;
        assert!(!session_is_current(&inner, 7, StreamRole::Host));
    }
}
