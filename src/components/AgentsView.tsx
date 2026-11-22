// The agents session: talk to the entry agent, watch goals get planned into tasks, worked
// on by the agent pool, verified and merged — in a timeline like a terminal's scrollback.
// Pool, live runs and approvals also sit in the "Agents" dock view (AgentsDock).
import {
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  CircleDashed,
  CirclePause,
  CirclePlay,
  CircleStop,
  Folder,
  FolderOpen,
  GitMerge,
  Hand,
  Loader2,
  MessageSquareReply,
  OctagonX,
  Wrench,
  LayoutDashboard,
  MessagesSquare,
  Plus,
  PanelRight,
  RotateCcw,
  Settings2,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ComboInput, NumberInput, Select, Switch } from "@/components/ui/controls";
import { IconButton, PanelHeader } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import { effectiveRoles, runtimeLabel, shortName, STATUS_LABEL, TIER_HINT, tierLabel } from "@/lib/forge/config";
export { STATUS_LABEL };
import { forge } from "@/lib/forge/engine";
import { send } from "@/lib/forge/entry";
import { OUTPUT_LANGUAGES } from "@/lib/forge/llm";
import { useForge, useRunEvents } from "@/lib/forge/store";
import { type AgentEvent, type AgentRun, type Autonomy, type Goal, type PendingApproval, type Status, type Story, TIERS, type Tier } from "@/lib/forge/types";
import { tr } from "@/lib/i18n";
import { confirm } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { isViewOpen, type Pane, useApp } from "@/store/app";
import { Markdown } from "./AgentPanel";
import { openAgentsSettings } from "./AgentsSettings";
import { Kanban } from "./AgentsKanban";
import { PaneHeader } from "./TerminalArea";

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

export function GoalTag({ id }: { id: string }) {
  const g = useForge((s) => s.goals[id]);
  if (!g) return null;
  return <span className="mr-1.5 rounded bg-ov/[0.07] px-1.5 py-px text-[10.5px] text-muted-foreground">{shortName(g.text)}</span>;
}

// ------------------------------------------------------------------ the pane

export function AgentsView({ pane, focused, visible, multi, zoomed }: { pane: Pane; focused: boolean; visible: boolean; multi: boolean; zoomed: boolean }) {
  const focusPane = useApp((s) => s.focusPane);
  const loaded = useForge((s) => s.loaded);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [mode, setModeState] = useState<Mode>(() => {
    try {
      return localStorage.getItem("rt.agents.mode") === "chat" ? "chat" : "board";
    } catch {
      return "board";
    }
  });
  const setMode = (m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("rt.agents.mode", m);
    } catch {}
  };
  // over a background image, the same see-through mask as terminals
  const glass = useApp((s) => (s.settings.backdrop !== "none" ? s.settings.glassOpacity : null));
  useEffect(() => {
    void forge.start();
  }, []);
  // switching to the board brings up its pool panel in the dock
  useEffect(() => {
    if (visible) useApp.getState().toggleView("agents", true);
  }, [visible]);
  return (
    <div
      data-pane-id={pane.id}
      data-glass={glass != null ? "on" : undefined}
      style={glass != null ? { background: `color-mix(in srgb, var(--surface) ${Math.round(glass * 100)}%, transparent)` } : undefined}
      className="relative flex min-h-0 min-w-0 flex-1 flex-col"
      onPointerDownCapture={() => focusPane(pane.id)}
    >
      {multi && <PaneHeader pane={pane} focused={focused} multi={multi} zoomed={zoomed} />}
      <Toolbar mode={mode} setMode={setMode} />
      {loaded ? (
        <>
          {mode === "board" ? <Kanban onReply={setReplyTo} /> : <Timeline onReply={setReplyTo} />}
          {mode === "board" && <ReplyStrip onOpenChat={() => setMode("chat")} />}
          <Composer visible={visible} focused={focused} replyTo={replyTo} setReplyTo={setReplyTo} />
        </>
      ) : (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      )}
    </div>
  );
}

type Mode = "board" | "chat";

