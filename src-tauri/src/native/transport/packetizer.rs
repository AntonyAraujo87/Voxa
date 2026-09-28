use voxa_native_core::protocol;

pub(super) fn chunk_size(keyframe: bool) -> usize {
    if keyframe {
        protocol::FEC_DATA_PAYLOAD
    } else {
        protocol::MAX_PAYLOAD
    }
}

pub(super) fn fragment_count(frame_len: usize, keyframe: bool) -> Option<u16> {
    let size = chunk_size(keyframe);
    let count = frame_len.checked_add(size - 1)? / size;
    (count > 0 && count <= protocol::MAX_FRAGMENTS).then_some(count as u16)
}

pub(super) fn xor_parity(
    chunks: &[&[u8]],
    group_size: usize,
    final_fragment_len: usize,
) -> Vec<u8> {
    debug_assert!(
        (protocol::MIN_FEC_GROUP_SIZE..=protocol::MAX_FEC_GROUP_SIZE).contains(&group_size)
    );
    let parity_len = chunks.iter().map(|chunk| chunk.len()).max().unwrap_or(0);
    let mut parity = Vec::with_capacity(protocol::FEC_HEADER_LEN + parity_len);
    parity.push(group_size as u8);
    parity.extend_from_slice(&(final_fragment_len as u16).to_be_bytes());
    parity.resize(protocol::FEC_HEADER_LEN + parity_len, 0);
    for chunk in chunks {
        for (offset, byte) in chunk.iter().enumerate() {
            parity[protocol::FEC_HEADER_LEN + offset] ^= byte;
        }
    }
    parity
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reserves_fec_header_only_for_keyframes() {
        assert_eq!(chunk_size(false), protocol::MAX_PAYLOAD);
        assert_eq!(chunk_size(true), protocol::FEC_DATA_PAYLOAD);
    }
    #[test]
    fn rejects_empty_and_oversized_frames() {
        assert_eq!(fragment_count(0, false), None);
        assert_eq!(fragment_count(protocol::MAX_ENCODED_FRAME + 1, false), None);
    }
    #[test]
    fn parity_recovers_one_missing_chunk() {
        let a = [1u8, 2, 3];
        let b = [4u8, 5, 6];
        let parity = xor_parity(&[&a, &b], 4, b.len());
        let recovered = parity[protocol::FEC_HEADER_LEN..]
            .iter()
            .zip(a)
            .map(|(left, right)| left ^ right)
            .collect::<Vec<_>>();
        assert_eq!(recovered, b);
    }
}
