//! Remote keyboard and mouse with explicit host-side consent.
//!
//! The viewer samples only while the native stream window owns focus. The host
//! still authenticates every datagram and discards input unless the local user
//! has visibly authorized that exact peer.

use super::{transport::TransportHandle, Inner};
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use windows::Win32::{
    Foundation::{HWND, POINT},
    UI::{
        Input::KeyboardAndMouse::{
            keybd_event, mouse_event, GetAsyncKeyState, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP,
            MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP,
            MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP,
        },
        WindowsAndMessaging::{GetCursorPos, GetForegroundWindow},
    },
};

const VERSION: u8 = 1;
const MOUSE_MOVE: u8 = 1;
const MOUSE_BUTTON: u8 = 2;
const KEYBOARD: u8 = 3;
const WIRE_LEN: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct RemoteInput {
    kind: u8,
    code: u8,
    down: bool,
    dx: i16,
    dy: i16,
}

impl RemoteInput {
    fn encode(self) -> [u8; WIRE_LEN] {
        let mut bytes = [0u8; WIRE_LEN];
        bytes[0] = VERSION;
        bytes[1] = self.kind;
        bytes[2] = self.code;
        bytes[3] = u8::from(self.down);
        bytes[4..6].copy_from_slice(&self.dx.to_be_bytes());
        bytes[6..8].copy_from_slice(&self.dy.to_be_bytes());
        bytes
    }

    fn decode(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != WIRE_LEN
            || bytes[0] != VERSION
            || !(1..=3).contains(&bytes[1])
            || bytes[3] > 1
        {
            return None;
        }
        Some(Self {
            kind: bytes[1],
            code: bytes[2],
            down: bytes[3] != 0,
            dx: i16::from_be_bytes([bytes[4], bytes[5]]),
            dy: i16::from_be_bytes([bytes[6], bytes[7]]),
        })
    }
}

pub(super) fn spawn_capture(
    hwnd: isize,
    transport: TransportHandle,
    state: Arc<Mutex<Inner>>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut previous_keys = [false; 256];
        let mut previous_buttons = [false; 3];
        let mut previous_cursor = None::<POINT>;
        while !transport.stopped() {
            if unsafe { GetForegroundWindow() } != HWND(hwnd as *mut _) {
                for (vk, down) in previous_keys.iter_mut().enumerate() {
                    if *down {
                        transport.queue_input(
                            RemoteInput {
                                kind: KEYBOARD,
                                code: vk as u8,
                                down: false,
                                dx: 0,
                                dy: 0,
                            }
                            .encode()
                            .to_vec(),
                        );
                        *down = false;
                    }
                }
                for (index, down) in previous_buttons.iter_mut().enumerate() {
                    if *down {
                        transport.queue_input(
                            RemoteInput {
                                kind: MOUSE_BUTTON,
                                code: [1, 2, 4][index],
                                down: false,
                                dx: 0,
                                dy: 0,
                            }
                            .encode()
                            .to_vec(),
                        );
                        *down = false;
                    }
                }
                previous_cursor = None;
                thread::sleep(Duration::from_millis(20));
                continue;
            }
            let mut events = VecDeque::new();
            let mut cursor = POINT::default();
            if unsafe { GetCursorPos(&mut cursor) }.is_ok() {
                if let Some(previous) = previous_cursor {
                    let dx = (cursor.x - previous.x).clamp(i16::MIN.into(), i16::MAX.into()) as i16;
                    let dy = (cursor.y - previous.y).clamp(i16::MIN.into(), i16::MAX.into()) as i16;
                    if dx != 0 || dy != 0 {
                        events.push_back(RemoteInput {
                            kind: MOUSE_MOVE,
                            code: 0,
                            down: false,
                            dx,
                            dy,
                        });
                    }
                }
                previous_cursor = Some(cursor);
            }
            for (index, vk) in [1i32, 2, 4].into_iter().enumerate() {
                let down = unsafe { GetAsyncKeyState(vk) } < 0;
                if down != previous_buttons[index] {
                    events.push_back(RemoteInput {
                        kind: MOUSE_BUTTON,
                        code: vk as u8,
                        down,
                        dx: 0,
                        dy: 0,
                    });
                    previous_buttons[index] = down;
                }
            }
            for (vk, previous) in previous_keys.iter_mut().enumerate().take(255).skip(8) {
                if matches!(vk, 1 | 2 | 4) {
                    continue;
                }
                let down = unsafe { GetAsyncKeyState(vk as i32) } < 0;
                if down != *previous {
                    events.push_back(RemoteInput {
                        kind: KEYBOARD,
                        code: vk as u8,
                        down,
                        dx: 0,
                        dy: 0,
                    });
                    *previous = down;
                }
            }
            for event in events {
                transport.queue_input(event.encode().to_vec());
            }
            if let Ok(mut inner) = state.lock() {
                inner.status.last_error = None;
            }
            thread::sleep(Duration::from_millis(8));
        }
    })
}