/** In board view, the entry agent's latest answer (and reports) still has to reach you. */
function ReplyStrip({ onOpenChat }: { onOpenChat: () => void }) {
  const timeline = useForge((s) => s.timeline);
  const thinking = useForge((s) => s.thinking);
  const [closed, setClosed] = useState<string | null>(() => timeline.at(-1)?.id ?? null);
  const last = timeline.at(-1);
  const show = thinking || (last && last.from !== "user" && last.id !== closed);
  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          className="shrink-0 px-4 pb-2"
        >
          <div className="mx-auto flex max-w-[800px] items-start gap-2 rounded-xl border border-ov/[0.08] bg-popover/90 px-3 py-2 text-[12.5px] shadow-lg shadow-shadow/30">
            <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
            <div className="max-h-48 min-w-0 flex-1 overflow-y-auto">
              {thinking ? (
                <span className="shimmer text-muted-foreground">{tr("Reading your message…")}</span>
              ) : (
                <>
                  {last?.goal && <GoalTag id={last.goal} />}
                  <Markdown text={last?.text ?? ""} />
                </>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton tip={tr("Open in the conversation")} className="size-6" onClick={onOpenChat}>
                <MessagesSquare />
              </IconButton>
              {!thinking && (
                <IconButton tip={tr("Dismiss")} className="size-6" onClick={() => setClosed(last?.id ?? null)}>
                  <X />
                </IconButton>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
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
  const cap = useForge((s) => s.config.limits.maxConcurrentRuns);
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

function Toolbar({ mode, setMode }: { mode: Mode; setMode: (m: Mode) => void }) {
  const paused = useForge((s) => s.paused);
  const active = useForge((s) => s.activeRuns.length);
  const goals = useForge((s) => s.goals);
  const panel = useApp((s) => isViewOpen(s, "agents"));
  const cost = useCostToday();
  const open = Object.values(goals).filter((g) => !["done", "cancelled", "failed"].includes(g.status)).length;
  return (
    <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-ov/[0.06] px-3">
      <Bot className="size-4 text-primary" />
      <span className="text-[13px] font-semibold">{tr("Agents")}</span>
      <Slots />
      <span className="text-[11px] text-muted-foreground">
        {paused ? <span className="text-warning">{tr("Dispatching paused")}</span> : open ? tr("{0} goals in progress", { 0: open }) : null}
        {cost > 0 && <span className="ml-2 tabular-nums">{tr("Today ${0}", { 0: cost.toFixed(2) })}</span>}
      </span>
      <div className="flex-1" />
      <div className="flex rounded-md bg-ov/[0.06] p-0.5 text-[11.5px]">
        {(
          [
            ["board", tr("Board"), <LayoutDashboard key="b" />],
            ["chat", tr("Conversation"), <MessagesSquare key="c" />],
          ] as const
        ).map(([m, label, icon]) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={cn(
              "press flex h-6 items-center gap-1 rounded px-2 [&_svg]:size-3.5",
              mode === m ? "bg-surface text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {icon}
            {label}
          </button>
        ))}
      </div>
      {active > 0 && (
        <IconButton tip={tr("Emergency stop: pause and cancel every running agent")} danger onClick={() => void forge.emergencyStop()}>
          <OctagonX />
        </IconButton>
      )}
      <IconButton tip={panel ? tr("Hide the agent pool") : tr("Show the agent pool")} active={panel} onClick={() => useApp.getState().toggleView("agents")}>
        <PanelRight />
      </IconButton>
    </div>
  );
}

// ------------------------------------------------------------------ timeline

function Timeline({ onReply: setReplyTo }: { onReply: (goal: string | null) => void }) {
  const timeline = useForge((s) => s.timeline);
  const goals = useForge((s) => s.goals);
  const thinking = useForge((s) => s.thinking);
  const approvals = useForge((s) => s.approvals);
  const list = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // a goal's card shows under the last message about it; goals never mentioned (none yet) at the end
  const lastFor = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of timeline) if (t.goal) m.set(t.goal, t.id);
    return m;
  }, [timeline]);
  const orphans = Object.values(goals).filter((g) => !lastFor.has(g.id));
  const loose = Object.values(approvals).filter((a) => !goalOfSubject(a.subject));

  useEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });

  return (
    <>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
        }}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex max-w-[800px] flex-col gap-3 px-4 py-4 text-[12.5px] leading-relaxed">
          {timeline.length === 0 && !orphans.length && <Welcome />}
          {orphans.map((g) => (
            <GoalCard key={g.id} goal={g} onReply={setReplyTo} />
          ))}
          {timeline.map((t) => (
            <div key={t.id} className="flex flex-col gap-2">
              {t.from === "user" ? (
                <div className="flex justify-end">
                  <div className="max-w-[80%] rounded-lg rounded-br-sm bg-primary/14 px-3 py-1.5 break-words whitespace-pre-wrap">
                    {t.goal && <GoalTag id={t.goal} />}
                    {t.text}
                  </div>
                </div>
              ) : t.from === "agent" ? (
                <div className="flex gap-2">
                  <Bot className="mt-0.5 size-4 shrink-0 text-primary" />
                  <div className="min-w-0 flex-1 text-foreground/95">
                    <Markdown text={t.text} />
                  </div>
                </div>
              ) : (
                <div className="pl-6 text-[11.5px] text-muted-foreground">{t.text}</div>
              )}
              {t.goal && lastFor.get(t.goal) === t.id && goals[t.goal] && <GoalCard goal={goals[t.goal]} onReply={setReplyTo} />}
            </div>
          ))}
          {loose.map((a) => (
            <ApprovalCard key={a.id} ap={a} />
          ))}
          {thinking && (
            <div className="flex items-center gap-2 pl-0.5 text-[12px] text-muted-foreground">
              <Bot className="size-4 text-primary" />
              <span className="shimmer">{tr("Reading your message…")}</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function goalOfSubject(subject: string) {
  const st = useForge.getState();
  return st.goals[subject] ?? (st.stories[subject] ? st.goals[st.stories[subject].goal] : undefined);
}

export function Welcome() {
  const probes = useForge((s) => s.probes);
  const peers = useForge((s) => s.config.peers);
  const ok = Object.values(probes).filter((p) => p.ok);
  const probing = Object.values(probes).some((p) => p.probing);
  return (
    <div className="mx-auto mt-[8vh] flex max-w-[520px] flex-col items-center gap-3 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
        <Bot className="size-6" />
      </div>
      <div className="text-[15px] font-semibold">{tr("Agents")}</div>
      <p className="text-[12.5px] text-muted-foreground">
        {tr(
          "Say what you want done. It's planned into tasks, handed to the best-suited agents in your pool, checked by an independent verifier, and code changes wait for your OK before they're merged.",
        )}
      </p>
      <div className="flex flex-wrap justify-center gap-1.5 text-[11px]">
        {probing && (
          <span className="flex items-center gap-1 text-muted-foreground">
            <Loader2 className="size-3 animate-spin" /> {tr("Looking for agents…")}
          </span>
        )}
        {ok.map((p) => (
          <span key={p.runtime} className="rounded-full bg-success/12 px-2 py-0.5 text-success">
            {p.runtime}
          </span>
        ))}
      </div>
      {!probing && !peers.length && (
        <Button size="sm" variant="secondary" onClick={() => openAgentsSettings()}>
          <Settings2 className="size-3.5" /> {tr("Set up the agent pool")}
        </Button>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ composer

function Composer({
  visible,
  focused,
  replyTo,
  setReplyTo,
}: {
  visible: boolean;
  focused: boolean;
  replyTo: string | null;
  setReplyTo: (g: string | null) => void;
}) {
  const [text, setText] = useState("");
  const recent = useForge((s) => s.config.workspaces);
  const [workspace, setWorkspace] = useState<string>(() => recent[0] ?? "");
  const input = useRef<HTMLTextAreaElement>(null);
  const thinking = useForge((s) => s.thinking);

  useEffect(() => {
    if (focused && visible) requestAnimationFrame(() => input.current?.focus());
  }, [focused, visible]);
  useEffect(() => {
    if (replyTo) input.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(220, el.scrollHeight)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    setText("");
    setReplyTo(null);
    void send(t, { workspace: workspace || undefined, goal: replyTo ?? undefined });
  };

  const browse = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const dir = await open({ directory: true, defaultPath: workspace || undefined, title: tr("Choose the project folder") });
    if (typeof dir === "string") setWorkspace(dir);
  };

  return (
    <div className="shrink-0 px-4 pb-3">
      <div className="mx-auto max-w-[800px] rounded-xl border border-ov/10 bg-inset transition-colors focus-within:border-primary/50">
        <AnimatePresence>
          {replyTo && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
              <div className="flex items-center gap-1.5 px-3 pt-2 text-[11.5px] text-primary">
                <MessageSquareReply className="size-3.5" />
                {tr("Replying to “{0}”", { 0: goalTitle(replyTo) })}
                <button type="button" className="press ml-1 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={() => setReplyTo(null)}>
                  <X className="size-3" />
                </button>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
        <textarea
          ref={input}
          rows={1}
          value={text}
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape" && replyTo) setReplyTo(null);
          }}
          placeholder={replyTo ? tr("Answer or add details…") : tr("What should the agents do? (Shift+Enter for a new line)")}
          className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-[13px] leading-snug outline-none placeholder:text-muted-foreground/60"
        />
        <div className="flex items-center gap-1 px-2 pb-2">
          <WorkspacePicker value={workspace} recent={recent} onChange={setWorkspace} onBrowse={() => void browse()} />
          <div className="flex-1" />
          <Tooltip content={tr("Send (Enter)")} side="top">
            <button
              type="button"
              disabled={!text.trim()}
              onClick={submit}
              className="press flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:bg-ov/[0.08] disabled:text-muted-foreground [&_svg]:size-4"
            >
              {thinking ? <Loader2 className="animate-spin" /> : <ArrowUp />}
            </button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function WorkspacePicker({
  value,
  recent,
  onChange,
  onBrowse,
}: {
  value: string;
  recent: string[];
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  const name = value ? value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : "";
  const options = [
    { value: "", label: tr("No project folder"), hint: tr("research, machines") },
    ...recent.map((r) => ({ value: r, label: r.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? r, hint: r })),
    { value: "\u0000browse", label: tr("Choose a folder…") },
  ];
  return (
    <Select<string>
      size="sm"
      className="h-7 max-w-64 min-w-0 gap-1.5 border-transparent bg-transparent px-2 text-[11.5px] text-muted-foreground hover:bg-ov/[0.06]"
      value={value}
      options={options.map((o) => ({
        ...o,
        label: (
          <span className="flex items-center gap-1.5">
            {o.value === "\u0000browse" ? <FolderOpen className="size-3.5" /> : <Folder className="size-3.5" />}
            {o.label}
          </span>
        ),
      }))}
      onChange={(v) => (v === "\u0000browse" ? onBrowse() : onChange(v))}
      placeholder={name}
    />
  );
}

// ------------------------------------------------------------------ goals

function GoalCard({ goal, onReply }: { goal: Goal; onReply: (id: string) => void }) {
  const storiesAll = useForge((s) => s.stories);
  const features = useForge((s) => s.features);
  const approvals = useForge((s) => s.approvals);
  const runs = useForge((s) => s.runs);
  const stories = useMemo(
    () => Object.values(storiesAll).filter((s) => s.goal === goal.id).sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3))),
    [storiesAll, goal.id],
  );
  const feats = Object.values(features).filter((f) => f.goal === goal.id);
  const counted = stories.filter((s) => s.status !== "cancelled");
  const done = counted.filter((s) => s.status === "done").length;
  const aps = Object.values(approvals).filter((a) => a.subject === goal.id || stories.some((s) => s.id === a.subject));
  const planRun = Object.values(runs)
    .filter((r) => r.subject === goal.id && r.purpose === "plan")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const finished = ["done", "cancelled", "failed"].includes(goal.status);
  const [open, setOpen] = useState(!finished);
  useEffect(() => {
    if (!finished) setOpen(true);
  }, [finished]);

  return (
    <motion.div layout="position" className={cn("overflow-hidden rounded-xl border bg-ov/[0.025]", goal.status === "needs_human" ? "border-warning/35" : "border-ov/[0.08]")}>
      <div className="flex items-start gap-2 px-3 pt-2.5 pb-2">
        <button type="button" onClick={() => setOpen(!open)} className="press mt-0.5 text-muted-foreground hover:text-foreground">
          <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className={cn("text-[11px] font-medium", tone(goal.status))}>{tr(GOAL_LABEL[goal.status])}</span>
            {goal.workspace && (
              <Tooltip content={goal.workspace}>
                <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground">
                  <Folder className="size-3" />
                  {goal.workspace.split(/[\\/]/).pop()}
                </span>
              </Tooltip>
            )}
            {counted.length > 0 && <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">{done}/{counted.length}</span>}
          </div>
          <div className={cn("mt-0.5 text-[12.5px] break-words text-foreground/90", !open && "truncate")}>{goal.text.split("\n")[0]}</div>
          {counted.length > 0 && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ov/[0.08]">
              <motion.div
                className={cn("h-full rounded-full", goal.status === "done" ? "bg-success" : "bg-primary")}
                initial={false}
                animate={{ width: `${(done / counted.length) * 100}%` }}
                transition={{ type: "spring", stiffness: 160, damping: 26 }}
              />
            </div>
          )}
        </div>
        <GoalActions goal={goal} onReply={onReply} />
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }}>
            <div className="flex flex-col gap-1.5 px-3 pb-3">
              {goal.status === "planning" && (
                <div className="ml-5.5 flex flex-col gap-1">
                  <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin text-primary" />
                    <span className="shimmer">{planRun?.status === "running" || planRun?.status === "starting" ? tr("{0} is planning…", { 0: planRun.peer }) : tr("Waiting for a planner…")}</span>
                  </div>
                  {planRun && <RunLine run={planRun} />}
                </div>
              )}
              {goal.note && (
                <div className={cn("ml-5.5 rounded-md px-2.5 py-1.5 text-[11.5px] whitespace-pre-wrap", goal.status === "needs_human" ? "bg-warning/[0.08] text-foreground/90" : "bg-ov/[0.04] text-muted-foreground")}>
                  {goal.note}
                </div>
              )}
              {feats.map((f) => (
                <div key={f.id} className="ml-5.5 flex flex-col gap-0.5">
                  {feats.length > 1 && (
                    <div className="pt-1 text-[11px] font-medium text-muted-foreground">
                      {f.title}
                    </div>
                  )}
                  {stories
                    .filter((s) => s.feature === f.id)
                    .map((s) => (
                      <StoryRow key={s.id} story={s} />
                    ))}
                </div>
              ))}
              {aps.map((a) => (
                <div key={a.id} className="ml-5.5">
                  <ApprovalCard ap={a} />
                </div>
              ))}
              {goal.status === "done" && !goal.report && <GoalResult goal={goal} stories={stories} />}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function GoalActions({ goal, onReply }: { goal: Goal; onReply: (id: string) => void }) {
  const running = !["done", "cancelled", "failed"].includes(goal.status);
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      {goal.status !== "done" && (
        <IconButton tip={tr("Reply / add details")} className="size-6" onClick={() => onReply(goal.id)}>
          <MessageSquareReply />
        </IconButton>
      )}
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
            }).then((ok) => ok && forge.deleteGoal(goal.id))
          }
        >
          <Trash2 />
        </IconButton>
      )}
    </div>
  );
}

