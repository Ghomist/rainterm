import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Cable,
  ChevronDown,
  Columns2,
  Copy,
  CopyPlus,
  Pencil,
  XSquare,
  Minus,
  Plus,
  Radio,
  Rows2,
  Server,
  Square,
  SquareTerminal,
  Bot,
  X,
  Check,
  Bell,
} from "lucide-react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { UpdateBadge } from "./Updater";
import { tooltipKeys } from "@/lib/keymap";
import { cn, isMac } from "@/lib/utils";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { prompt } from "@/lib/overlay";
import { type BroadcastMode, groupById, layoutPanes, type Pane, type Tab, useApp } from "@/store/app";
import { GroupPicker } from "./TerminalArea";
import { StatusDot } from "./StatusDot";
import { tr } from "@/lib/i18n";

const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

/** With tabs down the left, the title bar names what you're looking at. */
function ActiveTitle() {
  const tab = useApp((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const pane = useApp((s) => (tab ? s.panes[tab.activePane] : undefined));
  if (!tab || !pane) return null;
  return (
    <div data-tauri-drag-region className="pointer-events-none flex min-w-0 items-baseline gap-2 text-[12.5px]">
      <span className="truncate font-medium text-foreground/90">{tab.name ?? pane.title}</span>
      {pane.subtitle && <span className="truncate text-[11.5px] text-muted-foreground">{pane.subtitle}</span>}
    </div>
  );
}

export function TitleBar() {
  const tabs = useApp((s) => s.tabs);
  const vertical = useApp((s) => s.settings.tabPosition === "left");
  const set = useApp((s) => s.set);
  const stripRef = useRef<HTMLDivElement>(null);
  const [fade, setFade] = useState({ left: false, right: false });

  // Edge fades only when tabs actually overflow (and only on the hidden side).
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const update = () => {
      // Measure layout boxes (offsetLeft/Width ignore transforms). scrollWidth would
      // include tabs mid-animation (motion moves them with transforms) and stay stuck.
      const kids = [...el.children] as HTMLElement[];
      const first = kids[0];
      const last = kids.at(-1);
      const content = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : 0;
      const overflow = content - el.clientWidth > 2;
      const left = overflow && el.scrollLeft > 2;
      const right = overflow && el.scrollLeft + el.clientWidth < content - 2;
      setFade((f) => (f.left === left && f.right === right ? f : { left, right }));
    };
    update();
    // Tabs animate in (scale), so measure again once that has settled.
    const late = window.setTimeout(update, 350);
    const ro = new ResizeObserver(update);
    ro.observe(el);
    const mo = new MutationObserver(update);
    mo.observe(el, { childList: true });
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      clearTimeout(late);
      ro.disconnect();
      mo.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [tabs.length]);

  if (vertical)
    return (
      <header
        data-tauri-drag-region
        className={cn("flex h-10 shrink-0 items-center gap-1 bg-chrome select-none", isMac ? "pl-[78px]" : "pl-3")}
      >
        <ActiveTitle />
        <div data-tauri-drag-region className="h-full min-w-8 flex-1" />
        <RightTools />
        {!isMac && <WindowControls />}
      </header>
    );

  return (
    <header
      data-tauri-drag-region
      className={cn(
        "flex h-10 shrink-0 items-center gap-1 bg-chrome select-none",
        // macOS: leave room for the native traffic lights (overlay title bar).
        isMac ? "pl-[78px]" : "pl-1.5",
      )}
    >
      <Reorder.Group
        as="div"
        axis="x"
        values={tabs}
        onReorder={(next: Tab[]) => set({ tabs: next })}
        onWheel={(e) => {
          // Vertical wheel scrolls the strip sideways; no visible scrollbar.
          if (e.deltaY) e.currentTarget.scrollLeft += e.deltaY;
        }}
        ref={stripRef}
        style={{
          maskImage: `linear-gradient(to right, ${fade.left ? "transparent" : "#000"} 0, #000 18px, #000 calc(100% - 18px), ${fade.right ? "transparent" : "#000"} 100%)`,
        }}
        className="no-scrollbar flex h-full min-w-0 items-center gap-0.5 overflow-x-auto"
      >
        <AnimatePresence initial={false}>
          {tabs.map((t) => (
            <TabItem key={t.id} tab={t} />
          ))}
        </AnimatePresence>
      </Reorder.Group>

      <NewTabButton />

      <div data-tauri-drag-region className="h-full min-w-8 flex-1" />
      <RightTools />
      {!isMac && <WindowControls />}
    </header>
  );
}

/** What a tab shows, wherever the tabs are (top strip or vertical list). */
export function useTabInfo(tab: Tab) {
  const active = useApp((s) => s.activeTabId === tab.id);
  const pane = useApp((s) => s.panes[tab.activePane]);
  const groups = useApp((s) => {
    const g = new Set<string>();
    for (const id of layoutPanes(tab.layout)) {
      const p = s.panes[id];
      if (p?.group) g.add(p.group);
    }
    return [...g].sort().join(",");
  });
  const count = layoutPanes(tab.layout).length;
  const attention = useApp((s) => {
    const list = layoutPanes(tab.layout).map((id) => s.panes[id]?.attention);
    return (list.includes("fail") ? "fail" : list.includes("wait") ? "wait" : list.includes("ok") ? "ok" : null) as Attention;
  });
  // The tab's progress: an error wins, then the least done (what you're waiting on).
  const progressKey = useApp((s) => {
    const all = layoutPanes(tab.layout).map((id) => s.panes[id]?.progress).filter((p) => !!p);
    const p = all.find((x) => x.state === 2) ?? all.sort((a, b) => a.value - b.value)[0];
    return p ? `${p.state}:${p.value}` : "";
  });
  const progress = progressKey ? { state: Number(progressKey.split(":")[0]) as 1 | 2 | 3 | 4, value: Number(progressKey.split(":")[1]) } : null;
  // Looking at the tab (window focused, tab active) clears its "finished" mark.
  useEffect(() => {
    if (!active || !attention) return;
    const clear = () => {
      if (!document.hasFocus()) return;
      useApp.setState((s) => {
        const panes = { ...s.panes };
        for (const id of layoutPanes(tab.layout)) if (panes[id]?.attention) panes[id] = { ...panes[id], attention: null };
        return { panes };
      });
    };
    clear();
    window.addEventListener("focus", clear);
    return () => window.removeEventListener("focus", clear);
  }, [active, attention, tab.layout]);
  const Icon = pane?.kind === "ssh" ? Server : pane?.kind === "serial" ? Cable : pane?.kind === "agents" ? Bot : SquareTerminal;
  const title = tab.name ?? pane?.title ?? "";
  const rename = async () => {
    const name = await prompt({ title: tr("Rename tab"), value: title, confirmLabel: tr("Rename") });
    if (name !== null) useApp.getState().renameTab(tab.id, name);
  };
  return { active, pane, groups, count, attention, progress, Icon, title, rename };
}

/** Hovering a tab for a while switches to it (handy while dragging files). */
export function useHoverSwitch(tabId: string, active: boolean) {
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  return {
    onPointerEnter: () => {
      const ms = useApp.getState().settings.tabHoverSwitchMs;
      if (!ms || active) return;
      timer.current = window.setTimeout(() => useApp.getState().setActiveTab(tabId), ms);
    },
    onPointerLeave: () => {
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = null;
    },
  };
}

/** The status slot: a finished / failed mark, else the connection dot; the close button on hover. */
export type Attention = "ok" | "fail" | "wait" | null;

/** A thin bar along a tab's edge for the progress its program reports (OSC 9;4). */
export function TabProgress({ progress, className }: { progress: { state: 1 | 2 | 3 | 4; value: number } | null; className?: string }) {
  if (!progress) return null;
  const color = progress.state === 2 ? "bg-destructive" : progress.state === 4 ? "bg-warning" : "bg-primary";
  return (
    <span className={cn("pointer-events-none absolute h-[2px] overflow-hidden rounded-full bg-ov/10", className)}>
      {progress.state === 3 ? (
        <span className={cn("absolute inset-y-0 w-1/3 animate-[rt-indeterminate_1.2s_ease-in-out_infinite] rounded-full", color)} />
      ) : (
        <span className={cn("absolute inset-y-0 left-0 rounded-full transition-[width] duration-300", color)} style={{ width: `${Math.max(3, progress.value)}%` }} />
      )}
    </span>
  );
}

export function TabStatus({ tab, attention, status }: { tab: Tab; attention: Attention; status: Pane["status"] }) {
  return (
    <span className="relative -mr-1 flex size-5 shrink-0 items-center justify-center">
      {attention === "wait" ? (
        <Tooltip content={tr("A program here is waiting for you")}>
          <span className="flex size-3.5 animate-pulse items-center justify-center rounded-full bg-warning/20 text-warning group-hover:hidden">
            <Bell className="size-2.5" strokeWidth={2.5} />
          </span>
        </Tooltip>
      ) : attention ? (
        <Tooltip content={attention === "fail" ? tr("A command failed here") : tr("A long command finished here")}>
          <span
            className={cn(
              "flex size-3.5 items-center justify-center rounded-full group-hover:hidden",
              attention === "fail" ? "bg-destructive/15 text-destructive" : "bg-success/15 text-success",
            )}
          >
            {attention === "fail" ? <X className="size-2.5" strokeWidth={3} /> : <Check className="size-2.5" strokeWidth={3} />}
          </span>
        </Tooltip>
      ) : (
        <StatusDot status={status} className="group-hover:hidden" />
      )}
      <button
        type="button"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useApp.getState().closeTab(tab.id)}
        className="absolute inset-0 hidden items-center justify-center rounded text-muted-foreground transition hover:bg-ov/10 hover:text-foreground group-hover:flex"
      >
        <X className="size-3.5" />
      </button>
    </span>
  );
}

