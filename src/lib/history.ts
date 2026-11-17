// Command history per machine + suggestion engine.
// Keys: "local:<shellId>" or "ssh:<user>@<host>:<port>". Our own history is merged
// with the shell's existing history files (imported once per key, lazily).
import { ipc } from "./ipc";

const MAX = 3000;
let own: Record<string, string[]> = {};
const imported = new Map<string, string[]>();
const importing = new Map<string, Promise<void>>();
let saveTimer: number | null = null;

export async function loadHistory() {
  own = (await ipc.storeLoad<Record<string, string[]>>("history").catch(() => null)) ?? {};
}

function scheduleSave() {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void ipc.storeSave("history", own).catch(() => {}), 1500);
}

export function addCommand(key: string, cmd: string) {
  const c = cmd.trim();
  if (!c || c.length > 500) return;
  const arr = (own[key] ??= []);
  const i = arr.lastIndexOf(c);
  if (i >= 0) arr.splice(i, 1);
  arr.push(c);
  if (arr.length > MAX) arr.splice(0, arr.length - MAX);
  scheduleSave();
}

export function removeCommand(key: string, cmd: string) {
  const arr = own[key];
  if (arr) {
    const i = arr.lastIndexOf(cmd);
    if (i >= 0) arr.splice(i, 1);
  }
  const imp = imported.get(key);
  if (imp) {
    const i = imp.lastIndexOf(cmd);
    if (i >= 0) imp.splice(i, 1);
  }
  scheduleSave();
}

/** Import the shell's own history once (local files or remote over SFTP). */
export function ensureImported(key: string, load: () => Promise<string[]>) {
  if (imported.has(key) || importing.has(key)) return;
  const p = load()
    .then((cmds) => void imported.set(key, cmds))
    .catch(() => void imported.set(key, []))
    .finally(() => importing.delete(key));
  importing.set(key, p);
}

/** All known commands for a key, most recent first, unique. */
export function commands(key: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of [own[key] ?? [], imported.get(key) ?? []]) {
    for (let i = list.length - 1; i >= 0; i--) {
      const c = list[i];
      if (!seen.has(c)) {
        seen.add(c);
        out.push(c);
      }
    }
  }
  return out;
}

/** Inline (fish-style) suggestion: most recent command extending `prefix`. */
export function suggest(key: string, prefix: string): string | null {
  if (!prefix.trim()) return null;
  for (const c of commands(key)) if (c.length > prefix.length && c.startsWith(prefix)) return c;
  return null;
}

/** Fuzzy search for the completion list. Prefix matches rank first, then recency. */
export function search(key: string, query: string, limit = 12): string[] {
  const all = commands(key);
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  const scored: { c: string; s: number }[] = [];
  all.forEach((c, recency) => {
    const lc = c.toLowerCase();
    let s: number;
    if (lc.startsWith(q)) s = 3000;
    else if (lc.includes(q)) s = 2000 - lc.indexOf(q);
    else {
      // subsequence match, tighter = better
      let qi = 0;
      let gaps = 0;
      let last = -1;
      for (let i = 0; i < lc.length && qi < q.length; i++) {
        if (lc[i] === q[qi]) {
          if (last >= 0) gaps += i - last - 1;
          last = i;
          qi++;
        }
      }
      if (qi < q.length) return;
      s = 1000 - gaps;
    }
    scored.push({ c, s: s - recency * 0.01 });
  });
  return scored
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}