export function GoalResult({ goal, stories, className }: { goal: Goal; stories: Story[]; className?: string }) {
  const parts = stories.filter((s) => s.status === "done" && s.handoff);
  if (!parts.length && !goal.report) return null;
  const text = goal.report ?? parts
    .map((s) => {
      const h = s.handoff!;
      const findings = h.findings?.length ? `\n${h.findings.map((f) => `- ${f.claim}${f.source ? ` (\`${f.source}\`)` : ""}`).join("\n")}` : "";
      const issues = h.openIssues.length ? `\n${h.openIssues.map((x) => `- ⚠ ${x}`).join("\n")}` : "";
      return `**${s.title}** — ${h.summary}${findings}${issues}`;
    })
    .join("\n\n");
  return (
    <div className={cn("rounded-lg border border-success/20 bg-success/[0.05] px-3 py-2 text-[12.5px]", className ?? "ml-5.5")}>
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium text-success">
        <Check className="size-3.5" /> {tr("Result")}
      </div>
      <Markdown text={text} />
      {goal.note && !goal.report && <div className="mt-1 text-[11px] text-muted-foreground">{goal.note}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ stories

function StoryRow({ story: s }: { story: Story }) {
  const runs = useForge((st) => st.runs);
  const active = useForge((st) => st.activeRuns);
  const storyRuns = Object.values(runs)
    .filter((r) => r.subject === s.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const live = storyRuns.filter((r) => active.includes(r.id));
  const last = live.at(-1) ?? storyRuns.at(-1);
  const [open, setOpen] = useState(false);
  const stuck = ["needs_human", "needs_split", "failed", "cancelled"].includes(s.status);
  const escalated = s.attempts.length > 0 && s.attempts.at(-1)!.tier !== s.minTier;
  return (
    <div className={cn("rounded-md", open && "bg-ov/[0.03]")}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpen(!open)}
        onKeyDown={(e) => e.key === "Enter" && setOpen(!open)}
        className="group flex min-w-0 cursor-default items-center gap-2 rounded-md px-1.5 py-1 hover:bg-ov/[0.04]"
      >
        <StatusIcon s={s.status} />
        <span className="min-w-0 flex-1 truncate text-[12px]">{s.title}</span>
        <RoleChip role={s.role} tier={escalated ? s.attempts.at(-1)!.tier : s.minTier} up={escalated} />
        {s.risk === "destructive" && <TriangleAlert className="size-3.5 shrink-0 text-warning" />}
        {last && (live.length > 0 || s.status === "running" || s.status === "verifying") && (
          <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
            {last.purpose === "verify" && <ShieldCheck className="size-3" />}
            {last.peer} · <Elapsed from={last.startedAt} to={last.endedAt} />
          </span>
        )}
        {!live.length && s.status !== "running" && (
          <span className={cn("shrink-0 text-[11px]", tone(s.status))}>{tr(STATUS_LABEL[s.status])}</span>
        )}
        {s.attempts.length > 1 && <span className="shrink-0 text-[10.5px] text-muted-foreground">×{s.attempts.length}</span>}
        {stuck && (
          <IconButton
            tip={tr("Try again")}
            className="size-5 opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              forge.retryStory(s.id);
            }}
          >
            <RotateCcw />
          </IconButton>
        )}
      </div>
      {!open && live.length > 0 && last?.activity && (
        <div className="truncate pb-1 pl-7 font-mono text-[10.5px] text-muted-foreground/80">{last.activity}</div>
      )}
      {!open && s.blockedReason && !live.length && (
        <div className={cn("line-clamp-2 pb-1 pl-7 text-[11px]", stuck ? "text-warning" : "text-muted-foreground")}>{s.blockedReason}</div>
      )}
      <AnimatePresence initial={false}>
        {open && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.16 }} className="overflow-hidden">
            <StoryDetail story={s} runs={storyRuns} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

export function StoryDetail({ story: s, runs }: { story: Story; runs: AgentRun[] }) {
  const live = runs.find((r) => ["starting", "running", "waiting_permission"].includes(r.status));
  const [tab, setTab] = useState<string>(() => live?.id ?? "info");
  useEffect(() => {
    if (tab !== "info" && !runs.some((r) => r.id === tab)) setTab(runs.at(-1)?.id ?? "info");
  }, [runs, tab]);
  const h = s.handoff;
  const lastVerify = [...s.attempts].reverse().find((a) => a.verify)?.verify;
  return (
    <div className="flex flex-col gap-2 px-2 pt-0.5 pb-2 pl-7">
      <div className="flex flex-wrap items-center gap-1">
        <TabBtn on={tab === "info"} onClick={() => setTab("info")}>
          {tr("Overview")}
        </TabBtn>
        {runs.map((r) => (
          <TabBtn key={r.id} on={tab === r.id} onClick={() => setTab(r.id)}>
            {r.purpose === "verify" ? <ShieldCheck className="size-3" /> : <Bot className="size-3" />}
            {r.purpose === "verify" ? tr("Check · {0}", { 0: r.peer }) : tr("Work · {0}", { 0: r.peer })}
            <span
              className={cn(
                "size-1.5 rounded-full",
                r.status === "done" ? "bg-success" : r.status === "failed" ? "bg-destructive" : r.status === "cancelled" ? "bg-ov/30" : "animate-pulse bg-primary",
              )}
            />
          </TabBtn>
        ))}
      </div>
      {tab === "info" ? (
        <div className="flex flex-col gap-2.5 text-[12px]">
          {h && (
            <div className="rounded-lg border border-ov/[0.07] bg-ov/[0.03] px-3 py-2">
              <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{tr("Outcome")}</div>
              <Markdown text={h.summary} />
              {(h.findings?.length ?? 0) > 0 && (
                <ul className="mt-1 list-disc space-y-0.5 pl-4.5">
                  {h.findings!.map((f, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static
                    <li key={i}>
                      {f.claim}
                      {f.source && <span className="ml-1 font-mono text-[10.5px] text-muted-foreground">{f.source}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {h.changes.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] text-muted-foreground">
                  {h.changes.map((c, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static
                    <div key={i}>
                      <code className="font-mono text-foreground/85">{c.resource}</code> {c.what}
                    </div>
                  ))}
                </div>
              )}
              {h.openIssues.length > 0 && (
                <div className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] text-warning">
                  {h.openIssues.map((x, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: static
                    <div key={i}>⚠ {x}</div>
                  ))}
                </div>
              )}
            </div>
          )}
          {lastVerify && (
            <div className={cn("flex gap-1.5 text-[11.5px]", lastVerify.pass ? "text-success" : "text-destructive")}>
              {lastVerify.pass ? <ShieldCheck className="mt-0.5 size-3.5 shrink-0" /> : <X className="mt-0.5 size-3.5 shrink-0" />}
              <span className="text-foreground/85">{lastVerify.reason}</span>
            </div>
          )}
          <div>
            <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{tr("Task")}</div>
            <div className="whitespace-pre-wrap text-foreground/85">{s.instructions}</div>
          </div>
          {s.acceptance.length > 0 && (
            <div>
              <div className="mb-0.5 text-[11px] font-medium text-muted-foreground">{tr("Acceptance")}</div>
              {s.acceptance.map((a, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: static
                <div key={i} className="flex gap-1.5">
                  <span className="shrink-0 text-muted-foreground">{a.kind === "command" ? "$" : a.kind === "file_exists" ? "▢" : "◇"}</span>
                  <span className={cn("break-all", a.kind !== "llm_judge" && "font-mono text-[11px]")}>{a.spec}</span>
                </div>
              ))}
            </div>
          )}
          {s.attempts.length > 1 && (
            <div className="flex flex-col gap-0.5 text-[11px] text-muted-foreground">
              {s.attempts.map((a, i) =>
                a.verify || a.error ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: attempts
                  <div key={i}>
                    {tr("Attempt {0}", { 0: i + 1 })} · {a.peer} · {tierLabel(a.tier)} ·{" "}
                    <span className={a.verify?.pass ? "text-success" : "text-destructive"}>
                      {a.verify ? (a.verify.pass ? tr("accepted") : tr("rejected")) : tr("error")}
                    </span>{" "}
                    — {(a.verify?.reason ?? a.error ?? "").slice(0, 240)}
                  </div>
                ) : null,
              )}
            </div>
          )}
        </div>
      ) : (
        <RunLog runId={tab} />
      )}
    </div>
  );
}

function TabBtn({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
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

function RunLine({ run }: { run: AgentRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {run.activity ? <span className="max-w-[60ch] truncate font-mono">{run.activity}</span> : tr("Show output")}
      </button>
      {open && (
        <div className="mt-1">
          <RunLog runId={run.id} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ run output

/** Drop the machine-readable parts of a reply (JSON handoffs, plans, verdicts). */
export function proseOnly(text: string) {
  let t = text.replace(/```[a-zA-Z]*[ \t]*\n([\s\S]*?)(?:```|$)/g, (m, body: string) => (/^\s*[[{]/.test(body) ? "" : m));
  // a bare JSON object at the end
  const i = t.search(/\n\s*\{[\s\S]*\}\s*$/);
  if (i >= 0) {
    try {
      JSON.parse(t.slice(i));
      t = t.slice(0, i);
    } catch {}
  }
  return t.replace(/\n{3,}/g, "\n\n").trim();
}

type Piece =
  | { k: "text"; text: string }
  | { k: "tools"; items: Extract<AgentEvent, { t: "tool" }>[] }
  | { k: "note"; text: string; tone: "warn" | "error" }
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
                <Markdown key={i} text={p.text} />
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
            <span className="w-16 shrink-0 text-[11.5px] text-muted-foreground">{tr("At once")}</span>
            <NumberInput value={config.limits.maxConcurrentRuns} min={1} max={16} className="h-7 w-16" onChange={(v) => set((c) => (c.limits.maxConcurrentRuns = v))} />
            <Slots />
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
            {load > 0 && <span className="text-[10.5px] text-primary tabular-nums">{load}/{p.maxConcurrent}</span>}
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
