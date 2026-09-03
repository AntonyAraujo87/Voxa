//! Atalhos globais: funcionam com o jogo em primeiro plano, sem foco na janela.
//!
//! Atalho global e um recurso exclusivo do sistema: o primeiro programa a
//! registrar uma combinacao fica com ela, e os proximos recebem um erro. Na
//! pratica isso acontece o tempo todo — `Ctrl+Shift+M` e o mudo global do
//! Discord, e quem tem Discord aberto nunca conseguiria o nosso.
//!
//! Por isso cada acao tem uma combinacao padrao com alternativa embutida, e
//! alem disso o usuario pode trocar qualquer uma pela tecla que quiser —
//! `rebind_hotkey` desregistra a antiga e tenta registrar a nova, reportando
//! o resultado real. `Code` aqui e o mesmo tipo de `keyboard-types`, entao
//! aceita exatamente o `KeyboardEvent.code` que o frontend captura — sem
//! tabela de conversao entre os dois lados.

use serde::Serialize;
use std::sync::Mutex;
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
    pub talk: Option<String>,
}

#[cfg(desktop)]
struct Binding {
    action: &'static str,
    shortcut: tauri_plugin_global_shortcut::Shortcut,
}

#[cfg(desktop)]
pub struct HotkeyState {
    /// o que esta de fato registrado no sistema agora — push-to-talk so
    /// entra aqui quando o modo esta ligado, as outras tres sempre que
    /// conseguirem registrar.
    bindings: Mutex<Vec<Binding>>,
    /// rotulos pra interface mostrar.
    status: Mutex<HotkeyStatus>,
    /// `code` cru (formato `KeyboardEvent.code`) configurado pro
    /// push-to-talk, mesmo quando o modo esta desligado e a tecla nao esta
    /// registrada em lugar nenhum — e o que `set_push_to_talk` usa quando o
    /// modo liga.
    talk_code: Mutex<String>,
}

#[cfg(desktop)]
fn acao_estatica(action: &str) -> Option<&'static str> {
    match action {
        "mute" => Some("mute"),
        "deafen" => Some("deafen"),
        "share" => Some("share"),
        "talk" => Some("talk"),
        _ => None,
    }
}

#[cfg(desktop)]
fn grava_status(status: &mut HotkeyStatus, action: &str, valor: Option<String>) {
    match action {
        "mute" => status.mute = valor,
        "deafen" => status.deafen = valor,
        "share" => status.share = valor,
        "talk" => status.talk = valor,
        _ => {}
    }
}

#[cfg(desktop)]
pub fn setup(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{
        Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
    };

    let ctrl_shift = Modifiers::CONTROL | Modifiers::SHIFT;
    let ctrl_alt = Modifiers::CONTROL | Modifiers::ALT;

    // Primeira opcao e a convencional; a segunda existe para quando o Discord
    // (ou qualquer outro) ja tiver tomado a primeira. So valem no primeiro
    // boot — depois disso, quem manda e o que estiver salvo nas preferencias
    // (reaplicado via rebind_hotkey logo apos o hydrate no frontend).
    let padroes: [(&'static str, [(Shortcut, &'static str); 2]); 3] = [
        (
            "mute",
            [
                (Shortcut::new(Some(ctrl_shift), Code::KeyM), "Ctrl+Shift+M"),
                (Shortcut::new(Some(ctrl_alt), Code::KeyM), "Ctrl+Alt+M"),
            ],
        ),
        (
            "deafen",
            [
                (Shortcut::new(Some(ctrl_shift), Code::KeyD), "Ctrl+Shift+D"),
                (Shortcut::new(Some(ctrl_alt), Code::KeyD), "Ctrl+Alt+D"),
            ],
        ),
        (
            "share",
            [
                (Shortcut::new(Some(ctrl_shift), Code::KeyE), "Ctrl+Shift+E"),
                (Shortcut::new(Some(ctrl_alt), Code::KeyE), "Ctrl+Alt+E"),
            ],
        ),
    ];

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let state = app.state::<HotkeyState>();
                let action = {
                    let bindings = match state.bindings.lock() {
                        Ok(b) => b,
                        Err(_) => return,
                    };
                    bindings
                        .iter()
                        .find(|b| b.shortcut == *shortcut)
                        .map(|b| b.action)
                };
                let Some(action) = action else { return };

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

    // Limpa antes de registrar: um encerramento sujo — crash, kill, ou o
    // instalador substituindo o binario com o app aberto — deixa registros
    // presos, e a tentativa seguinte falha.
    let manager = app.global_shortcut();
    for (_, opcoes) in &padroes {
        for (sc, _) in opcoes {
            let _ = manager.unregister(*sc);
        }
    }
    let _ = manager.unregister(Shortcut::new(None, Code::F8));

    let mut bindings = Vec::new();
    let mut status = HotkeyStatus::default();

    for (action, opcoes) in &padroes {
        let mut ok = false;
        for (sc, rotulo) in opcoes {
            if manager.register(*sc).is_ok() {
                bindings.push(Binding {
                    action,
                    shortcut: *sc,
                });
                grava_status(&mut status, action, Some((*rotulo).to_string()));
                ok = true;
                break;
            }
        }
        if !ok {
            eprintln!("[voxa] atalho {action}: indisponivel (outro programa ja usa)");
        }
    }

    // So um rotulo, sem registrar no sistema — talk so entra de fato quando
    // o modo push-to-talk liga, mas a interface precisa saber qual e a tecla
    // configurada mesmo com o modo desligado.
    grava_status(&mut status, "talk", Some("F8".to_string()));

    app.manage(HotkeyState {
        bindings: Mutex::new(bindings),
        status: Mutex::new(status),
        talk_code: Mutex::new("F8".to_string()),
    });
    Ok(())
}

