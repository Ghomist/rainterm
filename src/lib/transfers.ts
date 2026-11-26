// Transfer queue shared by all file panels (survives switching panes/tabs).
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { create } from "zustand";
import { Channel, ipc, type Progress } from "./ipc";
import { toast } from "./overlay";
import { tr } from "@/lib/i18n";

export type JobStatus = "running" | "done" | "error" | "cancelled";

export interface Job {
  id: string;
  dir: "up" | "down";
  label: string;
  progress: Progress;
  status: JobStatus;
  error?: string;
  startedAt: number;
  speed: number; // bytes/s (smoothed)
}

interface TransferState {
  jobs: Job[];
}

export const useTransfers = create<TransferState>(() => ({ jobs: [] }));

const patch = (id: string, p: Partial<Job>) =>
  useTransfers.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));

export function clearFinished() {
  useTransfers.setState((s) => ({ jobs: s.jobs.filter((j) => j.status === "running") }));
}

export function cancelJob(id: string) {
  void ipc.fsCancel(id);
}

function start(dir: Job["dir"], label: string) {
  const id = crypto.randomUUID();
  const job: Job = {
    id,
    dir,
    label,
    progress: { done: 0, total: 0, filesDone: 0, filesTotal: 0, current: "" },
    status: "running",
    startedAt: performance.now(),
    speed: 0,
  };
  useTransfers.setState((s) => ({ jobs: [...s.jobs, job] }));
  let lastT = performance.now();
  let lastDone = 0;
  const ch = new Channel<Progress>();
  ch.onmessage = (p) => {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    const cur = useTransfers.getState().jobs.find((j) => j.id === id);
    let speed = cur?.speed ?? 0;
    if (dt > 0.05) {
      const inst = (p.done - lastDone) / dt;
      speed = speed ? speed * 0.7 + inst * 0.3 : inst;
      lastT = now;
      lastDone = p.done;
    }
    patch(id, { progress: p, speed });
  };
  return { id, ch };
}

const finish = (id: string, e?: unknown) => {
  const msg = e === undefined ? undefined : String(e);
  patch(id, {
    status: msg === undefined ? "done" : msg.includes("cancelled") ? "cancelled" : "error",
    error: msg,
  });
};

export async function download(sessionId: string, remotes: string[], localDir: string) {
  const label = remotes.length === 1 ? remotes[0].split("/").pop() || remotes[0] : `${remotes.length} items`;
  const { id, ch } = start("down", label);
  try {
    const created = await ipc.fsDownload(sessionId, remotes, localDir, id, ch);
    finish(id);
    toast({
      kind: "success",
      title: `Downloaded ${label}`,
      description: localDir,
      action: created[0] ? { label: "Show in folder", run: () => void revealItemInDir(created[0]) } : undefined,
    });
    return created;
  } catch (e) {
    finish(id, e);
    if (!String(e).includes("cancelled")) toast({ kind: "error", title: tr("Download failed: {0}", { 0: label }), description: String(e) });
    return null;
  }
}

export async function upload(sessionId: string, locals: string[], remoteDir: string) {
  const label = locals.length === 1 ? locals[0].split(/[\\/]/).pop() || locals[0] : `${locals.length} items`;
  const { id, ch } = start("up", label);
  try {
    await ipc.fsUpload(sessionId, locals, remoteDir, id, ch);
    finish(id);
    toast({ kind: "success", title: tr("Uploaded {0}", { 0: label }), description: remoteDir });
    return true;
  } catch (e) {
    finish(id, e);
    if (!String(e).includes("cancelled")) toast({ kind: "error", title: tr("Upload failed: {0}", { 0: label }), description: String(e) });
    return false;
  }
}

export function fmtSize(n: number) {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

export function fmtEta(sec: number) {
  if (!Number.isFinite(sec) || sec <= 0) return "";
  if (sec < 60) return `${Math.ceil(sec)}s left`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${Math.ceil(sec % 60)}s left` : `${Math.floor(m / 60)}h ${m % 60}m left`;
}
