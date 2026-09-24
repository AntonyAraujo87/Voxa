use super::{
    capture::DxgiCapture,
    converter::GpuColorConverter,
    encoder::HardwareH264Encoder,
    transport::{EncodedFrame, HostTransportHandle, VideoTier},
    CaptureTargetId, Inner,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use voxa_native_core::protocol::StreamConfig;
use windows::Win32::Graphics::Direct3D11::{
    ID3D11Device, ID3D11DeviceContext, ID3D11Texture2D, D3D11_TEXTURE2D_DESC,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};

const FPS: u32 = 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct VideoProfile {
    width: u32,
    height: u32,
    fps: u32,
}

struct EncoderLane {
    profile: VideoProfile,
    bitrate: u32,
    converter: GpuColorConverter,
    encoder: HardwareH264Encoder,
    next_frame_at: Instant,
}

impl EncoderLane {
    fn open(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source_width: u32,
        source_height: u32,
        bitrate: u32,
    ) -> Result<Self, String> {
        let profile = profile_for(source_width, source_height, bitrate);
        Ok(Self {
            profile,
            bitrate,
            converter: GpuColorConverter::new(
                device,
                context,
                source_width,
                source_height,
                profile.width,
                profile.height,
                profile.fps,
            )?,
            encoder: HardwareH264Encoder::open(
                device,
                profile.width,
                profile.height,
                profile.fps,
                bitrate,
            )?,
            next_frame_at: Instant::now(),
        })
    }

    fn update(
        &mut self,
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source_width: u32,
        source_height: u32,
        bitrate: u32,
    ) -> Result<bool, String> {
        let profile = profile_for(source_width, source_height, bitrate);
        if profile != self.profile {
            *self = Self::open(device, context, source_width, source_height, bitrate)?;
            return Ok(true);
        }
        let changed = bitrate < self.bitrate.saturating_mul(4) / 5
            || bitrate > self.bitrate.saturating_mul(5) / 4;
        if changed {
            self.bitrate = bitrate;
            if self.encoder.set_bitrate(bitrate).is_err() {
                self.encoder = HardwareH264Encoder::open(
                    device,
                    profile.width,
                    profile.height,
                    profile.fps,
                    bitrate,
                )?;
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn config(&self) -> StreamConfig {
        StreamConfig {
            width: self.profile.width,
            height: self.profile.height,
            fps: self.profile.fps as u16,
        }
    }

    fn due(&mut self, now: Instant) -> bool {
        if now < self.next_frame_at {
            return false;
        }
        self.next_frame_at = now + Duration::from_nanos(1_000_000_000 / self.profile.fps as u64);
        true
    }

    fn encode(
        &self,
        texture: &ID3D11Texture2D,
        frame_id: u64,
        timestamp_100ns: i64,
    ) -> Result<Option<EncodedFrame>, String> {
        let nv12 = self.converter.convert(texture)?;
        let duration = 10_000_000i64 / self.profile.fps as i64;
        Ok(self
            .encoder
            .encode(&nv12, timestamp_100ns, duration)?
            .map(|unit| EncodedFrame {
                id: frame_id,
                timestamp_us: timestamp_100ns.max(0) as u64 / 10,
                keyframe: unit.keyframe,
                bytes: Arc::new(unit.bytes),
            }))
    }
}

pub(super) fn spawn(
    transport: HostTransportHandle,
    state: Arc<Mutex<Inner>>,
    capture_target: Option<CaptureTargetId>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || run(transport, state, capture_target))
}

fn run(
    transport: HostTransportHandle,
    state: Arc<Mutex<Inner>>,
    capture_target: Option<CaptureTargetId>,
) {
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
        match run_device_session(&transport, &state, capture_target) {
            Ok(()) => return,
            Err(error) => {
                if let Ok(mut inner) = state.lock() {
                    inner.status.phase = "failed";
                    inner.status.capture = "recovering";
                    inner.status.encoder = "recovering";
                    inner.status.last_error = Some(error.chars().take(240).collect());
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
    capture_target: Option<CaptureTargetId>,
) -> Result<(), String> {
    let capture = DxgiCapture::open(capture_target)?;
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
    let mut lanes = HashMap::<VideoTier, EncoderLane>::new();
    if let Ok(mut inner) = state.lock() {
        inner.status.capture = "dxgi-active";
        inner.status.encoder = "media-foundation-h264";
        inner.status.phase = "streaming";
        inner.status.last_error = None;
    }
    drop(first);

    let started = Instant::now();
    let mut frame_id = 1u64;
    let mut next_frame_at = Instant::now();
    while !transport.stopped() {
        let active_tiers = transport.active_tiers();
        if active_tiers.is_empty() {
            thread::sleep(Duration::from_millis(100));
            next_frame_at = Instant::now();
            continue;
        }
        let now = Instant::now();
        let frame_interval = Duration::from_nanos(1_000_000_000 / FPS as u64);
        if now < next_frame_at {
            thread::sleep(next_frame_at - now);
        }
        let Some(frame) = capture.acquire(20)? else {
            // Uma tela estatica pode nao produzir frames DXGI. Nao acumular
            // atraso para depois codificar uma rajada quando ela mudar.
            next_frame_at = Instant::now();
            continue;
        };
        let captured_at = Instant::now();
        next_frame_at += frame_interval;
        if next_frame_at <= captured_at {
            next_frame_at = captured_at + frame_interval;
        }
        let requested = active_tiers
            .iter()
            .map(|(_, bitrate)| *bitrate)
            .min()
            .unwrap_or(12_000_000);
        if let Ok(mut inner) = state.lock() {
            inner.status.bitrate_kbps = requested / 1000;
        }
        let timestamp_100ns = started.elapsed().as_nanos().saturating_div(100) as i64;
        let force_keyframe = transport.take_keyframe_request();
        lanes.retain(|tier, _| active_tiers.iter().any(|(active, _)| active == tier));
        for (tier, bitrate) in active_tiers {
            let lane = match lanes.entry(tier) {
                std::collections::hash_map::Entry::Occupied(entry) => entry.into_mut(),
                std::collections::hash_map::Entry::Vacant(entry) => {
                    let lane = EncoderLane::open(
                        &capture.device,
                        &capture.context,
                        desc.Width,
                        desc.Height,
                        bitrate,
                    )?;
                    transport.queue_config(tier, lane.config());
                    entry.insert(lane)
                }
            };
            if lane.update(
                &capture.device,
                &capture.context,
                desc.Width,
                desc.Height,
                bitrate,
            )? {
                transport.queue_config(tier, lane.config());
            }
            if force_keyframe && lane.encoder.force_keyframe().is_err() {
                *lane = EncoderLane::open(
                    &capture.device,
                    &capture.context,
                    desc.Width,
                    desc.Height,
                    bitrate,
                )?;
                transport.queue_config(tier, lane.config());
            }
            if !lane.due(captured_at) {
                continue;
            }
            if let Some(encoded) = lane.encode(&frame.texture, frame_id, timestamp_100ns)? {
                let dropped = transport.queue_video(tier, encoded);
                if let Ok(mut inner) = state.lock() {
                    inner.status.dropped_frames += u64::from(dropped);
                    inner.status.encoded_frames += 1;
                    inner.status.last_error = None;
                }
            }
        }
        frame_id = frame_id.wrapping_add(1).max(1);
    }
    Ok(())
}

fn profile_for(source_width: u32, source_height: u32, bitrate: u32) -> VideoProfile {
    let (max_width, max_height, fps) = match bitrate {
        0..=1_499_999 => (960, 540, 30),
        1_500_000..=3_999_999 => (1280, 720, 30),
        4_000_000..=7_999_999 => (1280, 720, 60),
        _ => (1920, 1080, FPS),
    };
    let scale = (max_width as f64 / source_width.max(1) as f64)
        .min(max_height as f64 / source_height.max(1) as f64)
        .min(1.0);
    let even = |value: u32| value.max(2) & !1;
    VideoProfile {
        width: even((source_width as f64 * scale).round() as u32),
        height: even((source_height as f64 * scale).round() as u32),
        fps,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn degrades_resolution_and_fps_with_bandwidth() {
        assert_eq!(
            profile_for(1920, 1080, 900_000),
            VideoProfile {
                width: 960,
                height: 540,
                fps: 30
            }
        );
        assert_eq!(
            profile_for(1920, 1080, 2_000_000),
            VideoProfile {
                width: 1280,
                height: 720,
                fps: 30
            }
        );
        assert_eq!(
            profile_for(1920, 1080, 5_000_000),
            VideoProfile {
                width: 1280,
                height: 720,
                fps: 60
            }
        );
        assert_eq!(
            profile_for(2560, 1440, 12_000_000),
            VideoProfile {
                width: 1920,
                height: 1080,
                fps: 60
            }
        );
    }
}
