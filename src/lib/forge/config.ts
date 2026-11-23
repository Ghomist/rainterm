// Agent pool defaults and roles (agent-forge PLAN.md §8–9).
import { tr } from "@/lib/i18n";
import type { ForgeConfig, PermissionCeiling, RoleDef, RuntimeConfig, RuntimeKind, Status, Tier } from "./types";

const ro: PermissionCeiling = { fs: "read", shell: "readonly", web: false, terminals: false };
const none: PermissionCeiling = { fs: "none", shell: "none", web: false, terminals: false };

/** Role names and descriptions are English source strings (shown through tr()). */
export const PRESET_ROLES: RoleDef[] = [
  {
    id: "plan",
    name: "Plan",
    kind: "system",
    color: "#a78bfa",
    description: "Break a goal into features and stories with dependencies, acceptance checks and required positioning.",
    permissionCeiling: ro,
  },
  {
    id: "verify",
    name: "Verify",
    kind: "system",
    color: "#e879f9",
    description: "Independently check whether a story's output meets its acceptance criteria. Read-only, may run tests.",
    permissionCeiling: { fs: "read", shell: "workspace", web: false, terminals: false },
  },
  {
    id: "research",
    name: "Research",
    kind: "preset",
    color: "#38bdf8",
    description: "Gather facts: read code and docs, search the web, inspect logs, run read-only commands. Changes nothing.",
    permissionCeiling: { ...ro, web: true },
  },
  {
    id: "analyze",
    name: "Analyze",
    kind: "preset",
    color: "#fbbf24",
    description: "Reason over known information: root-cause, compare options, assess risk, produce a design. Changes nothing.",
    permissionCeiling: ro,
  },
  {
    id: "build",
    name: "Build",
    kind: "preset",
    color: "#34d399",
    description: "Write code, configs, tests and docs inside the workspace.",
    permissionCeiling: { fs: "workspace", shell: "workspace", web: true, terminals: false },
  },
  {
    id: "operate",
    name: "Operate",
    kind: "preset",
    color: "#fb923c",
    description:
      "Work on real machines through rainterm's terminals and saved SSH hosts: inspect, diagnose, run commands (risky ones need approval).",
    permissionCeiling: { fs: "read", shell: "readonly", web: true, terminals: true },
  },
];

export const NO_TOOLS = none;

export const RUNTIME_KINDS: { kind: RuntimeKind; label: string }[] = [
  { kind: "rainterm", label: "rainterm model" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "codex", label: "Codex" },
  { kind: "opencode", label: "opencode" },
  { kind: "pi", label: "pi" },
  { kind: "custom", label: "Custom ACP agent" },
];

export const runtimeLabel = (k: RuntimeKind) => RUNTIME_KINDS.find((r) => r.kind === k)?.label ?? k;

/** How each kind is launched over ACP (first run of an npx one downloads the adapter). */
export function acpCommand(rt: RuntimeConfig): string[] | undefined {
  if (rt.command?.length) return rt.command;
  switch (rt.kind) {
    case "claude-code":
      return ["npx", "-y", "@agentclientprotocol/claude-agent-acp"];
    case "codex":
      return ["npx", "-y", "@zed-industries/codex-acp"];
    case "opencode":
      return ["opencode", "acp"];
    case "pi":
      return ["npx", "-y", "pi-acp"];
    default:
      return undefined;
  }
}

export function defaultConfig(): ForgeConfig {
  return {
    runtimes: [
      { id: "rainterm", kind: "rainterm" },
      { id: "claude", kind: "claude-code" },
      { id: "codex", kind: "codex" },
      { id: "opencode", kind: "opencode" },
      { id: "pi", kind: "pi" },
    ],
    peers: [],
    roles: [],
    autonomy: "balanced",
    limits: { maxConcurrentRuns: 4, dailyCostUsd: 30 },
    workspaces: [],
  };
}

/** Preset roles merged with user overrides and custom roles. */
export function effectiveRoles(c: ForgeConfig): RoleDef[] {
  const out = new Map<string, RoleDef>();
  for (const r of PRESET_ROLES) out.set(r.id, { ...r, enabled: true });
  for (const r of c.roles) {
    const base = out.get(r.id) ?? (r.parent ? out.get(r.parent) : undefined);
    const preset = PRESET_ROLES.find((p) => p.id === r.id);
    out.set(r.id, {
      ...(base ?? { permissionCeiling: ro, color: "#a1a1aa" }),
      ...r,
      kind: preset ? preset.kind : "custom",
      permissionCeiling: r.permissionCeiling ?? base?.permissionCeiling ?? ro,
      enabled: r.enabled ?? true,
    } as RoleDef);
  }
  return [...out.values()];
}

// ------------------------------------------------------------------ words people read

/** Tiers in plain words (the L1–L4 codes are for the planner). */
export const TIER_LABEL: Record<Tier, string> = { L1: "Lightweight", L2: "Standard", L3: "Senior", L4: "Expert" };
export const tierLabel = (t: Tier) => tr(TIER_LABEL[t] ?? t);

export const TIER_HINT: Record<Tier, string> = {
  L1: "Light: lookups, summaries; never changes",
  L2: "Standard: routine changes and investigation",
  L3: "Senior: cross-module work, hard debugging",
  L4: "Expert: planning, architecture, arbitration",
};

export const STATUS_LABEL: Record<Status, string> = {
  draft: "Waiting for OK",
  ready: "Ready",
  claimed: "Starting",
  running: "Working",
  verifying: "Verifying",
  done: "Done",
  failed: "Failed",
  blocked: "Waiting",
  needs_human: "Needs you",
  needs_split: "Too big",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

/** Long paths in text read as their last folder: "D:\Projects\tool" → "tool". */
export function shortPaths(text: string) {
  return text.replace(/(?:[a-zA-Z]:[\\/]|~[\\/]|\/(?=[\w.]))[^\s"'“”‘’，。；：、！？（）()]+/g, (p) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p);
}

/** A goal as people refer to it: the start of what they asked for. */
export function shortName(text: string, max = 24) {
  const line = shortPaths(text.split("\n")[0]).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
