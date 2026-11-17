//! Command names for completion: executables on PATH (+ shell built-ins), per shell.
//! Local: scan PATH (PATHEXT on Windows); PowerShell also lists its cmdlets/functions/
//! aliases; WSL lists PATH inside the distro. Remote: `sh` lists PATH on the server.

use std::collections::BTreeSet;
use std::path::Path;

use crate::session::Sessions;

const LIMIT: usize = 8000;

const POSIX_BUILTINS: &[&str] = &[
    "alias", "bg", "cd", "echo", "eval", "exec", "exit", "export", "fg", "history", "jobs", "kill",
    "printf", "pwd", "read", "set", "source", "test", "time", "trap", "type", "ulimit", "umask",
    "unalias", "unset", "wait", "which", "sudo",
];

const CMD_BUILTINS: &[&str] = &[
    "assoc", "call", "cd", "chdir", "cls", "color", "copy", "date", "del", "dir", "echo", "endlocal",
    "erase", "exit", "for", "ftype", "goto", "if", "md", "mkdir", "mklink", "move", "path", "pause",
    "popd", "prompt", "pushd", "rd", "rem", "ren", "rename", "rmdir", "set", "setlocal", "shift",
    "start", "time", "title", "type", "ver", "vol",
];

/// Executables in the current process's PATH.
fn scan_path() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    let Some(path) = std::env::var_os("PATH") else { return out };
    #[cfg(windows)]
    let exts: Vec<String> = std::env::var("PATHEXT")
        .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
        .split(';')
        .map(|e| e.trim_start_matches('.').to_ascii_lowercase())
        .chain(["ps1".to_string()])
        .collect();
    for dir in std::env::split_paths(&path) {
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            #[cfg(windows)]
            {
                let ext = p.extension().map(|x| x.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
                if exts.contains(&ext) {
                    if let Some(stem) = p.file_stem() {
                        out.insert(stem.to_string_lossy().into_owned());
                    }
                }
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if e.metadata().map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0).unwrap_or(false) {
                    out.insert(e.file_name().to_string_lossy().into_owned());
                }
            }
            let _ = &p;
        }
    }
    out
}

fn run(program: &str, args: &[&str]) -> Vec<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

const LIST_PATH_SH: &str =
    "IFS=:; for d in $PATH; do case \"$d\" in /mnt/*) continue;; esac; [ -d \"$d\" ] && ls -1 \"$d\"; done 2>/dev/null";

/// Command names for a local shell (by the ids from `detect_shells`).
pub fn local(shell_id: &str, program: &str) -> Vec<String> {
    let mut set: BTreeSet<String> = BTreeSet::new();
    match shell_id {
        "pwsh" | "powershell" => {
            set.extend(scan_path());
            set.extend(run(
                program,
                &["-NoProfile", "-NoLogo", "-Command", "Get-Command -CommandType Cmdlet,Function,Alias | ForEach-Object Name"],
            ));
        }
        "cmd" => {
            set.extend(scan_path());
            set.extend(CMD_BUILTINS.iter().map(|s| s.to_string()));
        }
        "wsl" => {
            set.extend(run(program, &["-e", "sh", "-c", LIST_PATH_SH]));
            set.extend(POSIX_BUILTINS.iter().map(|s| s.to_string()));
        }
        _ => {
            set.extend(scan_path());
            set.extend(POSIX_BUILTINS.iter().map(|s| s.to_string()));
        }
    }
    finish(set)
}

pub async fn remote(sessions: &Sessions, session_id: &str) -> anyhow::Result<Vec<String>> {
    let conn = sessions.ssh(session_id).map_err(anyhow::Error::msg)?;
    // Run through `sh` explicitly: the login shell may be fish.
    let script = LIST_PATH_SH.replace('\'', "'\\''");
    let out = conn.exec(&format!("sh -c '{script}'")).await?;
    let mut set: BTreeSet<String> = out.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect();
    set.extend(POSIX_BUILTINS.iter().map(|s| s.to_string()));
    Ok(finish(set))
}

fn finish(set: BTreeSet<String>) -> Vec<String> {
    set.into_iter()
        .filter(|n| !n.contains(char::is_whitespace) && Path::new(n).components().count() == 1)
        .take(LIMIT)
        .collect()
}
