use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
const DELTA_DEADLINE: Duration = Duration::from_millis(250);
const KEYFRAME_DEADLINE: Duration = Duration::from_millis(1500);
const MAX_PENDING_FRAMES: usize = 3;

struct PendingFrame {
    created: Instant,
    keyframe: bool,
    timestamp_us: u64,
    parts: Vec<Option<Vec<u8>>>,
    bytes: usize,
}
pub struct CompleteFrame {
    pub id: u64,
    pub keyframe: bool,
    pub timestamp_us: u64,
    pub bytes: Vec<u8>,
}
#[derive(Default)]
pub struct Reassembler {
    pending: HashMap<u64, PendingFrame>,
}

impl Reassembler {
    pub fn push(
        &mut self,
        frame_id: u64,
        index: u16,
        count: u16,
        keyframe: bool,
        timestamp_us: u64,
        data: &[u8],
    ) -> Result<Option<CompleteFrame>, String> {
        let count = count as usize;
        let index = index as usize;
        if count == 0 || count > crate::protocol::MAX_FRAGMENTS || index >= count {
            return Err("Fragmentação inválida".into());
        }
        if !self.pending.contains_key(&frame_id) && self.pending.len() >= MAX_PENDING_FRAMES {
            return Err("Muitos frames incompletos".into());
        }
        let frame = self
            .pending
            .entry(frame_id)
            .or_insert_with(|| PendingFrame {
                created: Instant::now(),
                keyframe,
                timestamp_us,
                parts: vec![None; count],
                bytes: 0,
            });
        if frame.parts.len() != count
            || frame.keyframe != keyframe
            || frame.timestamp_us != timestamp_us
        {
            self.pending.remove(&frame_id);
            return Err("Contagem de fragmentos mudou".into());
        }
        if frame.parts[index].is_none() {
            frame.bytes += data.len();
            if frame.bytes > crate::protocol::MAX_ENCODED_FRAME {
                self.pending.remove(&frame_id);
                return Err("Frame excedeu o limite".into());
            }
            frame.parts[index] = Some(data.to_vec());
        }
        if frame.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        let frame = self.pending.remove(&frame_id).unwrap();
        let mut bytes = Vec::with_capacity(frame.bytes);
        for part in frame.parts {
            bytes.extend_from_slice(part.as_ref().unwrap());
        }
        Ok(Some(CompleteFrame {
            id: frame_id,
            keyframe: frame.keyframe,
            timestamp_us: frame.timestamp_us,
            bytes,
        }))
    }
    pub fn expire(&mut self) -> usize {
        let before = self.pending.len();
        self.pending.retain(|_, frame| {
            let deadline = if frame.keyframe {
                KEYFRAME_DEADLINE
            } else {
                DELTA_DEADLINE
            };
            frame.created.elapsed() <= deadline
        });
        before - self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completes_out_of_order() {
        let mut r = Reassembler::default();
        assert!(r.push(1, 1, 2, false, 99, b"b").unwrap().is_none());
        let f = r.push(1, 0, 2, false, 99, b"a").unwrap().unwrap();
        assert_eq!(f.bytes, b"ab");
        assert_eq!(f.timestamp_us, 99);
    }
    #[test]
    fn bounds_incomplete_frame_memory() {
        let mut r = Reassembler::default();
        for id in 1..=3 {
            assert!(r.push(id, 0, 2, false, 0, b"x").unwrap().is_none());
        }
        assert!(r.push(4, 0, 2, false, 0, b"x").is_err());
    }
    #[test]
    fn keyframes_get_enough_time_for_udp_pacing() {
        assert!(KEYFRAME_DEADLINE > DELTA_DEADLINE);
        assert!(KEYFRAME_DEADLINE >= Duration::from_secs(1));
    }
}
