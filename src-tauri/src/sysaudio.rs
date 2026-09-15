//! Captura do audio do SISTEMA (WASAPI loopback).
//!
//! Por que existe: o audio da transmissao vem do `getDisplayMedia`, e no
//! WebView2 ele entrega o audio da janela escolhida — quando entrega. Em jogo
//! em tela cheia, o mais comum e vir NADA, e quem assiste ve a imagem em
//! silencio sem entender por que.
//!
//! O loopback do WASAPI pega o que a placa de som esta tocando, direto, sem
//! depender do que o Chromium resolve expor. O truque e pegar o dispositivo de
//! RENDER (a saida) e abri-lo como Capture: a propria crate liga o
//! AUDCLNT_STREAMFLAGS_LOOPBACK nessa combinacao.
//!
//! O audio sai daqui em blocos de f32 intercalado pelo Channel do Tauri (bytes
//! crus, sem passar por JSON) e vira um MediaStreamTrack no frontend.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::ipc::{Channel, InvokeResponseBody};

/// 20 ms a 48 kHz — mesmo tamanho de quadro que o Opus usa, entao o caminho
/// inteiro trabalha na mesma cadencia.
const FRAMES_POR_BLOCO: usize = 960;
const CANAIS: usize = 2;
const TAXA: usize = 48_000;

static CAPTURA: Mutex<Option<Arc<AtomicBool>>> = Mutex::new(None);

#[derive(Clone, Copy)]
enum AudioScope {
    System,
    Application(u32),
    ExcludeSelf,
}

// A ativacao COM da biblioteca pode aguardar o driver sem prazo. No maximo
// uma ativacao por processo impede acumular threads se o driver nao responder.
#[cfg(target_os = "windows")]
static ACTIVATING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn stop_system_audio() {
    if let Some(rodando) = CAPTURA.lock().unwrap_or_else(|e| e.into_inner()).take() {
        rodando.store(false, Ordering::Relaxed);
    }
}

#[tauri::command]
pub async fn start_system_audio(
    canal: Channel<InvokeResponseBody>,
    erros: Channel<String>,
    mode: Option<String>,
    process_id: Option<u32>,
) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (canal, erros, mode, process_id);
        return Err("captura de audio do sistema so existe no Windows".into());
    }

    #[cfg(target_os = "windows")]
    {
        let scope = match mode.as_deref().unwrap_or("system") {
            "system" => AudioScope::System,
            "exclude-voxa" => AudioScope::ExcludeSelf,
            "application" => {
                let pid = process_id.ok_or("Selecione o aplicativo cujo som deseja transmitir")?;
                if !crate::capture::audio_process_exists(pid) {
                    return Err(
                        "O aplicativo selecionado fechou. Escolha a fonte de audio novamente."
                            .into(),
                    );
                }
                AudioScope::Application(pid)
            }
            _ => return Err("Modo de captura de audio invalido".into()),
        };
        let rodando = Arc::new(AtomicBool::new(true));
        {
            let mut atual = CAPTURA.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(anterior) = atual.replace(rodando.clone()) {
                anterior.store(false, Ordering::Relaxed);
            }
        }
        let controle = rodando.clone();
        let (pronto, espera) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Err(e) = capturar(canal, &rodando, &pronto, scope) {
                let mensagem = e.to_string();
                // Antes de abrir, rejeita o invoke. Depois, avisa a interface.
                let _ = pronto.send(Err(mensagem.clone()));
                let _ = erros.send(mensagem);
            }
            rodando.store(false, Ordering::Relaxed);
        });
        tauri::async_runtime::spawn_blocking(move || {
            let resultado = espera
                .recv_timeout(std::time::Duration::from_secs(5))
                .map_err(|_| "A captura de audio do Windows nao iniciou em 5s".to_string())
                .and_then(|r| r);
            if resultado.is_err() {
                controle.store(false, Ordering::Relaxed);
            }
            resultado
        })
        .await
        .map_err(|e| e.to_string())?
    }
}

