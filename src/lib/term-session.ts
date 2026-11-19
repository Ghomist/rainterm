// A TermSession owns one xterm.js instance and one backend session (local PTY, SSH or
// serial). It lives outside React so panes can be re-rendered / re-parented without
// losing state.

import { afterLayoutAnimation, layoutAnimating } from "./layout-anim";
import { FitAddon } from "@xterm/addon-fit";
import { ImageAddon } from "@xterm/addon-image";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Blocks } from "./blocks";
import {
  Channel,
  type FsEntry,
  type FsTarget,
  ipc,
  type SerialTarget,
  type SessionEvent,
  type ShellSpec,
  type SshTarget,
} from "./ipc";
import type { Settings } from "./settings";
import { addCommand, ensureImported, search } from "./history";
import { POSIX_INTEGRATION } from "./shell-integration";
import { themeById } from "./term-theme";

/** One entry of the completion popup. */
export interface Completion {
  kind: "history" | "dir" | "file" | "command";
  label: string;
  /** How many typed characters (before the cursor) it replaces. */
  replace: number;
  insert: string;
}

/** Commands whose arguments are usually paths: show path completions first. */
const PATH_COMMANDS = new Set([
  "cd", "ls", "ll", "la", "cat", "less", "more", "head", "tail", "vim", "vi", "nvim", "nano", "code",
  "rm", "cp", "mv", "mkdir", "rmdir", "touch", "chmod", "chown", "source", ".", "bash", "sh", "zsh",
  "python", "python3", "node", "tar", "unzip", "zip", "git", "dir", "type", "get-content", "set-location",
  "remove-item", "copy-item", "move-item", "explorer", "start", "du", "stat", "file", "open",
]);

/** Command names on PATH per machine (shared by all sessions of that machine). */
const commandCache = new Map<string, { at: number; list: Promise<string[]> }>();

export type SessionSource =
  | { kind: "local"; shell: ShellSpec }
  | {
      kind: "ssh";
      profileId?: string;
      target: SshTarget;
      secret: string | null;
      jumpSecret: string | null;
    }
  | { kind: "serial"; target: SerialTarget };

/** Ack in batches: one IPC per ~64 KiB parsed, or after a short idle. */
const ACK_BATCH = 64 * 1024;
const ACK_IDLE_MS = 16;

/** Over a background the terminal canvas is blended into the glass (multiply on light
 *  themes, screen on dark; see index.css). A white / black background is the identity for
 *  those blends, so the glass shows its true color and only the text is laid on top. */
function termTheme(s: Settings) {
  const def = themeById(s.theme);
  if (s.backdrop === "none") return def.theme;
  return { ...def.theme, background: def.appearance === "dark" ? "#000000" : "#ffffff" };
}

export class TermSession {
  readonly term: Terminal;
  readonly search = new SearchAddon();
  readonly blocks: Blocks;
  /** Extra consumer of user input (broadcast mode). */
  inputHook: ((data: string) => void) | null = null;
  onCwd: ((cwd: string) => void) | null = null;

  private fit = new FitAddon();
  private id: string | null = null;
  private opened = false;
  private disposed = false;
  private pendingAck = 0;
  private lastDataAt = 0;
  private logging = false;
  private logMark: import("@xterm/xterm").IMarker | null = null;
  private logTimer: number | null = null;
  private lastCwd = "";
  private repeatSentAt = 0;
  private ackTimer: number | null = null;
  private fitFrame: number | null = null;
  private ptyTimer: number | null = null;
  private observer: ResizeObserver | null = null;
  private fitWaiting = false;
  private host: HTMLElement | null = null;
  private settings: Settings;
  /** Theme id last pushed to xterm (skips no-op theme writes). */
  private themeApplied: string | null = null;

