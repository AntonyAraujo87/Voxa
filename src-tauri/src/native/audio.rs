//! Low-latency Windows system-audio loopback and playback.

use super::{
    transport::{AudioPacket, HostTransportHandle, TransportHandle},
    AudioProcessInfo, Inner,
};
use rusty_opus::{Application, OpusDecoder, OpusEncoder};
use std::{
    collections::VecDeque,
    mem::{size_of, ManuallyDrop},
    ops::Deref,
    pin::Pin,
    ptr,
    sync::{Arc, Condvar, Mutex},
    thread,
    time::Duration,
};
use windows::{
    core::{implement, IUnknown, Interface, Ref, HRESULT},
    Win32::{
        Foundation::CloseHandle,
        Media::{
            Audio::{
                eConsole, eRender, ActivateAudioInterfaceAsync, AudioSessionStateActive,
                IActivateAudioInterfaceAsyncOperation, IActivateAudioInterfaceCompletionHandler,
                IActivateAudioInterfaceCompletionHandler_Impl, IAudioCaptureClient, IAudioClient,
                IAudioRenderClient, IAudioSessionControl2, IAudioSessionManager2,
                IMMDeviceEnumerator, MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT,
                AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
                AUDCLNT_STREAMFLAGS_LOOPBACK, AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
                AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
                PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
            },
            Multimedia::WAVE_FORMAT_IEEE_FLOAT,
        },
        System::Com::{
            CoCreateInstance, CoInitializeEx, CoUninitialize,
            StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0},
            BLOB, CLSCTX_ALL, COINIT_MULTITHREADED,
        },
        System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
            TH32CS_SNAPPROCESS,
        },
        System::Variant::VT_BLOB,
    },
};

