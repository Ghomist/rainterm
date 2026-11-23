// The agents session: a board of goals, each a small flow chart of its tasks, with pages
// for a goal (report, follow-ups) and a task (output, checks, the agents' work). The pool,
// approvals and live runs sit in the "Agent pool" dock view (AgentsDock).
import {
  Bot,
  Check,
  ChevronRight,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleStop,
  GitMerge,
  Hand,
  Loader2,
  OctagonX,
  SkipForward,
  PanelRight,
  Plus,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComboInput, NumberInput, Select, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconButton, PanelHeader } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import { effectiveRoles, runtimeLabel, shortName, STATUS_LABEL, TIER_HINT, tierLabel } from "@/lib/forge/config";
import { forge } from "@/lib/forge/engine";
import { newGoal } from "@/lib/forge/entry";
import { OUTPUT_LANGUAGES } from "@/lib/forge/llm";
import { proseOnly } from "@/lib/forge/prompts";
import { useForge, useRunEvents } from "@/lib/forge/store";
import { type AgentEvent, type AgentRun, type Autonomy, type Goal, type PendingApproval, type Status, TIERS, type Tier } from "@/lib/forge/types";
import { tr } from "@/lib/i18n";
import { confirm, toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { isViewOpen, type Pane, useApp } from "@/store/app";
import { RichMarkdown } from "@/components/ui/markdown";
import { openAgentsSettings } from "./AgentsSettings";
import { Board, GoalPage, TaskPage } from "./AgentsBoard";
import { PaneHeader } from "./TerminalArea";

export { STATUS_LABEL };

// ------------------------------------------------------------------ shared bits

export const AUTONOMY: { value: Autonomy; label: string; hint: string }[] = [
  { value: "cautious", label: "Cautious", hint: "Plans need your OK" },
  { value: "balanced", label: "Balanced", hint: "Asks for risky steps and merging" },
  { value: "hands-off", label: "Hands-off", hint: "Merges and pushes on its own" },
];

export const GOAL_LABEL: Record<Goal["status"], string> = {
  planning: "Planning",
  active: "In progress",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  needs_human: "Needs you",
};

export function tone(s: Status | Goal["status"]) {
  if (s === "done") return "text-success";
  if (s === "running" || s === "claimed" || s === "planning" || s === "active") return "text-primary";
  if (s === "verifying") return "text-[#c084fc]";
  if (s === "needs_human" || s === "needs_split" || s === "draft") return "text-warning";
  if (s === "failed") return "text-destructive";
  return "text-muted-foreground";
}

export function StatusIcon({ s, className }: { s: Status; className?: string }) {
  const c = cn("size-3.5 shrink-0", tone(s), className);
  if (s === "done") return <Check className={c} />;
  if (s === "running" || s === "claimed") return <Loader2 className={cn(c, "animate-spin")} />;
  if (s === "verifying") return <ShieldCheck className={cn(c, "animate-pulse")} />;
  if (s === "needs_human" || s === "needs_split" || s === "draft") return <Hand className={c} />;
  if (s === "failed") return <X className={c} />;
  if (s === "cancelled") return <X className={c} />;
  if (s === "skipped") return <SkipForward className={c} />;
  return <CircleDashed className={c} />;
}

/** "2m 03s" since a start time, ticking. */
export function Elapsed({ from, to }: { from: string; to?: string }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (to) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [to]);
  const ms = (to ? Date.parse(to) : Date.now()) - Date.parse(from);
  const s = Math.max(0, Math.round(ms / 1000));
  return <span className="tabular-nums">{s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`}</span>;
}

function useRoles() {
  const config = useForge((s) => s.config);
  return useMemo(() => effectiveRoles(config), [config]);
}

export function RoleChip({ role, tier, up }: { role: string; tier?: Tier; up?: boolean }) {
  const roles = useRoles();
  const r = roles.find((x) => x.id === role);
  const color = r?.color ?? "#a1a1aa";
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-px text-[10.5px] font-medium" style={{ background: `${color}22`, color }}>
      {r ? tr(r.name) : role}
      {tier && (
        <span className="opacity-70">
          · {up && "↑"}
          {tierLabel(tier)}
        </span>
      )}
    </span>
  );
}

/** What the user asked for, shortened: how goals are named everywhere people look. */
export function goalTitle(id: string) {
  const g = useForge.getState().goals[id];
  return g ? shortName(g.text) : id;
}

// ------------------------------------------------------------------ the pane

export type Page = { kind: "board" } | { kind: "goal"; id: string } | { kind: "task"; id: string };

export function AgentsView({ pane, focused, visible, multi, zoomed }: { pane: Pane; focused: boolean; visible: boolean; multi: boolean; zoomed: boolean }) {
  const focusPane = useApp((s) => s.focusPane);
  const loaded = useForge((s) => s.loaded);
  const [page, setPage] = useState<Page>({ kind: "board" });
  const [creating, setCreating] = useState(false);
  // over a background image, the same see-through mask as terminals
  const glass = useApp((s) => (s.settings.backdrop !== "none" ? s.settings.glassOpacity : null));
  useEffect(() => {
    void forge.start();
  }, []);
  // switching to the board brings up its pool panel in the dock
  useEffect(() => {
    if (visible) useApp.getState().toggleView("agents", true);
  }, [visible]);
  // a page whose goal / task was removed goes back to the board
  const exists = useForge((s) => (page.kind === "goal" ? !!s.goals[page.id] : page.kind === "task" ? !!s.stories[page.id] : true));
  useEffect(() => {
    if (loaded && !exists) setPage({ kind: "board" });
  }, [exists, loaded]);
  return (
    <div
      data-pane-id={pane.id}
      data-glass={glass != null ? "on" : undefined}
      style={glass != null ? { background: `color-mix(in srgb, var(--surface) ${Math.round(glass * 100)}%, transparent)` } : undefined}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => focusPane(pane.id)}
    >
      {multi && <PaneHeader pane={pane} focused={focused} multi={multi} zoomed={zoomed} />}
      <Toolbar onNew={() => setCreating(true)} page={page} go={setPage} />
      {!loaded ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : page.kind === "goal" ? (
        <GoalPage key={page.id} id={page.id} go={setPage} />
      ) : page.kind === "task" ? (
        <TaskPage key={page.id} id={page.id} go={setPage} />
      ) : (
        <Board go={setPage} onNew={() => setCreating(true)} />
      )}
      <NewGoalDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(id) => setPage({ kind: "goal", id })}
      />
    </div>
  );
}

function NewGoalDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const g = await newGoal(text);
      setText("");
      onClose();
      if (g) onCreated(g.id);
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't start the task"), description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(620px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{tr("New task")}</DialogTitle>
          <DialogDescription>
            {tr("Describe what you want done. Mention a local folder path to work in it (git repositories get isolated branches); machines are reached through your saved SSH hosts.")}
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          rows={7}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={tr("e.g. Add a --json flag to the CLI in D:\\Projects\\tool, or: check why disk usage on web-1 keeps growing")}
          className="w-full resize-y rounded-lg border border-input bg-inset px-3 py-2 text-[13px] leading-relaxed outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
        />
        <DialogFooter>
          <span className="mr-auto self-center text-[11px] text-muted-foreground">Ctrl+Enter</span>
          <Button variant="ghost" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!text.trim() || busy} onClick={() => void submit()}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {tr("Start")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function useCostToday() {
  const runs = useForge((s) => s.runs);
  return useMemo(() => {
    const day = new Date().toISOString().slice(0, 10);
    return Object.values(runs).reduce((a, r) => a + (r.startedAt.startsWith(day) ? (r.usage?.costUsd ?? 0) : 0), 0);
  }, [runs]);
}

function Slots() {
  // each agent's own limit adds up to the pool's capacity
  const cap = useForge((s) => s.config.peers.filter((p) => p.enabled !== false).reduce((n, p) => n + p.maxConcurrent, 0));
  const active = useForge((s) => s.activeRuns.length);
  return (
    <Tooltip content={tr("{0} of {1} agent slots in use", { 0: active, 1: cap })}>
      <span className="flex items-center gap-[3px]">
        {Array.from({ length: cap }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: slots
          <span key={i} className={cn("size-1.5 rounded-full", i < active ? "animate-pulse bg-primary" : "bg-ov/15")} />
        ))}
      </span>
    </Tooltip>
  );
}

/** Agents › goal › step — each level clickable. */
function Breadcrumb({ page, go }: { page: Page; go: (p: Page) => void }) {
  const story = useForge((s) => (page.kind === "task" ? s.stories[page.id] : undefined));
  const goalId = page.kind === "goal" ? page.id : story?.goal;
  const goal = useForge((s) => (goalId ? s.goals[goalId] : undefined));
  const crumbs: { label: string; to?: Page }[] = [{ label: tr("Agents"), to: page.kind === "board" ? undefined : { kind: "board" } }];
  if (goal) crumbs.push({ label: shortName(goal.text, 40), to: page.kind === "task" ? { kind: "goal", id: goal.id } : undefined });
  if (story) crumbs.push({ label: story.title });
  return (
    <nav className="flex min-w-0 items-center gap-1 text-[13px]">
      <Bot className="size-4 shrink-0 text-primary" />
      {crumbs.map((c, i) => (
        <span key={c.label + i} className="flex min-w-0 items-center gap-1">
          {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/60" />}
          {c.to ? (
            <button type="button" onClick={() => go(c.to!)} className="press min-w-0 truncate rounded px-1 text-muted-foreground hover:bg-ov/[0.06] hover:text-foreground">
              {c.label}
            </button>
          ) : (
            <span className={cn("min-w-0 truncate px-1", i === crumbs.length - 1 && "font-semibold")}>{c.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

function Toolbar({ onNew, page, go }: { onNew: () => void; page: Page; go: (p: Page) => void }) {
  const paused = useForge((s) => s.paused);
  const active = useForge((s) => s.activeRuns.length);
  const goals = useForge((s) => s.goals);
  const panel = useApp((s) => isViewOpen(s, "agents"));
  const cost = useCostToday();
  const open = Object.values(goals).filter((g) => !["done", "cancelled", "failed"].includes(g.status)).length;
  return (
    <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-ov/[0.06] px-3">
      <Breadcrumb page={page} go={go} />
      <Slots />
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {paused ? <span className="text-warning">{tr("Dispatching paused")}</span> : open ? tr("{0} goals in progress", { 0: open }) : null}
        {cost > 0 && <span className="ml-2 tabular-nums">{tr("Today ${0}", { 0: cost.toFixed(2) })}</span>}
      </span>
      <div className="flex-1" />
      {active > 0 && (
        <IconButton tip={tr("Emergency stop: pause and cancel every running agent")} danger onClick={() => void forge.emergencyStop()}>
          <OctagonX />
        </IconButton>
      )}
      <IconButton tip={panel ? tr("Hide the agent pool") : tr("Show the agent pool")} active={panel} onClick={() => useApp.getState().toggleView("agents")}>
        <PanelRight />
      </IconButton>
      <Button size="sm" onClick={onNew}>
        <Plus className="size-3.5" /> {tr("New task")}
      </Button>
    </div>
  );
}

export function GoalActions({ goal, onRemoved }: { goal: Goal; onRemoved?: () => void }) {
  const running = !["done", "cancelled", "failed"].includes(goal.status);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {running ? (
        <IconButton
          tip={tr("Cancel this goal")}
          className="size-6"
          danger
          onClick={() =>
            void confirm({ title: tr("Cancel {0}?", { 0: goal.id }), message: tr("Running agents are stopped; finished work stays on its branch."), confirmLabel: tr("Cancel goal") }).then(
              (ok) => ok && forge.cancelGoal(goal.id),
            )
          }
        >
          <CircleStop />
        </IconButton>
      ) : (
        <IconButton
          tip={tr("Remove from the board")}
          className="size-6"
          danger
          onClick={() =>
            void confirm({
              title: tr("Remove {0}?", { 0: goal.id }),
              message: tr("Its tasks and logs are removed; unmerged forge branches of it are deleted."),
              confirmLabel: tr("Remove"),
            }).then((ok) => {
              if (!ok) return;
              forge.deleteGoal(goal.id);
              onRemoved?.();
            })
          }
        >
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}

export function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("press flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px]", on ? "bg-primary/12 text-primary" : "text-muted-foreground hover:bg-ov/[0.06] hover:text-foreground")}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ run output


type Piece =
  | { k: "text"; text: string }
  | { k: "tools"; items: Extract<AgentEvent, { t: "tool" }>[] }
  | { k: "note"; text: string; tone: "warn" | "error" }
  | { k: "said"; from: "user" | "supervisor"; text: string }
  | { k: "plan"; items: { content: string; status: string }[] };

function readable(events: { event: AgentEvent }[]): Piece[] {
  const out: Piece[] = [];
  for (const { event: e } of events) {
    const last = out[out.length - 1];
    if (e.t === "text") {
      if (last?.k === "text") last.text += e.text;
      else out.push({ k: "text", text: e.text });
    } else if (e.t === "tool") {
      if (last?.k === "tools") last.items.push(e);
      else out.push({ k: "tools", items: [e] });
    } else if (e.t === "plan") {
      const prev = out.findIndex((p) => p.k === "plan");
      if (prev >= 0) out.splice(prev, 1);
      out.push({ k: "plan", items: e.items });
    } else if (e.t === "permission" && e.decision !== "allow") {
      out.push({ k: "note", tone: e.decision === "deny" ? "error" : "warn", text: `${e.decision === "deny" ? tr("Not allowed") : tr("Asked you")}: ${e.title}` });
    } else if (e.t === "error") out.push({ k: "note", tone: "error", text: e.message });
    else if (e.t === "note") out.push({ k: "said", from: e.from, text: e.text });
  }
  return out
    .map((p) => (p.k === "text" ? { ...p, text: proseOnly(p.text) } : p))
    .filter((p) => !(p.k === "text" && !p.text));
}

export function RunLog({ runId }: { runId: string }) {
  const events = useRunEvents((s) => s[runId]);
  const run = useForge((s) => s.runs[runId]);
  const [raw, setRaw] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {
    if (!events) void forge.store.loadRunEvents(runId);
  }, [events, runId]);
  useEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  const live = run && ["starting", "running", "waiting_permission"].includes(run.status);
  const pieces = useMemo(() => readable(events ?? []), [events]);
  const shown = (events ?? []).filter((e) => e.event.t !== "usage" && e.event.t !== "end");
  return (
    <div className="overflow-hidden rounded-lg border border-ov/[0.07] bg-inset/50">
      {run && (
        <div className="flex flex-wrap items-center gap-x-3 border-b border-ov/[0.05] px-2.5 py-1 text-[10.5px] text-muted-foreground">
          <span>{run.peer}</span>
          <Elapsed from={run.startedAt} to={run.endedAt} />
          {run.usage?.costUsd != null && <span>${run.usage.costUsd.toFixed(3)}</span>}
          {(run.usage?.inputTokens ?? 0) > 0 && <span>{tr("{0} in · {1} out", { 0: fmtK(run.usage!.inputTokens!), 1: fmtK(run.usage!.outputTokens ?? 0) })}</span>}
          <div className="flex-1" />
          <button type="button" onClick={() => setRaw(!raw)} className="press rounded px-1 hover:bg-ov/[0.06] hover:text-foreground">
            {raw ? tr("Readable") : tr("Raw log")}
          </button>
        </div>
      )}
      <div
        ref={box}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
        }}
        className={cn("max-h-96 overflow-y-auto px-2.5 py-2", raw ? "font-mono text-[11px] leading-relaxed" : "text-[12px] leading-relaxed")}
      >
        {raw ? (
          <>
            {!shown.length && <div className="text-muted-foreground">{events ? tr("No output yet.") : tr("Loading…")}</div>}
            {shown.map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: append-only log
              <EventLine key={i} e={e.event} />
            ))}
          </>
        ) : (
          <div className="flex flex-col gap-2">
            {!pieces.length && !live && <div className="text-muted-foreground">{events ? tr("No output.") : tr("Loading…")}</div>}
            {pieces.map((p, i) =>
              p.k === "text" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: derived list
                <RichMarkdown key={i} text={p.text} compact />
              ) : p.k === "tools" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: derived list
                <ToolGroup key={i} items={p.items} />
              ) : p.k === "plan" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: derived list
                <div key={i} className="flex flex-col gap-0.5 text-[11.5px] text-muted-foreground">
                  {p.items.map((it, j) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static
                    <div key={j} className={cn(it.status === "completed" && "line-through opacity-60")}>
                      {it.status === "completed" ? "☑" : it.status === "in_progress" ? "◐" : "☐"} {it.content}
                    </div>
                  ))}
                </div>
              ) : p.k === "said" ? (
                // biome-ignore lint/suspicious/noArrayIndexKey: derived list
                <div key={i} className={cn("rounded-md border-l-2 px-2.5 py-1.5 text-[12px]", p.from === "user" ? "border-primary bg-primary/[0.06]" : "border-[#c084fc] bg-[#c084fc]/[0.07]")}>
                  <div className="text-[10.5px] font-medium text-muted-foreground">{p.from === "user" ? tr("You said") : tr("Supervisor stepped in")}</div>
                  {p.text}
                </div>
              ) : (
                // biome-ignore lint/suspicious/noArrayIndexKey: derived list
                <div key={i} className={cn("text-[11.5px]", p.tone === "error" ? "text-destructive" : "text-warning")}>
                  {p.text}
                </div>
              ),
            )}
            {live && (
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Loader2 className="size-3 animate-spin text-primary" />
                <span className="truncate">{run.status === "waiting_permission" ? tr("Waiting for your OK") : run.activity || tr("Working…")}</span>
              </div>
            )}
            {run?.error && run.error !== "cancelled" && !live && <div className="text-[11.5px] text-destructive">{run.error.slice(0, 400)}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

/** Consecutive tool calls as one compact line: "Used 4 tools: read a.ts, grep foo…" (expandable). */
function ToolGroup({ items }: { items: Extract<AgentEvent, { t: "tool" }>[] }) {
  const [open, setOpen] = useState(false);
  const failed = items.filter((x) => x.status === "failed").length;
  const running = items.some((x) => x.status === "pending" || x.status === "in_progress");
  return (
    <div className="text-[11.5px] text-muted-foreground">
      <button type="button" onClick={() => setOpen(!open)} className="flex max-w-full min-w-0 items-center gap-1.5 hover:text-foreground">
        <ChevronRight className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        {running ? <Loader2 className="size-3 shrink-0 animate-spin text-primary" /> : <Wrench className="size-3 shrink-0" />}
        <span className="shrink-0">{tr("Used {0} tools", { 0: items.length })}</span>
        {failed > 0 && <span className="shrink-0 text-destructive">{tr("{0} failed", { 0: failed })}</span>}
        {!open && <span className="min-w-0 truncate opacity-70">· {items.map((x) => x.title).join(" · ")}</span>}
      </button>
      {open && (
        <div className="mt-0.5 ml-4.5 flex flex-col gap-0.5 border-l border-ov/10 pl-2">
          {items.map((x) => (
            <div key={x.id} className="flex min-w-0 items-center gap-1.5">
              <span className={cn("shrink-0", x.status === "failed" ? "text-destructive" : x.status === "completed" ? "text-success" : "text-primary")}>
                {x.status === "failed" ? "✗" : x.status === "completed" ? "✓" : "·"}
              </span>
              <span className="min-w-0 truncate font-mono text-[11px] text-foreground/80">{x.title}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function EventLine({ e }: { e: AgentEvent }) {
  const [open, setOpen] = useState(false);
  switch (e.t) {
    case "start":
      return <div className="text-muted-foreground">▸ {e.info}</div>;
    case "text":
      return <div className="font-sans text-[12px] whitespace-pre-wrap text-foreground/90">{e.text.replace(/```json[\s\S]*?```/g, "").trim() || "…"}</div>;
    case "thinking":
      return (
        <div>
          <button type="button" onClick={() => setOpen(!open)} className="text-muted-foreground/70 italic hover:text-muted-foreground">
            {tr("thinking")} {open ? "▾" : "▸"}
          </button>
          {open && <div className="border-l border-ov/10 pl-2 whitespace-pre-wrap text-muted-foreground">{e.text}</div>}
        </div>
      );
    case "plan":
      return (
        <div className="text-muted-foreground">
          {e.items.map((it, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static
            <div key={i}>
              {it.status === "completed" ? "☑" : it.status === "in_progress" ? "◐" : "☐"} {it.content}
            </div>
          ))}
        </div>
      );
    case "tool": {
      const live = e.status === "pending" || e.status === "in_progress";
      return (
        <div>
          <button type="button" onClick={() => e.detail && setOpen(!open)} className="flex w-full min-w-0 items-center gap-1.5 text-left">
            <span className={cn("shrink-0", live ? "text-primary" : e.status === "failed" ? "text-destructive" : "text-success")}>
              {live ? <Loader2 className="size-3 animate-spin" /> : e.status === "failed" ? "✗" : "✓"}
            </span>
            <span className="min-w-0 truncate text-foreground/85">{e.title}</span>
            {e.kind && <span className="shrink-0 text-[10px] text-muted-foreground">{e.kind}</span>}
          </button>
          {open && e.detail && <pre className="mt-0.5 ml-4 max-h-48 overflow-auto whitespace-pre-wrap text-muted-foreground">{e.detail}</pre>}
        </div>
      );
    }
    case "permission":
      return (
        <div className={cn(e.decision === "deny" ? "text-destructive" : e.decision === "pending_human" ? "text-warning" : "text-muted-foreground/70")}>
          {e.decision === "allow" ? "✓" : e.decision === "deny" ? "⊘" : "✋"} {e.title} <span className="opacity-70">— {e.reason}</span>
        </div>
      );
    case "stderr":
      return <div className="whitespace-pre-wrap text-muted-foreground/60">{e.text.trim()}</div>;
    case "error":
      return <div className="whitespace-pre-wrap text-destructive">{e.message}</div>;
    case "note":
      return <div className="whitespace-pre-wrap text-primary">» {e.from === "user" ? tr("You said") : tr("Supervisor stepped in")}: {e.text}</div>;
    default:
      return null;
  }
}

// ------------------------------------------------------------------ approvals

export function ApprovalCard({ ap, compact }: { ap: PendingApproval; compact?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const icon = ap.kind === "merge" ? <GitMerge className="size-4" /> : ap.kind === "plan" ? <ShieldCheck className="size-4" /> : <Hand className="size-4" />;
  const act = async (allow: boolean) => {
    setBusy(true);
    try {
      await forge.resolveApproval(ap.id, allow, note || undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="flex items-start gap-2.5 rounded-lg border border-warning/35 bg-warning/[0.06] px-3 py-2"
    >
      <span className="mt-0.5 text-warning">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium break-words">{ap.title}</div>
        {ap.detail && <div className="mt-0.5 text-[11.5px] break-words whitespace-pre-wrap text-muted-foreground">{ap.detail}</div>}
        {ap.kind === "plan" && !compact && (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={tr("Feedback to re-plan with (optional, when rejecting)")}
            className="mt-1.5 h-7 w-full rounded-md border border-ov/10 bg-inset px-2 text-[11.5px] outline-none focus:border-primary/50"
          />
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => void act(false)}>
          {ap.kind === "merge" ? tr("Not now") : tr("Deny")}
        </Button>
        <Button size="sm" disabled={busy} onClick={() => void act(true)}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {ap.kind === "merge" ? tr("Merge") : tr("Allow")}
        </Button>
      </div>
    </motion.div>
  );
}

// ------------------------------------------------------------------ dock view

/** The board's right column: what needs you, the pool (who's busy), live and recent runs. */
/** Right-dock "Agent pool" view: controls, the pool, what needs you, live and recent runs. */
export function AgentsDock() {
  const hasBoard = useApp((s) => Object.values(s.panes).some((p) => p.kind === "agents"));
  const loaded = useForge((s) => s.loaded);
  if (!hasBoard || !loaded)
    return (
      <>
        <PanelHeader title={tr("Agent pool")} icon={<Bot />} />
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-10 text-center text-[12px] text-muted-foreground">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Bot className="size-5" />
          </div>
          {tr("Open the agents session to see and manage the pool.")}
          <Button size="sm" variant="secondary" onClick={() => useApp.getState().openAgents()}>
            {tr("Open agents")}
          </Button>
        </div>
      </>
    );
  return <PoolPanel />;
}

function PoolPanel() {
  const config = useForge((s) => s.config);
  const paused = useForge((s) => s.paused);
  const runs = useForge((s) => s.runs);
  const active = useForge((s) => s.activeRuns);
  const approvals = useForge((s) => s.approvals);
  const stories = useForge((s) => s.stories);
  const cost = useCostToday();
  const live = active.map((id) => runs[id]).filter(Boolean);
  const aps = Object.values(approvals);
  const set = (fn: (c: typeof config) => void) => {
    const c = structuredClone(forge.config);
    fn(c);
    forge.updateConfig(c);
  };
  const [editing, setEditing] = useState<number | null>(null);
  const addPeer = () => {
    const c = structuredClone(forge.config);
    const probes = useForge.getState().probes;
    const rt = c.runtimes.find((r) => r.enabled !== false && probes[r.id]?.ok) ?? c.runtimes[0];
    let id = rt?.id ?? "agent";
    for (let i = 2; c.peers.some((p) => p.id === id); i++) id = `${rt?.id ?? "agent"}-${i}`;
    c.peers.push({ id, runtime: rt?.id ?? "rainterm", roles: ["research", "build"], tier: "L2", maxConcurrent: 1, enabled: true });
    forge.updateConfig(c);
    setEditing(c.peers.length - 1);
  };
  return (
    <>
      <PanelHeader title={tr("Agent pool")} icon={<Bot />}>
        <IconButton tip={paused ? tr("Resume dispatching") : tr("Pause dispatching (running agents finish)")} active={paused} onClick={() => forge.setPaused(!paused)}>
          {paused ? <CirclePlay /> : <CirclePause />}
        </IconButton>
        <IconButton tip={tr("Runtimes, roles and all agent settings")} onClick={() => openAgentsSettings()}>
          <Settings2 />
        </IconButton>
      </PanelHeader>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3 text-[12px]">
        <div className="flex flex-col gap-2 rounded-lg border border-ov/[0.07] bg-ov/[0.02] p-2.5">
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[11.5px] text-muted-foreground">{tr("Autonomy")}</span>
            <Select<Autonomy>
              size="sm"
              className="h-7 min-w-0 flex-1"
              value={config.autonomy}
              options={AUTONOMY.map((x) => ({ value: x.value, label: tr(x.label), hint: tr(x.hint) }))}
              onChange={(v) => set((c) => (c.autonomy = v))}
            />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[11.5px] text-muted-foreground">{tr("Language")}</span>
            <Select<string>
              size="sm"
              className="h-7 min-w-0 flex-1"
              value={config.outputLanguage ?? "system"}
              options={OUTPUT_LANGUAGES.map((l) => ({ value: l.value, label: l.value === "system" ? tr(l.label) : l.label }))}
              onChange={(v) => set((c) => (c.outputLanguage = v))}
            />
          </div>
          <div className="flex items-center gap-2">
            <Tooltip content={tr("Every few minutes, check what each working agent is doing; if it clearly drifted from its step, interrupt and correct it.")}>
              <span className="flex-1 text-[11.5px] text-muted-foreground">{tr("Keep agents on track")}</span>
            </Tooltip>
            <Switch checked={config.supervise !== false} onChange={(v) => set((c) => (c.supervise = v))} />
          </div>
          <div className="flex items-center gap-2">
            <Tooltip content={tr("When a task finishes, keep what it taught about your machines and projects in the knowledge base (updating notes rather than piling them up), so later tasks start from it.")}>
              <span className="flex-1 text-[11.5px] text-muted-foreground">{tr("Learn from finished tasks")}</span>
            </Tooltip>
            <Switch checked={config.learn !== false} onChange={(v) => set((c) => (c.learn = v))} />
          </div>
          <div className="flex items-center gap-2">
            <span className="w-16 shrink-0 text-[11.5px] text-muted-foreground">{tr("Daily cap")}</span>
            <NumberInput value={config.limits.dailyCostUsd} min={0} max={10000} className="h-7 w-16" onChange={(v) => set((c) => (c.limits.dailyCostUsd = v))} />
            <span className="text-[11px] text-muted-foreground tabular-nums">{tr("USD · today ${0}", { 0: cost.toFixed(2) })}</span>
          </div>
          {live.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 justify-start text-destructive hover:text-destructive" onClick={() => void forge.emergencyStop()}>
              <OctagonX className="size-3.5" /> {tr("Emergency stop")}
            </Button>
          )}
        </div>

        {aps.length > 0 && (
          <Section title={tr("Needs you")} count={aps.length}>
            <div className="flex flex-col gap-1.5">
              {aps.map((a) => (
                <ApprovalCard key={a.id} ap={a} compact />
              ))}
            </div>
          </Section>
        )}

        <Section
          title={tr("Agent list")}
          count={config.peers.filter((p) => p.enabled !== false).length}
          action={
            <IconButton tip={tr("Add an agent")} className="size-6" onClick={addPeer}>
              <Plus />
            </IconButton>
          }
        >
          {config.peers.length === 0 && <div className="px-1 text-muted-foreground">{tr("No agents yet.")}</div>}
          {config.peers.map((p, i) => (
            <PeerLine key={`${i}-${p.id}`} index={i} live={live} open={editing === i} onToggle={() => setEditing(editing === i ? null : i)} />
          ))}
        </Section>

        <Section title={tr("Running")} count={live.length}>
          {!live.length && <div className="px-1 text-muted-foreground">{tr("Nothing is running.")}</div>}
          {live.map((r) => (
            <RunRow key={r.id} r={r} title={stories[r.subject]?.title} />
          ))}
        </Section>
      </div>
    </>
  );
}

/** One agent of the pool; click it to edit everything about it right here. */
function PeerLine({ index, live, open, onToggle }: { index: number; live: AgentRun[]; open: boolean; onToggle: () => void }) {
  const p = useForge((s) => s.config.peers[index]);
  const runtimes = useForge((s) => s.config.runtimes);
  const probes = useForge((s) => s.probes);
  const roles = useRoles();
  if (!p) return null;
  const rt = runtimes.find((r) => r.id === p.runtime);
  const probe = probes[p.runtime];
  const load = live.filter((r) => r.peer === p.id).length;
  const down = rt?.enabled === false || probe?.ok === false;
  const off = p.enabled === false;
  const set = (patch: Partial<typeof p>) => {
    const c = structuredClone(forge.config);
    c.peers[index] = { ...c.peers[index], ...patch };
    forge.updateConfig(c);
  };
  const remove = () => {
    const c = structuredClone(forge.config);
    c.peers.splice(index, 1);
    forge.updateConfig(c);
  };
  return (
    <div className={cn("rounded-lg transition-colors", open ? "bg-ov/[0.04] ring-1 ring-ov/[0.08]" : "hover:bg-ov/[0.03]")}>
      <div className={cn("flex cursor-default items-center gap-2 px-1.5 py-1.5", !open && (off || down) && "opacity-55")} onClick={onToggle}>
        <span
          className={cn("size-1.5 shrink-0 rounded-full", load ? "animate-pulse bg-primary" : down ? "bg-destructive/70" : off ? "bg-ov/25" : "bg-success/70")}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate font-medium">{p.id}</span>
            <span className="text-[10.5px] text-muted-foreground">{tierLabel(p.tier)}</span>
            <span className={cn("text-[10.5px] tabular-nums", load ? "text-primary" : "text-muted-foreground")}>
              {load ? tr("{0}/{1} running", { 0: load, 1: p.maxConcurrent }) : tr("up to {0} at once", { 0: p.maxConcurrent })}
            </span>
          </div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {down ? tr("runtime unavailable") : `${rt ? tr(runtimeLabel(rt.kind)) : p.runtime}${p.model ? ` · ${p.model}` : ""}${p.effort ? ` · ${p.effort}` : ""}`}
          </div>
        </div>
        <div onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
          <Switch checked={!off} onChange={(v) => set({ enabled: v })} />
        </div>
      </div>
      {!open && (
        <div className="flex flex-wrap gap-1 px-1.5 pb-1.5 pl-5">
          {p.roles.map((id) => {
            const r = roles.find((x) => x.id === id);
            const color = r?.color ?? "#a1a1aa";
            return (
              <span key={id} className="rounded px-1.5 py-px text-[10px] font-medium" style={{ background: `${color}1f`, color }}>
                {r ? tr(r.name) : id}
              </span>
            );
          })}
        </div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-2 px-2 pt-0.5 pb-2.5 text-[11.5px]">
              <Field label={tr("Name")}>
                <input
                  className="h-7 w-full min-w-0 rounded-md border border-input bg-inset px-2 outline-none focus:border-primary/60"
                  defaultValue={p.id}
                  onBlur={(e) => {
                    const v = e.target.value.trim().replace(/\s+/g, "-");
                    if (v && v !== p.id && !forge.config.peers.some((x, j) => j !== index && x.id === v)) set({ id: v });
                    else e.target.value = p.id;
                  }}
                />
              </Field>
              <Field label={tr("Runtime")}>
                <Select<string>
                  size="sm"
                  className="h-7 min-w-0 flex-1"
                  value={p.runtime}
                  options={runtimes.map((r) => ({
                    value: r.id,
                    label: r.id,
                    hint: probes[r.id]?.ok === false ? tr("unavailable") : tr(runtimeLabel(r.kind)),
                  }))}
                  onChange={(v) => set({ runtime: v, model: undefined, effort: undefined })}
                />
              </Field>
              <Field label={tr("Model")}>
                <ComboInput
                  className="h-7 min-w-0 flex-1 text-[11.5px]"
                  value={p.model ?? ""}
                  placeholder={tr("default model")}
                  options={(probe?.models ?? []).map((m) => ({ value: m.value, label: m.name, hint: m.group }))}
                  onChange={(v) => set({ model: v || undefined })}
                />
              </Field>
              <Field label={tr("Effort")}>
                <ComboInput
                  className="h-7 min-w-0 flex-1 text-[11.5px]"
                  value={p.effort ?? ""}
                  placeholder={tr("default")}
                  options={(probe?.efforts ?? []).map((m) => ({ value: m.value, label: m.name }))}
                  onChange={(v) => set({ effort: v || undefined })}
                />
              </Field>
              <Field label={tr("Tier")}>
                <div className="flex flex-1 gap-1">
                  {TIERS.map((t) => (
                    <Tooltip key={t} content={tr(TIER_HINT[t])}>
                      <button
                        type="button"
                        onClick={() => set({ tier: t })}
                        className={cn(
                          "press h-6 flex-1 rounded-md text-[11px] font-medium",
                          p.tier === t ? "bg-primary/15 text-primary" : "bg-ov/[0.05] text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {tierLabel(t)}
                      </button>
                    </Tooltip>
                  ))}
                </div>
              </Field>
              <Field label={tr("At once")}>
                <NumberInput value={p.maxConcurrent} min={1} max={8} className="h-7 w-16" onChange={(v) => set({ maxConcurrent: v })} />
              </Field>
              <div>
                <div className="mb-1 text-muted-foreground">{tr("Roles")}</div>
                <div className="flex flex-wrap gap-1">
                  {roles
                    .filter((r) => r.enabled !== false)
                    .map((r) => {
                      const on = p.roles.includes(r.id);
                      return (
                        <Tooltip key={r.id} content={tr(r.description)}>
                          <button
                            type="button"
                            onClick={() => set({ roles: on ? p.roles.filter((x) => x !== r.id) : [...p.roles, r.id] })}
                            className={cn("press rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition", !on && "opacity-45 hover:opacity-80")}
                            style={{ background: `${r.color}${on ? "30" : "14"}`, color: r.color }}
                          >
                            {on && <Check className="mr-0.5 inline size-3" />}
                            {tr(r.name)}
                          </button>
                        </Tooltip>
                      );
                    })}
                </div>
              </div>
              {probe && !probe.ok && !probe.probing && probe.error && (
                <div className="line-clamp-3 text-[10.5px] text-warning">{probe.error}</div>
              )}
              <div className="flex items-center gap-1">
                <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={remove}>
                  <Trash2 className="size-3.5" /> {tr("Remove")}
                </Button>
                <div className="flex-1" />
                <Button size="sm" variant="ghost" className="h-7" onClick={() => void forge.probe(p.runtime)}>
                  {probe?.probing ? <Loader2 className="size-3.5 animate-spin" /> : <RotateCcw className="size-3.5" />} {tr("Probe again")}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Section({ title, count, action, children }: { title: string; count?: number; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="pt-2">
      <div className="flex h-7 items-center gap-1.5 px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
        {title}
        {count != null && count > 0 && <span className="rounded-full bg-ov/10 px-1.5 text-[10px] tabular-nums">{count}</span>}
        <div className="flex-1" />
        {action}
      </div>
      {children}
    </div>
  );
}

function RunRow({ r, title }: { r: AgentRun; title?: string }) {
  const [open, setOpen] = useState(false);
  const live = r.status === "running" || r.status === "starting" || r.status === "waiting_permission";
  return (
    <div className="rounded-md hover:bg-ov/[0.03]">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full min-w-0 items-center gap-2 px-1.5 py-1 text-left">
        {live ? (
          r.status === "waiting_permission" ? <Hand className="size-3.5 shrink-0 text-warning" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
        ) : r.status === "done" ? (
          <Check className="size-3.5 shrink-0 text-success" />
        ) : (
          <X className={cn("size-3.5 shrink-0", r.status === "failed" ? "text-destructive" : "text-muted-foreground")} />
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="truncate">{title ?? (r.purpose === "plan" ? tr("Planning: {0}", { 0: goalTitle(r.subject) }) : "")}</span>
          </div>
          <div className="truncate text-[10.5px] text-muted-foreground">
            {r.peer} ·{" "}
            {live
              ? r.purpose === "verify"
                ? tr("verifying")
                : r.purpose === "plan"
                  ? tr("planning")
                  : tr("working")
              : r.status === "done"
                ? r.purpose === "verify"
                  ? tr("verified")
                  : r.purpose === "plan"
                    ? tr("planned")
                    : tr("finished")
                : r.status === "cancelled"
                  ? tr("stopped")
                  : tr("failed")}{" "}
            · <Elapsed from={r.startedAt} to={r.endedAt} />
            {live && r.activity ? ` · ${r.activity}` : ""}
          </div>
        </div>
      </button>
      {open && (
        <div className="px-1.5 pb-1.5">
          <RunLog runId={r.id} />
          {live && (
            <Button size="sm" variant="ghost" className="mt-1 h-6 text-destructive" onClick={() => void forge.cancelRun(r.id)}>
              <CircleStop className="size-3.5" /> {tr("Stop this agent")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
