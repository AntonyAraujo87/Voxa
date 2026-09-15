//! Fonte de captura de tela.
//!
//! O WebView2 nao tem o seletor de fonte do Chrome: a escolha vira um argumento
//! de linha de comando lido uma unica vez, quando o processo nasce. Por isso a
//! preferencia precisa morar em disco, fora do localStorage do WebView.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
static ACTIVE_SOURCE: std::sync::OnceLock<String> = std::sync::OnceLock::new();
pub fn remember_active_source(source: String) {
    let _ = ACTIVE_SOURCE.set(source);
}
#[tauri::command]
pub fn get_active_capture_source() -> String {
    ACTIVE_SOURCE.get().cloned().unwrap_or_default()
}

#[derive(Default, Serialize, Deserialize)]
pub struct BootConfig {
    /// Trecho do titulo da fonte que o Chromium deve auto-selecionar.
    /// Vazio = detecta pelo idioma do sistema e pega o monitor.
    #[serde(default)]
    pub capture_source: String,

    /// Desliga as flags agressivas de GPU e audio do WebView2.
    ///
    /// Existe porque as flags que deixam a captura rapida na maioria das
    /// maquinas travam a interface em algumas: `--ignore-gpu-blocklist`
    /// obriga a usar a GPU justamente onde o Chromium sabe que o driver da
    /// problema, e o servico de audio dentro do processo troca isolamento por
    /// latencia. O sintoma e a janela congelar inteira, com o processo vivo.
    ///
    /// Fica aqui, e nao no localStorage, porque precisa ser lido ANTES do
    /// WebView existir — quando o localStorage ainda nao pode ser consultado.
    #[serde(default)]
    pub modo_seguro: bool,
}

fn config_path() -> PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&base)
        .join("com.voxa.app")
        .join("boot.json")
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
    pub process_id: Option<u32>,
}

/// O jogo pode minimizar depois da selecao. Verificar o processo, nao sua
/// janela visivel, evita rejeitar uma fonte de audio ainda em execucao.
#[cfg(target_os = "windows")]
pub fn audio_process_exists(pid: u32) -> bool {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    if pid == 0 || pid == std::process::id() {
        return false;
    }
    unsafe {
        let Ok(snapshot) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return false;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut valid = Process32FirstW(snapshot, &mut entry).is_ok();
        let mut found = false;
        while valid {
            if entry.th32ProcessID == pid {
                found = true;
                break;
            }
            valid = Process32NextW(snapshot, &mut entry).is_ok();
        }
        let _ = CloseHandle(snapshot);
        found
    }
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
        process_id: None,
    }];

    #[cfg(target_os = "windows")]
    unsafe {
        use windows::core::BOOL;
        use windows::Win32::Foundation::{HWND, LPARAM, TRUE};
        use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
        use windows::Win32::System::Threading::GetCurrentProcessId;
        use windows::Win32::UI::WindowsAndMessaging::{
            EnumWindows, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
            GetWindowThreadProcessId, IsIconic, IsWindowVisible,
        };

        /// `IsWindowVisible` sozinho nao basta desde o Windows 8: apps do
        /// shell (Program Manager de tela cheia, "Windows Shell Experience
        /// Host", hosts do Cortana/busca, etc.) ficam WS_VISIBLE mas
        /// "cloaked" pelo DWM quando nao ha nada de fato na tela. Sem checar
        /// isso, a lista mostrava janelas fantasma que o usuario nunca abriu.
        unsafe fn esta_cloaked(hwnd: HWND) -> bool {
            let mut cloaked: u32 = 0;
            let ok = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut _ as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            ok.is_ok() && cloaked != 0
        }

        unsafe extern "system" fn collect(hwnd: HWND, lparam: LPARAM) -> BOOL {
            unsafe {
                let list = &mut *(lparam.0 as *mut Vec<(String, u32)>);

                if !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                    return TRUE;
                }
                if esta_cloaked(hwnd) {
                    return TRUE;
                }

                // Janela sem area (0x0, ou fora da tela) nao e uma fonte real.
                let mut rect = Default::default();
                if GetWindowRect(hwnd, &mut rect).is_ok() {
                    let vazia = rect.right <= rect.left || rect.bottom <= rect.top;
                    if vazia {
                        return TRUE;
                    }
                }

                // O proprio Voxa nunca deveria compartilhar a si mesmo. Comparar
                // pelo processo, nao pelo titulo: o titulo real da janela deste
                // app e o identificador interno do WebView2, nao "Voxa".
                let mut pid: u32 = 0;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                if pid == GetCurrentProcessId() {
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
                        list.push((title, pid));
                    }
                }
                TRUE
            }
        }

        let mut titles: Vec<(String, u32)> = Vec::new();
        let _ = EnumWindows(Some(collect), LPARAM(&mut titles as *mut _ as isize));

        titles.sort();
        titles.dedup();
        for (title, pid) in titles {
            out.push(CaptureSource {
                id: title.clone(),
                label: title,
                kind: "window",
                process_id: Some(pid),
            });
        }
    }

    out
}

/// Grava a fonte escolhida. So vale no proximo boot — ver o comentario do topo.
#[tauri::command]
pub fn set_capture_source(title: String) -> Result<(), String> {
    if title.len() > 512 || title.chars().any(|ch| ch.is_control() || ch == '"') {
        return Err("Titulo de captura invalido".into());
    }
    // Le antes de gravar: escrever a struct do zero apagaria `modo_seguro`,
    // e a pessoa que ligou o modo de compatibilidade o perderia ao trocar a
    // fonte de captura — sem nenhum aviso, e o congelamento voltaria.
    write_config(&BootConfig {
        capture_source: title,
        ..read_config()
    })
}

#[tauri::command]
pub fn get_capture_source() -> String {
    read_config().capture_source
}

/// Liga/desliga o modo de compatibilidade. So vale no proximo boot: as flags
/// sao lidas antes do WebView2 nascer e nao podem ser trocadas com ele vivo.
#[tauri::command]
pub fn set_safe_mode(on: bool) -> Result<(), String> {
    write_config(&BootConfig {
        modo_seguro: on,
        ..read_config()
    })
}

#[tauri::command]
pub fn get_safe_mode() -> bool {
    read_config().modo_seguro
}
