use std::{
    net::SocketAddr,
    sync::{
        atomic::{AtomicU32, Ordering},
        Arc,
    },
};
use tokio::net::UdpSocket;

const RELAY_MAGIC: &[u8; 4] = b"VRLY";
const RELAY_HEADER: usize = 22;

pub(super) struct Route {
    pub(super) socket: Arc<UdpSocket>,
    pub(super) direct: SocketAddr,
    pub(super) relay: Option<(SocketAddr, u64, u64, u8)>,
    pub(super) selected: AtomicU32,
}

impl Route {
    pub(super) async fn send(&self, bytes: &[u8]) -> Result<(), String> {
        match self.selected.load(Ordering::Acquire) {
            1 => self
                .socket
                .send_to(bytes, self.direct)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            2 => self.send_relay(bytes).await,
            _ => {
                let direct = self
                    .socket
                    .send_to(bytes, self.direct)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                let relayed = if self.relay.is_some() {
                    self.send_relay(bytes).await
                } else {
                    Ok(())
                };
                direct.or(relayed)
            }
        }
    }
    async fn send_relay(&self, bytes: &[u8]) -> Result<(), String> {
        let (endpoint, session, auth, role) = self.relay.ok_or("Relay UDP indisponível")?;
        let mut packet = Vec::with_capacity(RELAY_HEADER + bytes.len());
        packet.extend_from_slice(RELAY_MAGIC);
        packet.extend_from_slice(&[1, role]);
        packet.extend_from_slice(&session.to_be_bytes());
        packet.extend_from_slice(&auth.to_be_bytes());
        packet.extend_from_slice(bytes);
        self.socket
            .send_to(&packet, endpoint)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    pub(super) fn select(&self, source: SocketAddr) -> u32 {
        let current = self.selected.load(Ordering::Acquire);
        if current != 0 {
            return current;
        }
        let route = if self.relay.is_some_and(|relay| relay.0 == source) {
            2
        } else if source == self.direct {
            1
        } else {
            0
        };
        if route != 0 {
            let _ = self
                .selected
                .compare_exchange(0, route, Ordering::AcqRel, Ordering::Acquire);
        }
        self.selected.load(Ordering::Acquire)
    }
    pub(super) fn reset(&self) {
        self.selected.store(0, Ordering::Release);
    }
}
