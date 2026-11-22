// Scrum view of the agents board: one column per stage, cards move between them as the
// engine works, and dependencies between tasks are drawn as curves on an SVG layer over
// the cards. Click a card for its details and live output.
import { CircleStop, Hand, Loader2, MessageSquareReply, RotateCcw, ShieldAlert, TriangleAlert, X } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/panel";
import { forge } from "@/lib/forge/engine";
import { useForge } from "@/lib/forge/store";
import type { Goal, Status, Story } from "@/lib/forge/types";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Markdown } from "./AgentPanel";
import {
  ApprovalCard,
  Elapsed,
  GOAL_LABEL,
  GoalActions,
  GoalResult,
  goalTitle,
  RoleChip,
  RunLog,
  STATUS_LABEL,
  StatusIcon,
  StoryDetail,
  tone,
  Welcome,
} from "./AgentsView";

type ColId = "plan" | "todo" | "doing" | "verify" | "human" | "done";

const COLUMNS: { id: ColId; label: string; accent: string }[] = [
  { id: "plan", label: "Planning", accent: "#a78bfa" },
  { id: "todo", label: "To do", accent: "#94a3b8" },
  { id: "doing", label: "In progress", accent: "var(--primary)" },
  { id: "verify", label: "Verifying", accent: "#c084fc" },
  { id: "human", label: "Needs you", accent: "var(--warning)" },
  { id: "done", label: "Done", accent: "var(--success)" },
];

const COLUMN_OF: Record<Status, ColId | null> = {
  draft: "todo",
  ready: "todo",
  blocked: "todo",
  claimed: "doing",
  running: "doing",
  verifying: "verify",
  needs_human: "human",
  needs_split: "human",
  failed: "human",
  done: "done",
  cancelled: null,
};

/** A stable color per goal so its cards are recognisable across columns. */
const GOAL_COLORS = ["#60a5fa", "#f472b6", "#34d399", "#fbbf24", "#a78bfa", "#fb7185", "#2dd4bf", "#f97316"];
const goalColor = (id: string) => GOAL_COLORS[(Number(id.replace(/\D/g, "")) || 0) % GOAL_COLORS.length];

const storyNum = (s: Story) => Number(s.id.replace(/\D/g, "")) || 0;

type Selected = { kind: "story" | "goal"; id: string } | null;