/** Group colour dots of the panes in a tab. */
export function GroupDots({ groups, ring = "ring-chrome" }: { groups: string; ring?: string }) {
  if (!groups) return null;
  return (
    <span className="relative flex -space-x-1">
      {groups.split(",").map((g) => (
        <span key={g} className={cn("size-2 rounded-full ring-2", ring)} style={{ background: groupById(g)?.color }} />
      ))}
    </span>
  );
}

/** Right-click menu of a tab. */
export function TabMenu({ tab, pane, rename }: { tab: Tab; pane: Pane; rename: () => void }) {
  const { setActiveTab, closeTab, duplicateTab, closeOtherTabs, splitActive, setPaneGroup } = useApp.getState();
  return (
    <ContextMenuContent className="min-w-56">
      <ContextMenuItem onSelect={() => void rename()}>
        <Pencil /> {tr("Rename…")}
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => duplicateTab(tab.id)}>
        <CopyPlus /> {tr("Duplicate tab")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          setActiveTab(tab.id);
          splitActive("row");
        }}
      >
        <Columns2 /> {tr("Split right")}
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() => {
          setActiveTab(tab.id);
          splitActive("col");
        }}
      >
        <Rows2 /> {tr("Split down")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <GroupPicker
        pane={pane}
        onPick={(g) => {
          for (const id of layoutPanes(tab.layout)) setPaneGroup(id, g);
        }}
      />
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => closeOtherTabs(tab.id)}>
        <XSquare /> {tr("Close other tabs")}
      </ContextMenuItem>
      <ContextMenuItem destructive onSelect={() => closeTab(tab.id)}>
        <X /> {tr("Close tab")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
}

