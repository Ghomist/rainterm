// Shell integration for bash / zsh / fish over SSH: a one-off (not persisted) hook that
// makes the shell report, around every prompt:
//   OSC 133;D;<exit>  — previous command finished (exit code)
//   OSC 7             — current directory (file panel follows `cd`)
//   OSC 133;A         — a prompt starts here
//   OSC 133;B         — the prompt ends, command input starts (exact command text)
//
// One line that every shell can parse; each runs only its own branch:
//  - bash/zsh: `__rt_pc` runs first and returns the original `$?` (themes still see the
//    real status); `__rt_b` runs last and re-appends B, since themes rebuild PS1.
//  - fish: `fish_postexec` keeps `$status`, the `fish_prompt` event emits D/A/7, and the
//    prompt function is wrapped to append B.
// Leading space keeps it out of history (HISTCONTROL=ignorespace / HIST_IGNORE_SPACE;
// fish never saves space-prefixed commands).
const BASH_ZSH =
  '[ -n "$BASH_VERSION$ZSH_VERSION" ] && eval \'' +
  '__rt_pc(){ local s=$?; printf "\\033]133;D;%s\\007\\033]7;file://%s%s\\007\\033]133;A\\007" "$s" "${HOSTNAME:-$HOST}" "$PWD"; return $s; };' +
  ' __rt_b(){ local s=$?; case "$PS1" in *"133;B"*) ;; *) if [ -n "$ZSH_VERSION" ];' +
  ' then PS1="$PS1%{$(printf "\\033]133;B\\007")%}"; else PS1="$PS1\\[$(printf "\\033]133;B\\007")\\]"; fi;; esac; return $s; };' +
  ' if [ -n "$ZSH_VERSION" ]; then precmd_functions=(__rt_pc $precmd_functions __rt_b);' +
  ' else PROMPT_COMMAND="__rt_pc${PROMPT_COMMAND:+;$PROMPT_COMMAND};__rt_b"; fi\'';

const FISH =
  'test -n "$FISH_VERSION" && eval \'' +
  'function __rt_post --on-event fish_postexec; set -g __rt_s $status; end;' +
  ' function __rt_pc --on-event fish_prompt; printf "\\e]133;D;%s\\a\\e]7;file://%s%s\\a\\e]133;A\\a" "$__rt_s" "$hostname" "$PWD"; end;' +
  ' functions -q __rt_orig_prompt; or functions -c fish_prompt __rt_orig_prompt;' +
  ' function fish_prompt; __rt_orig_prompt; printf "\\e]133;B\\a"; end\'';

export const POSIX_INTEGRATION = ` ${BASH_ZSH}; ${FISH}`;
