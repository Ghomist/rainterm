//! Minimal OpenSSH client config reader for "Import from ~/.ssh/config".
//!
//! Semantics follow ssh_config(5) closely enough for import: blocks are scanned in
//! order, every block whose `Host` patterns match an alias contributes, and for each
//! keyword the *first* value obtained wins (so `Host *` defaults at the end apply only
//! where nothing more specific was set). `Include` is followed (with `*` globs);
//! `Match` blocks are skipped.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Default, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HostEntry {
    pub alias: String,
    pub host_name: Option<String>,
    pub user: Option<String>,
    pub port: Option<u16>,
    pub identity_file: Option<String>,
    pub proxy_jump: Option<String>,
}

struct Block {
    patterns: Vec<String>, // empty = global section before any Host line
    options: Vec<(String, String)>,
}

pub fn read_default() -> anyhow::Result<Vec<HostEntry>> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("no home dir"))?;
    let path = home.join(".ssh").join("config");
    if !path.exists() {
        return Ok(Vec::new());
    }
    let mut blocks = Vec::new();
    load(&path, &home.join(".ssh"), &mut blocks, 0)?;
    Ok(resolve(&blocks, &home))
}

fn load(path: &Path, ssh_dir: &Path, blocks: &mut Vec<Block>, depth: u8) -> anyhow::Result<()> {
    let text = std::fs::read_to_string(path)?;
    parse_into(&text, ssh_dir, blocks, depth);
    Ok(())
}

fn parse_into(text: &str, ssh_dir: &Path, blocks: &mut Vec<Block>, depth: u8) {
    if blocks.is_empty() {
        blocks.push(Block { patterns: Vec::new(), options: Vec::new() });
    }
    let mut skipping = false; // inside a `Match` block
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let (key, value) = split_kv(line);
        let key = key.to_ascii_lowercase();
        match key.as_str() {
            "host" => {
                skipping = false;
                blocks.push(Block { patterns: words(&value), options: Vec::new() });
            }
            "match" => skipping = true,
            "include" if depth < 8 => {
                for pat in words(&value) {
                    for file in expand_include(&pat, ssh_dir) {
                        if let Ok(t) = std::fs::read_to_string(&file) {
                            parse_into(&t, ssh_dir, blocks, depth + 1);
                        }
                    }
                }
            }
            _ if !skipping => {
                if let Some(b) = blocks.last_mut() {
                    b.options.push((key, value));
                }
            }
            _ => {}
        }
    }
}

fn split_kv(line: &str) -> (String, String) {
    // "Key value", "Key=value", "Key = value"
    let idx = line.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(line.len());
    let key = line[..idx].to_string();
    let rest = line[idx..].trim_start_matches(|c: char| c.is_whitespace() || c == '=');
    (key, unquote(rest.trim()))
}

fn unquote(s: &str) -> String {
    s.strip_prefix('"').and_then(|s| s.strip_suffix('"')).unwrap_or(s).to_string()
}

fn words(s: &str) -> Vec<String> {
    s.split_whitespace().map(unquote).collect()
}

fn expand_include(pat: &str, ssh_dir: &Path) -> Vec<PathBuf> {
    let p = expand_tilde(pat);
    let full = if Path::new(&p).is_absolute() { PathBuf::from(&p) } else { ssh_dir.join(&p) };
    let name = full.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    if !name.contains('*') && !name.contains('?') {
        return vec![full];
    }
    let Some(dir) = full.parent() else { return vec![] };
    let mut out: Vec<PathBuf> = std::fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|f| f.file_name().is_some_and(|n| wildcard(&name, &n.to_string_lossy())))
        .collect();
    out.sort();
    out
}

fn expand_tilde(p: &str) -> String {
    match (p.strip_prefix('~'), dirs::home_dir()) {
        (Some(rest), Some(home)) => format!("{}{}", home.display(), rest),
        _ => p.to_string(),
    }
}

/// ssh_config pattern match: `*` and `?` wildcards.
fn wildcard(pat: &str, s: &str) -> bool {
    let (p, s): (Vec<char>, Vec<char>) = (pat.chars().collect(), s.chars().collect());
    let (mut pi, mut si, mut star, mut mark) = (0, 0, None, 0);
    while si < s.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi].eq_ignore_ascii_case(&s[si])) {
            pi += 1;
            si += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = si;
            pi += 1;
        } else if let Some(sp) = star {
            pi = sp + 1;
            mark += 1;
            si = mark;
        } else {
            return false;
        }
    }
    p[pi..].iter().all(|&c| c == '*')
}

