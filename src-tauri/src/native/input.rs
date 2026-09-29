//! Remote keyboard and mouse with explicit host-side consent.
//!
//! The viewer samples only while the native stream window owns focus. The host
//! still authenticates every datagram and discards input unless the local user
//! has visibly authorized that exact peer.

use super::{transport::TransportHandle, Inner};
use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use windows::Win32::{
    Foundation::{HWND, POINT},
    UI::{
        Input::KeyboardAndMouse::{
            GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBDINPUT,
            KEYBD_EVENT_FLAGS, KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, MOUSEEVENTF_LEFTDOWN,
            MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE,
            MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT, MOUSE_EVENT_FLAGS, VIRTUAL_KEY,
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

#[derive(Default)]
pub(super) struct RemoteInputState {
    keys: HashSet<u8>,
    buttons: HashSet<u8>,
}

impl RemoteInputState {
    fn record(&mut self, event: RemoteInput) {
        let target = match event.kind {
            KEYBOARD => Some(&mut self.keys),
            MOUSE_BUTTON => Some(&mut self.buttons),
            _ => None,
        };
        if let Some(target) = target {
            if event.down {
                target.insert(event.code);
            } else {
                target.remove(&event.code);
            }
        }
    }
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
        let event = Self {
            kind: bytes[1],
            code: bytes[2],
            down: bytes[3] != 0,
            dx: i16::from_be_bytes([bytes[4], bytes[5]]),
            dy: i16::from_be_bytes([bytes[6], bytes[7]]),
        };
        let valid = match event.kind {
            MOUSE_MOVE => event.code == 0 && !event.down,
            MOUSE_BUTTON => matches!(event.code, 1 | 2 | 4) && event.dx == 0 && event.dy == 0,
            KEYBOARD => event.code >= 8 && event.dx == 0 && event.dy == 0,
            _ => false,
        };
        valid.then_some(event)
    }
}

pub(super) fn coalesce_queued_motion(queue: &mut VecDeque<Vec<u8>>, payload: &[u8]) -> bool {
    let Some(current) = RemoteInput::decode(payload).filter(|event| event.kind == MOUSE_MOVE)
    else {
        return false;
    };
    let Some(previous) = queue
        .back()
        .and_then(|bytes| RemoteInput::decode(bytes))
        .filter(|event| event.kind == MOUSE_MOVE)
    else {
        return false;
    };
    let merged = RemoteInput {
        dx: previous.dx.saturating_add(current.dx),
        dy: previous.dy.saturating_add(current.dy),
        ..current
    };
    if let Some(last) = queue.back_mut() {
        *last = merged.encode().to_vec();
    }
    true
}

pub(super) fn is_queued_motion(payload: &[u8]) -> bool {
    RemoteInput::decode(payload).is_some_and(|event| event.kind == MOUSE_MOVE)
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
    let Some(event) = RemoteInput::decode(payload) else {
        return;
    };
    let Ok(mut inner) = state.lock() else {
        return;
    };
    if !inner.remote_control_peers.contains(peer_id) || !inject(event) {
        return;
    }
    // Injetar e registrar sob a mesma trava impede que uma revogacao libere
    // as teclas e este pacote as pressione novamente logo depois.
    inner
        .remote_input_states
        .entry(peer_id.to_owned())
        .or_default()
        .record(event);
}

fn inject(event: RemoteInput) -> bool {
    match event.kind {
        MOUSE_MOVE => send_mouse(MOUSEEVENTF_MOVE, i32::from(event.dx), i32::from(event.dy)),
        MOUSE_BUTTON => {
            let flag = match (event.code, event.down) {
                (1, true) => MOUSEEVENTF_LEFTDOWN,
                (1, false) => MOUSEEVENTF_LEFTUP,
                (2, true) => MOUSEEVENTF_RIGHTDOWN,
                (2, false) => MOUSEEVENTF_RIGHTUP,
                (4, true) => MOUSEEVENTF_MIDDLEDOWN,
                (4, false) => MOUSEEVENTF_MIDDLEUP,
                _ => return false,
            };
            send_mouse(flag, 0, 0)
        }
        KEYBOARD => send_keyboard(
            event.code,
            if event.down {
                KEYBD_EVENT_FLAGS(0)
            } else {
                KEYEVENTF_KEYUP
            },
        ),
        _ => false,
    }
}

fn send_keyboard(code: u8, flags: KEYBD_EVENT_FLAGS) -> bool {
    let flags = if is_extended_key(code) {
        flags | KEYEVENTF_EXTENDEDKEY
    } else {
        flags
    };
    let input = INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: VIRTUAL_KEY(u16::from(code)),
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 1 }
}

fn is_extended_key(code: u8) -> bool {
    matches!(
        code,
        // Navegacao, teclado numerico, Print Screen, Windows e modificadores
        // direitos usam o prefixo E0 no protocolo de teclado do Windows.
        0x21..=0x2e | 0x5b..=0x5d | 0x6f | 0x90 | 0xa3 | 0xa5
    )
}

fn send_mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32) -> bool {
    let input = INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                dwFlags: flags,
                ..Default::default()
            },
        },
    };
    unsafe { SendInput(&[input], std::mem::size_of::<INPUT>() as i32) == 1 }
}

