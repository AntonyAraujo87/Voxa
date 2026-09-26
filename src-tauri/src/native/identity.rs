//! Persistent device identity and optional trusted-peer list.
//!
//! On Windows both values live in Credential Manager, whose payload is
//! protected for the signed-in Windows account. No private key is written to
//! the Voxa configuration directory.

use voxa_native_core::protocol::EphemeralKey;

const SERVICE: &str = "Voxa Stream";
const DEVICE_ENTRY: &str = "device-x25519-v1";
const TRUST_ENTRY: &str = "trusted-peers-v1";
const MAX_TRUSTED: usize = 64;

pub(super) fn load_or_create() -> Result<EphemeralKey, String> {
    #[cfg(target_os = "windows")]
    {
        let entry = keyring::Entry::new(SERVICE, DEVICE_ENTRY)
            .map_err(|error| format!("Credencial de identidade: {error}"))?;
        match entry.get_password() {
            Ok(secret) => EphemeralKey::from_secret_base64(&secret),
            Err(keyring::Error::NoEntry) => {
                let identity = EphemeralKey::generate()?;
                entry
                    .set_password(&identity.secret_base64())
                    .map_err(|error| format!("Proteção da identidade no Windows: {error}"))?;
                Ok(identity)
            }
            // Credential Manager may be disabled by policy. Streaming must
            // remain available; this session simply loses persistent trust.
            Err(_) => EphemeralKey::generate(),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        EphemeralKey::generate()
    }
}

pub(super) fn is_trusted(public_key: &str) -> Result<bool, String> {
    validate_public_key(public_key)?;
    Ok(read_trusted()?.iter().any(|key| key == public_key))
}

pub(super) fn trust(public_key: &str) -> Result<usize, String> {
    validate_public_key(public_key)?;
    let mut keys = read_trusted()?;
    if !keys.iter().any(|key| key == public_key) {
        if keys.len() >= MAX_TRUSTED {
            return Err(format!(
                "Limite de {MAX_TRUSTED} computadores confiáveis atingido"
            ));
        }
        keys.push(public_key.to_owned());
        write_trusted(&keys)?;
    }
    Ok(keys.len())
}

pub(super) fn clear_trusted() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let entry = keyring::Entry::new(SERVICE, TRUST_ENTRY)
            .map_err(|error| format!("Credencial de pareamento: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("Remoção dos pareamentos: {error}")),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(())
    }
}

fn read_trusted() -> Result<Vec<String>, String> {
    #[cfg(target_os = "windows")]
    {
        let entry = keyring::Entry::new(SERVICE, TRUST_ENTRY)
            .map_err(|error| format!("Credencial de pareamento: {error}"))?;
        let encoded = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(Vec::new()),
            Err(error) => return Err(format!("Leitura dos pareamentos: {error}")),
        };
        let keys: Vec<String> = serde_json::from_str(&encoded)
            .map_err(|_| "Lista protegida de computadores está corrompida")?;
        if keys.len() > MAX_TRUSTED || keys.iter().any(|key| validate_public_key(key).is_err()) {
            return Err("Lista protegida de computadores é inválida".into());
        }
        Ok(keys)
    }
    #[cfg(not(target_os = "windows"))]
    {
        Ok(Vec::new())
    }
}

fn write_trusted(keys: &[String]) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let entry = keyring::Entry::new(SERVICE, TRUST_ENTRY)
            .map_err(|error| format!("Credencial de pareamento: {error}"))?;
        let encoded = serde_json::to_string(keys).map_err(|error| error.to_string())?;
        entry
            .set_password(&encoded)
            .map_err(|error| format!("Proteção dos pareamentos no Windows: {error}"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = keys;
        Err("Pareamento persistente disponível somente no Windows".into())
    }
}

fn validate_public_key(value: &str) -> Result<(), String> {
    if value.len() == 43
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        Ok(())
    } else {
        Err("Identidade pública do computador inválida".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn public_identity_validation_rejects_injected_credential_names() {
        assert!(validate_public_key(&"A".repeat(43)).is_ok());
        assert!(validate_public_key("../peer").is_err());
        assert!(validate_public_key(&"A".repeat(44)).is_err());
    }
}
