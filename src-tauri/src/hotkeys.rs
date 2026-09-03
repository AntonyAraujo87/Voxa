//! Atalhos globais: funcionam com o jogo em primeiro plano, sem foco na janela.
//!
//! Atalho global e um recurso exclusivo do sistema: o primeiro programa a
//! registrar uma combinacao fica com ela, e os proximos recebem um erro. Na
//! pratica isso acontece o tempo todo — `Ctrl+Shift+M` e o mudo global do
//! Discord, e quem tem Discord aberto nunca conseguiria o nosso.
//!
//! Por isso cada acao tem uma combinacao alternativa, e o resultado real e
//! reportado ao frontend. Antes o fracasso ia so para o log: o usuario
//! apertava a tecla, nada acontecia, e nao havia como descobrir o motivo.

use serde::Serialize;
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize)]
struct HotkeyEvent {
    action: &'static str,
    pressed: bool,
}

/// Qual combinacao ficou valendo para cada acao, ou nenhuma.
#[derive(Clone, Default, Serialize)]
pub struct HotkeyStatus {
    pub mute: Option<String>,
    pub deafen: Option<String>,
    pub share: Option<String>,
}

#[cfg(desktop)]
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let ctrl_shift = Modifiers::CONTROL | Modifiers::SHIFT;
    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;

    // Primeira opcao e a convencional; a segunda existe para quando o Discord
    // (ou qualquer outro) ja tiver tomado a primeira.
    let mute = [
        (Shortcut::new(Some(ctrl_shift), Code::KeyM), "Ctrl+Shift+M"),
        (Shortcut::new(Some(ctrl_alt), Code::KeyM), "Ctrl+Alt+M"),
    ];
    let deafen = [
        (Shortcut::new(Some(ctrl_shift), Code::KeyD), "Ctrl+Shift+D"),
        (Shortcut::new(Some(ctrl_alt), Code::KeyD), "Ctrl+Alt+D"),
    ];
    let share = [
        (Shortcut::new(Some(ctrl_shift), Code::KeyE), "Ctrl+Shift+E"),
        (Shortcut::new(Some(ctrl_alt), Code::KeyE), "Ctrl+Alt+E"),
    ];
    // Push-to-talk num modificador seria impossivel de segurar durante o jogo.
    let talk = Shortcut::new(None, Code::F8);

    let todos = [
        mute[0].0,
        mute[1].0,
        deafen[0].0,
        deafen[1].0,
        share[0].0,
        share[1].0,
    ];

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let action = if *shortcut == mute[0].0 || *shortcut == mute[1].0 {
                    "mute"
                } else if *shortcut == deafen[0].0 || *shortcut == deafen[1].0 {
                    "deafen"
                } else if *shortcut == share[0].0 || *shortcut == share[1].0 {
                    "share"
                } else if *shortcut == talk {
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

    // Limpa antes de registrar: um encerramento sujo — crash, kill, ou o
    // instalador substituindo o binario com o app aberto — deixa registros
    // presos, e a tentativa seguinte falha.
    for sc in todos {
        let _ = manager.unregister(sc);
    }

    // Tenta as combinacoes em ordem e guarda o rotulo da que funcionou.
    let registrar = |opcoes: &[(Shortcut, &'static str)]| -> Option<String> {
        for (sc, rotulo) in opcoes {
            if manager.register(*sc).is_ok() {
                return Some((*rotulo).to_string());
            }
        }
        None
    };

    let status = HotkeyStatus {
        mute: registrar(&mute),
        deafen: registrar(&deafen),
        share: registrar(&share),
    };

    for (acao, valor) in [
        ("microfone", &status.mute),
        ("ensurdecer", &status.deafen),
        ("compartilhar", &status.share),
    ] {
        match valor {
            Some(combo) => println!("[voxa] atalho {acao}: {combo}"),
            None => eprintln!("[voxa] atalho {acao}: indisponivel (outro programa ja usa)"),
        }
    }

    app.manage(std::sync::Mutex::new(status));
    Ok(())
}

/// Combinacoes efetivamente ativas, para a interface mostrar as certas.
#[tauri::command]
pub fn hotkey_status(app: tauri::AppHandle) -> HotkeyStatus {
    app.try_state::<std::sync::Mutex<HotkeyStatus>>()
        .and_then(|s| s.lock().ok().map(|g| g.clone()))
        .unwrap_or_default()
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
