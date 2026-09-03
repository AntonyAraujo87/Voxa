// ---------------------------------------------------------------------------
// VOXA — backend Tauri.
// A janela e so a casca: todo o WebRTC roda no WebView2, que usa o mesmo
// pipeline do Chromium (MediaFoundation + D3D11) e portanto encoda/decoda na
// GPU. O trabalho do Rust aqui e:
//   1. ligar as flags certas ANTES do WebView subir;
//   2. liberar a permissao de microfone (o wry so trata clipboard);
//   3. escolher a fonte de captura (o WebView2 nao tem o seletor do Chrome);
//   4. atalhos globais, que funcionam com a janela em segundo plano.
// ---------------------------------------------------------------------------

use serde::{Deserialize, Serialize};
use tauri::{Emitter, Manager};

/* ===========================================================================
   Configuracao lida antes do WebView existir
   ========================================================================= */

#[derive(Default, Serialize, Deserialize)]
struct BootConfig {
    /// Trecho do titulo da fonte que o Chromium deve auto-selecionar.
    /// Vazio = detecta pelo idioma do sistema e pega o monitor.
    #[serde(default)]
    capture_source: String,
}

fn config_path() -> std::path::PathBuf {
    let base = std::env::var("APPDATA").unwrap_or_else(|_| ".".into());
    std::path::Path::new(&base).join("com.voxa.app").join("boot.json")
}

fn read_config() -> BootConfig {
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

/* ===========================================================================
   Flags do WebView2
   ========================================================================= */

/// Trecho do titulo da fonte de captura que o WebView2 deve selecionar sozinho.
///
/// O Chromium compara por SUBSTRING e com CASE SENSITIVE contra o nome da
/// fonte, que vem traduzido para o idioma do sistema:
///   pt-BR: "Tela inteira" / "Tela 1"      en: "Entire screen" / "Screen 1"
///   es:    "Pantalla completa"            de: "Gesamter Bildschirm"
/// Por isso nao da pra usar "Screen": nao bate com "Entire screen" (s minusculo)
/// e nao bate com nada em portugues — o Chromium entao cai na primeira fonte
/// disponivel, que e uma JANELA qualquer. Escolhemos o maior trecho que serve
/// tanto para o monitor unico quanto para "<nome> 1" em cada idioma.
#[cfg(target_os = "windows")]
pub fn default_screen_title() -> &'static str {
    // LANGID: os 10 bits baixos sao o idioma primario.
    let primary = unsafe { windows::Win32::Globalization::GetUserDefaultUILanguage() } & 0x3ff;
    match primary {
        0x16 => "Tela",       // portugues
        0x0a => "Pantalla",   // espanhol
        0x0c => "cran",       // frances — "Écran", sem o acento pra evitar UTF-8
        0x07 => "Bildschirm", // alemao
        0x10 => "Schermo",    // italiano
        _ => "creen",         // ingles — casa com "Entire screen" E "Screen 1"
    }
}

#[cfg(target_os = "windows")]
fn capture_source_title() -> String {
    if let Ok(custom) = std::env::var("VOXA_CAPTURE_SOURCE") {
        if !custom.is_empty() {
            return custom;
        }
    }
    let saved = read_config().capture_source;
    if !saved.is_empty() {
        return saved;
    }
    default_screen_title().to_string()
}

#[cfg(target_os = "windows")]
fn tune_webview2() {
    let source = capture_source_title();
    eprintln!("[voxa] fonte de captura automatica: \"{source}\"");

    let flags = [
        // --- captura de tela ---
        // WGC (Windows Graphics Capture) e o caminho moderno: a composicao ja
        // acontece na GPU, sem GDI BitBlt. Custa uma fracao da CPU e captura
        // janelas com aceleracao de hardware (jogos) sem tela preta.
        "--enable-features=WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer,MediaFoundationD3D11VideoCapture".to_string(),
        // O WebView2 nao tem o seletor de fonte do Chrome. Sem isso,
        // getDisplayMedia() rejeita na hora.
        format!("--auto-select-desktop-capture-source={source}"),
        // --- GPU ---
        "--ignore-gpu-blocklist".to_string(),
        "--enable-gpu-rasterization".to_string(),
        "--enable-zero-copy".to_string(),
        "--disable-frame-rate-limit".to_string(),
        // --- audio/video ---
        "--autoplay-policy=no-user-gesture-required".to_string(),
        // O "audio service" fora de processo adiciona um hop de IPC em cada
        // buffer; em processo corta latencia do microfone.
        "--disable-features=AudioServiceOutOfProcess,msWebOOUI,msPdfOOUI".to_string(),
    ]
    .join(" ");

    // Respeita override manual do usuario, se existir.
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", flags);
    }
}

#[cfg(not(target_os = "windows"))]
fn tune_webview2() {}

/* ===========================================================================
   Permissao de midia
   ========================================================================= */

