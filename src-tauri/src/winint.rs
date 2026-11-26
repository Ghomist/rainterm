//! Opening rainterm on a folder (`rainterm D:\code`, `rainterm .`, Explorer's "Open in
//! rainterm") and, on Windows, adding / removing that Explorer menu and the PATH entry.

use std::path::{Path, PathBuf};

/// The folder a launch asks for: the first argument that is a folder (relative to `cwd`),
/// or `--cwd X` / `-d X`.
pub fn folder_from_args(args: &[String], cwd: &Path) -> Option<String> {
    let mut it = args.iter().skip(1);
    while let Some(a) = it.next() {
        let p = if a == "--cwd" || a == "-d" {
            it.next()?.clone()
        } else if a.starts_with('-') {
            continue;
        } else {
            a.clone()
        };
        // Explorer passes "D:\" with a trailing quote quirk for drive roots: D:"
        let p = p.trim_end_matches('"');
        let path = if Path::new(p).is_absolute() { PathBuf::from(p) } else { cwd.join(p) };
        if path.is_dir() {
            let s = path.canonicalize().unwrap_or(path).to_string_lossy().into_owned();
            // canonicalize gives \\?\C:\… on Windows
            return Some(s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s));
        }
    }
    None
}

#[cfg(windows)]
mod win {
    use std::process::Command;

    use anyhow::{bail, Context};

    const KEYS: [&str; 3] = [
        r"HKCU\Software\Classes\Directory\shell\rainterm",
        r"HKCU\Software\Classes\Directory\Background\shell\rainterm",
        r"HKCU\Software\Classes\Drive\shell\rainterm",
    ];

    fn hidden(program: &str) -> Command {
        use std::os::windows::process::CommandExt;
        let mut c = Command::new(program);
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    }

    fn reg(args: &[&str]) -> anyhow::Result<()> {
        let o = hidden("reg").args(args).output().context("run reg.exe")?;
        if !o.status.success() {
            bail!("{}", String::from_utf8_lossy(&o.stderr).trim());
        }
        Ok(())
    }

    fn exe() -> anyhow::Result<String> {
        Ok(std::env::current_exe()?.to_string_lossy().into_owned())
    }

    pub fn installed() -> bool {
        hidden("reg").args(["query", KEYS[0]]).output().is_ok_and(|o| o.status.success())
    }

    /// The user PATH, through PowerShell so other programs hear about the change.
    fn set_path(add: bool) -> anyhow::Result<()> {
        let dir = std::env::current_exe()?.parent().context("exe folder")?.to_string_lossy().into_owned();
        let dir = dir.replace('\'', "''");
        let script = if add {
            format!("$d='{dir}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $l=@($p -split ';' | Where-Object {{ $_ }}); if ($l -notcontains $d) {{ [Environment]::SetEnvironmentVariable('Path', (($l + $d) -join ';'), 'User') }}")
        } else {
            format!("$d='{dir}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $l=@($p -split ';' | Where-Object {{ $_ -and $_ -ne $d }}); [Environment]::SetEnvironmentVariable('Path', ($l -join ';'), 'User')")
        };
        let o = hidden("powershell").args(["-NoProfile", "-NonInteractive", "-Command", &script]).output()?;
        if !o.status.success() {
            bail!("{}", String::from_utf8_lossy(&o.stderr).trim());
        }
        Ok(())
    }

    pub fn set(on: bool, label: &str) -> anyhow::Result<()> {
        let exe = exe()?;
        if on {
            for k in KEYS {
                reg(&["add", k, "/ve", "/d", label, "/f"])?;
                reg(&["add", k, "/v", "Icon", "/d", &format!("\"{exe}\",0"), "/f"])?;
                reg(&["add", &format!(r"{k}\command"), "/ve", "/d", &format!("\"{exe}\" \"%V\""), "/f"])?;
            }
        } else {
            for k in KEYS {
                let _ = reg(&["delete", k, "/f"]);
            }
        }
        set_path(on)
    }
}

pub fn installed() -> bool {
    #[cfg(windows)]
    return win::installed();
    #[cfg(not(windows))]
    false
}

pub fn set(on: bool, label: &str) -> anyhow::Result<()> {
    #[cfg(windows)]
    return win::set(on, label);
    #[cfg(not(windows))]
    {
        let _ = (on, label);
        anyhow::bail!("only on Windows")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_folder() {
        let tmp = std::env::temp_dir();
        let args = |v: &[&str]| v.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        assert!(folder_from_args(&args(&["rainterm"]), &tmp).is_none());
        assert!(folder_from_args(&args(&["rainterm", "."]), &tmp).is_some());
        assert!(folder_from_args(&args(&["rainterm", "--cwd", "."]), &tmp).is_some());
        assert!(folder_from_args(&args(&["rainterm", "no-such-folder-xyz"]), &tmp).is_none());
        let abs = tmp.to_string_lossy().into_owned();
        assert!(folder_from_args(&args(&["rainterm", &abs]), Path::new("/")).is_some());
    }
}
