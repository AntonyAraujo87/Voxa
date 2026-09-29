use super::feedback::FeedbackReport;
use crate::native::{Inner, SessionPhase, StreamRole};
use std::sync::{
    atomic::{AtomicU32, AtomicU64, Ordering},
    Arc, Mutex,
};

pub(super) fn mark_dropped(state: &Arc<Mutex<Inner>>) {
    if let Ok(mut inner) = state.lock() {
        inner.status.dropped_frames += 1;
    }
}

pub(super) fn adjust_queue_bytes(counter: &AtomicU64, removed: u64, added: u64) {
    let _ = counter.fetch_update(Ordering::AcqRel, Ordering::Acquire, |current| {
        Some(current.saturating_sub(removed).saturating_add(added))
    });
}

pub(super) fn mark_failed(state: &Arc<Mutex<Inner>>) {
    if let Ok(mut inner) = state.lock() {
        // Erros de envio sao recuperaveis. No host, um par com falha nao pode
        // derrubar as sessoes dos demais espectadores.
        let next_phase = if inner.status.role == Some(StreamRole::Host) {
            SessionPhase::Recovering
        } else {
            SessionPhase::Failed
        };
        inner.status.set_phase(next_phase);
    }
}

pub(super) fn mark_connected(state: &Arc<Mutex<Inner>>, role: StreamRole, peer_id: &str) {
    if let Ok(mut inner) = state.lock() {
        let next_phase = if role == StreamRole::Host {
            SessionPhase::Streaming
        } else {
            SessionPhase::Connecting
        };
        inner.status.set_phase(next_phase);
    }
    update_peer(state, peer_id, |metric| metric.phase = "connected");
}

pub(super) fn apply_feedback(
    state: &Arc<Mutex<Inner>>,
    feedback_rtt_ms: &AtomicU32,
    feedback_loss_bits: &AtomicU32,
    feedback_at_us: &AtomicU64,
    peer_id: &str,
    payload: &[u8],
) {
    if let Some(report) = FeedbackReport::decode(payload) {
        feedback_rtt_ms.store(report.rtt_ms, Ordering::Release);
        feedback_loss_bits.store(report.loss_pct.to_bits(), Ordering::Release);
        feedback_at_us.store(super::now_us(), Ordering::Release);
        if let Ok(mut inner) = state.lock() {
            inner.status.rtt_ms = report.rtt_ms;
            inner.status.loss_pct = report.loss_pct;
        }
        update_peer(state, peer_id, |metric| {
            metric.rtt_ms = report.rtt_ms;
            metric.loss_pct = report.loss_pct;
            metric.latency_p50_ms = report.latency_p50_ms;
            metric.latency_p95_ms = report.latency_p95_ms;
            metric.latency_p99_ms = report.latency_p99_ms;
        });
    }
}

pub(super) fn adaptive_fec_group_size(loss_pct: f32) -> u32 {
    if !loss_pct.is_finite() || loss_pct >= 8.0 {
        4
    } else if loss_pct >= 3.0 {
        8
    } else if loss_pct >= 1.0 {
        16
    } else {
        0
    }
}

pub(super) fn update_peer(
    state: &Arc<Mutex<Inner>>,
    peer_id: &str,
    update: impl FnOnce(&mut crate::native::PeerMetric),
) {
    if let Ok(mut inner) = state.lock() {
        let snapshot = {
            let metric = inner
                .peer_metrics
                .entry(peer_id.to_string())
                .or_insert_with(|| crate::native::PeerMetric::waiting(peer_id.to_string()));
            update(metric);
            metric.clone()
        };
        if let Some(metric) = inner
            .status
            .peer_metrics
            .iter_mut()
            .find(|metric| metric.peer_id == peer_id)
        {
            *metric = snapshot;
        } else {
            inner.status.peer_metrics.push(snapshot);
        }
    }
}
