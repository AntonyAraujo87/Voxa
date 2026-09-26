//! SPAKE2 P-256 authentication for a pair of computers.
//!
//! The signaling server only relays the public shares and confirmation MACs.
//! The password-derived room secret and the resulting binding key never leave
//! either computer. Every negotiation is single-use and randomized.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use pakery_core::{crypto::CpaceGroup, SharedSecret};
use pakery_crypto::{P256Group, Spake2P256};
use pakery_spake2::{PartyA, PartyAState, PartyB, PartyBState, Spake2Output};
use serde::Serialize;
use sha2::{Digest, Sha256, Sha512};
use std::collections::HashMap;

use super::StreamRole;

const HOST_ID: &[u8] = b"voxa-host-v1";
const VIEWER_ID: &[u8] = b"voxa-viewer-v1";
const PROTOCOL: &str = "spake2-p256-rfc9382-v1";
const P256_SHARE_BYTES: usize = 65;
const CONFIRMATION_BYTES: usize = 32;

enum PendingState {
    Host(PartyAState<Spake2P256>),
    Viewer(PartyBState<Spake2P256>),
}

#[derive(Default)]
pub(super) struct PakeManager {
    pending: HashMap<String, PendingState>,
    confirmations: HashMap<String, Spake2Output>,
    authenticated: HashMap<String, SharedSecret>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PakeStart {
    pub protocol: &'static str,
    pub share: String,
}

impl PakeManager {
    pub fn begin(
        &mut self,
        peer_id: &str,
        role: StreamRole,
        room: &str,
        room_secret: &str,
    ) -> Result<PakeStart, String> {
        validate(peer_id, room, room_secret)?;
        self.remove(peer_id);
        let wide: [u8; 64] = Sha512::digest(room_secret.as_bytes()).into();
        let scalar = P256Group::scalar_from_wide_bytes(&wide)
            .map_err(|_| "Não foi possível preparar a senha SPAKE2")?;
        let mut rng = rand_core::UnwrapErr(getrandom::SysRng);
        let aad = room.as_bytes();
        let (share, state) = match role {
            StreamRole::Host => {
                let (share, state) =
                    PartyA::<Spake2P256>::start(&scalar, HOST_ID, VIEWER_ID, aad, &mut rng)
                        .map_err(|_| "Não foi possível iniciar o SPAKE2")?;
                (share, PendingState::Host(state))
            }
            StreamRole::Viewer => {
                let (share, state) =
                    PartyB::<Spake2P256>::start(&scalar, HOST_ID, VIEWER_ID, aad, &mut rng)
                        .map_err(|_| "Não foi possível iniciar o SPAKE2")?;
                (share, PendingState::Viewer(state))
            }
        };
        self.pending.insert(peer_id.to_owned(), state);
        Ok(PakeStart {
            protocol: PROTOCOL,
            share: URL_SAFE_NO_PAD.encode(share),
        })
    }

    pub fn finish(&mut self, peer_id: &str, remote_share: &str) -> Result<String, String> {
        let remote = decode(remote_share, P256_SHARE_BYTES, "Parâmetro SPAKE2 inválido")?;
        let state = self
            .pending
            .remove(peer_id)
            .ok_or("Negociação SPAKE2 ausente ou expirada")?;
        let output = match state {
            PendingState::Host(state) => state.finish(&remote),
            PendingState::Viewer(state) => state.finish(&remote),
        }
        .map_err(|_| "A mensagem SPAKE2 do computador remoto é inválida")?;
        let confirmation = URL_SAFE_NO_PAD.encode(&output.confirmation_mac);
        self.confirmations.insert(peer_id.to_owned(), output);
        Ok(confirmation)
    }

