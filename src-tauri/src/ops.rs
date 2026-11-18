//! Quick-ops tools for the side panels: listening ports, and a runner for docker /
//! podman / kubectl — on this computer or, for SSH sessions, on the server.

use std::time::Duration;

use serde::Serialize;

use crate::session::Sessions;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PortEntry {
    pub proto: String,
    pub address: String,
    pub port: u16,
    pub pid: Option<u32>,
    pub process: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Programs the panels may run. Anything else is refused.
const TOOLS: &[&str] = &["docker", "podman", "kubectl"];

// ------------------------------------------------------------------ ports

/// "0.0.0.0:22" / "[::]:22" / "*:22" / "127.0.0.53%lo:53" → (address, port)
fn split_addr(s: &str) -> Option<(String, u16)> {
    let i = s.rfind(':').or_else(|| s.rfind('.'))?;
    let port = s[i + 1..].parse().ok()?;
    let mut addr = s[..i].trim_matches(|c| c == '[' || c == ']').to_string();
    if let Some(p) = addr.find('%') {
        addr.truncate(p);
    }
    if addr.is_empty() {
        addr = "*".into();
    }
    Some((addr, port))
}

/// `ss -Htulnp` lines.
fn parse_ss(out: &str) -> Vec<PortEntry> {
    let re = regex::Regex::new(r#"\("([^"]+)",pid=(\d+)"#).unwrap();
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 5 {
                return None;
            }
            let proto = f[0].to_ascii_lowercase();
            if !proto.starts_with("tcp") && !proto.starts_with("udp") {
                return None;
            }
            let (address, port) = split_addr(f[4])?;
            let cap = re.captures(l);
            Some(PortEntry {
                proto: proto[..3].to_string(),
                address,
                port,
                pid: cap.as_ref().and_then(|c| c[2].parse().ok()),
                process: cap.map(|c| c[1].to_string()),
            })
        })
        .collect()
}

/// `netstat -tulnp` lines (Linux) — the fallback when `ss` is missing.
fn parse_netstat_linux(out: &str) -> Vec<PortEntry> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let proto = f.first()?.to_ascii_lowercase();
            if !(proto.starts_with("tcp") || proto.starts_with("udp")) || f.len() < 6 {
                return None;
            }
            if proto.starts_with("tcp") && f.get(5) != Some(&"LISTEN") {
                return None;
            }
            let (address, port) = split_addr(f[3])?;
            let last = f.last().copied().unwrap_or("");
            let (pid, process) = match last.split_once('/') {
                Some((p, n)) => (p.parse().ok(), Some(n.to_string())),
                None => (None, None),
            };
            Some(PortEntry { proto: proto[..3].to_string(), address, port, pid, process })
        })
        .collect()
}

/// `netstat -ano` (Windows).
#[cfg_attr(not(windows), allow(dead_code))]
fn parse_netstat_windows(out: &str) -> Vec<PortEntry> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let proto = f.first()?.to_ascii_lowercase();
            match proto.as_str() {
                "tcp" if f.len() >= 5 && f[3] == "LISTENING" => {}
                "udp" if f.len() >= 4 => {}
                _ => return None,
            }
            let (address, port) = split_addr(f[1])?;
            Some(PortEntry { proto, address, port, pid: f.last()?.parse().ok(), process: None })
        })
        .collect()
}

/// `lsof -nP -iTCP -sTCP:LISTEN -iUDP` (macOS).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_lsof(out: &str) -> Vec<PortEntry> {
    out.lines()
        .skip(1)
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            if f.len() < 9 {
                return None;
            }
            let proto = f[7].to_ascii_lowercase();
            let (address, port) = split_addr(f[8])?;
            Some(PortEntry { proto, address, port, pid: f[1].parse().ok(), process: Some(f[0].to_string()) })
        })
        .collect()
}

fn finish(mut v: Vec<PortEntry>) -> Vec<PortEntry> {
    v.sort_by(|a, b| a.port.cmp(&b.port).then(a.proto.cmp(&b.proto)).then(a.address.cmp(&b.address)));
    v.dedup();
    v
}

