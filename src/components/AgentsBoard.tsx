// The board: one row per goal with its tasks as a small flow chart (left → right by
// dependency), plus the goal page (report, follow-ups) and the task page (output, checks,
// the agents' work). Rows don't leave whole columns empty the way stage columns do.
import {
  Bot,
  ChevronRight,
  Clock,
  FileText,
  Folder,
  GitBranch,
  Hand,
  ListChecks,
  Loader2,
  MessageSquarePlus,
  Package,
  Plus,
  RotateCcw,
  ScrollText,
  Send,
  ShieldCheck,
  ShieldX,
  SkipForward,
  Target,
  TriangleAlert,
  X,
  Zap,
  BookOpen,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { MarkdownActions, RichMarkdown } from "@/components/ui/markdown";
import { openNote } from "./KnowledgePanel";
import { shortName, shortPaths } from "@/lib/forge/config";
import { forge } from "@/lib/forge/engine";
import { followUp } from "@/lib/forge/entry";
import { useForge } from "@/lib/forge/store";
import type { Goal, Story } from "@/lib/forge/types";
import { tr } from "@/lib/i18n";
import { toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import {
  ApprovalCard,
  Elapsed,
  GOAL_LABEL,
  GoalActions,
  type Page,
  RoleChip,
  RunLog,
  STATUS_LABEL,
  StatusIcon,
  tone,
} from "./AgentsView";

type Go = (p: Page) => void;

const FINISHED = ["done", "cancelled", "failed"];
const storyNum = (s: Story) => Number(s.id.replace(/\D/g, "")) || 0;

function useGoalStories(goalId: string) {
  const all = useForge((s) => s.stories);
  return useMemo(() => Object.values(all).filter((s) => s.goal === goalId).sort((a, b) => storyNum(a) - storyNum(b)), [all, goalId]);
}

// ------------------------------------------------------------------ board

type Filter = "active" | "attention" | "done" | "all";

export function Board({ go, onNew }: { go: Go; onNew: () => void }) {
  const goals = useForge((s) => s.goals);
  const approvals = useForge((s) => s.approvals);
  const stories = useForge((s) => s.stories);
  const list = useMemo(() => Object.values(goals), [goals]);
  const needsYou = (g: Goal) =>
    g.status === "needs_human" || Object.values(approvals).some((a) => a.subject === g.id || stories[a.subject]?.goal === g.id);
  const counts = {
    active: list.filter((g) => !FINISHED.includes(g.status)).length,
    attention: list.filter(needsYou).length,
    done: list.filter((g) => FINISHED.includes(g.status)).length,
    all: list.length,
  };
  const [filter, setFilter] = useState<Filter>(() => (counts.active ? "active" : "all"));
  // a filter with nothing left in it (everything finished, say) falls back to all
  const eff: Filter = counts[filter] ? filter : "all";
  const shown = list
    .filter((g) =>
      eff === "active" ? !FINISHED.includes(g.status) : eff === "attention" ? needsYou(g) : eff === "done" ? FINISHED.includes(g.status) : true,
    )
    .sort((a, b) => Number(needsYou(b)) - Number(needsYou(a)) || Number(FINISHED.includes(a.status)) - Number(FINISHED.includes(b.status)) || b.updatedAt.localeCompare(a.updatedAt));

  if (!list.length) return <Welcome onNew={onNew} />;
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[1180px] flex-col gap-3 px-5 py-4">
        <div className="flex items-center gap-1">
          {(
            [
              ["active", tr("In progress")],
              ["attention", tr("Needs you")],
              ["done", tr("Finished")],
              ["all", tr("All")],
            ] as const
          ).map(([f, label]) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "press flex h-7 items-center gap-1.5 rounded-full px-3 text-[12px] transition-colors",
                eff === f ? "bg-primary/14 text-foreground" : "text-muted-foreground hover:bg-ov/[0.05] hover:text-foreground",
              )}
            >
              {label}
              <span className={cn("text-[10.5px] tabular-nums", f === "attention" && counts.attention ? "text-warning" : "opacity-60")}>{counts[f]}</span>
            </button>
          ))}
        </div>
        {!shown.length && <div className="py-16 text-center text-[12.5px] text-muted-foreground">{tr("Nothing here.")}</div>}
        {shown.map((g) => (
          <GoalRow key={g.id} goal={g} go={go} />
        ))}
      </div>
    </div>
  );
}

