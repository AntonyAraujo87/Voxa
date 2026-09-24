use super::{
    audio, decoder::HardwareVideoDecoder, presenter::NativePresenter, renderer,
    transport::TransportHandle, Inner,
};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::AppHandle;
use windows::{
    core::Interface,
    Win32::{
        Foundation::{HMODULE, HWND},
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
            },
            Dxgi::{CreateDXGIFactory1, IDXGIAdapter, IDXGIFactory1},
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

pub fn hardware_decoder_codecs(
    selected: Option<u32>,
) -> Result<Vec<voxa_native_core::protocol::VideoCodec>, String> {
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("DXGI do espectador: {e}"))?;
        let mut adapters = Vec::new();
        for index in 0..32 {
            let Ok(adapter) = factory.EnumAdapters(index) else {
                break;
            };
            if selected.is_none() || selected == Some(index) {
                adapters.push(adapter);
            }
        }
        let mut available = Vec::new();
        for codec in voxa_native_core::protocol::VideoCodec::ALL {
            let supported = adapters.iter().any(|adapter| {
                create_device_on_adapter(adapter).is_ok_and(|(device, _)| {
                    HardwareVideoDecoder::open(&device, codec, 1280, 720, 30).is_ok()
                })
            });
            if supported {
                available.push(codec);
            }
        }
        Ok(available)
    }
}

pub(super) fn spawn(
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
    app: AppHandle,
    hwnd: isize,
    decoder_adapter_index: Option<u32>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || run(transport, state, app, hwnd, decoder_adapter_index))
}