function TabItem({ tab }: { tab: Tab }) {
  const { active, pane, groups, count, attention, progress, Icon, title, rename } = useTabInfo(tab);
  const hover = useHoverSwitch(tab.id, active);
  const { setActiveTab, closeTab } = useApp.getState();
  if (!pane) return null;

  return (
    <ContextMenu>
      <Tooltip content={tab.name ? `${title} · ${pane.subtitle}` : pane.subtitle} delay={700}>
      <ContextMenuTrigger asChild>
        <Reorder.Item
          as="div"
          value={tab}
          layout="position"
          initial={{ opacity: 0, scale: 0.92, y: 4 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.92, transition: { duration: 0.12 } }}
          transition={spring}
          whileDrag={{ scale: 1.03, zIndex: 10 }}
          onPointerDown={(e) => e.button === 0 && setActiveTab(tab.id)}
          // Middle click closes (mousedown default would start autoscroll).
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onMouseUp={(e) => {
            if (e.button === 1) {
              e.preventDefault();
              closeTab(tab.id);
            }
          }}
          {...hover}
          onDoubleClick={() => void rename()}
          className={cn(
            // Full title-bar height, so the accent strip can sit on the window's top edge.
            "group relative flex h-full w-48 min-w-28 shrink items-center gap-2 px-2.5 text-[12.5px] transition-colors duration-150",
            // Like the side rails: no background block; the selected tab lights up and
            // carries a glowing accent strip flush with the window edge.
            active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {active && (
            <motion.div
              layoutId="active-tab"
              transition={spring}
              className="absolute inset-x-2.5 top-0 h-[2px] rounded-b-full bg-primary shadow-[0_0_8px_var(--primary)]"
            />
          )}
          <Icon
            className={cn(
              "relative size-3.5 shrink-0 transition-[color,filter] duration-200",
              active
                ? "text-primary drop-shadow-[0_0_5px_color-mix(in_oklab,var(--primary)_70%,transparent)]"
                : "opacity-80 group-hover:drop-shadow-[0_0_4px_color-mix(in_oklab,var(--foreground)_40%,transparent)]",
            )}
          />
          <span className="relative min-w-0 flex-1 truncate">{title}</span>
          <GroupDots groups={groups} />
          <TabProgress progress={progress} className="inset-x-2.5 bottom-1" />
          {count > 1 && (
            <span className="relative flex items-center gap-0.5 rounded bg-ov/10 px-1 text-[10px] text-muted-foreground tabular-nums">
              <Columns2 className="size-2.5" />
              {count}
            </span>
          )}
          {/* Status dot and close button share one 20px slot, so they line up. */}
          <TabStatus tab={tab} attention={attention} status={pane.status} />
        </Reorder.Item>
      </ContextMenuTrigger>
      </Tooltip>
      <TabMenu tab={tab} pane={pane} rename={rename} />
    </ContextMenu>
  );
}

export function NewTabButton({ compact = false }: { compact?: boolean }) {
  const shells = useApp((s) => s.shells);
  const openLocal = useApp((s) => s.openLocal);
  const agentsOn = useApp((s) => s.settings.agentsBoard);
  const set = useApp((s) => s.set);
  if (compact)
    return (
      <Tooltip content={tr("New tab")} shortcut="newTab" side="right">
        <Button variant="ghost" size="icon-sm" onClick={() => openLocal()}>
          <Plus />
        </Button>
      </Tooltip>
    );

  return (
    <div className="flex shrink-0 items-center">
      <Tooltip content={tr("New tab")} shortcut="newTab">
        <Button variant="ghost" size="icon-sm" className="rounded-r-none" onClick={() => openLocal()}>
          <Plus />
        </Button>
      </Tooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" className="w-5 rounded-l-none text-muted-foreground">
            <ChevronDown className="size-3.5" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          <DropdownMenuLabel>{tr("Local shells")}</DropdownMenuLabel>
          {shells.map((sh) => (
            <DropdownMenuItem key={sh.id} onSelect={() => openLocal(sh)}>
              <SquareTerminal />
              {sh.name}
            </DropdownMenuItem>
          ))}
          {agentsOn && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => useApp.getState().openAgents()}>
                <Bot />
                {tr("Agents")}
              </DropdownMenuItem>
            </>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "ssh" } })}>
            <Server />
            {tr("New SSH session…")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "serial" } })}>
            <Cable />
            {tr("New serial session…")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RightTools() {
  return (
    <div className="mr-1 flex shrink-0 items-center gap-0.5">
      <UpdateBadge />
      <BroadcastMenu />
    </div>
  );
}

const modes: { value: BroadcastMode; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "tab", label: "All panes in this tab" },
  { value: "all", label: "All terminals" },
];

