// Line-number + fold gutter for one terminal (WindTerm style), plus the per-command
// badges (exit code / duration / start time; click to copy the output) and the sticky
// header that keeps the command of the output on screen in view.
import {
  Check,
  ChevronDown,
  ChevronRight,
  ClipboardCopy,
  Copy,
  CornerLeftUp,
  FoldVertical,
  TerminalSquare,
  UnfoldVertical,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { Block } from "@/lib/blocks";
import type { BlockBadges } from "@/lib/settings";
import type { TermSession } from "@/lib/term-session";
import { cn, fmtDuration } from "@/lib/utils";
import { useApp } from "@/store/app";

// biome-ignore lint/suspicious/noExplicitAny: xterm internals
type Any = any;

interface Row {
  key: number;
  abs: number;
  num: number | null;
  block: number; // index into blocks.list, -1 if not a command line
  folded: number; // lines hidden under this command line
  failed: boolean; // command exited non-zero (OSC 133;D)
  canFold: boolean;
  /** Command rows: exit code, timing, and how many cells of text the row holds. */
  exit: number | null;
  started: number;
  finished: number | null;
  textEnd: number;
}

interface Sticky {
  block: number;
  text: string;
}

export function gutterWidth(session: TermSession, lineNumbers: boolean) {
  if (!lineNumbers) return 16;
  const total = session.blocks.totalLines();
  return Math.max(3, String(total).length) * 7.4 + 24;
}

const sameRow = (a: Row, b: Row) =>
  a.key === b.key &&
  a.abs === b.abs &&
  a.num === b.num &&
  a.block === b.block &&
  a.folded === b.folded &&
  a.failed === b.failed &&
  a.canFold === b.canFold &&
  a.exit === b.exit &&
  a.started === b.started &&
  a.finished === b.finished &&
  a.textEnd === b.textEnd;


const fmtTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

const blockRowFields = (b: Block | undefined) => ({
  exit: b?.exitCode ?? null,
  started: b?.startedAt ?? 0,
  finished: b?.finishedAt ?? null,
});

// Memoized (and so are its rows): it re-renders on terminal output / scroll only when the
// visible numbers actually change, and not at all when the surrounding layout re-renders.
export const Gutter = memo(function Gutter({
  session,
  lineNumbers,
  width,
}: {
  session: TermSession;
  lineNumbers: boolean;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const badges = useApp((s) => s.settings.blockBadges);
  const stickyOn = useApp((s) => s.settings.stickyCommand);
  const [rows, setRows] = useState<Row[]>([]);
  const [geom, setGeom] = useState({ top: 6, left: 0, cell: 17, cellW: 8, paneW: 0 });
  const [hover, setHover] = useState<number | null>(null);
  /** Command row under the mouse in the terminal itself (reveals its badge). */
  const [hot, setHot] = useState(-1);
  const [flash, setFlash] = useState<number | null>(null);
  const [sticky, setSticky] = useState<Sticky | null>(null);
  const [menuRow, setMenuRow] = useState<Row | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const { term, blocks } = session;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const el = ref.current;
      const core: Any = (term as Any)._core;
      const css = core?._renderService?.dimensions?.css?.cell;
      const cell: number = css?.height || 0;
      const cellW: number = css?.width || 0;
      const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (el && screen && cell) {
        const er = el.getBoundingClientRect();
        const sr = screen.getBoundingClientRect();
        const top = sr.top - er.top;
        const left = sr.left - er.left;
        const paneW = el.parentElement?.clientWidth ?? 0;
        setGeom((g) =>
          g.top === top && g.left === left && g.cell === cell && g.cellW === cellW && g.paneW === paneW
            ? g
            : { top, left, cell, cellW, paneW },
        );
      }
      const buf = term.buffer.active;
      if (buf.type !== "normal") {
        setSticky(null);
        return setRows([]);
      }
      const next: Row[] = [];
      const cursorAbs = buf.baseY + buf.cursorY;
      for (let r = 0; r < term.rows; r++) {
        const abs = buf.viewportY + r;
        if (abs > cursorAbs) {
          // Empty screen rows below the cursor don't get numbers.
          next.push({ key: r, abs, num: null, block: -1, folded: 0, canFold: false, failed: false, exit: null, started: 0, finished: null, textEnd: 0 });
          continue;
        }
        const line = buf.getLine(abs);
        const block = blocks.blockAt(abs);
        const b = block >= 0 ? blocks.list[block] : undefined;
        next.push({
          key: r,
          abs,
          num: line && !line.isWrapped ? blocks.lineNumber(abs) : null,
          block,
          folded: b?.fold ? b.fold.lines.length : 0,
          canFold: block >= 0 && (!!b?.fold || blocks.canFold(block)),
          failed: !!b && b.exitCode !== null && b.exitCode !== 0,
          ...blockRowFields(b),
          textEnd: b && line ? line.translateToString(true).length : 0,
        });
      }
      setRows((prev) => (prev.length === next.length && prev.every((r, i) => sameRow(r, next[i])) ? prev : next));

      // Sticky header: the screen's top row is output of a command whose own line scrolled away.
      let st: Sticky | null = null;
      const vy = buf.viewportY;
      if (vy > 0) {
        const i = blocks.blockCovering(vy);
        const b = i >= 0 ? blocks.list[i] : undefined;
        if (b && !b.marker.isDisposed && b.marker.line < vy)
          st = { block: i, text: buf.getLine(b.marker.line)?.translateToString(true) ?? b.command };
      }
      setSticky((prev) => (prev?.block === st?.block && prev?.text === st?.text ? prev : st));
    };
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    const subs = [
      term.onRender(schedule),
      term.onScroll(schedule),
      term.onResize(schedule),
      term.buffer.onBufferChange(schedule),
    ];
    const off = blocks.onChange(schedule);
    let flashTimer = 0;
    const offFlash = blocks.onFlash((i) => {
      setFlash(i);
      clearTimeout(flashTimer);
      flashTimer = window.setTimeout(() => setFlash(null), 900);
    });

    // Which command row is under the mouse (badges that would cover text show on hover).
    let moveRaf = 0;
    let lastY = 0;
    const onMove = (e: MouseEvent) => {
      lastY = e.clientY;
      if (moveRaf) return;
      moveRaf = requestAnimationFrame(() => {
        moveRaf = 0;
        const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
        const core: Any = (term as Any)._core;
        const cell: number = core?._renderService?.dimensions?.css?.cell?.height || 0;
        if (!screen || !cell) return;
        const r = Math.floor((lastY - screen.getBoundingClientRect().top) / cell);
        const abs = term.buffer.active.viewportY + r;
        setHot(r >= 0 && r < term.rows ? blocks.blockAt(abs) : -1);
      });
    };
    const onLeave = () => setHot(-1);
    const host = term.element;
    host?.addEventListener("mousemove", onMove);
    host?.addEventListener("mouseleave", onLeave);
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(moveRaf);
      clearTimeout(flashTimer);
      for (const s of subs) s.dispose();
      off();
      offFlash();
      host?.removeEventListener("mousemove", onMove);
      host?.removeEventListener("mouseleave", onLeave);
    };
  }, [session]);

  // Running commands on screen: tick once a second so their elapsed time moves.
  const running = badges.duration && rows.some((r) => r.block >= 0 && r.finished === null && r.started > 0);
  const stickyRunning = badges.duration && sticky && session.blocks.list[sticky.block]?.finishedAt === null;
  useEffect(() => {
    if (!running && !stickyRunning) return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [running, stickyRunning]);

  // Block highlight band (rows covered by the hovered / just-jumped-to block).
  const bandBlock = hover ?? flash;
  const band = (() => {
    if (bandBlock === null) return null;
    const r = session.blocks.range(bandBlock);
    const start = session.blocks.list[bandBlock]?.marker.line;
    if (start === undefined) return null;
    const end = r ? r.end : start;
    const vy = session.term.buffer.active.viewportY;
    const a = Math.max(start, vy) - vy;
    const b = Math.min(end, vy + session.term.rows - 1) - vy;
    if (b < a) return null;
    return { top: geom.top + a * geom.cell, height: (b - a + 1) * geom.cell };
  })();

  const rowAt = (clientY: number) => {
    const el = ref.current;
    if (!el) return null;
    const y = clientY - el.getBoundingClientRect().top - geom.top;
    return rows[Math.floor(y / geom.cell)] ?? null;
  };

  const blocks = session.blocks;
  const onHover = useCallback((block: number) => setHover(block >= 0 ? block : null), []);
  const onToggle = useCallback(
    (block: number) => {
      session.blocks.toggle(block);
      session.focus();
    },
    [session],
  );
  const menuBlock = menuRow && menuRow.block >= 0 ? blocks.list[menuRow.block] : undefined;
  const termFont = { fontFamily: session.term.options.fontFamily, fontSize: session.term.options.fontSize };

  return (
    <>
      {band && (
        <div
          className={cn(
            "pointer-events-none absolute right-0 z-[1] rounded-sm bg-primary/[0.07] ring-1 ring-primary/20 ring-inset transition-all duration-100",
            hover === null && "animate-[fade-out_0.9s_ease-in_forwards]",
          )}
          style={{ left: width, top: band.top, height: band.height }}
        />
      )}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={ref}
            onContextMenu={(e) => setMenuRow(rowAt(e.clientY))}
            onMouseLeave={() => setHover(null)}
            className="absolute top-0 bottom-0 left-0 overflow-hidden font-mono text-[11px] tabular-nums select-none"
            style={{ width }}
          >
            {rows.map((row) => (
              <GutterRow
                key={row.key}
                row={row}
                top={geom.top + row.key * geom.cell}
                cell={geom.cell}
                lineNumbers={lineNumbers}
                onHover={onHover}
                onToggle={onToggle}
              />
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuRow && menuBlock ? (
            <>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(blocks.output(menuRow.block))}>
                <Copy /> Copy output
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!menuBlock.command}
                onSelect={() => void navigator.clipboard.writeText(menuBlock.command)}
              >
                <TerminalSquare /> Copy command
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(blocks.text(menuRow.block))}>
                <ClipboardCopy /> Copy command + output
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!menuRow.canFold} onSelect={() => blocks.toggle(menuRow.block)}>
                {menuRow.folded ? <UnfoldVertical /> : <FoldVertical />}
                {menuRow.folded ? "Unfold output" : "Fold output"}
              </ContextMenuItem>
            </>
          ) : null}
          <ContextMenuItem onSelect={() => blocks.foldAll()}>
            <FoldVertical /> Fold all
          </ContextMenuItem>
          <ContextMenuItem onSelect={() => blocks.unfoldAll()}>
            <UnfoldVertical /> Unfold all
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {/* Right edge of each command row: "N lines folded" + the badge. */}
      {rows
        .filter((r) => r.block >= 0 && !(stickyOn && sticky && r.key === 0))
        .map((r) => {
          const fields = badgeFields(badges, r.exit, r.started, r.finished, blocks.integrated);
          // Would the badge sit on top of the row's text? Then only show it on hover.
          const badgePx = fields.reduce((n, f) => n + f.text.length, 0) * 6.3 + fields.length * 10 + 26;
          const textPx = geom.left + r.textEnd * geom.cellW;
          const crowded = textPx + 16 > geom.paneW - 14 - badgePx - (r.folded ? 120 : 0);
          const show = r.folded > 0 || ((hot === r.block || hover === r.block) ? true : fields.length > 0 && !crowded);
          if (!show) return null;
          return (
            <div
              key={`badge-${r.abs}`}
              className="absolute right-3 z-[20] flex items-center gap-1"
              style={{ top: geom.top + r.key * geom.cell + 1, height: geom.cell - 2 }}
              onMouseEnter={() => setHot(r.block)}
            >
              {r.folded > 0 && (
                <button
                  type="button"
                  onClick={() => blocks.toggle(r.block)}
                  className="flex h-full items-center gap-1 rounded-full border border-primary/25 bg-[color-mix(in_oklab,var(--primary)_14%,var(--surface))] px-2 text-[10.5px] text-primary transition hover:bg-[color-mix(in_oklab,var(--primary)_24%,var(--surface))]"
                >
                  <UnfoldVertical className="size-3" />
                  {r.folded} lines folded
                </button>
              )}
              <Badge
                session={session}
                block={r.block}
                fields={fields}
                expanded={hot === r.block || hover === r.block}
                hidden={crowded && hot !== r.block && hover !== r.block}
              />
            </div>
          );
        })}

      {/* Sticky header: the command whose output fills the screen. */}
      {stickyOn && sticky && (
        <StickyHeader
          session={session}
          sticky={sticky}
          badges={badges}
          top={geom.top}
          gutter={width}
          lineNumbers={lineNumbers}
          textLeft={geom.left - width}
          cell={geom.cell}
          font={termFont}
        />
      )}
    </>
  );
});

