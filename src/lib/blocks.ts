// Command blocks, line numbers and folding for xterm.js.
//
// A "block" is one command: the line it was typed on plus its output, up to the next
// prompt. Detection uses OSC 133 shell-integration marks when the shell emits them
//   A = prompt starts, B = prompt ends / command input starts, D;n = previous exit code
// (injected automatically for PowerShell and for bash/zsh over SSH), and falls back to
// "Enter pressed at a prompt" for any other shell.
//
// Folding: xterm.js can't hide rows, so a fold *removes* the block's output lines from
// the buffer's line list and keeps them aside; unfolding splices them back. Markers
// shift automatically on insert/delete. This reaches into xterm internals (`_core`),
// all guarded so a future xterm change degrades to "no folding" instead of breaking.

import type { IMarker, Terminal } from "@xterm/xterm";

interface Fold {
  lines: unknown[];
  /** How many *logical* lines (not wrapped rows) the fold hides. */
  logical: number;
  padded: number;
}

export interface Block {
  /** First row of the command line. */
  marker: IMarker;
  /** The command text as typed (prompt stripped), if it could be read. */
  command: string;
  /** Start of the prompt that preceded the command (OSC 133;A), if known. */
  prompt: IMarker | null;
  /** Exit code reported by the shell (OSC 133;D), if any. */
  exitCode: number | null;
  /** First prompt printed after this command = where its output ends. */
  end: IMarker | null;
  fold: Fold | null;
  startedAt: number;
  /** Row the cursor was on when Enter was pressed = last row of the command, however the
   *  shell wrapped or redrew it. Output starts on the row after. */
  inputEnd: IMarker | null;
}

