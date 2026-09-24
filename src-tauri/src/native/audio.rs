//! Low-latency Windows system-audio loopback and playback.

use super::{
    transport::{AudioPacket, HostTransportHandle, TransportHandle},
    Inner,
};
use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::{
    collections::VecDeque,
    ptr,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use windows::Win32::{
    Media::{
        Audio::{
            eConsole, eRender, IAudioCaptureClient, IAudioClient, IAudioRenderClient,
            IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
            AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
            AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX,
        },
        Multimedia::WAVE_FORMAT_IEEE_FLOAT,
    },
    System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED,
    },
};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const FRAME_SAMPLES: usize = 960;
const FRAME_US: u64 = 20_000;
const OPUS_BITRATE: i32 = 128_000;
const OPUS_MAX_PACKET: usize = 1_275;
const WASAPI_BUFFER_100NS: i64 = 400_000;

pub(super) fn spawn_capture(
    transport: HostTransportHandle,
    state: Arc<Mutex<Inner>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        // O relogio pertence a sessao, nao ao dispositivo WASAPI. Se o driver
        // reiniciar, voltar o timestamp a zero faria o espectador descartar
        // todos os pacotes novos como atrasados ate reconectar a sala.
        let mut timestamp_us = 0u64;
        while !transport.stopped() {
            if !transport.has_peers() {
                set_status(&state, "waiting", None);
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            if let Err(error) = capture_loop(&transport, &state, &mut timestamp_us) {
                set_status(&state, "recovering", Some(&error));
                eprintln!("[voxa] captura de áudio: {}", brief(&error));
                thread::sleep(Duration::from_millis(750));
            }
        }
    })
}

pub(super) fn spawn_playback(
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        while !transport.stopped() {
            if let Err(error) = playback_loop(&transport, &state) {
                set_status(&state, "recovering", Some(&error));
                eprintln!("[voxa] reprodução de áudio: {}", brief(&error));
                thread::sleep(Duration::from_millis(750));
            }
        }
    })
}

fn capture_loop(
    transport: &HostTransportHandle,
    state: &Arc<Mutex<Inner>>,
    timestamp_us: &mut u64,
) -> Result<(), String> {
    let _com = ComApartment::start()?;
    let (client, capture) = open_capture()?;
    let mut encoder = OpusEncoder::new(
        SAMPLE_RATE as i32,
        CHANNELS,
        Application::RestrictedLowDelay,
    )
    .map_err(str::to_owned)?;
    encoder.bitrate_bps = OPUS_BITRATE;
    encoder.complexity = 5;
    encoder.use_inband_fec = true;
    encoder.packet_loss_perc = 10;
    set_status(state, "wasapi-loopback-opus", None);
    let mut pcm = Vec::<f32>::with_capacity(FRAME_SAMPLES * CHANNELS * 2);
    let mut encoded = [0u8; OPUS_MAX_PACKET];
    unsafe { client.Start() }.map_err(|e| format!("Inicia loopback WASAPI: {e}"))?;
    while !transport.stopped() {
        if !transport.has_peers() {
            let _ = unsafe { client.Stop() };
            return Ok(());
        }
        let packet_frames = unsafe { capture.GetNextPacketSize() }
            .map_err(|e| format!("Consulta áudio do sistema: {e}"))?;
        if packet_frames == 0 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        let mut data = ptr::null_mut();
        let mut frames = 0;
        let mut flags = 0;
        unsafe { capture.GetBuffer(&mut data, &mut frames, &mut flags, None, None) }
            .map_err(|e| format!("Lê áudio do sistema: {e}"))?;
        let samples = frames as usize * CHANNELS;
        if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
            pcm.resize(pcm.len() + samples, 0.0);
        } else {
            let source = unsafe { std::slice::from_raw_parts(data.cast::<f32>(), samples) };
            pcm.extend_from_slice(source);
        }
        unsafe { capture.ReleaseBuffer(frames) }
            .map_err(|e| format!("Libera áudio do sistema: {e}"))?;

        let packet_samples = FRAME_SAMPLES * CHANNELS;
        while pcm.len() >= packet_samples {
            let length = encoder
                .encode(&pcm[..packet_samples], FRAME_SAMPLES, &mut encoded)
                .map_err(str::to_owned)?;
            let packet_timestamp = take_timestamp(timestamp_us);
            transport.queue_audio(AudioPacket {
                timestamp_us: packet_timestamp,
                bytes: Arc::new(encoded[..length].to_vec()),
            });
            pcm.drain(..packet_samples);
        }
    }
    let _ = unsafe { client.Stop() };
    Ok(())
}

