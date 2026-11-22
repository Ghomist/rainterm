import {
  AlertTriangle,
  Bot,
  ArrowDown,
  ArrowUp,
  Cable,
  Columns2,
  KeyRound,
  Maximize2,
  Minimize2,
  RotateCw,
  Rows2,
  Server,
  SquareTerminal,
  Users,
  X,
  Sparkles,
} from "lucide-react";
import { toast } from "@/lib/overlay";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Kbd } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { groupById, INPUT_GROUPS, isTermPane, type Layout, type Pane, type Tab, type TermPane, useApp } from "@/store/app";
import { AgentsView } from "./AgentsView";
import { AgentBar } from "./AgentBar";
import { Backdrop } from "./Backdrop";
import { Gutter, gutterWidth } from "./Gutter";
import { Latency } from "./Latency";
import { openInstallKey } from "./SshKeys";
import { SuggestOverlay } from "./Suggest";
import { StatusDot } from "./StatusDot";
import { tr } from "@/lib/i18n";

export function TerminalArea() {
  const tabs = useApp((s) => s.tabs);
  const activeTabId = useApp((s) => s.activeTabId);

  return (
    <main className="relative min-w-0 flex-1 overflow-hidden rounded-xl border border-ov/[0.07] bg-surface shadow-sm shadow-shadow/40">
      <Backdrop />
      {tabs.map((t) => (
        <TabView key={t.id} tab={t} active={t.id === activeTabId} />
      ))}
      <AnimatePresence>{tabs.length === 0 && <EmptyState />}</AnimatePresence>
      <SearchBar />
    </main>
  );
}

function TabView({ tab, active }: { tab: Tab; active: boolean }) {
  const multi = tab.layout.type === "split";
  // Over a background the terminals blend into the scene (mix-blend-mode), which only works
  // without a stacking context in between: no z-index, and no opacity fade.
  const glass = useApp((s) => s.settings.backdrop !== "none");
  return (
    <motion.div
      initial={false}
      animate={{ opacity: active || glass ? 1 : 0 }}
      transition={{ duration: glass ? 0 : 0.12 }}
      style={{ visibility: active ? "visible" : "hidden", zIndex: glass ? undefined : active ? 1 : 0 }}
      className="absolute inset-0 flex"
    >
      {tab.zoomed ? (
        <PaneSlot tab={tab} paneId={tab.zoomed} tabActive={active} multi={multi} />
      ) : (
        <LayoutView tab={tab} node={tab.layout} tabActive={active} multi={multi} />
      )}
    </motion.div>
  );
}

function LayoutView({
  tab,
  node,
  tabActive,
  multi,
}: {
  tab: Tab;
  node: Layout;
  tabActive: boolean;
  multi: boolean;
}) {
  if (node.type === "pane")
    return <PaneSlot tab={tab} paneId={node.paneId} tabActive={tabActive} multi={multi} />;
  return <SplitView tab={tab} node={node} tabActive={tabActive} />;
}

function PaneSlot({
  tab,
  paneId,
  tabActive,
  multi,
}: {
  tab: Tab;
  paneId: string;
  tabActive: boolean;
  multi: boolean;
}) {
  const pane = useApp((s) => s.panes[paneId]);
  if (!pane) return null;
  if (!isTermPane(pane))
    return (
      <AgentsView
        pane={pane}
        focused={tab.activePane === pane.id}
        visible={tabActive}
        multi={multi}
        zoomed={tab.zoomed === pane.id}
      />
    );
  return (
    <TerminalPane
      pane={pane}
      focused={tab.activePane === pane.id}
      visible={tabActive}
      multi={multi}
      zoomed={tab.zoomed === pane.id}
    />
  );
}

