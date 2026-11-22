// Prompts for the planner, workers and verifier (agent-forge prompts.ts). Kept in English;
// every prompt says which language people-facing text must be in (Agents → output language).
import { languageRule } from "./llm";
import type { Feature, Goal, PeerConfig, RoleDef, Story } from "./types";

const TIER_TABLE = `| Tier | Use for |
|---|---|
| L1 | Clear rules, easy to verify, cheap to get wrong: classification, summaries, simple lookups. Never for changes. |
| L2 | Routine work: single-module change, writing tests, step-by-step investigation. (default) |
| L3 | Cross-module change, hard debugging, design work. |
| L4 | Architecture decisions, arbitration. Use sparingly. |`;

export function planPrompt(args: {
  goal: Goal;
  workspace?: { path: string; type: string; listing: string };
  roles: RoleDef[];
  peers: PeerConfig[];
  machines: string;
  feedback?: string;
}) {
  const roles = args.roles
    .filter((r) => r.enabled !== false && r.kind !== "system")
    .map((r) => `- \`${r.id}\` (${r.name}): ${r.description}${r.parent ? ` [narrower version of ${r.parent}]` : ""}`)
    .join("\n");
  const pool =
    args.peers
      .filter((p) => p.enabled !== false)
      .map((p) => `- ${p.roles.join(", ")} @ ${p.tier}`)
      .join("\n") || "- (none configured)";
  const messages = args.goal.messages.length
    ? `\n## Follow-ups from the user\n${args.goal.messages.map((m) => `- ${m.text}`).join("\n")}\n`
    : "";
  return `You are the planner of a multi-agent task system inside the rainterm terminal app. You do NOT do the work yourself.
Your only job: break the goal below into Features (FE) and User Stories (US) that independent worker agents can execute.
You may read files in the working directory to understand the project, but do not modify anything.
${languageRule()}

## Goal
${args.goal.text}
${messages}
## Workspace
${
  args.workspace
    ? `Path: ${args.workspace.path} (${args.workspace.type})\nFiles:\n\`\`\`\n${args.workspace.listing}\n\`\`\``
    : "None — this goal has no project folder. All stories share one scratch directory as their working directory, so later stories can read files written by earlier ones (refer to them by plain relative names). Prefer putting conclusions in the handoff (summary/findings) rather than only in files."
}

## Machines
${args.machines}
Stories that must look at or act on these machines need the \`operate\` role: its workers use rainterm's terminals (they can open a terminal on a saved SSH host and run commands there; risky commands are confirmed by the user).

## Rules for a US (all must hold, otherwise split further)
1. One worker can finish it in one session (roughly < 30 minutes of agent work).
2. It has checkable acceptance criteria. Prefer \`command\` checks that exit 0 on success (build, typecheck, tests, grep). Commands run with \`bash -c\` in the workspace root (Git Bash on Windows): use POSIX shell syntax and keep them short. Use \`llm_judge\` only for what commands cannot check. Use \`file_exists\` for paths relative to the workspace root. Stories without a workspace, or that work on remote machines, use \`llm_judge\`.
3. It needs no human decisions mid-way.
4. It fits exactly one role from the list below.
5. Each worker starts from a fresh copy containing the merged results of the stories it depends on — declare dependencies with \`dependsOn\`. Stories without mutual dependencies run in parallel, so avoid two parallel stories editing the same file.
Workers see only their own story plus short handoffs from dependencies, so instructions must be self-contained and concrete (files, functions, interfaces, host names).

## Roles
${roles}

## Tiers (choose the minimum that will reliably succeed)
${TIER_TABLE}

## Available worker pool (role @ tier)
${pool}

## Risk
- read: changes nothing. - change: edits workspace files. - destructive: deletes data or changes real systems.
${args.feedback ? `\n## Feedback on your previous plan\n${args.feedback}\n` : ""}
## Output
Keep it small: prefer 1 feature with 1–6 stories unless the goal clearly needs more. A simple question or lookup is a single story.
If the goal is too ambiguous to plan, return no features and put your questions in \`questions\`.
End your reply with exactly one fenced JSON block:
\`\`\`json
{
  "features": [
    { "key": "F1", "title": "...", "objective": "...", "constraints": ["..."],
      "stories": [
        { "key": "S1", "title": "...", "instructions": "...",
          "acceptance": [{ "kind": "command", "spec": "npm test" }],
          "dependsOn": [], "role": "build", "minTier": "L2", "risk": "change" }
      ] }
  ],
  "questions": []
}
\`\`\``;
}