fn playback_loop(transport: &TransportHandle, state: &Arc<Mutex<Inner>>) -> Result<(), String> {
    let _com = ComApartment::start()?;
    let (client, render, capacity) = open_render()?;
    let mut decoder = OpusDecoder::new(SAMPLE_RATE as i32, CHANNELS).map_err(str::to_owned)?;
    let mut decoded = vec![0.0f32; FRAME_SAMPLES * CHANNELS];
    let mut samples = VecDeque::<f32>::with_capacity(FRAME_SAMPLES * CHANNELS * 6);
    let mut last_timestamp = None::<u64>;
    let mut started = false;
    set_status(state, "wasapi-opus", None);

    unsafe { client.Start() }.map_err(|e| format!("Inicia saída WASAPI: {e}"))?;
    while !transport.stopped() {
        while let Some(packet) = transport.take_audio() {
            if let Some(previous) = last_timestamp {
                if packet.timestamp_us <= previous {
                    continue;
                }
                let missing = packet
                    .timestamp_us
                    .saturating_sub(previous)
                    .saturating_div(FRAME_US)
                    .saturating_sub(1)
                    .min(2);
                for _ in 0..missing {
                    let count = decoder
                        .decode(&[], FRAME_SAMPLES, &mut decoded)
                        .map_err(str::to_owned)?;
                    push_bounded(&mut samples, &decoded[..count * CHANNELS]);
                }
            }
            let count = decoder
                .decode(&packet.bytes, FRAME_SAMPLES, &mut decoded)
                .map_err(str::to_owned)?;
            push_bounded(&mut samples, &decoded[..count * CHANNELS]);
            last_timestamp = Some(packet.timestamp_us);
        }

        if !started && samples.len() < FRAME_SAMPLES * CHANNELS * 2 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        started = true;
        let padding = unsafe { client.GetCurrentPadding() }
            .map_err(|e| format!("Consulta buffer de áudio: {e}"))?;
        let writable = capacity.saturating_sub(padding).min(FRAME_SAMPLES as u32);
        if writable == 0 {
            thread::sleep(Duration::from_millis(2));
            continue;
        }
        let pointer = unsafe { render.GetBuffer(writable) }
            .map_err(|e| format!("Reserva buffer de áudio: {e}"))?;
        let needed = writable as usize * CHANNELS;
        if samples.len() >= needed {
            let destination =
                unsafe { std::slice::from_raw_parts_mut(pointer.cast::<f32>(), needed) };
            for sample in destination {
                *sample = samples.pop_front().unwrap_or_default();
            }
            unsafe { render.ReleaseBuffer(writable, 0) }
                .map_err(|e| format!("Envia áudio ao dispositivo: {e}"))?;
        } else {
            unsafe { render.ReleaseBuffer(writable, AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) }
                .map_err(|e| format!("Envia silêncio ao dispositivo: {e}"))?;
        }
    }
    let _ = unsafe { client.Stop() };
    Ok(())
}

fn push_bounded(queue: &mut VecDeque<f32>, input: &[f32]) {
    let limit = FRAME_SAMPLES * CHANNELS * 6;
    while queue.len() + input.len() > limit {
        for _ in 0..(FRAME_SAMPLES * CHANNELS).min(queue.len()) {
            queue.pop_front();
        }
    }
    queue.extend(input.iter().copied());
}

fn format() -> WAVEFORMATEX {
    WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_IEEE_FLOAT as u16,
        nChannels: CHANNELS as u16,
        nSamplesPerSec: SAMPLE_RATE as u32,
        nAvgBytesPerSec: (SAMPLE_RATE * CHANNELS * size_of::<f32>()) as u32,
        nBlockAlign: (CHANNELS * size_of::<f32>()) as u16,
        wBitsPerSample: 32,
        cbSize: 0,
    }
}

fn default_render_client() -> Result<IAudioClient, String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("Abre dispositivos de áudio: {e}"))?
    };
    let device = unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|e| format!("Saída de áudio padrão indisponível: {e}"))?;
    unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|e| format!("Ativa dispositivo de áudio: {e}"))
}

fn open_capture() -> Result<(IAudioClient, IAudioCaptureClient), String> {
    let client = default_render_client()?;
    let format = format();
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_LOOPBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            WASAPI_BUFFER_100NS,
            0,
            &format,
            None,
        )
    }
    .map_err(|e| format!("Configura captura do som do sistema: {e}"))?;
    let capture = unsafe { client.GetService::<IAudioCaptureClient>() }
        .map_err(|e| format!("Abre captura do som do sistema: {e}"))?;
    Ok((client, capture))
}

fn open_render() -> Result<(IAudioClient, IAudioRenderClient, u32), String> {
    let client = default_render_client()?;
    let format = format();
    unsafe {
        client.Initialize(
            AUDCLNT_SHAREMODE_SHARED,
            AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
            WASAPI_BUFFER_100NS,
            0,
            &format,
            None,
        )
    }
    .map_err(|e| format!("Configura reprodução do stream: {e}"))?;
    let capacity = unsafe { client.GetBufferSize() }
        .map_err(|e| format!("Consulta capacidade de áudio: {e}"))?;
    let render = unsafe { client.GetService::<IAudioRenderClient>() }
        .map_err(|e| format!("Abre reprodução do stream: {e}"))?;
    Ok((client, render, capacity))
}

struct ComApartment;
impl ComApartment {
    fn start() -> Result<Self, String> {
        unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }
            .ok()
            .map_err(|e| format!("Inicializa COM para áudio: {e}"))?;
        Ok(Self)
    }
}
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

fn brief(message: &str) -> String {
    message.chars().take(160).collect()
}

fn take_timestamp(next: &mut u64) -> u64 {
    let current = *next;
    *next = (*next).saturating_add(FRAME_US);
    current
}

fn set_status(state: &Arc<Mutex<Inner>>, audio: &'static str, error: Option<&str>) {
    if let Ok(mut inner) = state.lock() {
        inner.status.audio = audio;
        inner.status.audio_error = error.map(brief);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_clock_survives_device_session_restart() {
        let mut next = 0;
        assert_eq!(take_timestamp(&mut next), 0);
        assert_eq!(take_timestamp(&mut next), FRAME_US);
        // A mesma variavel e reutilizada quando o WASAPI e reaberto.
        assert_eq!(take_timestamp(&mut next), FRAME_US * 2);
    }
}