#[cfg(target_os = "windows")]
fn capturar(
    canal: Channel<InvokeResponseBody>,
    rodando: &AtomicBool,
    pronto: &std::sync::mpsc::Sender<Result<(), String>>,
    scope: AudioScope,
) -> Result<(), Box<dyn std::error::Error>> {
    use std::collections::VecDeque;
    use wasapi::{
        initialize_mta, AudioClient, DeviceEnumerator, Direction, SampleType, StreamMode,
        WaveFormat,
    };

    // COM precisa ser inicializado NESTA thread — a captura roda fora da thread
    // principal de propósito, pra nao competir com a interface.
    initialize_mta().ok()?;

    let (mut client, periodo_min) = match scope {
        AudioScope::System => {
            let enumerator = DeviceEnumerator::new()?;
            let device = enumerator.get_default_device(&Direction::Render)?;
            let client = device.get_iaudioclient()?;
            let (_, period) = client.get_device_period()?;
            (client, period)
        }
        AudioScope::Application(_) | AudioScope::ExcludeSelf => {
            if ACTIVATING.swap(true, Ordering::AcqRel) {
                return Err("Uma ativacao de audio ainda aguarda o Windows. Tente novamente ou reinicie o Voxa.".into());
            }
            struct ActivationGuard;
            impl Drop for ActivationGuard {
                fn drop(&mut self) {
                    ACTIVATING.store(false, Ordering::Release);
                }
            }
            let _guard = ActivationGuard;
            let (pid, include) = match scope {
                AudioScope::Application(pid) => (pid, true),
                _ => (std::process::id(), false),
            };
            let client = AudioClient::new_application_loopback_client(pid, include)
                .map_err(|_| "Captura por aplicativo indisponivel. Requer Windows build 20348 ou posterior e driver compativel.")?;
            // GetDevicePeriod nao e suportado pelo loopback por processo.
            (client, 200_000)
        }
    };
    if !rodando.load(Ordering::Relaxed) {
        return Ok(());
    }

    let formato = WaveFormat::new(32, 32, &SampleType::Float, TAXA, CANAIS, None);
    let blockalign = formato.get_blockalign() as usize;

    client.initialize_client(
        &formato,
        &Direction::Capture,
        &StreamMode::EventsShared {
            // Deixa o Windows reamostrar se a placa estiver em 44.1 kHz: sem
            // isso, precisariamos reamostrar na mao aqui dentro.
            autoconvert: true,
            buffer_duration_hns: periodo_min,
        },
    )?;

    let evento = client.set_get_eventhandle()?;
    let capture = client.get_audiocaptureclient()?;
    let mut fila: VecDeque<u8> = VecDeque::with_capacity(blockalign * FRAMES_POR_BLOCO * 8);

    client.start_stream()?;
    let _ = pronto.send(Ok(()));

    let bytes_por_bloco = blockalign * FRAMES_POR_BLOCO;

    // A partir daqui o stream esta ABERTO: qualquer saida precisa passar por
    // stop_stream, senao o dispositivo fica preso ate o processo morrer. Por
    // isso o laco guarda o erro em vez de propagar com `?`.
    let mut falha: Option<Box<dyn std::error::Error>> = None;

    while rodando.load(Ordering::Relaxed) {
        while fila.len() >= bytes_por_bloco {
            let bloco: Vec<u8> = fila.drain(..bytes_por_bloco).collect();
            // Se o outro lado sumiu (janela fechou), nao ha por que seguir.
            if canal.send(InvokeResponseBody::Raw(bloco)).is_err() {
                rodando.store(false, Ordering::Relaxed);
                break;
            }
        }

        if let Err(e) = capture.read_from_device_to_deque(&mut fila) {
            falha = Some(Box::new(e));
            break;
        }

        // Espera o proximo periodo do dispositivo. O timeout evita a thread
        // ficar presa pra sempre se o dispositivo for removido no meio.
        match evento.wait_for_event(500) {
            // Loopback pode nao sinalizar evento enquanto o PC esta em silencio.
            // Isso nao encerra a captura: o jogo pode comecar a tocar depois.
            Ok(()) | Err(wasapi::WasapiError::EventTimeout) => {}
            Err(e) => {
                falha = Some(Box::new(e));
                break;
            }
        }
    }

    let _ = client.stop_stream();
    match falha {
        Some(e) => Err(e),
        None => Ok(()),
    }
}