interface Field {
  key: string;
  text: string;
  tone: "ok" | "fail" | "muted" | "run";
}

function badgeFields(
  badges: BlockBadges,
  exit: number | null,
  started: number,
  finished: number | null,
  integrated: boolean,
): Field[] {
  const out: Field[] = [];
  if (badges.exitCode && exit !== null) out.push({ key: "exit", text: exit === 0 ? "" : String(exit), tone: exit === 0 ? "ok" : "fail" });
  else if (badges.exitCode && exit === null && finished !== null && integrated) out.push({ key: "exit", text: "", tone: "ok" });
  if (badges.duration && started > 0) {
    if (finished !== null) out.push({ key: "dur", text: fmtDuration(finished - started), tone: "muted" });
    else out.push({ key: "dur", text: fmtDuration(Date.now() - started), tone: "run" });
  }
  if (badges.startTime && started > 0) out.push({ key: "time", text: fmtTime(started), tone: "muted" });
  return out;
}

/** Exit code · duration · start time; click copies the output (Shift: with the command). */
function Badge({
  session,
  block,
  fields,
  expanded,
  hidden,
}: {
  session: TermSession;
  block: number;
  fields: Field[];
  expanded: boolean;
  hidden?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  if (hidden) return null;
  const copy = (withCommand: boolean) => {
    const text = withCommand ? session.blocks.text(block) : session.blocks.output(block);
    void navigator.clipboard.writeText(text);
    setCopied(true);
  };
  return (
    <Tooltip content={copied ? "Copied" : "Copy output · Shift+click: with the command"} side="left">
      <button
        type="button"
        tabIndex={-1}
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          copy(e.shiftKey);
          session.focus();
        }}
        className={cn(
          "flex h-full items-center gap-1.5 rounded-full border px-1.5 font-sans text-[10.5px] tabular-nums leading-none transition-colors",
          "border-ov/10 bg-[color-mix(in_oklab,var(--surface)_86%,transparent)] text-muted-foreground",
          "hover:border-primary/30 hover:text-foreground",
          copied && "border-success/40 text-success",
        )}
      >
        {fields.map((f) => (
          <span
            key={f.key}
            className={cn(
              "flex items-center gap-0.5",
              f.tone === "ok" && "text-success",
              f.tone === "fail" && "font-medium text-destructive",
              f.tone === "run" && "text-primary",
            )}
          >
            {f.key === "exit" && (f.tone === "ok" ? <Check className="size-3" /> : <X className="size-3" />)}
            {f.tone === "run" && <span className="size-1.5 animate-pulse rounded-full bg-primary" />}
            {f.text}
          </span>
        ))}
        {(expanded || copied || fields.length === 0) &&
          (copied ? <Check className="size-3" /> : <Copy className="size-3 opacity-80" />)}
      </button>
    </Tooltip>
  );
}

