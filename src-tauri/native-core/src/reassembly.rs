use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
const FRAME_DEADLINE: Duration = Duration::from_millis(85);
const MAX_FRAGMENTS: usize = 4096;
const MAX_FRAME_BYTES: usize = 24 * 1024 * 1024;

struct PendingFrame {
    created: Instant,
    keyframe: bool,
    parts: Vec<Option<Vec<u8>>>,
    bytes: usize,
}
pub struct CompleteFrame {
    pub id: u64,
    pub keyframe: bool,
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
        data: &[u8],
    ) -> Result<Option<CompleteFrame>, String> {
        let count = count as usize;
        let index = index as usize;
        if count == 0 || count > MAX_FRAGMENTS || index >= count {
            return Err("Fragmentação inválida".into());
        }
        let frame = self
            .pending
            .entry(frame_id)
            .or_insert_with(|| PendingFrame {
                created: Instant::now(),
                keyframe,
                parts: vec![None; count],
                bytes: 0,
            });
        if frame.parts.len() != count {
            self.pending.remove(&frame_id);
            return Err("Contagem de fragmentos mudou".into());
        }
        if frame.parts[index].is_none() {
            frame.bytes += data.len();
            if frame.bytes > MAX_FRAME_BYTES {
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
            bytes,
        }))
    }
    pub fn expire(&mut self) -> usize {
        let before = self.pending.len();
        self.pending
            .retain(|_, frame| frame.created.elapsed() <= FRAME_DEADLINE);
        before - self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn completes_out_of_order() {
        let mut r = Reassembler::default();
        assert!(r.push(1, 1, 2, false, b"b").unwrap().is_none());
        let f = r.push(1, 0, 2, false, b"a").unwrap().unwrap();
        assert_eq!(f.bytes, b"ab");
    }
}
