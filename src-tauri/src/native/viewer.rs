use super::{
    decoder::HardwareH264Decoder, presenter::NativePresenter, transport::TransportHandle, Inner,
};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use windows::Win32::{
    Foundation::{HMODULE, HWND},
    Graphics::{
        Direct3D::{D3D_DRIVER_TYPE_HARDWARE, D3D_FEATURE_LEVEL_11_0},
        Direct3D11::{
            D3D11CreateDevice, ID3D11Device, ID3D11DeviceContext, D3D11_CREATE_DEVICE_BGRA_SUPPORT,
            D3D11_SDK_VERSION,
        },
    },
    System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED},
};

pub(super) fn spawn(
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
    hwnd: isize,
) -> thread::JoinHandle<()> {
    thread::spawn(move || run(transport, state, hwnd))
}

fn run(transport: TransportHandle, state: Arc<Mutex<Inner>>, hwnd: isize) {
    if let Err(error) = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) }.ok() {
        fail(&state, "com-unavailable", &error.to_string());
        return;
    }
    let _apartment = ComApartment;
    while !transport.stopped() {
        match run_session(&transport, &state, hwnd) {
            Ok(()) => return,
            Err(error) => {
                fail(&state, "recovering", &error);
                thread::sleep(Duration::from_millis(500));
            }
        }
    }
}

fn run_session(
    transport: &TransportHandle,
    state: &Arc<Mutex<Inner>>,
    hwnd: isize,
) -> Result<(), String> {
    let mut config_wait = std::time::Instant::now();
    let mut config = loop {
        if transport.stopped() {
            return Ok(());
        }
        if let Some(config) = transport.take_config() {
            break config;
        }
        if config_wait.elapsed() >= Duration::from_secs(1) {
            transport.request_keyframe();
            config_wait = std::time::Instant::now();
        }
        thread::sleep(Duration::from_millis(2));
    };
    let (device, context) = create_device()?;
    let mut decoder =
        HardwareH264Decoder::open(&device, config.width, config.height, config.fps.into())?;
    let mut presenter = NativePresenter::new(
        &device,
        &context,
        HWND(hwnd as *mut _),
        config.width,
        config.height,
        config.fps.into(),
    )?;
    if let Ok(mut inner) = state.lock() {
        inner.status.decoder = "media-foundation-h264";
        inner.status.phase = "decoding";
    }
    let mut duration = 10_000_000i64 / i64::from(config.fps);
    while !transport.stopped() {
        if let Some(new_config) = transport.take_config() {
            if new_config != config {
                config = new_config;
                decoder = HardwareH264Decoder::open(
                    &device,
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
                decoder = HardwareH264Decoder::open(
                    &device,
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
            presenter.present(&texture)?;
            if let Ok(mut inner) = state.lock() {
                inner.status.decoded_frames += 1;
                inner.status.renderer = "d3d11-swapchain";
                inner.status.phase = "streaming";
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
        Ok((
            device.ok_or("D3D11 não retornou dispositivo para o espectador")?,
            context.ok_or("D3D11 não retornou contexto para o espectador")?,
        ))
    }
}

fn fail(state: &Arc<Mutex<Inner>>, decoder: &'static str, error: &str) {
    if let Ok(mut inner) = state.lock() {
        inner.status.phase = "failed";
        inner.status.decoder = decoder;
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
