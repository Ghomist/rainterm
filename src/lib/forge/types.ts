// Agents session data model: goals are planned into features (FE) and stories (US), which
// a pool of worker agents executes and an independent verifier checks. Same shapes as
// agent-forge (PLAN.md §5, §8, §9), trimmed to what rainterm uses.

export type Status =
  | "draft"
  | "ready"
  | "claimed"
  | "running"
  | "verifying"
  | "done"
  | "failed"
  | "blocked"
  | "needs_human"
  | "needs_split"
  | "cancelled"
  /** The user skipped it (with a note the next steps see). */
  | "skipped";

export type Tier = "L1" | "L2" | "L3" | "L4";
export const TIERS: Tier[] = ["L1", "L2", "L3", "L4"];
export type Risk = "read" | "change" | "destructive";
export type Autonomy = "cautious" | "balanced" | "hands-off";

export type GoalStatus = "planning" | "active" | "done" | "failed" | "cancelled" | "needs_human";

export interface Goal {
  id: string;
  text: string;
  /** Local folder the work happens in (git repo or plain folder); none = research only. */
  workspace?: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  note?: string;
  messages: { at: string; text: string }[];
  /** The final report for the user, written when the goal is done. */
  report?: string;
  /** Knowledge-base notes kept (added or updated) from this goal's results. */
  learned?: { id: string; title: string }[];
  /** 1 = urgent: its work goes ahead of everything queued (0 / unset = normal). */
  priority?: number;
  /** Why nothing is running for it right now (queued…), shown quietly; not a problem. */
  waiting?: string;
}

export interface BriefEntry {
  kind: "decision" | "contract" | "handoff" | "note";
  text: string;
  source?: string;
}

export interface Feature {
  id: string;
  goal: string;
  title: string;
  objective: string;
  constraints: string[];
  brief: BriefEntry[];
  status: Status;
  approval: "pending" | "approved" | "rejected" | "not_required";
  createdAt: string;
}

export interface Check {
  kind: "command" | "file_exists" | "llm_judge";
  spec: string;
}

export interface Attempt {
  run: string;
  peer: string;
  tier: Tier;
  outcome?: Handoff["outcome"] | "error";
  error?: string;
  verify?: { pass: boolean; reason: string; by: string };
}

export interface Story {
  id: string;
  feature: string;
  goal: string;
  title: string;
  /** One sentence: what the step achieves (newer plans). */
  objective?: string;
  steps?: string[];
  deliverables?: string[];
  instructions: string;
  acceptance: Check[];
  dependsOn: string[];
  role: string;
  minTier: Tier;
  risk: Risk;
  budget: { attempts: number; wallclockMin: number };
  status: Status;
  attempts: Attempt[];
  handoff?: Handoff;
  /** What the worker wrote for people (markdown, JSON removed). */
  output?: string;
  /** Why the user skipped it — passed on to the steps after it. */
  skipNote?: string;
  pinnedPeer?: string;
  blockedReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Handoff {
  summary: string;
  changes: { resource: string; what: string }[];
  findings?: { claim: string; source: string }[];
  decisions: { text: string; why: string }[];
  openIssues: string[];
  evidence: string[];
  outcome: "done" | "needs_split" | "needs_info" | "failed";
}

export interface Verdict {
  pass: boolean;
  reason: string;
  evidence: string[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  contextUsed?: number;
  contextSize?: number;
  costUsd?: number;
}

export type RunPurpose = "plan" | "work" | "verify" | "report" | "supervise" | "learn" | "probe";
export type RunStatus = "starting" | "running" | "waiting_permission" | "done" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  peer: string;
  purpose: RunPurpose;
  /** Goal or story id. */
  subject: string;
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  usage?: Usage;
  error?: string;
  /** Last line of what it's doing (live). */
  activity?: string;
}

export type AgentEvent =
  | { t: "start"; info?: string }
  | { t: "text"; text: string }
  | { t: "thinking"; text: string }
  | { t: "plan"; items: { content: string; status: string }[] }
  | {
      t: "tool";
      id: string;
      title: string;
      kind?: string;
      status: "pending" | "in_progress" | "completed" | "failed";
      detail?: string;
    }
  | { t: "permission"; id: string; title: string; decision: "allow" | "deny" | "pending_human"; reason?: string }
  | { t: "usage"; usage: Usage }
  | { t: "stderr"; text: string }
  /** Someone stepped in mid-run: the user, or the supervisor that keeps agents on track. */
  | { t: "note"; from: "user" | "supervisor"; text: string }
  | { t: "error"; message: string }
  | { t: "end"; stopReason?: string };

// ------------------------------------------------------------------ agent pool

/**
 * claude-code / codex / opencode / pi: launched over ACP (Agent Client Protocol).
 * custom: any ACP agent, given its command. rainterm: the model set in Settings → Agent,
 * driven directly with rainterm's own tools.
 */
export type RuntimeKind = "claude-code" | "codex" | "opencode" | "pi" | "custom" | "rainterm";

export interface RuntimeConfig {
  id: string;
  kind: RuntimeKind;
  /** Launch command (argv) overriding the default. */
  command?: string[];
  env?: Record<string, string>;
  /** Run on a saved SSH host instead of this computer. */
  remote?: { profileId: string; workdir?: string };
  enabled?: boolean;
}

export interface PeerConfig {
  id: string;
  runtime: string;
  model?: string;
  effort?: string;
  roles: string[];
  tier: Tier;
  maxConcurrent: number;
  priority?: number;
  enabled?: boolean;
}

export interface PermissionCeiling {
  fs: "none" | "read" | "workspace" | "any";
  shell: "none" | "readonly" | "workspace" | "any";
  web: boolean;
  /** May use rainterm's terminals and SSH hosts (MCP / built-in tools). */
  terminals: boolean;
}

export interface RoleDef {
  id: string;
  name: string;
  description: string;
  kind: "system" | "preset" | "custom";
  permissionCeiling: PermissionCeiling;
  systemPrompt?: string;
  parent?: string;
  color: string;
  enabled?: boolean;
}

export interface ForgeConfig {
  runtimes: RuntimeConfig[];
  peers: PeerConfig[];
  /** Custom roles and overrides of the presets. */
  roles: RoleDef[];
  autonomy: Autonomy;
  limits: { maxConcurrentRuns: number; dailyCostUsd: number };
  /** Folders used before (newest first), offered when a goal needs a workspace. */
  workspaces: string[];
  /** Check now and then that running agents still work toward their step (default on). */
  supervise?: boolean;
  /** Keep what finished goals taught in the knowledge base (default on). */
  learn?: boolean;
  /** Language agents write in: "system" (the UI language), "zh", "en", "ja"… */
  outputLanguage?: string;
}

export interface ModelOption {
  value: string;
  name: string;
  group?: string;
}

export interface RuntimeProbe {
  runtime: string;
  ok: boolean;
  version?: string;
  error?: string;
  models: ModelOption[];
  efforts: ModelOption[];
  probedAt: string;
  probing?: boolean;
}

export interface PendingApproval {
  id: string;
  kind: "permission" | "merge" | "story" | "plan";
  /** Story / goal id. */
  subject: string;
  run?: string;
  title: string;
  detail?: string;
  createdAt: string;
}

/** The conversation in an agents session: what you said and what the entry agent answered. */
export interface TimelineItem {
  id: string;
  at: string;
  from: "user" | "agent" | "system";
  text: string;
  /** A goal this message created or is about: its live card is shown under it. */
  goal?: string;
}
