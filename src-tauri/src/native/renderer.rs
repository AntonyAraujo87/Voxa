use tauri::{AppHandle, Manager};
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::HWND;

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

#[cfg(target_os = "windows")]
pub fn hwnd(app: &AppHandle) -> Result<HWND, String> {
    app.get_window("stream")
        .ok_or("Janela nativa de stream ausente")?
        .hwnd()
        .map(|handle| HWND(handle.0))
        .map_err(|e| format!("Handle da janela nativa: {e}"))
}