fn block_matches(b: &Block, alias: &str) -> bool {
    if b.patterns.is_empty() {
        return true; // global section
    }
    let mut hit = false;
    for p in &b.patterns {
        if let Some(neg) = p.strip_prefix('!') {
            if wildcard(neg, alias) {
                return false;
            }
        } else if wildcard(p, alias) {
            hit = true;
        }
    }
    hit
}

fn resolve(blocks: &[Block], home: &Path) -> Vec<HostEntry> {
    let mut aliases: Vec<String> = Vec::new();
    for b in blocks {
        for p in &b.patterns {
            if !p.contains(['*', '?', '!']) && !aliases.contains(p) {
                aliases.push(p.clone());
            }
        }
    }
    aliases
        .into_iter()
        .map(|alias| {
            let mut e = HostEntry { alias: alias.clone(), ..Default::default() };
            for b in blocks.iter().filter(|b| block_matches(b, &alias)) {
                for (k, v) in &b.options {
                    match k.as_str() {
                        "hostname" if e.host_name.is_none() => e.host_name = Some(v.replace("%h", &alias)),
                        "user" if e.user.is_none() => e.user = Some(v.clone()),
                        "port" if e.port.is_none() => e.port = v.parse().ok(),
                        "identityfile" if e.identity_file.is_none() => {
                            let p = expand_tilde(v);
                            let p = if Path::new(&p).is_absolute() { p } else { home.join(&p).display().to_string() };
                            e.identity_file = Some(p);
                        }
                        "proxyjump" if e.proxy_jump.is_none() && !v.eq_ignore_ascii_case("none") => {
                            e.proxy_jump = Some(v.clone())
                        }
                        _ => {}
                    }
                }
            }
            e
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(text: &str) -> Vec<HostEntry> {
        let mut blocks = Vec::new();
        parse_into(text, Path::new("/nonexistent"), &mut blocks, 0);
        resolve(&blocks, Path::new("/home/me"))
    }

    #[test]
    fn first_value_wins_and_defaults_apply() {
        let hosts = parse(
            "Host web prod-*\n  HostName 10.0.0.5\n  User deploy\n\nHost web\n  Port 2200\n  User ignored\n\n\
             Host bastion\n  HostName bastion.example.com\n\nHost *\n  User fallback\n  IdentityFile ~/.ssh/id_ed25519\n",
        );
        let web = hosts.iter().find(|h| h.alias == "web").unwrap();
        assert_eq!(web.host_name.as_deref(), Some("10.0.0.5"));
        assert_eq!(web.user.as_deref(), Some("deploy"));
        assert_eq!(web.port, Some(2200));
        let b = hosts.iter().find(|h| h.alias == "bastion").unwrap();
        assert_eq!(b.user.as_deref(), Some("fallback"));
        assert!(b.identity_file.as_deref().unwrap().ends_with(".ssh/id_ed25519"));
        assert!(hosts.iter().all(|h| !h.alias.contains('*')));
    }

    #[test]
    fn equals_syntax_negation_and_match() {
        let hosts = parse(
            "Host=db\n  HostName = db.internal\n  ProxyJump bastion\nHost * !db\n  Port 22\n\
             Match host db\n  User nope\nHost other\n  User ok\n",
        );
        let db = hosts.iter().find(|h| h.alias == "db").unwrap();
        assert_eq!(db.host_name.as_deref(), Some("db.internal"));
        assert_eq!(db.proxy_jump.as_deref(), Some("bastion"));
        assert_eq!(db.port, None); // negated
        assert_eq!(db.user, None); // Match block skipped
        assert_eq!(hosts.iter().find(|h| h.alias == "other").unwrap().user.as_deref(), Some("ok"));
    }

    #[test]
    fn wildcards() {
        assert!(wildcard("prod-*", "prod-web1"));
        assert!(wildcard("db?", "db1"));
        assert!(!wildcard("db?", "db12"));
        assert!(wildcard("*", "anything"));
    }
}
