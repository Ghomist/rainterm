// The engine: planner + scheduler + verifier loop (agent-forge PLAN.md §4, §6, §8.3).
// Flow is code, not prompt: each agent call makes one small decision whose output is
// checked against a schema and written to the board; the board is the only source of truth.
import { tr } from "@/lib/i18n";
import { knowledgeFor, refreshKb } from "@/lib/kb";
import { ipc } from "@/lib/ipc";
import { notify } from "@/lib/notify";
import type { AgentAutonomy } from "@/lib/settings";
import { useApp } from "@/store/app";
import { effectiveRoles, shortName, STATUS_LABEL, tierLabel } from "./config";
import { decide } from "./policy";
import { agentsHome, join, run, runShell } from "./proc";
import { complete, hasModel, languageRule, textOf } from "./llm";
import { extractJson, JSON_FIX, JSON_REMINDER, planPrompt, proseOnly, verifyPrompt, workPrompt } from "./prompts";
import { type AgentSession, createSession, probeRuntime } from "./runtimes";
import { Store, useForge } from "./store";
import {
  type AgentEvent,
  type AgentRun,
  type Check,
  type Feature,
  type ForgeConfig,
  type Goal,
  type Handoff,
  type PeerConfig,
  type PendingApproval,
  type PermissionCeiling,
  type RoleDef,
  type RunPurpose,
  type RuntimeConfig,
  type Story,
  TIERS,
  type Tier,
  type Verdict,
} from "./types";
import * as ws from "./workspace";

const now = () => new Date().toISOString();
const tierIdx = (t: Tier) => TIERS.indexOf(t);
const bumpTier = (t: Tier, n: number): Tier => TIERS[Math.min(TIERS.length - 1, Math.max(0, tierIdx(t) + n))];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ActiveRun {
  run: AgentRun;
  session?: AgentSession;
  story?: string;
  cancelled?: boolean;
  /** Messages waiting to be said to the agent once its turn is interrupted. */
  pending?: { from: "user" | "supervisor"; text: string }[];
  /** What it did lately, for the supervisor (tool calls, bits of text). */
  recent: string[];
  sinceCheck: number;
  checkedAt: number;
  corrections: number;
}

export class Engine {
  store = new Store();
  paused = false;
  private active = new Map<string, ActiveRun>();
  private waiters = new Map<string, (allow: boolean) => void>();
  private planning = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private started: Promise<void> | null = null;
  /** Workspace kind per path (git or plain folder), cached. */
  private gitCache = new Map<string, boolean>();

  get config(): ForgeConfig {
    return this.store.config;
  }

  /** Load the board and start scheduling (first agents tab opened). */
  start() {
    this.started ??= (async () => {
      await this.store.load();
      this.recover();
      // probing can take minutes (npx downloads adapters): never block on it
      if (this.store.fresh)
        void this.probeAll().then(() => {
          if (this.config.peers.length) return; // set up by hand meanwhile
          this.seedPeers();
          this.store.setConfig({ ...this.config });
        });
      else void this.probeAll();
      this.timer = setInterval(() => void this.tick(), 1500);
      this.superviseTimer = setInterval(() => void this.superviseTick(), 60_000);
      this.watchGoals();
      // goals finished before reports existed (or while a report was being written) get one now
      for (const g of this.store.goals.values())
        if (g.status === "done" && !g.report && Date.now() - Date.parse(g.updatedAt) < 7 * 86400_000) void this.report(g.id);
    })();
    return this.started;
  }

  private superviseTimer?: ReturnType<typeof setInterval>;
  stop() {
    clearInterval(this.timer);
    clearInterval(this.superviseTimer);
  }

  // ------------------------------------------------------------------ telling the user

  private say(goal: string, text: string) {
    this.store.addTimeline({ id: Math.random().toString(36).slice(2, 10), at: now(), from: "agent", text, goal });
  }

  /** Whatever path a goal takes, finishing posts its report and getting stuck says why. */
  private watchGoals() {
    const seen = new Map(Object.values(useForge.getState().goals).map((g) => [g.id, g.status]));
    useForge.subscribe((st) => {
      for (const g of Object.values(st.goals)) {
        const prev = seen.get(g.id);
        if (prev === g.status) continue;
        seen.set(g.id, g.status);
        if (prev === undefined && g.status === "planning") continue;
        if (g.status === "done" && !g.report) void this.report(g.id);
        else if (g.status === "needs_human")
          this.say(g.id, `${tr("“{0}” needs you.", { 0: shortName(g.text, 40) })}${g.note ? `\n\n${g.note}` : ""}\n\n${tr("Reply to it with more details, or retry its tasks on the board.")}`);
        else if (g.status === "failed") this.say(g.id, tr("“{0}” failed: {1}", { 0: shortName(g.text, 40), 1: g.note ?? "" }));
      }
    });
  }

  /** The final report: what the user asked for, answered for someone who didn't watch the work. */
  async report(goalId: string) {
    const g = this.store.goals.get(goalId);
    if (!g || this.reporting.has(goalId)) return;
    this.reporting.add(goalId);
    try {
      const done = this.storiesOf(g.id).filter((x) => x.status === "done" && x.handoff);
      const isGit = g.workspace ? await this.isGit(g.workspace) : false;
      const facts = done
        .map((x) => {
          const h = x.handoff!;
          const parts = [`### ${x.title}`, `Result: ${h.summary}`];
          if (x.output) parts.push(`Worker's write-up:\n${x.output.slice(0, 4000)}`);
          if (h.findings?.length) parts.push(...h.findings.map((f) => `- finding: ${f.claim}${f.source ? ` (${f.source})` : ""}`));
          if (h.changes.length) parts.push(...h.changes.map((c) => `- changed ${c.resource}: ${c.what}`));
          if (h.openIssues.length) parts.push(...h.openIssues.map((i) => `- open issue: ${i}`));
          return parts.join("\n");
        })
        .join("\n\n");
      const skipped = this.storiesOf(g.id).filter((x) => x.status === "skipped");
      const skippedFacts = skipped.map((x) => `- skipped by the user: ${x.title} (their note: ${x.skipNote ?? ""})`).join("\n");
      const where = g.workspace
        ? isGit
          ? `The work was done in the git repository ${g.workspace}, on branch ${ws.integrationBranch(g.id)}; it reaches the user's own branch only after they approve the merge.`
          : `The work was done directly in the folder ${g.workspace}.`
        : `There was no project folder; files the workers wrote are in ${join(await agentsHome(), "scratch", g.id)}.`;
      const system = `You write the final report of a finished task for the person who asked for it. They did not watch the work and don't know how it was split up — never mention agents, workers, stories, tasks, ids or JSON.
Write in Markdown:
1. First a short paragraph that directly answers or states the outcome (for a question: the answer itself, with the key facts).
2. Then only the sections that apply, with these headings: what was done; files changed (paths, one line each); how to check or use it; things that need attention (open issues, follow-ups, anything uncertain).
Be concrete and short. Use the facts given; don't invent anything.
${languageRule()}`;
      const user = `What they asked for:\n${g.text}${g.messages.length ? `\n\nTheir follow-ups:\n${g.messages.map((m) => `- ${m.text}`).join("\n")}` : ""}\n\n${where}\n\nResults:\n${facts || "(no results)"}${skippedFacts ? `\n\nNot done:\n${skippedFacts}` : ""}`;
      let text = "";
      if (facts && hasModel()) {
        try {
          text = textOf(await complete(system, [{ role: "user", content: [{ type: "text", text: user }] }], [], 2000));
        } catch {
          /* try a pool agent */
        }
      }
      if (!text && facts) {
        // no model of our own: ask an agent from the pool (no tools needed)
        const peer = this.matchPeer("analyze", "L1", { needCapacity: false }).peer ?? this.matchPeer("plan", "L1", { needCapacity: false }).peer;
        if (peer) {
          const cwd = join(await agentsHome(), "scratch", g.id);
          await ipc.fsMkdir({ kind: "local" }, cwd).catch(() => {});
          const out = await this.runAgent({
            peer,
            purpose: "report",
            subject: g.id,
            cwd,
            role: { ...this.role("analyze")!, permissionCeiling: { fs: "none", shell: "none", web: false, terminals: false } },
            timeoutMin: 10,
            expectJson: false,
            prompt: `${system}\n\nReply with the report only.\n\n${user}`,
          });
          if (!out.error) text = out.prose.trim();
        }
      }
      if (!text) text = this.stitchedReport(g, done, isGit);
      g.report = text;
      this.store.put("goals", g);
      this.say(g.id, text);
      if (facts && this.config.learn !== false) void this.learn(g.id, facts).catch(() => {});
    } finally {
      this.reporting.delete(goalId);
    }
  }

  private reporting = new Set<string>();

  /** The rainterm model, when one is set, for small picking / summarizing jobs. */
  private extractor() {
    if (!hasModel()) return undefined;
    return async (system: string, user: string) => textOf(await complete(system, [{ role: "user", content: [{ type: "text", text: user }] }], [], 900));
  }