#[cfg(test)]
fn is_authorized_peer(peer_id: &str, state: &Arc<Mutex<Inner>>) -> bool {
    state
        .lock()
        .map(|inner| inner.remote_control_peers.contains(peer_id))
        .unwrap_or(false)
}

pub(super) fn release_peer(inner: &mut Inner, peer_id: &str) {
    if let Some(pressed) = inner.remote_input_states.remove(peer_id) {
        release(pressed);
    }
}

pub(super) fn release_all(inner: &mut Inner) {
    let pressed = inner
        .remote_input_states
        .drain()
        .map(|(_, state)| state)
        .collect::<Vec<_>>();
    for state in pressed {
        release(state);
    }
}

fn release(pressed: RemoteInputState) {
    for vk in pressed.keys {
        let _ = send_keyboard(vk, KEYEVENTF_KEYUP);
    }
    for button in pressed.buttons {
        let flag = match button {
            1 => MOUSEEVENTF_LEFTUP,
            2 => MOUSEEVENTF_RIGHTUP,
            4 => MOUSEEVENTF_MIDDLEUP,
            _ => continue,
        };
        let _ = send_mouse(flag, 0, 0);
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
        let mut malformed_move = event.encode();
        malformed_move[2] = 1;
        assert!(RemoteInput::decode(&malformed_move).is_none());
        let invalid_key = RemoteInput {
            kind: KEYBOARD,
            code: 1,
            down: true,
            dx: 0,
            dy: 0,
        };
        assert!(RemoteInput::decode(&invalid_key.encode()).is_none());
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

    #[test]
    fn tracks_only_inputs_that_each_peer_actually_pressed() {
        let mut pressed = RemoteInputState::default();
        pressed.record(RemoteInput {
            kind: KEYBOARD,
            code: 65,
            down: true,
            dx: 0,
            dy: 0,
        });
        pressed.record(RemoteInput {
            kind: MOUSE_BUTTON,
            code: 1,
            down: true,
            dx: 0,
            dy: 0,
        });
        pressed.record(RemoteInput {
            kind: KEYBOARD,
            code: 65,
            down: false,
            dx: 0,
            dy: 0,
        });
        assert!(pressed.keys.is_empty());
        assert_eq!(pressed.buttons, HashSet::from([1]));
    }

    #[test]
    fn marks_navigation_and_right_modifiers_as_extended() {
        assert!(is_extended_key(0x25)); // seta esquerda
        assert!(is_extended_key(0xa3)); // Ctrl direito
        assert!(!is_extended_key(0x41)); // A
    }

    #[test]
    fn coalesces_mouse_motion_without_dropping_button_transitions() {
        let mut queue = VecDeque::from([RemoteInput {
            kind: MOUSE_MOVE,
            code: 0,
            down: false,
            dx: 10,
            dy: -5,
        }
        .encode()
        .to_vec()]);
        let next = RemoteInput {
            kind: MOUSE_MOVE,
            code: 0,
            down: false,
            dx: 4,
            dy: 2,
        }
        .encode();
        assert!(coalesce_queued_motion(&mut queue, &next));
        let merged = RemoteInput::decode(queue.front().unwrap()).unwrap();
        assert_eq!((merged.dx, merged.dy), (14, -3));

        let button = RemoteInput {
            kind: MOUSE_BUTTON,
            code: 1,
            down: true,
            dx: 0,
            dy: 0,
        }
        .encode();
        assert!(!coalesce_queued_motion(&mut queue, &button));
    }
}