function Welcome({ onNew }: { onNew: () => void }) {
  const probes = useForge((s) => s.probes);
  const peers = useForge((s) => s.config.peers);
  const probing = Object.values(probes).some((p) => p.probing);
  const ok = Object.values(probes).filter((p) => p.ok);
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 pb-16 text-center">
      <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/12 text-primary">
        <Bot className="size-6" />
      </div>
      <div className="text-[15px] font-semibold">{tr("Agents")}</div>
      <p className="max-w-[520px] text-[12.5px] text-muted-foreground">
        {tr(
          "Give it a task. It's planned into steps, handed to the best-suited agents in your pool, checked independently, and you get a report you can read without having watched. Code changes wait for your OK before they're merged.",
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
      <Button onClick={onNew} disabled={!peers.length && !probing}>
        <Plus className="size-3.5" /> {tr("New task")}
      </Button>
    </div>
  );
}

function GoalRow({ goal: g, go }: { goal: Goal; go: Go }) {
  const stories = useGoalStories(g.id);
  const approvals = useForge((s) => s.approvals);
  const counted = stories.filter((s) => s.status !== "cancelled");
  const done = counted.filter((s) => s.status === "done" || s.status === "skipped").length;
  const aps = Object.values(approvals).filter((a) => a.subject === g.id || stories.some((s) => s.id === a.subject));
  const finished = FINISHED.includes(g.status);
  const [showFlow, setShowFlow] = useState(false);
  return (
    <motion.div
      layout="position"
      className={cn(
        "overflow-hidden rounded-xl border bg-popover/60",
        g.status === "needs_human" || aps.length ? "border-warning/35" : "border-ov/[0.08]",
      )}
    >
      <button type="button" onClick={() => go({ kind: "goal", id: g.id })} className="group flex w-full items-start gap-3 px-4 pt-3 pb-2 text-left">
        <GoalDot status={g.status} />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-[13.5px] font-medium leading-snug">{shortName(g.text, 160)}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
            <span className={tone(g.status)}>{tr(GOAL_LABEL[g.status])}</span>
            {!!g.priority && !finished && (
              <span className="flex items-center gap-0.5 text-warning">
                <Zap className="size-3" />
                {tr("Urgent")}
              </span>
            )}
            {counted.length > 0 && (
              <span className="tabular-nums">{tr("{0} of {1} steps done", { 0: done, 1: counted.length })}</span>
            )}
            {g.workspace && (
              <span className="flex min-w-0 items-center gap-1">
                <Folder className="size-3" />
                <span className="truncate">{g.workspace.split(/[\\/]/).pop()}</span>
              </span>
            )}
            <span>
              <Elapsed from={g.createdAt} to={finished ? g.updatedAt : undefined} />
            </span>
          </div>
        </div>
        <ChevronRight className="mt-1 size-4 shrink-0 text-muted-foreground opacity-50 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
      </button>
      {counted.length > 0 && !finished && (
        <div className="mx-4 h-1 overflow-hidden rounded-full bg-ov/[0.08]">
          <motion.div
            className="h-full rounded-full bg-primary"
            initial={false}
            animate={{ width: `${(done / counted.length) * 100}%` }}
            transition={{ type: "spring", stiffness: 160, damping: 26 }}
          />
        </div>
      )}
      <div className="flex flex-col gap-2 px-4 pt-2.5 pb-3.5">
        {aps.map((a) => (
          <ApprovalCard key={a.id} ap={a} compact />
        ))}
        {g.status === "needs_human" && g.note && (
          <div className="rounded-lg bg-warning/[0.08] px-3 py-2 text-[12px] whitespace-pre-wrap">{g.note}</div>
        )}
        {g.status === "planning" && <PlanningLine goal={g} />}
        {g.status === "done" ? (
          <>
            {g.report ? (
              <button
                type="button"
                onClick={() => go({ kind: "goal", id: g.id })}
                className="relative max-h-40 overflow-hidden rounded-lg border border-success/20 bg-success/[0.04] px-3.5 py-2.5 text-left"
              >
                <RichMarkdown text={g.report} compact />
                <span className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-popover to-transparent" />
              </button>
            ) : (
              <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {tr("Writing the report…")}
              </div>
            )}
            {counted.length > 0 && (
              <button type="button" onClick={() => setShowFlow(!showFlow)} className="flex items-center gap-1 self-start text-[11.5px] text-muted-foreground hover:text-foreground">
                <ChevronRight className={cn("size-3 transition-transform", showFlow && "rotate-90")} />
                {tr("Steps")}
              </button>
            )}
            {showFlow && <Flow stories={counted} go={go} />}
          </>
        ) : (
          counted.length > 0 && <Flow stories={counted} go={go} />
        )}
      </div>
    </motion.div>
  );
}

function GoalDot({ status }: { status: Goal["status"] }) {
  return (
    <span className="mt-1.5 flex size-2.5 shrink-0 items-center justify-center">
      <span
        className={cn(
          "size-2.5 rounded-full",
          status === "done"
            ? "bg-success"
            : status === "needs_human"
              ? "bg-warning"
              : status === "failed"
                ? "bg-destructive"
                : status === "cancelled"
                  ? "bg-ov/30"
                  : "animate-pulse bg-primary",
        )}
      />
    </span>
  );
}

function PlanningLine({ goal: g }: { goal: Goal }) {
  const run = useForge((s) =>
    Object.values(s.runs)
      .filter((r) => r.subject === g.id && r.purpose === "plan")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
  );
  const live = run && (run.status === "running" || run.status === "starting");
  return (
    <div className="flex items-center gap-2 rounded-lg bg-ov/[0.03] px-3 py-2 text-[12px] text-muted-foreground">
      <Loader2 className="size-3.5 shrink-0 animate-spin text-primary" />
      <span className="shimmer shrink-0">{live ? tr("{0} is planning the steps…", { 0: run.peer }) : (g.waiting ?? tr("Queued — waiting for a free agent"))}</span>
      {live && run.activity && <span className="min-w-0 truncate font-mono text-[11px] opacity-70">{run.activity}</span>}
    </div>
  );
}

// ------------------------------------------------------------------ flow chart of a goal's tasks

const W = 232;
const H = 78;
const GX = 40;
const GY = 10;

function layout(stories: Story[]) {
  const byId = new Map(stories.map((s) => [s.id, s]));
  const depth = new Map<string, number>();
  const visit = (s: Story, seen: Set<string>): number => {
    const known = depth.get(s.id);
    if (known !== undefined) return known;
    if (seen.has(s.id)) return 0;
    seen.add(s.id);
    const deps = s.dependsOn.map((d) => byId.get(d)).filter((d): d is Story => !!d);
    const d = deps.length ? 1 + Math.max(...deps.map((x) => visit(x, seen))) : 0;
    depth.set(s.id, d);
    return d;
  };
  for (const s of stories) visit(s, new Set());
  const cols: Story[][] = [];
  for (const s of stories) (cols[depth.get(s.id)!] ??= []).push(s);
  const pos = new Map<string, { x: number; y: number }>();
  cols.forEach((col, ci) => col.forEach((s, ri) => pos.set(s.id, { x: ci * (W + GX), y: ri * (H + GY) })));
  const width = cols.length * W + (cols.length - 1) * GX;
  const height = Math.max(...cols.map((c) => c.length)) * (H + GY) - GY;
  const edges = stories.flatMap((s) =>
    s.dependsOn
      .filter((d) => pos.has(d))
      .map((d) => {
        const a = pos.get(d)!;
        const b = pos.get(s.id)!;
        const x1 = a.x + W;
        const y1 = a.y + H / 2;
        const x2 = b.x;
        const y2 = b.y + H / 2;
        const dx = (x2 - x1) / 2;
        return {
          key: `${d}>${s.id}`,
          d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2 - 2} ${y2}`,
          done: byId.get(d)?.status === "done" || byId.get(d)?.status === "skipped",
          waiting: s.status === "blocked",
        };
      }),
  );
  return { pos, width, height, edges };
}

function Flow({ stories, go }: { stories: Story[]; go: Go }) {
  const { pos, width, height, edges } = useMemo(() => layout(stories), [stories]);
  const [preview, setPreview] = useState<Story | null>(null);
  return (
    <div className="kb-scroll -mx-1 overflow-x-auto px-1 pb-1">
      <div className="relative" style={{ width, height }}>
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
          <defs>
            <marker id="flow-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L8,4 L0,8 z" fill="context-stroke" />
            </marker>
          </defs>
          {edges.map((e) => (
            <path
              key={e.key}
              d={e.d}
              fill="none"
              markerEnd="url(#flow-arrow)"
              className={cn(e.waiting && !e.done && "kb-flow")}
              stroke={e.done ? "var(--success)" : "var(--muted-foreground)"}
              strokeOpacity={e.done ? 0.55 : 0.5}
              strokeWidth={1.5}
              strokeDasharray={e.done ? undefined : "5 4"}
            />
          ))}
        </svg>
        {stories.map((s) => {
          const p = pos.get(s.id)!;
          return (
            <motion.div
              key={s.id}
              initial={false}
              animate={{ x: p.x, y: p.y }}
              transition={{ type: "spring", stiffness: 380, damping: 34 }}
              className="absolute top-0 left-0"
              style={{ width: W, height: H }}
            >
              <TaskNode story={s} onOpen={() => go({ kind: "task", id: s.id })} onPreview={() => setPreview(s)} />
            </motion.div>
          );
        })}
      </div>
      {preview && <OutputPreview title={preview.title} text={preview.output ?? preview.handoff?.summary ?? ""} onClose={() => setPreview(null)} />}
    </div>
  );
}

function TaskNode({ story: s, onOpen, onPreview }: { story: Story; onOpen: () => void; onPreview: () => void }) {
  const runs = useForge((st) => st.runs);
  const active = useForge((st) => st.activeRuns);
  const pending = useForge((st) => Object.values(st.approvals).some((a) => a.subject === s.id));
  const live = Object.values(runs)
    .filter((r) => r.subject === s.id && active.includes(r.id))
    .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
    .at(-1);
  const escalated = s.attempts.length > 0 && s.attempts.at(-1)!.tier !== s.minTier;
  const stuck = ["needs_human", "needs_split", "failed"].includes(s.status);
  const hasOutput = !!(s.output || s.handoff?.summary);
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        "group relative flex h-full cursor-default flex-col gap-1 overflow-hidden rounded-lg border bg-popover px-2.5 py-2 transition-[border-color,box-shadow] hover:shadow-md hover:shadow-shadow/20",
        stuck || pending
          ? "border-warning/40"
          : s.status === "skipped"
            ? "border-dashed border-ov/25 opacity-70"
            : s.status === "done"
              ? "border-success/25"
              : live
                ? "border-primary/35"
                : "border-ov/[0.09] hover:border-ov/20",
      )}
    >
      {live && <span className="kb-run absolute inset-x-0 top-0 h-px" />}
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon s={s.status} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{s.title}</span>
        {pending && <Hand className="size-3.5 shrink-0 animate-pulse text-warning" />}
        {s.risk === "destructive" && <TriangleAlert className="size-3.5 shrink-0 text-warning" />}
      </div>
      <div className="flex min-w-0 items-center gap-1.5">
        <RoleChip role={s.role} tier={escalated ? s.attempts.at(-1)!.tier : s.minTier} up={escalated} />
        <span className={cn("min-w-0 truncate text-[10.5px]", live ? "text-muted-foreground" : tone(s.status))}>
          {live ? (
            <>
              {live.peer}
              {live.purpose === "verify" ? ` · ${tr("checking")}` : ""} · <Elapsed from={live.startedAt} />
            </>
          ) : (
            tr(STATUS_LABEL[s.status])
          )}
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-1 text-[10.5px] text-muted-foreground">
        <span className={cn("min-w-0 flex-1 truncate", stuck && "text-warning", live && "font-mono")}>
          {live ? live.activity : s.status === "skipped" ? s.skipNote : s.blockedReason ? s.blockedReason : s.status === "done" ? s.handoff?.summary : ""}
        </span>
        {hasOutput && s.status === "done" && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onPreview();
            }}
            className="press flex shrink-0 items-center gap-0.5 rounded px-1 py-px text-muted-foreground hover:bg-ov/[0.08] hover:text-foreground"
          >
            <FileText className="size-3" /> {tr("Preview")}
          </button>
        )}
      </div>
    </div>
  );
}

/** A markdown output or file, in a large readable dialog with copy / export. */
export function OutputPreview({ title, text, load, onClose }: { title: string; text?: string; load?: () => Promise<string>; onClose: () => void }) {
  const [content, setContent] = useState<string | null>(text ?? null);
  const [error, setError] = useState<string | null>(null);
  // load once when opened (the loader is a fresh closure on every render)
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (load) load().then(setContent, (e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-[min(860px,calc(100%-2rem))] flex-col gap-3 p-0">
        <DialogHeader className="flex-row items-center gap-2 border-b border-ov/[0.07] px-5 pt-4 pb-3 pr-12">
          <DialogTitle className="min-w-0 flex-1 truncate">{title}</DialogTitle>
          {content && <MarkdownActions text={content} name={title} />}
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
          {error ? (
            <div className="text-[12.5px] text-destructive">{error}</div>
          ) : content === null ? (
            <Loader2 className="mx-auto my-8 size-5 animate-spin text-muted-foreground" />
          ) : content.trim() ? (
            <RichMarkdown text={content} />
          ) : (
            <div className="text-[12.5px] text-muted-foreground">{tr("No output.")}</div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ pages

function PageShell({ onUp, children }: { onUp: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("[role=dialog]")) onUp();
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onUp]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex max-w-[960px] flex-col gap-5 px-6 pt-6 pb-12">{children}</div>
    </div>
  );
}

function Pill({ className, children }: { className?: string; children: React.ReactNode }) {
  return <span className={cn("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium", className)}>{children}</span>;
}

const pillTone = (s: string) =>
  s === "done"
    ? "bg-success/12 text-success"
    : s === "failed"
      ? "bg-destructive/12 text-destructive"
      : s === "needs_human" || s === "needs_split" || s === "draft"
        ? "bg-warning/14 text-warning"
        : s === "cancelled" || s === "skipped"
          ? "bg-ov/[0.08] text-muted-foreground"
          : "bg-primary/12 text-primary";

/** A report section: title row with an icon, then the content. */
function Panel({
  icon,
  title,
  actions,
  children,
  className,
}: {
  icon?: React.ReactNode;
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-2xl border border-ov/[0.08] bg-popover/70 shadow-sm shadow-shadow/10", className)}>
      {(title || actions) && (
        <div className="flex min-h-11 items-center gap-2 px-5 pt-3">
          {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
          <h2 className="min-w-0 flex-1 text-[13px] font-semibold">{title}</h2>
          {actions}
        </div>
      )}
      <div className="px-5 pt-2 pb-5">{children}</div>
    </section>
  );
}

const clock = (iso?: string) => {
  if (!iso) return "";
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function GoalPage({ id, go }: { id: string; go: Go }) {
  const g = useForge((s) => s.goals[id]);
  const stories = useGoalStories(id);
  const approvals = useForge((s) => s.approvals);
  const planRun = useForge((s) =>
    Object.values(s.runs)
      .filter((r) => r.subject === id && r.purpose === "plan")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
  );
  const [planOpen, setPlanOpen] = useState(false);
  if (!g) return null;
  const counted = stories.filter((s) => s.status !== "cancelled");
  const settled = counted.filter((s) => s.status === "done" || s.status === "skipped").length;
  const aps = Object.values(approvals).filter((a) => a.subject === g.id || stories.some((s) => s.id === a.subject));
  const stuck = stories.filter((s) => ["needs_human", "needs_split", "failed"].includes(s.status));
  return (
    <PageShell onUp={() => go({ kind: "board" })}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <Pill className={pillTone(g.status)}>{tr(GOAL_LABEL[g.status])}</Pill>
          {counted.length > 0 && <span>{tr("{0} of {1} steps done", { 0: settled, 1: counted.length })}</span>}
          {g.workspace && (
            <span className="flex min-w-0 items-center gap-1" title={g.workspace}>
              <Folder className="size-3" />
              <span className="truncate">{g.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}</span>
            </span>
          )}
          <span>
            <Elapsed from={g.createdAt} to={FINISHED.includes(g.status) ? g.updatedAt : undefined} />
          </span>
          <div className="flex-1" />
          {planRun && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setPlanOpen(true)}>
              <ScrollText className="size-3.5" /> {tr("How it was planned")}
            </Button>
          )}
          {stuck.length > 0 && (
            <Button size="sm" variant="secondary" className="h-7" onClick={() => stuck.forEach((s) => forge.retryStory(s.id))}>
              <RotateCcw className="size-3.5" /> {tr("Retry stuck steps")}
            </Button>
          )}
          <GoalActions goal={g} onRemoved={() => go({ kind: "board" })} />
        </div>
        <h1 className="text-[19px] leading-snug font-semibold whitespace-pre-wrap select-text" title={g.text}>
          {shortPaths(g.text)}
        </h1>
        {counted.length > 0 && !FINISHED.includes(g.status) && (
          <div className="h-1.5 overflow-hidden rounded-full bg-ov/[0.08]">
            <motion.div
              className="h-full rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(settled / counted.length) * 100}%` }}
              transition={{ type: "spring", stiffness: 160, damping: 26 }}
            />
          </div>
        )}
      </header>

      {aps.map((a) => (
        <ApprovalCard key={a.id} ap={a} />
      ))}

      {g.status === "done" && (
        <Panel
          icon={<ShieldCheck className="text-success" />}
          title={tr("Result")}
          actions={g.report ? <MarkdownActions text={g.report} name={shortName(g.text, 40)} /> : undefined}
          className="border-success/25"
        >
          {g.report ? (
            <>
              <RichMarkdown text={g.report} />
              {!!g.learned?.length && (
                <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-ov/[0.06] pt-2.5 text-[11.5px] text-muted-foreground">
                  <BookOpen className="size-3.5" />
                  {tr("Kept in the knowledge base:")}
                  {g.learned.map((n) => (
                    <button
                      key={n.id}
                      type="button"
                      onClick={() => void openNote(n.id)}
                      className="press rounded-md bg-ov/[0.06] px-1.5 py-0.5 text-foreground/85 hover:bg-ov/[0.1]"
                    >
                      {n.title}
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <div className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> {tr("Writing the report…")}
            </div>
          )}
        </Panel>
      )}

      {g.note && g.status !== "done" && (
        <div className={cn("rounded-2xl px-5 py-3.5 text-[12.5px] whitespace-pre-wrap select-text", g.status === "needs_human" ? "bg-warning/[0.08]" : "bg-ov/[0.04] text-muted-foreground")}>
          {g.note}
        </div>
      )}

      {g.status === "planning" && <PlanningLine goal={g} />}

      {counted.length > 0 && (
        <Panel icon={<ListChecks />} title={tr("Steps")}>
          <Flow stories={counted} go={go} />
        </Panel>
      )}

      <FollowUp goal={g} />

      {planOpen && planRun && (
        <LogDialog title={tr("How it was planned")} runId={planRun.id} onClose={() => setPlanOpen(false)} />
      )}
    </PageShell>
  );
}

function FollowUp({ goal: g }: { goal: Goal }) {
  const [text, setText] = useState("");
  const done = g.status === "done";
  const send = () => {
    const t = text.trim();
    if (!t) return;
    try {
      followUp(g.id, t);
      setText("");
    } catch (e) {
      toast({ kind: "error", title: (e as Error).message });
    }
  };
  return (
    <Panel icon={<MessageSquarePlus />} title={g.status === "needs_human" ? tr("Answer / add details") : tr("Add details")}>
      {g.messages.length > 0 && (
        <div className="mb-2.5 flex flex-col gap-1">
          {g.messages.map((m) => (
            <div key={m.at} className="flex gap-2 rounded-lg bg-primary/[0.07] px-3 py-1.5 text-[12.5px] select-text">
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{clock(m.at)}</span>
              <span className="whitespace-pre-wrap">{m.text}</span>
            </div>
          ))}
        </div>
      )}
      {done ? (
        <div className="text-[12px] text-muted-foreground">{tr("This goal is finished. To continue, start a new task.")}</div>
      ) : (
        <div className="flex items-end gap-2">
          <textarea
            rows={2}
            value={text}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              g.status === "needs_human"
                ? tr("Answer its questions or say how to continue — stuck steps run again with it (Ctrl+Enter)")
                : tr("Corrections or extra requirements; steps that haven't started yet will see them (Ctrl+Enter)")
            }
            className="min-h-[52px] flex-1 resize-y rounded-lg border border-input bg-inset px-3 py-2 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
          />
          <Button size="sm" disabled={!text.trim()} onClick={send}>
            <Send className="size-3.5" /> {tr("Send")}
          </Button>
        </div>
      )}
    </Panel>
  );
}

// ------------------------------------------------------------------ step page: a timeline, newest on top

type TimelineEntry = {
  key: string;
  at?: string;
  icon: React.ReactNode;
  tone: "ok" | "bad" | "warn" | "live" | "muted";
  title: React.ReactNode;
  meta?: React.ReactNode;
  body?: React.ReactNode;
  actions?: React.ReactNode;
};

export function TaskPage({ id, go }: { id: string; go: Go }) {
  const s = useForge((st) => st.stories[id]);
  const runsAll = useForge((st) => st.runs);
  const activeIds = useForge((st) => st.activeRuns);
  const approvals = useForge((st) => st.approvals);
  const [dialog, setDialog] = useState<null | { kind: "brief" } | { kind: "skip" } | { kind: "log"; run: string; title: string } | { kind: "file"; path: string }>(null);
  if (!s) return null;
  const runs = Object.values(runsAll).filter((r) => r.subject === s.id);
  const liveRun = runs.filter((r) => activeIds.includes(r.id)).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  const aps = Object.values(approvals).filter((a) => a.subject === s.id);
  const stuck = ["needs_human", "needs_split", "failed", "cancelled"].includes(s.status);
  const open = !["done", "skipped", "cancelled"].includes(s.status);
  const objective = s.objective || firstSentence(s.instructions);

  const entries: TimelineEntry[] = [];
  if (s.status === "skipped")
    entries.push({
      key: "skip",
      at: s.updatedAt,
      icon: <SkipForward />,
      tone: "muted",
      title: tr("Skipped"),
      body: s.skipNote ? <div className="text-[12.5px] whitespace-pre-wrap select-text">{s.skipNote}</div> : undefined,
    });
  if (s.blockedReason && (stuck || s.status === "blocked" || s.status === "ready"))
    entries.push({
      key: "blocked",
      at: s.updatedAt,
      icon: stuck ? <Hand /> : <Clock />,
      tone: stuck ? "warn" : "muted",
      title: stuck ? tr("Needs you") : tr("Waiting"),
      body: <div className="text-[12.5px] whitespace-pre-wrap select-text">{s.blockedReason}</div>,
    });
  s.attempts.forEach((a, i) => {
    const run = runsAll[a.run];
    const latest = i === s.attempts.length - 1;
    const label = s.attempts.length > 1 ? tr("Attempt {0}", { 0: i + 1 }) : "";
    if (a.verify) {
      const vrun = a.verify.by !== "command" ? runsAll[a.verify.by] : undefined;
      entries.push({
        key: `v${i}`,
        at: vrun?.endedAt ?? run?.endedAt,
        icon: a.verify.pass ? <ShieldCheck /> : <ShieldX />,
        tone: a.verify.pass ? "ok" : "bad",
        title: a.verify.pass ? tr("Passed the check") : tr("Didn't pass the check"),
        meta: [label, vrun ? tr("checked by {0}", { 0: vrun.peer }) : tr("checked by its commands")].filter(Boolean).join(" · "),
        body: <div className="text-[12.5px] text-foreground/85 select-text">{a.verify.reason}</div>,
        actions: vrun ? <LogButton onClick={() => setDialog({ kind: "log", run: vrun.id, title: tr("Check · {0}", { 0: vrun.peer }) })} /> : undefined,
      });
    }
    if (latest && (s.output || s.handoff)) {
      const h = s.handoff;
      const text = s.output || h?.summary || "";
      entries.push({
        key: `o${i}`,
        at: run?.endedAt,
        icon: <FileText />,
        tone: "ok",
        title: tr("Output"),
        meta: label || undefined,
        actions: text ? <MarkdownActions text={text} name={s.title} /> : undefined,
        body: (
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-ov/[0.07] bg-surface/60 px-4 py-3">
              <RichMarkdown text={text} />
            </div>
            {h && h.changes.length > 0 && (
              <div className="flex flex-col gap-1">
                <div className="text-[11px] font-medium text-muted-foreground">{tr("Files")}</div>
                {h.changes.map((c, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <div key={j} className="flex min-w-0 items-center gap-2 rounded-lg bg-ov/[0.03] px-2.5 py-1.5 text-[12px]">
                    <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                    <code className="shrink-0 font-mono text-[11.5px] select-text">{c.resource}</code>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.what}</span>
                    {/\.(md|markdown|txt)$/i.test(c.resource) && (
                      <button
                        type="button"
                        onClick={() => setDialog({ kind: "file", path: c.resource })}
                        className="press shrink-0 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-ov/[0.07] hover:text-foreground"
                      >
                        {tr("Preview")}
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
            {h && h.openIssues.length > 0 && (
              <div className="flex flex-col gap-1 rounded-lg bg-warning/[0.07] px-3 py-2 text-[12px]">
                {h.openIssues.map((x, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <div key={j} className="flex gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" /> {x}
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
      });
    } else if (!latest && (a.error || (a.outcome && a.outcome !== "done")))
      entries.push({
        key: `e${i}`,
        at: run?.endedAt,
        icon: <X />,
        tone: "bad",
        title: tr("Attempt {0} didn't work out", { 0: i + 1 }),
        body: a.error ? <div className="text-[12px] text-muted-foreground select-text">{a.error.slice(0, 600)}</div> : undefined,
      });
    if (run) {
      const live = activeIds.includes(run.id);
      entries.push({
        key: `w${i}`,
        at: run.startedAt,
        icon: live ? <Loader2 className="animate-spin" /> : <Bot />,
        tone: live ? "live" : "muted",
        title: live ? tr("{0} is working on it", { 0: run.peer }) : tr("{0} worked on it", { 0: run.peer }),
        meta: (
          <>
            {label && `${label} · `}
            <Elapsed from={run.startedAt} to={run.endedAt} />
          </>
        ),
        body: live && run.activity ? <div className="truncate font-mono text-[11.5px] text-muted-foreground">{run.activity}</div> : undefined,
        actions: <LogButton onClick={() => setDialog({ kind: "log", run: run.id, title: tr("Work · {0}", { 0: run.peer }) })} />,
      });
    }
  });
  if (!s.attempts.length && !s.blockedReason && s.status !== "skipped")
    entries.push({ key: "wait", at: s.createdAt, icon: <Clock />, tone: "muted", title: tr("Not started yet") });
  entries.sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""));

  return (
    <PageShell onUp={() => go({ kind: "goal", id: s.goal })}>
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-[11.5px] text-muted-foreground">
          <Pill className={pillTone(s.status)}>
            <StatusIcon s={s.status} className="size-3" />
            {tr(STATUS_LABEL[s.status])}
          </Pill>
          <RoleChip role={s.role} tier={s.attempts.at(-1)?.tier ?? s.minTier} up={!!s.attempts.at(-1) && s.attempts.at(-1)!.tier !== s.minTier} />
          {s.attempts.at(-1) && (
            <span className="flex items-center gap-1">
              <Bot className="size-3" /> {s.attempts.at(-1)!.peer}
            </span>
          )}
          <div className="flex-1" />
          <Button size="sm" variant="ghost" className="h-7" onClick={() => setDialog({ kind: "brief" })}>
            <ScrollText className="size-3.5" /> {tr("Step details")}
          </Button>
          {stuck && (
            <Button size="sm" variant="secondary" className="h-7" onClick={() => forge.retryStory(s.id)}>
              <RotateCcw className="size-3.5" /> {tr("Try again")}
            </Button>
          )}
          {open && (
            <Button size="sm" variant="ghost" className="h-7" onClick={() => setDialog({ kind: "skip" })}>
              <SkipForward className="size-3.5" /> {tr("Skip")}
            </Button>
          )}
          {liveRun && (
            <Button size="sm" variant="ghost" className="h-7 text-destructive hover:text-destructive" onClick={() => forge.cancelStory(s.id)}>
              <X className="size-3.5" /> {tr("Cancel task")}
            </Button>
          )}
        </div>
        <h1 className="text-[19px] leading-snug font-semibold select-text">{s.title}</h1>
        {objective && (
          <div className="flex gap-2.5 rounded-xl bg-primary/[0.06] px-4 py-3 text-[13px] leading-relaxed select-text">
            <Target className="mt-0.5 size-4 shrink-0 text-primary" />
            <span>{objective}</span>
          </div>
        )}
      </header>

      {aps.map((a) => (
        <ApprovalCard key={a.id} ap={a} />
      ))}

      {liveRun && <Interject runId={liveRun.id} />}

      <ol className="relative flex flex-col">
        {entries.map((e, i) => (
          <TimelineItem key={e.key} entry={e} last={i === entries.length - 1} />
        ))}
      </ol>

      {dialog?.kind === "brief" && <BriefDialog story={s} go={go} onClose={() => setDialog(null)} />}
      {dialog?.kind === "skip" && <SkipDialog story={s} onClose={() => setDialog(null)} />}
      {dialog?.kind === "log" && <LogDialog title={dialog.title} runId={dialog.run} onClose={() => setDialog(null)} />}
      {dialog?.kind === "file" && <OutputPreview title={dialog.path} load={() => forge.readOutput(s.id, dialog.path)} onClose={() => setDialog(null)} />}
    </PageShell>
  );
}

function firstSentence(text: string) {
  const t = text.replace(/\s+/g, " ").trim();
  const m = t.match(/^(.{20,220}?[。.!！?？])(\s|$)/);
  return m ? m[1] : t.length > 220 ? `${t.slice(0, 219)}…` : t;
}

function TimelineItem({ entry: e, last }: { entry: TimelineEntry; last: boolean }) {
  const color =
    e.tone === "ok"
      ? "text-success bg-success/12"
      : e.tone === "bad"
        ? "text-destructive bg-destructive/12"
        : e.tone === "warn"
          ? "text-warning bg-warning/14"
          : e.tone === "live"
            ? "text-primary bg-primary/14"
            : "text-muted-foreground bg-ov/[0.07]";
  return (
    <li className="relative flex gap-4 pb-6">
      {!last && <span className="absolute top-8 bottom-0 left-[13px] w-px bg-ov/[0.1]" />}
      <span className={cn("relative z-[1] flex size-7 shrink-0 items-center justify-center rounded-full ring-4 ring-surface [&_svg]:size-3.5", color)}>{e.icon}</span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex min-h-6 items-center gap-2">
          <span className="text-[13px] font-semibold">{e.title}</span>
          {e.meta && <span className="text-[11px] text-muted-foreground">{e.meta}</span>}
          <span className="flex-1" />
          {e.at && <span className="text-[11px] text-muted-foreground tabular-nums">{clock(e.at)}</span>}
          {e.actions}
        </div>
        {e.body && <div className="mt-1.5">{e.body}</div>}
      </div>
    </li>
  );
}

function LogButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="press flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-ov/[0.07] hover:text-foreground">
      <ScrollText className="size-3" /> {tr("Process")}
    </button>
  );
}

/** Say something to the agent while it works (it's interrupted, reads it, carries on). */
function Interject({ runId }: { runId: string }) {
  const [text, setText] = useState("");
  const send = async () => {
    const t = text.trim();
    if (!t) return;
    if (await forge.interject(runId, t, "user")) {
      setText("");
      toast({ kind: "success", title: tr("Sent — it will read this and carry on") });
    }
  };
  return (
    <div className="flex items-end gap-2 rounded-2xl border border-primary/25 bg-primary/[0.04] p-2.5">
      <textarea
        rows={1}
        value={text}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void send();
          }
        }}
        placeholder={tr("Step in: tell the agent something while it works — a hint, a correction, a change of plan (Ctrl+Enter)")}
        className="min-h-[34px] flex-1 resize-y bg-transparent px-1.5 py-1.5 text-[12.5px] outline-none placeholder:text-muted-foreground/60"
      />
      <Button size="sm" disabled={!text.trim()} onClick={() => void send()}>
        <Send className="size-3.5" /> {tr("Send")}
      </Button>
    </div>
  );
}

function BriefDialog({ story: s, go, onClose }: { story: Story; go: Go; onClose: () => void }) {
  const all = useForge((st) => st.stories);
  const deps = s.dependsOn.map((d) => all[d]).filter(Boolean);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-[min(720px,calc(100%-2rem))] flex-col gap-0 p-0">
        <DialogHeader className="border-b border-ov/[0.07] px-6 pt-5 pb-3">
          <DialogTitle>{s.title}</DialogTitle>
        </DialogHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-6 py-5 text-[12.5px] select-text">
          {s.objective && <BriefBlock icon={<Target />} title={tr("Objective")}>{s.objective}</BriefBlock>}
          {s.steps && s.steps.length > 0 && (
            <BriefBlock icon={<ListChecks />} title={tr("Steps")}>
              <ol className="flex flex-col gap-1.5">
                {s.steps.map((x, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <li key={i} className="flex gap-2.5">
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-ov/[0.08] text-[10.5px] font-semibold tabular-nums">{i + 1}</span>
                    <span className="pt-px">{x}</span>
                  </li>
                ))}
              </ol>
            </BriefBlock>
          )}
          {s.deliverables && s.deliverables.length > 0 && (
            <BriefBlock icon={<Package />} title={tr("Deliverables")}>
              <ul className="flex flex-col gap-1">
                {s.deliverables.map((x, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <li key={i} className="flex gap-2">
                    <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-primary/70" />
                    {x}
                  </li>
                ))}
              </ul>
            </BriefBlock>
          )}
          {s.instructions && (
            <BriefBlock icon={<ScrollText />} title={s.objective ? tr("Details") : tr("Instructions")}>
              <div className="whitespace-pre-wrap text-foreground/85">{s.instructions}</div>
            </BriefBlock>
          )}
          {s.acceptance.length > 0 && (
            <BriefBlock icon={<ShieldCheck />} title={tr("How it's checked")}>
              <ul className="flex flex-col gap-1">
                {s.acceptance.map((a, i) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: static
                  <li key={i} className="flex gap-2">
                    <span className="shrink-0 text-muted-foreground">{a.kind === "command" ? "$" : "◇"}</span>
                    <span className={cn("break-all", a.kind !== "llm_judge" && "font-mono text-[11.5px]")}>{a.spec}</span>
                  </li>
                ))}
              </ul>
            </BriefBlock>
          )}
          {deps.length > 0 && (
            <BriefBlock icon={<GitBranch />} title={tr("Comes after")}>
              <div className="flex flex-wrap gap-1.5">
                {deps.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => {
                      onClose();
                      go({ kind: "task", id: d.id });
                    }}
                    className="press flex items-center gap-1.5 rounded-lg bg-ov/[0.06] px-2 py-1 hover:bg-ov/10"
                  >
                    <StatusIcon s={d.status} className="size-3" /> {d.title}
                  </button>
                ))}
              </div>
            </BriefBlock>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BriefBlock({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 flex items-center gap-1.5 text-[11.5px] font-semibold text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {title}
      </div>
      {children}
    </div>
  );
}

function SkipDialog({ story: s, onClose }: { story: Story; onClose: () => void }) {
  const [note, setNote] = useState("");
  const skip = () => {
    try {
      forge.skipStory(s.id, note);
      onClose();
    } catch (e) {
      toast({ kind: "error", title: (e as Error).message });
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(560px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{tr("Skip “{0}”", { 0: s.title })}</DialogTitle>
          <DialogDescription>
            {tr("The steps after it go ahead without it. Say why, and anything they should know instead — they'll read your note.")}
          </DialogDescription>
        </DialogHeader>
        <textarea
          autoFocus
          rows={4}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && note.trim()) {
              e.preventDefault();
              skip();
            }
          }}
          placeholder={tr("e.g. I already checked this by hand: the API is v2 and the token is in .env")}
          className="w-full resize-y rounded-lg border border-input bg-inset px-3 py-2 text-[12.5px] outline-none placeholder:text-muted-foreground/60 focus:border-primary/60"
        />
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {tr("Cancel")}
          </Button>
          <Button disabled={!note.trim()} onClick={skip}>
            <SkipForward className="size-3.5" /> {tr("Skip")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LogDialog({ title, runId, onClose }: { title: string; runId: string; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="flex max-h-[85vh] max-w-[min(860px,calc(100%-2rem))] flex-col gap-3 p-0">
        <DialogHeader className="border-b border-ov/[0.07] px-5 pt-4 pb-3">
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          <RunLog runId={runId} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
