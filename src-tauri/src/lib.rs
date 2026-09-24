mod diagnostico;
mod lifecycle;
mod native;

#[tauri::command]
fn runtime_info() -> serde_json::Value {
    serde_json::json!({"os":std::env::consts::OS,"arch":std::env::consts::ARCH,"version":env!("CARGO_PKG_VERSION"),"media":"native-udp"})
}

#[tauri::command]
fn open_new_session() -> Result<(), String> {
    let executable =
        std::env::current_exe().map_err(|e| format!("Não foi possível localizar o Voxa: {e}"))?;
    std::process::Command::new(executable)
        .arg("--voxa-secondary-session")
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("Não foi possível abrir outra sessão do Voxa: {e}"))
}

fn derive_room_proof_inner(room: &str, password: &str) -> Result<String, String> {
    if room.is_empty() || room.len() > 64 || password.len() < 12 || password.len() > 128 {
        return Err("Sala ou senha inválida".into());
    }
    let params = argon2::Params::new(64 * 1024, 3, 1, Some(32))
        .map_err(|e| format!("Parâmetros Argon2id: {e}"))?;
    let argon = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let salt = format!("voxa-room-v3\0{room}");
    let mut proof = [0u8; 32];
    argon
        .hash_password_into(password.as_bytes(), salt.as_bytes(), &mut proof)
        .map_err(|e| format!("Derivação segura da sala: {e}"))?;
    Ok(proof.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[tauri::command]
async fn derive_room_proof(room: String, password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || derive_room_proof_inner(&room, &password))
        .await
        .map_err(|error| format!("Falha ao derivar a credencial da sala: {error}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native::NativeEngine::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            open_new_session,
            derive_room_proof,
            native::engine_capture_targets,
            native::engine_audio_processes,
            native::engine_graphics_adapters,
            native::engine_switch_capture,
            native::engine_switch_audio,
            native::engine_prepare,
            native::engine_preview_peer,
            native::engine_connect_peer,
            native::engine_disconnect_peer,
            native::engine_set_max_peers,
            native::engine_stop,
            native::engine_status,
            native::engine_toggle_fullscreen,
            native::minimize_main,
            native::hide_main,
            diagnostico::read_panic_log,
            lifecycle::release_memory
        ])
        .on_window_event(lifecycle::handle_window_event)
        .setup(|app| {
            diagnostico::setup(app.handle());
            #[cfg(desktop)]
            if let Err(error) = lifecycle::setup_tray(app.handle()) {
                eprintln!("[voxa] tray: {error}");
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Voxa");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn room_proof_uses_fixed_length_argon2_output() {
        let proof = derive_room_proof_inner("sala-segura", "senha-com-mais-de-doze")
            .expect("Argon2id deve derivar a prova");
        assert_eq!(proof.len(), 64);
        assert!(proof.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(proof, "senha-com-mais-de-doze");
    }
}
