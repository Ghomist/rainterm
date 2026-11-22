// Agent processes from the webview: a local child (proc_spawn) or a command on an SSH host
// (proc_spawn_remote), both line-oriented on stdout. Plus one-shot runs and small path helpers.
import { Channel, ipc, type ProcEvent, type RunOutput } from "@/lib/ipc";

export interface ChildHandlers {
  onLine(line: string): void;
  onStderr?(text: string): void;
  onExit?(code: number | null): void;
}

export class Child {
  private id: number | null = null;
  private queue: string[] = [];
  exited = false;
  exitCode: number | null = null;

  private constructor(private h: ChildHandlers) {}

  private channel() {
    const ch = new Channel<ProcEvent>();
    ch.onmessage = (e) => {
      if (e.t === "out") this.h.onLine(e.line);
      else if (e.t === "err") this.h.onStderr?.(e.text);
      else {
        this.exited = true;
        this.exitCode = e.code;
        this.h.onExit?.(e.code);
      }
    };
    return ch;
  }

  private started(id: number) {
    this.id = id;
    for (const q of this.queue.splice(0)) void ipc.procWrite(id, q).catch(() => {});
  }

  static async local(argv: string[], cwd: string | undefined, env: Record<string, string> | undefined, h: ChildHandlers) {
    const c = new Child(h);
    c.started(await ipc.procSpawn(argv, cwd ?? null, env ?? null, c.channel()));
    return c;
  }

  static async remote(sessionId: string, command: string, h: ChildHandlers) {
    const c = new Child(h);
    c.started(await ipc.procSpawnRemote(sessionId, command, c.channel()));
    return c;
  }

  write(data: string) {
    if (this.exited) return;
    if (this.id == null) this.queue.push(data);
    else void ipc.procWrite(this.id, data).catch(() => {});
  }

  closeStdin() {
    if (this.id != null && !this.exited) void ipc.procCloseStdin(this.id);
  }

  kill() {
    if (this.id != null && !this.exited) void ipc.procKill(this.id);
  }
}

export function run(
  argv: string[],
  opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {},
): Promise<RunOutput> {
  return ipc.procRun(argv, opts).catch((e) => ({ code: -1, stdout: "", stderr: String(e) }));
}

// ------------------------------------------------------------------ paths

export const isWin = navigator.userAgent.includes("Windows");

export function join(...parts: string[]) {
  const sep = isWin ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .join(sep);
}

export function basename(p: string) {
  return p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? p;
}

const norm = (p: string) => {
  const s = p.replace(/\\/g, "/").replace(/\/+$/, "");
  return isWin ? s.toLowerCase() : s;
};

/** Absolute path of `p` resolved against `root` (no `..` folding beyond the simple cases). */
export function resolvePath(root: string, p: string) {
  const abs = /^([a-zA-Z]:[\\/]|[\\/])/.test(p) ? p : `${root.replace(/[\\/]+$/, "")}/${p}`;
  const out: string[] = [];
  for (const seg of abs.replace(/\\/g, "/").split("/")) {
    if (seg === "..") out.pop();
    else if (seg !== "." && !(seg === "" && out.length > 0)) out.push(seg);
  }
  return out.join("/") || "/";
}

export function inside(root: string, p: string) {
  const r = norm(root);
  const a = norm(resolvePath(root, p));
  return a === r || a.startsWith(`${r}/`);
}

let homeDir: Promise<string> | null = null;
/** `<rainterm home>/agents` (runs/, worktrees/, scratch/ inside). */
export function agentsHome() {
  homeDir ??= ipc.agentsHome();
  return homeDir;
}

let bash: Promise<string | null> | null = null;
/** A POSIX shell for acceptance checks: Git Bash on Windows. */
export function findBash() {
  bash ??= (async () => {
    if (!isWin) return "/bin/bash";
    const cands: string[] = [];
    const r = await run(["git", "--exec-path"], { timeoutMs: 10_000 });
    if (r.code === 0) {
      // <git>/mingw64/libexec/git-core → <git>/bin/bash.exe
      const root = r.stdout.trim().replace(/[\\/]+$/, "").split(/[\\/]/).slice(0, -3).join("\\");
      cands.push(`${root}\\bin\\bash.exe`, `${root}\\usr\\bin\\bash.exe`);
    }
    cands.push("C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files (x86)\\Git\\bin\\bash.exe");
    for (const c of cands) if ((await ipc.pathStat(c)).exists) return c;
    return null;
  })();
  return bash;
}

/** Run a command line with bash (falls back to the platform shell) in `cwd`. */
export async function runShell(cmd: string, cwd: string, timeoutMs: number) {
  const b = await findBash();
  if (b) return run([b, "-c", cmd], { cwd, timeoutMs });
  return isWin ? run(["cmd", "/d", "/s", "/c", cmd], { cwd, timeoutMs }) : run(["sh", "-c", cmd], { cwd, timeoutMs });
}

export function shQuote(s: string) {
  return /^[A-Za-z0-9_/.:=@%+-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
