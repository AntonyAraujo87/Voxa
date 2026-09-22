use std::collections::HashSet;

/// Estima perda em uma janela usando sequências autenticadas. Pacotes fora de
/// ordem contam como recebidos; duplicatas não melhoram artificialmente a taxa.
#[derive(Default)]
pub struct LossEstimator {
    first: Option<u64>,
    highest: u64,
    received: HashSet<u64>,
}

impl LossEstimator {
    pub fn observe(&mut self, sequence: u64) {
        self.first = Some(self.first.map_or(sequence, |first| first.min(sequence)));
        self.highest = self.highest.max(sequence);
        self.received.insert(sequence);
    }

    pub fn take_percent(&mut self) -> f32 {
        let Some(first) = self.first.take() else {
            return 0.0;
        };
        let expected = self.highest.saturating_sub(first).saturating_add(1);
        let received = self.received.len() as u64;
        self.highest = 0;
        self.received.clear();
        if expected == 0 {
            0.0
        } else {
            ((expected.saturating_sub(received)) as f64 * 100.0 / expected as f64).clamp(0.0, 100.0)
                as f32
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn handles_loss_reordering_and_duplicates() {
        let mut estimator = LossEstimator::default();
        for sequence in [10, 12, 12, 11, 14] {
            estimator.observe(sequence);
        }
        assert!((estimator.take_percent() - 20.0).abs() < f32::EPSILON);
        assert_eq!(estimator.take_percent(), 0.0);
    }
}