const SAMPLE_RATE: usize = 48_000;
const CHANNELS: usize = 2;
const FRAME_SAMPLES: usize = 960;
const FRAME_US: u64 = 20_000;
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
        let mut timestamp_us = unix_now_us();
        while !transport.stopped() {
            if !transport.has_peers() {
                set_status(&state, "waiting", None);
                thread::sleep(Duration::from_millis(50));
                continue;
            }
            let process_id = state.lock().ok().and_then(|inner| inner.audio_process_id);
            if let Err(error) = capture_loop(&transport, &state, &mut timestamp_us, process_id) {
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
    process_id: Option<u32>,
) -> Result<(), String> {
    let _com = ComApartment::start()?;
    let (client, capture) = open_capture(process_id)?;
    // A device can disappear for seconds during sleep, hot-plug or an output
    // switch. Resume on the shared wall clock instead of emitting stale audio.
    *timestamp_us = (*timestamp_us).max(unix_now_us());
    let mut encoder = OpusEncoder::new(
        SAMPLE_RATE as i32,
        CHANNELS,
        Application::RestrictedLowDelay,
    )
    .map_err(str::to_owned)?;
    let mut audio_bitrate = transport.audio_bitrate_bps();
    encoder.bitrate_bps = audio_bitrate;
    encoder.complexity = 5;
    encoder.use_inband_fec = true;
    encoder.packet_loss_perc = 10;
    set_status(
        state,
        if process_id.is_some() {
            "wasapi-game-only-opus"
        } else {
            "wasapi-system-opus"
        },
        None,
    );
    let mut pcm = Vec::<f32>::with_capacity(FRAME_SAMPLES * CHANNELS * 2);
    let mut encoded = [0u8; OPUS_MAX_PACKET];
    unsafe { client.Start() }.map_err(|e| format!("Inicia loopback WASAPI: {e}"))?;
    while !transport.stopped() {
        if state
            .lock()
            .map(|inner| inner.audio_process_id != process_id)
            .unwrap_or(false)
        {
            let _ = unsafe { client.Stop() };
            return Ok(());
        }
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
            let requested_bitrate = transport.audio_bitrate_bps();
            if requested_bitrate != audio_bitrate {
                audio_bitrate = requested_bitrate;
                encoder.bitrate_bps = audio_bitrate;
                if let Ok(mut inner) = state.lock() {
                    inner.status.audio_bitrate_kbps = audio_bitrate as u32 / 1000;
                }
            }
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
            let video_latency = state
                .lock()
                .map(|inner| inner.status.latency_p50_ms)
                .unwrap_or_default();
            let target_age = video_latency.clamp(40, 250).saturating_sub(25);
            if let Some(age) = transport.capture_to_display_ms(packet.timestamp_us) {
                let wait_ms = sync_wait_ms(age, target_age);
                if wait_ms > 0 {
                    thread::sleep(Duration::from_millis(u64::from(wait_ms)));
                }
                if let Ok(mut inner) = state.lock() {
                    inner.status.av_sync_ms = (age as i64 + 25 - i64::from(video_latency))
                        .clamp(i64::from(i32::MIN), i64::from(i32::MAX))
                        as i32;
                }
            }
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

pub(super) fn enumerate_processes() -> Result<Vec<AudioProcessInfo>, String> {
    unsafe {
        let _com = ComApartment::start()?;
        let audio_client = default_render_device()?;
        let manager: IAudioSessionManager2 = audio_client
            .Activate(CLSCTX_ALL, None)
            .map_err(|e| format!("Sessões de áudio do Windows: {e}"))?;
        let sessions = manager
            .GetSessionEnumerator()
            .map_err(|e| format!("Enumera sessões de áudio: {e}"))?;
        let mut active = std::collections::HashSet::new();
        for index in 0..sessions.GetCount().unwrap_or_default() {
            let Ok(control) = sessions.GetSession(index) else {
                continue;
            };
            if control.GetState().ok() != Some(AudioSessionStateActive) {
                continue;
            }
            if let Ok(control) = control.cast::<IAudioSessionControl2>() {
                if let Ok(process_id) = control.GetProcessId() {
                    active.insert(process_id);
                }
            }
        }
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
            .map_err(|e| format!("Lista processos de áudio: {e}"))?;
        let mut entry = PROCESSENTRY32W {
            dwSize: size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut processes = Vec::new();
        if Process32FirstW(snapshot, &mut entry).is_ok() {
            loop {
                if active.contains(&entry.th32ProcessID)
                    && entry.th32ProcessID != std::process::id()
                {
                    let end = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..end]);
                    if !name.is_empty() {
                        processes.push(AudioProcessInfo {
                            process_id: entry.th32ProcessID,
                            name,
                        });
                    }
                }
                if Process32NextW(snapshot, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snapshot);
        processes.sort_by(|left, right| {
            left.name
                .to_lowercase()
                .cmp(&right.name.to_lowercase())
                .then(left.process_id.cmp(&right.process_id))
        });
        Ok(processes)
    }
}

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler(Arc<(Mutex<bool>, Condvar)>);

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> windows::core::Result<()> {
        let (lock, condition) = &*self.0;
        let mut completed = lock
            .lock()
            .map_err(|_| windows::core::Error::from_hresult(HRESULT(0x80004005u32 as i32)))?;
        *completed = true;
        condition.notify_one();
        Ok(())
    }
}

fn process_loopback_client(process_id: u32) -> Result<IAudioClient, String> {
    unsafe {
        let mut parameters = AUDIOCLIENT_ACTIVATION_PARAMS {
            ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
            Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
                ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                    TargetProcessId: process_id,
                    ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
                },
            },
        };
        let pinned = Pin::new(&mut parameters);
        let property = ManuallyDrop::new(PROPVARIANT {
            Anonymous: PROPVARIANT_0 {
                Anonymous: ManuallyDrop::new(PROPVARIANT_0_0 {
                    vt: VT_BLOB,
                    wReserved1: 0,
                    wReserved2: 0,
                    wReserved3: 0,
                    Anonymous: PROPVARIANT_0_0_0 {
                        blob: BLOB {
                            cbSize: size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
                            pBlobData: std::ptr::from_mut(pinned.get_mut()).cast(),
                        },
                    },
                }),
            },
        });
        let pinned_property = Pin::new(property.deref());
        let completed = Arc::new((Mutex::new(false), Condvar::new()));
        let callback: IActivateAudioInterfaceCompletionHandler =
            ActivationHandler(completed.clone()).into();
        let operation = ActivateAudioInterfaceAsync(
            VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
            &IAudioClient::IID,
            Some(std::ptr::from_ref(pinned_property.get_ref())),
            &callback,
        )
        .map_err(|e| format!("Ativa captura somente do jogo: {e}"))?;
        let (lock, condition) = &*completed;
        let ready = lock.lock().map_err(|_| "Captura de áudio indisponível")?;
        let (ready, timeout) = condition
            .wait_timeout_while(ready, Duration::from_secs(5), |value| !*value)
            .map_err(|_| "Captura de áudio indisponível")?;
        if timeout.timed_out() && !*ready {
            return Err("Windows demorou para ativar o áudio do jogo".into());
        }
        let mut result = HRESULT::default();
        let mut interface: Option<IUnknown> = None;
        operation
            .GetActivateResult(&mut result, &mut interface)
            .map_err(|e| format!("Resultado da captura do jogo: {e}"))?;
        result
            .ok()
            .map_err(|e| format!("O Windows recusou a captura do jogo: {e}"))?;
        interface
            .ok_or("Windows não retornou o cliente de áudio do jogo")?
            .cast()
            .map_err(|e| format!("Interface de áudio do jogo: {e}"))
    }
}

fn default_render_client() -> Result<IAudioClient, String> {
    let device = default_render_device()?;
    unsafe { device.Activate(CLSCTX_ALL, None) }
        .map_err(|e| format!("Ativa dispositivo de áudio: {e}"))
}

fn default_render_device() -> Result<windows::Win32::Media::Audio::IMMDevice, String> {
    let enumerator: IMMDeviceEnumerator = unsafe {
        CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)
            .map_err(|e| format!("Abre dispositivos de áudio: {e}"))?
    };
    unsafe { enumerator.GetDefaultAudioEndpoint(eRender, eConsole) }
        .map_err(|e| format!("Saída de áudio padrão indisponível: {e}"))
}

