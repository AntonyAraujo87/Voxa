use crate::{
    congestion::CongestionController,
    protocol::{FEC_DATA_PAYLOAD, FEC_GROUP_SIZE, FEC_HEADER_LEN},
    reassembly::{CompleteFrame, Reassembler},
};

fn parity(chunks: &[&[u8]], last_len: usize) -> Vec<u8> {
    let size = chunks.iter().map(|chunk| chunk.len()).max().unwrap_or(0);
    let mut output = (last_len as u16).to_be_bytes().to_vec();
    output.resize(FEC_HEADER_LEN + size, 0);
    for chunk in chunks {
        for (index, byte) in chunk.iter().enumerate() {
            output[FEC_HEADER_LEN + index] ^= byte;
        }
    }
    output
}

#[test]
fn keyframe_survives_jitter_and_one_loss_per_fec_group() {
    let original = (0..FEC_DATA_PAYLOAD * 18 + 37)
        .map(|index| (index.wrapping_mul(31) & 0xff) as u8)
        .collect::<Vec<_>>();
    let chunks = original.chunks(FEC_DATA_PAYLOAD).collect::<Vec<_>>();
    let count = chunks.len() as u16;
    let mut receiver = Reassembler::default();
    let mut completed = None::<CompleteFrame>;

    // Paridades chegam antes dos dados e cada grupo perde um fragmento
    // diferente. Os demais chegam em ordem inversa para simular jitter.
    for start in (0..chunks.len()).step_by(FEC_GROUP_SIZE) {
        let end = (start + FEC_GROUP_SIZE).min(chunks.len());
        let fec = parity(&chunks[start..end], chunks.last().unwrap().len());
        completed = receiver
            .push_fec(42, start as u16, count, 77, &fec)
            .unwrap()
            .or(completed);
    }
    for index in (0..chunks.len()).rev() {
        if index % FEC_GROUP_SIZE == 2 {
            continue;
        }
        completed = receiver
            .push(42, index as u16, count, true, 77, chunks[index])
            .unwrap()
            .or(completed);
    }
    assert_eq!(completed.expect("FEC deve completar o frame").bytes, original);
}

#[test]
fn congestion_stays_bounded_during_loss_burst_and_recovers_gradually() {
    let mut controller = CongestionController::new(12_000_000, 800_000, 35_000_000);
    for _ in 0..20 {
        controller.update(12.0, 220);
    }
    assert_eq!(controller.update(12.0, 220), 800_000);
    let after_one_good_window = controller.update(0.0, 25);
    assert_eq!(after_one_good_window, 1_150_000);
    for _ in 0..200 {
        controller.update(0.0, 25);
    }
    assert_eq!(controller.update(0.0, 25), 35_000_000);
}
