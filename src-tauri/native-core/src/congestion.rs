use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NetworkCondition {
    Healthy,
    Constrained,
    Critical,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CongestionDecision {
    pub target_bitrate_bps: u32,
    pub condition: NetworkCondition,
    pub max_delta_age: Duration,
    pub request_keyframe: bool,
}

#[derive(Debug, Clone)]
pub struct CongestionController {
    bitrate_bps: u32,
    min_bps: u32,
    max_bps: u32,
    condition: NetworkCondition,
    critical_samples: u8,
}

impl CongestionController {
    pub fn new(start_bps: u32, min_bps: u32, max_bps: u32) -> Self {
        Self {
            bitrate_bps: start_bps.clamp(min_bps, max_bps),
            min_bps,
            max_bps,
            condition: NetworkCondition::Healthy,
            critical_samples: 0,
        }
    }

    pub fn update(&mut self, loss_pct: f32, rtt_ms: u32) -> CongestionDecision {
        let loss_pct = if loss_pct.is_finite() {
            loss_pct.clamp(0.0, 100.0)
        } else {
            100.0
        };
        let next = if loss_pct >= 8.0 || rtt_ms >= 180 {
            NetworkCondition::Critical
        } else if loss_pct >= 3.0 || rtt_ms >= 100 {
            NetworkCondition::Constrained
        } else {
            NetworkCondition::Healthy
        };
        match next {
            NetworkCondition::Critical => {
                self.bitrate_bps = ((self.bitrate_bps as f32) * 0.72) as u32;
                self.critical_samples = self.critical_samples.saturating_add(1);
            }
            NetworkCondition::Constrained => {
                self.bitrate_bps = ((self.bitrate_bps as f32) * 0.88) as u32;
            }
            NetworkCondition::Healthy if loss_pct < 1.0 && rtt_ms < 60 => {
                self.bitrate_bps = self.bitrate_bps.saturating_add(350_000);
            }
            NetworkCondition::Healthy => {}
        }
        self.bitrate_bps = self.bitrate_bps.clamp(self.min_bps, self.max_bps);
        let request_keyframe = self.condition == NetworkCondition::Critical
            && next != NetworkCondition::Critical
            && self.critical_samples >= 2;
        if next != NetworkCondition::Critical {
            self.critical_samples = 0;
        }
        self.condition = next;
        CongestionDecision {
            target_bitrate_bps: self.bitrate_bps,
            condition: next,
            max_delta_age: match next {
                NetworkCondition::Healthy => Duration::from_millis(250),
                NetworkCondition::Constrained => Duration::from_millis(140),
                NetworkCondition::Critical => Duration::from_millis(80),
            },
            request_keyframe,
        }
    }
}

/// Centraliza a regra de protocolo de no maximo quatro pedidos por segundo.
pub struct KeyframeRequestLimiter {
    last: Option<Instant>,
}

impl KeyframeRequestLimiter {
    pub fn new() -> Self {
        Self { last: None }
    }
    pub fn allow_at(&mut self, now: Instant) -> bool {
        if self
            .last
            .is_some_and(|last| now.saturating_duration_since(last) < Duration::from_millis(250))
        {
            return false;
        }
        self.last = Some(now);
        true
    }
    pub fn allow(&mut self) -> bool {
        self.allow_at(Instant::now())
    }
}

impl Default for KeyframeRequestLimiter {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reacts_fast_to_loss_and_recovers_slowly() {
        let mut c = CongestionController::new(10_000_000, 800_000, 30_000_000);
        assert!(c.update(10.0, 40).target_bitrate_bps < 8_000_000);
        let reduced = c.update(10.0, 40).target_bitrate_bps;
        let recovered = c.update(0.0, 30);
        assert_eq!(recovered.target_bitrate_bps, reduced + 350_000);
        assert!(recovered.request_keyframe);
    }

    #[test]
    fn tightens_delta_deadline_under_pressure() {
        let mut c = CongestionController::new(10_000_000, 800_000, 30_000_000);
        assert_eq!(c.update(0.0, 30).max_delta_age, Duration::from_millis(250));
        assert_eq!(c.update(4.0, 30).max_delta_age, Duration::from_millis(140));
        assert_eq!(c.update(9.0, 30).max_delta_age, Duration::from_millis(80));
    }

    #[test]
    fn keyframe_limiter_enforces_spacing() {
        let start = Instant::now();
        let mut limiter = KeyframeRequestLimiter::new();
        assert!(limiter.allow_at(start));
        assert!(!limiter.allow_at(start + Duration::from_millis(249)));
        assert!(limiter.allow_at(start + Duration::from_millis(250)));
        assert!(limiter.allow_at(start + Duration::from_millis(500)));
        assert!(limiter.allow_at(start + Duration::from_millis(750)));
        assert!(limiter.allow_at(start + Duration::from_millis(1_000)));
    }
}
