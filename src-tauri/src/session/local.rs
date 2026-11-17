//! Local shell backend on top of portable-pty (ConPTY on Windows, openpty on Unix).

use std::io::{Read, Write};
use std::path::PathBuf;

use portable_pty::{CommandBuilder, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};

use super::{BackendIo, Ctrl, SessionEvent};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellSpec {
    pub id: String,
    pub name: String,
    pub program: String,
    #[serde(default)]
    pub args: Vec<String>,
}

pub fn spawn(spec: ShellSpec, cols: u16, rows: u16, io: BackendIo) -> anyhow::Result<()> {
    let BackendIo { out, mut ctrl_rx, ctrl_tx, events, shared } = io;

    let pty = native_pty_system();
    let pair = pty.openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })?;

    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("TERM_PROGRAM", "rainterm");
    super::posix_integration::apply(&mut cmd, &spec.id);

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let mut reader = pair.master.try_clone_reader()?;
    let mut writer = pair.master.take_writer()?;
    let master = pair.master;
    let mut killer = child.clone_killer();

    let _ = events.send(SessionEvent::Connected);

    // Reader: blocking read -> bounded channel (blocking_send gives us backpressure).
    std::thread::Builder::new().name("pty-reader".into()).spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if out.blocking_send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    })?;

    // Waiter: record exit code, then tell the control thread to drop the master.
    // (On Windows ConPTY the reader only sees EOF once the master is closed.)
    std::thread::Builder::new().name("pty-waiter".into()).spawn(move || {
        let status = child.wait();
        *shared.exit_code.lock() = status.ok().map(|s| s.exit_code() as i32);
        let _ = ctrl_tx.send(Ctrl::ChildExited);
    })?;

    // Control: writes and resizes are blocking calls, keep them off the async runtime.
    std::thread::Builder::new().name("pty-ctrl".into()).spawn(move || {
        while let Some(msg) = ctrl_rx.blocking_recv() {
            match msg {
                Ctrl::Write(data) => {
                    if writer.write_all(&data).is_err() {
                        break;
                    }
                    let _ = writer.flush();
                }
                Ctrl::Resize { cols, rows } => {
                    let _ = master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
                }
                Ctrl::Close => {
                    let _ = killer.kill();
                }
                Ctrl::ChildExited => break,
            }
        }
        drop(writer);
        drop(master);
    })?;

    Ok(())
}

/// Shell integration for PowerShell: wraps whatever prompt the profile set up
/// (starship, oh-my-posh, default) so every prompt also reports
///   OSC 133;D;n      previous command's exit code
///   OSC 133;A / B    prompt start / end → exact command blocks, command text, history
///   OSC 7, OSC 9;9   working directory → file panel follows `cd`
/// The real `$?` is re-established (VS Code's trick) before the original prompt runs,
/// so success/failure indicators keep working. Also binds Ctrl+W / Alt+D (sent for
/// Ctrl+Backspace / Ctrl+Delete) to word deletion in PSReadLine.
/// Runs after the user's profile; nothing is written to disk.
#[cfg(windows)]
const PWSH_INTEGRATION: &str = r#"
try {
  Set-PSReadLineKeyHandler -Chord Ctrl+w -Function BackwardKillWord
  Set-PSReadLineKeyHandler -Chord Alt+d -Function KillWord
} catch {}
$global:__rt_prompt = $function:prompt
function global:prompt {
  $fail = -not $global:?
  $code = if ($fail) { if ($global:LASTEXITCODE) { $global:LASTEXITCODE } else { 1 } } else { 0 }
  if ($fail) { Write-Error 'failure' -ErrorAction Ignore }
  $out = & $global:__rt_prompt
  $e = [char]27; $b = [char]7; $p = $PWD.ProviderPath
  $u = 'file:///' + $p.Replace('\', '/')
  "$e]133;D;$code$b$e]133;A$b$e]7;$u$b$e]9;9;$p$b" + $out + "$e]133;B$b"
}
"#;

/// `-EncodedCommand` argument: base64 of the UTF-16LE script (no quoting pitfalls).
#[cfg(windows)]
fn pwsh_encoded() -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let bytes: Vec<u8> = PWSH_INTEGRATION.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let mut out = String::new();
    for c in bytes.chunks(3) {
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

/// Detect shells available on this machine.
pub fn detect_shells() -> Vec<ShellSpec> {
    let mut shells: Vec<ShellSpec> = Vec::new();
    fn push(shells: &mut Vec<ShellSpec>, id: &str, name: &str, program: PathBuf, args: &[&str]) {
        shells.push(ShellSpec {
            id: id.into(),
            name: name.into(),
            program: program.to_string_lossy().into_owned(),
            args: args.iter().map(|s| s.to_string()).collect(),
        });
    }

    #[cfg(windows)]
    {
        let enc = pwsh_encoded();
        if let Some(p) = which("pwsh.exe") {
            push(&mut shells, "pwsh", "PowerShell", p, &["-NoLogo", "-NoExit", "-EncodedCommand", &enc]);
        }
        if let Some(p) = which("powershell.exe") {
            push(&mut shells, "powershell", "Windows PowerShell", p, &["-NoLogo", "-NoExit", "-EncodedCommand", &enc]);
        }
        if let Some(p) = which("cmd.exe") {
            push(&mut shells, "cmd", "Command Prompt", p, &[]);
        }
        if let Some(p) = which("wsl.exe") {
            push(&mut shells, "wsl", "WSL", p, &[]);
        }
        for base in [std::env::var("ProgramFiles").ok(), std::env::var("ProgramW6432").ok()]
            .into_iter()
            .flatten()
        {
            let p = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
            if p.exists() && !shells.iter().any(|s| s.id == "gitbash") {
                push(&mut shells, "gitbash", "Git Bash", p, &["--login", "-i"]);
            }
        }
    }

    #[cfg(not(windows))]
    {
        if let Ok(sh) = std::env::var("SHELL") {
            let name = PathBuf::from(&sh)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "shell".into());
            push(&mut shells, "default", &name, PathBuf::from(sh), &["-l"]);
        }
        for (id, name) in [("zsh", "zsh"), ("bash", "bash"), ("fish", "fish")] {
            if let Some(p) = which(name) {
                if !shells.iter().any(|s| s.program == p.to_string_lossy()) {
                    push(&mut shells, id, name, p, &["-l"]);
                }
            }
        }
    }

    shells
}

fn which(program: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path).map(|d| d.join(program)).find(|p| p.is_file())
}
