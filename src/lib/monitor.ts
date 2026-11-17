// Resource monitor data: one poller for the machine behind the active pane (the local
// machine, or the remote Linux host of an SSH session), with a short history for charts.
import { create } from "zustand";
import { ipc, type MonitorSnapshot } from "./ipc";

export interface Sample {
  t: number;
  cpu: number;
  mem: number; // 0..100
  rx: number;
  tx: number;
  gpu: number | null;
}

export interface MachineState {
  snap: MonitorSnapshot | null;
  error: string | null;
  history: Sample[];
}

const HISTORY = 60; // samples kept (2 min at 2 s)

export const useMonitor = create<{ machines: Record<string, MachineState> }>(() => ({ machines: {} }));

function record(key: string, snap: MonitorSnapshot | null, error: string | null) {
  useMonitor.setState((s) => {
    const prev = s.machines[key] ?? { snap: null, error: null, history: [] };
    let history = prev.history;
    if (snap) {
      const gpu = snap.gpus.find((g) => g.util != null)?.util ?? null;
      history = [
        ...history,
        {
          t: Date.now(),
          cpu: snap.cpu,
          mem: snap.memTotal ? (snap.memUsed / snap.memTotal) * 100 : 0,
          rx: snap.netRx,
          tx: snap.netTx,
          gpu,
        },
      ].slice(-HISTORY);
    }
    return { machines: { ...s.machines, [key]: { snap: snap ?? prev.snap, error, history } } };
  });
}

/** Machine key for a pane: "local" or the SSH session id. */
export function machineKey(kind: string, sessionId: string | null) {
  if (kind === "local") return "local";
  if (kind === "ssh" && sessionId) return `ssh:${sessionId}`;
  return null;
}

let timer: number | null = null;
let current: { key: string; interval: number } | null = null;
let inflight = false;

async function tick(key: string) {
  if (inflight) return;
  inflight = true;
  try {
    const snap = key === "local" ? await ipc.monitorLocal() : await ipc.monitorRemote(key.slice(4));
    record(key, snap, null);
  } catch (e) {
    record(key, null, String(e));
  } finally {
    inflight = false;
  }
}

/** Poll `key` every `interval` ms (null stops polling). Re-calling with the same args is a no-op. */
export function pollMachine(key: string | null, interval: number) {
  if (current?.key === key && current?.interval === interval) return;
  if (timer !== null) clearInterval(timer);
  timer = null;
  current = key ? { key, interval } : null;
  if (!key) return;
  void tick(key);
  timer = window.setInterval(() => void tick(key), interval);
}

export function fmtBytes(n: number, digits = 1) {
  if (!Number.isFinite(n)) return "–";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : n < 10 ? digits : 0)} ${u[i]}`;
}

export function fmtRate(n: number) {
  return `${fmtBytes(n)}/s`;
}

export function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
