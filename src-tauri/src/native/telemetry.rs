use serde::Serialize;
use std::collections::VecDeque;

const WINDOW: usize = 600;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagePercentiles {
    pub p50_ms: u32,
    pub p95_ms: u32,
    pub p99_ms: u32,
    pub samples: usize,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineTelemetry {
    pub capture_interval: StagePercentiles,
    pub encode: StagePercentiles,
    pub network: StagePercentiles,
    pub decode: StagePercentiles,
    pub present: StagePercentiles,
    pub application_queue_bytes: u64,
}

#[derive(Default)]
pub(super) struct TelemetryCollector {
    capture_interval: VecDeque<u32>,
    encode: VecDeque<u32>,
    network: VecDeque<u32>,
    decode: VecDeque<u32>,
    present: VecDeque<u32>,
}

impl TelemetryCollector {
    pub fn capture_interval(&mut self, value: u32) {
        push(&mut self.capture_interval, value);
    }
    pub fn encode(&mut self, value: u32) {
        push(&mut self.encode, value);
    }
    pub fn network(&mut self, value: u32) {
        push(&mut self.network, value);
    }
    pub fn decode(&mut self, value: u32) {
        push(&mut self.decode, value);
    }
    pub fn present(&mut self, value: u32) {
        push(&mut self.present, value);
    }

    pub fn snapshot(&self, application_queue_bytes: u64) -> PipelineTelemetry {
        PipelineTelemetry {
            capture_interval: percentiles(&self.capture_interval),
            encode: percentiles(&self.encode),
            network: percentiles(&self.network),
            decode: percentiles(&self.decode),
            present: percentiles(&self.present),
            application_queue_bytes,
        }
    }
}

fn push(samples: &mut VecDeque<u32>, value: u32) {
    if samples.len() >= WINDOW {
        samples.pop_front();
    }
    samples.push_back(value.min(60_000));
}

fn percentiles(samples: &VecDeque<u32>) -> StagePercentiles {
    if samples.is_empty() {
        return StagePercentiles::default();
    }
    let mut sorted = samples.iter().copied().collect::<Vec<_>>();
    sorted.sort_unstable();
    let at = |percent: usize| sorted[(sorted.len() - 1) * percent / 100];
    StagePercentiles {
        p50_ms: at(50),
        p95_ms: at(95),
        p99_ms: at(99),
        samples: sorted.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounds_window_and_computes_percentiles() {
        let mut collector = TelemetryCollector::default();
        for value in 1..=700 {
            collector.encode(value);
        }
        let snapshot = collector.snapshot(42);
        assert_eq!(snapshot.encode.samples, WINDOW);
        assert!(snapshot.encode.p50_ms >= 400);
        assert_eq!(snapshot.application_queue_bytes, 42);
    }
}