export function Kanban({ onReply }: { onReply: (goal: string) => void }) {
  const goals = useForge((s) => s.goals);
  const storiesAll = useForge((s) => s.stories);
  const approvals = useForge((s) => s.approvals);
  const [filter, setFilter] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selected>(null);
  const [hover, setHover] = useState<string | null>(null);

  const goalList = useMemo(() => Object.values(goals).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [goals]);
  // finished goals stay listed but only active ones fill the board unless picked
  const shownGoals = useMemo(() => {
    if (filter) return goalList.filter((g) => g.id === filter);
    return goalList.filter((g) => !["done", "cancelled", "failed"].includes(g.status) || Date.now() - Date.parse(g.updatedAt) < 12 * 3600_000);
  }, [goalList, filter]);
  const shownIds = new Set(shownGoals.map((g) => g.id));

  const cols = useMemo(() => {
    const out: Record<ColId, Story[]> = { plan: [], todo: [], doing: [], verify: [], human: [], done: [] };
    for (const s of Object.values(storiesAll)) {
      if (!shownIds.has(s.goal)) continue;
      const c = COLUMN_OF[s.status];
      if (c) out[c].push(s);
    }
    for (const c of Object.keys(out) as ColId[]) out[c].sort((a, b) => storyNum(a) - storyNum(b));
    out.done.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    out.done = out.done.slice(0, filter ? 200 : 30);
    return out;
    // biome-ignore lint/correctness/useExhaustiveDependencies: shownIds derives from shownGoals
  }, [storiesAll, shownGoals, filter]);

  const planning = shownGoals.filter((g) => g.status === "planning");
  const doneGoals = shownGoals.filter((g) => g.status === "done");
  const stuckGoals = shownGoals.filter((g) => g.status === "needs_human" && !Object.values(storiesAll).some((s) => s.goal === g.id && COLUMN_OF[s.status] === "human"));
  const goalApprovals = Object.values(approvals).filter((a) => (a.kind === "merge" || a.kind === "plan") && shownIds.has(a.subject));
  const pendingFor = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of Object.values(approvals)) m.set(a.subject, (m.get(a.subject) ?? 0) + 1);
    return m;
  }, [approvals]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && setSelected(null);
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);

  // ---- dependency lines
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<string, HTMLElement>());
  const [edges, setEdges] = useState<{ from: string; to: string; d: string; done: boolean; live: boolean }[]>([]);
  const visibleStories = useMemo(() => Object.values(cols).flat(), [cols]);

  const measure = useCallback(() => {
    const root = content.current;
    if (!root) return;
    const base = root.getBoundingClientRect();
    const rect = (id: string) => {
      const el = cards.current.get(id);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: r.left - base.left, r: r.right - base.left, t: r.top - base.top, b: r.bottom - base.top };
    };
    const next: typeof edges = [];
    const byId = new Map(visibleStories.map((s) => [s.id, s]));
    for (const s of visibleStories) {
      const b = rect(s.id);
      if (!b) continue;
      for (const dep of s.dependsOn) {
        const a = rect(dep);
        if (!a) continue;
        const ay = (a.t + a.b) / 2;
        const by = (b.t + b.b) / 2;
        let d: string;
        if (Math.abs(a.l - b.l) < 20) {
          // same column: loop out on the right side
          const x = Math.max(a.r, b.r);
          d = `M ${a.r} ${ay} C ${x + 28} ${ay}, ${x + 28} ${by}, ${b.r} ${by}`;
        } else if (a.r <= b.l) {
          const dx = Math.max(30, (b.l - a.r) / 2);
          d = `M ${a.r} ${ay} C ${a.r + dx} ${ay}, ${b.l - dx} ${by}, ${b.l} ${by}`;
        } else {
          const dx = Math.max(30, (a.l - b.r) / 2);
          d = `M ${a.l} ${ay} C ${a.l - dx} ${ay}, ${b.r + dx} ${by}, ${b.r} ${by}`;
        }
        const depStory = byId.get(dep);
        next.push({ from: dep, to: s.id, d, done: depStory?.status === "done", live: s.status === "blocked" || s.status === "running" });
      }
    }
    setEdges(next);
  }, [visibleStories]);

  // re-measure while cards animate into place after a change, and on resize
  useLayoutEffect(() => {
    let raf = 0;
    const end = performance.now() + 700;
    const loop = () => {
      measure();
      if (performance.now() < end) raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [measure]);
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure]);

  const register = (id: string) => (el: HTMLElement | null) => {
    if (el) cards.current.set(id, el);
    else cards.current.delete(id);
  };

  const related = useMemo(() => {
    if (!hover) return null;
    const set = new Set([hover]);
    for (const e of edges) if (e.from === hover || e.to === hover) set.add(e.from === hover ? e.to : e.from);
    return set;
  }, [hover, edges]);

  if (!goalList.length)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Welcome />
      </div>
    );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <GoalStrip goals={goalList} filter={filter} setFilter={setFilter} onOpen={(id) => setSelected({ kind: "goal", id })} />
      <div ref={scroller} className="kb-scroll min-h-0 flex-1 overflow-x-auto overflow-y-auto">
        <div ref={content} className="relative flex min-h-full gap-6 px-4 pt-1 pb-3">
          <svg className="pointer-events-none absolute inset-0 z-[1] h-full w-full overflow-visible" aria-hidden>
            <defs>
              <marker id="kb-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
              </marker>
            </defs>
            {edges.map((e) => {
              const hot = related && related.has(e.from) && related.has(e.to) && (e.from === hover || e.to === hover);
              const dim = related && !hot;
              return (
                <path
                  key={`${e.from}>${e.to}`}
                  d={e.d}
                  fill="none"
                  markerEnd="url(#kb-arrow)"
                  className={cn("transition-opacity duration-150", e.live && !e.done && "kb-flow")}
                  stroke={hot ? "var(--primary)" : e.done ? "var(--success)" : "var(--muted-foreground)"}
                  strokeOpacity={dim ? 0.12 : hot ? 0.95 : e.done ? 0.45 : 0.5}
                  strokeWidth={hot ? 2 : 1.5}
                  strokeDasharray={e.done ? undefined : "5 4"}
                />
              );
            })}
          </svg>
          <LayoutGroup>
            {COLUMNS.map((c) => {
              const items = cols[c.id];
              const extra =
                c.id === "plan" ? planning.length : c.id === "human" ? stuckGoals.length + goalApprovals.length : c.id === "done" ? doneGoals.length : 0;
              return (
                <section key={c.id} className="flex min-w-[176px] max-w-[320px] flex-1 basis-0 flex-col">
                  <header className="sticky top-0 z-[2] flex h-9 items-center gap-2 bg-surface/80 px-1 backdrop-blur-sm">
                    <span className="h-3 w-[3px] rounded-full" style={{ background: c.accent }} />
                    <span className="text-[11.5px] font-semibold tracking-wide text-muted-foreground uppercase">{tr(c.label)}</span>
                    <span className="rounded-full bg-ov/[0.08] px-1.5 text-[10.5px] text-muted-foreground tabular-nums">{items.length + extra}</span>
                  </header>
                  <div className="flex min-h-24 flex-1 flex-col gap-2 rounded-xl bg-ov/[0.018] p-1.5">
                    {c.id === "plan" &&
                      planning.map((g) => <PlanningCard key={g.id} goal={g} onOpen={() => setSelected({ kind: "goal", id: g.id })} />)}
                    {c.id === "human" &&
                      goalApprovals.map((a) => (
                        <motion.div layout key={a.id}>
                          <ApprovalCard ap={a} compact />
                        </motion.div>
                      ))}
                    {c.id === "human" &&
                      stuckGoals.map((g) => <StuckGoalCard key={g.id} goal={g} onOpen={() => setSelected({ kind: "goal", id: g.id })} />)}
                    {c.id === "done" &&
                      doneGoals.map((g) => <ReportCard key={g.id} goal={g} onOpen={() => setSelected({ kind: "goal", id: g.id })} />)}
                    {items.map((s) => (
                      <StoryCard
                        key={s.id}
                        story={s}
                        refCb={register(s.id)}
                        selected={selected?.kind === "story" && selected.id === s.id}
                        dim={!!related && !related.has(s.id)}
                        pending={pendingFor.get(s.id) ?? 0}
                        onHover={setHover}
                        onOpen={() => setSelected({ kind: "story", id: s.id })}
                      />
                    ))}
                    {!items.length && !extra && <div className="flex flex-1 items-center justify-center text-[11px] text-muted-foreground/50">—</div>}
                  </div>
                </section>
              );
            })}
          </LayoutGroup>
        </div>
      </div>

      <AnimatePresence>
        {selected && (
          <Drawer key={`${selected.kind}:${selected.id}`} selected={selected} onClose={() => setSelected(null)} onReply={onReply} onOpen={setSelected} />
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ goal strip

function GoalStrip({
  goals,
  filter,
  setFilter,
  onOpen,
}: {
  goals: Goal[];
  filter: string | null;
  setFilter: (g: string | null) => void;
  onOpen: (id: string) => void;
}) {
  const stories = useForge((s) => s.stories);
  return (
    <div className="flex shrink-0 items-center gap-1.5 overflow-x-auto px-4 py-2">
      <Chip on={!filter} onClick={() => setFilter(null)}>
        {tr("All goals")}
      </Chip>
      {goals.slice(0, 30).map((g) => {
        const ss = Object.values(stories).filter((s) => s.goal === g.id && s.status !== "cancelled");
        const done = ss.filter((s) => s.status === "done").length;
        return (
          <Chip key={g.id} on={filter === g.id} onClick={() => setFilter(filter === g.id ? null : g.id)} onDoubleClick={() => onOpen(g.id)}>
            <span className="size-2 shrink-0 rounded-full" style={{ background: goalColor(g.id) }} />
            <span className="max-w-40 truncate">{g.text.split("\n")[0]}</span>
            {ss.length > 0 && <span className={cn("text-[10.5px] tabular-nums", tone(g.status))}>{done}/{ss.length}</span>}
            {g.status === "planning" && <Loader2 className="size-3 animate-spin text-primary" />}
            {g.status === "needs_human" && <Hand className="size-3 text-warning" />}
          </Chip>
        );
      })}
    </div>
  );
}

function Chip({ on, onClick, onDoubleClick, children }: { on: boolean; onClick: () => void; onDoubleClick?: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      className={cn(
        "press flex h-7 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] transition-colors",
        on ? "border-primary/40 bg-primary/12 text-foreground" : "border-ov/[0.08] text-muted-foreground hover:bg-ov/[0.05] hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

// ------------------------------------------------------------------ cards

function StoryCard({
  story: s,
  refCb,
  selected,
  dim,
  pending,
  onHover,
  onOpen,
}: {
  story: Story;
  refCb: (el: HTMLElement | null) => void;
  selected: boolean;
  dim: boolean;
  pending: number;
  onHover: (id: string | null) => void;
  onOpen: () => void;
}) {
  const runs = useForge((st) => st.runs);
  const active = useForge((st) => st.activeRuns);
  const live = Object.values(runs)
    .filter((r) => r.subject === s.id && active.includes(r.id))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const escalated = s.attempts.length > 0 && s.attempts.at(-1)!.tier !== s.minTier;
  const stuck = s.status === "needs_human" || s.status === "needs_split" || s.status === "failed";
  return (
    <motion.div
      layout
      layoutId={s.id}
      ref={refCb}
      transition={{ type: "spring", stiffness: 420, damping: 34 }}
      onMouseEnter={() => onHover(s.id)}
      onMouseLeave={() => onHover(null)}
      onClick={onOpen}
      className={cn(
        "relative z-[2] cursor-default overflow-hidden rounded-lg border bg-popover/90 px-2.5 py-2 shadow-sm shadow-shadow/20 transition-[opacity,border-color,box-shadow]",
        selected ? "border-primary/60 ring-2 ring-primary/25" : stuck ? "border-warning/35" : "border-ov/[0.08] hover:border-ov/20",
        dim && "opacity-40",
      )}
    >
      {/* goal color + running shimmer */}
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: goalColor(s.goal) }} />
      {live && <span className="kb-run absolute inset-x-0 top-0 h-px" />}
      <div className="flex items-center gap-1.5">
        <StatusIcon s={s.status} />
        <span className="min-w-0 truncate text-[10.5px] text-muted-foreground">{goalTitle(s.goal)}</span>
        <div className="flex-1" />
        {s.risk === "destructive" && <TriangleAlert className="size-3.5 text-warning" />}
        {pending > 0 && <ShieldAlert className="size-3.5 animate-pulse text-warning" />}
        <RoleChip role={s.role} tier={escalated ? s.attempts.at(-1)!.tier : s.minTier} up={escalated} />
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug">{s.title}</div>
      {live ? (
        <div className="mt-1.5 flex flex-col gap-0.5 text-[10.5px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className={cn("size-1.5 rounded-full", live.status === "waiting_permission" ? "bg-warning" : "animate-pulse bg-primary")} />
            {live.peer}
            {live.purpose === "verify" && ` · ${tr("verifying")}`} · <Elapsed from={live.startedAt} />
          </span>
          {live.activity && <span className="truncate font-mono">{live.activity}</span>}
        </div>
      ) : s.blockedReason ? (
        <div className={cn("mt-1 line-clamp-2 text-[10.5px]", stuck ? "text-warning" : "text-muted-foreground")}>{s.blockedReason}</div>
      ) : s.status === "done" && s.handoff?.summary ? (
        <div className="mt-1 line-clamp-2 text-[10.5px] text-muted-foreground">{s.handoff.summary}</div>
      ) : null}
      {s.attempts.length > 1 && <div className="mt-1 text-[10px] text-muted-foreground">{tr("Attempt {0}", { 0: s.attempts.length })}</div>}
    </motion.div>
  );
}

function PlanningCard({ goal: g, onOpen }: { goal: Goal; onOpen: () => void }) {
  const run = useForge((s) =>
    Object.values(s.runs)
      .filter((r) => r.subject === g.id && r.purpose === "plan")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
  );
  const running = run && (run.status === "running" || run.status === "starting");
  return (
    <motion.div
      layout
      layoutId={g.id}
      onClick={onOpen}
      className="relative z-[2] cursor-default overflow-hidden rounded-lg border border-[#a78bfa]/30 bg-popover/90 px-2.5 py-2"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: goalColor(g.id) }} />
      {running && <span className="kb-run absolute inset-x-0 top-0 h-px" />}
      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin text-[#a78bfa]" />
        <span>{tr("Planning")}</span>
        <span className="ml-auto">{running ? run.peer : tr("Waiting for a planner…")}</span>
      </div>
      <div className="mt-1 line-clamp-3 text-[12.5px] leading-snug">{g.text.split("\n")[0]}</div>
      {running && run.activity && <div className="mt-1 truncate font-mono text-[10.5px] text-muted-foreground">{run.activity}</div>}
    </motion.div>
  );
}

function ReportCard({ goal: g, onOpen }: { goal: Goal; onOpen: () => void }) {
  return (
    <motion.div
      layout
      layoutId={g.id}
      onClick={onOpen}
      className="relative z-[2] cursor-default overflow-hidden rounded-lg border border-success/30 bg-popover/90 px-2.5 py-2"
    >
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: goalColor(g.id) }} />
      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <span className="text-success">✓</span>
        <span className="min-w-0 truncate">{g.text.split("\n")[0]}</span>
      </div>
      {g.report ? (
        <div className="mt-1 line-clamp-6 text-[12px] leading-snug">
          <Markdown text={g.report} />
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> {tr("Writing the report…")}
        </div>
      )}
    </motion.div>
  );
}

function StuckGoalCard({ goal: g, onOpen }: { goal: Goal; onOpen: () => void }) {
  return (
    <motion.div layout layoutId={g.id} onClick={onOpen} className="relative z-[2] cursor-default overflow-hidden rounded-lg border border-warning/35 bg-popover/90 px-2.5 py-2">
      <span className="absolute inset-y-0 left-0 w-[3px]" style={{ background: goalColor(g.id) }} />
      <div className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
        <Hand className="size-3.5 text-warning" />
        <span>{tr("Needs you")}</span>
      </div>
      <div className="mt-1 line-clamp-2 text-[12.5px] leading-snug">{g.text.split("\n")[0]}</div>
      {g.note && <div className="mt-1 line-clamp-3 text-[10.5px] text-warning">{g.note}</div>}
    </motion.div>
  );
}

// ------------------------------------------------------------------ detail drawer

function Drawer({
  selected,
  onClose,
  onReply,
  onOpen,
}: {
  selected: NonNullable<Selected>;
  onClose: () => void;
  onReply: (goal: string) => void;
  onOpen: (s: Selected) => void;
}) {
  return (
    <>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 z-10 bg-black/15"
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: 40, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: 40, opacity: 0 }}
        transition={{ type: "spring", stiffness: 420, damping: 38 }}
        className="absolute top-2 right-2 bottom-2 z-20 flex w-[min(460px,calc(100%-1rem))] flex-col overflow-hidden rounded-xl border border-ov/10 bg-popover shadow-2xl shadow-shadow"
      >
        {selected.kind === "story" ? (
          <StoryPanel id={selected.id} onClose={onClose} onReply={onReply} onOpen={onOpen} />
        ) : (
          <GoalPanel id={selected.id} onClose={onClose} onReply={onReply} onOpen={onOpen} />
        )}
      </motion.aside>
    </>
  );
}

