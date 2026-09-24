use super::{
    audio, decoder::HardwareVideoDecoder, presenter::NativePresenter, renderer,
    transport::TransportHandle, Inner,
};
use std::{
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
            Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0},
            Direct3D11::{
                D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, ID3D11Multithread,
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_SDK_VERSION,
            },
        },
        System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
    },
};

pub(super) fn spawn(
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
    app: AppHandle,
    hwnd: isize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || run(transport, state, app, hwnd))
}

fn run(transport: TransportHandle, state: Arc<Mutex<Inner>>, app: AppHandle, hwnd: isize) {
    renderer::set_title(&app, "Voxa Stream — aguardando vídeo");
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        fail(&state, "com-unavailable", &error.to_string());
        renderer::set_title(&app, "Voxa Stream — falha nativa; veja o painel");
        return;
    }
    let _apartment = ComApartment;
    let audio = audio::spawn_playback(transport.clone(), state.clone());
    while !transport.stopped() {
        match run_session(&transport, &state, &app, hwnd) {
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
    let (device, context) = create_device()?;
    let mut decoder = HardwareVideoDecoder::open(
        &device,
        config.codec,
        config.width,
        config.height,
        config.fps.into(),
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
        inner.status.phase = "decoding";
        inner.status.last_error = None;
    }
    let mut duration = 10_000_000i64 / i64::from(config.fps);
    let mut first_present = true;
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
                    "[voxa] frame H.264 descartado: {}",
                    error.chars().take(120).collect::<String>()
                );
                thread::sleep(Duration::from_millis(20));
                continue;
            }
        };
        if let Some(texture) = texture {
            presenter.present(&texture.texture, texture.subresource_index)?;
            if let Ok(mut inner) = state.lock() {
                inner.status.decoded_frames += 1;
                inner.status.renderer = "d3d11-swapchain";
                inner.status.phase = "streaming";
                inner.status.last_error = None;
            }
            if first_present {
                renderer::set_title(app, "Voxa Stream");
                first_present = false;
            }
        }
    }
    Ok(())
}

fn create_device() -> Result<(ID3D11Device, ID3D11DeviceContext), String> {
    unsafe {
        let mut device = None;
        let mut context = None;
        let levels = [D3D_FEATURE_LEVEL_11_0];
        D3D11CreateDevice(
            None,
            D3D_DRIVER_TYPE_HARDWARE,
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
