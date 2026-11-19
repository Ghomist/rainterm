// The terminal as a tool: run a command in a pane's shell (visibly, as if typed), wait
// for it to finish, and read back its output and exit code from the command blocks.
// Used by the built-in agent (and later the MCP server).
import type { TermSession } from "@/lib/term-session";

export interface RunResult {
  /** Output lines (head + tail when long), already truncated. */
  output: string;
  exitCode: number | null;
  /** Still running when we stopped waiting. */
  running: boolean;
  /** A full-screen program took over the terminal. */
  fullscreen: boolean;
  omitted: number;
}

const HEAD = 40;
const TAIL = 120;
const LINE_MAX = 400;
const QUIET_MS = 1200;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Is the shell sitting at a prompt (ready for a command)? */
export function atPrompt(s: TermSession) {
  return s.term.buffer.active.type === "normal" && s.blocks.inputState() !== null;
}

/** Plain text of absolute lines [from, to] (wrapped rows joined into logical lines). */
function linesText(s: TermSession, from: number, to: number): string[] {
  const buf = s.term.buffer.active;
  const out: string[] = [];
  for (let y = Math.max(0, from); y <= to; y++) {
    const line = buf.getLine(y);
    if (!line) continue;
    const t = line.translateToString(true);
    if (line.isWrapped && out.length) out[out.length - 1] += t;
    else out.push(t);
  }
  return out;
}

