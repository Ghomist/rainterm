//! SSH key pairs in ~/.ssh: list them, generate new ed25519 ones (like `ssh-keygen -t
//! ed25519`), and the line `ssh-copy-id` would add to a server's authorized_keys.

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::{
    private::{Ed25519Keypair, KeypairData},
    Cipher, HashAlg, Kdf, LineEnding, PrivateKey, PublicKey,
};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyInfo {
    /// File name of the private key ("id_ed25519").
    pub name: String,
    /// Private key path (may not exist when only the .pub is there).
    pub path: String,
    pub has_private: bool,
    /// Private key protected by a passphrase (None: unknown / no private key).
    pub encrypted: Option<bool>,
    pub algorithm: String,
    pub comment: String,
    pub fingerprint: String,
    /// The one-line OpenSSH public key ("ssh-ed25519 AAAA… comment").
    pub public_key: String,
}

fn ssh_dir() -> anyhow::Result<PathBuf> {
    Ok(dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home directory"))?.join(".ssh"))
}

fn info(pub_path: &Path) -> Option<KeyInfo> {
    let text = std::fs::read_to_string(pub_path).ok()?;
    let key = PublicKey::from_openssh(text.trim()).ok()?;
    let private = pub_path.with_extension("");
    let encrypted = std::fs::read_to_string(&private)
        .ok()
        .and_then(|t| PrivateKey::from_openssh(t.trim()).ok())
        .map(|k| k.is_encrypted());
    Some(KeyInfo {
        name: private.file_name()?.to_string_lossy().into_owned(),
        path: private.to_string_lossy().into_owned(),
        has_private: private.exists(),
        encrypted,
        algorithm: key.algorithm().to_string(),
        comment: key.comment().to_string(),
        fingerprint: key.fingerprint(HashAlg::Sha256).to_string(),
        public_key: key.to_openssh().ok()?,
    })
}

pub fn list() -> anyhow::Result<Vec<KeyInfo>> {
    let dir = ssh_dir()?;
    let Ok(rd) = std::fs::read_dir(&dir) else { return Ok(vec![]) };
    let mut out: Vec<KeyInfo> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "pub"))
        .filter_map(|p| info(&p))
        .collect();
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

fn random<const N: usize>() -> anyhow::Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| anyhow::anyhow!("no randomness: {e}"))?;
    Ok(b)
}

/// New ed25519 key pair at ~/.ssh/<name> (+ .pub). Refuses to overwrite.
pub fn generate(name: &str, comment: &str, passphrase: Option<&str>) -> anyhow::Result<KeyInfo> {
    anyhow::ensure!(
        !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "._-".contains(c)) && !name.starts_with('.'),
        "use letters, digits, '.', '_' or '-' for the file name"
    );
    let dir = ssh_dir()?;
    std::fs::create_dir_all(&dir)?;
    let private = dir.join(name);
    let public = dir.join(format!("{name}.pub"));
    anyhow::ensure!(!private.exists() && !public.exists(), "~/.ssh/{name} already exists");

    let seed = random::<32>()?;
    let mut key = PrivateKey::new(KeypairData::from(Ed25519Keypair::from_seed(&seed)), comment)?;
    if let Some(pass) = passphrase.filter(|p| !p.is_empty()) {
        let salt = random::<16>()?.to_vec();
        let checkint = u32::from_le_bytes(random::<4>()?);
        // Same parameters as ssh-keygen: aes256-ctr, bcrypt with 16 rounds.
        key = key.encrypt_with(Cipher::Aes256Ctr, Kdf::Bcrypt { salt, rounds: 16 }, checkint, pass)?;
    }
    let pem = key.to_openssh(LineEnding::LF)?;
    write_private(&private, pem.as_bytes())?;
    std::fs::write(&public, format!("{}\n", key.public_key().to_openssh()?))?;
    info(&public).ok_or_else(|| anyhow::anyhow!("could not read the new key back"))
}

#[cfg(unix)]
fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(path)?;
    f.write_all(data)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_private(path: &Path, data: &[u8]) -> anyhow::Result<()> {
    use std::io::Write;
    // Under the user profile, which only the user (and admins) can read.
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(data)?;
    Ok(())
}

/// Shell command that appends `public_key` to ~/.ssh/authorized_keys unless it's there
/// (prints "added" / "present"). The key is parsed and re-encoded first, so nothing but a
/// well-formed key line reaches the shell.
pub fn copy_id_command(public_key: &str) -> anyhow::Result<String> {
    let key = PublicKey::from_openssh(public_key.trim())?;
    let line = key.to_openssh()?;
    anyhow::ensure!(!line.contains('\'') && !line.contains('\n'), "unexpected characters in the key comment");
    let body = line.split_whitespace().nth(1).unwrap_or_default().to_string();
    Ok(format!(
        "umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && \
         if grep -qF '{body}' ~/.ssh/authorized_keys; then echo present; \
         else printf '%s\\n' '{line}' >> ~/.ssh/authorized_keys && echo added; fi"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_round_trip() {
        let seed = [7u8; 32];
        let key = PrivateKey::new(KeypairData::from(Ed25519Keypair::from_seed(&seed)), "me@pc").unwrap();
        let enc = key.encrypt_with(Cipher::Aes256Ctr, Kdf::Bcrypt { salt: vec![1; 16], rounds: 4 }, 42, "pw").unwrap();
        let pem = enc.to_openssh(LineEnding::LF).unwrap();
        let back = PrivateKey::from_openssh(pem.as_str()).unwrap();
        assert!(back.is_encrypted());
        let plain = back.decrypt("pw").unwrap();
        assert_eq!(plain.public_key().to_openssh().unwrap(), key.public_key().to_openssh().unwrap());
        let cmd = copy_id_command(&key.public_key().to_openssh().unwrap()).unwrap();
        assert!(cmd.contains("ssh-ed25519 AAAA") && cmd.contains("me@pc"));
        assert!(copy_id_command("ssh-ed25519 AAAA'; rm -rf / #").is_err());
    }
}
