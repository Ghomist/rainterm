//! Shell integration for local bash / zsh (WSL, Git Bash, macOS/Linux shells), set up
//! through the environment so nothing is typed into the terminal and no user file is
//! touched (the same approach as VS Code):
//!  - zsh: `ZDOTDIR` points at generated startup files that load the user's own
//!    .zshenv/.zprofile/.zshrc first, then add prompt hooks, and hand `ZDOTDIR` back.
//!  - bash: a `PROMPT_COMMAND` environment variable emits the marks before each prompt.
//! Marks: OSC 133;D;<exit>, OSC 133;A (prompt start), OSC 7 (cwd), OSC 133;B (zsh only).
//! For WSL the variables are forwarded with `WSLENV` (`/p` converts the Windows path).

use std::path::PathBuf;

use portable_pty::CommandBuilder;

pub(super) const ZSHENV: &str = r#"# rainterm shell integration: load your own config, then add prompt marks.
__rt_home="${RT_USER_ZDOTDIR:-$HOME}"
__rt_zd="$ZDOTDIR"; ZDOTDIR="$__rt_home"
[[ -f "$ZDOTDIR/.zshenv" ]] && . "$ZDOTDIR/.zshenv"
__rt_home="$ZDOTDIR"; ZDOTDIR="$__rt_zd"
"#;

pub(super) const ZPROFILE: &str = r#"__rt_zd="$ZDOTDIR"; ZDOTDIR="$__rt_home"
[[ -f "$ZDOTDIR/.zprofile" ]] && . "$ZDOTDIR/.zprofile"
__rt_home="$ZDOTDIR"; ZDOTDIR="$__rt_zd"
"#;

// After .zshrc, ZDOTDIR stays the user's: .zlogin and child shells use their config.
pub(super) const ZSHRC: &str = r#"ZDOTDIR="$__rt_home"
[[ -f "$ZDOTDIR/.zshrc" ]] && . "$ZDOTDIR/.zshrc"
unset RT_USER_ZDOTDIR __rt_zd
__rt_pc() { local s=$?; printf '\e]133;D;%s\a\e]7;file://%s%s\a\e]133;A\a' "$s" "$HOST" "$PWD"; return $s }
__rt_b() { local s=$?; [[ "$PS1" == *'133;B'* ]] || PS1="$PS1%{$(printf '\e]133;B\a')%}"; return $s }
precmd_functions=(__rt_pc $precmd_functions __rt_b)
"#;

/// bash: runs before every prompt; `(exit $s)` hands the real `$?` on to PS1 themes.
const BASH_PROMPT_COMMAND: &str = r#"__rt_s=$?; printf '\033]133;D;%s\007\033]133;A\007\033]7;file://%s%s\007' "$__rt_s" "$HOSTNAME" "$PWD"; (exit $__rt_s)"#;

fn zsh_dir() -> anyhow::Result<PathBuf> {
    // Temp dir on purpose: rewritten on every spawn, and (unlike %APPDATA% for apps
    // running in a packaged/virtualised context) always visible from inside WSL.
    let dir = std::env::temp_dir().join("rainterm-shell-integration").join("zsh");
    std::fs::create_dir_all(&dir)?;
    for (name, body) in [(".zshenv", ZSHENV), (".zprofile", ZPROFILE), (".zshrc", ZSHRC)] {
        let p = dir.join(name);
        if std::fs::read_to_string(&p).ok().as_deref() != Some(body) {
            std::fs::write(&p, body)?;
        }
    }
    Ok(dir)
}

/// Add the integration environment for shells that are bash/zsh (or may be: WSL).
pub fn apply(cmd: &mut CommandBuilder, shell_id: &str) {
    let applies = matches!(shell_id, "wsl" | "gitbash" | "default" | "zsh" | "bash");
    if !applies {
        return;
    }
    let Ok(dir) = zsh_dir() else { return };
    let user_zdotdir = std::env::var("ZDOTDIR").unwrap_or_default();
    cmd.env("ZDOTDIR", dir.display().to_string());
    cmd.env("RT_USER_ZDOTDIR", user_zdotdir);
    cmd.env("PROMPT_COMMAND", BASH_PROMPT_COMMAND);
    if shell_id == "wsl" {
        let mut wslenv = std::env::var("WSLENV").unwrap_or_default();
        for v in ["ZDOTDIR/p", "RT_USER_ZDOTDIR", "PROMPT_COMMAND"] {
            if !wslenv.is_empty() {
                wslenv.push(':');
            }
            wslenv.push_str(v);
        }
        cmd.env("WSLENV", wslenv);
    }
}
