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
  Bot,
  FolderTree,
  Network,
  RotateCcw,
  Server,
  Settings2,
  Ship,
  Sparkles,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { beginLayoutAnimation, endLayoutAnimation } from "@/lib/layout-anim";
import { ErrorBoundary } from "./ErrorBoundary";
import { useEffect, useRef, useState } from "react";
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
import { AgentPanel } from "./AgentPanel";
import { AgentsDock } from "./AgentsView";
import { FilesView } from "./FilePanel";
import { MonitorPanel } from "./MonitorPanel";
import { ContainersPanel, K8sPanel, PortsPanel } from "./OpsPanels";
import { SessionsView } from "./Sidebar";
import { SnippetsPanel } from "./SnippetsPanel";
import { tr } from "@/lib/i18n";

export const VIEWS: Record<ViewId, { label: string; icon: React.ReactNode; render: () => React.ReactNode }> = {
  sessions: { label: "Sessions", icon: <Server />, render: () => <SessionsView /> },
  files: { label: "Files", icon: <FolderTree />, render: () => <FilesView /> },
  monitor: { label: "Resource monitor", icon: <Activity />, render: () => <MonitorPanel /> },
  snippets: { label: "Quick commands", icon: <Zap />, render: () => <SnippetsPanel /> },
  agent: { label: "Agent", icon: <Sparkles />, render: () => <AgentPanel /> },
  ports: { label: "Ports", icon: <Network />, render: () => <PortsPanel /> },
  containers: { label: "Containers", icon: <Boxes />, render: () => <ContainersPanel /> },
  k8s: { label: "Kubernetes", icon: <Ship />, render: () => <K8sPanel /> },
  agents: { label: "Agent pool", icon: <Bot />, render: () => <AgentsDock /> },
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
  const reduce = useApp((s) => s.settings.reduceEffects);
  const shown = active && views.includes(active) && !hidden ? active : null;
  // The view inside lags the panel by one slide: opening from closed, the panel slides out
  // first and the view mounts after (mounting during the slide made it stutter); closing,
  // the view stays until the panel has slid away. Switching views while open is immediate.
  const [content, setContent] = useState(shown);
  const open = useRef(!!shown);
  useEffect(() => {
    const wasOpen = open.current;
    open.current = !!shown;
    if (shown && wasOpen) return setContent(shown);
    const t = setTimeout(() => setContent(shown), reduce ? 0 : 220);
    return () => clearTimeout(t);
  }, [shown]);
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
      transition={live !== null || reduce ? { duration: 0 } : { duration: 0.2, ease: [0.25, 0.8, 0.25, 1] }}
      // Terminals hold their rows / columns while this slides and refit once at the end.
      onAnimationStart={() => live === null && beginLayoutAnimation()}
      onAnimationComplete={() => live === null && endLayoutAnimation()}
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
          {content && (
            <motion.div
              key={content}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.16, ease: [0.2, 0.8, 0.2, 1] }}
              className="absolute inset-0 flex flex-col"
            >
              <ErrorBoundary key={content} label={tr(VIEWS[content].label)}>{VIEWS[content].render()}</ErrorBoundary>
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
          <Tooltip content={tr("Settings")} shortcut="settings" side="right">
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
      <Tooltip content={tr(v.label)} shortcut={id === "sessions" ? "sessionsView" : id} side={side === "left" ? "right" : "left"}>
        <ContextMenuTrigger asChild>
          <button
            type="button"
            onClick={onClick}
            aria-label={tr(v.label)}
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
          {other === "left" ? <ArrowLeftToLine /> : <ArrowRightToLine />} {other === "left" ? tr("Move to the left side") : tr("Move to the right side")}
        </ContextMenuItem>
        <ContextMenuItem disabled={index === 0} onSelect={() => moveView(id, side, index - 1)}>
          <ArrowUp /> {tr("Move up")}
        </ContextMenuItem>
        <ContextMenuItem disabled={index === count - 1} onSelect={() => moveView(id, side, index + 1)}>
          <ArrowDown /> {tr("Move down")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={resetDock}>
          <RotateCcw /> {tr("Reset panel layout")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
