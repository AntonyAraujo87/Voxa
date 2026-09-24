use super::{
    capture::DxgiCapture,
    converter::GpuColorConverter,
    encoder::HardwareVideoEncoder,
    transport::{EncodedFrame, HostTransportHandle},
    CaptureTargetId, Inner,
};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use voxa_native_core::protocol::{StreamConfig, VideoCodec};
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
    codec: VideoCodec,
    profile: VideoProfile,
    bitrate: u32,
    converter: GpuColorConverter,
    encoder: HardwareVideoEncoder,
    next_frame_at: Instant,
}

impl EncoderLane {
    fn open(
        device: &ID3D11Device,
        context: &ID3D11DeviceContext,
        source_width: u32,
        source_height: u32,
        codec: VideoCodec,
        bitrate: u32,
    ) -> Result<Self, String> {
        let profile = profile_for(source_width, source_height, bitrate);
        Ok(Self {
            codec,
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
            encoder: HardwareVideoEncoder::open(
                device,
                codec,
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
            *self = Self::open(
                device,
                context,
                source_width,
                source_height,
                self.codec,
                bitrate,
            )?;
            return Ok(true);
        }
        let changed = bitrate < self.bitrate.saturating_mul(4) / 5
            || bitrate > self.bitrate.saturating_mul(5) / 4;
        if changed {
            self.bitrate = bitrate;
            if self.encoder.set_bitrate(bitrate).is_err() {
                self.encoder = HardwareVideoEncoder::open(
                    device,
                    self.codec,
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
            codec: self.codec,
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
        let capture_target = state.lock().ok().and_then(|inner| inner.capture_target);
        match run_device_session(&transport, &state, capture_target) {
            Ok(()) if transport.stopped() => return,
            Ok(()) => continue,
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
        if state
            .lock()
            .map(|inner| inner.capture_target != capture_target)
            .unwrap_or(false)
        {
            return Ok(());
        }
        if let Some(frame) = capture.acquire(100)? {
            break frame;
        }
    };
    unsafe { first.texture.GetDesc(&mut desc) };
    let mut lanes = HashMap::<(String, VideoCodec), EncoderLane>::new();
    let mut lane_retries = HashMap::<(String, VideoCodec), Instant>::new();
    if let Ok(mut inner) = state.lock() {
        inner.status.capture = "dxgi-active";
        inner.status.encoder = "media-foundation-hardware";
        inner.status.phase = "streaming";
        inner.status.last_error = None;
    }
    drop(first);

    let mut frame_id = 1u64;
    let mut next_frame_at = Instant::now();
    while !transport.stopped() {
        if state
            .lock()
            .map(|inner| inner.capture_target != capture_target)
            .unwrap_or(false)
        {
            return Ok(());
        }
        let active_lanes = transport.active_lanes();
        if active_lanes.is_empty() {
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
        let requested = active_lanes
            .iter()
            .map(|(_, _, bitrate)| *bitrate)
            .min()
            .unwrap_or(12_000_000);
        if let Ok(mut inner) = state.lock() {
            inner.status.bitrate_kbps = requested / 1000;
        }
        let timestamp_100ns = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .saturating_div(100)
            .min(i64::MAX as u128) as i64;
        let force_keyframe = transport.take_keyframe_request();
        lanes.retain(|key, _| {
            active_lanes
                .iter()
                .any(|(peer_id, codec, _)| key == &(peer_id.clone(), *codec))
        });
        for (peer_id, codec, bitrate) in active_lanes {
            let key = (peer_id.clone(), codec);
            if lane_retries
                .get(&key)
                .is_some_and(|retry_at| *retry_at > captured_at)
            {
                continue;
            }
            lane_retries.remove(&key);
            if !lanes.contains_key(&key) {
                match EncoderLane::open(
                    &capture.device,
                    &capture.context,
                    desc.Width,
                    desc.Height,
                    codec,
                    bitrate,
                ) {
                    Ok(lane) => {
                        transport.queue_config(&peer_id, lane.config());
                        lanes.insert(key.clone(), lane);
                    }
                    Err(error) => {
                        mark_lane_error(state, &peer_id, &error);
                        lane_retries.insert(key, captured_at + Duration::from_secs(2));
                        continue;
                    }
                }
            }
            let Some(lane) = lanes.get_mut(&key) else {
                continue;
            };
            let update = lane.update(
                &capture.device,
                &capture.context,
                desc.Width,
                desc.Height,
                bitrate,
            );
            match update {
                Ok(true) => {
                    if let Some(lane) = lanes.get(&key) {
                        transport.queue_config(&peer_id, lane.config());
                    }
                }
                Ok(false) => {}
                Err(error) => {
                    lanes.remove(&key);
                    lane_retries.insert(key, captured_at + Duration::from_secs(2));
                    mark_lane_error(state, &peer_id, &error);
                    continue;
                }
            }
            let Some(lane) = lanes.get_mut(&key) else {
                continue;
            };
            if force_keyframe && lane.encoder.force_keyframe().is_err() {
                match EncoderLane::open(
                    &capture.device,
                    &capture.context,
                    desc.Width,
                    desc.Height,
                    codec,
                    bitrate,
                ) {
                    Ok(replacement) => {
                        *lane = replacement;
                        transport.queue_config(&peer_id, lane.config());
                    }
                    Err(error) => {
                        lanes.remove(&key);
                        lane_retries.insert(key, captured_at + Duration::from_secs(2));
                        mark_lane_error(state, &peer_id, &error);
                        continue;
                    }
                }
            }
            if !lane.due(captured_at) {
                continue;
            }
            let encoded = match lane.encode(&frame.texture, frame_id, timestamp_100ns) {
                Ok(encoded) => encoded,
                Err(error) => {
                    lanes.remove(&key);
                    lane_retries.insert(key, captured_at + Duration::from_secs(2));
                    mark_lane_error(state, &peer_id, &error);
                    continue;
                }
            };
            if let Some(encoded) = encoded {
                let dropped = transport.queue_video(&peer_id, codec, encoded);
                if let Ok(mut inner) = state.lock() {
                    inner.status.dropped_frames += u64::from(dropped);
                    inner.status.encoded_frames += 1;
                }
                mark_lane_streaming(state, &peer_id);
            }
        }
        frame_id = frame_id.wrapping_add(1).max(1);
    }
    Ok(())
}

fn mark_lane_error(state: &Arc<Mutex<Inner>>, peer_id: &str, error: &str) {
    if let Ok(mut inner) = state.lock() {
        let message = format!(
            "Encoder do espectador: {}",
            error.chars().take(180).collect::<String>()
        );
        inner.status.last_error = Some(message);
        if let Some(metric) = inner.peer_metrics.get_mut(peer_id) {
            metric.phase = "encoder-retrying";
        }
        if let Some(metric) = inner
            .status
            .peer_metrics
            .iter_mut()
            .find(|metric| metric.peer_id == peer_id)
        {
            metric.phase = "encoder-retrying";
        }
    }
}

fn mark_lane_streaming(state: &Arc<Mutex<Inner>>, peer_id: &str) {
    if let Ok(mut inner) = state.lock() {
        if let Some(metric) = inner.peer_metrics.get_mut(peer_id) {
            metric.phase = "streaming";
        }
        if let Some(metric) = inner
            .status
            .peer_metrics
            .iter_mut()
            .find(|metric| metric.peer_id == peer_id)
        {
            metric.phase = "streaming";
        }
        if !inner
            .status
            .peer_metrics
            .iter()
            .any(|metric| metric.phase == "encoder-retrying")
        {
            inner.status.last_error = None;
        }
    }
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