fn command(program: &str) -> std::process::Command {
    #[allow(unused_mut)]
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

pub fn ports_local() -> anyhow::Result<Vec<PortEntry>> {
    #[cfg(windows)]
    {
        let out = command("netstat").arg("-ano").output()?;
        let mut v = parse_netstat_windows(&String::from_utf8_lossy(&out.stdout));
        let mut sys = sysinfo::System::new()?;
        sys.refresh_processes(sysinfo::ProcessesToUpdate::All, true);
        for e in &mut v {
            if let Some(p) = e.pid.and_then(|pid| sys.process(sysinfo::Pid::from_u32(pid))) {
                e.process = Some(p.name().to_string_lossy().into_owned());
            }
        }
        Ok(finish(v))
    }
    #[cfg(target_os = "macos")]
    {
        let out = command("lsof").args(["-nP", "-iTCP", "-sTCP:LISTEN", "-iUDP"]).output()?;
        Ok(finish(parse_lsof(&String::from_utf8_lossy(&out.stdout))))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        match command("ss").arg("-Htulnp").output() {
            Ok(out) if out.status.success() => Ok(finish(parse_ss(&String::from_utf8_lossy(&out.stdout)))),
            _ => {
                let out = command("netstat").arg("-tulnp").output()?;
                Ok(finish(parse_netstat_linux(&String::from_utf8_lossy(&out.stdout))))
            }
        }
    }
}

pub async fn ports_remote(sessions: &Sessions, session_id: &str) -> anyhow::Result<Vec<PortEntry>> {
    let conn = sessions.ssh(session_id).map_err(anyhow::Error::msg)?;
    let (_, out, _) = conn
        .exec_full(
            "if command -v ss >/dev/null 2>&1; then echo '#ss'; ss -Htulnp; else echo '#netstat'; netstat -tulnp; fi 2>/dev/null",
            Duration::from_secs(15),
        )
        .await?;
    Ok(finish(if out.starts_with("#ss") { parse_ss(&out) } else { parse_netstat_linux(&out) }))
}

// ------------------------------------------------------------------ tool runner

fn shell_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:=,@%+".contains(c)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

/// Run `tool args…` locally (no shell) or on the SSH session's server.
pub async fn run(sessions: &Sessions, session_id: Option<&str>, tool: &str, args: &[String]) -> anyhow::Result<RunOutput> {
    anyhow::ensure!(TOOLS.contains(&tool), "{tool} is not allowed here");
    let timeout = Duration::from_secs(25);
    match session_id {
        Some(id) => {
            let conn = sessions.ssh(id).map_err(anyhow::Error::msg)?;
            let line = std::iter::once(tool.to_string()).chain(args.iter().map(|a| shell_quote(a))).collect::<Vec<_>>().join(" ");
            let (code, stdout, stderr) = conn.exec_full(&line, timeout).await?;
            Ok(RunOutput { code, stdout, stderr })
        }
        None => {
            let mut cmd = command(tool);
            cmd.args(args);
            let task = tauri::async_runtime::spawn_blocking(move || cmd.output());
            match tokio::time::timeout(timeout, task).await {
                Err(_) => anyhow::bail!("{tool} took too long to answer"),
                Ok(joined) => match joined? {
                    Ok(o) => Ok(RunOutput {
                        code: o.status.code().unwrap_or(-1),
                        stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
                        stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
                    }),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                        Ok(RunOutput { code: 127, stdout: String::new(), stderr: format!("{tool}: command not found") })
                    }
                    Err(e) => Err(e.into()),
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ss() {
        let out = "tcp   LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:((\"systemd-resolve\",pid=600,fd=14))\n\
                   tcp   LISTEN 0 128  [::]:22 [::]:* users:((\"sshd\",pid=812,fd=4))\n\
                   udp   UNCONN 0 0    0.0.0.0:68 0.0.0.0:*\n";
        let v = finish(parse_ss(out));
        assert_eq!(v.len(), 3);
        assert_eq!(v[0], PortEntry { proto: "tcp".into(), address: "::".into(), port: 22, pid: Some(812), process: Some("sshd".into()) });
        assert_eq!(v[1].address, "127.0.0.53");
        assert_eq!(v[2].proto, "udp");
    }

    #[test]
    fn parses_netstat() {
        let w = "  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1234\n\
                 \x20 TCP    10.0.0.2:5555          1.2.3.4:443            ESTABLISHED     99\n\
                 \x20 UDP    [::]:500               *:*                                    4567\n";
        let v = parse_netstat_windows(w);
        assert_eq!(v.len(), 2);
        assert_eq!((v[0].port, v[0].pid), (135, Some(1234)));
        assert_eq!((v[1].proto.as_str(), v[1].address.as_str()), ("udp", "::"));
        let l = "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      812/sshd\n\
                 udp        0      0 0.0.0.0:68              0.0.0.0:*                           700/dhclient\n";
        let v = parse_netstat_linux(l);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].process.as_deref(), Some("sshd"));
    }

    #[test]
    fn quotes() {
        assert_eq!(shell_quote("ps"), "ps");
        assert_eq!(shell_quote("{{json .}}"), "'{{json .}}'");
        assert_eq!(shell_quote("it's"), "'it'\\''s'");
    }
}
