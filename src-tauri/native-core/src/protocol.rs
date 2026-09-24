use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use chacha20poly1305::{
    aead::{Aead, Payload},
    ChaCha20Poly1305, KeyInit, Nonce,
};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

// Leaves 22 bytes for the optional authenticated blind-relay envelope while staying under
// the conservative 1200-byte Internet path MTU.
pub const MAX_DATAGRAM: usize = 1178;
pub const HEADER_LEN: usize = 42;
pub const TAG_LEN: usize = 16;
pub const MAX_PAYLOAD: usize = MAX_DATAGRAM - HEADER_LEN - TAG_LEN;
pub const FEC_HEADER_LEN: usize = 2;
pub const FEC_DATA_PAYLOAD: usize = MAX_PAYLOAD - FEC_HEADER_LEN;
pub const FEC_GROUP_SIZE: usize = 8;
pub const MAX_FRAGMENTS: usize = 4096;
pub const MAX_ENCODED_FRAME: usize = MAX_PAYLOAD * MAX_FRAGMENTS;
const MAGIC: &[u8; 4] = b"VOXA";
const VERSION: u8 = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Kind {
    Hello = 1,
    HelloAck = 2,
    Video = 3,
    Ping = 4,
    Pong = 5,
    Feedback = 6,
    Keyframe = 7,
    Input = 8,
    Config = 9,
    VideoFec = 10,
}

impl TryFrom<u8> for Kind {
    type Error = String;
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::Hello),
            2 => Ok(Self::HelloAck),
            3 => Ok(Self::Video),
            4 => Ok(Self::Ping),
            5 => Ok(Self::Pong),
            6 => Ok(Self::Feedback),
            7 => Ok(Self::Keyframe),
            8 => Ok(Self::Input),
            9 => Ok(Self::Config),
            10 => Ok(Self::VideoFec),
            _ => Err("Tipo de pacote desconhecido".into()),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum VideoCodec {
    H264 = 1,
    H265 = 2,
    Av1 = 3,
}

impl TryFrom<u8> for VideoCodec {
    type Error = String;

    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(Self::H264),
            2 => Ok(Self::H265),
            3 => Ok(Self::Av1),
            _ => Err("Codec de vídeo desconhecido".into()),
        }
    }
}

impl VideoCodec {
    pub const ALL: [Self; 3] = [Self::Av1, Self::H265, Self::H264];

    pub fn name(self) -> &'static str {
        match self {
            Self::H264 => "h264",
            Self::H265 => "h265",
            Self::Av1 => "av1",
        }
    }

    pub fn bit(self) -> u8 {
        1 << (self as u8 - 1)
    }

    pub fn mask(codecs: impl IntoIterator<Item = Self>) -> u8 {
        codecs.into_iter().fold(0, |mask, codec| mask | codec.bit())
    }

    pub fn best_common(local: u8, remote: u8) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|codec| local & remote & codec.bit() != 0)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamConfig {
    pub codec: VideoCodec,
    pub width: u32,
    pub height: u32,
    pub fps: u16,
}

impl StreamConfig {
    const WIRE_LEN: usize = 12;

