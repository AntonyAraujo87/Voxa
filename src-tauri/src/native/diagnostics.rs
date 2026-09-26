//! In-memory flight recorder for the last minute of a streaming session.

use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use super::EngineStatus;

const RETENTION: Duration = Duration::from_secs(60);
const MAX_EVENTS: usize = 512;

#[derive(Clone, Default)]
pub(super) struct DiagnosticRing {
    events: Arc<Mutex<VecDeque<DiagnosticEvent>>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiagnosticEvent {
    timestamp_ms: u64,
    category: &'static str,
    message: String,
    fields: Value,
}

impl DiagnosticRing {
    pub fn record(&self, category: &'static str, message: impl Into<String>, fields: Value) {
        let now = unix_ms();
        let mut message = message.into();
        if message.len() > 240 {
            let mut boundary = 240;
            while !message.is_char_boundary(boundary) {
                boundary -= 1;
            }
            message.truncate(boundary);
        }
        let Ok(mut events) = self.events.lock() else {
            return;
        };
        prune(&mut events, now);
        events.push_back(DiagnosticEvent {
            timestamp_ms: now,
            category,
            message,
            fields,
        });
        while events.len() > MAX_EVENTS {
            events.pop_front();
        }
    }

    pub fn record_status(&self, status: &EngineStatus) {
        self.record(
            "metrics",
            status.phase,
            json!({
                "role": status.role,
                "rttMs": status.rtt_ms,
                "lossPct": status.loss_pct,
                "bitrateKbps": status.bitrate_kbps,
                "receivedFrames": status.received_frames,
                "encodedFrames": status.encoded_frames,
                "decodedFrames": status.decoded_frames,
                "droppedFrames": status.dropped_frames,
                "connectedPeers": status.connected_peers,
                "capture": status.capture,
                "encoder": status.encoder,
                "decoder": status.decoder,
                "audio": status.audio,
                "audioError": status.audio_error.as_deref(),
                "lastError": status.last_error.as_deref(),
                "captureRestarts": status.capture_restarts,
                "keyframeRequests": status.keyframe_requests,
                "latencyP50Ms": status.latency_p50_ms,
                "latencyP95Ms": status.latency_p95_ms,
                "latencyP99Ms": status.latency_p99_ms,
                "avSyncMs": status.av_sync_ms,
                "rejoinRequired": status.rejoin_required,
            }),
        );
    }

    pub fn snapshot(&self) -> Vec<DiagnosticEvent> {
        let now = unix_ms();
        let Ok(mut events) = self.events.lock() else {
            return Vec::new();
        };
        prune(&mut events, now);
        events.iter().cloned().collect()
    }
}

fn prune(events: &mut VecDeque<DiagnosticEvent>, now: u64) {
    let cutoff = now.saturating_sub(RETENTION.as_millis() as u64);
    while events
        .front()
        .is_some_and(|event| event.timestamp_ms < cutoff)
    {
        events.pop_front();
    }
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ring_is_bounded_and_truncates_untrusted_messages() {
        let ring = DiagnosticRing::default();
        for index in 0..600 {
            ring.record("test", format!("{index}{}", "x".repeat(400)), json!({}));
        }
        let snapshot = ring.snapshot();
        assert_eq!(snapshot.len(), MAX_EVENTS);
        assert!(snapshot.iter().all(|event| event.message.len() <= 240));
        ring.record("test", "á".repeat(121), json!({}));
        assert_eq!(ring.snapshot().last().unwrap().message.chars().count(), 120);
    }
}
