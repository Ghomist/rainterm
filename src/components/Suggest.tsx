// VS Code-style completion popup anchored at the terminal cursor:
// history commands + files/folders for the word being typed.
import { File, Folder, History, KeyRound, SquareTerminal } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TermSession } from "@/lib/term-session";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

// biome-ignore lint/suspicious/noExplicitAny: xterm internals
type Any = any;

interface Geo {
  x: number;
  y: number;
  cellH: number;
  hostW: number;
  hostH: number;
}

/** Cursor position in px relative to the terminal host element, or null if off-screen. */
function cursorGeo(session: TermSession): Geo | null {
  const term = session.term;
  const host = term.element?.parentElement;
  const screen = term.element?.querySelector(".xterm-screen") as HTMLElement | null;
  const cell = (term as Any)._core?._renderService?.dimensions?.css?.cell;
  if (!host || !screen || !cell?.width) return null;
  const buf = term.buffer.active;
  const row = buf.baseY + buf.cursorY - buf.viewportY;
  if (row < 0 || row >= term.rows) return null;
  const hr = host.getBoundingClientRect();
  const sr = screen.getBoundingClientRect();
  return {
    x: sr.left - hr.left + buf.cursorX * cell.width,
    y: sr.top - hr.top + row * cell.height,
    cellH: cell.height,
    hostW: hr.width,
    hostH: hr.height,
  };
}

const ICON = {
  history: <History className="size-3.5 shrink-0 text-muted-foreground" />,
  dir: <Folder className="size-3.5 shrink-0 fill-primary/25 text-primary" />,
  file: <File className="size-3.5 shrink-0 text-muted-foreground" />,
  command: <SquareTerminal className="size-3.5 shrink-0 text-primary" />,
};

export function SuggestOverlay({ session, left }: { session: TermSession; left: number }) {
  const [popup, setPopup] = useState(session.suggestion.popup);
  const [geo, setGeo] = useState<Geo | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const update = () => {
      setPopup(session.suggestion.popup);
      setGeo(session.suggestion.popup ? cursorGeo(session) : null);
    };
    const off = session.onSuggest(update);
    const d = session.term.onScroll(update);
    return () => {
      off();
      d.dispose();
    };
  }, [session]);

  // Keep the selected row visible.
  useLayoutEffect(() => {
    listRef.current?.querySelector('[data-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [popup?.index]);

  const typed = session.blocks.inputState()?.text ?? "";
  const rowH = 26;
  const listH = Math.min(popup?.items.length ?? 0, 8) * rowH + 30;
  const below = geo ? geo.y + geo.cellH + 4 + listH < geo.hostH : true;
  const font = session.term.options.fontFamily;

  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-[15] overflow-hidden" style={{ left }}>
      <AnimatePresence>
        {popup && geo && (
          <motion.div
            key="popup"
            initial={{ opacity: 0, y: below ? -3 : 3, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.07 } }}
            transition={{ duration: 0.11, ease: "easeOut" }}
            className={cn(
              "pointer-events-auto absolute w-max max-w-[min(560px,92%)] min-w-56 overflow-hidden rounded-lg border bg-popover shadow-xl shadow-shadow transition-opacity duration-150",
              "border-ov/10",
            )}
            style={{
              left: Math.max(4, Math.min(geo.x - 6, geo.hostW - 260)),
              ...(below ? { top: geo.y + geo.cellH + 4 } : { bottom: geo.hostH - geo.y + 4 }),
              transformOrigin: below ? "top left" : "bottom left",
            }}
          >
            <div
              ref={listRef}
              className="max-h-[216px] overflow-y-auto p-1"
              onMouseDown={(e) => e.preventDefault() /* keep focus in the terminal */}
            >
              {popup.items.map((c, i) => {
                const word = c.kind === "history" ? typed : typed.slice(typed.length - c.replace);
                const hit = word && c.label.toLowerCase().startsWith(word.toLowerCase()) ? word.length : 0;
                return (
                  <button
                    type="button"
                    key={`${c.kind}:${c.label}`}
                    data-selected={popup.active && i === popup.index}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => session.acceptCompletion(c)}
                    className={cn(
                      "flex h-[26px] w-full items-center gap-2 rounded-md px-2 text-left text-[12.5px] transition-colors duration-75",
                      popup.active && i === popup.index ? "bg-primary/15 text-foreground" : "text-foreground/80 hover:bg-ov/[0.06]",
                    )}
                    style={{ fontFamily: font }}
                  >
                    {ICON[c.kind]}
                    <span className="truncate">
                      <span className="font-semibold text-primary">{c.label.slice(0, hit)}</span>
                      {c.label.slice(hit)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3 border-t border-ov/[0.06] px-2.5 py-1 text-[10.5px] text-muted-foreground">
              <span>{tr("↑↓ select")}</span>
              <span>{tr("Tab accept")}</span>
              <span>{tr("Esc / ↑ at top close")}</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** sudo asks for the password this session logged in with: a local chip on the prompt
 *  line (never sent to the server). Enter types the saved password, Esc / typing = yourself. */
export function SudoOverlay({ session, left }: { session: TermSession; left: number }) {
  const [offer, setOffer] = useState(session.sudoOffer);
  const [geo, setGeo] = useState<Geo | null>(null);
  useEffect(() => {
    const update = () => {
      setOffer(session.sudoOffer);
      setGeo(session.sudoOffer ? cursorGeo(session) : null);
    };
    const off = session.onSudo(update);
    const d = session.term.onScroll(update);
    const r = session.term.onResize(update);
    return () => {
      off();
      d.dispose();
      r.dispose();
    };
  }, [session]);
  const h = geo ? Math.max(20, Math.round(geo.cellH) + 2) : 20;
  return (
    <div className="pointer-events-none absolute inset-y-0 right-0 z-[15] overflow-hidden" style={{ left }}>
      <AnimatePresence>
        {offer && geo && (
          <motion.div
            key="sudo"
            initial={{ opacity: 0, x: -4 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.07 } }}
            transition={{ duration: 0.12, ease: "easeOut" }}
            className="pointer-events-auto absolute flex items-center gap-1 rounded-md border border-primary/30 bg-popover/95 pr-0.5 pl-2 text-[11.5px] shadow-lg shadow-shadow"
            style={{ left: Math.max(4, Math.min(geo.x + 10, geo.hostW - 330)), top: geo.y + (geo.cellH - h) / 2, height: h }}
            onMouseDown={(e) => e.preventDefault() /* keep focus in the terminal */}
          >
            <KeyRound className="size-3.5 shrink-0 text-primary" />
            <span className="mr-1 whitespace-nowrap text-foreground/85">{tr("Type the saved password?")}</span>
            <button
              type="button"
              onClick={() => session.answerSudo(true)}
              className="flex h-[calc(100%-4px)] items-center gap-1 whitespace-nowrap rounded bg-primary/15 px-1.5 font-medium text-primary transition-colors hover:bg-primary/25"
            >
              {tr("Yes")} <kbd className="font-sans text-[10px] opacity-70">Enter</kbd>
            </button>
            <button
              type="button"
              onClick={() => session.answerSudo(false)}
              className="flex h-[calc(100%-4px)] items-center gap-1 whitespace-nowrap rounded px-1.5 text-muted-foreground transition-colors hover:bg-ov/[0.06] hover:text-foreground"
            >
              {tr("Type it myself")} <kbd className="font-sans text-[10px] opacity-70">Esc</kbd>
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
