// Tabs as a list down the left (Settings › Appearance › Tabs): one row per tab with what
// runs in it, its host / folder and its status; folds down to an icon strip.
import { Columns2, PanelLeftClose, PanelLeftOpen, Play } from "lucide-react";
import { AnimatePresence, motion, Reorder } from "motion/react";
import { useEffect, useState } from "react";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Tooltip } from "@/components/ui/tooltip";
import { beginLayoutAnimation, endLayoutAnimation } from "@/lib/layout-anim";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { isTermPane, type Pane, type Tab, useApp } from "@/store/app";
import { StatusDot } from "./StatusDot";
import { GroupDots, NewTabButton, TabMenu, TabProgress, TabStatus, useHoverSwitch, useTabInfo } from "./TitleBar";

const spring = { type: "spring", stiffness: 520, damping: 40, mass: 0.7 } as const;
const MIN_W = 160;
const MAX_W = 420;
const FOLDED_W = 48;

export function VerticalTabs() {
  const on = useApp((s) => s.settings.tabPosition === "left");
  const tabs = useApp((s) => s.tabs);
  const folded = useApp((s) => s.settings.vtabsCollapsed);
  const width = useApp((s) => s.settings.vtabsWidth);
  const reduce = useApp((s) => s.settings.reduceEffects);
  const [live, setLive] = useState<number | null>(null);
  const w = folded ? FOLDED_W : (live ?? width);

  const onResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = w;
    let last = start;
    const move = (ev: PointerEvent) => {
      last = Math.min(MAX_W, Math.max(MIN_W, start + ev.clientX - startX));
      setLive(last);
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.cursor = "";
      setLive(null);
      void useApp.getState().updateSettings({ vtabsWidth: Math.round(last) });
    };
    document.body.style.cursor = "col-resize";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const fold = () => void useApp.getState().updateSettings({ vtabsCollapsed: !folded });

  if (!on) return null;
  return (
    <motion.nav
      initial={false}
      animate={{ width: w }}
      transition={live !== null || reduce ? { duration: 0 } : { duration: 0.2, ease: [0.25, 0.8, 0.25, 1] }}
      onAnimationStart={() => live === null && beginLayoutAnimation()}
      onAnimationComplete={() => live === null && endLayoutAnimation()}
      className="relative flex shrink-0 flex-col overflow-hidden border-r border-ov/[0.06]"
      aria-label={tr("Tabs")}
    >
      <div className={cn("flex h-9 shrink-0 items-center gap-1", folded ? "flex-col justify-center" : "pr-1 pl-3")}>
        {!folded && (
          <span className="flex-1 truncate text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
            {tr("Tabs")} <span className="tabular-nums opacity-70">{tabs.length}</span>
          </span>
        )}
        {!folded && <NewTabButton />}
        <Tooltip content={folded ? tr("Show tab names") : tr("Fold to icons")}>
          <button
            type="button"
            onClick={fold}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-ov/[0.06] hover:text-foreground"
          >
            {folded ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
          </button>
        </Tooltip>
      </div>
      <Reorder.Group
        as="div"
        axis="y"
        values={tabs}
        onReorder={(next: Tab[]) => useApp.getState().set({ tabs: next })}
        className="no-scrollbar flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5 pb-2"
      >
        <AnimatePresence initial={false}>
          {tabs.map((t) => (
            <Row key={t.id} tab={t} folded={folded} />
          ))}
        </AnimatePresence>
      </Reorder.Group>
      {folded && (
        <div className="flex shrink-0 justify-center pb-2">
          <NewTabButton compact />
        </div>
      )}
      {!folded && (
        <div
          onPointerDown={onResize}
          onDoubleClick={() => void useApp.getState().updateSettings({ vtabsWidth: 220 })}
          className={cn(
            "absolute inset-y-0 right-0 z-20 w-1.5 cursor-col-resize transition-colors hover:bg-primary/40",
            live !== null && "bg-primary/40",
          )}
        />
      )}
    </motion.nav>
  );
}

/** The command running in a pane right now (its shell's current block), if any. */
function useRunning(pane: Pane | undefined): string | null {
  const [cmd, setCmd] = useState<string | null>(null);
  useEffect(() => {
    if (!pane || !isTermPane(pane)) return setCmd(null);
    const blocks = pane.session.blocks;
    const update = () => {
      const b = blocks.list.at(-1);
      setCmd(b && b.finishedAt === null && b.command.trim() ? b.command.trim() : null);
    };
    update();
    const off = blocks.onChange(update);
    return () => void off();
  }, [pane]);
  return cmd;
}

function Row({ tab, folded }: { tab: Tab; folded: boolean }) {
  const { active, pane, groups, count, attention, progress, Icon, title, rename } = useTabInfo(tab);
  const hover = useHoverSwitch(tab.id, active);
  const running = useRunning(pane);
  if (!pane) return null;
  const where = pane.kind === "local" ? (pane.cwd ?? pane.subtitle) : pane.kind === "ssh" ? (pane.cwd ? `${pane.subtitle} · ${pane.cwd}` : pane.subtitle) : pane.subtitle;
  const { setActiveTab, closeTab } = useApp.getState();

  const item = (
    <Reorder.Item
      as="div"
      value={tab}
      layout="position"
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -6, transition: { duration: 0.12 } }}
      transition={spring}
      whileDrag={{ scale: 1.02, zIndex: 10 }}
      onPointerDown={(e) => e.button === 0 && setActiveTab(tab.id)}
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
        "group relative flex shrink-0 items-center rounded-md transition-colors duration-150",
        folded ? "h-10 justify-center" : "h-12 gap-2.5 pr-2 pl-2.5",
        active ? "bg-ov/[0.07] text-foreground" : "text-muted-foreground hover:bg-ov/[0.04] hover:text-foreground",
      )}
    >
      {active && (
        <motion.div
          layoutId="active-vtab"
          transition={spring}
          className="absolute inset-y-2 left-0 w-[2px] rounded-r-full bg-primary shadow-[0_0_8px_var(--primary)]"
        />
      )}
      <span className="relative">
        <Icon
          className={cn(
            "size-4 shrink-0 transition-[color,filter] duration-200",
            active ? "text-primary drop-shadow-[0_0_5px_color-mix(in_oklab,var(--primary)_70%,transparent)]" : "opacity-80",
          )}
        />
        {folded && (attention || running || pane.status !== "connected") && (
          <span className="absolute -right-1.5 -bottom-1">
            {attention ? (
              <span
                className={cn(
                  "block size-2 rounded-full ring-2 ring-chrome",
                  attention === "fail" ? "bg-destructive" : attention === "wait" ? "animate-pulse bg-warning" : "bg-success",
                )}
              />
            ) : running ? (
              <span className="block size-2 animate-pulse rounded-full bg-primary ring-2 ring-chrome" />
            ) : (
              <StatusDot status={pane.status} />
            )}
          </span>
        )}
      </span>
      {!folded && (
        <>
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate text-[12.5px] font-medium">{title}</span>
              <GroupDots groups={groups} ring={active ? "ring-transparent" : "ring-chrome"} />
            </span>
            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
              {running ? (
                <>
                  <Play className="size-2.5 shrink-0 fill-primary text-primary" />
                  <span className="truncate font-mono text-[10.5px] text-foreground/75">{running}</span>
                </>
              ) : (
                <span className="truncate">{where}</span>
              )}
            </span>
          </span>
          {count > 1 && (
            <span className="flex items-center gap-0.5 rounded bg-ov/10 px-1 text-[10px] text-muted-foreground tabular-nums">
              <Columns2 className="size-2.5" />
              {count}
            </span>
          )}
          <TabStatus tab={tab} attention={attention} status={pane.status} />
        </>
      )}
      <TabProgress progress={progress} className={folded ? "inset-x-2 bottom-1" : "right-2.5 bottom-1 left-2.5"} />
    </Reorder.Item>
  );

  return (
    <ContextMenu>
      {folded ? (
        <Tooltip content={`${title} · ${running ?? where}`} side="right">
          <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
        </Tooltip>
      ) : (
        <ContextMenuTrigger asChild>{item}</ContextMenuTrigger>
      )}
      <TabMenu tab={tab} pane={pane} rename={rename} />
    </ContextMenu>
  );
}
