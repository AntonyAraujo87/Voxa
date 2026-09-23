use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use tokio::{
    net::{lookup_host, UdpSocket},
    time::{timeout_at, Duration, Instant},
};

const MAGIC: u32 = 0x2112_A442;
const ATTEMPT_TIMEOUT: Duration = Duration::from_millis(900);

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
    let mut last_error = "STUN expirou".to_string();
    for _ in 0..2 {
        let mut transaction = [0u8; 12];
        getrandom::fill(&mut transaction).map_err(|e| format!("Entropia indisponível: {e}"))?;
        let mut request = [0u8; 20];
        request[..2].copy_from_slice(&1u16.to_be_bytes());
        request[4..8].copy_from_slice(&MAGIC.to_be_bytes());
        request[8..].copy_from_slice(&transaction);
        socket.send_to(&request, target).await.map_err(|e| e.to_string())?;
        let deadline = Instant::now() + ATTEMPT_TIMEOUT;
        let mut response = [0u8; 1024];
        loop {
            let Ok(received) = timeout_at(deadline, socket.recv_from(&mut response)).await else {
                break;
            };
            let (len, _) = received.map_err(|e| e.to_string())?;
            match parse(&response[..len], transaction) {
                Ok(endpoint) => return Ok(endpoint),
                Err(error) => last_error = error,
            }
        }
    }
    Err(last_error)
}

pub async fn discover_any(socket: &UdpSocket, servers: &[&str]) -> Result<SocketAddr, String> {
    if servers.is_empty() {
        return Err("Nenhum servidor STUN configurado".into());
    }
    let mut failures = Vec::with_capacity(servers.len());
    for server in servers {
        match discover(socket, server).await {
            Ok(endpoint) => return Ok(endpoint),
            Err(error) => failures.push(format!("{server}: {error}")),
        }
    }
    Err(format!("Todos os servidores STUN falharam ({})", failures.join("; ")))
}

fn parse(data: &[u8], transaction: [u8; 12]) -> Result<SocketAddr, String> {
    if data.len() < 20
        || data[..2] != [0x01, 0x01]
        || data[4..8] != MAGIC.to_be_bytes()
        || data[8..20] != transaction
    {
        return Err("Resposta STUN inválida".into());
    }
    let declared = u16::from_be_bytes([data[2], data[3]]) as usize;
    if declared % 4 != 0 || 20 + declared > data.len() {
        return Err("Tamanho da resposta STUN inválido".into());
    }
    let end = 20 + declared;
    let mut offset = 20;
    while offset + 4 <= end {
        let kind = u16::from_be_bytes([data[offset], data[offset + 1]]);
        let len = u16::from_be_bytes([data[offset + 2], data[offset + 3]]) as usize;
        let start = offset + 4;
        if start + len > end {
            break;
        }
        if kind == 0x0020 && len >= 8 && data[start + 1] == 0x01 {
            let port = u16::from_be_bytes([data[start + 2], data[start + 3]])
                ^ (MAGIC >> 16) as u16;
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
        let mut data = vec![0x01, 0x01, 0, 12];
        data.extend_from_slice(&MAGIC.to_be_bytes());
        data.extend_from_slice(&tx);
        data.extend_from_slice(&[0, 0x20, 0, 8, 0, 1]);
        data.extend_from_slice(&port.to_be_bytes());
        for index in 0..4 {
            data.push(ip[index] ^ magic[index]);
        }
        assert_eq!(parse(&data, tx).unwrap(), "192.168.1.9:54321".parse().unwrap());
    }

    #[test]
    fn ignores_attributes_past_declared_message_length() {
        let tx = [7u8; 12];
        let magic = MAGIC.to_be_bytes();
        let port = 54321u16 ^ (MAGIC >> 16) as u16;
        let ip = [203u8, 0, 113, 9];
        let mut data = vec![0x01, 0x01, 0, 0];
        data.extend_from_slice(&MAGIC.to_be_bytes());
        data.extend_from_slice(&tx);
        data.extend_from_slice(&[0, 0x20, 0, 8, 0, 1]);
        data.extend_from_slice(&port.to_be_bytes());
        for index in 0..4 {
            data.push(ip[index] ^ magic[index]);
        }
        assert!(parse(&data, tx).is_err());
    }

    #[tokio::test]
    async fn refuses_empty_fallback_list() {
        let socket = UdpSocket::bind("127.0.0.1:0").await.unwrap();
        assert!(discover_any(&socket, &[]).await.unwrap_err().contains("Nenhum"));
    }
}