/// Libera microfone e camera no WebView2.
///
/// O wry so trata a permissao de clipboard; sem este handler o
/// `getUserMedia()` fica pendurado esperando uma resposta que nunca vem e o
/// canal de voz nunca abre. Concedemos automaticamente porque quem esta
/// pedindo e a propria janela do app (origem local), acionada por um clique
/// explicito do usuario em "entrar no canal de voz".
#[cfg(target_os = "windows")]
fn grant_media_permissions(webview: &tauri::webview::PlatformWebview) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_PERMISSION_KIND, COREWEBVIEW2_PERMISSION_KIND_CAMERA,
        COREWEBVIEW2_PERMISSION_KIND_MICROPHONE, COREWEBVIEW2_PERMISSION_STATE_ALLOW,
    };
    use webview2_com::PermissionRequestedEventHandler;

    unsafe {
        let core = match webview.controller().CoreWebView2() {
            Ok(core) => core,
            Err(err) => {
                eprintln!("[voxa] CoreWebView2 indisponivel: {err}");
                return;
            }
        };

        let mut token: i64 = 0;
        let result = core.add_PermissionRequested(
            &PermissionRequestedEventHandler::create(Box::new(|_, args| {
                let Some(args) = args else { return Ok(()) };
                let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                args.PermissionKind(&mut kind)?;
                if kind == COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                    || kind == COREWEBVIEW2_PERMISSION_KIND_CAMERA
                {
                    args.SetState(COREWEBVIEW2_PERMISSION_STATE_ALLOW)?;
                }
                Ok(())
            })),
            &mut token,
        );

        if let Err(err) = result {
            eprintln!("[voxa] falha ao registrar PermissionRequested: {err}");
        }
    }
}

/* ===========================================================================
   Comandos expostos ao frontend
   ========================================================================= */

#[derive(Serialize)]
pub struct CaptureSource {
    id: String,
    label: String,
    kind: &'static str,
}

/// Lista as fontes que o Chromium consegue auto-selecionar.
///
/// Para JANELAS o nome da fonte e exatamente o titulo da janela, entao listar
/// titulos aqui basta. Para o MONITOR o nome e traduzido pelo proprio Chromium,
/// e por isso o primeiro item usa o prefixo detectado pelo idioma do sistema.
#[tauri::command]
fn list_capture_sources() -> Vec<CaptureSource> {
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

/// Grava a fonte escolhida. So vale no proximo boot: o Chromium le a flag
/// `--auto-select-desktop-capture-source` uma unica vez, ao criar o processo.
#[tauri::command]
fn set_capture_source(title: String) -> Result<(), String> {
    write_config(&BootConfig {
        capture_source: title,
    })
}

#[tauri::command]
fn get_capture_source() -> String {
    read_config().capture_source
}

/// Metadados do build, exibidos no painel de diagnostico do app.
#[tauri::command]
fn runtime_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
    })
}

/* ===========================================================================
   Atalhos globais
   ========================================================================= */

#[derive(Clone, Serialize)]
struct HotkeyEvent {
    action: &'static str,
    pressed: bool,
}

#[cfg(desktop)]
fn setup_hotkeys(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    use tauri_plugin_global_shortcut::{Code, Modifiers, Shortcut, ShortcutState};

    let mods = Modifiers::CONTROL | Modifiers::SHIFT;
    let mute = Shortcut::new(Some(mods), Code::KeyM);
    let deafen = Shortcut::new(Some(mods), Code::KeyD);
    let share = Shortcut::new(Some(mods), Code::KeyE);
    // Push-to-talk num modificador puro seria impossivel de segurar durante o
    // jogo; F8 e uma tecla que quase nenhum jogo usa.
    let talk = Shortcut::new(None, Code::F8);

    let (m, d, s, t) = (mute, deafen, share, talk);

    app.plugin(
        tauri_plugin_global_shortcut::Builder::new()
            .with_handler(move |app, shortcut, event| {
                let action = if shortcut == &m {
                    "mute"
                } else if shortcut == &d {
                    "deafen"
                } else if shortcut == &s {
                    "share"
                } else if shortcut == &t {
                    "talk"
                } else {
                    return;
                };

                let pressed = event.state() == ShortcutState::Pressed;
                // Toggles disparam so na descida; push-to-talk precisa dos dois
                // lados pra saber quando soltar.
                if action != "talk" && !pressed {
                    return;
                }
                let _ = app.emit("hotkey", HotkeyEvent { action, pressed });
            })
            .build(),
    )?;

    use tauri_plugin_global_shortcut::GlobalShortcutExt;
    let manager = app.global_shortcut();
    for sc in [mute, deafen, share] {
        if let Err(err) = manager.register(sc) {
            eprintln!("[voxa] atalho global recusado ({sc:?}): {err}");
        }
    }
    Ok(())
}

/// Push-to-talk rouba a tecla do sistema inteiro, entao so registra sob demanda.
#[tauri::command]
fn set_push_to_talk(app: tauri::AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Shortcut};
        let talk = Shortcut::new(None, Code::F8);
        let manager = app.global_shortcut();
        let result = if enabled {
            manager.register(talk)
        } else {
            manager.unregister(talk)
        };
        return result.map_err(|e| e.to_string());
    }
    #[cfg(not(desktop))]
    {
        let _ = (app, enabled);
        Ok(())
    }
}

/* ===========================================================================
   Bootstrap
   ========================================================================= */

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tune_webview2();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            runtime_info,
            list_capture_sources,
            set_capture_source,
            get_capture_source,
            set_push_to_talk
        ])
        .setup(|app| {
            #[cfg(desktop)]
            if let Err(err) = setup_hotkeys(app.handle()) {
                eprintln!("[voxa] atalhos globais indisponiveis: {err}");
            }

            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.with_webview(|webview| grant_media_permissions(&webview));
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
