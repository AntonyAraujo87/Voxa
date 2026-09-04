//! Ajuste do WebView2 antes da janela existir.
//!
//! Todo o WebRTC roda dentro do WebView2, que e o mesmo pipeline do Chromium
//! (MediaFoundation + D3D11). O trabalho aqui e ligar as flags certas antes do
//! processo nascer e conceder a permissao de microfone, que o wry nao trata.

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
    let saved = crate::capture::read_config().capture_source;
    if !saved.is_empty() {
        return saved;
    }
    default_screen_title().to_string()
}

#[cfg(target_os = "windows")]
pub fn tune() {
    let source = capture_source_title();
    eprintln!("[voxa] fonte de captura automatica: \"{source}\"");

    let seguro = crate::capture::read_config().modo_seguro;
    if seguro {
        eprintln!("[voxa] modo de compatibilidade: flags de GPU e audio desligadas");
    }

    // Sempre ligadas: nao mexem em GPU nem em isolamento de processo.
    let mut flags = vec![
        // WGC (Windows Graphics Capture) e o caminho moderno: a composicao ja
        // acontece na GPU, sem GDI BitBlt. Custa uma fracao da CPU e captura
        // janelas aceleradas por hardware (jogos) sem tela preta.
        "--enable-features=WebRtcAllowWgcDesktopCapturer,WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer,MediaFoundationD3D11VideoCapture".to_string(),
        format!("--auto-select-desktop-capture-source={source}"),
        "--autoplay-policy=no-user-gesture-required".to_string(),
    ];

    // As de baixo sao ganho de performance na maioria das maquinas e risco de
    // travar a interface em algumas — por isso saem no modo de compatibilidade.
    //
    // `--ignore-gpu-blocklist` e a mais delicada: aquela lista existe porque o
    // Chromium ja sabe quais combinacoes de placa e driver travam. Ignora-la
    // ganha desempenho onde da certo e congela a janela onde nao da — com o
    // processo vivo, sem erro nenhum, so a tela parada.
    //
    // O servico de audio dentro do processo corta um hop de IPC por buffer
    // (menos latencia no microfone), mas troca isolamento por velocidade: um
    // driver de audio problematico leva a interface junto.
    if !seguro {
        flags.push("--ignore-gpu-blocklist".to_string());
        flags.push("--enable-gpu-rasterization".to_string());
        flags.push("--enable-zero-copy".to_string());
        flags.push("--disable-frame-rate-limit".to_string());
        flags.push("--disable-features=AudioServiceOutOfProcess,msWebOOUI,msPdfOOUI".to_string());
    } else {
        // Mantem so o que nao envolve GPU nem audio em processo.
        flags.push("--disable-features=msWebOOUI,msPdfOOUI".to_string());
    }

    let flags = flags.join(" ");

    // Respeita override manual do usuario, se existir.
    if std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_err() {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", flags);
    }
}

#[cfg(not(target_os = "windows"))]
pub fn tune() {}

/// Libera microfone e camera no WebView2.
///
/// O wry so trata a permissao de clipboard; sem este handler o `getUserMedia()`
/// fica pendurado esperando uma resposta que nunca vem e o canal de voz nunca
/// abre. Concedemos automaticamente porque quem pede e a propria janela do app
/// (origem local), acionada por um clique explicito do usuario.
#[cfg(target_os = "windows")]
pub fn grant_media_permissions(webview: &tauri::webview::PlatformWebview) {
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

        suppress_screen_capture_bar(&core);
    }
}

/// Remove a faixa "tauri.localhost esta compartilhando sua tela".
///
/// Essa barra e a interface padrao do WebView2 para captura de tela. Num
/// navegador ela faz todo sentido: avisa que um site qualquer esta te
/// gravando. Aqui ela e ruido — quem iniciou a captura foi o proprio usuario,
/// clicando num botao deste app, e o app ja mostra o estado de transmissao em
/// tres lugares (barra do canal, tile e lista de membros). Pior: ela cobre o
/// campo de mensagem e exibe uma URL interna que nao significa nada para quem
/// usa.
///
/// `SetHandled(TRUE)` diz ao WebView2 que a interface e responsabilidade
/// nossa; a captura em si continua (`SetCancel(FALSE)`).
///
/// Requer WebView2 Runtime recente (interface ICoreWebView2_27). Em runtime
/// antigo o cast falha, registramos e seguimos — a barra volta a aparecer,
/// mas nada quebra.
#[cfg(target_os = "windows")]
unsafe fn suppress_screen_capture_bar(
    core: &webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2,
) {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2_27;
    use webview2_com::ScreenCaptureStartingEventHandler;
    use windows::core::Interface;

    let core27: ICoreWebView2_27 = match core.cast() {
        Ok(c) => c,
        Err(_) => {
            eprintln!("[voxa] WebView2 antigo: a barra de compartilhamento nao pode ser removida");
            return;
        }
    };

    let mut token: i64 = 0;
    let result = core27.add_ScreenCaptureStarting(
        &ScreenCaptureStartingEventHandler::create(Box::new(|_, args| {
            let Some(args) = args else { return Ok(()) };
            args.SetCancel(false)?;
            args.SetHandled(true)?;
            Ok(())
        })),
        &mut token,
    );

    if let Err(err) = result {
        eprintln!("[voxa] falha ao registrar ScreenCaptureStarting: {err}");
    }
}
