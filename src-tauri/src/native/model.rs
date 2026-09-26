use super::{diagnostics, pake};
use crate::native::transport::{DatagramHub, HostTransportHandle, TransportControl};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::net::UdpSocket;
use voxa_native_core::protocol;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StreamRole {
    Host,
    Viewer,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetId {
    pub adapter_index: u32,
    pub output_index: u32,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureTargetInfo {
    pub id: CaptureTargetId,
    pub gpu: String,
    pub monitor: String,
    pub width: u32,
    pub height: u32,
    pub primary: bool,
    pub hdr: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioProcessInfo {
    pub process_id: u32,
    pub name: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphicsAdapterInfo {
    pub adapter_index: u32,
    pub name: String,
    pub dedicated_memory_mb: u64,
    pub vendor_id: u32,
    pub device_id: u32,
    pub revision: u32,
    pub driver_version: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerVerification {
    pub(super) peer_id: String,
    pub(super) code: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerMetric {
    pub(super) peer_id: String,
    pub(super) endpoint: Option<String>,
    pub(super) phase: &'static str,
    pub(super) rtt_ms: u32,
    pub(super) loss_pct: f32,
    pub(super) bitrate_kbps: u32,
    pub(super) received_frames: u64,
    pub(super) dropped_frames: u64,
    pub(super) latency_p50_ms: u32,
    pub(super) latency_p95_ms: u32,
    pub(super) latency_p99_ms: u32,
}

impl PeerMetric {
    pub(super) fn waiting(peer_id: String) -> Self {
        Self {
            peer_id,
            endpoint: None,
            phase: "punching",
            rtt_ms: 0,
            loss_pct: 0.0,
            bitrate_kbps: 12_000,
            received_frames: 0,
            dropped_frames: 0,
            latency_p50_ms: 0,
            latency_p95_ms: 0,
            latency_p99_ms: 0,
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub(super) phase: &'static str,
    pub(super) role: Option<StreamRole>,
    pub(super) local_endpoint: Option<String>,
    pub(super) public_endpoint: Option<String>,
    pub(super) peer_endpoint: Option<String>,
    pub(super) rtt_ms: u32,
    pub(super) loss_pct: f32,
    pub(super) bitrate_kbps: u32,
    pub(super) received_frames: u64,
    pub(super) encoded_frames: u64,
    pub(super) dropped_frames: u64,
    pub(super) keyframe_requests: u64,
    pub(super) renderer: &'static str,
    pub(super) capture: &'static str,
    pub(super) encoder: &'static str,
    pub(super) decoder: &'static str,
    pub(super) decoder_gpu: Option<String>,
    pub(super) audio: &'static str,
    pub(super) audio_bitrate_kbps: u32,
    pub(super) audio_error: Option<String>,
    pub(super) av_sync_ms: i32,
    pub(super) encoder_capacity: usize,
    pub(super) cursor_visible: bool,
    pub(super) hdr: bool,
    pub(super) capture_restarts: u32,
    pub(super) rejoin_required: bool,
    pub(super) decoded_frames: u64,
    pub(super) latency_p50_ms: u32,
    pub(super) latency_p95_ms: u32,
    pub(super) latency_p99_ms: u32,
    pub(super) verification_code: Option<String>,
    pub(super) connected_peers: usize,
    pub(super) max_peers: usize,
    pub(super) peer_verifications: Vec<PeerVerification>,
    pub(super) peer_metrics: Vec<PeerMetric>,
    pub(super) last_error: Option<String>,
}

impl Default for EngineStatus {
    fn default() -> Self {
        Self {
            phase: "idle",
            role: None,
            local_endpoint: None,
            public_endpoint: None,
            peer_endpoint: None,
            rtt_ms: 0,
            loss_pct: 0.0,
            bitrate_kbps: 12_000,
            received_frames: 0,
            encoded_frames: 0,
            dropped_frames: 0,
            keyframe_requests: 0,
            renderer: "closed",
            capture: "idle",
            encoder: "idle",
            decoder: "idle",
            decoder_gpu: None,
            audio: "idle",
            audio_bitrate_kbps: 0,
            audio_error: None,
            av_sync_ms: 0,
            encoder_capacity: 1,
            cursor_visible: true,
            hdr: false,
            capture_restarts: 0,
            rejoin_required: false,
            decoded_frames: 0,
            latency_p50_ms: 0,
            latency_p95_ms: 0,
            latency_p99_ms: 0,
            verification_code: None,
            connected_peers: 0,
            max_peers: 4,
            peer_verifications: Vec::new(),
            peer_metrics: Vec::new(),
            last_error: None,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedEndpoint {
    pub(super) local: String,
    pub(super) public: Option<String>,
    pub(super) public_key: String,
    pub(super) codecs: u8,
}

#[derive(Default)]
pub(super) struct Inner {
    pub(super) generation: u64,
    pub(super) status: EngineStatus,
    pub(super) socket: Option<Arc<UdpSocket>>,
    pub(super) datagrams: Option<DatagramHub>,
    pub(super) transports: HashMap<String, TransportControl>,
    pub(super) host_fanout: HostTransportHandle,
    pub(super) host_pipeline: Option<std::thread::JoinHandle<()>>,
    pub(super) host_audio: Option<std::thread::JoinHandle<()>>,
    pub(super) verification_codes: HashMap<String, String>,
    pub(super) peer_public_keys: HashMap<String, String>,
    pub(super) peer_metrics: HashMap<String, PeerMetric>,
    pub(super) key_exchange: Option<protocol::EphemeralKey>,
    pub(super) capture_target: Option<CaptureTargetId>,
    pub(super) audio_process_id: Option<u32>,
    pub(super) decoder_adapter_index: Option<u32>,
    pub(super) supported_codecs: u8,
    pub(super) hardware_encoder_capacity: usize,
    pub(super) signaling_max_peers: usize,
    pub(super) cursor_visible: bool,
    pub(super) pake: pake::PakeManager,
    pub(super) diagnostics: diagnostics::DiagnosticRing,
}

#[derive(Default)]
pub struct NativeEngine {
    pub(super) inner: Arc<Mutex<Inner>>,
}