export function truncate(lines: string[]): { text: string; omitted: number } {
  const clip = (l: string) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}… [${l.length - LINE_MAX} more chars]` : l);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (lines.length <= HEAD + TAIL) return { text: lines.map(clip).join("\n"), omitted: 0 };
  const omitted = lines.length - HEAD - TAIL;
  return {
    text: [...lines.slice(0, HEAD).map(clip), `… [${omitted} lines omitted] …`, ...lines.slice(-TAIL).map(clip)].join("\n"),
    omitted,
  };
}

/** What's on the screen right now (full-screen apps) or the last `n` lines before the cursor. */
export function readScreen(s: TermSession, n = 60) {
  const buf = s.term.buffer.active;
  const cursor = buf.baseY + buf.cursorY;
  if (buf.type !== "normal") return linesText(s, buf.viewportY, buf.viewportY + s.term.rows - 1).join("\n").trimEnd();
  return truncate(linesText(s, Math.max(0, cursor - n + 1), cursor)).text;
}

/** Clear whatever is typed at the prompt (Ctrl+U on POSIX shells, Esc in PowerShell / cmd). */
function clearLineKey(s: TermSession) {
  const src = s.source;
  if (src.kind === "local" && /pwsh|powershell|cmd/i.test(`${src.shell.id} ${src.shell.program}`)) return "\x1b";
  return "\x15";
}

/**
 * Type `command` + Enter into the shell and wait for it to finish (or `timeoutMs`).
 * `submit: false` only types it (for the user to review and run).
 */
export async function runCommand(
  s: TermSession,
  command: string,
  opts: { timeoutMs: number; submit?: boolean; signal?: AbortSignal },
): Promise<RunResult> {
  const { term, blocks } = s;
  const typed = blocks.inputState();
  if (typed?.text) {
    s.agentInput(clearLineKey(s));
    await sleep(120);
  }
  const one = command.replace(/\r?\n/g, " ").trim();
  if (opts.submit === false) {
    s.agentInput(one);
    return { output: "", exitCode: null, running: false, fullscreen: false, omitted: 0 };
  }
  // Type first and let the shell echo it: block detection reads the command off the
  // prompt line when Enter arrives (Enter sent together with the text finds it empty).
  s.agentInput(one);
  // Wait until the echo is complete (the shell may redraw the line, e.g. syntax colors or
  // autosuggestions): the cursor then sits on the command's last row.
  const typedSince = performance.now();
  for (let i = 0; i < 80; i++) {
    await sleep(25);
    const quiet = performance.now() - s.lastOutputAt > 120 && s.lastOutputAt > typedSince;
    const st = blocks.inputState();
    if (quiet && (!st || st.text.length >= Math.min(one.length, 3))) break;
  }
  const buf0 = term.buffer.normal;
  const typedAt = buf0.baseY + buf0.cursorY;
  const before = blocks.list.length;
  term.scrollToBottom();
  s.agentInput("\r");
  // The block appears as soon as Enter is seen at a prompt.
  for (let i = 0; i < 20 && blocks.list.length === before; i++) await sleep(25);
  const block = blocks.list.length > before ? blocks.list[blocks.list.length - 1] : null;
  const idx = block ? blocks.list.indexOf(block) : -1;
  const startLine = block && !block.marker.isDisposed ? block.marker.line : typedAt;

  const deadline = performance.now() + opts.timeoutMs;
  let fullscreen = false;
  let done = false;
  await sleep(150);
  while (performance.now() < deadline) {
    if (opts.signal?.aborted) break;
    if (term.buffer.active.type !== "normal") {
      fullscreen = true;
      break;
    }
    if (blocks.integrated && idx >= 0 && blocks.list[idx] === block && blocks.range(idx)) {
      done = true;
      break;
    }
    // No shell integration (or the block got lost): output went quiet and a prompt is back.
    if (performance.now() - s.lastOutputAt > QUIET_MS && atPrompt(s) && (!blocks.integrated || idx < 0)) {
      done = true;
      break;
    }
    await sleep(100);
  }

  if (fullscreen) {
    const screen = readScreen(s);
    return { output: screen, exitCode: null, running: true, fullscreen: true, omitted: 0 };
  }
  let lines: string[];
  const range = idx >= 0 && blocks.list[idx] === block ? blocks.range(idx) : null;
  if (range) lines = linesText(s, range.start, range.end);
  else {
    // Output so far: below the command line up to the cursor (minus the new prompt).
    const buf = term.buffer.normal;
    const cursor = buf.baseY + buf.cursorY;
    let first = Math.max(startLine, typedAt) + 1;
    let last = done ? cursor - 1 : cursor;
    if (!block) {
      // No block was recorded (e.g. the shell repainted its first screen): find the row
      // where the command was echoed, looking up from the cursor, and start below it.
      const probe = one.slice(0, 24);
      const text = (y: number) => buf.getLine(y)?.translateToString(true) ?? "";
      for (let y = cursor; y >= Math.max(0, cursor - 400); y--) {
        if (text(y).includes(probe)) {
          first = Math.max(first, y + 1);
          // A multi-line prompt: the lines above the command row are the previous prompt;
          // the same lines above the cursor are the new one — not output.
          if (done) for (let k = 1; k <= 4 && y - k >= 0 && text(y - k) === text(cursor - k); k++) last = cursor - 1 - k;
          break;
        }
      }
    }
    while (buf.getLine(first)?.isWrapped) first++;
    lines = linesText(s, first, last);
  }
  const { text, omitted } = truncate(lines);
  return {
    output: text,
    exitCode: block?.exitCode ?? null,
    running: !done,
    fullscreen: false,
    omitted,
  };
}

const KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  tab: "\t",
  esc: "\x1b",
  escape: "\x1b",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
};

/** "q", "<Enter>", "<C-c>", ":wq<Enter>" → the bytes a keyboard would send. */
export function keysToBytes(keys: string): string {
  return keys.replace(/<([^<>]+)>/g, (whole, name: string) => {
    const n = name.trim().toLowerCase();
    const ctrl = /^(?:c|ctrl)-(.)$/.exec(n);
    if (ctrl) {
      const ch = ctrl[1].toUpperCase().charCodeAt(0);
      return ch >= 64 && ch <= 95 ? String.fromCharCode(ch - 64) : whole;
    }
    return KEYS[n] ?? whole;
  });
}

/** Commands that only look at things — run without asking in "auto" mode. */
const READ_ONLY =
  /^(?:ls|ll|dir|pwd|cd|cat|bat|head|tail|less|more|wc|grep|rg|egrep|fgrep|find|fd|locate|which|where|whereis|type|file|stat|du|df|free|uptime|uname|hostname|whoami|id|groups|date|env|printenv|echo|ps|pgrep|top -b|htop -t|lsof|ss|netstat|ip (?:a|addr|r|route|link)|ifconfig|ping -c|dig|nslookup|host|curl -[sSIL]*I|journalctl|dmesg|lsblk|blkid|mount$|lscpu|lsusb|lspci|nproc|vmstat|iostat|sar|systemctl (?:status|list-units|list-unit-files|is-active|is-enabled|cat|show)|service \S+ status|docker (?:ps|images|logs|inspect|stats --no-stream|version|info)|podman (?:ps|images|logs|inspect)|kubectl (?:get|describe|logs|top|version|config (?:get-contexts|current-context|view))|git (?:status|log|diff|show|branch|remote -v|rev-parse)|node -v|python3? --version|java -version|go version|sort|uniq|cut|tr|awk|column|jq|yq|nl|tac|rev|diff|cmp|md5sum|sha\d*sum|realpath|readlink|basename|dirname|tree|nc -z|getent|last|who|crontab -l|docker (?:compose|-compose) (?:ps|logs|config|ls)|docker-compose (?:ps|logs|config)|docker (?:network|volume|image) (?:ls|inspect)|kubectl (?:api-resources|cluster-info|auth can-i)|helm (?:list|ls|status|get)|npm (?:ls|list|view)|pip3? (?:list|show|freeze)|Get-\w+|Test-\w+|Select-\w+|Measure-\w+|Format-\w+|Where-Object|Sort-Object|Resolve-Path|Split-Path)\b/i;

/** True if the command line clearly only reads (no redirection into files, no sudo). */
export function isReadOnly(command: string) {
  const c = command.trim();
  // Throwing output away (2>/dev/null, >/dev/null, 2>&1) is fine; any other redirection writes a file.
  const stripped = c.replace(/\d?>{1,2}\s*\/dev\/null|\d>&\d/g, "");
  if (/>|\bsudo\b|\btee\b|\|\s*(?:sh|bash|zsh|xargs)\b|`|\$\(|\bsed\s+-i|\bawk\b.*\bsystem\(/.test(stripped)) return false;
  return c.split(/\s*(?:\|\||&&|;|\|)\s*/).every((part) => !part || READ_ONLY.test(part));
}