  constructor(
    public source: SessionSource,
    settings: Settings,
    private onEvent: (ev: SessionEvent) => void,
  ) {
    this.settings = settings;
    this.term = new Terminal({
      fontFamily: settings.fontFamily,
      fontSize: settings.fontSize,
      lineHeight: settings.lineHeight,
      cursorBlink: settings.cursorBlink,
      cursorStyle: settings.cursorStyle,
      cursorWidth: 2,
      scrollback: settings.scrollback,
      allowProposedApi: true,
      allowTransparency: false,
      smoothScrollDuration: 80,
      macOptionIsMeta: true,
      theme: termTheme(settings),
    });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((e, uri) => {
        if (e.ctrlKey || e.metaKey) void openUrl(uri);
      }),
    );
    // Inline images: sixel and the iTerm2 protocol (imgcat, chafa, matplotlib backends…).
    this.term.loadAddon(new ImageAddon({ sixelSizeLimit: 25_000_000, storageLimit: 64, showPlaceholder: true }));
    this.blocks = new Blocks(this.term);
    // Only ConPTY (local shells on Windows) needs the cursor row kept fixed when lines
    // are folded/removed; everything else can simply move content up.
    this.blocks.keepCursorRow = source.kind === "local" && navigator.userAgent.includes("Windows");
    // History: remember every submitted command for this machine.
    this.blocks.onCommand((cmd) => addCommand(this.hostKey, cmd));
    this.term.onWriteParsed(() => this.refreshSuggest());
    this.term.onCursorMove(() => this.refreshSuggest());

