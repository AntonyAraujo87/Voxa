use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::{
    net::{lookup_host, UdpSocket},
    time::{timeout, Duration},
};
const MAGIC: u32 = 0x2112_A442;

pub fn local_endpoint(port: u16) -> Result<SocketAddr, String> {
    let probe = std::net::UdpSocket::bind("0.0.0.0:0").map_err(|e| e.to_string())?;
    probe.connect("8.8.8.8:80").map_err(|e| e.to_string())?;
    let ip = probe.local_addr().map_err(|e| e.to_string())?.ip();
    Ok(SocketAddr::new(ip, port))
}

pub async fn discover(socket: &UdpSocket, server: &str) -> Result<SocketAddr, String> {
    let target = lookup_host(server)
        .await
        .map_err(|e| e.to_string())?
        .find(|addr| addr.is_ipv4())
        .ok_or("STUN sem IPv4")?;
    let mut transaction = [0u8; 12];
    getrandom::fill(&mut transaction).map_err(|e| format!("Entropia indisponível: {e}"))?;
    let mut request = [0u8; 20];
    request[..2].copy_from_slice(&1u16.to_be_bytes());
    request[4..8].copy_from_slice(&MAGIC.to_be_bytes());
    request[8..].copy_from_slice(&transaction);
    socket
        .send_to(&request, target)
        .await
        .map_err(|e| e.to_string())?;
    let mut response = [0u8; 1024];
    let (len, source) = timeout(Duration::from_millis(1400), socket.recv_from(&mut response))
        .await
        .map_err(|_| "STUN expirou")?
        .map_err(|e| e.to_string())?;
    if source != target {
        return Err("Resposta STUN recebida de origem inesperada".into());
    }
    parse(&response[..len], transaction)
}

fn parse(data: &[u8], transaction: [u8; 12]) -> Result<SocketAddr, String> {
    if data.len() < 20
        || data[..2] != [0x01, 0x01]
        || data[4..8] != MAGIC.to_be_bytes()
        || data[8..20] != transaction
    {
        return Err("Resposta STUN inválida".into());
    }
    let mut offset = 20;
    while offset + 4 <= data.len() {
        let kind = u16::from_be_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let start = offset + 4;
        if start + len > data.len() {
            break;
        }
        if kind == 0x0020 && len >= 8 && data[start + 1] == 0x01 {
            let port =
                u16::from_be_bytes([data[start + 2], data[start + 3]]) ^ (MAGIC >> 16) as u16;
            let magic = MAGIC.to_be_bytes();
            let ip = Ipv4Addr::new(
                data[start + 4] ^ magic[0],
                data[start + 5] ^ magic[1],
                data[start + 6] ^ magic[2],
                data[start + 7] ^ magic[3],
            );
            return Ok(SocketAddr::new(IpAddr::V4(ip), port));
        }
        offset = start + ((len + 3) & !3);
    }
    Err("STUN não retornou XOR-MAPPED-ADDRESS".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_xor_mapped_address() {
        let tx = [3u8; 12];
        let magic = MAGIC.to_be_bytes();
        let port = 54321u16 ^ (MAGIC >> 16) as u16;
        let ip = [192u8, 168, 1, 9];
        let mut d = vec![0x01, 0x01, 0, 12];
        d.extend_from_slice(&MAGIC.to_be_bytes());
        d.extend_from_slice(&tx);
        d.extend_from_slice(&[0, 0x20, 0, 8, 0, 1]);
        d.extend_from_slice(&port.to_be_bytes());
        for i in 0..4 {
            d.push(ip[i] ^ magic[i]);
        }
        assert_eq!(parse(&d, tx).unwrap(), "192.168.1.9:54321".parse().unwrap());
    }
}
