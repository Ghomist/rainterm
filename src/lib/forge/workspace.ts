// Workspaces (agent-forge PLAN.md §9.7): a git worktree per story, an integration branch
// forge/<goal> per goal, merged into the user's branch only on approval.
import { ipc } from "@/lib/ipc";
import { agentsHome, basename, join, run } from "./proc";

const ID = ["-c", "user.name=rainterm-agents", "-c", "user.email=agents@rainterm.local"];

export async function git(cwd: string, ...args: string[]) {
  const r = await run(["git", ...ID, ...args], { cwd, timeoutMs: 120_000 });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout).trim().slice(0, 600)}`);
  return r.stdout;
}

export async function isGitRepo(path: string) {
  const r = await run(["git", "rev-parse", "--show-toplevel"], { cwd: path, timeoutMs: 15_000 });
  return r.code === 0;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}

async function wtRoot(repo: string, goal: string) {
  return join(await agentsHome(), "worktrees", `${basename(repo)}-${hash(repo.toLowerCase())}`, goal);
}

export const integrationBranch = (goal: string) => `forge/${goal}`;
export const storyBranch = (story: string) => `forge/${story}`;

async function branchExists(repo: string, b: string) {
  return (await run(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd: repo })).code === 0;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Best effort: an agent process that is still shutting down can keep the folder locked. */
async function removeWorktree(repo: string, dir: string, tries = 3): Promise<boolean> {
  for (let i = 0; i < tries && (await ipc.pathStat(dir)).exists; i++) {
    if (i) await sleep(1500 * i);
    await run(["git", "worktree", "remove", "--force", dir], { cwd: repo });
    if ((await ipc.pathStat(dir)).exists) await ipc.fsRemove({ kind: "local" }, [dir]).catch(() => {});
  }
  await run(["git", "worktree", "prune"], { cwd: repo });
  return !(await ipc.pathStat(dir)).exists;
}

/** forge/<goal> (from the current HEAD) with a worktree to merge stories in. */
export async function ensureIntegration(repo: string, goal: string): Promise<string> {
  const b = integrationBranch(goal);
  const dir = join(await wtRoot(repo, goal), "_integration");
  if (!(await branchExists(repo, b))) {
    const head = (await git(repo, "rev-parse", "HEAD").catch(() => "")).trim();
    if (!head) throw new Error("the repository has no commits yet; make a first commit");
    await git(repo, "branch", b, head);
  }
  if (!(await ipc.pathStat(dir)).exists) {
    await run(["git", "worktree", "prune"], { cwd: repo });
    await git(repo, "worktree", "add", dir, b);
  }
  return dir;
}

/** A fresh worktree for a story, branched from the goal's integration branch. */
export async function createStoryWorktree(repo: string, goal: string, story: string): Promise<string> {
  await ensureIntegration(repo, goal);
  let dir = join(await wtRoot(repo, goal), story);
  if (!(await removeWorktree(repo, dir))) dir = `${dir}-${Date.now().toString(36)}`;
  await git(repo, "worktree", "add", "-B", storyBranch(story), dir, integrationBranch(goal));
  return dir;
}

/** Agent-private state folders that are never committed. */
const AGENT_STATE_DIRS = [".omo", ".sisyphus", ".opencode", ".claude", ".pi", ".codex", ".agent-forge", ".aider.tags.cache.v3"];

export async function commitAll(dir: string, message: string): Promise<boolean> {
  await run(["git", "clean", "-fdq", "--", ...AGENT_STATE_DIRS], { cwd: dir, timeoutMs: 30_000 });
  await git(dir, "add", "-A", "--", ".", ...AGENT_STATE_DIRS.map((d) => `:(exclude)${d}`));
  if (!(await git(dir, "status", "--porcelain")).trim()) return false;
  await git(dir, "commit", "-q", "--no-verify", "-m", message);
  return true;
}

export async function pendingCommits(repo: string, goal: string): Promise<number> {
  const out = await git(repo, "rev-list", "--count", `HEAD..${integrationBranch(goal)}`).catch(() => "0");
  return Number(out.trim()) || 0;
}

export async function storyDiff(dir: string, goal: string, maxChars = 40_000) {
  const base = integrationBranch(goal);
  const stat = await git(dir, "diff", "--stat", `${base}...HEAD`).catch(() => "");
  let patch = await git(dir, "diff", `${base}...HEAD`).catch(() => "");
  if (patch.length > maxChars) patch = `${patch.slice(0, maxChars)}\n... [diff truncated, ${patch.length} chars total]`;
  return { stat, patch };
}

export async function mergeStory(repo: string, goal: string, story: string, title: string) {
  const dir = await ensureIntegration(repo, goal);
  const r = await run(["git", ...ID, "merge", "--no-ff", "-m", `forge: ${story} ${title}`, storyBranch(story)], {
    cwd: dir,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) {
    await run(["git", "merge", "--abort"], { cwd: dir });
    throw new Error(`merge conflict merging ${story} into ${integrationBranch(goal)}: ${(r.stdout + r.stderr).slice(0, 600)}`);
  }
}

/** Remove a finished story's worktree and branch; never throws. */
export function cleanupWorktree(repo: string, dir: string, story: string) {
  void removeWorktree(repo, dir, 5)
    .then(() => run(["git", "branch", "-D", storyBranch(story)], { cwd: repo }))
    .catch(() => {});
}

/** Merge the goal's integration branch into whatever branch the user's checkout is on. */
export async function mergeIntoUser(repo: string, goal: string): Promise<string> {
  if ((await git(repo, "status", "--porcelain", "--untracked-files=no")).trim())
    throw new Error("the working tree has uncommitted changes; commit or stash them first");
  const cur = (await git(repo, "rev-parse", "--abbrev-ref", "HEAD")).trim();
  const r = await run(["git", ...ID, "merge", "--no-ff", "-m", `forge: merge ${goal}`, integrationBranch(goal)], {
    cwd: repo,
    timeoutMs: 120_000,
  });
  if (r.code !== 0) {
    await run(["git", "merge", "--abort"], { cwd: repo });
    throw new Error(`merge failed: ${(r.stdout + r.stderr).slice(0, 600)}`);
  }
  await removeWorktree(repo, join(await wtRoot(repo, goal), "_integration"));
  return cur;
}

/** Drop the goal's worktrees and branches (after merge, or when the goal is deleted). */
export async function discardGoal(repo: string, goal: string, stories: string[] = []) {
  const root = await wtRoot(repo, goal);
  await run(["git", "worktree", "prune"], { cwd: repo });
  const list = await git(repo, "worktree", "list", "--porcelain").catch(() => "");
  for (const line of list.split("\n")) {
    const p = line.startsWith("worktree ") ? line.slice(9).trim() : "";
    if (p && p.replace(/\\/g, "/").toLowerCase().startsWith(root.replace(/\\/g, "/").toLowerCase())) await removeWorktree(repo, p);
  }
  const branches = await git(repo, "branch", "--list", "forge/*", "--format=%(refname:short)").catch(() => "");
  for (const b of branches.split("\n").map((x) => x.trim()).filter(Boolean)) {
    if (b === integrationBranch(goal) || stories.some((st) => b === storyBranch(st))) await run(["git", "branch", "-D", b], { cwd: repo });
  }
}

export async function topLevelListing(dir: string): Promise<string> {
  const r = await run(["git", "ls-files"], { cwd: dir, timeoutMs: 20_000 });
  if (r.code === 0 && r.stdout.trim()) {
    const files = r.stdout.trim().split("\n");
    const shown = files.slice(0, 150).join("\n");
    return files.length > 150 ? `${shown}\n... (${files.length} files total)` : shown;
  }
  const l = await ipc.fsList({ kind: "local" }, dir).catch(() => null);
  return l ? l.entries.slice(0, 100).map((e) => (e.kind === "dir" ? `${e.name}/` : e.name)).join("\n") : "";
}
