//! Persistence: profiles + settings as JSON files in the config dir, secrets in the
//! OS credential store (Windows Credential Manager / macOS Keychain / Secret Service).
//! The frontend owns the JSON schemas; Rust just stores them atomically.

use std::path::PathBuf;

use serde_json::Value;

const SERVICE: &str = "rainterm";

/// `~/.rainterm` — one place regardless of how the app is launched (packaged hosts such
/// as MSIX redirect %APPDATA% writes per launcher, which split the data in two).
/// `RAINTERM_HOME` overrides it.
pub fn config_dir() -> anyhow::Result<PathBuf> {
    static DIR: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    if let Some(d) = DIR.get() {
        return Ok(d.clone());
    }
    let dir = match std::env::var_os("RAINTERM_HOME") {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?.join(".rainterm"),
    };
    let fresh = !dir.exists();
    std::fs::create_dir_all(&dir)?;
    if fresh {
        migrate_legacy(&dir);
    }
    Ok(DIR.get_or_init(|| dir).clone())
}

/// First run with the new location: bring over the JSON stores from the old config dir.
fn migrate_legacy(dir: &std::path::Path) {
    let Some(old) = dirs::config_dir().map(|d| d.join("rainterm")) else { return };
    let Ok(rd) = std::fs::read_dir(&old) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().is_some_and(|x| x == "json") {
            let _ = std::fs::copy(&p, dir.join(e.file_name()));
        }
    }
}

pub fn load(name: &str) -> anyhow::Result<Option<Value>> {
    let p = config_dir()?.join(format!("{name}.json"));
    if !p.exists() {
        return Ok(None);
    }
    Ok(Some(serde_json::from_slice(&std::fs::read(p)?)?))
}

pub fn save(name: &str, value: &Value) -> anyhow::Result<()> {
    let p = config_dir()?.join(format!("{name}.json"));
    let tmp = p.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, p)?;
    Ok(())
}

pub fn secret_get(key: &str) -> Option<String> {
    keyring::Entry::new(SERVICE, key).ok()?.get_password().ok()
}

pub fn secret_set(key: &str, value: &str) -> anyhow::Result<()> {
    keyring::Entry::new(SERVICE, key)?.set_password(value)?;
    Ok(())
}

pub fn secret_delete(key: &str) {
    if let Ok(e) = keyring::Entry::new(SERVICE, key) {
        let _ = e.delete_credential();
    }
}
