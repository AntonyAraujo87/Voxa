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
    pub(super) relays: Vec<(SocketAddr, u64, u64, u8)>,
    pub(super) selected: AtomicU32,
}

impl Route {
    pub(super) fn accepts(&self, source: SocketAddr) -> bool {
        let source = canonical(source);
        source == canonical(self.direct)
            || self.relays.iter().any(|relay| canonical(relay.0) == source)
    }

    pub(super) async fn send(&self, bytes: &[u8]) -> Result<(), String> {
        match self.selected.load(Ordering::Acquire) {
            1 => self
                .socket
                .send_to(bytes, self.direct)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string()),
            selected if selected >= 2 => self.send_relay(bytes, selected as usize - 2).await,
            _ => {
                let direct = self
                    .socket
                    .send_to(bytes, self.direct)
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string());
                let mut relayed = Ok(());
                for index in 0..self.relays.len() {
                    if let Err(error) = self.send_relay(bytes, index).await {
                        relayed = Err(error);
                    }
                }
                direct.or(relayed)
            }
        }
    }

    async fn send_relay(&self, bytes: &[u8], index: usize) -> Result<(), String> {
        let (endpoint, session, auth, role) = self
            .relays
            .get(index)
            .copied()
            .ok_or("Relay UDP indisponível")?;
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
        let source = canonical(source);
        let route = if source == canonical(self.direct) {
            1
        } else {
            self.relays
                .iter()
                .position(|relay| canonical(relay.0) == source)
                .map_or(0, |index| index as u32 + 2)
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

fn canonical(address: SocketAddr) -> SocketAddr {
    match address {
        SocketAddr::V6(value) => value
            .ip()
            .to_ipv4_mapped()
            .map(|ip| SocketAddr::new(ip.into(), value.port()))
            .unwrap_or(SocketAddr::V6(value)),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ipv4_mapped_sources_match_ipv4_candidates() {
        let mapped: SocketAddr = "[::ffff:203.0.113.7]:3479".parse().unwrap();
        let plain: SocketAddr = "203.0.113.7:3479".parse().unwrap();
        assert_eq!(canonical(mapped), plain);
    }

    #[tokio::test]
    async fn rejects_datagrams_from_unannounced_sources_before_decryption() {
        let socket = Arc::new(UdpSocket::bind("127.0.0.1:0").await.unwrap());
        let route = Route {
            socket,
            direct: "203.0.113.7:4000".parse().unwrap(),
            relays: vec![("198.51.100.8:3479".parse().unwrap(), 1, 2, 0)],
            selected: AtomicU32::new(0),
        };
        assert!(route.accepts("203.0.113.7:4000".parse().unwrap()));
        assert!(route.accepts("198.51.100.8:3479".parse().unwrap()));
        assert!(!route.accepts("192.0.2.9:9999".parse().unwrap()));
    }
}
