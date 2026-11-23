// Starting goals and adding to them. There's no chat agent in front: a goal's text goes
// straight to the planner. A local folder mentioned in it becomes the goal's workspace
// (git repositories get isolated branches); otherwise the goal works in its own scratch folder.
import { ipc } from "@/lib/ipc";
import { forge } from "./engine";

/** Windows (C:\…, C:/…) and POSIX (/…, ~/…) paths in free text, longest first. */
function pathsIn(text: string): string[] {
  const found = text.match(/(?:[a-zA-Z]:[\\/]|~[\\/]|\/(?=[\w.]))[^\s"'“”‘’`<>|，。；：、！？（）()]+/g) ?? [];
  return [...new Set(found.map((p) => p.replace(/[.,;:!?)\]}]+$/, "")))].sort((a, b) => b.length - a.length);
}

/** The first existing folder mentioned in the text (a file's folder counts). */
export async function detectFolder(text: string): Promise<string | undefined> {
  const home = await ipc.fsHome({ kind: "local" }).catch(() => "");
  for (const raw of pathsIn(text)) {
    const p = raw.startsWith("~") && home ? `${home}${raw.slice(1)}` : raw;
    const st = await ipc.pathStat(p).catch(() => null);
    if (st?.dir) return p.replace(/[\\/]+$/, "");
    if (st?.exists) return p.replace(/[\\/][^\\/]*$/, "");
  }
  return undefined;
}

export async function newGoal(text: string) {
  text = text.trim();
  if (!text) return null;
  await forge.start();
  return forge.submitGoal(text, await detectFolder(text));
}

export function followUp(goalId: string, text: string) {
  return forge.postMessage(goalId, text);
}