fn open_capture(process_id: Option<u32>) -> Result<(IAudioClient, IAudioCaptureClient), String> {
    let client = match process_id {
        Some(process_id) => process_loopback_client(process_id)?,
        None => default_render_client()?,
    };
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

fn sync_wait_ms(audio_age_ms: u32, target_age_ms: u32) -> u32 {
    target_age_ms.saturating_sub(audio_age_ms).min(100)
}

fn unix_now_us() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_micros()
        .min(u128::from(u64::MAX)) as u64
}

fn set_status(state: &Arc<Mutex<Inner>>, audio: &'static str, error: Option<&str>) {
    if let Ok(mut inner) = state.lock() {
        inner.status.audio = audio;
        inner.status.audio_error = error.map(brief);
        if error.is_none() && audio != "waiting" {
            inner.status.audio_bitrate_kbps = inner.host_fanout.audio_bitrate_bps() as u32 / 1000;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audio_clock_survives_device_session_restart() {
        let mut next = 1_000_000;
        assert_eq!(take_timestamp(&mut next), 1_000_000);
        assert_eq!(take_timestamp(&mut next), 1_000_000 + FRAME_US);
        // A mesma variavel e reutilizada quando o WASAPI e reaberto.
        assert_eq!(take_timestamp(&mut next), 1_000_000 + FRAME_US * 2);
    }

    #[test]
    fn av_sync_only_delays_early_audio_and_is_bounded() {
        assert_eq!(sync_wait_ms(20, 70), 50);
        assert_eq!(sync_wait_ms(80, 70), 0);
        assert_eq!(sync_wait_ms(0, 500), 100);
    }
}
