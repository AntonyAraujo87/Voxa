use super::TransportHandle;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Arc, Mutex,
    },
};
use voxa_native_core::protocol::{StreamConfig, VideoCodec};

#[derive(Clone, Default)]
pub struct HostTransportHandle {
    peers: Arc<Mutex<HashMap<String, TransportHandle>>>,
    configs: Arc<Mutex<HashMap<(String, VideoCodec), StreamConfig>>>,
    supported_codecs: Arc<AtomicU32>,
    force_keyframe: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
}

pub(super) fn negotiated_codec(local: u8, remote: u8) -> Option<VideoCodec> {
    VideoCodec::best_common(local, remote)
}

pub(super) fn opus_bitrate_for_video(video_bitrate: u32) -> i32 {
    match video_bitrate {
        0..=1_499_999 => 64_000,
        1_500_000..=3_999_999 => 80_000,
        4_000_000..=7_999_999 => 96_000,
        _ => 128_000,
    }
}

impl HostTransportHandle {
    pub fn add(&self, peer_id: String, handle: TransportHandle) {
        if let Some(codec) = self.codec_for(&handle) {
            if let Some(config) = self
                .configs
                .lock()
                .ok()
                .and_then(|configs| configs.get(&(peer_id.clone(), codec)).copied())
            {
                handle.queue_config(config);
            }
        }
        if let Ok(mut peers) = self.peers.lock() {
            peers.insert(peer_id, handle);
        }
        self.force_keyframe.store(true, Ordering::Release);
    }
    pub fn remove(&self, peer_id: &str) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.remove(peer_id);
        }
        if let Ok(mut configs) = self.configs.lock() {
            configs.retain(|(configured_peer, _), _| configured_peer != peer_id);
        }
    }
    pub fn clear(&self) {
        if let Ok(mut peers) = self.peers.lock() {
            peers.clear();
        }
        if let Ok(mut configs) = self.configs.lock() {
            configs.clear();
        }
    }
    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Acquire)
    }
    pub fn has_peers(&self) -> bool {
        self.peers
            .lock()
            .map(|peers| !peers.is_empty())
            .unwrap_or(false)
    }
    pub fn audio_bitrate_bps(&self) -> i32 {
        let video = self
            .peers
            .lock()
            .ok()
            .and_then(|peers| peers.values().map(TransportHandle::target_bitrate).min())
            .unwrap_or(12_000_000);
        opus_bitrate_for_video(video)
    }
    pub fn stop(&self) {
        self.stop.store(true, Ordering::Release);
        self.clear();
    }
    pub fn set_supported_codecs(&self, codecs: u8) {
        self.supported_codecs
            .store(u32::from(codecs), Ordering::Release);
    }
    fn codec_for(&self, handle: &TransportHandle) -> Option<VideoCodec> {
        negotiated_codec(
            self.supported_codecs.load(Ordering::Acquire) as u8,
            handle.peer_codecs.load(Ordering::Acquire) as u8,
        )
    }
    pub fn peers_support_any(&self, local_codecs: u8) -> bool {
        self.peers
            .lock()
            .map(|peers| {
                peers.values().all(|handle| {
                    negotiated_codec(
                        local_codecs,
                        handle.peer_codecs.load(Ordering::Acquire) as u8,
                    )
                    .is_some()
                })
            })
            .unwrap_or(false)
    }
    pub fn queue_video(&self, peer_id: &str, codec: VideoCodec, frame: EncodedFrame) -> bool {
        let handle = self
            .peers
            .lock()
            .ok()
            .and_then(|peers| peers.get(peer_id).cloned());
        handle
            .filter(|handle| self.codec_for(handle) == Some(codec))
            .map(|handle| handle.queue_video(frame))
            .unwrap_or(false)
    }
    pub fn queue_config(&self, peer_id: &str, config: StreamConfig) {
        if let Ok(mut current) = self.configs.lock() {
            current.insert((peer_id.to_owned(), config.codec), config);
        }
        if let Ok(peers) = self.peers.lock() {
            if let Some(handle) = peers.get(peer_id) {
                if self.codec_for(handle) == Some(config.codec) {
                    handle.queue_config(config);
                }
            }
        }
    }
    pub fn take_keyframe_request(&self) -> bool {
        self.force_keyframe.swap(false, Ordering::AcqRel)
            || self
                .peers
                .lock()
                .map(|peers| peers.values().any(TransportHandle::take_keyframe_request))
                .unwrap_or(false)
    }
    pub fn request_keyframe(&self) {
        self.force_keyframe.store(true, Ordering::Release);
    }
    pub fn active_lanes(&self) -> Vec<(String, VideoCodec, u32)> {
        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        peers
            .iter()
            .filter_map(|(peer_id, handle)| {
                self.codec_for(handle)
                    .map(|codec| (peer_id.clone(), codec, handle.target_bitrate()))
            })
            .collect()
    }
    pub fn queue_audio(&self, packet: AudioPacket) {
        if let Ok(peers) = self.peers.lock() {
            for handle in peers.values() {
                handle.queue_audio(packet.clone());
            }
        }
    }
    pub fn queue_cursor(&self, cursor: CursorPacket) {
        if let Ok(peers) = self.peers.lock() {
            for handle in peers.values() {
                handle.queue_cursor(cursor.clone());
            }
        }
    }
}

#[derive(Clone)]
pub struct EncodedFrame {
    pub id: u64,
    pub timestamp_us: u64,
    pub keyframe: bool,
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Clone)]
pub struct AudioPacket {
    pub timestamp_us: u64,
    pub bytes: Arc<Vec<u8>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorPacket {
    pub timestamp_us: u64,
    pub visible: bool,
    pub x: i32,
    pub y: i32,
    pub source_width: u32,
    pub source_height: u32,
}

impl CursorPacket {
    const WIRE_LEN: usize = 17;
    pub(super) fn encode(&self) -> [u8; Self::WIRE_LEN] {
        let mut bytes = [0u8; Self::WIRE_LEN];
        bytes[0] = u8::from(self.visible);
        bytes[1..5].copy_from_slice(&self.x.to_be_bytes());
        bytes[5..9].copy_from_slice(&self.y.to_be_bytes());
        bytes[9..13].copy_from_slice(&self.source_width.to_be_bytes());
        bytes[13..17].copy_from_slice(&self.source_height.to_be_bytes());
        bytes
    }
    pub(super) fn decode(timestamp_us: u64, bytes: &[u8]) -> Option<Self> {
        if bytes.len() != Self::WIRE_LEN || bytes[0] > 1 {
            return None;
        }
        let cursor = Self {
            timestamp_us,
            visible: bytes[0] == 1,
            x: i32::from_be_bytes(bytes[1..5].try_into().ok()?),
            y: i32::from_be_bytes(bytes[5..9].try_into().ok()?),
            source_width: u32::from_be_bytes(bytes[9..13].try_into().ok()?),
            source_height: u32::from_be_bytes(bytes[13..17].try_into().ok()?),
        };
        (cursor.source_width > 0 && cursor.source_height > 0).then_some(cursor)
    }
}
