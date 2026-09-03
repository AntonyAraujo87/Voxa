//! Fonte de captura de tela.
//!
//! O WebView2 nao tem o seletor de fonte do Chrome: a escolha vira um argumento
//! de linha de comando lido uma unica vez, quando o processo nasce. Por isso a
//! preferencia precisa morar em disco, fora do localStorage do WebView.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Default, Serialize, Deserialize)]
pub struct BootConfig {
    /// Trecho do titulo da fonte que o Chromium deve auto-selecionar.
    /// Vazio = detecta pelo idioma do sistema e pega o monitor.
    #[serde(default)]
    pub capture_source: String,
}

fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&base).join("com.voxa.app").join("boot.json")
}

pub fn read_config() -> BootConfig {
    std::fs::read_to_string(config_path())
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_config(cfg: &BootConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct CaptureSource {
    id: String,
    label: String,
    kind: &'static str,
}

/// Lista as fontes que o Chromium consegue auto-selecionar.
///
/// Para JANELAS o nome da fonte e exatamente o titulo da janela, entao listar
/// titulos basta. Para o MONITOR o nome e traduzido pelo proprio Chromium, e
/// por isso a primeira entrada usa o prefixo detectado pelo idioma do sistema.
#[tauri::command]
pub fn list_capture_sources() -> Vec<CaptureSource> {
    let mut out = vec![CaptureSource {
        id: String::new(),
        label: "Monitor inteiro (padrao)".into(),
        kind: "monitor",
    }];

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowTextLengthW, GetWindowTextW, IsWindowVisible,
        };

        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let list = &mut *(lparam.0 as *mut Vec<String>);
                if !IsWindowVisible(hwnd).as_bool() {
                    return TRUE;
                }
                let len = GetWindowTextLengthW(hwnd);
                if len <= 0 {
                    return TRUE;
                }
                let mut buf = vec![0u16; len as usize + 1];
                let read = GetWindowTextW(hwnd, &mut buf);
                if read > 0 {
                    let title = String::from_utf16_lossy(&buf[..read as usize]);
                    if !title.trim().is_empty() {
                        list.push(title);
                    }
                }
                TRUE
            }
        }

        let mut titles: Vec<String> = Vec::new();
        let _ = EnumWindows(Some(collect), LPARAM(&mut titles as *mut _ as isize));

        titles.sort();
        titles.dedup();
        for title in titles {
            // A propria janela do app nao serve de fonte util.
            if title == "Voxa" {
                continue;
            }
            out.push(CaptureSource {
                id: title.clone(),
                label: title,
                kind: "window",
            });
        }
    }

    out
}

/// Grava a fonte escolhida. So vale no proximo boot — ver o comentario do topo.
#[tauri::command]
pub fn set_capture_source(title: String) -> Result<(), String> {
    write_config(&BootConfig {
        capture_source: title,
    })
}

#[tauri::command]
pub fn get_capture_source() -> String {
    read_config().capture_source
}
