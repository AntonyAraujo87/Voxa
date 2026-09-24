use std::{
    collections::{HashMap, HashSet, VecDeque},
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
    fec: HashMap<usize, FecGroup>,
}

struct FecGroup {
    last_fragment_len: usize,
    parity: Vec<u8>,
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
    recent_completed: VecDeque<u64>,
    completed_set: HashSet<u64>,
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
                fec: HashMap::new(),
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
        recover_fec(frame);
        if frame.parts.iter().any(Option::is_none) {
            return Ok(None);
        }
        let frame = complete(&mut self.pending, frame_id);
        self.remember(frame_id);
        Ok(Some(frame))
    }

    pub fn push_fec(
        &mut self,
        frame_id: u64,
        group_start: u16,
        count: u16,
        timestamp_us: u64,
        data: &[u8],
    ) -> Result<Option<CompleteFrame>, String> {
        if self.completed_set.contains(&frame_id) {
            return Ok(None);
        }
        let count = count as usize;
        let group_start = group_start as usize;
        if count == 0
            || count > crate::protocol::MAX_FRAGMENTS
            || group_start >= count
            || group_start % crate::protocol::FEC_GROUP_SIZE != 0
            || data.len() < crate::protocol::FEC_HEADER_LEN
            || data.len() > crate::protocol::MAX_PAYLOAD
        {
            return Err("FEC inválido".into());
        }
        if !self.pending.contains_key(&frame_id) && self.pending.len() >= MAX_PENDING_FRAMES {
            return Err("Muitos frames incompletos".into());
        }
        let last_fragment_len = u16::from_be_bytes([data[0], data[1]]) as usize;
        if last_fragment_len == 0 || last_fragment_len > crate::protocol::FEC_DATA_PAYLOAD {
            return Err("Comprimento FEC inválido".into());
        }
        let frame = self
            .pending
            .entry(frame_id)
            .or_insert_with(|| PendingFrame {
                created: Instant::now(),
                keyframe: true,
                timestamp_us,
                parts: vec![None; count],
                bytes: 0,
                fec: HashMap::new(),
            });
        if !frame.keyframe || frame.parts.len() != count || frame.timestamp_us != timestamp_us {
            self.pending.remove(&frame_id);
            return Err("Metadados FEC divergentes".into());
        }
        frame.fec.entry(group_start).or_insert_with(|| FecGroup {
            last_fragment_len,
            parity: data[crate::protocol::FEC_HEADER_LEN..].to_vec(),
        });
        recover_fec(frame);
        if frame.parts.iter().any(Option::is_none) {
            Ok(None)
        } else {
            let frame = complete(&mut self.pending, frame_id);
            self.remember(frame_id);
            Ok(Some(frame))
        }
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

    fn remember(&mut self, frame_id: u64) {
        self.recent_completed.push_back(frame_id);
        self.completed_set.insert(frame_id);
        while self.recent_completed.len() > 64 {
            if let Some(oldest) = self.recent_completed.pop_front() {
                self.completed_set.remove(&oldest);
            }
        }
    }
}

fn recover_fec(frame: &mut PendingFrame) {
    for (&start, fec) in &frame.fec {
        let end = (start + crate::protocol::FEC_GROUP_SIZE).min(frame.parts.len());
        let missing = (start..end)
            .filter(|index| frame.parts[*index].is_none())
            .collect::<Vec<_>>();
        if missing.len() != 1 {
            continue;
        }
        let missing = missing[0];
        let mut recovered = fec.parity.clone();
        for index in start..end {
            if index == missing {
                continue;
            }
            if let Some(part) = &frame.parts[index] {
                for (offset, byte) in part.iter().enumerate() {
                    recovered[offset] ^= byte;
                }
            }
        }
        let expected = if missing + 1 == frame.parts.len() {
            fec.last_fragment_len
        } else {
            crate::protocol::FEC_DATA_PAYLOAD
        };
        if recovered.len() >= expected {
            recovered.truncate(expected);
            frame.bytes += recovered.len();
            frame.parts[missing] = Some(recovered);
        }
    }
}

fn complete(pending: &mut HashMap<u64, PendingFrame>, frame_id: u64) -> CompleteFrame {
    let frame = pending.remove(&frame_id).expect("frame completo presente");
    let mut bytes = Vec::with_capacity(frame.bytes);
    for part in frame.parts {
        bytes.extend_from_slice(part.as_ref().expect("fragmento recuperado"));
    }
    CompleteFrame {
        id: frame_id,
        keyframe: frame.keyframe,
        timestamp_us: frame.timestamp_us,
        bytes,
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

    #[test]
    fn fec_recovers_one_lost_keyframe_fragment() {
        let mut r = Reassembler::default();
        let a = vec![1u8; crate::protocol::FEC_DATA_PAYLOAD];
        let b = vec![2u8; 17];
        let mut parity = vec![0u8; crate::protocol::FEC_DATA_PAYLOAD];
        for (index, byte) in a.iter().enumerate() {
            parity[index] ^= byte;
        }
        for (index, byte) in b.iter().enumerate() {
            parity[index] ^= byte;
        }
        let mut fec = (b.len() as u16).to_be_bytes().to_vec();
        fec.extend_from_slice(&parity);
        assert!(r.push(7, 0, 2, true, 99, &a).unwrap().is_none());
        let frame = r.push_fec(7, 0, 2, 99, &fec).unwrap().unwrap();
        assert_eq!(&frame.bytes[..a.len()], &a);
        assert_eq!(&frame.bytes[a.len()..], &b);
    }
}