fn run(
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
    app: AppHandle,
    hwnd: isize,
    decoder_adapter_index: Option<u32>,
) {
    renderer::set_title(&app, "Voxa Stream — aguardando vídeo");
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        fail(&state, "com-unavailable", &error.to_string());
        renderer::set_title(&app, "Voxa Stream — falha nativa; veja o painel");
        return;
    }
    let _apartment = ComApartment;
    let audio = audio::spawn_playback(transport.clone(), state.clone());
    while !transport.stopped() {
        match run_session(&transport, &state, &app, hwnd, decoder_adapter_index) {
            Ok(()) => break,
            Err(error) => {
                fail(&state, "recovering", &error);
                renderer::set_title(&app, "Voxa Stream — recuperando decoder");
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
    let _ = audio.join();
}

fn run_session(
    transport: &TransportHandle,
    state: &Arc<Mutex<Inner>>,
    app: &AppHandle,
    hwnd: isize,
    decoder_adapter_index: Option<u32>,
) -> Result<(), String> {
    let mut config_wait = std::time::Instant::now();
    let waiting_since = std::time::Instant::now();
    let mut reported_waiting = false;
    let mut config = loop {
        if transport.stopped() {
            return Ok(());
        }
        if let Some(config) = transport.current_config() {
            break config;
        }
        if config_wait.elapsed() >= Duration::from_secs(1) {
            transport.request_keyframe();
            config_wait = std::time::Instant::now();
        }
        if !reported_waiting && waiting_since.elapsed() >= Duration::from_secs(5) {
            if let Ok(mut inner) = state.lock() {
                inner.status.last_error =
                    Some("Sem configuração de vídeo do host; verificando a rota UDP".into());
            }
            renderer::set_title(app, "Voxa Stream — aguardando dados UDP");
            reported_waiting = true;
        }
        thread::sleep(Duration::from_millis(2));
    };
    renderer::set_title(app, "Voxa Stream — iniciando decoder");
    let (device, context, mut decoder, decoder_gpu) = create_device(
        config.codec,
        config.width,
        config.height,
        config.fps.into(),
        decoder_adapter_index,
    )?;
    let mut presenter = NativePresenter::new(
        &device,
        &context,
        HWND(hwnd as *mut _),
        config.width,
        config.height,
        config.fps.into(),
    )?;
    if let Ok(mut inner) = state.lock() {
        inner.status.decoder = match config.codec {
            voxa_native_core::protocol::VideoCodec::H264 => "media-foundation-h264",
            voxa_native_core::protocol::VideoCodec::H265 => "media-foundation-h265",
            voxa_native_core::protocol::VideoCodec::Av1 => "media-foundation-av1",
        };
        inner.status.decoder_gpu = Some(decoder_gpu);
        inner.status.phase = "decoding";
        inner.status.last_error = None;
    }
    let mut duration = 10_000_000i64 / i64::from(config.fps);
    let mut first_present = true;
    let mut latency_samples = VecDeque::<u32>::with_capacity(600);
    let mut frames_since_latency_update = 0u32;
    while !transport.stopped() {
        if let Some(new_config) = transport.current_config() {
            if new_config != config {
                config = new_config;
                decoder = HardwareVideoDecoder::open(
                    &device,
                    config.codec,
                    config.width,
                    config.height,
                    config.fps.into(),
                )?;
                presenter = NativePresenter::new(
                    &device,
                    &context,
                    HWND(hwnd as *mut _),
                    config.width,
                    config.height,
                    config.fps.into(),
                )?;
                duration = 10_000_000i64 / i64::from(config.fps);
            }
        }
        let Some(frame) = transport.take_video() else {
            thread::sleep(Duration::from_millis(1));
            continue;
        };
        let texture = match decoder.decode(&frame.bytes, frame.timestamp_us as i64 * 10, duration) {
            Ok(texture) => texture,
            Err(error) => {
                transport.request_keyframe();
                decoder = HardwareVideoDecoder::open(
                    &device,
                    config.codec,
                    config.width,
                    config.height,
                    config.fps.into(),
                )?;
                eprintln!(
                    "[voxa] frame {} descartado: {}",
                    config.codec.name(),
                    error.chars().take(120).collect::<String>()
                );
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        if let Some(texture) = texture {
            presenter.present(&texture.texture, texture.subresource_index)?;
            if let Some(cursor) = transport.current_cursor() {
                if cursor.timestamp_us <= frame.timestamp_us.saturating_add(100_000) {
                    presenter.present_cursor(&cursor)?;
                }
            }
            if let Some(latency) = transport.capture_to_display_ms(frame.timestamp_us) {
                if latency_samples.len() >= 600 {
                    latency_samples.pop_front();
                }
                latency_samples.push_back(latency);
                frames_since_latency_update += 1;
            }
            if let Ok(mut inner) = state.lock() {
                inner.status.decoded_frames += 1;
                inner.status.renderer = "d3d11-swapchain";
                inner.status.phase = "streaming";
                inner.status.last_error = None;
                if frames_since_latency_update >= 30 {
                    let (p50, p95, p99) = latency_percentiles(&latency_samples);
                    inner.status.latency_p50_ms = p50;
                    inner.status.latency_p95_ms = p95;
                    inner.status.latency_p99_ms = p99;
                    frames_since_latency_update = 0;
                }
            }
            if first_present {
                renderer::set_title(app, "Voxa Stream");
                first_present = false;
            }
        }
    }
    Ok(())
}

fn create_device(
    codec: voxa_native_core::protocol::VideoCodec,
    width: u32,
    height: u32,
    fps: u32,
    selected: Option<u32>,
) -> Result<
    (
        ID3D11Device,
        ID3D11DeviceContext,
        HardwareVideoDecoder,
        String,
    ),
    String,
> {
    unsafe {
        let factory: IDXGIFactory1 =
            CreateDXGIFactory1().map_err(|e| format!("DXGI do espectador: {e}"))?;
        let mut adapters = Vec::<(u32, usize)>::new();
        for index in 0..32 {
            let Ok(adapter) = factory.EnumAdapters(index) else {
                break;
            };
            let dedicated = adapter
                .GetDesc()
                .map(|desc| desc.DedicatedVideoMemory)
                .unwrap_or(0);
            adapters.push((index, dedicated));
        }
        if let Some(selected) = selected {
            adapters.retain(|(index, _)| *index == selected);
        } else {
            adapters.sort_by_key(|(_, dedicated)| std::cmp::Reverse(*dedicated));
        }
        let mut failures = Vec::new();
        for (index, _) in adapters {
            let adapter = factory
                .EnumAdapters(index)
                .map_err(|e| format!("GPU {index} do espectador: {e}"))?;
            let description = adapter
                .GetDesc()
                .map(|desc| wide_string(&desc.Description))
                .unwrap_or_else(|_| format!("GPU {index}"));
            match create_device_on_adapter(&adapter).and_then(|(device, context)| {
                HardwareVideoDecoder::open(&device, codec, width, height, fps)
                    .map(|decoder| (device, context, decoder, description.clone()))
            }) {
                Ok(stack) => return Ok(stack),
                Err(error) => failures.push(format!("{description}: {error}")),
            }
        }
        Err(format!(
            "Nenhuma GPU conseguiu decodificar {}: {}",
            codec.name(),
            failures.join(" | ")
        ))
    }
}

unsafe fn create_device_on_adapter(
    adapter: &IDXGIAdapter,
) -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    unsafe {
        let mut device = None;
        let mut context = None;
        let levels = [D3D_FEATURE_LEVEL_11_0];
        D3D11CreateDevice(
            adapter,
            D3D_DRIVER_TYPE_UNKNOWN,
            HMODULE::default(),
            D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            Some(&levels),
            D3D11_SDK_VERSION,
            Some(&mut device),
            None,
            Some(&mut context),
        )
        .map_err(|e| format!("D3D11 do espectador: {e}"))?;
        let device = device.ok_or("D3D11 não retornou dispositivo para o espectador")?;
        let context = context.ok_or("D3D11 não retornou contexto para o espectador")?;
        let multithread: ID3D11Multithread = device
            .cast()
            .map_err(|e| format!("Proteção multithread D3D11 do espectador: {e}"))?;
        let _ = multithread.SetMultithreadProtected(true);
        Ok((device, context))
    }
}

fn wide_string<const N: usize>(value: &[u16; N]) -> String {
    let length = value.iter().position(|unit| *unit == 0).unwrap_or(N);
    String::from_utf16_lossy(&value[..length])
}

fn latency_percentiles(samples: &VecDeque<u32>) -> (u32, u32, u32) {
    if samples.is_empty() {
        return (0, 0, 0);
    }
    let mut ordered = samples.iter().copied().collect::<Vec<_>>();
    ordered.sort_unstable();
    let percentile = |percent: usize| {
        let index = (ordered.len() - 1).saturating_mul(percent) / 100;
        ordered[index]
    };
    (percentile(50), percentile(95), percentile(99))
}

fn fail(state: &Arc<Mutex<Inner>>, decoder: &'static str, error: &str) {
    if let Ok(mut inner) = state.lock() {
        inner.status.phase = if decoder == "recovering" {
            "recovering"
        } else {
            "failed"
        };
        inner.status.decoder = decoder;
        inner.status.last_error = Some(error.chars().take(240).collect());
    }
    eprintln!(
        "[voxa] decoder nativo: {}",
        error.chars().take(160).collect::<String>()
    );
}

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn computes_stable_latency_percentiles() {
        let samples = (1..=100).collect::<VecDeque<_>>();
        assert_eq!(latency_percentiles(&samples), (50, 95, 99));
    }
}