/** What the user is typing at the current prompt. */
export interface InputState {
  /** Text typed so far (prompt excluded). */
  text: string;
  /** Cursor is at the end of the input (suggestions only make sense there). */
  atEnd: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: xterm internals are untyped
type Any = any;

const live = (m: IMarker | null | undefined): m is IMarker => !!m && !m.isDisposed;

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching escape sequences
const TERMINAL_REPORT = /^(?:\x1b\[[\d;?>]*[Rcn]|\x1b\[[IO]|\x1b\][^]*|\x1bP[^]*|\x1b\[<[\d;]+[mM]|\x1b\[M[^]{3})+$/;

export class Blocks {
  readonly list: Block[] = [];
  /** True once the shell has emitted OSC 133 prompt marks. */
  integrated = false;
  /** Prompt printed but no command entered yet (OSC 133;A). */
  private pending: IMarker | null = null;
  /** Where command input starts at the current prompt (OSC 133;B). */
  private inputStart: { mark: IMarker; col: number } | null = null;
  private awaitD: Block | null = null;
  private listeners = new Set<() => void>();
  private promptListeners = new Set<(line: number) => void>();
  private commandListeners = new Set<(command: string, block: Block) => void>();
  // Fallback prompt detection: the line as it looked when output settled, before typing.
  private idle: { line: number; col: number; text: string } | null = null;
  /** Text of the most recent prompt line (any row) — catches empty Enters fast. */
  private lastPrompt = "";
  private idleArmed = true;
  private idleTimer: number | null = null;
  // Logical line numbering.
  private trimmed = 0;
  private version = 0;
  private lnCache = { abs: -1, count: 0, version: -1 };

  constructor(private term: Terminal) {
    term.parser.registerOscHandler(133, (data) => {
      if (this.term.buffer.active.type !== "normal") return false;
      const kind = data[0];
      if (kind === "A") {
        this.integrated = true;
        const last = this.list.at(-1);
        if (last && !last.end && live(last.marker)) {
          const end = this.term.registerMarker(0) ?? null;
          if (end && end.line > last.marker.line) last.end = end;
          else end?.dispose();
        }
        this.inputStart?.mark.dispose();
        this.inputStart = null;
        const m = this.term.registerMarker(0) ?? null;
        if (live(this.pending)) this.pending.dispose();
        this.pending = m;
        const line = m?.line ?? -1;
        for (const fn of this.promptListeners) fn(line);
        this.emit();
      } else if (kind === "B") {
        this.inputStart?.mark.dispose();
        const mark = this.term.registerMarker(0);
        this.inputStart = mark ? { mark, col: this.term.buffer.active.cursorX } : null;
      } else if (kind === "D") {
        // Exit code of the command entered at the previous prompt (if it was a block).
        const code = Number(data.split(";")[1]);
        if (this.awaitD && Number.isFinite(code)) this.awaitD.exitCode = code;
        this.awaitD = null;
        this.emit();
      }
      return false;
    });
    term.onWriteParsed(() => {
      if (!this.idleArmed) return;
      if (this.idleTimer !== null) clearTimeout(this.idleTimer);
      this.idleTimer = window.setTimeout(() => {
        this.idleTimer = null;
        if (!this.idleArmed) return;
        const buf = this.term.buffer.active;
        const line = buf.baseY + buf.cursorY;
        this.idle = { line, col: buf.cursorX, text: buf.getLine(line)?.translateToString(true) ?? "" };
        if (this.idle.text.trim()) this.lastPrompt = this.idle.text.trimEnd();
      }, 150);
    });
    // Reflow changes which rows are wrapped; trimming the scrollback shifts indices.
    term.onResize(() => this.version++);
    try {
      (term as Any)._core._bufferService.buffers.normal.lines.onTrim((n: number) => {
        this.trimmed += n;
        this.version++;
      });
    } catch {
      /* numbering just restarts after trims */
    }
  }

  onChange(fn: () => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Called with the absolute line whenever a new prompt starts (OSC 133;A). */
  onPrompt(fn: (line: number) => void) {
    this.promptListeners.add(fn);
    return () => this.promptListeners.delete(fn);
  }

  /** Called whenever a command is submitted (for history). */
  onCommand(fn: (command: string, block: Block) => void) {
    this.commandListeners.add(fn);
    return () => this.commandListeners.delete(fn);
  }

  private emit() {
    for (const fn of this.listeners) fn();
  }

  // ---------------------------------------------------------------- reading input

  /** Text of the logical line that contains row `y`, from column `col` of row `from`. */
  private logicalText(from: number, col: number, toRow: number) {
    const buf = this.term.buffer.normal;
    let end = toRow;
    while (buf.getLine(end + 1)?.isWrapped) end++;
    let text = "";
    for (let y = from; y <= end; y++) {
      const line = buf.getLine(y);
      if (!line) continue;
      text += line.translateToString(y === end, y === from ? col : 0);
    }
    return text;
  }

  /** The command being typed at the prompt, or null when not at a prompt. */
  inputState(): InputState | null {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return null;
    const cursor = buf.baseY + buf.cursorY;
    // `raw` = everything from the input start column (may begin with a space).
    let raw: string | null = null;
    let startRow = cursor;
    let startCol = 0;
    if (this.integrated) {
      if (!live(this.pending)) return null; // a command is running
      if (this.inputStart && live(this.inputStart.mark) && this.inputStart.mark.line <= cursor) {
        startRow = this.inputStart.mark.line;
        startCol = this.inputStart.col;
        raw = this.logicalText(startRow, startCol, cursor);
      }
    }
    if (raw === null) {
      // Fallback: strip the prompt as it looked before the user started typing.
      if (!this.idle || this.idle.line > cursor) return null;
      // Only the part left of where the cursor sat: a right prompt isn't part of it.
      const prompt = this.idle.text.slice(0, this.idle.col).trimEnd();
      const full = this.logicalText(this.idle.line, 0, cursor);
      if (!full.startsWith(prompt)) return null;
      startRow = this.idle.line;
      startCol = prompt.length;
      raw = full.slice(prompt.length);
    }
    // Cursor position relative to the input start (cells; fine for ASCII input).
    const offset = (cursor - startRow) * this.term.cols + buf.cursorX - startCol;
    // Shell-drawn predictions after the cursor (PSReadLine, zsh-autosuggestions) are
    // rendered dim/grey: they are not typed text.
    if (offset >= 0 && offset < raw.trimEnd().length && this.restIsDecoration(cursor, buf.cursorX)) raw = raw.slice(0, offset);
    const typedEnd = raw.trimEnd().length;
    return { text: raw.trim(), atEnd: offset >= typedEnd };
  }

  /**
   * True if what follows the cursor isn't typed text but shell decoration:
   *  - a right-aligned prompt (fish's status, zsh RPROMPT, p10k): separated from the
   *    cursor by a gap of blanks and reaching the right edge of the row, or
   *  - a dim/grey inline prediction (PSReadLine, zsh-autosuggestions).
   */
  private restIsDecoration(row: number, col: number) {
    const buf = this.term.buffer.active;
    const line = buf.getLine(row);
    if (line && !buf.getLine(row + 1)?.isWrapped) {
      const text = line.translateToString(false);
      const rest = text.slice(col);
      const lead = rest.length - rest.trimStart().length;
      const lastCol = text.trimEnd().length;
      if (rest.trim() && lead >= 2 && lastCol >= this.term.cols - 3) return true;
    }
    return this.restIsDim(row, col);
  }

  /** True if every visible cell after the cursor (to the end of the logical line) is dim. */
  private restIsDim(row: number, col: number) {
    const buf = this.term.buffer.active;
    const cell = buf.getNullCell();
    let y = row;
    let x = col;
    for (;;) {
      const line = buf.getLine(y);
      if (!line) break;
      for (; x < line.length; x++) {
        line.getCell(x, cell);
        const ch = cell.getChars();
        if (ch && ch !== " " && !cell.isDim() && !cell.isItalic() && cell.getFgColor() !== 8 && !(cell.isFgPalette() && cell.getFgColor() === 8))
          return false;
      }
      if (!buf.getLine(y + 1)?.isWrapped) break;
      y++;
      x = 0;
    }
    return true;
  }

  /** Called with every chunk of user input. */
  onUserInput(data: string) {
    const buf = this.term.buffer.active;
    if (buf.type !== "normal") return;
    // Replies the terminal sends by itself (cursor position / device reports, focus
    // events, OSC/DCS answers, mouse reports) travel the same channel as keystrokes.
    if (TERMINAL_REPORT.test(data)) return;
    if (!data.includes("\r")) {
      // The user started typing: the prompt snapshot is final.
      this.idleArmed = false;
      return;
    }
    const cursor = buf.baseY + buf.cursorY;
    if (this.integrated && (!live(this.pending) || this.pending.line > cursor)) return; // no prompt waiting
    const input = this.inputState();
    const lineText = buf.getLine(cursor)?.translateToString(true).trimEnd() ?? "";
    if ((input && !input.text.trim()) || (!input && this.lastPrompt && lineText === this.lastPrompt)) {
      // Enter on an empty prompt: not a command. The shell prints a new prompt.
      this.idleArmed = true;
      this.idle = null;
      return;
    }
    // The block starts at the first row of the command (it may have wrapped).
    let row = cursor;
    if (this.inputStart && live(this.inputStart.mark) && this.inputStart.mark.line <= cursor) row = this.inputStart.mark.line;
    else if (this.idle && this.idle.line <= cursor) row = this.idle.line;
    this.mark(row, cursor, input?.text.trim() ?? "");
  }

  private mark(row: number, cursor: number, command: string) {
    this.idleArmed = true;
    this.idle = null;
    this.inputStart?.mark.dispose();
    this.inputStart = null;
    const last = this.list.at(-1);
    if (last && live(last.marker) && last.marker.line >= row) return;
    const marker = this.term.registerMarker(row - cursor);
    if (!marker) return;
    const prompt = live(this.pending) && this.pending.line <= row ? this.pending : null;
    if (live(this.pending) && !prompt) this.pending.dispose();
    this.pending = null;
    const inputEnd = cursor > row ? (this.term.registerMarker(0) ?? null) : null;
    const block: Block = { marker, command, prompt, exitCode: null, end: null, fold: null, startedAt: Date.now(), inputEnd };
    marker.onDispose(() => {
      const i = this.list.indexOf(block);
      if (i >= 0) this.list.splice(i, 1);
      if (live(block.prompt)) block.prompt.dispose();
      if (live(block.end)) block.end.dispose();
      if (live(block.inputEnd)) block.inputEnd.dispose();
      this.emit();
    });
    this.list.push(block);
    this.awaitD = block;
    if (command) for (const fn of this.commandListeners) fn(command, block);
    this.emit();
  }

  /**
   * Absolute line range [start, end] of block i's *output* (excludes the command line
   * and the next prompt). Null while the command is still running.
   */
  range(i: number): { start: number; end: number } | null {
    const b = this.list[i];
    if (!b || !live(b.marker)) return null;
    const buf = this.term.buffer.normal;
    // Output starts after the (possibly wrapped) command line.
    // Output starts after the command's last row: where the cursor was at Enter (a long
    // command the shell redrew itself isn't marked as soft-wrapped, so don't rely on that).
    let start = live(b.inputEnd) ? b.inputEnd.line + 1 : b.marker.line + 1;
    while (buf.getLine(start)?.isWrapped) start++;
    const next = this.list[i + 1];
    let stop: number | null = null;
    if (live(b.end)) stop = b.end.line;
    else if (next && live(next.marker)) stop = live(next.prompt) ? next.prompt.line : next.marker.line;
    else if (!next && live(this.pending) && this.pending.line > b.marker.line) stop = this.pending.line;
    if (stop === null) return null;
    let end = stop - 1;
    if (!this.integrated) {
      // No prompt marks: at least keep trailing blank separator lines out of the fold.
      while (end >= start && (buf.getLine(end)?.translateToString(true).trim() ?? "") === "") end--;
    }
    return { start, end };
  }

  /**
   * Delete buffer lines [start, end] (all above the cursor) for good, keeping the
   * cursor's screen row — same invariant as folding, so the PTY's view stays valid.
   */
  removeLines(start: number, end: number) {
    const buf = this.normalBuf();
    if (!buf || end < start || end >= buf.ybase + buf.y) return;
    this.cut(buf, start, end - start + 1);
    buf.ydisp = buf.ybase;
    this.version++;
    this.sync();
  }

  /**
   * When true, cutting/inserting lines keeps the cursor on the same *screen row* and
   * pads the top of the buffer instead. Needed for ConPTY (local Windows shells), which
   * addresses the screen with absolute coordinates. Remote shells (SSH, serial) use
   * relative cursor movement, so content can simply move up — no blank rows on top.
   */
  keepCursorRow = true;

  private normalBuf(): Any | null {
    const core: Any = (this.term as Any)._core;
    const buf: Any = core?._bufferService?.buffer;
    if (!buf?.lines?.splice || buf !== core._bufferService.buffers?.normal) return null;
    return buf;
  }

  /** Remove `count` rows at `start` (above the cursor). Returns the top padding added. */
  private cut(buf: Any, start: number, count: number) {
    const rows = this.term.rows;
    const cursorAbs = buf.ybase + buf.y;
    buf.lines.splice(start, count);
    let pad = 0;
    if (this.keepCursorRow) {
      pad = Math.max(0, rows - buf.lines.length);
      if (pad > 0) {
        buf.lines.splice(0, 0, ...Array.from({ length: pad }, () => buf.getBlankLine(buf.getNullCell())));
        this.topPad += pad;
      }
      buf.ybase = buf.lines.length - rows;
    } else {
      // Content moves up with the cursor; keep the screen region full with blank rows
      // *below* the cursor.
      while (buf.lines.length < rows) buf.lines.push(buf.getBlankLine(buf.getNullCell()));
      buf.ybase = Math.max(0, buf.lines.length - rows);
      buf.y = Math.max(0, Math.min(rows - 1, cursorAbs - count - buf.ybase));
    }
    return pad;
  }

  /** Insert `lines` at row `at` (above the cursor). Returns rows trimmed + padding removed. */
  private insert(buf: Any, at: number, lines: Any[]) {
    const rows = this.term.rows;
    const cursorAbs = buf.ybase + buf.y;
    const before = buf.lines.length;
    buf.lines.splice(at, 0, ...lines);
    // CircularList trims from the top when it hits max scrollback.
    const trimmed = before + lines.length - buf.lines.length;
    let removed = 0;
    if (this.keepCursorRow) {
      this.topPad = Math.max(0, this.topPad - trimmed);
      // Take back top padding that is no longer needed.
      while (this.topPad > 0 && buf.lines.length > rows && buf.lines.get(0)?.translateToString?.(true) === "") {
        buf.lines.splice(0, 1);
        this.topPad--;
        removed++;
      }
      buf.ybase = Math.max(0, buf.lines.length - rows);
    } else {
      const cursor = cursorAbs + lines.length - trimmed;
      // Drop blank rows below the cursor that only padded the screen.
      while (buf.lines.length > rows && buf.lines.length - 1 > cursor && buf.lines.get(buf.lines.length - 1)?.translateToString?.(true) === "")
        buf.lines.pop();
      buf.ybase = Math.max(0, buf.lines.length - rows);
      buf.y = Math.max(0, Math.min(rows - 1, cursor - buf.ybase));
    }
    return trimmed + removed;
  }

  // ---------------------------------------------------------------- line numbers

  /** Number of logical lines (rows that don't continue a wrapped line) before `abs`. */
  private logicalBefore(abs: number) {
    const buf = this.term.buffer.normal;
    const c = this.lnCache;
    let y = 0;
    let count = 0;
    if (c.version === this.version && c.abs >= 0 && c.abs <= abs) {
      y = c.abs;
      count = c.count;
    }
    for (; y < abs; y++) if (!buf.getLine(y)?.isWrapped) count++;
    this.lnCache = { abs, count, version: this.version };
    return count;
  }

  /**
   * Line number of buffer row `abs`: counts logical lines (a long line wrapped over
   * several rows gets one number), includes folded and trimmed lines, excludes the
   * blank padding folds add. Null for wrapped continuation rows and padding.
   */
  lineNumber(abs: number) {
    if (abs < this.topPad) return null;
    if (this.term.buffer.normal.getLine(abs)?.isWrapped) return null;
    return this.trimmed + this.logicalBefore(abs) - this.topPad + this.hiddenBefore(abs) + 1;
  }

  /** Total number of logical lines (for sizing the gutter). */
  totalLines() {
    const buf = this.term.buffer.normal;
    return this.trimmed + this.logicalBefore(buf.length) - this.topPad + this.hiddenBefore(Number.MAX_SAFE_INTEGER);
  }

  /** Logical lines hidden by folds strictly above absolute row `abs`. */
  hiddenBefore(abs: number) {
    let n = 0;
    for (const b of this.list) {
      if (b.fold && b.marker.line < abs) n += b.fold.logical;
    }
    return n;
  }

  blockAt(abs: number) {
    return this.list.findIndex((b) => !b.marker.isDisposed && b.marker.line === abs);
  }

  canFold(i: number) {
    const r = this.range(i);
    return !!r && r.end >= r.start;
  }

  toggle(i: number) {
    const b = this.list[i];
    if (!b) return;
    if (b.fold) this.unfold(i);
    else this.fold(i);
  }

  // Invariant kept by fold/unfold: the cursor's *screen row* (buf.y) never changes and
  // the buffer bottom stays aligned with the screen bottom (ybase = length - rows).
  // The PTY (ConPTY especially) addresses the screen with absolute coordinates, so
  // moving the cursor row would make later output land in the wrong place. When a
  // fold leaves fewer lines than the screen holds, blank rows are inserted at the very
  // top of the buffer (`topPad`) and taken back out on unfold.

  /** Blank rows inserted at the top of the buffer by folds (excluded from numbering). */
  topPad = 0;

  fold(i: number) {
    const b = this.list[i];
    const r = this.range(i);
    if (!b || b.fold || !r || r.end < r.start) return;
    const buf = this.normalBuf();
    if (!buf) return;

    const count = r.end - r.start + 1;
    if (r.end >= buf.ybase + buf.y) return; // never fold what the cursor is still writing into

    const lines: Any[] = [];
    for (let l = r.start; l <= r.end; l++) lines.push(buf.lines.get(l));
    const logical = lines.filter((l) => !l.isWrapped).length;
    const ydisp = buf.ydisp;
    const pad = this.cut(buf, r.start, count);
    buf.ydisp = Math.min(buf.ybase, Math.max(0, (ydisp > r.start ? ydisp - count : ydisp) + pad));

    b.fold = { lines, logical, padded: pad };
    this.version++;
    this.sync();
  }

  unfold(i: number) {
    const b = this.list[i];
    if (!b?.fold) return;
    const buf = this.normalBuf();
    if (!buf) return;

    const { lines } = b.fold;
    b.fold = null;
    const cols = this.term.cols;
    const nullCell = buf.getNullCell();
    for (const line of lines as Any[]) {
      if (line.length !== cols) line.resize(cols, nullCell);
    }
    let at = b.marker.line + 1;
    while (buf.lines.get(at)?.isWrapped) at++;
    const ydisp = buf.ydisp;
    const shifted = this.insert(buf, at, lines as Any[]);
    buf.ydisp = Math.min(buf.ybase, Math.max(0, (ydisp >= at ? ydisp + lines.length : ydisp) - shifted));
    this.version++;
    this.sync();
  }

  foldAll() {
    for (let i = 0; i < this.list.length; i++) if (!this.list[i].fold) this.fold(i);
  }

  unfoldAll() {
    for (let i = this.list.length - 1; i >= 0; i--) if (this.list[i].fold) this.unfold(i);
  }

  /** Plain text of block i: command line + output (folded content included). */
  text(i: number) {
    const b = this.list[i];
    if (!b) return "";
    const buf = this.term.buffer.active;
    const out: string[] = [buf.getLine(b.marker.line)?.translateToString(true) ?? ""];
    if (b.fold) {
      for (const l of b.fold.lines as Any[]) out.push(l.translateToString(true));
    } else {
      const r = this.range(i);
      if (r) for (let l = r.start; l <= r.end; l++) out.push(buf.getLine(l)?.translateToString(true) ?? "");
    }
    return out.join("\n").replace(/\n+$/, "");
  }

  /** Scroll to the previous/next command line relative to the viewport top. */
  jump(dir: -1 | 1) {
    const top = this.term.buffer.active.viewportY;
    const lines = this.list.filter((b) => !b.marker.isDisposed).map((b) => b.marker.line);
    const target = dir < 0 ? lines.filter((l) => l < top).at(-1) : lines.find((l) => l > top);
    if (target !== undefined) this.term.scrollToLine(target);
  }

  private sync() {
    const core: Any = (this.term as Any)._core;
    try {
      core._viewport?.queueSync?.();
      core.refresh?.(0, this.term.rows - 1);
      core._onScroll?.fire?.({ position: core._bufferService.buffer.ydisp });
    } catch {
      /* ignore */
    }
    this.emit();
  }
}
