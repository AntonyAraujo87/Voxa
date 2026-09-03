//! Janela flutuante que mostra quem esta falando por cima do jogo.
//!
//! Sem hook de DirectX/D3D de proposito: injetar no processo do jogo pra
//! desenhar por cima dele e exatamente o padrao que anticheat (Vanguard,
//! EAC, BattlEye) trata como ameaca — derrubaria o Voxa numa lista negra ou,
//! pior, o proprio jogo do usuario. Uma janela normal, transparente e
//! always-on-top e o que Discord e Parsec tambem fazem por padrao: funciona
//! em janela/borderless, nao em fullscreen exclusivo — troca deliberada.
//!
//! O estado (quem fala) mora na janela principal, que ja tem toda a logica
//! de voz; aqui so existe a JANELA. A ponte e um evento Tauri comum
//! (`overlay:roster`), emitido pelo frontend da janela principal e ouvido
//! pelo frontend da janela overlay — as duas rodam processos de WebView
//! separados, sem memoria compartilhada.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};

const LABEL: &str = "overlay";

#[tauri::command]
pub fn set_overlay_enabled(app: AppHandle, on: bool) -> Result<(), String> {
    if !on {
        if let Some(win) = app.get_webview_window(LABEL) {
            let _ = win.close();
        }
        return Ok(());
    }

    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }

    let win = WebviewWindowBuilder::new(&app, LABEL, WebviewUrl::App("index.html#overlay".into()))
        .title("Voxa")
        .inner_size(220.0, 360.0)
        .position(40.0, 40.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .resizable(false)
        .focused(false)
        .visible(true)
        .build()
        .map_err(|e| e.to_string())?;

    // So um indicador visual — clique atravessa pra janela (ou jogo) por
    // baixo. Sem isso a pessoa clicaria sem querer numa janela invisivel
    // por cima do jogo e perderia o foco dele.
    let _ = win.set_ignore_cursor_events(true);

    Ok(())
}