export function workPrompt(args: {
  story: Story;
  feature: Feature;
  role: RoleDef;
  cwd: string;
  depHandoffs: string[];
  lastFailure?: string;
  isGit: boolean;
}) {
  const { story: s, feature: f, role } = args;
  const brief = f.brief
    .filter((b) => b.kind !== "handoff")
    .map((b) => `- (${b.kind}) ${b.text}`)
    .join("\n");
  const readOnly = role.permissionCeiling.fs === "read" || role.permissionCeiling.fs === "none";
  return `You are a worker agent. Role: **${role.name} (${role.id})** — ${role.description}
${role.systemPrompt ? `\n${role.systemPrompt}\n` : ""}
Work only inside the current directory: ${args.cwd}
${args.isGit ? "It is an isolated git worktree; do not commit, push, or switch branches — it is committed for you." : "It is a scratch directory."}
${readOnly ? "You are READ-ONLY: do not create, edit or delete files." : ""}
${languageRule()}
${role.permissionCeiling.terminals ? "To work on machines, use rainterm's terminal tools (list_hosts, open_terminal, run_command, read_terminal). Never type passwords or secrets." : ""}

## Feature ${f.id}: ${f.title}
${f.objective}
${f.constraints.length ? `Constraints:\n${f.constraints.map((c) => `- ${c}`).join("\n")}` : ""}
${brief ? `Brief:\n${brief}` : ""}
${args.depHandoffs.length ? `\n## Handoffs from stories you depend on\n${args.depHandoffs.join("\n\n")}` : ""}

## Your story ${s.id}: ${s.title}
${s.instructions}

Do only this story. Other parts of the feature are separate stories handled by other agents — do not implement them, even if they look related.

## Acceptance (checked independently after you finish)
${s.acceptance.map((a) => `- [${a.kind}] ${a.spec}`).join("\n") || "- (none given; do what the instructions say)"}
${args.lastFailure ? `\n## Previous attempt failed\n${args.lastFailure}\nFix this.` : ""}

When finished, write a short answer for the user in plain prose (what you found or did — this is what they read), then end your reply with exactly one fenced JSON block (the handoff):
\`\`\`json
{ "summary": "the result in 1-3 sentences — for a question, the answer itself",
  "changes": [{ "resource": "path/or/thing", "what": "..." }],
  "findings": [{ "claim": "...", "source": "file:line or URL or command" }],
  "decisions": [{ "text": "...", "why": "..." }],
  "openIssues": [],
  "evidence": ["short command output excerpts"],
  "outcome": "done" }
\`\`\`
outcome: "done" | "needs_split" (too big — explain in openIssues) | "needs_info" (blocked on a human answer — put the question in openIssues) | "failed".`;
}

export function verifyPrompt(args: {
  story: Story;
  diff?: { stat: string; patch: string };
  changes: string;
  findings?: string;
  evidence?: string;
  checks: string;
}) {
  const s = args.story;
  return `You are an independent verifier. You did NOT do this work and you have no access to how it was done.
Decide whether the result meets the acceptance criteria. Be strict but fair: judge the result, not the style.
You may read files and run read-only commands or tests in the current directory. Do not modify anything.
${languageRule()}

## Story ${s.id}: ${s.title}
${s.instructions}

## Acceptance criteria
${s.acceptance.map((a) => `- [${a.kind}] ${a.spec}`).join("\n") || "- Infer from the instructions."}

## Automated check results
${args.checks || "(none)"}

${args.diff ? `## Changes (git diff against the base)\n${args.diff.stat}\n\`\`\`diff\n${args.diff.patch}\n\`\`\`` : ""}
${args.changes ? `## Declared changes\n${args.changes}` : ""}
${args.findings ? `## Findings to check (verify sources where you can)\n${args.findings}` : ""}
${args.evidence ? `## Evidence the worker reported\n${args.evidence}` : ""}

End your reply with exactly one fenced JSON block:
\`\`\`json
{ "pass": true, "reason": "1-3 sentences", "evidence": ["what you checked"] }
\`\`\``;
}

export const JSON_REMINDER =
  "Your reply did not end with a valid fenced ```json block in the required format. Reply now with ONLY that JSON block, nothing else.";

/** The last fenced JSON block (or bare JSON object) in a reply. */
// biome-ignore lint/suspicious/noExplicitAny: parsed model output
export function extractJson<T = any>(text: string): T | undefined {
  const blocks = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  for (const b of blocks.reverse()) {
    try {
      return JSON.parse(b);
    } catch {}
  }
  const i = text.indexOf("{");
  if (i >= 0) {
    try {
      return JSON.parse(text.slice(i, text.lastIndexOf("}") + 1));
    } catch {}
  }
  return undefined;
}
