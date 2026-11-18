// SSH round-trip latency: every connected SSH session is pinged (an SSH global request
// the server answers right away) every few seconds. Smoothed a little so the number
// doesn't jitter.
import { useEffect } from "react";
import { create } from "zustand";
import { ipc } from "./ipc";

interface LatencyState {
  /** session id → ms (null = the last ping got no reply). */
  ms: Record<string, number | null>;
}

export const useLatency = create<LatencyState>(() => ({ ms: {} }));

const INTERVAL = 4000;

export function useLatencyPolling(sessionIds: string[]) {
  const key = [...new Set(sessionIds)].sort().join(",");
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    // Forget sessions that went away.
    useLatency.setState((s) => ({ ms: Object.fromEntries(Object.entries(s.ms).filter(([id]) => ids.includes(id))) }));
    if (!ids.length) return;
    let stop = false;
    const tick = async () => {
      await Promise.all(
        ids.map(async (id) => {
          let v: number | null;
          try {
            v = await ipc.sshPing(id);
          } catch {
            v = null;
          }
          if (stop) return;
          useLatency.setState((s) => {
            const prev = s.ms[id];
            const next = v == null || prev == null ? v : prev * 0.4 + v * 0.6;
            return { ms: { ...s.ms, [id]: next } };
          });
        }),
      );
    };
    void tick();
    const t = setInterval(() => void tick(), INTERVAL);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [key]);
}

export const latencyTone = (ms: number | null | undefined) =>
  ms == null ? "text-destructive" : ms < 100 ? "text-success" : ms < 250 ? "text-warning" : "text-destructive";

export const fmtLatency = (ms: number | null | undefined) =>
  ms === undefined ? "" : ms === null ? "no reply" : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`;