function SplitView({
  tab,
  node,
  tabActive,
}: {
  tab: Tab;
  node: Extract<Layout, { type: "split" }>;
  tabActive: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const setRatio = useApp((s) => s.setRatio);
  const [dragging, setDragging] = useState(false);
  const row = node.dir === "row";

  const onDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setDragging(true);
    const move = (ev: PointerEvent) => {
      const r = row ? (ev.clientX - rect.left) / rect.width : (ev.clientY - rect.top) / rect.height;
      setRatio(tab.id, node.id, Math.min(0.88, Math.max(0.12, r)));
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={ref} className={cn("flex min-h-0 min-w-0 flex-1", row ? "flex-row" : "flex-col")}>
      <div className="relative flex min-h-0 min-w-0" style={{ flex: `${node.ratio} 1 0` }}>
        <LayoutView tab={tab} node={node.a} tabActive={tabActive} multi />
      </div>
      <Tooltip content={tr("Drag to resize · double-click to reset")} side={row ? "right" : "bottom"}>
        <div
          onPointerDown={onDrag}
          onDoubleClick={() => setRatio(tab.id, node.id, 0.5)}
          className={cn(
            "group relative z-10 shrink-0 transition-colors duration-150",
            row ? "w-px cursor-col-resize" : "h-px cursor-row-resize",
            dragging ? "bg-primary" : "bg-ov/10 hover:bg-primary/60",
          )}
        >
          <div className={cn("absolute", row ? "inset-y-0 -inset-x-1.5" : "inset-x-0 -inset-y-1.5")} />
        </div>
      </Tooltip>
      <div className="relative flex min-h-0 min-w-0" style={{ flex: `${1 - node.ratio} 1 0` }}>
        <LayoutView tab={tab} node={node.b} tabActive={tabActive} multi />
      </div>
    </div>
  );
}

function TerminalPane({
  pane,
  focused,
  visible,
  multi,
  zoomed,
}: {
  pane: TermPane;
  focused: boolean;
  visible: boolean;
  multi: boolean;
  zoomed: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const reconnect = useApp((s) => s.reconnect);
  const focusPane = useApp((s) => s.focusPane);
  const lineNumbers = useApp((s) => s.settings.lineNumbers);
  const glass = useApp((s) => (s.settings.backdrop !== "none" ? s.settings.glassOpacity : null));
  const { session } = pane;
  const [width, setWidth] = useState(() => gutterWidth(session, lineNumbers));
  const showHeader = multi || !!pane.group;

  useEffect(() => {
    if (!ref.current) return;
    session.attach(ref.current);
    return () => session.detach();
  }, [session]);

  useEffect(() => {
    if (focused && visible) requestAnimationFrame(() => session.focus());
  }, [focused, visible, session]);

  // Gutter width only changes when the line-number digit count does.
  useEffect(() => {
    const update = () => setWidth(gutterWidth(session, lineNumbers));
    update();
    const d = session.term.onLineFeed(update);
    const off = session.blocks.onChange(update);
    return () => {
      d.dispose();
      off();
    };
  }, [session, lineNumbers]);

  // Enter on a dead session reconnects (WindTerm / Termius style).
  useEffect(() => {
    const d = session.term.onData((data) => {
      if (data === "\r" && !session.alive) reconnect(pane.id);
    });
    return () => d.dispose();
  }, [session, reconnect, pane.id]);

  const ended = (pane.status === "exited" || pane.status === "error") && !pane.awaitingSecret;

  return (
    <div
      data-pane-id={pane.id}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => focusPane(pane.id)}
    >
      {showHeader && <PaneHeader pane={pane} focused={focused} multi={multi} zoomed={zoomed} />}
      <div
        className="relative min-h-0 flex-1 overflow-hidden"
        data-glass={glass != null ? "on" : undefined}
        style={glass != null ? { background: `color-mix(in srgb, var(--surface) ${Math.round(glass * 100)}%, transparent)` } : undefined}
      >
        <Gutter session={session} lineNumbers={lineNumbers} width={width} />
        {/* Clips the terminal while a side panel slides (it refits only once it settles). */}
        <div ref={ref} className="absolute top-0 right-0 bottom-0 overflow-hidden" style={{ left: width }} />
        <SuggestOverlay session={session} left={width} />
        {/* Dim unfocused panes a touch so the active one stands out. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 z-[3] bg-surface transition-opacity duration-200",
            multi && !focused ? "opacity-25" : "opacity-0",
          )}
        />
      </div>

      <AgentBar pane={pane} />

      <AnimatePresence>
        {ended && visible && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            className="absolute right-4 bottom-4 z-10 flex max-w-[min(520px,calc(100%-2rem))] items-start gap-3 rounded-xl border border-ov/10 bg-popover p-3 pr-3.5 shadow-2xl shadow-shadow"
          >
            <div
              className={
                pane.status === "error"
                  ? "mt-0.5 rounded-md bg-destructive/15 p-1.5 text-destructive"
                  : "mt-0.5 rounded-md bg-ov/5 p-1.5 text-muted-foreground"
              }
            >
              {pane.status === "error" ? (
                <AlertTriangle className="size-4" />
              ) : (
                <SquareTerminal className="size-4" />
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">
                {pane.retry ? tr("Connection lost") : pane.status === "error" ? tr("Connection failed") : tr("Session ended")}
              </div>
              <div className="mt-0.5 text-[12px] break-words text-muted-foreground select-text">
                {pane.retry ? (
                  <RetryCountdown retry={pane.retry} error={pane.status === "error" ? pane.error : undefined} />
                ) : pane.status === "error" ? (
                  pane.error
                ) : (
                  tr("Process exited{0}.", { 0: pane.exitCode != null ? ` with code ${pane.exitCode}` : "" })
                )}
              </div>
            </div>
            {pane.retry && (
              <Button size="sm" variant="ghost" onClick={() => useApp.getState().cancelRetry(pane.id)}>
                {tr("Stop")}
              </Button>
            )}
            <Button size="sm" variant="secondary" onClick={() => reconnect(pane.id)}>
              <RotateCw className="size-3.5" />
              {pane.retry ? tr("Now") : tr("Reconnect")}
              <Kbd className="ml-0.5 h-4 bg-transparent">↵</Kbd>
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** "Reconnecting in 8s (attempt 3)": ticks once a second. */
function RetryCountdown({ retry, error }: { retry: { attempt: number; at: number }; error?: string }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, []);
  const left = Math.max(0, Math.ceil((retry.at - now) / 1000));
  const offline = typeof navigator !== "undefined" && !navigator.onLine;
  return (
    <>
      {offline
        ? tr("Waiting for the network to come back…")
        : left > 0
          ? tr("Reconnecting in {0}s", { 0: left })
          : tr("Reconnecting…")}
      {retry.attempt > 1 && tr(" (attempt {0})", { 0: retry.attempt })}
      {error && <span className="mt-0.5 block text-[11.5px] opacity-75">{error}</span>}
    </>
  );
}

/** Slim per-pane title bar: makes splits self-explanatory (and closable). */
export function PaneHeader({
  pane,
  focused,
  multi,
  zoomed,
}: {
  pane: Pane;
  focused: boolean;
  multi: boolean;
  zoomed: boolean;
}) {
  const { splitActive, closePane, toggleZoom, focusPane } = useApp.getState();
  const group = groupById(pane.group);
  const Icon = pane.kind === "ssh" ? Server : pane.kind === "serial" ? Cable : pane.kind === "agents" ? Bot : SquareTerminal;
  const act = (fn: () => void) => () => {
    focusPane(pane.id);
    fn();
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group/ph relative flex h-7 shrink-0 items-center gap-1.5 border-b px-2 text-[11.5px] transition-colors duration-150",
            focused
              ? "border-primary/30 bg-primary/[0.07] text-foreground"
              : "border-ov/[0.06] bg-ov/[0.02] text-muted-foreground",
          )}
          onDoubleClick={multi ? act(toggleZoom) : undefined}
        >
          {group && <span className="absolute inset-x-0 top-0 h-0.5" style={{ background: group.color }} />}
          <StatusDot status={pane.status} />
          <Icon className="size-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 truncate font-medium">{pane.title}</span>
          <span className="min-w-0 truncate opacity-60">{pane.subtitle}</span>
          <Latency pane={pane} className="text-[10.5px] opacity-70" />
          {group && (
            <span
              className="flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[10.5px] font-medium"
              style={{ background: `${group.color}26`, color: group.color }}
            >
              <Users className="size-3" /> {tr(group.name)}
            </span>
          )}
          <div className="flex-1" />
          <div
            className={cn(
              "flex items-center gap-0.5 transition-opacity duration-150",
              focused ? "opacity-100" : "opacity-0 group-hover/ph:opacity-100",
            )}
          >
            <HeaderBtn tip={tr("Split right")} shortcut="splitRight" onClick={act(() => splitActive("row"))}>
              <Columns2 />
            </HeaderBtn>
            <HeaderBtn tip={tr("Split down")} shortcut="splitDown" onClick={act(() => splitActive("col"))}>
              <Rows2 />
            </HeaderBtn>
            {multi && (
              <HeaderBtn
                tip={zoomed ? tr("Restore layout") : tr("Maximize pane")}
                shortcut="zoomPane"
                onClick={act(toggleZoom)}
              >
                {zoomed ? <Minimize2 /> : <Maximize2 />}
              </HeaderBtn>
            )}
            <HeaderBtn tip={tr("Close pane")} shortcut="closePane" onClick={() => closePane(pane.id)} danger>
              <X />
            </HeaderBtn>
          </div>
        </div>
      </ContextMenuTrigger>
      <PaneMenu pane={pane} multi={multi} zoomed={zoomed} />
    </ContextMenu>
  );
}

export function PaneMenu({ pane, multi, zoomed }: { pane: Pane; multi: boolean; zoomed: boolean }) {
  const { splitActive, closePane, toggleZoom, focusPane, setPaneGroup, reconnect } =
    useApp.getState();
  const act = (fn: () => void) => () => {
    focusPane(pane.id);
    fn();
  };
  return (
    <ContextMenuContent className="min-w-56">
      <ContextMenuItem onSelect={act(() => splitActive("row"))}>
        <Columns2 /> {tr("Split right")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={act(() => splitActive("col"))}>
        <Rows2 /> {tr("Split down")}
      </ContextMenuItem>
      {multi && (
        <ContextMenuItem onSelect={act(toggleZoom)}>
          {zoomed ? <Minimize2 /> : <Maximize2 />} {zoomed ? tr("Restore layout") : tr("Maximize pane")}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <GroupPicker pane={pane} onPick={(g) => setPaneGroup(pane.id, g)} />
      <ContextMenuSeparator />
      {pane.kind === "ssh" && pane.session?.alive && !pane.session.blocks.integrated && (
        <ContextMenuItem
          onSelect={act(() => {
            const why = pane.session?.enableIntegration();
            if (why) toast({ kind: "info", title: why });
          })}
        >
          <Sparkles /> {tr("Enable shell integration")}
        </ContextMenuItem>
      )}
      {pane.kind === "ssh" && pane.session?.alive && (
        <ContextMenuItem onSelect={() => openInstallKey({ paneId: pane.id })}>
          <KeyRound /> {tr("Install my public key here…")}
        </ContextMenuItem>
      )}
      {pane.session && !pane.session.alive && (
        <ContextMenuItem onSelect={() => reconnect(pane.id)}>
          <RotateCw /> {tr("Reconnect")}
        </ContextMenuItem>
      )}
      <ContextMenuItem destructive onSelect={() => closePane(pane.id)}>
        <X /> {tr("Close pane")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

/** Colored A–D chips; click to join, click again to leave. */
export function GroupPicker({ pane, onPick }: { pane: Pane; onPick: (g: string | null) => void }) {
  return (
    <div className="px-2 pt-1 pb-1.5">
      <div className="pb-1.5 text-[11px] font-medium text-muted-foreground">
        {tr("Input group · typing goes to every member")}
      </div>
      <div className="flex gap-1">
        {INPUT_GROUPS.map((g) => (
          <Tooltip key={g.id} content={pane.group === g.id ? tr("Leave {0}", { 0: tr(g.name) }) : tr("Join {0}", { 0: tr(g.name) })}>
          <button
            type="button"
            onClick={() => onPick(pane.group === g.id ? null : g.id)}
            className={cn(
              "flex h-6 flex-1 items-center justify-center rounded-md text-[11px] font-semibold transition",
              pane.group === g.id ? "scale-105 shadow-sm" : "opacity-60 hover:opacity-100",
            )}
            style={{
              background: pane.group === g.id ? g.color : `${g.color}30`,
              color: pane.group === g.id ? "#111" : g.color,
            }}
          >
            {g.id.toUpperCase()}
          </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

function HeaderBtn({
  tip,
  shortcut,
  onClick,
  children,
  danger,
}: {
  tip: string;
  shortcut?: string;
  onClick: () => void;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <Tooltip content={tip} shortcut={shortcut}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "press flex size-5 items-center justify-center rounded [&_svg]:size-3.5",
          danger
            ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
            : "text-muted-foreground hover:bg-ov/10 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

function SearchBar() {
  const open = useApp((s) => s.searchOpen);
  const set = useApp((s) => s.set);
  const pane = useApp((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? s.panes[tab.activePane] : null;
  });
  const [q, setQ] = useState("");
  const [result, setResult] = useState<{ index: number; count: number } | null>(null);
  const search = pane?.session?.search;

  useEffect(() => {
    if (!search) return;
    const d = search.onDidChangeResults((r) => setResult({ index: r.resultIndex, count: r.resultCount }));
    return () => d.dispose();
  }, [search]);

  const opts = {
    decorations: {
      matchBackground: "#7cc4ff33",
      activeMatchBackground: "#e8c27a88",
      matchOverviewRuler: "#7cc4ff",
      activeMatchColorOverviewRuler: "#e8c27a",
    },
  };
  const go = (dir: 1 | -1) => {
    if (!search || !q) return;
    if (dir > 0) search.findNext(q, opts);
    else search.findPrevious(q, opts);
  };
  const close = () => {
    search?.clearDecorations();
    set({ searchOpen: false });
    pane?.session?.focus();
  };

  return (
    <AnimatePresence>
      {open && pane?.session && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -8 }}
          transition={{ duration: 0.15 }}
          className="absolute top-2.5 right-5 z-20 flex items-center gap-1 rounded-lg border border-ov/10 bg-popover p-1 shadow-xl shadow-shadow"
        >
          <input
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (e.target.value) search?.findNext(e.target.value, { ...opts, incremental: true });
              else search?.clearDecorations();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") go(e.shiftKey ? -1 : 1);
              if (e.key === "Escape") close();
            }}
            placeholder={tr("Find")}
            spellCheck={false}
            className="h-7 w-52 rounded-md bg-inset px-2 text-[12.5px] outline-none placeholder:text-muted-foreground/60"
          />
          <span className="w-14 text-center text-[11px] text-muted-foreground tabular-nums">
            {q && result ? (result.count ? `${result.index + 1}/${result.count}` : "0/0") : ""}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={() => go(-1)}>
            <ArrowUp className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={() => go(1)}>
            <ArrowDown className="size-3.5" />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={close}>
            <X className="size-3.5" />
          </Button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function EmptyState() {
  const openLocal = useApp((s) => s.openLocal);
  const set = useApp((s) => s.set);
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0 }}
      className="absolute inset-0 flex flex-col items-center justify-center gap-5 text-muted-foreground"
    >
      <div className="text-3xl font-light tracking-tight text-foreground/80">{tr("rainterm")}</div>
      <div className="grid grid-cols-[auto_auto] gap-x-6 gap-y-2 text-[12.5px]">
        <button type="button" className="text-left hover:text-foreground" onClick={() => openLocal()}>
          {tr("New local tab")}
        </button>
        <Kbd>{tr("Ctrl Shift T")}</Kbd>
        <button
          type="button"
          className="text-left hover:text-foreground"
          onClick={() => set({ profileEditor: { kind: "ssh" } })}
        >
          {tr("New SSH session")}
        </button>
        <Kbd>{tr("Ctrl Shift N")}</Kbd>
        <button
          type="button"
          className="text-left hover:text-foreground"
          onClick={() => set({ paletteOpen: true })}
        >
          {tr("Command palette")}
        </button>
        <Kbd>{tr("Ctrl Shift P")}</Kbd>
      </div>
    </motion.div>
  );
}
