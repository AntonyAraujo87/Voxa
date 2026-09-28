#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct FeedbackReport {
    pub(super) rtt_ms: u32,
    pub(super) loss_pct: f32,
    pub(super) latency_p50_ms: u32,
    pub(super) latency_p95_ms: u32,
    pub(super) latency_p99_ms: u32,
}

impl FeedbackReport {
    const LEGACY_LEN: usize = 8;
    const LEN: usize = 20;

    pub(super) fn encode(self) -> [u8; Self::LEN] {
        let mut bytes = [0; Self::LEN];
        bytes[0..4].copy_from_slice(&self.rtt_ms.to_be_bytes());
        bytes[4..8].copy_from_slice(&self.loss_pct.clamp(0.0, 100.0).to_bits().to_be_bytes());
        bytes[8..12].copy_from_slice(&self.latency_p50_ms.to_be_bytes());
        bytes[12..16].copy_from_slice(&self.latency_p95_ms.to_be_bytes());
        bytes[16..20].copy_from_slice(&self.latency_p99_ms.to_be_bytes());
        bytes
    }

    pub(super) fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != Self::LEGACY_LEN && bytes.len() != Self::LEN {
            return None;
        }
        let loss = f32::from_bits(u32::from_be_bytes(bytes[4..8].try_into().ok()?));
        let loss_pct = if loss.is_finite() {
            loss.clamp(0.0, 100.0)
        } else {
            100.0
        };
        let read = |start: usize| {
            bytes
                .get(start..start + 4)
                .and_then(|part| part.try_into().ok())
                .map(u32::from_be_bytes)
        };
        Some(Self {
            rtt_ms: read(0)?,
            loss_pct,
            latency_p50_ms: if bytes.len() == Self::LEN {
                read(8)?
            } else {
                0
            },
            latency_p95_ms: if bytes.len() == Self::LEN {
                read(12)?
            } else {
                0
            },
            latency_p99_ms: if bytes.len() == Self::LEN {
                read(16)?
            } else {
                0
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn round_trips_current_report() {
        let report = FeedbackReport {
            rtt_ms: 42,
            loss_pct: 1.25,
            latency_p50_ms: 15,
            latency_p95_ms: 28,
            latency_p99_ms: 40,
        };
        assert_eq!(FeedbackReport::decode(&report.encode()), Some(report));
    }
    #[test]
    fn rejects_trailing_or_truncated_data() {
        assert!(FeedbackReport::decode(&[0; 7]).is_none());
        assert!(FeedbackReport::decode(&[0; 9]).is_none());
        assert!(FeedbackReport::decode(&[0; 21]).is_none());
    }
}
