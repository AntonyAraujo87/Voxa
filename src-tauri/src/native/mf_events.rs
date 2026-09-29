//! Bounded wait for asynchronous Media Foundation transforms.
//!
//! Some hardware MFTs do not implement a cancellable callback reliably. A
//! bounded poll therefore remains the safe fallback, but the backoff below
//! avoids waking a CPU core every millisecond while a driver is under load.

use std::time::{Duration, Instant};
use windows::Win32::Media::MediaFoundation::{
    IMFMediaEventGenerator, MF_EVENT_FLAG_NO_WAIT, MF_E_NO_EVENTS_AVAILABLE,
};

pub(super) unsafe fn wait_for(
    events: &IMFMediaEventGenerator,
    expected: u32,
    component: &str,
) -> Result<(), String> {
    let started = Instant::now();
    let mut empty_polls = 0u32;
    loop {
        let event = match unsafe { events.GetEvent(MF_EVENT_FLAG_NO_WAIT) } {
            Ok(event) => event,
            Err(error) if error.code() == MF_E_NO_EVENTS_AVAILABLE => {
                let elapsed = started.elapsed();
                if elapsed >= Duration::from_millis(500) {
                    return Err(format!("{component} de hardware não respondeu em 500 ms"));
                }
                empty_polls = empty_polls.saturating_add(1);
                if empty_polls <= 3 {
                    std::thread::yield_now();
                } else {
                    let delay = if elapsed < Duration::from_millis(15) {
                        1
                    } else if elapsed < Duration::from_millis(75) {
                        2
                    } else {
                        5
                    };
                    std::thread::sleep(Duration::from_millis(delay));
                }
                continue;
            }
            Err(error) => return Err(format!("Evento do {component}: {error}")),
        };
        let status = unsafe { event.GetStatus() }.map_err(|error| error.to_string())?;
        status
            .ok()
            .map_err(|error| format!("Falha assíncrona do {component}: {error}"))?;
        if unsafe { event.GetType() }.map_err(|error| error.to_string())? == expected {
            return Ok(());
        }
    }
}