function BroadcastMenu() {
  const broadcast = useApp((s) => s.broadcast);
  const setBroadcast = useApp((s) => s.setBroadcast);
  const grouped = useApp((s) => Object.values(s.panes).some((p) => p.group));
  const on = broadcast !== "off";
  const tabKeys = useApp((s) => tooltipKeys(s.settings, "broadcast") ?? "");
  return (
    <DropdownMenu>
      <Tooltip content={tr("Broadcast input / input groups")}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              "relative text-muted-foreground",
              on && "bg-warning/15 text-warning hover:bg-warning/20 hover:text-warning",
            )}
          >
            <Radio />
            {grouped && !on && <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{tr("Broadcast input")}</DropdownMenuLabel>
        {modes.map((m) => (
          <DropdownMenuItem key={m.value} onSelect={() => setBroadcast(m.value)}>
            <span
              className={cn(
                "flex size-3.5 items-center justify-center rounded-full border",
                broadcast === m.value ? "border-primary" : "border-ov/25",
              )}
            >
              {broadcast === m.value && <span className="size-1.5 rounded-full bg-primary" />}
            </span>
            <span className="flex-1">{tr(m.label)}</span>
            <span className="text-[10.5px] text-muted-foreground">{m.value === "tab" ? tabKeys : ""}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          {tr("For finer control use")}{" "}<span className="text-foreground">{tr("input groups")}</span>{tr(": right-click a tab or a pane header and pick A–D. Terminals in the same group share input, across tabs.")}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WindowControls() {
  const win = getCurrentWindow();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    void win.isMaximized().then(setMaximized);
    const un = win.onResized(() => void win.isMaximized().then(setMaximized));
    return () => void un.then((f) => f());
  }, [win]);

  const btn =
    "flex h-full w-11.5 items-center justify-center text-muted-foreground transition-colors duration-100 hover:bg-ov/[0.07] hover:text-foreground";
  return (
    <div className="flex h-full shrink-0">
      <button type="button" className={btn} onClick={() => void win.minimize()}>
        <Minus className="size-4" strokeWidth={1.5} />
      </button>
      <button type="button" className={btn} onClick={() => void win.toggleMaximize()}>
        {maximized ? (
          <Copy className="size-3.5 -scale-x-100" strokeWidth={1.5} />
        ) : (
          <Square className="size-3.25" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        className={cn(btn, "hover:bg-[#e81123] hover:text-white")}
        onClick={() => void win.close()}
      >
        <X className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