function PanelTop({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-start gap-2 border-b border-ov/[0.07] px-4 py-3">
      <div className="min-w-0 flex-1">{children}</div>
      <IconButton tip={tr("Close (Esc)")} className="size-6" onClick={onClose}>
        <X />
      </IconButton>
    </div>
  );
}

function StoryPanel({ id, onClose, onReply, onOpen }: { id: string; onClose: () => void; onReply: (g: string) => void; onOpen: (s: Selected) => void }) {
  const s = useForge((st) => st.stories[id]);
  const runsAll = useForge((st) => st.runs);
  const approvals = useForge((st) => st.approvals);
  const storiesAll = useForge((st) => st.stories);
  if (!s) return <PanelTop onClose={onClose}>{tr("This task is gone.")}</PanelTop>;
  const runs = Object.values(runsAll)
    .filter((r) => r.subject === s.id)
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const aps = Object.values(approvals).filter((a) => a.subject === s.id);
  const stuck = ["needs_human", "needs_split", "failed", "cancelled"].includes(s.status);
  const activeNow = ["claimed", "running", "verifying"].includes(s.status);
  const deps = s.dependsOn.map((d) => storiesAll[d]).filter(Boolean);
  const dependents = Object.values(storiesAll).filter((x) => x.dependsOn.includes(s.id));
  return (
    <>
      <PanelTop onClose={onClose}>
        <div className="flex items-center gap-1.5 text-[11px]">
          <StatusIcon s={s.status} />
          <span className={tone(s.status)}>{tr(STATUS_LABEL[s.status])}</span>
          <button type="button" className="min-w-0 truncate text-muted-foreground hover:text-foreground" onClick={() => onOpen({ kind: "goal", id: s.goal })}>
            · {goalTitle(s.goal)}
          </button>
          <RoleChip role={s.role} tier={s.minTier} />
        </div>
        <div className="mt-1 text-[14px] font-semibold leading-snug">{s.title}</div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {stuck && (
            <Button size="sm" variant="secondary" onClick={() => forge.retryStory(s.id)}>
              <RotateCcw className="size-3.5" /> {tr("Try again")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => onReply(s.goal)}>
            <MessageSquareReply className="size-3.5" /> {tr("Reply / add details")}
          </Button>
          {activeNow && (
            <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => forge.cancelStory(s.id)}>
              <CircleStop className="size-3.5" /> {tr("Cancel task")}
            </Button>
          )}
        </div>
      </PanelTop>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        {aps.map((a) => (
          <div key={a.id} className="px-2 pb-2">
            <ApprovalCard ap={a} />
          </div>
        ))}
        {(deps.length > 0 || dependents.length > 0) && (
          <div className="flex flex-wrap items-center gap-1 px-2 pb-2 text-[11px] text-muted-foreground">
            {deps.length > 0 && <span>{tr("After")}</span>}
            {deps.map((d) => (
              <LinkChip key={d.id} s={d} onClick={() => onOpen({ kind: "story", id: d.id })} />
            ))}
            {dependents.length > 0 && <span className="ml-1">{tr("Before")}</span>}
            {dependents.map((d) => (
              <LinkChip key={d.id} s={d} onClick={() => onOpen({ kind: "story", id: d.id })} />
            ))}
          </div>
        )}
        <div className="-ml-5">
          <StoryDetail story={s} runs={runs} />
        </div>
      </div>
    </>
  );
}

function LinkChip({ s, onClick }: { s: Story; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press flex items-center gap-1 rounded-md bg-ov/[0.06] px-1.5 py-0.5 hover:bg-ov/10 hover:text-foreground">
      <StatusIcon s={s.status} className="size-3" />
      <span className="max-w-40 truncate">{s.title}</span>
    </button>
  );
}

function GoalPanel({ id, onClose, onReply, onOpen }: { id: string; onClose: () => void; onReply: (g: string) => void; onOpen: (s: Selected) => void }) {
  const g = useForge((st) => st.goals[id]);
  const storiesAll = useForge((st) => st.stories);
  const approvals = useForge((st) => st.approvals);
  const runsAll = useForge((st) => st.runs);
  if (!g) return <PanelTop onClose={onClose}>{tr("This goal is gone.")}</PanelTop>;
  const stories = Object.values(storiesAll)
    .filter((s) => s.goal === g.id)
    .sort((a, b) => storyNum(a) - storyNum(b));
  const aps = Object.values(approvals).filter((a) => a.subject === g.id);
  const planRun = Object.values(runsAll)
    .filter((r) => r.subject === g.id && r.purpose === "plan")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  return (
    <>
      <PanelTop onClose={onClose}>
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="size-2 rounded-full" style={{ background: goalColor(g.id) }} />
          <span className={tone(g.status)}>{tr(GOAL_LABEL[g.status])}</span>
          {g.workspace && <span className="truncate text-muted-foreground">· {g.workspace}</span>}
          <div className="flex-1" />
          <GoalActions goal={g} onReply={onReply} />
        </div>
        <div className="mt-1 text-[13.5px] leading-snug whitespace-pre-wrap">{g.text}</div>
      </PanelTop>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-4 pt-3 pb-4 text-[12px]">
        {aps.map((a) => (
          <ApprovalCard key={a.id} ap={a} />
        ))}
        {g.note && (
          <div className={cn("rounded-md px-2.5 py-1.5 whitespace-pre-wrap", g.status === "needs_human" ? "bg-warning/[0.08]" : "bg-ov/[0.04] text-muted-foreground")}>
            {g.note}
          </div>
        )}
        {g.messages.length > 0 && (
          <div className="flex flex-col gap-1">
            {g.messages.map((m) => (
              <div key={m.at} className="rounded-md bg-primary/[0.07] px-2.5 py-1">
                {m.text}
              </div>
            ))}
          </div>
        )}
        {stories.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {stories.map((s) => (
              <button
                key={s.id}
                type="button"
                onClick={() => onOpen({ kind: "story", id: s.id })}
                className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-ov/[0.05]"
              >
                <StatusIcon s={s.status} />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <RoleChip role={s.role} tier={s.minTier} />
              </button>
            ))}
          </div>
        )}
        {planRun && (
          <div>
            <div className="mb-1 text-[11px] font-medium text-muted-foreground">{tr("Planning")}</div>
            <RunLog runId={planRun.id} />
          </div>
        )}
        {g.status === "done" && <GoalResult goal={g} stories={stories} className="order-first" />}
      </div>
    </>
  );
}
