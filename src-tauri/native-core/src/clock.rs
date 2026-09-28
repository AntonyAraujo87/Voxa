//! Process-wide monotonic media clock.
//!
//! Media timestamps must never move backwards when Windows corrects wall time.
//! Wall time remains available only for logs and exported diagnostics.

use std::{sync::OnceLock, time::Instant};

static PROCESS_EPOCH: OnceLock<Instant> = OnceLock::new();

pub fn monotonic_us() -> u64 {
    PROCESS_EPOCH
        .get_or_init(Instant::now)
        .elapsed()
        .as_micros()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn never_moves_backwards() {
        let first = monotonic_us();
        let second = monotonic_us();
        assert!(second >= first);
    }
}
