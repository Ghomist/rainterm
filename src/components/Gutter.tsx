// Line-number + fold gutter for one terminal (WindTerm style).
import { ChevronDown, ChevronRight, ClipboardCopy, FoldVertical, UnfoldVertical } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { TermSession } from "@/lib/term-session";
import { cn } from "@/lib/utils";

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
}

export function gutterWidth(session: TermSession, lineNumbers: boolean) {
  if (!lineNumbers) return 16;
  const total = session.blocks.totalLines();
  return Math.max(3, String(total).length) * 7.4 + 24;
}

export function Gutter({
  session,
  lineNumbers,
  width,
}: {
  session: TermSession;
  lineNumbers: boolean;
  width: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [geom, setGeom] = useState({ top: 6, cell: 17 });
  const [hover, setHover] = useState<number | null>(null);
  const [menuRow, setMenuRow] = useState<Row | null>(null);

  useEffect(() => {
    const { term, blocks } = session;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const el = ref.current;
      const core: Any = (term as Any)._core;
      const cell: number = core?._renderService?.dimensions?.css?.cell?.height || 0;
      const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
      if (el && screen && cell) {
        const top = screen.getBoundingClientRect().top - el.getBoundingClientRect().top;
        setGeom((g) => (g.top === top && g.cell === cell ? g : { top, cell }));
      }
      const buf = term.buffer.active;
      if (buf.type !== "normal") return setRows([]);
      const next: Row[] = [];
      const cursorAbs = buf.baseY + buf.cursorY;
      for (let r = 0; r < term.rows; r++) {
        const abs = buf.viewportY + r;
        if (abs > cursorAbs) {
          // Empty screen rows below the cursor don't get numbers.
          next.push({ key: r, abs, num: null, block: -1, folded: 0, canFold: false, failed: false });
          continue;
        }
        const line = buf.getLine(abs);
        const block = blocks.blockAt(abs);
        const b = block >= 0 ? blocks.list[block] : null;
        next.push({
          key: r,
          abs,
          num: line && !line.isWrapped ? blocks.lineNumber(abs) : null,
          block,
          folded: b?.fold ? b.fold.lines.length : 0,
          canFold: block >= 0 && (!!b?.fold || blocks.canFold(block)),
          failed: !!b && b.exitCode !== null && b.exitCode !== 0,
        });
      }
      setRows(next);
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
    schedule();
    return () => {
      cancelAnimationFrame(raf);
      for (const s of subs) s.dispose();
      off();
    };
  }, [session]);

  // Block highlight band (rows covered by the hovered block's command + output).
  const band = (() => {
    if (hover === null) return null;
    const r = session.blocks.range(hover);
    const start = session.blocks.list[hover]?.marker.line;
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

  return (
    <>
      {band && (
        <div
          className="pointer-events-none absolute right-0 z-[1] rounded-sm bg-primary/[0.07] ring-1 ring-primary/20 ring-inset transition-all duration-100"
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
              <div
                key={row.key}
                onMouseEnter={() => setHover(row.block >= 0 ? row.block : null)}
                className={cn(
                  "absolute right-0 left-0 flex items-center justify-end pr-1",
                  row.failed
                    ? "text-destructive"
                    : row.block >= 0
                      ? "text-primary/80"
                      : "text-muted-foreground/45",
                )}
                style={{ top: geom.top + row.key * geom.cell, height: geom.cell }}
              >
                {lineNumbers && (
                  <Tooltip
                    content={row.failed ? `Exit code ${session.blocks.list[row.block]?.exitCode}` : null}
                    side="right"
                  >
                    <span className="truncate">{row.num ?? ""}</span>
                  </Tooltip>
                )}
                <button
                  type="button"
                  tabIndex={-1}
                  disabled={!row.canFold}
                  onClick={() => {
                    blocks.toggle(row.block);
                    session.focus();
                  }}
                  className={cn(
                    "ml-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-sm transition",
                    row.canFold
                      ? "text-muted-foreground hover:bg-ov/10 hover:text-foreground"
                      : "invisible",
                  )}
                >
                  {row.folded ? (
                    <ChevronRight className="size-3" />
                  ) : (
                    <ChevronDown className="size-3 opacity-60" />
                  )}
                </button>
              </div>
            ))}
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          {menuRow && menuRow.block >= 0 ? (
            <>
              <ContextMenuItem
                disabled={!menuRow.canFold}
                onSelect={() => blocks.toggle(menuRow.block)}
              >
                {menuRow.folded ? <UnfoldVertical /> : <FoldVertical />}
                {menuRow.folded ? "Unfold output" : "Fold output"}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => void navigator.clipboard.writeText(blocks.text(menuRow.block))}
              >
                <ClipboardCopy /> Copy command + output
              </ContextMenuItem>
              <ContextMenuSeparator />
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

      {/* "N lines folded" pills next to folded command lines */}
      {rows
        .filter((r) => r.folded > 0)
        .map((r) => (
          <button
            type="button"
            key={`fold-${r.abs}`}
            onClick={() => blocks.toggle(r.block)}
            className="absolute right-4 z-[20] flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-2 text-[10.5px] text-primary backdrop-blur transition hover:bg-primary/20"
            style={{ top: geom.top + r.key * geom.cell + 1, height: geom.cell - 2 }}
          >
            <UnfoldVertical className="size-3" />
            {r.folded} lines folded
          </button>
        ))}
    </>
  );
}
