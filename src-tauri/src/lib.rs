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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(native::NativeEngine::default())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            open_new_session,
            native::engine_capture_targets,
            native::engine_prepare,
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
