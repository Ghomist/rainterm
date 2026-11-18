// Side docks: an icon rail on each window edge plus a resizable panel showing one tool
// view. Views can sit in either dock (right-click an icon to move it); both docks can be
// open at once, and Ctrl+Shift+B hides both panels.
import {
  Activity,
  ArrowDown,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUp,
  Boxes,
  FolderTree,
  Network,
  RotateCcw,
  Server,
  Settings2,
  Ship,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import type { DockSide, ViewId } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { FilesView } from "./FilePanel";
import { MonitorPanel } from "./MonitorPanel";
import { ContainersPanel, K8sPanel, PortsPanel } from "./OpsPanels";
import { SessionsView } from "./Sidebar";
import { SnippetsPanel } from "./SnippetsPanel";

export const VIEWS: Record<ViewId, { label: string; icon: React.ReactNode; render: () => React.ReactNode }> = {
  sessions: { label: "Sessions", icon: <Server />, render: () => <SessionsView /> },
  files: { label: "Files", icon: <FolderTree />, render: () => <FilesView /> },
  monitor: { label: "Resource monitor", icon: <Activity />, render: () => <MonitorPanel /> },
  snippets: { label: "Quick commands", icon: <Zap />, render: () => <SnippetsPanel /> },
  ports: { label: "Ports", icon: <Network />, render: () => <PortsPanel /> },
  containers: { label: "Containers", icon: <Boxes />, render: () => <ContainersPanel /> },
  k8s: { label: "Kubernetes", icon: <Ship />, render: () => <K8sPanel /> },
};

/** Full-width, square rail cells flush with the window edge (no floating pills). */
const railBtn =
  "rail-btn relative flex h-11 w-full items-center justify-center text-muted-foreground outline-none focus-visible:text-foreground [&_svg]:size-[18px]";

const MIN_W = 200;
const MAX_W = 720;

export function Dock({ side }: { side: DockSide }) {
  const views = useApp((s) => s.settings.dock[side]);
  const active = useApp((s) => (side === "left" ? s.settings.leftView : s.settings.rightView));
  const hidden = useApp((s) => s.panelsHidden);
  const width = useApp((s) => (side === "left" ? s.settings.leftWidth : s.settings.rightWidth));
  const [live, setLive] = useState<number | null>(null);
  const shown = active && views.includes(active) && !hidden ? active : null;
  const w = live ?? width;

  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = w;
    let last = start;
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      last = Math.min(MAX_W, Math.max(MIN_W, side === "left" ? start + dx : start - dx));
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      setLive(null);
      void useApp.getState().updateSettings(side === "left" ? { leftWidth: Math.round(last) } : { rightWidth: Math.round(last) });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const panel = (
    <motion.div
      initial={false}
      animate={{ width: shown ? w : 0, opacity: shown ? 1 : 0 }}
      transition={live !== null ? { duration: 0 } : { type: "spring", stiffness: 420, damping: 42 }}
      className="relative shrink-0 overflow-hidden"
    >
      <div
        onPointerDown={onResize}
        onDoubleClick={() =>
          void useApp.getState().updateSettings(side === "left" ? { leftWidth: 260 } : { rightWidth: 340 })
        }
        className={cn(
          "absolute inset-y-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40",
          side === "left" ? "right-0" : "left-0",
          live !== null && "bg-primary/40",
        )}
      />
      <div style={{ width: w }} className="relative h-full">
        <AnimatePresence initial={false} mode="popLayout">
          {shown && (
            <motion.div
              key={shown}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
              className="absolute inset-0 flex flex-col"
            >
              {VIEWS[shown].render()}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  );

  if (!views.length && side === "right") return null;
  const rail = <Rail side={side} views={views} shown={shown} />;
  return (
    <div className="flex shrink-0">
      {side === "left" ? (
        <>
          {rail}
          {panel}
        </>
      ) : (
        <>
          {panel}
          {rail}
        </>
      )}
    </div>
  );
}

function Rail({ side, views, shown }: { side: DockSide; views: ViewId[]; shown: ViewId | null }) {
  const toggleView = useApp((s) => s.toggleView);
  const set = useApp((s) => s.set);
  return (
    <div className="flex w-11 shrink-0 flex-col pb-1">
      {views.map((id, i) => (
        <RailButton
          key={id}
          id={id}
          side={side}
          index={i}
          count={views.length}
          active={shown === id}
          onClick={() => toggleView(id)}
        />
      ))}
      {side === "left" && (
        <>
          <div className="flex-1" />
          <Tooltip content="Settings" shortcut="settings" side="right">
            <button
              type="button"
              onClick={() => set({ settingsOpen: true })}
              aria-label="Settings"
              className={railBtn}
            >
              <Settings2 />
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function RailButton({
  id,
  side,
  index,
  count,
  active,
  onClick,
}: {
  id: ViewId;
  side: DockSide;
  index: number;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  const moveView = useApp((s) => s.moveView);
  const resetDock = useApp((s) => s.resetDock);
  const v = VIEWS[id];
  const other: DockSide = side === "left" ? "right" : "left";
  return (
    <ContextMenu>
      <Tooltip content={v.label} shortcut={id === "sessions" ? "sessionsView" : id} side={side === "left" ? "right" : "left"}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={v.label}
            data-active={active}
            className={railBtn}
          >
            {active && (
              <motion.span
                layoutId={`rail-${side}`}
                className={cn(
                  "absolute inset-y-2 w-[2px] bg-primary shadow-[0_0_8px_var(--primary)]",
                  side === "left" ? "left-0 rounded-r-full" : "right-0 rounded-l-full",
                )}
                transition={{ type: "spring", stiffness: 560, damping: 42 }}
              />
            )}
            {/* Re-mounts on selection: a small spring "pop" as the view opens. */}
            <motion.span
              key={active ? "on" : "off"}
              initial={active ? { scale: 0.6, rotate: -14 } : false}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: "spring", stiffness: 520, damping: 14 }}
              className="flex"
            >
              {v.icon}
            </motion.span>
          </button>
        </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => moveView(id, other)}>
          {other === "left" ? <ArrowLeftToLine /> : <ArrowRightToLine />} Move to {other} side
        </ContextMenuItem>
        <ContextMenuItem disabled={index === 0} onSelect={() => moveView(id, side, index - 1)}>
          <ArrowUp /> Move up
        </ContextMenuItem>
        <ContextMenuItem disabled={index === count - 1} onSelect={() => moveView(id, side, index + 1)}>
          <ArrowDown /> Move down
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={resetDock}>
          <RotateCcw /> Reset panel layout
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
