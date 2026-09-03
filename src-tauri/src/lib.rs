// ---------------------------------------------------------------------------
// VOXA — backend Tauri.
//
// A janela e so a casca: todo o WebRTC roda no WebView2. O Rust cuida do que o
// navegador nao alcanca — flags de GPU e captura, permissao de microfone,
// atalhos globais e o ciclo de vida da janela.
//
//   webview.rs   flags do Chromium e permissao de midia
//   capture.rs   escolha e persistencia da fonte de captura
//   hotkeys.rs   atalhos globais e push-to-talk
//   lifecycle.rs bandeja do sistema e liberacao de memoria
// ---------------------------------------------------------------------------

mod capture;
mod hotkeys;
mod lifecycle;
mod webview;

use tauri::Manager;

/// Metadados do build, exibidos no painel de diagnostico do app.
#[tauri::command]
fn runtime_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    webview::tune();

    tauri::Builder::default()
        // Fechar a janela esconde na bandeja: sem esta guarda, abrir o atalho
        // de novo criaria um SEGUNDO processo — dois icones na bandeja, duas
        // conexoes com o mesmo apelido e o microfone disputado entre eles.
        // A segunda instancia apenas traz a primeira de volta e encerra.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            capture::list_capture_sources,
            capture::set_capture_source,
            capture::get_capture_source,
            hotkeys::set_push_to_talk,
            hotkeys::hotkey_status,
            lifecycle::release_memory,
            lifecycle::flash_taskbar
        ])
        .on_window_event(lifecycle::handle_window_event)
        .setup(|app| {
            #[cfg(desktop)]
            if let Err(err) = hotkeys::setup(app.handle()) {
                eprintln!("[voxa] atalhos globais indisponiveis: {err}");
            }

            #[cfg(desktop)]
            if let Err(err) = lifecycle::setup_tray(app.handle()) {
                eprintln!("[voxa] bandeja indisponivel: {err}");
            }

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| webview::grant_media_permissions(&webview));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