    pub fn confirm(&mut self, peer_id: &str, remote_mac: &str) -> Result<(), String> {
        let remote = decode(
            remote_mac,
            CONFIRMATION_BYTES,
            "Confirmação SPAKE2 inválida",
        )?;
        let output = self
            .confirmations
            .remove(peer_id)
            .ok_or("Confirmação SPAKE2 inesperada")?;
        output
            .verify_peer_confirmation(&remote)
            .map_err(|_| "Senha da sala incorreta")?;
        let session_key = output.into_session_key();
        let mut digest = Sha256::new();
        digest.update(b"voxa-pake-media-binding-v1\0");
        digest.update(session_key.as_bytes());
        self.authenticated.insert(
            peer_id.to_owned(),
            SharedSecret::new(digest.finalize().to_vec()),
        );
        Ok(())
    }

    pub fn binding_key(&self, peer_id: &str) -> Option<[u8; 32]> {
        self.authenticated.get(peer_id)?.as_bytes().try_into().ok()
    }

    pub fn remove(&mut self, peer_id: &str) {
        self.pending.remove(peer_id);
        self.confirmations.remove(peer_id);
        self.authenticated.remove(peer_id);
    }
}

fn validate(peer_id: &str, room: &str, secret: &str) -> Result<(), String> {
    if peer_id.is_empty() || peer_id.len() > 128 {
        return Err("Identidade remota inválida".into());
    }
    if room.is_empty()
        || room.len() > 64
        || !room
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err("Código da sala inválido".into());
    }
    if secret.len() != 64 || !secret.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Segredo local da sala inválido".into());
    }
    Ok(())
}

fn decode(value: &str, expected_len: usize, message: &str) -> Result<Vec<u8>, String> {
    if value.len() > 256 {
        return Err(message.into());
    }
    let bytes = URL_SAFE_NO_PAD
        .decode(value)
        .map_err(|_| message.to_owned())?;
    (bytes.len() == expected_len && URL_SAFE_NO_PAD.encode(&bytes) == value)
        .then_some(bytes)
        .ok_or_else(|| message.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn exchange(secret_a: &str, secret_b: &str) -> (Result<(), String>, Result<(), String>) {
        let mut host = PakeManager::default();
        let mut viewer = PakeManager::default();
        let a = host
            .begin("viewer", StreamRole::Host, "room", secret_a)
            .unwrap();
        let b = viewer
            .begin("host", StreamRole::Viewer, "room", secret_b)
            .unwrap();
        let confirm_a = host.finish("viewer", &b.share).unwrap();
        let confirm_b = viewer.finish("host", &a.share).unwrap();
        let a_result = host.confirm("viewer", &confirm_b);
        let b_result = viewer.confirm("host", &confirm_a);
        if a_result.is_ok() && b_result.is_ok() {
            assert_eq!(host.binding_key("viewer"), viewer.binding_key("host"));
        }
        (a_result, b_result)
    }

    #[test]
    fn same_password_authenticates_and_derives_the_same_binding() {
        let secret = "a".repeat(64);
        let (host, viewer) = exchange(&secret, &secret);
        assert!(host.is_ok());
        assert!(viewer.is_ok());
    }

    #[test]
    fn wire_values_use_the_expected_p256_and_sha256_sizes() {
        let mut manager = PakeManager::default();
        let start = manager
            .begin("viewer", StreamRole::Host, "room", &"a".repeat(64))
            .unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.decode(start.share).unwrap().len(),
            P256_SHARE_BYTES
        );

        let mut viewer = PakeManager::default();
        let viewer_start = viewer
            .begin("host", StreamRole::Viewer, "room", &"a".repeat(64))
            .unwrap();
        let confirmation = manager.finish("viewer", &viewer_start.share).unwrap();
        assert_eq!(
            URL_SAFE_NO_PAD.decode(confirmation).unwrap().len(),
            CONFIRMATION_BYTES
        );
    }

    #[test]
    fn different_passwords_fail_explicit_confirmation() {
        let (host, viewer) = exchange(&"a".repeat(64), &"b".repeat(64));
        assert!(host.is_err());
        assert!(viewer.is_err());
    }
}
