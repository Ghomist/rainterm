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

// ------------------------------------------------------------------ read-only queries

/// What the services / logs / network / cron panels may ask a Linux machine. Each is a
/// fixed, read-only script; parameters are checked, then quoted. Anything that changes the
/// machine is typed into a terminal instead, where the user sees it (and sudo can ask).
#[derive(Debug, serde::Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Query {
    Services,
    Service { unit: String },
    Journal { unit: Option<String>, lines: u32, priority: Option<u8> },
    LogFile { path: String, lines: u32 },
    LogFiles,
    Connections,
    Firewall,
    Cron,
}

fn unit_ok(u: &str) -> bool {
    !u.is_empty() && u.len() < 256 && u.chars().all(|c| c.is_ascii_alphanumeric() || "@._:-\\".contains(c))
}

fn script(q: &Query) -> anyhow::Result<String> {
    Ok(match q {
        Query::Services => "systemctl list-units --type=service --all --no-pager --no-legend --plain 2>&1; echo '#files'; systemctl list-unit-files --type=service --no-pager --no-legend --plain 2>&1".into(),
        Query::Service { unit } => {
            anyhow::ensure!(unit_ok(unit), "bad unit name");
            format!(
                "systemctl show {u} --no-pager -p Id,Description,LoadState,ActiveState,SubState,UnitFileState,MainPID,MemoryCurrent,CPUUsageNSec,TasksCurrent,ActiveEnterTimestamp,ExecMainStartTimestamp,FragmentPath,Restart,NRestarts,Result 2>&1",
                u = shell_quote(unit)
            )
        }
        Query::Journal { unit, lines, priority } => {
            let mut c = format!("journalctl --no-pager -o short-iso -n {}", (*lines).clamp(1, 5000));
            if let Some(u) = unit {
                anyhow::ensure!(unit_ok(u), "bad unit name");
                c += &format!(" -u {}", shell_quote(u));
            }
            if let Some(p) = priority {
                anyhow::ensure!(*p <= 7, "bad priority");
                c += &format!(" -p {p}");
            }
            c + " 2>&1"
        }
        Query::LogFile { path, lines } => {
            anyhow::ensure!(path.starts_with('/') && !path.contains('\n') && !path.contains('\0'), "give an absolute path");
            format!("tail -n {} -- {} 2>&1", (*lines).clamp(1, 5000), shell_quote(path))
        }
        Query::LogFiles => "find /var/log -maxdepth 2 -type f \\( -name '*.log' -o -name syslog -o -name messages -o -name secure -o -name 'auth.log' -o -name kern.log \\) -size +0 2>/dev/null | sort | head -200".into(),
        Query::Connections => "if command -v ss >/dev/null 2>&1; then echo '#ss'; ss -Htunap 2>/dev/null; else echo '#netstat'; netstat -tunap 2>/dev/null; fi".into(),
        Query::Firewall => "if command -v ufw >/dev/null 2>&1; then echo '#ufw'; sudo -n ufw status verbose 2>&1; fi; if command -v firewall-cmd >/dev/null 2>&1; then echo '#firewalld'; sudo -n firewall-cmd --list-all 2>&1; fi; if command -v nft >/dev/null 2>&1; then echo '#nft'; sudo -n nft list ruleset 2>&1 | head -300; elif command -v iptables >/dev/null 2>&1; then echo '#iptables'; sudo -n iptables -S 2>&1 | head -300; fi".into(),
        Query::Cron => "echo '#user'; crontab -l 2>&1; echo '#etc /etc/crontab'; cat /etc/crontab 2>/dev/null; for f in /etc/cron.d/*; do [ -f \"$f\" ] && { echo \"#etc $f\"; cat \"$f\"; }; done 2>/dev/null; echo '#timers'; systemctl list-timers --all --no-pager --no-legend 2>&1".into(),
    })
}

