#[derive(Debug, Clone)]
pub struct CongestionController {
    bitrate_bps: u32,
    min_bps: u32,
    max_bps: u32,
}

impl CongestionController {
    pub fn new(start_bps: u32, min_bps: u32, max_bps: u32) -> Self {
        Self {
            bitrate_bps: start_bps.clamp(min_bps, max_bps),
            min_bps,
            max_bps,
        }
    }
    pub fn update(&mut self, loss_pct: f32, rtt_ms: u32) -> u32 {
        if loss_pct >= 8.0 || rtt_ms >= 180 {
            self.bitrate_bps = ((self.bitrate_bps as f32) * 0.72) as u32;
        } else if loss_pct >= 3.0 || rtt_ms >= 100 {
            self.bitrate_bps = ((self.bitrate_bps as f32) * 0.88) as u32;
        } else if loss_pct < 1.0 && rtt_ms < 60 {
            self.bitrate_bps = self.bitrate_bps.saturating_add(350_000);
        }
        self.bitrate_bps = self.bitrate_bps.clamp(self.min_bps, self.max_bps);
        self.bitrate_bps
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reacts_fast_to_loss_and_recovers_slowly() {
        let mut c = CongestionController::new(10_000_000, 800_000, 30_000_000);
        assert!(c.update(10.0, 40) < 8_000_000);
        let reduced = c.update(10.0, 40);
        assert_eq!(c.update(0.0, 30), reduced + 350_000);
    }
}