pub(super) fn inject_if_authorized(peer_id: &str, payload: &[u8], state: &Arc<Mutex<Inner>>) {
    if !is_authorized_peer(peer_id, state) {
        return;
    }
    let Some(event) = RemoteInput::decode(payload) else {
        return;
    };
    unsafe {
        match event.kind {
            MOUSE_MOVE => mouse_event(
                MOUSEEVENTF_MOVE,
                i32::from(event.dx),
                i32::from(event.dy),
                0,
                0,
            ),
            MOUSE_BUTTON => {
                let flag = match (event.code, event.down) {
                    (1, true) => MOUSEEVENTF_LEFTDOWN,
                    (1, false) => MOUSEEVENTF_LEFTUP,
                    (2, true) => MOUSEEVENTF_RIGHTDOWN,
                    (2, false) => MOUSEEVENTF_RIGHTUP,
                    (4, true) => MOUSEEVENTF_MIDDLEDOWN,
                    (4, false) => MOUSEEVENTF_MIDDLEUP,
                    _ => return,
                };
                mouse_event(flag, 0, 0, 0, 0);
            }
            KEYBOARD => keybd_event(
                event.code,
                0,
                if event.down {
                    KEYBD_EVENT_FLAGS(0)
                } else {
                    KEYEVENTF_KEYUP
                },
                0,
            ),
            _ => {}
        }
    }
}

fn is_authorized_peer(peer_id: &str, state: &Arc<Mutex<Inner>>) -> bool {
    state
        .lock()
        .map(|inner| inner.remote_control_peers.contains(peer_id))
        .unwrap_or(false)
}

pub(super) fn release_all() {
    unsafe {
        for vk in 8u8..=254 {
            keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
        }
        mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_RIGHTUP, 0, 0, 0, 0);
        mouse_event(MOUSEEVENTF_MIDDLEUP, 0, 0, 0, 0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn input_wire_is_strict_and_round_trips() {
        let event = RemoteInput {
            kind: MOUSE_MOVE,
            code: 0,
            down: false,
            dx: -17,
            dy: 42,
        };
        assert_eq!(RemoteInput::decode(&event.encode()), Some(event));
        assert!(RemoteInput::decode(&event.encode()[..7]).is_none());
        let mut invalid = event.encode();
        invalid[0] = 9;
        assert!(RemoteInput::decode(&invalid).is_none());
    }

    #[test]
    fn consent_is_scoped_to_the_exact_peer() {
        let state = Arc::new(Mutex::new(Inner::default()));
        assert!(!is_authorized_peer("viewer-a", &state));
        state
            .lock()
            .unwrap()
            .remote_control_peers
            .insert("viewer-a".into());
        assert!(is_authorized_peer("viewer-a", &state));
        assert!(!is_authorized_peer("viewer-b", &state));
    }
}