/// PowerShell single-quoted string.
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// The same questions asked of Windows (this computer): services, event log, connections,
/// firewall and Task Scheduler. Output mimics the Linux tools' where the panels parse it.
fn win_script(q: &Query) -> anyhow::Result<String> {
    const HEAD: &str = "$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8; ";
    let body = match q {
        Query::Services => r#"$s = Get-CimInstance Win32_Service
foreach ($x in $s) { $st = if ($x.State -eq 'Running') { 'active running' } elseif ($x.State -eq 'Stopped') { 'inactive dead' } elseif ($x.State -match 'Pending') { 'activating ' + $x.State } else { 'inactive ' + $x.State }; "$($x.Name -replace ' ','_').service loaded $st $($x.DisplayName)" }
'#files'
foreach ($x in $s) { $m = switch ($x.StartMode) { 'Auto' { 'enabled' } 'Disabled' { 'disabled' } default { 'manual' } }; "$($x.Name -replace ' ','_').service $m" }"#
            .to_string(),
        Query::Service { unit } => {
            anyhow::ensure!(unit_ok(unit), "bad unit name");
            let name = unit.trim_end_matches(".service").replace('_', " ");
            format!(
                r#"$x = Get-CimInstance Win32_Service | Where-Object {{ $_.Name -eq {n} }} | Select-Object -First 1
$p = if ($x.ProcessId) {{ Get-Process -Id $x.ProcessId }}
"Id=$($x.Name)"; "Description=$($x.Description)"; "ActiveState=$($x.State)"; "MainPID=$($x.ProcessId)"
"MemoryCurrent=$($p.WorkingSet64)"; "TasksCurrent=$($p.Threads.Count)"
"ActiveEnterTimestamp=$(if ($p.StartTime) {{ $p.StartTime.ToString('yyyy-MM-dd HH:mm:ss') }})"
"UnitFileState=$($x.StartMode)"; "FragmentPath=$($x.PathName)"; "Result=$(if ($x.ExitCode) {{ 'exit code ' + $x.ExitCode }})""#,
                n = ps_quote(&name)
            )
        }
        Query::Journal { unit, lines, priority } => {
            let n = (*lines).clamp(1, 5000);
            let level = match priority {
                Some(p) if *p <= 3 => "$f.Level = 1,2; ",
                Some(4) => "$f.Level = 1,2,3; ",
                _ => "",
            };
            let filter = match unit {
                Some(u) => {
                    anyhow::ensure!(unit_ok(u), "bad unit name");
                    let w = ps_quote(&format!("*{}*", u.trim_end_matches(".service").replace('_', " ")));
                    format!("$e = Get-WinEvent -FilterHashtable $f -MaxEvents 4000 | Where-Object {{ $_.ProviderName -like {w} -or $_.Message -like {w} }} | Select-Object -First {n}")
                }
                None => format!("$e = Get-WinEvent -FilterHashtable $f -MaxEvents {n}"),
            };
            format!(
                r#"$f = @{{ LogName = 'System','Application' }}; {level}{filter}
$lv = @{{ 1 = 'critical: '; 2 = 'error: '; 3 = 'warning: ' }}
$e | Sort-Object TimeCreated | ForEach-Object {{ $m = (($_.Message -split "`r?`n") | Where-Object {{ $_ }} | Select-Object -First 1); "$($_.TimeCreated.ToString('yyyy-MM-ddTHH:mm:ss')) $env:COMPUTERNAME $($_.ProviderName)[$($_.Id)]: $($lv[[int]$_.Level])$m" }}"#
            )
        }
        Query::LogFile { path, lines } => {
            anyhow::ensure!(std::path::Path::new(path).is_absolute() && !path.contains('\n'), "give an absolute path");
            format!("Get-Content -Tail {} -LiteralPath {} 2>&1", (*lines).clamp(1, 5000), ps_quote(path))
        }
        Query::LogFiles => r#"Get-ChildItem "$env:SystemRoot\Logs" -Recurse -Depth 2 -File -Include *.log | Where-Object { $_.Length -gt 0 } | Select-Object -First 150 -ExpandProperty FullName"#.to_string(),
        Query::Connections => r#"$n = @{}; Get-Process | ForEach-Object { $n[$_.Id] = $_.ProcessName }
'#ss'
$a = { param($h, $p) if ($h -match ':') { "[$h]:$p" } else { "${h}:$p" } }
# MSFT_NetTCPConnection.State comes as a number (or its name, depending on the shell)
$m = @{ '1' = 'CLOSED'; '2' = 'LISTEN'; '3' = 'SYN-SENT'; '4' = 'SYN-RECV'; '5' = 'ESTAB'; '6' = 'FIN-WAIT-1'; '7' = 'FIN-WAIT-2'; '8' = 'CLOSE-WAIT'; '9' = 'CLOSING'; '10' = 'LAST-ACK'; '11' = 'TIME-WAIT'; '12' = 'DELETE-TCB'; '100' = 'BOUND'
  'Closed' = 'CLOSED'; 'Listen' = 'LISTEN'; 'SynSent' = 'SYN-SENT'; 'SynReceived' = 'SYN-RECV'; 'Established' = 'ESTAB'; 'FinWait1' = 'FIN-WAIT-1'; 'FinWait2' = 'FIN-WAIT-2'; 'CloseWait' = 'CLOSE-WAIT'; 'Closing' = 'CLOSING'; 'LastAck' = 'LAST-ACK'; 'TimeWait' = 'TIME-WAIT'; 'DeleteTCB' = 'DELETE-TCB'; 'Bound' = 'BOUND' }
Get-NetTCPConnection | ForEach-Object { $c = $_; $k = [string]$c.State; $st = if ($m.ContainsKey($k)) { $m[$k] } else { $k.ToUpper() }; "tcp $st 0 0 $(& $a $c.LocalAddress $c.LocalPort) $(& $a $c.RemoteAddress $c.RemotePort) users:((`"$($n[[int]$c.OwningProcess])`",pid=$($c.OwningProcess),fd=0))" }"#
            .to_string(),
        Query::Firewall => r#"'#windows'
$d = { param($v, $def) if ([string]$v -eq 'NotConfigured') { "$def (default)" } else { [string]$v } }
Get-NetFirewallProfile | ForEach-Object { "{0,-8} {1,-4} inbound {2}, outbound {3}" -f $_.Name, $(if ($_.Enabled) { 'on' } else { 'off' }), (& $d $_.DefaultInboundAction 'Block'), (& $d $_.DefaultOutboundAction 'Allow') }
$r = @(Get-NetFirewallRule -Enabled True -Direction Inbound -Action Allow)
''; "$($r.Count) inbound allow rules are on:"
$r | Sort-Object DisplayName | Select-Object -First 80 | ForEach-Object { '  ' + $_.DisplayName }"#
            .to_string(),
        Query::Cron => r#"'#wintasks'
$t = Get-ScheduledTask | Where-Object { $_.TaskPath -notlike '\Microsoft\*' } | ForEach-Object {
  $i = $_ | Get-ScheduledTaskInfo
  [pscustomobject]@{ name = $_.TaskName; path = $_.TaskPath; state = [string]$_.State
    next = $(if ($i.NextRunTime) { $i.NextRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' })
    last = $(if ($i.LastRunTime -and $i.LastRunTime.Year -gt 2000) { $i.LastRunTime.ToString('yyyy-MM-dd HH:mm') } else { '' })
    result = $i.LastTaskResult
    action = (($_.Actions | ForEach-Object { ("$($_.Execute) $($_.Arguments)").Trim() }) -join ' ; ') } }
ConvertTo-Json -InputObject @($t) -Compress"#
            .to_string(),
    };
    Ok(format!("{HEAD}{body}"))
}

/// Changes on Windows that need an administrator: through UAC, one action at a time.
/// `kind` and `verb` come from a fixed list; the name is quoted.
pub async fn win_admin(kind: &str, verb: &str, name: &str, path: Option<&str>) -> anyhow::Result<()> {
    anyhow::ensure!(cfg!(windows), "only on Windows");
    anyhow::ensure!(!name.is_empty() && !name.contains(['\n', '\r', '\0']), "bad name");
    let n = ps_quote(name);
    let action = match (kind, verb) {
        ("service", "start") => format!("Start-Service -Name {n}"),
        ("service", "stop") => format!("Stop-Service -Name {n} -Force"),
        ("service", "restart") => format!("Restart-Service -Name {n} -Force"),
        ("service", "enable") => format!("Set-Service -Name {n} -StartupType Automatic"),
        ("service", "manual") => format!("Set-Service -Name {n} -StartupType Manual"),
        ("service", "disable") => format!("Set-Service -Name {n} -StartupType Disabled"),
        ("task", v @ ("run" | "enable" | "disable" | "stop")) => {
            let p = ps_quote(path.unwrap_or("\\"));
            let cmd = match v {
                "run" => "Start-ScheduledTask",
                "stop" => "Stop-ScheduledTask",
                "enable" => "Enable-ScheduledTask",
                _ => "Disable-ScheduledTask",
            };
            format!("{cmd} -TaskName {n} -TaskPath {p} | Out-Null")
        }
        _ => anyhow::bail!("not allowed: {kind} {verb}"),
    };
    let run = |elevated: bool| {
        let action = action.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let script = if elevated {
                // the inner command, base64 so no quoting survives the hop
                let utf16: Vec<u8> = format!("$ErrorActionPreference='Stop'; {action}").encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
                let enc = base64_encode(&utf16);
                format!("$ErrorActionPreference='Stop'; $p = Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList '-NoProfile','-EncodedCommand','{enc}'; exit $p.ExitCode")
            } else {
                format!("$ErrorActionPreference='Stop'; {action}")
            };
            command("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output()
        })
    };
    // tasks you own run without asking; everything else (and a refused task) goes through UAC
    if kind == "task" {
        let o = run(false).await??;
        if o.status.success() {
            return Ok(());
        }
    }
    let o = run(true).await??;
    if !o.status.success() {
        let err = String::from_utf8_lossy(&o.stderr);
        anyhow::ensure!(!err.contains("canceled by the user") && !err.contains("已取消"), "Cancelled (administrator rights were not given)");
        anyhow::bail!("{}", err.lines().find(|l| !l.trim().is_empty()).unwrap_or("it failed (administrator rights were not given, or Windows refused)").trim());
    }
    Ok(())
}

fn base64_encode(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

/// Windows' own consoles for what a panel shows (services.msc, Event Viewer…).
pub fn win_open(tool: &str) -> anyhow::Result<()> {
    anyhow::ensure!(["services.msc", "eventvwr.msc", "wf.msc", "taskschd.msc", "resmon"].contains(&tool), "not allowed: {tool}");
    command("cmd").args(["/c", "start", "", tool]).spawn()?;
    Ok(())
}

/// Run a query on the SSH session's server, or here (Linux / macOS).
pub async fn query(sessions: &Sessions, session_id: Option<&str>, q: &Query) -> anyhow::Result<String> {
    let line = script(q)?;
    match session_id {
        Some(id) => {
            let conn = sessions.ssh(id).map_err(anyhow::Error::msg)?;
            let (_, out, err) = conn.exec_full(&line, Duration::from_secs(25)).await?;
            Ok(if out.is_empty() { err } else { out })
        }
        None if cfg!(windows) => {
            let script = win_script(q)?;
            let task = tauri::async_runtime::spawn_blocking(move || {
                command("powershell").args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &script]).output()
            });
            let o = tokio::time::timeout(Duration::from_secs(40), task).await.map_err(|_| anyhow::anyhow!("took too long"))???;
            Ok(String::from_utf8_lossy(&o.stdout).into_owned())
        }
        None => {
            let task = tauri::async_runtime::spawn_blocking(move || command("sh").arg("-c").arg(line).output());
            let o = tokio::time::timeout(Duration::from_secs(25), task).await.map_err(|_| anyhow::anyhow!("took too long"))???;
            Ok(String::from_utf8_lossy(&o.stdout).into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_matches() {
        assert_eq!(base64_encode(b"hello"), "aGVsbG8=");
        assert_eq!(base64_encode(b"ab"), "YWI=");
        assert_eq!(base64_encode(b"abc"), "YWJj");
    }

    #[test]
    fn windows_scripts_quote() {
        assert!(win_script(&Query::LogFile { path: "C:\\it's\\a.log".into(), lines: 5 }).unwrap().contains("'C:\\it''s\\a.log'"));
        assert!(win_script(&Query::Service { unit: "a';b".into() }).is_err());
    }

    #[test]
    fn queries_check_their_input() {
        assert!(script(&Query::Service { unit: "nginx.service".into() }).is_ok());
        assert!(script(&Query::Service { unit: "x; rm -rf /".into() }).is_err());
        assert!(script(&Query::LogFile { path: "relative".into(), lines: 10 }).is_err());
        let s = script(&Query::LogFile { path: "/var/log/a b'c".into(), lines: 10 }).unwrap();
        assert!(s.contains("'/var/log/a b'\\''c'"));
        assert!(script(&Query::Journal { unit: None, lines: 99999, priority: Some(3) }).unwrap().contains("-n 5000 -p 3"));
    }

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
