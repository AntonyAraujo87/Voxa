//! Atalhos globais: funcionam com o jogo em primeiro plano, sem foco na janela.

use serde::Serialize;
use tauri::Emitter;

#[derive(Clone, Serialize)]
struct HotkeyEvent {
    action: &'static str,
    pressed: bool,
}

#[cfg(desktop)]
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let mods = Modifiers::CONTROL | Modifiers::SHIFT;
    let mute = Shortcut::new(Some(mods), Code::KeyM);
    let deafen = Shortcut::new(Some(mods), Code::KeyD);
    let share = Shortcut::new(Some(mods), Code::KeyE);
    // Push-to-talk num modificador puro seria impossivel de segurar durante o
    // jogo; F8 e uma tecla que quase nenhum jogo usa.
    let talk = Shortcut::new(None, Code::F8);

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let action = if shortcut == &mute {
                    "mute"
                } else if shortcut == &deafen {
                    "deafen"
                } else if shortcut == &share {
                    "share"
                } else if shortcut == &talk {
                    "talk"
                } else {
                    return;
                };

                let pressed = event.state() == ShortcutState::Pressed;
                // Toggles disparam so na descida; push-to-talk precisa dos dois
                // lados para saber quando soltar.
                if action != "talk" && !pressed {
                    return;
                }
                let _ = app.emit("hotkey", HotkeyEvent { action, pressed });
            })
            .build(),
    )?;

    let manager = app.global_shortcut();

    // Limpa antes de registrar. Um encerramento sujo — crash, kill, ou o
    // instalador substituindo o binario com o app aberto — deixa os atalhos
    // presos no sistema, e o registro seguinte falha com "already registered".
    // O sintoma para o usuario e mudo: os atalhos simplesmente nao funcionam
    // mais, sem nenhuma mensagem na interface.
    for sc in [mute, deafen, share] {
        let _ = manager.unregister(sc);
    }

    for sc in [mute, deafen, share] {
        if let Err(err) = manager.register(sc) {
            eprintln!("[voxa] atalho global recusado ({sc:?}): {err}");
        }
    }
    Ok(())
}

/// Push-to-talk rouba a tecla do sistema inteiro, entao so registra sob demanda.
#[tauri::command]
pub fn set_push_to_talk(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
        let talk = Shortcut::new(None, Code::F8);
        let manager = app.global_shortcut();
        if enabled {
            // Mesmo motivo do registro inicial: F8 pode ter ficado preso.
            let _ = manager.unregister(talk);
            manager.register(talk)
        } else {
            manager.unregister(talk)
        }
        .map_err(|e| e.to_string())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}
