#![no_main]

use libfuzzer_sys::fuzz_target;
use voxa_native_core::protocol;

fuzz_target!(|data: &[u8]| {
    let key = [0xA5; 32];
    // Every byte sequence is an untrusted UDP datagram. The parser must reject
    // malformed headers/ciphertext without panicking or allocating unboundedly.
    let _ = protocol::open(&key, data);
});
