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
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};

/// 20 ms a 48 kHz — mesmo tamanho de quadro que o Opus usa, entao o caminho
/// inteiro trabalha na mesma cadencia.
const FRAMES_POR_BLOCO: usize = 960;
const CANAIS: usize = 2;
const TAXA: usize = 48_000;

static RODANDO: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn stop_system_audio() {
    RODANDO.store(false, Ordering::Relaxed);
}

#[tauri::command]
pub fn start_system_audio(canal: Channel<InvokeResponseBody>) -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = canal;
        return Err("captura de audio do sistema so existe no Windows".into());
    }

    #[cfg(target_os = "windows")]
    {
        if RODANDO.swap(true, Ordering::Relaxed) {
            return Ok(()); // ja esta capturando
        }

        let ativo = Arc::new(());
        std::thread::spawn(move || {
            let _guarda = ativo;
            if let Err(e) = capturar(canal) {
                eprintln!("[voxa] audio do sistema parou: {e}");
            }
            RODANDO.store(false, Ordering::Relaxed);
        });

        Ok(())
    }
}

#[cfg(target_os = "windows")]
fn capturar(canal: Channel<InvokeResponseBody>) -> Result<(), Box<dyn std::error::Error>> {
    use std::collections::VecDeque;
    use wasapi::{
        initialize_mta, Direction, DeviceEnumerator, SampleType, StreamMode, WaveFormat,
    };

    // COM precisa ser inicializado NESTA thread — a captura roda fora da thread
    // principal de propósito, pra nao competir com a interface.
    initialize_mta().ok()?;

    let enumerator = DeviceEnumerator::new()?;
    // Dispositivo de SAIDA, aberto como captura: e isso que liga o loopback.
    let device = enumerator.get_default_device(&Direction::Render)?;
    let mut client = device.get_iaudioclient()?;

    let formato = WaveFormat::new(32, 32, &SampleType::Float, TAXA, CANAIS, None);
    let blockalign = formato.get_blockalign() as usize;
    let (_, periodo_min) = client.get_device_period()?;

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

    let bytes_por_bloco = blockalign * FRAMES_POR_BLOCO;

    while RODANDO.load(Ordering::Relaxed) {
        while fila.len() >= bytes_por_bloco {
            let bloco: Vec<u8> = fila.drain(..bytes_por_bloco).collect();
            // Se o outro lado sumiu (janela fechou), nao ha por que seguir.
            if canal.send(InvokeResponseBody::Raw(bloco)).is_err() {
                RODANDO.store(false, Ordering::Relaxed);
                break;
            }
        }

        capture.read_from_device_to_deque(&mut fila)?;

        // Espera o proximo periodo do dispositivo. O timeout evita a thread
        // ficar presa pra sempre se o dispositivo for removido no meio.
        if evento.wait_for_event(500).is_err() {
            break;
        }
    }

    client.stop_stream()?;
    Ok(())
}
