use tauri::{AppHandle, Manager};

pub fn open(app: &AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_window("stream") {
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }
    tauri::window::WindowBuilder::new(app, "stream")
        .title("Voxa Stream")
        .inner_size(1280.0, 720.0)
        .min_inner_size(640.0, 360.0)
        .resizable(true)
        .build()
        .map(|_| ())
        .map_err(|e| format!("Não foi possível abrir a janela nativa: {e}"))
}