    pub fn encode(self) -> Result<[u8; Self::WIRE_LEN], String> {
        if self.width == 0
            || self.height == 0
            || !self.width.is_multiple_of(2)
            || !self.height.is_multiple_of(2)
            || self.width > 16_384
            || self.height > 16_384
            || self.fps == 0
            || self.fps > 240
        {
            return Err("Configuração de vídeo fora dos limites".into());
        }
        let mut bytes = [0u8; Self::WIRE_LEN];
        bytes[0] = self.codec as u8;
        bytes[2..6].copy_from_slice(&self.width.to_be_bytes());
        bytes[6..10].copy_from_slice(&self.height.to_be_bytes());
        bytes[10..12].copy_from_slice(&self.fps.to_be_bytes());
        Ok(bytes)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self, String> {
        if bytes.len() != Self::WIRE_LEN || bytes[1] != 0 {
            return Err("Configuração de stream incompatível".into());
        }
        let config = Self {
            codec: VideoCodec::try_from(bytes[0])?,
            width: u32::from_be_bytes(bytes[2..6].try_into().unwrap()),
            height: u32::from_be_bytes(bytes[6..10].try_into().unwrap()),
            fps: u16::from_be_bytes(bytes[10..12].try_into().unwrap()),
        };
        config.encode()?;
        Ok(config)
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Meta {
    pub stream_id: u32,
    pub sequence: u64,
    pub frame_id: u64,
    pub fragment_index: u16,
    pub fragment_count: u16,
    pub timestamp_us: u64,
    pub keyframe: bool,
}

#[derive(Debug)]
pub struct Packet {
    pub kind: Kind,
    pub meta: Meta,
    pub payload: Vec<u8>,
}

pub fn fragment_count(frame_len: usize) -> Result<u16, String> {
    let count = frame_len.saturating_add(MAX_PAYLOAD - 1) / MAX_PAYLOAD;
    if count == 0 || count > MAX_FRAGMENTS || frame_len > MAX_ENCODED_FRAME {
        return Err("Frame codificado fora do limite do protocolo".into());
    }
    Ok(count as u16)
}

pub fn fragments(frame: &[u8]) -> Result<impl Iterator<Item = &[u8]>, String> {
    fragment_count(frame.len())?;
    Ok(frame.chunks(MAX_PAYLOAD))
}

pub struct EphemeralKey {
    private: StaticSecret,
    public: [u8; 32],
}

impl EphemeralKey {
    pub fn generate() -> Result<Self, String> {
        let mut secret = [0u8; 32];
        getrandom::fill(&mut secret).map_err(|_| "Não foi possível gerar a chave X25519")?;
        let private = StaticSecret::from(secret);
        let public = PublicKey::from(&private).to_bytes();
        Ok(Self { private, public })
    }

    pub fn public_base64(&self) -> String {
        URL_SAFE_NO_PAD.encode(self.public)
    }

    pub fn agree(&self, peer_public: &str) -> Result<([u8; 32], String), String> {
        let raw = URL_SAFE_NO_PAD
            .decode(peer_public.trim())
            .map_err(|_| "Chave pública X25519 inválida")?;
        let peer: [u8; 32] = raw.try_into().map_err(|_| "A chave X25519 deve ter 256 bits")?;
        if peer == [0; 32] {
            return Err("Chave X25519 de baixa ordem recusada".into());
        }
        let shared = self.private.diffie_hellman(&PublicKey::from(peer)).to_bytes();
        if shared == [0; 32] {
            return Err("Chave X25519 de baixa ordem recusada".into());
        }
        let mut digest = Sha256::new();
        digest.update(b"voxa-x25519-media-v1\0");
        digest.update(shared);
        let key: [u8; 32] = digest.finalize().into();
        let verification = verification_code(&self.public, &peer, &key);
        Ok((key, verification))
    }
}

fn verification_code(own: &[u8; 32], peer: &[u8; 32], key: &[u8; 32]) -> String {
    let (first, second) = if own <= peer { (own, peer) } else { (peer, own) };
    let mut digest = Sha256::new();
    digest.update(b"voxa-verify-v1\0");
    digest.update(first);
    digest.update(second);
    digest.update(key);
    let bytes = digest.finalize();
    let number = u32::from_be_bytes(bytes[..4].try_into().unwrap()) % 1_000_000;
    format!("{number:06}")
}

pub fn directional_keys(base: &[u8; 32]) -> ([u8; 32], [u8; 32]) {
    fn derive(base: &[u8; 32], label: &[u8]) -> [u8; 32] {
        let mut digest = Sha256::new();
        digest.update(b"voxa-native-v1\0");
        digest.update(label);
        digest.update(base);
        digest.finalize().into()
    }
    (
        derive(base, b"host-to-viewer"),
        derive(base, b"viewer-to-host"),
    )
}

#[derive(Default)]
pub struct ReplayGuard {
    stream_id: Option<u32>,
    highest: u64,
    seen: u128,
}

impl ReplayGuard {
    pub fn accept(&mut self, stream_id: u32, sequence: u64) -> bool {
        if self.stream_id.is_none() {
            self.stream_id = Some(stream_id);
            self.highest = sequence;
            self.seen = 1;
            return true;
        }
        if self.stream_id != Some(stream_id) {
            return false;
        }
        if sequence > self.highest {
            let shift = (sequence - self.highest).min(128) as u32;
            self.seen = if shift == 128 {
                1
            } else {
                (self.seen << shift) | 1
            };
            self.highest = sequence;
            return true;
        }
        let age = self.highest - sequence;
        if age >= 128 {
            return false;
        }
        let bit = 1u128 << age;
        if self.seen & bit != 0 {
            return false;
        }
        self.seen |= bit;
        true
    }
}

pub fn seal(key: &[u8; 32], kind: Kind, meta: Meta, payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.len() > MAX_PAYLOAD {
        return Err("Fragmento maior que o MTU seguro".into());
    }
    let cipher_len = payload.len() + TAG_LEN;
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(MAGIC);
    header.extend_from_slice(&[VERSION, kind as u8, u8::from(meta.keyframe), 0]);
    header.extend_from_slice(&meta.stream_id.to_be_bytes());
    header.extend_from_slice(&meta.sequence.to_be_bytes());
    header.extend_from_slice(&meta.frame_id.to_be_bytes());
    header.extend_from_slice(&meta.fragment_index.to_be_bytes());
    header.extend_from_slice(&meta.fragment_count.to_be_bytes());
    header.extend_from_slice(&meta.timestamp_us.to_be_bytes());
    header.extend_from_slice(&(cipher_len as u16).to_be_bytes());
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| "Chave inválida")?;
    let encrypted = cipher
        .encrypt(
            Nonce::from_slice(&nonce(meta)),
            Payload {
                msg: payload,
                aad: &header,
            },
        )
        .map_err(|_| "Falha ao cifrar pacote")?;
    header.extend_from_slice(&encrypted);
    Ok(header)
}

pub fn open(key: &[u8; 32], datagram: &[u8]) -> Result<Packet, String> {
    if datagram.len() < HEADER_LEN + TAG_LEN || &datagram[..4] != MAGIC || datagram[4] != VERSION {
        return Err("Cabeçalho UDP inválido".into());
    }
    let kind = Kind::try_from(datagram[5])?;
    let meta = Meta {
        keyframe: datagram[6] & 1 != 0,
        stream_id: u32::from_be_bytes(datagram[8..12].try_into().unwrap()),
        sequence: u64::from_be_bytes(datagram[12..20].try_into().unwrap()),
        frame_id: u64::from_be_bytes(datagram[20..28].try_into().unwrap()),
        fragment_index: u16::from_be_bytes(datagram[28..30].try_into().unwrap()),
        fragment_count: u16::from_be_bytes(datagram[30..32].try_into().unwrap()),
        timestamp_us: u64::from_be_bytes(datagram[32..40].try_into().unwrap()),
    };
    let payload_len = u16::from_be_bytes(datagram[40..42].try_into().unwrap()) as usize;
    if payload_len != datagram.len() - HEADER_LEN {
        return Err("Tamanho UDP inconsistente".into());
    }
    let cipher = ChaCha20Poly1305::new_from_slice(key).map_err(|_| "Chave inválida")?;
    let payload = cipher
        .decrypt(
            Nonce::from_slice(&nonce(meta)),
            Payload {
                msg: &datagram[HEADER_LEN..],
                aad: &datagram[..HEADER_LEN],
            },
        )
        .map_err(|_| "Pacote UDP não autenticado")?;
    Ok(Packet {
        kind,
        meta,
        payload,
    })
}

fn nonce(meta: Meta) -> [u8; 12] {
    let mut nonce = [0u8; 12];
    nonce[..4].copy_from_slice(&meta.stream_id.to_be_bytes());
    nonce[4..].copy_from_slice(&meta.sequence.to_be_bytes());
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn x25519_peers_derive_same_key_and_verification_code() {
        let first = EphemeralKey::generate().unwrap();
        let second = EphemeralKey::generate().unwrap();
        let first_public = first.public_base64();
        let second_public = second.public_base64();
        let first_result = first.agree(&second_public).unwrap();
        let second_result = second.agree(&first_public).unwrap();
        assert_eq!(first_result, second_result);
        assert_eq!(first_result.1.len(), 6);
    }
    #[test]
    fn host_key_derives_isolated_keys_for_multiple_viewers() {
        let host = EphemeralKey::generate().unwrap();
        let first = EphemeralKey::generate().unwrap();
        let second = EphemeralKey::generate().unwrap();
        let first_key = host.agree(&first.public_base64()).unwrap().0;
        let second_key = host.agree(&second.public_base64()).unwrap().0;
        assert_ne!(first_key, second_key);
        assert_eq!(first_key, first.agree(&host.public_base64()).unwrap().0);
        assert_eq!(second_key, second.agree(&host.public_base64()).unwrap().0);
    }
    #[test]
    fn encrypted_packet_round_trip() {
        let key = [7u8; 32];
        let meta = Meta {
            stream_id: 4,
            sequence: 9,
            frame_id: 12,
            fragment_count: 1,
            keyframe: true,
            ..Default::default()
        };
        let encoded = seal(&key, Kind::Video, meta, b"frame").unwrap();
        assert!(!encoded.windows(5).any(|bytes| bytes == b"frame"));
        let decoded = open(&key, &encoded).unwrap();
        assert_eq!(decoded.kind, Kind::Video);
        assert_eq!(decoded.payload, b"frame");
        assert!(decoded.meta.keyframe);
    }
    #[test]
    fn tampering_is_rejected() {
        let key = [1u8; 32];
        let mut encoded = seal(
            &key,
            Kind::Ping,
            Meta {
                sequence: 1,
                ..Default::default()
            },
            b"x",
        )
        .unwrap();
        *encoded.last_mut().unwrap() ^= 1;
        assert!(open(&key, &encoded).is_err());
    }
    #[test]
    fn rejects_replay_and_accepts_reordering_once() {
        let mut guard = ReplayGuard::default();
        assert!(guard.accept(9, 10));
        assert!(guard.accept(9, 12));
        assert!(guard.accept(9, 11));
        assert!(!guard.accept(9, 11));
        assert!(!guard.accept(9, 10));
        assert!(!guard.accept(10, 1));
    }
    #[test]
    fn directions_never_share_a_key() {
        let (a, b) = directional_keys(&[4; 32]);
        assert_ne!(a, b);
    }
    #[test]
    fn fragments_at_the_encrypted_mtu_boundary() {
        let frame = vec![9u8; MAX_PAYLOAD * 2 + 1];
        let parts = fragments(&frame)
            .unwrap()
            .map(<[u8]>::len)
            .collect::<Vec<_>>();
        assert_eq!(parts, [MAX_PAYLOAD, MAX_PAYLOAD, 1]);
        assert_eq!(fragment_count(frame.len()).unwrap(), 3);
        assert!(fragment_count(0).is_err());
    }

    #[test]
    fn stream_config_round_trip_and_limits() {
        let config = StreamConfig {
            codec: VideoCodec::H265,
            width: 2560,
            height: 1440,
            fps: 120,
        };
        assert_eq!(StreamConfig::decode(&config.encode().unwrap()).unwrap(), config);
        assert!(StreamConfig::decode(&[1, 0]).is_err());
        assert!(StreamConfig {
            codec: VideoCodec::H264,
            width: 1921,
            height: 1080,
            fps: 60,
        }
        .encode()
        .is_err());
    }

    #[test]
    fn codec_negotiation_prefers_efficiency_and_keeps_h264_fallback() {
        let h264_h265 = VideoCodec::mask([VideoCodec::H264, VideoCodec::H265]);
        let all = VideoCodec::mask(VideoCodec::ALL);
        assert_eq!(VideoCodec::best_common(h264_h265, all), Some(VideoCodec::H265));
        assert_eq!(VideoCodec::best_common(VideoCodec::H264.bit(), all), Some(VideoCodec::H264));
        assert_eq!(VideoCodec::best_common(VideoCodec::Av1.bit(), VideoCodec::H264.bit()), None);
    }
}