function StickyHeader({
  session,
  sticky,
  badges,
  top,
  gutter,
  lineNumbers,
  textLeft,
  cell,
  font,
}: {
  session: TermSession;
  sticky: Sticky;
  badges: BlockBadges;
  top: number;
  gutter: number;
  lineNumbers: boolean;
  textLeft: number;
  cell: number;
  font: { fontFamily?: string; fontSize?: number };
}) {
  const [hot, setHot] = useState(false);
  const b = session.blocks.list[sticky.block];
  if (!b) return null;
  const fields = badgeFields(badges, b.exitCode, b.startedAt, b.finishedAt, session.blocks.integrated);
  return (
    <div
      className="absolute right-0 z-[19] flex cursor-pointer items-center border-b border-ov/10 bg-[color-mix(in_oklab,var(--surface)_94%,transparent)] shadow-[0_4px_10px_-6px_var(--shadow)] backdrop-blur-sm"
      style={{ top, left: 0, height: cell }}
      onMouseEnter={() => setHot(true)}
      onMouseLeave={() => setHot(false)}
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        session.blocks.scrollTo(sticky.block);
        session.focus();
      }}
    >
      {/* Over the gutter: the command's own line number, so the row reads naturally. */}
      <span
        className="flex h-full shrink-0 items-center justify-end pr-[18px] font-mono text-[11px] text-primary/80 tabular-nums"
        style={{ width: gutter }}
      >
        {lineNumbers ? session.blocks.lineNumber(b.marker.line) : ""}
      </span>
      <Tooltip content="Scroll to this command" side="bottom">
        <span
          className="min-w-0 flex-1 truncate whitespace-pre text-foreground/85"
          style={{ ...font, paddingLeft: Math.max(0, textLeft), lineHeight: `${cell}px` }}
        >
          {sticky.text}
        </span>
      </Tooltip>
      <CornerLeftUp className={cn("mx-1.5 size-3 shrink-0 text-muted-foreground transition-opacity", hot ? "opacity-100" : "opacity-0")} />
      <div className="mr-3 flex h-full shrink-0 items-center py-px" onClick={(e) => e.stopPropagation()} onKeyDown={undefined}>
        <Badge session={session} block={sticky.block} fields={fields} expanded={hot} />
      </div>
    </div>
  );
}

const GutterRow = memo(function GutterRow({
  row,
  top,
  cell,
  lineNumbers,
  onHover,
  onToggle,
}: {
  row: Row;
  top: number;
  cell: number;
  lineNumbers: boolean;
  onHover: (block: number) => void;
  onToggle: (block: number) => void;
}) {
  const num = <span className="truncate">{row.num ?? ""}</span>;
  return (
    <div
      onMouseEnter={() => onHover(row.block)}
      className={cn(
        "absolute right-0 left-0 flex items-center justify-end pr-1",
        row.failed ? "text-destructive" : row.block >= 0 ? "text-primary/80" : "text-muted-foreground/45",
      )}
      style={{ top, height: cell }}
    >
      {lineNumbers &&
        (row.failed ? (
          <Tooltip content={`Exit code ${row.exit}`} side="right">
            {num}
          </Tooltip>
        ) : (
          num
        ))}
      {row.canFold ? (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => onToggle(row.block)}
          className="ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-ov/10 hover:text-foreground"
        >
          {row.folded ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3 opacity-60" />}
        </button>
      ) : (
        <span className="ml-0.5 size-3.5 shrink-0" />
      )}
    </div>
  );
});
