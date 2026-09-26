#![no_main]

use libfuzzer_sys::fuzz_target;
use voxa_native_core::{protocol, reassembly::Reassembler};

fuzz_target!(|data: &[u8]| {
    let mut reassembler = Reassembler::default();
    let mut cursor = 0usize;
    // Bound operations and fragment sizes even when libFuzzer supplies a very
    // large corpus entry. The production limits remain exercised by the calls.
    for _ in 0..64 {
        if cursor + 8 > data.len() {
            break;
        }
        let selector = data[cursor];
        // Reuse four frame IDs so mutations exercise duplicate, out-of-order,
        // conflicting metadata and successful completion paths.
        let frame_id = u64::from(data[cursor + 1] % 4);
        let count = u16::from(data[cursor + 2] % 24).saturating_add(1);
        let index = u16::from(data[cursor + 3]) % count;
        let timestamp = u32::from_be_bytes([
            data[cursor + 4],
            data[cursor + 5],
            data[cursor + 6],
            data[cursor + 7],
        ]) as u64;
        cursor += 8;
        let available = data.len().saturating_sub(cursor);
        let requested = usize::from(selector).min(protocol::MAX_PAYLOAD + 8);
        let length = available.min(requested);
        let payload = &data[cursor..cursor + length];
        cursor += length;
        if selector & 1 == 0 {
            let _ = reassembler.push(
                frame_id,
                index,
                count,
                selector & 2 != 0,
                timestamp,
                payload,
            );
        } else {
            let group = index - (index % protocol::FEC_GROUP_SIZE as u16);
            let _ = reassembler.push_fec(frame_id, group, count, timestamp, payload);
        }
        if selector & 4 != 0 {
            let _ = reassembler.expire();
        }
    }
});