/// Combinacoes efetivamente ativas, para a interface mostrar as certas.
#[tauri::command]
pub fn hotkey_status(app: tauri::AppHandle) -> HotkeyStatus {
    #[cfg(desktop)]
    {
        app.try_state::<HotkeyState>()
            .and_then(|s| s.status.lock().ok().map(|g| g.clone()))
            .unwrap_or_default()
    }
    #[cfg(not(desktop))]
    {
        let _ = app;
        HotkeyStatus::default()
    }
}

/// Troca a combinacao de uma acao pela tecla que o usuario escolheu na
/// interface. `code` e o `KeyboardEvent.code` cru ("KeyM", "F9", "Digit5"...);
/// `code: None` remove o atalho da acao sem colocar outro no lugar.
/// Push-to-talk (`action == "talk"`) nao aceita modificador — segurar Ctrl
/// junto com outra tecla o jogo inteiro nao da.
#[tauri::command]
pub fn rebind_hotkey(
    app: tauri::AppHandle,
    action: String,
    code: Option<String>,
    ctrl: bool,
    shift: bool,
    alt: bool,
    label: Option<String>,
) -> Result<HotkeyStatus, String> {
    #[cfg(desktop)]
    {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut};

        let acao = acao_estatica(&action).ok_or_else(|| "acao desconhecida".to_string())?;
        if acao == "talk" && (ctrl || shift || alt) {
            return Err("push-to-talk precisa ser uma tecla sozinha, sem Ctrl/Shift/Alt".into());
        }

        let manager = app.global_shortcut();
        let state = app.state::<HotkeyState>();
        let mut bindings = state
            .bindings
            .lock()
            .map_err(|_| "estado travado".to_string())?;
        let mut status = state
            .status
            .lock()
            .map_err(|_| "estado travado".to_string())?;

        let estava_registrada = bindings.iter().any(|b| b.action == acao);
        if let Some(pos) = bindings.iter().position(|b| b.action == acao) {
            let antiga = bindings.remove(pos);
            let _ = manager.unregister(antiga.shortcut);
        }

        let Some(code_str) = code else {
            grava_status(&mut status, acao, None);
            return Ok(status.clone());
        };

        let tecla = Code::from_str(&code_str).map_err(|_| "tecla nao reconhecida".to_string())?;
        let mut mods = Modifiers::empty();
        if ctrl {
            mods |= Modifiers::CONTROL;
        }
        if shift {
            mods |= Modifiers::SHIFT;
        }
        if alt {
            mods |= Modifiers::ALT;
        }
        let novo = Shortcut::new(if mods.is_empty() { None } else { Some(mods) }, tecla);

        // Duas acoes do proprio Voxa na mesma tecla travariam uma a outra —
        // o handler acharia so a primeira do vetor.
        if bindings.iter().any(|b| b.shortcut == novo) {
            return Err("essa combinacao ja esta em uso por outro atalho do Voxa".into());
        }

        if acao == "talk" {
            *state
                .talk_code
                .lock()
                .map_err(|_| "estado travado".to_string())? = code_str.clone();
            // So registra no sistema agora se push-to-talk ja estava ligado —
            // senao a tecla fica presa sem necessidade. `set_push_to_talk`
            // registra com a tecla nova quando o modo for ligado.
            if estava_registrada {
                manager
                    .register(novo)
                    .map_err(|_| "combinacao ja esta em uso por outro programa".to_string())?;
                bindings.push(Binding {
                    action: acao,
                    shortcut: novo,
                });
            }
        } else {
            manager
                .register(novo)
                .map_err(|_| "combinacao ja esta em uso por outro programa".to_string())?;
            bindings.push(Binding {
                action: acao,
                shortcut: novo,
            });
        }

        grava_status(&mut status, acao, label.or(Some(code_str)));
        Ok(status.clone())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, action, code, ctrl, shift, alt, label);
        Err("atalhos globais so existem no app instalado".into())
    }
}

/// Push-to-talk rouba a tecla do sistema inteiro, entao so registra sob demanda.
#[tauri::command]
pub fn set_push_to_talk(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use std::str::FromStr;
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};

        let state = app.state::<HotkeyState>();
        let manager = app.global_shortcut();
        let mut bindings = state
            .bindings
            .lock()
            .map_err(|_| "estado travado".to_string())?;
        let mut status = state
            .status
            .lock()
            .map_err(|_| "estado travado".to_string())?;

        if let Some(pos) = bindings.iter().position(|b| b.action == "talk") {
            let antigo = bindings.remove(pos);
            let _ = manager.unregister(antigo.shortcut);
        }

        if !enabled {
            return Ok(());
        }

        let code_str = state
            .talk_code
            .lock()
            .map_err(|_| "estado travado".to_string())?
            .clone();
        let code = Code::from_str(&code_str).unwrap_or(Code::F8);
        let sc = Shortcut::new(None, code);
        // Mesmo motivo do registro inicial: a tecla pode ter ficado presa.
        let _ = manager.unregister(sc);
        manager.register(sc).map_err(|e| e.to_string())?;
        bindings.push(Binding {
            action: "talk",
            shortcut: sc,
        });
        if status.talk.is_none() {
            grava_status(&mut status, "talk", Some(code_str));
        }
        Ok(())
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}
