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
  X,
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
import { type BroadcastMode, groupById, layoutPanes, type Tab, useApp } from "@/store/app";
import { GroupPicker } from "./TerminalArea";
import { StatusDot } from "./StatusDot";

const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.7 } as const;

export function TitleBar() {
  const tabs = useApp((s) => s.tabs);
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

function TabItem({ tab }: { tab: Tab }) {
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
  const hoverTimer = useRef<number | null>(null);
  useEffect(() => () => {
    if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
  }, []);
  const { setActiveTab, closeTab, renameTab, duplicateTab, closeOtherTabs, splitActive, setPaneGroup } =
    useApp.getState();
  if (!pane) return null;
  const Icon = pane.kind === "ssh" ? Server : pane.kind === "serial" ? Cable : SquareTerminal;
  const title = tab.name ?? pane.title;

  const rename = async () => {
    const name = await prompt({ title: "Rename tab", value: title, confirmLabel: "Rename" });
    if (name !== null) renameTab(tab.id, name);
  };

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
          // Hovering a tab for a while switches to it (handy while dragging files).
          onPointerEnter={() => {
            const ms = useApp.getState().settings.tabHoverSwitchMs;
            if (!ms || active) return;
            hoverTimer.current = window.setTimeout(() => setActiveTab(tab.id), ms);
          }}
          onPointerLeave={() => {
            if (hoverTimer.current !== null) clearTimeout(hoverTimer.current);
            hoverTimer.current = null;
          }}
          onDoubleClick={() => void rename()}
          className={cn(
            "group relative flex h-7.5 w-48 min-w-28 shrink items-center gap-2 rounded-md px-2.5 text-[12.5px] transition-colors duration-150",
            active ? "text-foreground" : "text-muted-foreground hover:bg-ov/[0.04] hover:text-foreground",
          )}
        >
          {active && (
            <motion.div
              layoutId="active-tab"
              transition={spring}
              className="absolute inset-0 rounded-md bg-ov/[0.08] shadow-[inset_0_1px_0_color-mix(in_oklab,var(--ov)_6%,transparent)]"
            />
          )}
          <Icon className="relative size-3.5 shrink-0 opacity-80" />
          <span className="relative min-w-0 flex-1 truncate">{title}</span>
          {groups && (
            <span className="relative flex -space-x-1">
              {groups.split(",").map((g) => (
                <span
                  key={g}
                  className="size-2 rounded-full ring-2 ring-chrome"
                  style={{ background: groupById(g)?.color }}
                />
              ))}
            </span>
          )}
          {count > 1 && (
            <span className="relative flex items-center gap-0.5 rounded bg-ov/10 px-1 text-[10px] text-muted-foreground tabular-nums">
              <Columns2 className="size-2.5" />
              {count}
            </span>
          )}
          {/* Status dot and close button share one 20px slot, so they line up. */}
          <span className="relative -mr-1 flex size-5 shrink-0 items-center justify-center">
            <StatusDot status={pane.status} className="group-hover:hidden" />
            <button
              type="button"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => closeTab(tab.id)}
              className="absolute inset-0 hidden items-center justify-center rounded text-muted-foreground transition hover:bg-ov/10 hover:text-foreground group-hover:flex"
            >
              <X className="size-3.5" />
            </button>
          </span>
        </Reorder.Item>
      </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent className="min-w-56">
        <ContextMenuItem onSelect={() => void rename()}>
          <Pencil /> Rename…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => duplicateTab(tab.id)}>
          <CopyPlus /> Duplicate tab
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            setActiveTab(tab.id);
            splitActive("row");
          }}
        >
          <Columns2 /> Split right
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() => {
            setActiveTab(tab.id);
            splitActive("col");
          }}
        >
          <Rows2 /> Split down
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
          <XSquare /> Close other tabs
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => closeTab(tab.id)}>
          <X /> Close tab
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function NewTabButton() {
  const shells = useApp((s) => s.shells);
  const openLocal = useApp((s) => s.openLocal);
  const set = useApp((s) => s.set);

  return (
    <div className="flex shrink-0 items-center">
      <Tooltip content="New tab" shortcut="newTab">
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
          <DropdownMenuLabel>Local shells</DropdownMenuLabel>
          {shells.map((sh) => (
            <DropdownMenuItem key={sh.id} onSelect={() => openLocal(sh)}>
              <SquareTerminal />
              {sh.name}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "ssh" } })}>
            <Server />
            New SSH session…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "serial" } })}>
            <Cable />
            New serial session…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function RightTools() {
  return (
    <div className="mr-1 flex shrink-0 items-center gap-0.5">
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
      <Tooltip content="Broadcast input / input groups">
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
        <DropdownMenuLabel>Broadcast input</DropdownMenuLabel>
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
            <span className="flex-1">{m.label}</span>
            <span className="text-[10.5px] text-muted-foreground">{m.value === "tab" ? tabKeys : ""}</span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <div className="px-2 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
          For finer control use <span className="text-foreground">input groups</span>: right-click a
          tab or a pane header and pick A–D. Terminals in the same group share input, across tabs.
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