  /**
   * After a goal: keep what it taught about the user's environment in the knowledge base,
   * updating related notes rather than piling up near-duplicates. Usually nothing.
   */
  private async learn(goalId: string, facts: string) {
    const g = this.store.goals.get(goalId);
    if (!g || g.learned) return;
    const related = await ipc.kbSearch(`${g.text}\n${facts}`.slice(0, 2000), 5).catch(() => []);
    const ids = new Set(related.map((h) => h.id));
    const existing = related.map((h) => `### ${h.title} (id: ${h.id})\n${h.snippet.slice(0, 900)}`).join("\n\n") || "(none)";
    const system = `You keep the knowledge base that AI agents working for one user share. From the results of a finished task, keep only durable knowledge that will help future tasks: how the user's machines, services and projects are set up (hosts, paths, versions, config locations, ports), procedures that worked, root causes and fixes of problems, rules or preferences the user stated. Skip anything one-off (this task's progress, temporary output, generic knowledge any engineer has) and never write secrets (passwords, tokens, private keys).
Prefer updating an existing related note over adding a near-duplicate: to update one, give its id and the complete new content, keeping its facts that are still valid.
Reply with only a JSON block: {"notes": [{"id": "an existing id, or omit for a new note", "title": "short and specific", "tags": ["..."], "content": "concise Markdown"}]} with at most 3 notes, or {"notes": []} when there is nothing worth keeping — which is common.
${languageRule()}`;
    const user = `What the user asked for:\n${g.text}\n\nResults:\n${facts.slice(0, 12_000)}\n\nExisting related notes:\n${existing}`;
    type Out = { notes?: { id?: string; title?: string; tags?: string[]; content?: string }[] };
    const valid = (v: Out | undefined) => (!Array.isArray(v?.notes) ? 'It needs "notes": an array (empty when nothing is worth keeping).' : null);
    let out: Out | undefined;
    if (hasModel()) {
      out = extractJson<Out>(textOf(await complete(system, [{ role: "user", content: [{ type: "text", text: user }] }], [], 2500)));
    } else {
      const m = this.matchPeer("analyze", "L1", { needCapacity: false });
      const pick = m.peer ? m : this.matchPeer("plan", "L1", { needCapacity: false });
      if (!pick.peer) return;
      const cwd = join(await agentsHome(), "scratch", g.id);
      await ipc.fsMkdir({ kind: "local" }, cwd).catch(() => {});
      const r = await this.runAgent<Out>({
        peer: pick.peer,
        purpose: "learn",
        subject: g.id,
        cwd,
        role: { ...this.role("analyze")!, permissionCeiling: { fs: "none", shell: "none", web: false, terminals: false } },
        timeoutMin: 6,
        prompt: `${system}\n\n${user}`,
        validate: valid,
      });
      out = r.json;
    }
    if (valid(out)) return;
    const secret = /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|gho|xox[bp])-?[A-Za-z0-9_]{20,}|password\s*[:=]\s*\S{4,}/i;
    const kept: { id: string; title: string }[] = [];
    for (const n of (out?.notes ?? []).slice(0, 3)) {
      const title = n.title?.trim();
      const content = n.content?.trim();
      if (!title || !content || secret.test(content)) continue;
      const id = n.id && ids.has(n.id) ? n.id : null;
      try {
        const saved = await ipc.kbSave(id, title, Array.isArray(n.tags) ? n.tags.map(String) : [], content, "agent");
        kept.push({ id: saved, title });
      } catch {
        /* skip this one */
      }
    }
    const cur = this.store.goals.get(goalId);
    if (!cur) return;
    cur.learned = kept;
    this.store.put("goals", cur);
    if (kept.length) void refreshKb();
  }

  /** A plain report from the results alone (no model available). */
  private stitchedReport(g: Goal, done: Story[], isGit: boolean) {
    const out: string[] = [];
    if (done.length === 1) out.push(done[0].handoff!.summary);
    else out.push(done.map((x) => `- **${x.title}**: ${x.handoff!.summary}`).join("\n"));
    const findings = done.flatMap((x) => x.handoff!.findings ?? []);
    if (findings.length) out.push(`## ${tr("Findings")}\n${findings.map((f) => `- ${f.claim}${f.source ? ` (\`${f.source}\`)` : ""}`).join("\n")}`);
    const changes = done.flatMap((x) => x.handoff!.changes);
    if (changes.length) out.push(`## ${tr("Files changed")}\n${changes.map((c) => `- \`${c.resource}\` ${c.what}`).join("\n")}`);
    const issues = done.flatMap((x) => x.handoff!.openIssues);
    if (issues.length) out.push(`## ${tr("Needs attention")}\n${issues.map((i) => `- ${i}`).join("\n")}`);
    if (isGit && changes.length) out.push(`> ${tr("The changes are on branch {0}; approve the merge to bring them into your branch.", { 0: ws.integrationBranch(g.id) })}`);
    return out.join("\n\n") || tr("Done.");
  }

  /** Text of a file a task produced (markdown reports and the like), wherever it lives now. */
  async readOutput(storyId: string, file: string): Promise<string> {
    const s = this.mustStory(storyId);
    const g = this.mustGoal(s.goal);
    const rel = file.replace(/^\.?[\\/]+/, "");
    if (/^([a-zA-Z]:[\\/]|\/)/.test(file)) return ipc.fileReadText(file, 1024 * 1024);
    if (g.workspace && (await this.isGit(g.workspace))) {
      // merged or not, the goal's branch has it
      for (const ref of [ws.integrationBranch(g.id), ws.storyBranch(s.id), "HEAD"]) {
        const r = await run(["git", "show", `${ref}:${rel.replace(/\\/g, "/")}`], { cwd: g.workspace, timeoutMs: 15_000 });
        if (r.code === 0) return r.stdout;
      }
      throw new Error(tr("File not found: {0}", { 0: rel }));
    }
    const base = g.workspace ?? join(await agentsHome(), "scratch", g.id);
    return ipc.fileReadText(join(base, rel), 1024 * 1024);
  }


  private sync() {
    useForge.setState({ paused: this.paused, activeRuns: [...this.active.keys()] });
  }

  private recover() {
    // tasks whose goal is gone (left over from an older version)
    for (const st of [...this.store.stories.values()]) if (!this.store.goals.has(st.goal)) this.store.del("stories", st.id);
    for (const f of [...this.store.features.values()]) if (!this.store.goals.has(f.goal)) this.store.del("features", f.id);
    for (const ap of [...this.store.approvals.values()])
      if (!this.store.goals.has(ap.subject) && !this.store.stories.has(ap.subject)) this.store.del("approvals", ap.id);
    for (const r of this.store.runs.values())
      if (["starting", "running", "waiting_permission"].includes(r.status))
        this.store.put("runs", { ...r, status: "failed", error: tr("interrupted (rainterm restarted)"), endedAt: now() });
    for (const s of this.store.stories.values())
      if (["claimed", "running", "verifying"].includes(s.status)) {
        const last = s.attempts.at(-1);
        if (last && !last.outcome) {
          last.outcome = "error";
          last.error = tr("interrupted (rainterm restarted)");
        }
        this.store.put("stories", { ...s, status: "ready", updatedAt: now() });
      }
    for (const a of this.store.approvals.values()) if (a.kind === "permission") this.store.del("approvals", a.id);
  }

  // ------------------------------------------------------------------ config & probing

  async probeAll() {
    await Promise.all(this.config.runtimes.map((r) => this.probe(r.id)));
  }

  async probe(runtimeId: string) {
    const rt = this.runtime(runtimeId);
    if (!rt) return;
    const prev = this.store.probes.get(rt.id);
    this.store.putProbe({ ...(prev ?? { runtime: rt.id, ok: false, models: [], efforts: [], probedAt: now() }), probing: true });
    const dir = join(await agentsHome(), "scratch", "_probe");
    await ipc.fsMkdir({ kind: "local" }, dir).catch(() => {});
    const p = await probeRuntime(rt, dir);
    this.store.putProbe({ ...p, probing: false });
    // a runtime that works is used; one that doesn't is skipped by matching anyway
    const cur = this.runtime(runtimeId);
    if (p.ok && cur && cur.enabled === false)
      this.store.setConfig({ ...this.config, runtimes: this.config.runtimes.map((r) => (r.id === runtimeId ? { ...r, enabled: true } : r)) });
    return p;
  }

  private seedPeers() {
    const ok = (id: string) => this.store.probes.get(id)?.ok;
    const has = (id: string, m: string) => this.store.probes.get(id)?.models.some((x) => x.value === m);
    const peers: PeerConfig[] = [];
    if (ok("rainterm"))
      peers.push({ id: "rainterm", runtime: "rainterm", roles: ["plan", "analyze", "verify", "research", "operate"], tier: "L3", maxConcurrent: 2, enabled: true });
    if (ok("claude")) {
      peers.push({ id: "claude-opus", runtime: "claude", model: has("claude", "opus") ? "opus" : undefined, effort: "high", roles: ["plan", "analyze", "verify"], tier: "L4", maxConcurrent: 1, enabled: true });
      peers.push({ id: "claude-sonnet", runtime: "claude", model: has("claude", "sonnet") ? "sonnet" : undefined, effort: "medium", roles: ["build", "verify", "research"], tier: "L3", maxConcurrent: 2, enabled: true });
    }
    if (ok("codex")) peers.push({ id: "codex", runtime: "codex", roles: ["build", "verify"], tier: "L3", maxConcurrent: 1, enabled: true });
    if (ok("opencode")) peers.push({ id: "opencode", runtime: "opencode", roles: ["research", "analyze", "build"], tier: "L2", maxConcurrent: 2, enabled: true });
    if (ok("pi")) peers.push({ id: "pi", runtime: "pi", roles: ["research", "analyze", "build"], tier: "L2", maxConcurrent: 2, enabled: true });
    for (const r of this.config.runtimes) r.enabled = r.kind === "rainterm" || !!ok(r.id);
    this.config.peers = peers;
  }

  updateConfig(next: ForgeConfig) {
    const added = next.runtimes.filter((r) => !this.config.runtimes.some((x) => x.id === r.id && JSON.stringify(x) === JSON.stringify(r)));
    this.store.setConfig(next);
    for (const r of added) if (r.enabled !== false) void this.probe(r.id);
  }

  roles(): RoleDef[] {
    return effectiveRoles(this.config);
  }
  role(id: string) {
    return this.roles().find((r) => r.id === id);
  }
  runtime(id: string): RuntimeConfig | undefined {
    return this.config.runtimes.find((r) => r.id === id);
  }

  costToday() {
    const day = now().slice(0, 10);
    let c = 0;
    for (const r of this.store.runs.values()) if (r.startedAt.startsWith(day)) c += r.usage?.costUsd ?? 0;
    return Math.round(c * 10000) / 10000;
  }

  // ------------------------------------------------------------------ user actions

  async submitGoal(text: string, workspace?: string): Promise<Goal> {
    text = text.trim();
    if (!text) throw new Error(tr("The goal is empty."));
    let path: string | undefined;
    if (workspace?.trim()) {
      path = workspace.trim().replace(/[\\/]+$/, "");
      const st = await ipc.pathStat(path);
      if (!st.dir) throw new Error(tr("Folder not found: {0}", { 0: path }));
      const recent = [path, ...this.config.workspaces.filter((w) => w.toLowerCase() !== path!.toLowerCase())].slice(0, 12);
      this.store.setConfig({ ...this.config, workspaces: recent });
    }
    const g: Goal = { id: this.store.nextId("G"), text, workspace: path, status: "planning", createdAt: now(), updatedAt: now(), messages: [] };
    this.store.put("goals", g);
    void this.tick();
    return g;
  }

  /**
   * A follow-up on a goal: re-plans a goal that stopped (needs you / failed / cancelled);
   * otherwise becomes a brief note every story that hasn't started yet sees.
   */
  postMessage(goalId: string, text: string) {
    const g = this.mustGoal(goalId);
    text = text.trim();
    if (!text) return g;
    if (g.status === "done") throw new Error(tr("“{0}” is already done; start a new goal instead.", { 0: shortName(g.text, 40) }));
    g.messages.push({ at: now(), text });
    if (["needs_human", "cancelled", "failed"].includes(g.status)) {
      // no plan yet (planning failed or asked questions) → plan again with the answer;
      // otherwise the stuck tasks run again, seeing the message in their brief
      const stuck = this.storiesOf(g.id).filter((s) => ["needs_human", "needs_split", "failed", "cancelled"].includes(s.status));
      if (!this.storiesOf(g.id).length) g.status = "planning";
      else {
        g.status = "active";
        for (const f of this.store.features.values())
          if (f.goal === g.id) {
            f.brief.push({ kind: "note", text: `User follow-up: ${text}`, source: "user" });
            this.store.put("features", f);
          }
        for (const s of stuck) {
          s.budget.attempts = s.attempts.length + 2;
          s.status = "blocked"; // re-evaluated by the next tick (ready once its dependencies are done)
          s.blockedReason = undefined;
          this.store.put("stories", s);
        }
      }
      g.note = undefined;
    } else {
      for (const f of this.store.features.values())
        if (f.goal === g.id) {
          f.brief.push({ kind: "note", text: `User follow-up: ${text}`, source: "user" });
          this.store.put("features", f);
        }
    }
    g.updatedAt = now();
    this.store.put("goals", g);
    void this.tick();
    return g;
  }

  cancelGoal(goalId: string) {
    const g = this.mustGoal(goalId);
    for (const s of this.storiesOf(goalId)) if (!["done", "cancelled"].includes(s.status)) this.cancelStory(s.id);
    for (const a of this.active.values()) if (a.run.subject === goalId) void this.cancelRun(a.run.id);
    const subjects = new Set([goalId, ...this.storiesOf(goalId).map((s) => s.id)]);
    for (const a of [...this.store.approvals.values()])
      if (subjects.has(a.subject)) {
        this.waiters.get(a.id)?.(false);
        this.waiters.delete(a.id);
        this.store.del("approvals", a.id);
      }
    g.status = "cancelled";
    g.updatedAt = now();
    this.store.put("goals", g);
  }

  deleteGoal(goalId: string) {
    const g = this.store.goals.get(goalId);
    if (!g) return;
    if (!["done", "cancelled", "failed"].includes(g.status)) this.cancelGoal(goalId);
    const storyIds = this.storiesOf(goalId).map((s) => s.id);
    for (const ap of [...this.store.approvals.values()])
      if (ap.subject === goalId || storyIds.includes(ap.subject)) {
        this.waiters.get(ap.id)?.(false);
        this.waiters.delete(ap.id);
        this.store.del("approvals", ap.id);
      }
    for (const s of this.storiesOf(goalId)) this.store.del("stories", s.id);
    for (const f of [...this.store.features.values()]) if (f.goal === goalId) this.store.del("features", f.id);
    for (const r of [...this.store.runs.values()]) if (r.subject === goalId || r.subject.startsWith("US-") && !this.store.stories.has(r.subject)) this.store.del("runs", r.id);
    // after the cancelled agents let go of their folders
    if (g.workspace && this.gitCache.get(g.workspace)) setTimeout(() => void ws.discardGoal(g.workspace!, goalId, storyIds).catch(() => {}), 2500);
    this.store.del("goals", goalId);
  }

  cancelStory(storyId: string) {
    const s = this.mustStory(storyId);
    for (const a of this.active.values()) if (a.story === storyId) void this.cancelRun(a.run.id);
    s.status = "cancelled";
    s.updatedAt = now();
    this.store.put("stories", s);
  }

  retryStory(storyId: string, peer?: string) {
    const s = this.mustStory(storyId);
    if (this.isStoryActive(storyId)) throw new Error(tr("“{0}” is running.", { 0: s.title }));
    s.budget.attempts = Math.max(s.budget.attempts, s.attempts.length + 1);
    s.pinnedPeer = peer || s.pinnedPeer;
    s.status = s.dependsOn.every((d) => isSettled(this.store.stories.get(d)?.status)) ? "ready" : "blocked";
    s.blockedReason = undefined;
    s.updatedAt = now();
    this.store.put("stories", s);
    const g = this.store.goals.get(s.goal);
    if (g && g.status !== "active") {
      g.status = "active";
      g.note = undefined;
      this.store.put("goals", g);
    }
    void this.tick();
  }

  /** Skip a step: the steps after it go ahead, told why (the note is required). */
  skipStory(storyId: string, note: string) {
    const s = this.mustStory(storyId);
    note = note.trim();
    if (!note) throw new Error(tr("Say why it's skipped, so the next steps know."));
    for (const a of this.active.values()) if (a.story === storyId) void this.cancelRun(a.run.id);
    for (const ap of [...this.store.approvals.values()])
      if (ap.subject === storyId) {
        this.waiters.get(ap.id)?.(false);
        this.waiters.delete(ap.id);
        this.store.del("approvals", ap.id);
      }
    s.status = "skipped";
    s.skipNote = note;
    s.blockedReason = undefined;
    s.updatedAt = now();
    this.store.put("stories", s);
    const f = this.store.features.get(s.feature);
    if (f) {
      f.brief.push({ kind: "note", text: `“${s.title}” was skipped by the user: ${note}`, source: "user" });
      this.store.put("features", f);
    }
    const g = this.store.goals.get(s.goal);
    if (g && g.status === "needs_human") {
      g.status = "active";
      g.note = undefined;
      this.store.put("goals", g);
    }
    if (g) void this.checkCompletion(g);
    void this.tick();
  }

  /** Say something to a running agent: its turn is interrupted, it reads this, then carries on. */
  async interject(runId: string, text: string, from: "user" | "supervisor" = "user") {
    const a = this.active.get(runId);
    text = text.trim();
    if (!a || !text) return false;
    (a.pending ??= []).push({ from, text });
    this.pushEvent(a.run, { t: "note", from, text });
    await a.session?.interrupt().catch(() => {});
    return true;
  }

  private supervising = new Set<string>();

  /** Now and then: is each working agent still on its step? If it clearly drifted, correct it. */
  private async superviseTick() {
    if (this.config.supervise === false || this.paused) return;
    for (const a of [...this.active.values()]) {
      if (a.run.purpose !== "work" || !a.story || a.cancelled || this.supervising.has(a.run.id)) continue;
      const age = Date.now() - Date.parse(a.run.startedAt);
      if (age < 3 * 60_000 || Date.now() - a.checkedAt < 4 * 60_000 || a.sinceCheck < 6 || a.corrections >= 3) continue;
      this.supervising.add(a.run.id);
      void this.supervise(a).finally(() => this.supervising.delete(a.run.id));
    }
  }

  private async supervise(a: ActiveRun) {
    const s = this.store.stories.get(a.story!);
    const g = s && this.store.goals.get(s.goal);
    if (!s || !g) return;
    a.checkedAt = Date.now();
    a.sinceCheck = 0;
    const minutes = Math.round((Date.now() - Date.parse(a.run.startedAt)) / 60_000);
    const system = `You supervise an AI agent working on one step of a larger task. Judge only whether it is still working toward its step. Flag it ONLY when it has clearly gone off track: working on something unrelated or out of scope, or stuck repeating the same failing approach many times. Exploring, reading, testing and trying alternatives are normal and fine.
Reply with only a JSON block: {"on_track": true|false, "reason": "one sentence", "correction": "if off track: a short, direct instruction to the agent to get back on track"}`;
    const user = `Overall task: ${g.text}\n\nThe agent's step: ${s.title}\n${s.instructions}\n\nIt has been working for ${minutes} minutes. Its recent activity, oldest first:\n${a.recent.slice(-40).join("\n")}`;
    let verdict: { on_track?: boolean; reason?: string; correction?: string } | undefined;
    if (hasModel()) {
      try {
        verdict = extractJson(textOf(await complete(system, [{ role: "user", content: [{ type: "text", text: user }] }], [], 600)));
      } catch {
        /* no verdict this time */
      }
    } else {
      // no model of our own: a cheap agent from the pool, without tools
      const m = this.matchPeer("verify", "L1", { reserve: true });
      const pick = m.peer ? m : this.matchPeer("analyze", "L1", { reserve: true });
      if (!pick.peer) return;
      const cwd = join(await agentsHome(), "scratch", "_supervise");
      await ipc.fsMkdir({ kind: "local" }, cwd).catch(() => {});
      const out = await this.runAgent<{ on_track?: boolean; reason?: string; correction?: string }>({
        peer: pick.peer,
        purpose: "supervise",
        subject: s.id,
        cwd,
        role: { ...this.role("verify")!, permissionCeiling: { fs: "none", shell: "none", web: false, terminals: false } },
        timeoutMin: 5,
        release: pick.release,
        prompt: `${system}\n\n${user}`,
        validate: (v) => (typeof v?.on_track !== "boolean" ? 'It needs "on_track": true or false.' : null),
      });
      verdict = out.json;
    }
    if (!verdict || verdict.on_track !== false || !this.active.has(a.run.id)) return;
    a.corrections++;
    const text = (verdict.correction || verdict.reason || "").trim();
    if (text) await this.interject(a.run.id, `${text}${verdict.reason && verdict.correction ? ` (${verdict.reason})` : ""}`, "supervisor");
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.sync();
    if (!p) void this.tick();
  }

  async emergencyStop() {
    this.paused = true;
    this.sync();
    await Promise.all([...this.active.keys()].map((id) => this.cancelRun(id)));
  }

  async cancelRun(runId: string) {
    const a = this.active.get(runId);
    if (!a) return;
    a.cancelled = true;
    for (const [id, ap] of this.store.approvals)
      if (ap.run === runId) {
        this.waiters.get(id)?.(false);
        this.waiters.delete(id);
        this.store.del("approvals", id);
      }
    await a.session?.cancel().catch(() => {});
  }

  async resolveApproval(id: string, allow: boolean, note?: string) {
    const ap = this.store.approvals.get(id);
    if (!ap) return;
    if (ap.kind === "permission") {
      this.store.del("approvals", id);
      this.waiters.get(id)?.(allow);
      this.waiters.delete(id);
    } else if (ap.kind === "plan") {
      this.store.del("approvals", id);
      const g = this.mustGoal(ap.subject);
      if (allow) {
        for (const f of this.store.features.values())
          if (f.goal === g.id && f.approval === "pending") {
            f.approval = "approved";
            this.store.put("features", f);
          }
        for (const s of this.storiesOf(g.id))
          if (s.status === "draft" && s.risk !== "destructive") {
            s.status = s.dependsOn.length ? "blocked" : "ready";
            this.store.put("stories", s);
          }
      } else {
        for (const s of this.storiesOf(g.id)) this.store.del("stories", s.id);
        for (const f of [...this.store.features.values()]) if (f.goal === g.id) this.store.del("features", f.id);
        if (note) {
          g.messages.push({ at: now(), text: `Feedback on the previous plan: ${note}` });
          g.status = "planning";
        } else g.status = "cancelled";
        this.store.put("goals", g);
      }
    } else if (ap.kind === "story") {
      this.store.del("approvals", id);
      const s = this.mustStory(ap.subject);
      s.status = allow ? (s.dependsOn.length ? "blocked" : "ready") : "cancelled";
      s.updatedAt = now();
      this.store.put("stories", s);
    } else if (ap.kind === "merge") {
      if (!allow) {
        this.store.del("approvals", id);
        return;
      }
      const g = this.mustGoal(ap.subject);
      try {
        const branch = await ws.mergeIntoUser(g.workspace!, g.id);
        this.store.del("approvals", id);
        g.note = tr("Merged into your branch {0}.", { 0: branch });
        this.store.put("goals", g);
      } catch (e) {
        ap.detail = tr("Merge failed: {0}", { 0: (e as Error).message });
        this.store.put("approvals", ap);
      }
    }
    void this.tick();
  }

  // ------------------------------------------------------------------ helpers

  mustGoal(id: string) {
    const g = this.store.goals.get(id);
    if (!g) throw new Error(tr("No goal {0}", { 0: id }));
    return g;
  }
  mustStory(id: string) {
    const s = this.store.stories.get(id);
    if (!s) throw new Error(tr("No story {0}", { 0: id }));
    return s;
  }
  storiesOf(goal: string) {
    return [...this.store.stories.values()].filter((s) => s.goal === goal);
  }
  /** The user cancelled or skipped it (or removed it) while an agent was on it. */
  private stopped(id: string) {
    const st = this.store.stories.get(id)?.status;
    return st === undefined || st === "cancelled" || st === "skipped";
  }
  isStoryActive(id: string) {
    return [...this.active.values()].some((a) => a.story === id);
  }
  /** Slots in use: running sessions plus ones picked but not started yet (no overbooking). */
  private peerLoad(peerId: string) {
    return [...this.active.values()].filter((a) => a.run.peer === peerId).length + (this.reserved.get(peerId) ?? 0);
  }
  private reserved = new Map<string, number>();
  /** Hold one of a peer's slots until its session starts (or the caller gives up). */
  private reserve(peerId: string) {
    this.reserved.set(peerId, (this.reserved.get(peerId) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.reserved.set(peerId, Math.max(0, (this.reserved.get(peerId) ?? 1) - 1));
    };
  }

  private async isGit(path: string) {
    let v = this.gitCache.get(path);
    if (v === undefined) {
      v = await ws.isGitRepo(path);
      this.gitCache.set(path, v);
    }
    return v;
  }

  private addApproval(a: Omit<PendingApproval, "id" | "createdAt">): PendingApproval {
    const ap: PendingApproval = { ...a, id: this.store.nextId("A"), createdAt: now() };
    this.store.put("approvals", ap);
    notify(tr("Agents need you"), ap.title);
    return ap;
  }

  /** Can this runtime use rainterm's terminals? (built-in always; ACP agents through the MCP server) */
  private hasTerminals(rt: RuntimeConfig) {
    return rt.kind === "rainterm" || useApp.getState().settings.mcp.enabled;
  }

  /** Peer matching (PLAN.md §8.3). */
  matchPeer(
    roleId: string,
    minTier: Tier,
    opts: { story?: Story; exclude?: string[]; needCapacity?: boolean; reserve?: boolean } = {},
  ): { peer?: PeerConfig; reason?: string; busy?: boolean; release?: () => void } {
    const role = this.role(roleId);
    const tryRoles = [roleId, ...(role?.parent ? [role.parent] : [])];
    const goal = opts.story ? this.store.goals.get(opts.story.goal) : undefined;
    for (const rid of tryRoles) {
      const r = this.role(rid);
      let cands = this.config.peers.filter((p) => p.enabled !== false && p.roles.includes(rid));
      if (!cands.length) continue;
      cands = cands.filter((p) => {
        const rt = this.runtime(p.runtime);
        if (!rt || rt.enabled === false) return false;
        if (this.store.probes.get(rt.id)?.ok === false) return false;
        // local folders never leave this computer
        if (rt.remote && goal?.workspace) return false;
        if (r?.permissionCeiling.terminals && !this.hasTerminals(rt)) return false;
        return true;
      });
      if (!cands.length) return { reason: tr("No available “{0}” agent can take this", { 0: rid }) };
      const qualified = cands.filter((p) => tierIdx(p.tier) >= tierIdx(minTier) && !(opts.story && opts.story.risk !== "read" && p.tier === "L1"));
      if (!qualified.length) return { reason: tr("No “{0}” agent at {1} or above", { 0: rid, 1: tierLabel(minTier) }) };
      // only the lowest level that can take it: busy agents there mean waiting, not a stronger agent
      const level = Math.min(...qualified.map((p) => tierIdx(p.tier)));
      const sameLevel = qualified.filter((p) => tierIdx(p.tier) === level);
      let pool = sameLevel.filter((p) => !(opts.exclude ?? []).includes(p.id));
      if (!pool.length) pool = sameLevel;
      if (opts.story?.pinnedPeer) {
        const pinned = pool.find((p) => p.id === opts.story!.pinnedPeer);
        if (pinned) pool = [pinned];
      }
      const free = opts.needCapacity === false ? pool : pool.filter((p) => this.peerLoad(p.id) < p.maxConcurrent);
      if (!free.length) return { reason: tr("All “{0}” agents are busy", { 0: rid }), busy: true };
      const sameFeature = new Set(
        opts.story ? this.storiesOf(opts.story.goal).filter((s) => s.feature === opts.story!.feature).flatMap((s) => s.attempts.map((a) => a.peer)) : [],
      );
      free.sort(
        (a, b) =>
          tierIdx(a.tier) - tierIdx(b.tier) ||
          Number(sameFeature.has(b.id)) - Number(sameFeature.has(a.id)) ||
          (b.priority ?? 0) - (a.priority ?? 0) ||
          this.peerLoad(a.id) / a.maxConcurrent - this.peerLoad(b.id) / b.maxConcurrent,
      );
      return { peer: free[0], release: opts.reserve ? this.reserve(free[0].id) : undefined };
    }
    return { reason: tr("No agent has the “{0}” role", { 0: roleId }) };
  }

  // ------------------------------------------------------------------ scheduler

  private ticking = false;
  async tick() {
    if (this.ticking || !this.started) return;
    this.ticking = true;
    try {
      for (const s of this.store.stories.values()) {
        if (s.status !== "blocked") continue;
        const deps = s.dependsOn.map((d) => this.store.stories.get(d));
        if (deps.every((d) => isSettled(d?.status))) {
          s.status = "ready";
          s.blockedReason = undefined;
          s.updatedAt = now();
          this.store.put("stories", s);
        } else {
          const bad = deps.find((d) => d && ["failed", "needs_human", "needs_split", "cancelled"].includes(d.status));
          const reason = bad
            ? tr("Earlier task “{0}”: {1}", { 0: bad.title, 1: tr(STATUS_LABEL[bad.status]) })
            : tr("Waiting for {0}", {
                0: deps
                  .filter((d) => !isSettled(d?.status))
                  .map((d) => `“${d?.title ?? "?"}”`)
                  .join(", "),
              });
          if (s.blockedReason !== reason) {
            s.blockedReason = reason;
            this.store.put("stories", s);
          }
        }
      }
      this.updateGoalAttention();
      if (this.paused) return;
      const limit = this.config.limits.dailyCostUsd;
      if (limit && this.costToday() >= limit) {
        this.paused = true;
        this.sync();
        notify(tr("Agents paused"), tr("Today's spend reached the limit (${0}).", { 0: limit }));
        return;
      }
      for (const g of this.store.goals.values()) {
        if (g.status !== "planning" || this.planning.has(g.id)) continue;
        void this.planGoal(g);
      }
      const ready = [...this.store.stories.values()]
        .filter((s) => s.status === "ready" && !this.isStoryActive(s.id))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const s of ready) {
        const g = this.store.goals.get(s.goal);
        if (!g || g.status !== "active") continue;
        // plain folders can't be branched: one writer at a time
        if (
          g.workspace &&
          !this.gitCache.get(g.workspace) &&
          s.risk !== "read" &&
          [...this.active.values()].some((a) => a.story && this.store.stories.get(a.story)?.goal === g.id && this.store.stories.get(a.story)?.risk !== "read")
        )
          continue;
        const failures = s.attempts.filter((a) => (a.outcome && a.outcome !== "done") || a.verify?.pass === false).length;
        // one tier up per failure after the first, never above the highest that exists
        let tier = bumpTier(s.minTier, Math.max(0, failures - 1));
        while (tierIdx(tier) > tierIdx(s.minTier) && !this.matchPeer(s.role, tier, { story: s, needCapacity: false }).peer) tier = bumpTier(tier, -1);
        const lastPeer = s.attempts.at(-1)?.peer;
        const m = this.matchPeer(s.role, tier, { story: s, exclude: failures && lastPeer ? [lastPeer] : [], reserve: true });
        if (!m.peer) {
          if (s.blockedReason !== m.reason) {
            s.blockedReason = m.reason;
            this.store.put("stories", s);
          }
          continue;
        }
        void this.workStory(s, m.peer, tier, m.release!);
      }
    } finally {
      this.ticking = false;
    }
  }

  /** A goal whose stories are all stuck needs you. */
  private updateGoalAttention() {
    for (const g of this.store.goals.values()) {
      if (g.status !== "active") continue;
      const ss = this.storiesOf(g.id).filter((s) => s.status !== "cancelled");
      if (!ss.length) continue;
      const stuck = ss.filter((s) => ["needs_human", "needs_split", "failed"].includes(s.status));
      const moving = ss.some((s) => ["ready", "claimed", "running", "verifying", "draft"].includes(s.status));
      if (stuck.length && !moving && !ss.some((s) => s.status === "blocked" && !s.dependsOn.some((d) => stuck.some((x) => x.id === d)))) {
        g.status = "needs_human";
        g.note = stuck.map((s) => `“${s.title}”: ${s.blockedReason ?? tr(STATUS_LABEL[s.status])}`).join("\n");
        g.updatedAt = now();
        this.store.put("goals", g);
        notify(tr("A goal needs you"), shortName(g.text, 80));
      }
    }
  }

  // ------------------------------------------------------------------ agent runs

  private pushEvent(run: AgentRun, e: AgentEvent) {
    this.store.appendRunEvent(run.id, e);
    const a = this.active.get(run.id);
    if (a) {
      const line =
        e.t === "tool" && e.status !== "completed" && e.status !== "failed"
          ? null
          : e.t === "tool"
            ? `tool ${e.status}: ${e.title}${e.detail ? ` — ${e.detail.replace(/\s+/g, " ").slice(0, 160)}` : ""}`
            : e.t === "text"
              ? `says: ${e.text.replace(/\s+/g, " ").slice(0, 200)}`
              : e.t === "error"
                ? `error: ${e.message.slice(0, 200)}`
                : null;
      if (line) {
        a.recent.push(line);
        if (a.recent.length > 60) a.recent.splice(0, a.recent.length - 60);
        a.sinceCheck++;
      }
    }
    let changed = false;
    if (e.t === "usage") {
      run.usage = { ...run.usage, ...Object.fromEntries(Object.entries(e.usage).filter(([, v]) => v !== undefined)) };
      changed = true;
    }
    const act =
      e.t === "tool"
        ? e.title
        : e.t === "text"
          ? e.text.trim().split("\n").pop()?.slice(0, 160)
          : e.t === "thinking"
            ? tr("Thinking…")
            : undefined;
    if (act && act !== run.activity) {
      run.activity = act;
      changed = true;
    }
    if (changed) this.throttledPut(run);
  }

  private putTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private throttledPut(run: AgentRun) {
    if (this.putTimers.has(run.id)) return;
    this.putTimers.set(
      run.id,
      setTimeout(() => {
        this.putTimers.delete(run.id);
        this.store.put("runs", run);
      }, 400),
    );
  }

  private terminalMode(): AgentAutonomy {
    return this.config.autonomy === "cautious" ? "confirm" : "auto";
  }

  // biome-ignore lint/suspicious/noExplicitAny: ACP tool call payload
  private async permission(run: AgentRun, toolCall: any, ceiling: PermissionCeiling, roots: string[]): Promise<boolean> {
    const d = decide({ toolCall, ceiling, autonomy: this.config.autonomy, roots });
    const id = String(toolCall?.toolCallId ?? "");
    const title = String(toolCall?.title ?? toolCall?.kind ?? "tool");
    if (d.decision !== "ask") {
      this.pushEvent(run, { t: "permission", id, title, decision: d.decision, reason: d.reason });
      return d.decision === "allow";
    }
    this.pushEvent(run, { t: "permission", id, title, decision: "pending_human", reason: d.reason });
    const a = this.active.get(run.id);
    const ap = this.addApproval({ kind: "permission", subject: a?.story ?? run.subject, run: run.id, title: `${run.peer}: ${title}`, detail: d.reason });
    run.status = "waiting_permission";
    this.store.put("runs", run);
    const allow = await new Promise<boolean>((res) => this.waiters.set(ap.id, res));
    if (run.status === "waiting_permission") run.status = "running";
    this.store.put("runs", run);
    this.pushEvent(run, { t: "permission", id, title, decision: allow ? "allow" : "deny", reason: tr("you") });
    return allow;
  }

  private async runAgent<T>(p: {
    peer: PeerConfig;
    purpose: RunPurpose;
    subject: string;
    story?: string;
    cwd: string;
    prompt: string;
    role: RoleDef;
    timeoutMin: number;
    /** Reservation from matchPeer, released once this session counts as running. */
    release?: () => void;
    /** What's wrong with the parsed JSON (null = fine); the agent gets to fix it. */
    validate?: (json: T) => string | null;
    /** false: a plain answer is expected (no JSON block). */
    expectJson?: boolean;
  }): Promise<{ run: AgentRun; text: string; prose: string; json?: T; error?: string }> {
    const rt = this.runtime(p.peer.runtime)!;
    const run: AgentRun = { id: this.store.nextId("R"), peer: p.peer.id, purpose: p.purpose, subject: p.story ?? p.subject, status: "starting", startedAt: now() };
    this.store.put("runs", run);
    const active: ActiveRun = { run, story: p.story, recent: [], sinceCheck: 0, checkedAt: Date.now(), corrections: 0 };
    this.active.set(run.id, active);
    p.release?.();
    this.sync();
    const ceiling = p.role.permissionCeiling;
    const cwd = rt.remote ? (rt.remote.workdir || "/tmp") : p.cwd;
    const session = createSession({
      runtime: rt,
      peer: p.peer,
      cwd,
      ceiling,
      terminalMode: this.terminalMode(),
      onEvent: (e) => this.pushEvent(run, e),
      onPermission: (tc) => this.permission(run, tc, ceiling, [cwd]),
    });
    active.session = session;
    let text = "";
    let prose = "";
    let json: T | undefined;
    let error: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, rej) => {
        timer = setTimeout(() => {
          void session.cancel();
          rej(new Error(tr("timed out after {0} min", { 0: p.timeoutMin })));
        }, p.timeoutMin * 60_000);
      });
      await Promise.race([session.start(), timeout]);
      run.status = "running";
      this.store.put("runs", run);
      let r1 = await Promise.race([session.prompt(p.prompt), timeout]);
      text = r1.text;
      // someone stepped in (the user, or the supervisor): the turn was interrupted to say it
      for (let n = 0; active.pending?.length && !active.cancelled && n < 8; n++) {
        const msgs = active.pending.splice(0);
        const said = msgs
          .map((m) => (m.from === "user" ? `Message from the user: ${m.text}` : `Note from your supervisor: ${m.text}`))
          .join("\n\n");
        r1 = await Promise.race([
          session.prompt(`${said}\n\nTake this into account and continue the task. When you are finished, reply as originally asked (the answer for the user, then the JSON block).`),
          timeout,
        ]);
        text += `\n${r1.text}`;
      }
      prose = proseOnly(r1.final ?? r1.text);
      json = p.expectJson === false ? undefined : extractJson<T>(text);
      let problem = json ? (p.validate?.(json) ?? null) : null;
      const wantJson = p.expectJson !== false;
      // not in the required format: ask again (a few rounds), saying what was wrong
      for (let round = 0; wantJson && round < 3 && (!json || problem) && !active.cancelled && r1.stopReason !== "cancelled"; round++) {
        const ask = json ? `${JSON_FIX}\n${problem}` : JSON_REMINDER;
        this.pushEvent(run, { t: "stderr", text: tr("Reply not in the required format — asking again ({0}/3)", { 0: round + 1 }) });
        const r = await Promise.race([session.prompt(ask), timeout]);
        text += `\n${r.text}`;
        if (!prose) prose = proseOnly(r.final ?? r.text);
        json = extractJson<T>(r.text) ?? json;
        problem = json ? (p.validate?.(json) ?? null) : null;
      }
      if (active.cancelled) error = "cancelled";
      else if (!json && wantJson) error = tr("the agent did not return the required JSON");
      else if (problem) error = tr("the agent's reply is incomplete: {0}", { 0: problem });
    } catch (e) {
      error = active.cancelled ? "cancelled" : e instanceof Error ? e.message : String(e);
      this.pushEvent(run, { t: "error", message: error });
      if (!active.cancelled && /authenticat|not logged in|login|api key/i.test(error)) {
        // out of rotation until probed again (after logging in)
        const pr = this.store.probes.get(rt.id);
        this.store.putProbe({
          ...(pr ?? { runtime: rt.id, models: [], efforts: [] }),
          runtime: rt.id,
          ok: false,
          error: tr("Not signed in — sign in, then probe it again in Agents settings: {0}", { 0: error }),
          probedAt: now(),
        });
      }
    } finally {
      clearTimeout(timer);
      session.close();
      this.active.delete(run.id);
      clearTimeout(this.putTimers.get(run.id));
      this.putTimers.delete(run.id);
      run.status = error ? (active.cancelled ? "cancelled" : "failed") : "done";
      run.error = error;
      run.endedAt = now();
      run.activity = undefined;
      this.store.put("runs", run);
      this.pushEvent(run, { t: "end", stopReason: run.status });
      this.sync();
      setTimeout(() => void this.tick(), 50);
    }
    return { run, text, prose, json, error };
  }

  // ------------------------------------------------------------------ planning

  private machines() {
    const st = useApp.getState();
    const hosts = st.profiles
      .filter((p) => p.kind === "ssh")
      .map((p) => (p.kind === "ssh" ? `- ${p.name} (${p.user}@${p.host}${p.group ? `, group ${p.group}` : ""})` : ""))
      .slice(0, 60);
    const open = Object.values(st.panes)
      .filter((p) => p.session)
      .map((p) => `- ${p.title} [${p.kind}${p.kind === "ssh" ? ` ${p.subtitle}` : ""}, ${p.status}]`);
    return `Saved SSH hosts:\n${hosts.join("\n") || "- (none)"}\nOpen terminals:\n${open.join("\n") || "- (none)"}`;
  }

  private async planGoal(g: Goal, feedback?: string): Promise<void> {
    this.planning.add(g.id);
    let releasePlanner: (() => void) | undefined;
    try {
      const m = this.matchPeer("plan", "L3", { reserve: true });
      const alt = m.peer ? m : this.matchPeer("plan", "L1", { reserve: true });
      const pick = alt.peer ? alt : this.matchPeer("analyze", "L2", { reserve: true });
      const planner = pick.peer;
      releasePlanner = pick.release;
      if (!planner) {
        if (m.busy || this.matchPeer("plan", "L1", { needCapacity: false }).peer) return; // busy: next tick
        g.status = "needs_human";
        g.note = tr("Can't plan: {0}. Give some agent the “plan” role in Agents settings (and check its runtime works).", { 0: m.reason ?? "" });
        this.store.put("goals", g);
        return;
      }
      const isGit = g.workspace ? await this.isGit(g.workspace) : false;
      const cwd = g.workspace ?? join(await agentsHome(), "scratch", g.id);
      await ipc.fsMkdir({ kind: "local" }, cwd).catch(() => {});
      const listing = g.workspace ? await ws.topLevelListing(g.workspace) : "";
      const prompt = planPrompt({
        goal: g,
        workspace: g.workspace ? { path: g.workspace, type: isGit ? "git repository" : "plain folder", listing } : undefined,
        roles: this.roles(),
        peers: this.config.peers,
        machines: this.machines(),
        feedback,
        knowledge: await knowledgeFor([g.text, ...g.messages.map((m) => m.text)].join("\n"), { budget: 2500, extract: this.extractor() }),
      });
      // biome-ignore lint/suspicious/noExplicitAny: parsed plan
      const out = await this.runAgent<any>({
        peer: planner,
        purpose: "plan",
        subject: g.id,
        cwd,
        prompt,
        role: this.role("plan")!,
        timeoutMin: 20,
        release: releasePlanner,
        validate: (j) =>
          !Array.isArray(j?.features) && !Array.isArray(j?.questions)
            ? 'It needs a "features" array (or "questions" when the goal is unclear).'
            : (j.features ?? []).some((f: { stories?: unknown }) => !Array.isArray(f?.stories))
              ? 'Every feature needs a "stories" array.'
              : null,
      });
      if (this.store.goals.get(g.id)?.status !== "planning") return;
      if (out.error && this.store.probes.get(planner.runtime)?.ok === false) return; // runtime just went bad → another planner next tick
      if (out.error || !out.json) {
        g.status = "needs_human";
        g.note = tr("Planning failed: {0}", { 0: out.error ?? tr("no output") });
        this.store.put("goals", g);
        return;
      }
      const problems = this.validatePlan(out.json);
      if (problems.length && !feedback) {
        this.planning.delete(g.id);
        return this.planGoal(g, problems.join("\n"));
      }
      if (problems.length) {
        g.status = "needs_human";
        g.note = tr("The plan isn't usable: {0}", { 0: problems.join("; ") });
        this.store.put("goals", g);
        return;
      }
      // biome-ignore lint/suspicious/noExplicitAny: parsed plan
      const feats: any[] = out.json.features ?? [];
      if (!feats.length) {
        g.status = "needs_human";
        g.note = (out.json.questions ?? []).length
          ? `${tr("Needs more information:")}\n${out.json.questions.map((q: string) => `• ${q}`).join("\n")}`
          : tr("The planner returned no tasks.");
        this.store.put("goals", g);
        return;
      }
      this.materializePlan(g, feats);
    } finally {
      releasePlanner?.();
      this.planning.delete(g.id);
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: parsed plan
  private validatePlan(plan: any): string[] {
    const p: string[] = [];
    const roleIds = new Set(this.roles().map((r) => r.id));
    const keys = new Set<string>();
    for (const f of plan?.features ?? []) for (const s of f.stories ?? []) keys.add(s.key);
    for (const f of plan?.features ?? [])
      for (const s of f.stories ?? []) {
        if (!s.key || !s.title || !(s.instructions || s.objective)) p.push(`story ${s.key ?? "?"} is missing key/title/objective`);
        if (!roleIds.has(s.role)) p.push(`story ${s.key}: role "${s.role}" doesn't exist; choose from ${[...roleIds].join(", ")}`);
        if (s.minTier && !TIERS.includes(s.minTier)) p.push(`story ${s.key}: minTier "${s.minTier}" is invalid`);
        for (const d of s.dependsOn ?? []) if (!keys.has(d)) p.push(`story ${s.key} depends on unknown ${d}`);
        if (roleIds.has(s.role) && !this.matchPeer(s.role, TIERS.includes(s.minTier) ? s.minTier : "L2", { needCapacity: false }).peer)
          p.push(`story ${s.key} needs ${s.role}@${s.minTier}, but no agent in the pool qualifies; lower the tier or use another role`);
      }
    const deps = new Map<string, string[]>();
    for (const f of plan?.features ?? []) for (const s of f.stories ?? []) deps.set(s.key, s.dependsOn ?? []);
    const seen = new Set<string>();
    const stack = new Set<string>();
    const visit = (k: string): boolean => {
      if (stack.has(k)) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      stack.add(k);
      const c = (deps.get(k) ?? []).some(visit);
      stack.delete(k);
      return c;
    };
    if ([...deps.keys()].some(visit)) p.push("dependencies form a cycle");
    return p;
  }

  // biome-ignore lint/suspicious/noExplicitAny: parsed plan
  private materializePlan(g: Goal, feats: any[]) {
    const cautious = this.config.autonomy === "cautious";
    const keyToId = new Map<string, string>();
    const created: Story[] = [];
    for (const f of feats) {
      const fe: Feature = {
        id: this.store.nextId("FE"),
        goal: g.id,
        title: String(f.title ?? "Untitled"),
        objective: String(f.objective ?? ""),
        constraints: (f.constraints ?? []).map(String),
        brief: [],
        status: "ready",
        approval: cautious ? "pending" : "not_required",
        createdAt: now(),
      };
      this.store.put("features", fe);
      for (const s of f.stories ?? []) {
        const id = this.store.nextId("US");
        keyToId.set(s.key, id);
        const acceptance: Check[] = (s.acceptance ?? [])
          // biome-ignore lint/suspicious/noExplicitAny: parsed plan
          .filter((a: any) => a?.spec)
          // biome-ignore lint/suspicious/noExplicitAny: parsed plan
          .map((a: any) => ({ kind: ["command", "file_exists", "llm_judge"].includes(a.kind) ? a.kind : "llm_judge", spec: String(a.spec) }));
        created.push({
          id,
          feature: fe.id,
          goal: g.id,
          title: String(s.title),
          instructions: String(s.instructions ?? ""),
          objective: s.objective ? String(s.objective) : undefined,
          steps: Array.isArray(s.steps) ? s.steps.map(String).filter(Boolean) : undefined,
          deliverables: Array.isArray(s.deliverables) ? s.deliverables.map(String).filter(Boolean) : undefined,
          acceptance,
          dependsOn: (s.dependsOn ?? []).map(String),
          role: s.role,
          minTier: TIERS.includes(s.minTier) ? s.minTier : "L2",
          risk: ["read", "change", "destructive"].includes(s.risk) ? s.risk : "change",
          budget: { attempts: 3, wallclockMin: 30 },
          status: "draft",
          attempts: [],
          createdAt: now(),
          updatedAt: now(),
        });
      }
    }
    for (const st of created) {
      st.dependsOn = st.dependsOn.map((k) => keyToId.get(k) ?? k);
      st.status = cautious || st.risk === "destructive" ? "draft" : st.dependsOn.length ? "blocked" : "ready";
      this.store.put("stories", st);
    }
    g.status = "active";
    g.note = undefined;
    g.updatedAt = now();
    this.store.put("goals", g);
    if (cautious) this.addApproval({ kind: "plan", subject: g.id, title: tr("Approve the plan for “{0}”", { 0: shortName(g.text, 40) }), detail: tr("{0} features, {1} stories", { 0: feats.length, 1: created.length }) });
    for (const st of created)
      if (!cautious && st.risk === "destructive") this.addApproval({ kind: "story", subject: st.id, title: tr("Approve the risky task “{0}”", { 0: st.title }), detail: shortName(g.text, 60) });
  }

  // ------------------------------------------------------------------ work + verify

  private async prepareCwd(g: Goal, s: Story): Promise<{ cwd: string; git: boolean }> {
    if (g.workspace && (await this.isGit(g.workspace))) return { cwd: await ws.createStoryWorktree(g.workspace, g.id, s.id), git: true };
    if (g.workspace) return { cwd: g.workspace, git: false };
    const dir = join(await agentsHome(), "scratch", g.id); // shared by the goal's stories
    await ipc.fsMkdir({ kind: "local" }, dir).catch(() => {});
    return { cwd: dir, git: false };
  }

  private async workStory(s: Story, peer: PeerConfig, tier: Tier, release: () => void) {
    const g = this.mustGoal(s.goal);
    const f = this.store.features.get(s.feature)!;
    const baseRole = this.role(s.role) ?? this.role("build")!;
    // no workspace → the scratch folder is the goal's own; any role may write notes there
    const role: RoleDef = g.workspace
      ? baseRole
      : { ...baseRole, permissionCeiling: { ...baseRole.permissionCeiling, fs: baseRole.permissionCeiling.fs === "none" ? "none" : "workspace" } };
    const canWrite = role.permissionCeiling.fs === "workspace" || role.permissionCeiling.fs === "any";
    s.status = "claimed";
    s.blockedReason = undefined;
    s.updatedAt = now();
    const attempt: Story["attempts"][number] = { run: "", peer: peer.id, tier };
    const lastFailure = (() => {
      const a = s.attempts.at(-1);
      if (!a) return undefined;
      return a.verify && !a.verify.pass ? `Verifier rejected: ${a.verify.reason}` : a.error;
    })();
    s.attempts.push(attempt);
    this.store.put("stories", s);
    let cwd: string;
    let isGit: boolean;
    try {
      ({ cwd, git: isGit } = await this.prepareCwd(g, s));
    } catch (e) {
      release();
      attempt.outcome = "error";
      attempt.error = `workspace: ${(e as Error).message}`;
      return this.afterFailure(s, attempt.error);
    }
    const depHandoffs = s.dependsOn
      .map((d) => this.store.stories.get(d))
      .filter((d): d is Story => !!d)
      .map((d) => {
        if (d.status === "skipped")
          return `### ${d.id} ${d.title}\nSKIPPED by the user — it was not done. The user's note: ${d.skipNote ?? "(none)"}\nWork with that: don't assume its results exist.`;
        const h = d.handoff;
        return `### ${d.id} ${d.title}\n${h?.summary ?? ""}${h?.changes?.length ? `\nChanges:\n${h.changes.map((c) => `- ${c.resource}: ${c.what}`).join("\n")}` : ""}${h?.decisions?.length ? `\nDecisions:\n${h.decisions.map((x) => `- ${x.text} (${x.why})`).join("\n")}` : ""}${h?.findings?.length ? `\nFindings:\n${h.findings.map((x) => `- ${x.claim} [${x.source}]`).join("\n")}` : ""}`;
      });
    s.status = "running";
    this.store.put("stories", s);
    const out = await this.runAgent<Handoff>({
      peer,
      purpose: "work",
      release,
      subject: s.id,
      story: s.id,
      cwd,
      role,
      timeoutMin: s.budget.wallclockMin,
      prompt: workPrompt({
        story: s,
        feature: f,
        role,
        cwd,
        depHandoffs,
        lastFailure,
        isGit,
        knowledge: await knowledgeFor([s.title, s.objective ?? "", ...(s.steps ?? []), s.instructions].join("\n"), { budget: 1800, extract: this.extractor() }),
      }),
      validate: (h) =>
        typeof h?.summary !== "string" || !h.summary.trim()
          ? 'The handoff needs a non-empty "summary": the result in 1-3 sentences.'
          : h.outcome && !["done", "needs_split", "needs_info", "failed"].includes(h.outcome)
            ? '"outcome" must be one of "done", "needs_split", "needs_info", "failed".'
            : null,
    });
    attempt.run = out.run.id;
    if (this.stopped(s.id)) {
      // keep the user's status (cancelled / skipped); just record how the attempt ended
      const cur = this.store.stories.get(s.id);
      if (cur) {
        attempt.outcome = "error";
        attempt.error = cur.status;
        this.store.put("stories", { ...s, status: cur.status, skipNote: cur.skipNote });
      }
      return;
    }
    if (out.error && this.store.probes.get(peer.runtime)?.ok === false) {
      // infrastructure failure (not signed in…): don't burn an attempt
      s.attempts.pop();
      s.status = "ready";
      s.updatedAt = now();
      this.store.put("stories", s);
      return;
    }
    if (out.error || !out.json) {
      attempt.outcome = "error";
      attempt.error = out.error;
      return this.afterFailure(s, out.error ?? "no handoff");
    }
    const h = normalizeHandoff(out.json);
    s.handoff = h;
    s.output = out.prose || undefined;
    attempt.outcome = h.outcome;
    if (h.outcome === "needs_split" || h.outcome === "needs_info") {
      s.status = h.outcome === "needs_split" ? "needs_split" : "needs_human";
      s.blockedReason = h.openIssues.join("; ") || h.summary;
      s.updatedAt = now();
      this.store.put("stories", s);
      return;
    }
    if (h.outcome === "failed") {
      attempt.error = h.summary;
      return this.afterFailure(s, h.summary);
    }
    // read-only roles never commit: whatever they touched goes away with the worktree
    if (isGit && canWrite) await ws.commitAll(cwd, `${s.id}: ${s.title}`).catch(() => {});
    await this.verifyStory(s, attempt, cwd, isGit);
  }

  private async verifyStory(s: Story, attempt: Story["attempts"][number], cwd: string, isGit: boolean) {
    s.status = "verifying";
    s.updatedAt = now();
    this.store.put("stories", s);
    const lines: string[] = [];
    let cmdFailed: string | undefined;
    for (const c of s.acceptance) {
      if (c.kind === "command") {
        const r = await runShell(c.spec, cwd, 10 * 60_000);
        const tail = (r.stdout + r.stderr).trim().slice(-1500);
        lines.push(`$ ${c.spec}\nexit ${r.code}\n${tail}`);
        if (r.code !== 0 && !cmdFailed) cmdFailed = tr("Check failed: `{0}` (exit {1})", { 0: c.spec, 1: r.code }) + `\n${tail.slice(-800)}`;
      } else if (c.kind === "file_exists") {
        const ok = (await ipc.pathStat(join(cwd, c.spec))).exists;
        lines.push(`file_exists ${c.spec}: ${ok}`);
        if (!ok && !cmdFailed) cmdFailed = tr("File missing: {0}", { 0: c.spec });
      }
    }
    if (cmdFailed) {
      attempt.verify = { pass: false, reason: cmdFailed, by: "command" };
      return this.afterFailure(s, cmdFailed);
    }
    const hasCmd = s.acceptance.some((c) => c.kind !== "llm_judge");
    const needLlm = s.acceptance.some((c) => c.kind === "llm_judge") || !hasCmd;
    if (needLlm) {
      const vt: Tier = s.risk === "read" ? "L1" : attempt.tier;
      // wait for a free verifier slot (up to 20 min) rather than failing the story
      for (let i = 0; i < 600 && this.matchPeer("verify", vt, { story: s }).busy; i++) await sleep(2000);
      const vm = this.matchPeer("verify", vt, { story: s, reserve: true });
      const vpick = vm.peer ? vm : this.matchPeer("analyze", vt, { story: s, reserve: true });
      const verifier = vpick.peer;
      if (!verifier) {
        if (!hasCmd) {
          s.status = "needs_human";
          s.blockedReason = tr("No agent can verify this: {0}", { 0: this.matchPeer("verify", vt, { story: s }).reason ?? "" });
          s.updatedAt = now();
          this.store.put("stories", s);
          return;
        }
      } else {
        const diff = isGit ? await ws.storyDiff(cwd, s.goal) : undefined;
        const h = s.handoff!;
        const out = await this.runAgent<Verdict>({
          peer: verifier,
          purpose: "verify",
          release: vpick.release,
          subject: s.id,
          story: s.id,
          cwd,
          role: this.role("verify")!,
          timeoutMin: 20,
          validate: (v) => (typeof v?.pass !== "boolean" ? 'The verdict needs "pass": true or false, and a "reason".' : null),
          prompt: verifyPrompt({
            story: s,
            diff,
            checks: lines.join("\n\n"),
            changes: h.changes.map((c) => `- ${c.resource}: ${c.what}`).join("\n"),
            findings: h.findings?.map((x) => `- ${x.claim} [${x.source}]`).join("\n"),
            evidence: isGit ? undefined : h.evidence.map((e) => `- ${e}`).join("\n"),
          }),
        });
        if (out.error || !out.json) {
          attempt.verify = { pass: false, reason: tr("The verifier failed: {0}", { 0: out.error ?? "" }), by: out.run.id };
          if (this.stopped(s.id)) return;
          s.status = "needs_human";
          s.blockedReason = attempt.verify.reason;
          s.updatedAt = now();
          this.store.put("stories", s);
          return;
        }
        const v = out.json;
        attempt.verify = { pass: !!v.pass, reason: String(v.reason ?? ""), by: out.run.id };
        if (!v.pass) return this.afterFailure(s, tr("Not accepted: {0}", { 0: v.reason }));
      }
    } else attempt.verify = { pass: true, reason: tr("All checks passed"), by: "command" };

    const g = this.mustGoal(s.goal);
    if (this.stopped(s.id)) return; // skipped or cancelled while it was being checked
    if (isGit) {
      try {
        await ws.mergeStory(g.workspace!, g.id, s.id, s.title);
      } catch (e) {
        s.status = "needs_human";
        s.blockedReason = (e as Error).message;
        s.updatedAt = now();
        this.store.put("stories", s);
        return;
      }
      ws.cleanupWorktree(g.workspace!, cwd, s.id);
    }
    s.status = "done";
    s.updatedAt = now();
    s.blockedReason = undefined;
    this.store.put("stories", s);
    const f = this.store.features.get(s.feature)!;
    f.brief.push({ kind: "handoff", text: `${s.id} ${s.title}: ${s.handoff?.summary ?? ""}`, source: s.id });
    for (const d of s.handoff?.decisions ?? []) f.brief.push({ kind: "decision", text: `${d.text} (${d.why})`, source: s.id });
    this.store.put("features", f);
    await this.checkCompletion(g);
  }

  private afterFailure(s: Story, reason: string) {
    if (this.stopped(s.id)) return;
    if (s.attempts.length >= s.budget.attempts) {
      s.status = "needs_human";
      s.blockedReason = tr("Still failing after {0} attempts: {1}", { 0: s.attempts.length, 1: reason }).slice(0, 1500);
    } else {
      s.status = "ready";
      s.blockedReason = undefined;
    }
    s.updatedAt = now();
    this.store.put("stories", s);
  }

  private async checkCompletion(g: Goal) {
    const feats = [...this.store.features.values()].filter((f) => f.goal === g.id);
    for (const f of feats) {
      const ss = this.storiesOf(g.id).filter((s) => s.feature === f.id && s.status !== "cancelled");
      if (ss.length && ss.every((s) => isSettled(s.status)) && f.status !== "done") {
        f.status = "done";
        this.store.put("features", f);
      }
    }
    const allDone =
      feats.length &&
      feats.every((f) => f.status === "done" || this.storiesOf(g.id).filter((s) => s.feature === f.id).every((s) => s.status === "cancelled" || s.status === "skipped"));
    if (!allDone || g.status === "done") return;
    let approval: Omit<PendingApproval, "id" | "createdAt"> | undefined;
    if (g.workspace && (await this.isGit(g.workspace))) {
      const b = ws.integrationBranch(g.id);
      const n = await ws.pendingCommits(g.workspace, g.id);
      if (n === 0) g.note = tr("No code changes; nothing to merge");
      else if (this.config.autonomy === "hands-off") {
        try {
          g.note = tr("Merged into your branch {0}.", { 0: await ws.mergeIntoUser(g.workspace, g.id) });
        } catch (e) {
          approval = { kind: "merge", subject: g.id, title: tr("Merge the changes for “{0}” into your current branch", { 0: shortName(g.text, 40) }), detail: tr("Auto-merge failed: {0}", { 0: (e as Error).message }) };
        }
      } else
        approval = {
          kind: "merge",
          subject: g.id,
          title: tr("Merge the changes for “{0}” into your current branch", { 0: shortName(g.text, 40) }),
          detail: tr("Every task passed its checks; {0} commits are ready on branch {1}.", { 0: n, 1: b }),
        };
    }
    if (this.store.goals.get(g.id)?.status !== "active") return;
    g.status = "done";
    g.updatedAt = now();
    this.store.put("goals", g);
    notify(tr("Goal done"), shortName(g.text, 80));
    if (approval) this.addApproval(approval);
  }
}

function normalizeHandoff(j: unknown): Handoff {
  // biome-ignore lint/suspicious/noExplicitAny: parsed model output
  const o = j as any;
  // biome-ignore lint/suspicious/noExplicitAny: parsed model output
  const arr = (x: any) => (Array.isArray(x) ? x : []);
  return {
    summary: String(o?.summary ?? ""),
    // biome-ignore lint/suspicious/noExplicitAny: parsed model output
    changes: arr(o?.changes).map((c: any) => ({ resource: String(c?.resource ?? ""), what: String(c?.what ?? "") })),
    // biome-ignore lint/suspicious/noExplicitAny: parsed model output
    findings: arr(o?.findings).map((c: any) => ({ claim: String(c?.claim ?? ""), source: String(c?.source ?? "") })),
    // biome-ignore lint/suspicious/noExplicitAny: parsed model output
    decisions: arr(o?.decisions).map((c: any) => ({ text: String(c?.text ?? ""), why: String(c?.why ?? "") })),
    openIssues: arr(o?.openIssues).map(String),
    evidence: arr(o?.evidence).map(String),
    outcome: ["done", "needs_split", "needs_info", "failed"].includes(o?.outcome) ? o.outcome : "done",
  };
}

/** One engine for the whole app (kept across dev hot updates). */
export const forge: Engine = import.meta.hot?.data.forge ?? new Engine();
if (import.meta.hot) import.meta.hot.data.forge = forge;

// Dev-only handle for debugging / automated checks over CDP.
if (import.meta.env.DEV) (window as unknown as { __forge: Engine }).__forge = forge;

/** Done, or skipped by the user: the steps after it may go ahead. */
function isSettled(status: string | undefined) {
  return status === "done" || status === "skipped";
}
