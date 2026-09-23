use super::{
    capture::DxgiCapture,
    converter::GpuColorConverter,
    encoder::HardwareH264Encoder,
    transport::{EncodedFrame, HostTransportHandle},
    Inner,
};
use std::{
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use voxa_native_core::protocol::StreamConfig;
use windows::Win32::Graphics::Direct3D11::D3D11_TEXTURE2D_DESC;
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const FPS: u32 = 60;

pub(super) fn spawn(
    transport: HostTransportHandle,
    state: Arc<Mutex<Inner>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || run(transport, state))
}

fn run(transport: HostTransportHandle, state: Arc<Mutex<Inner>>) {
    let apartment = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
    if let Err(error) = apartment.ok() {
        if let Ok(mut inner) = state.lock() {
            inner.status.phase = "failed";
            inner.status.encoder = "com-unavailable";
        }
        eprintln!("[voxa] inicialização COM: {error}");
        return;
    }
    let _apartment = ComApartment;
    while !transport.stopped() {
        match run_device_session(&transport, &state) {
            Ok(()) => return,
            Err(error) => {
                if let Ok(mut inner) = state.lock() {
                    inner.status.phase = "failed";
                    inner.status.capture = "recovering";
                    inner.status.encoder = "recovering";
                }
                let brief = error.chars().take(160).collect::<String>();
                eprintln!("[voxa] pipeline nativo: {brief}");
                thread::sleep(Duration::from_millis(750));
            }
        }
    }
}

struct ComApartment;
impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() }
    }
}

fn run_device_session(
    transport: &HostTransportHandle,
    state: &Arc<Mutex<Inner>>,
) -> Result<(), String> {
    let capture = DxgiCapture::primary()?;
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    let first = loop {
        if transport.stopped() {
            return Ok(());
        }
        if let Some(frame) = capture.acquire(100)? {
            break frame;
        }
    };
    unsafe { first.texture.GetDesc(&mut desc) };
    let converter = GpuColorConverter::new(
        &capture.device,
        &capture.context,
        desc.Width,
        desc.Height,
        FPS,
    )?;
    let mut bitrate = transport.target_bitrate();
    let mut encoder =
        HardwareH264Encoder::open(&capture.device, desc.Width, desc.Height, FPS, bitrate)?;
    transport.queue_config(StreamConfig {
        width: desc.Width,
        height: desc.Height,
        fps: FPS as u16,
    });
    if let Ok(mut inner) = state.lock() {
        inner.status.capture = "dxgi-active";
        inner.status.encoder = "media-foundation-h264";
        inner.status.phase = "streaming";
    }
    drop(first);

    let started = Instant::now();
    let duration_100ns = 10_000_000i64 / FPS as i64;
    let mut frame_id = 1u64;
    while !transport.stopped() {
        if transport.peer_count() == 0 {
            thread::sleep(Duration::from_millis(100));
            continue;
        }
        let Some(frame) = capture.acquire(20)? else {
            continue;
        };
        let requested = transport.target_bitrate();
        if let Ok(mut inner) = state.lock() {
            inner.status.bitrate_kbps = requested / 1000;
        }
        let bitrate_changed =
            requested < bitrate.saturating_mul(4) / 5 || requested > bitrate.saturating_mul(5) / 4;
        if transport.take_keyframe_request() && encoder.force_keyframe().is_err() {
            encoder =
                HardwareH264Encoder::open(&capture.device, desc.Width, desc.Height, FPS, bitrate)?;
            transport.queue_config(StreamConfig {
                width: desc.Width,
                height: desc.Height,
                fps: FPS as u16,
            });
        }
        if bitrate_changed {
            bitrate = requested;
            if encoder.set_bitrate(bitrate).is_err() {
                encoder = HardwareH264Encoder::open(
                    &capture.device,
                    desc.Width,
                    desc.Height,
                    FPS,
                    bitrate,
                )?;
                transport.queue_config(StreamConfig {
                    width: desc.Width,
                    height: desc.Height,
                    fps: FPS as u16,
                });
            }
        }
        let nv12 = converter.convert(&frame.texture)?;
        let timestamp_100ns = started.elapsed().as_nanos().saturating_div(100) as i64;
        if let Some(unit) = encoder.encode(&nv12, timestamp_100ns, duration_100ns)? {
            let dropped = transport.queue_video(EncodedFrame {
                id: frame_id,
                timestamp_us: timestamp_100ns.max(0) as u64 / 10,
                keyframe: unit.keyframe,
                bytes: Arc::new(unit.bytes),
            });
            if dropped {
                if let Ok(mut inner) = state.lock() {
                    inner.status.dropped_frames += 1;
                }
            }
            frame_id = frame_id.wrapping_add(1).max(1);
        }
    }
    Ok(())
}
