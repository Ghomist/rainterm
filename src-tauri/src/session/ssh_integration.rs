//! Shell integration for SSH sessions without typing anything into the terminal.
//!
//! sshd starts the remote shell itself, so environment tricks don't reach it (`AcceptEnv`
//! only lets LANG/LC_* through). Instead, before the terminal channel opens:
//!  1. A hidden exec channel runs `sh -s` with a script on stdin. It looks at `$SHELL` and,
//!     for bash / zsh / fish only, writes small startup files to `~/.cache/rainterm`
//!     (or a private temp dir) and reports back where they are.
//!  2. The terminal channel then runs `sh <dir>/start` instead of the plain shell. That
//!     prints the motd (sshd skips it when a command is given) and execs the user's own
//!     login shell with the prompt hooks on top of their usual config.
//!
//! Anything else (sh/ksh/csh users, routers, Windows OpenSSH, forced commands, a full disk)
//! yields no report, and the session opens a plain shell exactly as before.

use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

use super::posix_integration::{ZPROFILE, ZSHENV, ZSHRC};
use super::ssh::Conn;

/// Hosts (user@host:port) where setup didn't work: not retried while the app runs.
static UNSUPPORTED: LazyLock<parking_lot::Mutex<HashSet<String>>> = LazyLock::new(Default::default);

const READY: &str = "__RT_READY__";

/// Runs the user's login shell with the hooks; `$1` is bash / zsh / fish.
const START: &str = r#"# rainterm shell integration: start your login shell with prompt marks.
d=${0%/*}
[ -f "$HOME/.hushlogin" ] || cat /run/motd.dynamic /etc/motd 2>/dev/null
case "$1" in
bash) exec "$SHELL" --rcfile "$d/bashrc" -i ;;
zsh) export RT_USER_ZDOTDIR="${ZDOTDIR-}" ZDOTDIR="$d/zsh"; exec "$SHELL" -l ;;
fish) exec "$SHELL" -l -C "source '$d/fish.fish'" ;;
esac
exec "$SHELL" -l
"#;

/// bash ignores `--rcfile` in login shells, so this does what a login shell would
/// (profile files, ~/.bash_logout, `logout`), then adds the marks like the typed hook.
const BASHRC: &str = r#"# rainterm shell integration: load your login config, then add prompt marks.
trap '[ -r ~/.bash_logout ] && . ~/.bash_logout' EXIT
logout() { exit "$@"; }
[ -r /etc/profile ] && . /etc/profile
for __rt_f in ~/.bash_profile ~/.bash_login ~/.profile; do
  if [ -r "$__rt_f" ]; then . "$__rt_f"; break; fi
done
unset __rt_f
__rt_pc() { local s=$?; printf '\033]133;D;%s\007\033]7;file://%s%s\007\033]133;A\007' "$s" "$HOSTNAME" "$PWD"; return $s; }
__rt_b() { local s=$?; case "$PS1" in *"133;B"*) ;; *) PS1="$PS1\[$(printf '\033]133;B\007')\]";; esac; return $s; }
PROMPT_COMMAND="__rt_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND};__rt_b"
"#;

/// Sourced by `fish --init-command`, i.e. after the user's config.
const FISH: &str = r#"# rainterm shell integration: prompt marks.
function __rt_post --on-event fish_postexec; set -g __rt_s $status; end
function __rt_pc --on-event fish_prompt; printf "\e]133;D;%s\a\e]7;file://%s%s\a\e]133;A\a" "$__rt_s" "$hostname" "$PWD"; end
functions -q __rt_orig_prompt; or functions -c fish_prompt __rt_orig_prompt
function fish_prompt; __rt_orig_prompt; printf "\e]133;B\a"; end
"#;

/// The setup script (POSIX sh, fed on stdin so the login shell never has to parse it).
fn setup_script() -> String {
    let mut s = String::from(
        r#"case "${SHELL##*/}" in bash|zsh|fish) k=${SHELL##*/} ;; *) exit 0 ;; esac
[ -x "$SHELL" ] || exit 0
umask 077
d="$HOME/.cache/rainterm"
if ! { mkdir -p "$d/zsh" && [ -w "$d/zsh" ]; } 2>/dev/null; then
  d=$(mktemp -d 2>/dev/null) && mkdir "$d/zsh" || exit 0
fi
w() { cat > "$d/$1.$$" && mv -f "$d/$1.$$" "$d/$1"; }
"#,
    );
    for (name, body) in [
        ("start", START),
        ("bashrc", BASHRC),
        ("fish.fish", FISH),
        ("zsh/.zshenv", ZSHENV),
        ("zsh/.zprofile", ZPROFILE),
        ("zsh/.zshrc", ZSHRC),
    ] {
        s.push_str(&format!("w {name} <<'__RT_EOF__' || exit 0\n{body}__RT_EOF__\n"));
    }
    s.push_str(&format!("printf '\\n{READY} %s %s\\n' \"$k\" \"$d\"\n"));
    s
}

/// The command for the terminal channel, from the setup's report (rc files may print
/// their own noise around it).
fn parse(out: &str) -> Option<String> {
    let line = out.lines().rev().find_map(|l| l.trim_end_matches('\r').strip_prefix(READY)?.strip_prefix(' '))?;
    let (kind, dir) = line.split_once(' ')?;
    if !matches!(kind, "bash" | "zsh" | "fish") {
        return None;
    }
    // Quoted with '…' below (and in the fish init command): keep it plain.
    if !dir.starts_with('/') || dir.chars().any(|c| c == '\'' || c.is_control()) {
        return None;
    }
    Some(format!("exec sh '{dir}/start' {kind}"))
}

/// Set up the hooks on the server; the command to run in place of the shell, or `None`
/// to open a plain shell.
pub async fn prepare(conn: &Conn, host_key: &str) -> Option<String> {
    if UNSUPPORTED.lock().contains(host_key) {
        return None;
    }
    // Generous: PAM runs the whole session setup (Ubuntu's dynamic motd…) for this channel too.
    match conn.exec_input("sh -s", setup_script().as_bytes(), Duration::from_secs(8)).await {
        Ok((_, out, _)) => {
            let cmd = parse(&out);
            if cmd.is_none() {
                UNSUPPORTED.lock().insert(host_key.to_string());
            }
            cmd
        }
        // Timed out (slow server): try again next connect. Refused: don't.
        Err(e) => {
            if !e.to_string().contains("timed out") {
                UNSUPPORTED.lock().insert(host_key.to_string());
            }
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_report_among_noise() {
        let out = "welcome from .bashrc\n\n__RT_READY__ zsh /home/a b/.cache/rainterm\n";
        assert_eq!(parse(out).as_deref(), Some("exec sh '/home/a b/.cache/rainterm/start' zsh"));
    }

    #[test]
    fn rejects_odd_reports() {
        assert_eq!(parse(""), None);
        assert_eq!(parse("__RT_READY__ ksh /home/a\n"), None);
        assert_eq!(parse("__RT_READY__ bash relative/dir\n"), None);
        assert_eq!(parse("__RT_READY__ bash /home/o'neil\n"), None);
    }

    #[test]
    fn heredoc_delimiter_not_in_bodies() {
        for b in [START, BASHRC, FISH, ZSHENV, ZPROFILE, ZSHRC] {
            assert!(!b.contains("__RT_EOF__"));
            assert!(b.ends_with('\n'));
        }
    }
}
