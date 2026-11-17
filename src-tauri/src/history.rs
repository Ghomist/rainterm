//! Seed command suggestions from the shells' own history files.
//! Local: PSReadLine (PowerShell) and ~/.bash_history. Remote: ~/.zsh_history and
//! ~/.bash_history read over SFTP. Results stay on this machine.

use std::path::PathBuf;

use crate::session::Sessions;

const LIMIT: usize = 3000;

/// Parse a history file (bash plain lines, zsh `: <ts>:<dur>;cmd` extended format,
/// PSReadLine with backtick continuations). Returns oldest → newest, deduplicated
/// (keeping the most recent occurrence), capped to the last `LIMIT` entries.
pub fn parse(text: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let mut cont = String::new();
    for raw in text.lines() {
        let mut line = raw.trim_end_matches('\r').to_string();
        // zsh extended history
        if line.starts_with(": ") {
            if let Some(i) = line.find(';') {
                line = line[i + 1..].to_string();
            }
        }
        // multi-line commands: zsh/bash `\` and PowerShell backtick continuations
        if line.ends_with('\\') || line.ends_with('`') {
            cont.push_str(&line[..line.len() - 1]);
            cont.push(' ');
            continue;
        }
        let cmd = format!("{cont}{line}");
        cont.clear();
        let cmd = cmd.trim();
        if cmd.is_empty() || cmd.starts_with('#') || cmd.len() > 500 {
            continue;
        }
        out.push(cmd.to_string());
    }
    // dedupe keeping the last occurrence
    let mut seen = std::collections::HashSet::new();
    let mut rev: Vec<String> = out.into_iter().rev().filter(|c| seen.insert(c.clone())).collect();
    rev.truncate(LIMIT);
    rev.reverse();
    rev
}

fn read_lossy(p: &PathBuf) -> Option<String> {
    std::fs::read(p).ok().map(|b| String::from_utf8_lossy(&b).into_owned())
}

/// History of a local shell (by the shell ids from `detect_shells`).
pub fn local(shell_id: &str) -> Vec<String> {
    let mut files: Vec<PathBuf> = Vec::new();
    let home = dirs::home_dir().unwrap_or_default();
    match shell_id {
        "pwsh" | "powershell" => {
            if let Some(appdata) = dirs::data_dir() {
                files.push(
                    appdata.join("Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt"),
                );
            }
        }
        "cmd" | "wsl" => {}
        _ => {
            files.push(home.join(".zsh_history"));
            files.push(home.join(".bash_history"));
        }
    }
    let text: String = files.iter().filter_map(read_lossy).collect::<Vec<_>>().join("\n");
    parse(&text)
}

/// History files of the remote user, read over the session's SFTP channel.
pub async fn remote(sessions: &Sessions, session_id: &str) -> anyhow::Result<Vec<String>> {
    let sftp = sessions.ssh(session_id).map_err(anyhow::Error::msg)?.sftp().await?;
    let home = sftp.canonicalize(".").await?;
    let mut text = String::new();
    for name in [".bash_history", ".zsh_history"] {
        let path = format!("{}/{}", home.trim_end_matches('/'), name);
        if let Ok(meta) = sftp.metadata(path.clone()).await {
            // Huge histories: only the tail matters.
            if meta.size.unwrap_or(0) > 4 * 1024 * 1024 {
                continue;
            }
            if let Ok(bytes) = sftp.read(path).await {
                text.push_str(&String::from_utf8_lossy(&bytes));
                text.push('\n');
            }
        }
    }
    Ok(parse(&text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_zsh_bash_and_continuations() {
        let h = parse(": 1700000000:0;ls -la\ngit status\n: 1700000001:0;ls -la\necho a \\\nb\ncd ~`\n/tmp\n\n#comment\n");
        assert_eq!(h, vec!["git status", "ls -la", "echo a  b", "cd ~ /tmp"]);
    }
}