    // OSC 7: shell reports its working directory (file://host/path).
    this.term.parser.registerOscHandler(7, (data) => {
      try {
        const url = new URL(data);
        let p = decodeURIComponent(url.pathname);
        // file:///C:/x on Windows -> C:\x (same form as OSC 9;9 and the file panel)
        if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, "\\");
        this.reportCwd(p);
      } catch {
        /* ignore */
      }
      return false;
    });
    // OSC 9;9: ConEmu / Windows Terminal style cwd report.
    this.term.parser.registerOscHandler(9, (data) => {
      if (data.startsWith("9;")) this.reportCwd(data.slice(2).replace(/^"|"$/g, ""));
      return false;
    });
    // Session log: record lines as *rendered*, not the raw byte stream (ConPTY paints
    // with cursor positioning, so neither raw bytes nor line-feed events are reliable).
    // Everything between the log marker and the cursor's line is considered final.
    this.term.onWriteParsed(() => {
      if (this.logging && this.logTimer === null)
        this.logTimer = window.setTimeout(() => this.flushLog(), 300);
    });

    this.term.onWriteParsed(() => {
      this.lastOutputAt = performance.now();
    });
    this.term.onData((d) => this.keyboard(d));
    this.term.onBinary((d) => this.keyboard(d));
    // The grid follows the layout every frame; the PTY / SSH side only gets the size once
    // it settles, so the shell isn't flooded with SIGWINCH (and prompt redraws) mid-animation.
    this.term.onResize(({ cols, rows }) => {
      if (this.ptyTimer !== null) clearTimeout(this.ptyTimer);
      this.ptyTimer = window.setTimeout(() => {
        this.ptyTimer = null;
        if (this.id) void ipc.resize(this.id, cols, rows);
      }, 90);
    });
    this.term.onSelectionChange(() => {
      if (this.settings.copyOnSelect && this.term.hasSelection())
        void navigator.clipboard.writeText(this.term.getSelection());
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));
  }

  /** When output was last written to the terminal (performance.now()). */
  lastOutputAt = 0;
  private keyListeners = new Set<(data: string) => void>();

  /** Keystrokes from the person at the keyboard (not agent / snippet input). */
  onUserKeys(fn: (data: string) => void) {
    this.keyListeners.add(fn);
    return () => this.keyListeners.delete(fn);
  }

  private keyboard(data: string) {
    for (const fn of this.keyListeners) fn(data);
    // Typing = text or Backspace. Anything else (arrows for history, Tab for the shell's
    // own completion, Ctrl+keys…) is not, and puts a passive popup away.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control keys
    this.typing = !/[\x00-\x08\x0a-\x1f]/.test(data.replace(/\x7f/g, "")) && !data.includes("\t");
    if (!this.typing && this.suggestion.popup) {
      if (this.suggestTimer !== null) clearTimeout(this.suggestTimer), (this.suggestTimer = null);
      this.suggestSeq++;
      this.setPopup(null);
    }
    this.input(data, true);
  }

  /** Input typed by the built-in agent: feeds block detection (so its commands become
   *  blocks) but is not mirrored to broadcast / input groups. */
  agentInput(data: string) {
    this.blocks.onUserInput(data);
    if (this.id) void ipc.write(this.id, data);
  }

  /** Send input to the backend. `user` input also feeds block detection + broadcast. */
  input(data: string, user = false) {
    if (user) {
      this.blocks.onUserInput(data);
      this.inputHook?.(data);
    }
    if (this.id) void ipc.write(this.id, data);
  }

  private reportCwd(p: string) {
    if (!p || p === this.lastCwd) return;
    this.lastCwd = p;
    this.onCwd?.(p);
  }

  setLogging(on: boolean) {
    if (!on) this.flushLog(true);
    this.logging = on;
    this.logMark?.dispose();
    this.logMark = on ? (this.term.registerMarker(0) ?? null) : null;
  }

  /** Append finished lines (log marker .. line above the cursor; `all`: up to the cursor). */
  private flushLog(all = false) {
    if (this.logTimer !== null) clearTimeout(this.logTimer);
    this.logTimer = null;
    const buf = this.term.buffer.normal;
    const mark = this.logMark;
    if (!mark || mark.isDisposed || !this.id) return;
    const cursor = buf.baseY + buf.cursorY;
    const end = all ? cursor : cursor - 1;
    let text = "";
    let line = "";
    for (let y = mark.line; y <= end; y++) {
      const l = buf.getLine(y);
      if (!l) continue;
      const next = buf.getLine(y + 1);
      const continues = !!next?.isWrapped && y + 1 <= end;
      line += l.translateToString(!continues);
      if (!continues) {
        text += `${line}\n`;
        line = "";
      }
    }
    if (text) void ipc.logAppend(this.id, text);
    // Move the marker to the first unlogged line.
    mark.dispose();
    this.logMark = this.term.registerMarker(Math.max(0, end + 1) - cursor) ?? null;
  }

  // ---------------------------------------------------------------- suggestions

  /**
   * Completion popup: history + commands + file paths for the word being typed. It shows
   * up after a short pause in typing (never while you browse history) and takes ↑↓ / Tab;
   * ↑ on the first entry closes it and goes on to the shell (previous history command).
   * Enter accepts only after you moved in the list. Ctrl+Space opens / closes it.
   */
  suggestion: { popup: { items: Completion[]; index: number; navigated: boolean; active: boolean } | null } = { popup: null };
  /** The last key from the keyboard was typing (text / Backspace), not navigation. */
  private typing = false;
  private suggestListeners = new Set<() => void>();
  private suggestTimer: number | null = null;
  private suggestSeq = 0;
  /** Input text for which the user dismissed the popup (Esc); stays closed until it changes. */
  private dismissedFor: string | null = null;
  private lastInputText = "";
  private manual = false;
  private dirCache = new Map<string, { at: number; entries: FsEntry[] }>();

  onSuggest(fn: () => void) {
    this.suggestListeners.add(fn);
    return () => this.suggestListeners.delete(fn);
  }

  private emitSuggest() {
    for (const fn of this.suggestListeners) fn();
  }

  /** History bucket for this session's machine. */
  get hostKey() {
    const src = this.source;
    if (src.kind === "local") return `local:${src.shell.id}`;
    if (src.kind === "ssh") return `ssh:${src.target.user}@${src.target.host}:${src.target.port}`;
    return `serial:${src.target.port}`;
  }

  private importHistory() {
    const src = this.source;
    if (src.kind === "local") {
      ensureImported(this.hostKey, () => ipc.historyLocal(src.shell.id));
      setTimeout(() => void this.commandList().catch(() => {}), 800);
    } else if (src.kind === "ssh") {
      const id = this.id;
      // Give SFTP a moment; the shell comes first.
      if (id) setTimeout(() => ensureImported(this.hostKey, () => ipc.historyRemote(id)), 1500);
      if (id) setTimeout(() => this.alive && void this.commandList().catch(() => {}), 2500);
    }
  }

  refreshSuggest() {
    if (this.suggestTimer !== null) clearTimeout(this.suggestTimer);
    // Passive suggestions wait for a pause in typing; an active popup follows at once.
    const delay = this.suggestion.popup || this.manual ? 60 : 300;
    this.suggestTimer = window.setTimeout(() => {
      this.suggestTimer = null;
      void this.computeSuggest();
    }, delay);
  }

  private setPopup(popup: TermSession["suggestion"]["popup"]) {
    if (popup === this.suggestion.popup) return;
    this.suggestion = { popup };
    this.emitSuggest();
  }

  private async computeSuggest() {
    const focused = !!this.term.textarea && document.activeElement === this.term.textarea;
    const st = this.settings.suggestions && this.alive && focused ? this.blocks.inputState() : null;
    // Only offer while you are typing: not when the line changed because you browsed
    // history (↑↓) or the shell redrew it.
    const showing = this.manual || !!this.suggestion.popup;
    if (!st || !st.atEnd || (!st.text && !this.manual) || (!showing && !this.typing)) {
      this.manual = false;
      this.lastInputText = st?.text ?? "";
      return this.setPopup(null);
    }
    const changed = st.text !== this.lastInputText;
    this.lastInputText = st.text;
    if (this.dismissedFor !== null) {
      if (st.text === this.dismissedFor) return;
      this.dismissedFor = null;
    }
    const seq = ++this.suggestSeq;
    const history: Completion[] = search(this.hostKey, st.text, 8)
      .filter((c) => c !== st.text)
      .map((c) => ({ kind: "history", label: c, replace: st.text.length, insert: c }));
    const [paths, commands] = await Promise.all([
      this.pathCompletions(st.text).catch(() => [] as Completion[]),
      this.commandCompletions(st.text).catch(() => [] as Completion[]),
    ]);
    if (seq !== this.suggestSeq) return; // input moved on while we were listing a directory
    const first = (st.text.split(/\s+/)[0] ?? "").toLowerCase();
    const pathFirst = PATH_COMMANDS.has(first) || /[\\/]/.test(st.text.split(/\s+/).at(-1) ?? "");
    const items = (
      commands.length
        ? // prefix history → command names → loose (fuzzy) history
          [
            ...history.filter((h) => h.insert.startsWith(st.text)).slice(0, 4),
            ...commands,
            ...history.filter((h) => !h.insert.startsWith(st.text)),
          ]
        : pathFirst
          ? [...paths, ...history]
          : [...history, ...paths]
    ).slice(0, 10);
    if (!items.length) {
      this.manual = false;
      return this.setPopup(null);
    }
    const prev = this.suggestion.popup;
    const keepIndex = prev && !changed ? Math.min(prev.index, items.length - 1) : 0;
    this.setPopup({ items, index: keepIndex, navigated: !!prev?.navigated && !changed, active: true });
  }

  private commandList(): Promise<string[]> {
    const key = this.hostKey;
    const hit = commandCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.list;
    const src = this.source;
    const id = this.id;
    const list =
      src.kind === "local"
        ? ipc.commandsLocal(src.shell.id, src.shell.program)
        : src.kind === "ssh" && id
          ? ipc.commandsRemote(id)
          : Promise.resolve([] as string[]);
    const entry = { at: Date.now(), list };
    commandCache.set(key, entry);
    list.catch(() => {
      if (commandCache.get(key) === entry) commandCache.delete(key);
    });
    return list;
  }

  /** Command names (PATH executables, shell built-ins) while typing the first word. */
  private async commandCompletions(text: string): Promise<Completion[]> {
    if (!/^\S+$/.test(text) || /[\\/~$=]/.test(text) || text.startsWith(".")) return [];
    const src = this.source;
    // Windows shells match case-insensitively; POSIX ones are case-sensitive.
    const ci = src.kind === "local" && navigator.userAgent.includes("Windows") && src.shell.id !== "wsl";
    const p = text.toLowerCase();
    const names = await this.commandList();
    return names
      .filter((n) => n.length > text.length && (ci ? n.toLowerCase().startsWith(p) : n.startsWith(text)))
      .sort((a, b) => a.length - b.length || a.localeCompare(b))
      .slice(0, 6)
      .map((n) => ({ kind: "command", label: n, replace: [...text].length, insert: n }) satisfies Completion);
  }

  /** File/dir completions for the last word, relative to the shell's directory. */
  private async pathCompletions(text: string): Promise<Completion[]> {
    const m = text.match(/(?:^|\s)((?:[^\s"']|\\ )*)$/);
    const token = m?.[1] ?? "";
    if (!token || /^-/.test(token) || text.trim() === token) return []; // only arguments
    const cwd = this.lastCwd;
    const src = this.source;
    if (!cwd) return [];
    const winLocal = src.kind === "local" && /^[A-Za-z]:/.test(cwd);
    if (src.kind === "local" && !winLocal && navigator.userAgent.includes("Windows")) return []; // WSL paths
    if (src.kind === "serial") return [];
    const sep = winLocal ? "\\" : "/";
    const cut = Math.max(token.lastIndexOf("/"), winLocal ? token.lastIndexOf("\\") : -1);
    const dirPart = cut >= 0 ? token.slice(0, cut + 1) : "";
    const prefix = token.slice(cut + 1);
    if (dirPart.startsWith("~")) return [];
    const absolute = winLocal ? /^[A-Za-z]:[\\/]/.test(dirPart) : dirPart.startsWith("/");
    const dir = absolute ? dirPart || sep : dirPart ? `${cwd.replace(/[\\/]+$/, "")}${sep}${dirPart}` : cwd;
    const target: FsTarget = src.kind === "ssh" && this.id ? { kind: "ssh", sessionId: this.id } : { kind: "local" };
    const key = `${target.kind}:${dir}`;
    let cached = this.dirCache.get(key);
    if (!cached || Date.now() - cached.at > 5000) {
      cached = { at: Date.now(), entries: (await ipc.fsList(target, dir)).entries };
      this.dirCache.set(key, cached);
    }
    const p = prefix.toLowerCase();
    return cached.entries
      .filter((e) => e.name.toLowerCase().startsWith(p) && (p.startsWith(".") || !e.name.startsWith(".")))
      .sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || a.name.localeCompare(b.name))
      .slice(0, 8)
      .map((e) => {
        const name = /\s/.test(e.name) ? e.name.replace(/ /g, "\\ ") : e.name;
        const isDir = e.kind === "dir";
        return {
          kind: isDir ? "dir" : "file",
          label: `${dirPart}${e.name}${isDir ? sep : ""}`,
          replace: token.length,
          insert: `${dirPart}${name}${isDir ? sep : " "}`,
        } satisfies Completion;
      });
  }

  /** Ctrl+Space: take over a passive popup, or open one right away. */
  openCompletions() {
    this.manual = true;
    this.dismissedFor = null;
    const p = this.suggestion.popup;
    if (p) this.setPopup({ ...p, active: true, index: 0 });
    else void this.computeSuggest();
    return true;
  }

  closeCompletions(dismiss = true) {
    if (!this.suggestion.popup) return;
    if (dismiss) this.dismissedFor = this.lastInputText;
    this.manual = false;
    this.setPopup(null);
  }

  /** Apply a completion: erase what it replaces, then type its text. */
  acceptCompletion(item: Completion | string) {
    const c: Completion =
      typeof item === "string"
        ? { kind: "history", label: item, replace: [...(this.blocks.inputState()?.text ?? "")].length, insert: item }
        : item;
    this.setPopup(null);
    this.manual = false;
    this.input("\x7f".repeat(c.replace) + c.insert, true);
    this.focus();
  }

  private moveCompletion(delta: number) {
    const p = this.suggestion.popup;
    if (!p) return;
    const index = (p.index + delta + p.items.length) % p.items.length;
    this.setPopup({ ...p, index, navigated: true });
  }

  get sessionId() {
    return this.id;
  }

  get alive() {
    return this.id !== null;
  }

  /** Mount into a DOM node. The first mount also starts the backend session. */
  attach(el: HTMLElement) {
    if (this.disposed) return;
    this.host = el;
    if (!this.opened) {
      this.term.open(el);
      this.opened = true;
      this.loadWebgl();
      el.addEventListener("contextmenu", this.onContextMenu);
      // Focus left the terminal (another pane, a panel, another window): drop the popup.
      this.term.textarea?.addEventListener("blur", () => {
        if (this.suggestTimer !== null) clearTimeout(this.suggestTimer), (this.suggestTimer = null);
        this.suggestSeq++;
        this.closeCompletions(false);
      });
      this.fitNow();
      void this.connect();
    } else if (this.term.element && this.term.element.parentElement !== el) {
      el.appendChild(this.term.element);
      this.fitNow();
    }
    this.observer?.disconnect();
    this.observer = new ResizeObserver(() => this.scheduleFit());
    this.observer.observe(el);
  }

  detach() {
    this.observer?.disconnect();
    this.observer = null;
  }

  focus() {
    this.term.focus();
  }

  applySettings(s: Settings) {
    this.settings = s;
    // Only touch options that changed: any settings write (even opening a side panel) lands
    // here, and re-setting the theme object makes xterm rebuild its glyph atlas and redraw.
    const o = this.term.options;
    let layout = false;
    const put = <K extends "fontFamily" | "fontSize" | "lineHeight" | "cursorStyle" | "cursorBlink" | "scrollback">(
      k: K,
      v: (typeof o)[K],
    ) => {
      if (o[k] === v) return;
      o[k] = v;
      if (k === "fontFamily" || k === "fontSize" || k === "lineHeight") layout = true;
    };
    put("fontFamily", s.fontFamily);
    put("fontSize", s.fontSize);
    put("lineHeight", s.lineHeight);
    put("cursorStyle", s.cursorStyle);
    put("cursorBlink", s.cursorBlink);
    put("scrollback", s.scrollback);
    const themeKey = `${s.theme}|${s.backdrop !== "none"}`;
    if (this.themeApplied !== themeKey) {
      o.theme = termTheme(s);
      this.themeApplied = themeKey;
    }
    if (layout) this.scheduleFit();
  }

  setHighlight(on: boolean) {
    if (this.id) void ipc.setHighlight(this.id, on);
  }

  /** (Re)start the backend, keeping the scrollback. */
  async connect() {
    if (this.disposed) return;
    const onData = new Channel<ArrayBuffer | number[]>();
    const onEvent = new Channel<SessionEvent>();
    onData.onmessage = (msg) => this.onData(msg);
    onEvent.onmessage = (ev) => {
      if (ev.type === "exit") this.id = null;
      if (ev.type === "connected" && this.source.kind === "ssh" && this.settings.sshAutoIntegration)
        void this.injectIntegration();
      if (ev.type === "connected") this.importHistory();
      this.onEvent(ev);
    };
    this.blocks.integrated = false; // a fresh shell has no hooks yet
    const { cols, rows } = this.term;
    const hl = this.settings.highlight;
    const src = this.source;
    try {
      this.id =
        src.kind === "local"
          ? await ipc.openLocal(src.shell, cols, rows, hl, onData, onEvent)
          : src.kind === "ssh"
            ? await ipc.openSsh(src.target, src.secret, src.jumpSecret, cols, rows, hl, onData, onEvent)
            : await ipc.openSerial(src.target, hl, onData, onEvent);
      if (this.disposed) void ipc.close(this.id);
      if (this.pendingHostKey !== null) {
        void ipc.hostKeyReply(this.id, this.pendingHostKey);
        this.pendingHostKey = null;
      }
    } catch (e) {
      this.onEvent({ type: "error", message: String(e) });
      this.onEvent({ type: "exit", code: null });
    }
  }

  /**
   * SSH + bash/zsh/fish: install the shell-integration hook once the first prompt is up.
   * Output is held back (not drawn) from the moment the hook line is typed until the
   * shell's first prompt mark comes back, so its echo never flashes on screen: the old
   * prompt row is then cleared and drawing resumes at the new prompt.
   */
  /** Install the prompt hook now (command folding, exit codes, cwd tracking), on request.
   *  Only at an idle prompt, so it can't answer some question the shell is asking. */
  enableIntegration(): string | null {
    if (this.source.kind !== "ssh") return "Only needed for SSH sessions — local shells are set up already.";
    if (!this.alive) return "Not connected.";
    if (this.blocks.integrated) return "Already enabled in this terminal.";
    const st = this.blocks.inputState();
    if (!st || st.text) return "Wait for an empty prompt first.";
    this.hold = { chunks: [], text: "", timer: window.setTimeout(() => this.releaseHold(-1), 5000) };
    this.input(`${POSIX_INTEGRATION}\r`);
    return null;
  }

  private async injectIntegration() {
    // Wait for the login banner / first prompt to settle.
    const t0 = performance.now();
    while (performance.now() - t0 < 8000) {
      await new Promise((r) => setTimeout(r, 150));
      if (!this.alive) return;
      if (this.lastDataAt && performance.now() - this.lastDataAt > 400) break;
    }
    if (!this.alive || this.blocks.integrated || this.term.buffer.active.type !== "normal") return;
    this.hold = { chunks: [], text: "", timer: window.setTimeout(() => this.releaseHold(-1), 5000) };
    this.input(`${POSIX_INTEGRATION}\r`);
  }

  /** Output held while the integration hook installs (see `injectIntegration`). */
  private hold: { chunks: Uint8Array[]; text: string; timer: number } | null = null;

  /** `at`: byte offset of the first prompt mark in the held output, or -1 (give up: show all). */
  private releaseHold(at: number) {
    const h = this.hold;
    if (!h) return;
    this.hold = null;
    clearTimeout(h.timer);
    const all = new Uint8Array(h.chunks.reduce((n, c) => n + c.byteLength, 0));
    let o = 0;
    for (const c of h.chunks) all.set(c, o), (o += c.byteLength);
    if (at < 0) {
      this.term.write(all);
      return;
    }
    // Wipe the old prompt row (the cursor is still on it), then draw from the new prompt.
    this.term.write("\r\x1b[2K");
    this.term.write(all.subarray(at));
  }

  private holdData(bytes: Uint8Array) {
    const h = this.hold!;
    h.chunks.push(bytes);
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    h.text += s;
    const d = h.text.indexOf("\x1b]133;D");
    const a = h.text.indexOf("\x1b]133;A");
    const at = d >= 0 && (a < 0 || d < a) ? d : a;
    if (at >= 0) this.releaseHold(at);
    else if (h.text.length > 256 * 1024) this.releaseHold(-1);
  }

  /** A host-key answer given before `openSsh` returned our id (fast servers): sent once it does. */
  private pendingHostKey: boolean | null = null;

  replyHostKey(accept: boolean) {
    if (this.id) void ipc.hostKeyReply(this.id, accept);
    else this.pendingHostKey = accept;
  }

  close() {
    if (this.id) void ipc.close(this.id);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.id) void ipc.close(this.id);
    this.id = null;
    this.detach();
    this.host?.removeEventListener("contextmenu", this.onContextMenu);
    this.term.dispose();
  }

  // ---------------------------------------------------------------- internals

  private onData(msg: ArrayBuffer | number[]) {
    this.lastDataAt = performance.now();
    const bytes = msg instanceof ArrayBuffer ? new Uint8Array(msg) : Uint8Array.from(msg);
    const n = bytes.byteLength;
    const id = this.id;
    if (this.hold) {
      this.holdData(bytes);
      if (id) {
        this.pendingAck += n;
        this.flushAck(id);
      }
      return;
    }
    // Ack after xterm has actually parsed the chunk: this is what drives backpressure.
    this.term.write(bytes, () => {
      if (!id) return;
      this.pendingAck += n;
      if (this.pendingAck >= ACK_BATCH) this.flushAck(id);
      else if (this.ackTimer === null)
        this.ackTimer = window.setTimeout(() => this.flushAck(id), ACK_IDLE_MS);
    });
  }

  private flushAck(id: string) {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
    if (this.pendingAck > 0) {
      void ipc.ack(id, this.pendingAck);
      this.pendingAck = 0;
    }
  }

  private loadWebgl() {
    try {
      const webgl = new WebglAddon();
      // Browsers cap live WebGL contexts; fall back to the DOM renderer if we lose ours.
      webgl.onContextLoss(() => webgl.dispose());
      this.term.loadAddon(webgl);
    } catch {
      /* DOM renderer fallback */
    }
  }

  scheduleFit() {
    // At most once per frame. While a side panel slides, don't refit at all: reflowing the
    // grid every frame is what made panel animations stutter. Refit once when it settles.
    if (this.fitFrame !== null || this.fitWaiting) return;
    if (layoutAnimating()) {
      this.fitWaiting = true;
      afterLayoutAnimation(() => {
        this.fitWaiting = false;
        this.scheduleFit();
      });
      return;
    }
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = null;
      this.fitNow();
    });
  }

  private fitNow() {
    const el = this.host;
    if (!el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
    const { cols, rows } = this.term;
    try {
      this.fit.fit();
    } catch {
      /* not visible yet */
    }
    if (this.term.cols !== cols || this.term.rows !== rows) this.renderNow();
  }

  /**
   * Draw the viewport right away. A resize clears the WebGL canvas and xterm only redraws
   * on the next frame — while a panel animates we resize every frame, so without this the
   * text would be blank for the whole animation.
   */
  private renderNow() {
    try {
      // biome-ignore lint/suspicious/noExplicitAny: xterm internals (no public sync render)
      const rs = (this.term as any)._core?._renderService;
      rs?._renderRows?.(0, this.term.rows - 1);
    } catch {
      /* the next scheduled frame draws it */
    }
  }

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    // Only Enter is paced on key repeat: it is what builds a backlog of prompts in a slow
    // shell. Other keys (Backspace, arrows, letters) repeat at full keyboard speed.
    if (e.repeat && this.alive && e.key === "Enter") {
      const now = performance.now();
      // Wait until output arrived *and* went quiet (prompt finished drawing), with a cap.
      const settled = this.lastDataAt > this.repeatSentAt && now - this.lastDataAt > 40;
      if (!settled && now - this.repeatSentAt < 1000) {
        e.preventDefault();
        return false;
      }
      this.repeatSentAt = now;
    }
    // Completion popup (VS Code style): ↑↓ select, Tab accepts, Enter accepts only after
    // you navigated (otherwise it runs what you typed), Esc dismisses, Ctrl+Space opens.
    const popup = this.suggestion.popup;
    const plain = !e.ctrlKey && !e.altKey && !e.metaKey;
    if (popup) {
      // ↑ on the first entry: you meant the shell's history — close and let it through.
      if (plain && e.key === "ArrowUp" && popup.index === 0) {
        this.closeCompletions();
        this.keyboard(this.term.modes.applicationCursorKeysMode ? "\x1bOA" : "\x1b[A");
        e.preventDefault();
        return false;
      }
      if (plain && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        this.moveCompletion(e.key === "ArrowDown" ? 1 : -1);
        e.preventDefault();
        return false;
      }
      if (plain && !e.shiftKey && (e.key === "Tab" || (e.key === "Enter" && popup.navigated))) {
        this.acceptCompletion(popup.items[popup.index]);
        e.preventDefault();
        return false;
      }
      if (e.key === "Escape") {
        this.closeCompletions();
        e.preventDefault();
        return false;
      }
      if (e.key === "Enter") this.closeCompletions(false);
    }
    if (e.ctrlKey && !e.shiftKey && !e.altKey && e.code === "Space") {
      if (popup) this.closeCompletions();
      else this.openCompletions();
      e.preventDefault();
      return false;
    }
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();
    // Ctrl+Backspace: delete the previous word (Ctrl+W / unix-word-rubout in bash, zsh,
    // fish; PowerShell gets the same binding from our shell integration).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "backspace") {
      this.input("\x17", true);
      e.preventDefault();
      return false;
    }
    // Ctrl+Delete: delete the next word (Alt+D / kill-word).
    if (e.ctrlKey && !e.shiftKey && !e.altKey && key === "delete") {
      this.input("\x1bd", true);
      e.preventDefault();
      return false;
    }
    // Copy: Ctrl+Shift+C always; Ctrl+C only when there's a selection (Windows Terminal style).
    if (mod && key === "c" && (e.shiftKey || this.term.hasSelection())) {
      if (this.term.hasSelection()) {
        void navigator.clipboard.writeText(this.term.getSelection());
        this.term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    if ((mod && e.shiftKey && key === "v") || (e.shiftKey && key === "insert")) {
      e.preventDefault();
      void this.paste();
      return false;
    }
    // Ctrl+Up / Ctrl+Down: jump between commands.
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (key === "arrowup" || key === "arrowdown")) {
      this.blocks.jump(key === "arrowup" ? -1 : 1);
      e.preventDefault();
      return false;
    }
    return true;
  }

  async paste() {
    const text = await navigator.clipboard.readText().catch(() => "");
    if (text) this.term.paste(text);
  }

  /** Right click: copy if there's a selection, otherwise paste (PuTTY / WindTerm style). */
  private onContextMenu = (e: MouseEvent) => {
    if (!this.settings.rightClickPaste) return;
    e.preventDefault();
    if (this.term.hasSelection()) {
      void navigator.clipboard.writeText(this.term.getSelection());
      this.term.clearSelection();
    } else {
      void this.paste();
    }
  };
}
