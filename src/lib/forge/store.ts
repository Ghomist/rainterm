// State of the agents board. The engine keeps the authoritative objects in Maps and mutates
// them (like agent-forge's store); every put publishes a fresh copy to the zustand store the
// UI renders from, and a debounced save writes everything to <home>/agents.json.
import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import { defaultConfig } from "./config";
import type { AgentEvent, AgentRun, Feature, ForgeConfig, Goal, PendingApproval, RuntimeProbe, Story, TimelineItem } from "./types";

export interface ForgeView {
  loaded: boolean;
  goals: Record<string, Goal>;
  features: Record<string, Feature>;
  stories: Record<string, Story>;
  runs: Record<string, AgentRun>;
  approvals: Record<string, PendingApproval>;
  probes: Record<string, RuntimeProbe>;
  timeline: TimelineItem[];
  config: ForgeConfig;
  paused: boolean;
  /** The entry agent is reading your message. */
  thinking: boolean;
  activeRuns: string[];
}

export const useForge = create<ForgeView>(() => ({
  loaded: false,
  goals: {},
  features: {},
  stories: {},
  runs: {},
  approvals: {},
  probes: {},
  timeline: [],
  config: defaultConfig(),
  paused: false,
  thinking: false,
  activeRuns: [],
}));

/** Live output of runs, by run id (finished runs of earlier sessions load from disk on demand). */
export const useRunEvents = create<Record<string, { at: string; event: AgentEvent }[]>>(() => ({}));

type Table = "goals" | "features" | "stories" | "runs" | "approvals" | "probes";

const clone = <T>(o: T): T => structuredClone(o);

interface Saved {
  goals: Goal[];
  features: Feature[];
  stories: Story[];
  runs: AgentRun[];
  approvals: PendingApproval[];
  probes: RuntimeProbe[];
  timeline: TimelineItem[];
  config: ForgeConfig;
  counters: Record<string, number>;
}

export class Store {
  goals = new Map<string, Goal>();
  features = new Map<string, Feature>();
  stories = new Map<string, Story>();
  runs = new Map<string, AgentRun>();
  approvals = new Map<string, PendingApproval>();
  probes = new Map<string, RuntimeProbe>();
  timeline: TimelineItem[] = [];
  config: ForgeConfig = defaultConfig();
  counters: Record<string, number> = {};
  fresh = true;
  private saveTimer?: ReturnType<typeof setTimeout>;

  async load() {
    const s = await ipc.storeLoad<Saved>("agents").catch(() => null);
    if (s) {
      this.fresh = false;
      for (const t of ["goals", "features", "stories", "runs", "approvals", "probes"] as Table[])
        for (const o of (s[t] ?? []) as { id?: string; runtime?: string }[]) (this[t] as Map<string, unknown>).set(o.id ?? o.runtime!, o);
      this.timeline = s.timeline ?? [];
      const d = defaultConfig();
      this.config = { ...d, ...s.config, limits: { ...d.limits, ...(s.config?.limits ?? {}) } };
      this.counters = s.counters ?? {};
    }
    useForge.setState({
      loaded: true,
      goals: Object.fromEntries([...this.goals].map(([k, v]) => [k, clone(v)])),
      features: Object.fromEntries([...this.features].map(([k, v]) => [k, clone(v)])),
      stories: Object.fromEntries([...this.stories].map(([k, v]) => [k, clone(v)])),
      runs: Object.fromEntries([...this.runs].map(([k, v]) => [k, clone(v)])),
      approvals: Object.fromEntries([...this.approvals].map(([k, v]) => [k, clone(v)])),
      probes: Object.fromEntries([...this.probes].map(([k, v]) => [k, clone(v)])),
      timeline: [...this.timeline],
      config: clone(this.config),
    });
  }

  nextId(prefix: string) {
    this.counters[prefix] = (this.counters[prefix] ?? 0) + 1;
    return `${prefix}-${this.counters[prefix]}`;
  }

  put<T extends { id: string }>(table: Table, obj: T) {
    // an agent finishing after its goal was removed must not bring its task back
    const parent = (obj as { goal?: string }).goal;
    if ((table === "stories" || table === "features") && parent && !this.goals.has(parent)) return;
    (this[table] as Map<string, unknown>).set(obj.id, obj);
    const copy = clone(obj);
    useForge.setState((s) => ({ [table]: { ...s[table], [obj.id]: copy } }) as Partial<ForgeView>);
    this.save();
  }

  putProbe(p: RuntimeProbe) {
    this.probes.set(p.runtime, p);
    const copy = clone(p);
    useForge.setState((s) => ({ probes: { ...s.probes, [p.runtime]: copy } }));
    this.save();
  }

  del(table: Table, id: string) {
    (this[table] as Map<string, unknown>).delete(id);
    useForge.setState((s) => {
      const next = { ...s[table] } as Record<string, unknown>;
      delete next[id];
      return { [table]: next } as Partial<ForgeView>;
    });
    this.save();
  }

  setConfig(c: ForgeConfig) {
    this.config = c;
    useForge.setState({ config: clone(c) });
    this.save();
  }

  addTimeline(item: TimelineItem) {
    this.timeline.push(item);
    if (this.timeline.length > 500) this.timeline.splice(0, this.timeline.length - 500);
    useForge.setState({ timeline: [...this.timeline] });
    this.save();
  }

  clearTimeline() {
    this.timeline = [];
    useForge.setState({ timeline: [] });
    this.save();
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), 800);
  }

  async flush() {
    clearTimeout(this.saveTimer);
    const runs = [...this.runs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 400);
    const data: Saved = {
      goals: [...this.goals.values()],
      features: [...this.features.values()],
      stories: [...this.stories.values()],
      runs,
      approvals: [...this.approvals.values()],
      probes: [...this.probes.values()].map((p) => ({ ...p, probing: false })),
      timeline: this.timeline,
      config: this.config,
      counters: this.counters,
    };
    await ipc.storeSave("agents", data).catch(() => {});
  }

  // ---- per-run event streams: in memory for the UI, appended to runs/<id>.jsonl on disk
  private pending = new Map<string, string[]>();
  private logTimer?: ReturnType<typeof setTimeout>;

  appendRunEvent(run: string, event: AgentEvent) {
    const at = new Date().toISOString();
    useRunEvents.setState((s) => {
      const list = s[run] ?? [];
      const last = list[list.length - 1];
      // merge streamed text/thinking into the previous chunk of the same kind
      if (last && (event.t === "text" || event.t === "thinking") && last.event.t === event.t && list.length) {
        const merged = { at: last.at, event: { ...last.event, text: (last.event as { text: string }).text + event.text } as AgentEvent };
        return { [run]: [...list.slice(0, -1), merged] };
      }
      // a tool update replaces its earlier line
      if (event.t === "tool") {
        const i = list.findIndex((x) => x.event.t === "tool" && x.event.id === event.id);
        if (i >= 0) {
          const prev = list[i].event as Extract<AgentEvent, { t: "tool" }>;
          const next = [...list];
          next[i] = { at: list[i].at, event: { ...prev, ...event, detail: event.detail ?? prev.detail } };
          return { [run]: next };
        }
      }
      const next = list.length > 3000 ? list.slice(-2500) : list;
      return { [run]: [...next, { at, event }] };
    });
    const buf = this.pending.get(run) ?? [];
    buf.push(JSON.stringify({ at, event }));
    this.pending.set(run, buf);
    this.logTimer ??= setTimeout(() => this.flushLogs(), 1000);
  }

  private flushLogs() {
    this.logTimer = undefined;
    for (const [run, lines] of this.pending) void ipc.agentsLogAppend(run, `${lines.join("\n")}\n`).catch(() => {});
    this.pending.clear();
  }

  async loadRunEvents(run: string) {
    if (useRunEvents.getState()[run]) return;
    const text = await ipc.agentsLogRead(run).catch(() => "");
    const out: { at: string; event: AgentEvent }[] = [];
    for (const l of text.split("\n")) {
      if (!l) continue;
      try {
        out.push(JSON.parse(l));
      } catch {}
    }
    // replay through the same merging rules
    useRunEvents.setState({ [run]: [] });
    for (const e of out) {
      useRunEvents.setState((s) => {
        const list = s[run] ?? [];
        const last = list[list.length - 1];
        if (last && (e.event.t === "text" || e.event.t === "thinking") && last.event.t === e.event.t)
          return { [run]: [...list.slice(0, -1), { at: last.at, event: { ...last.event, text: (last.event as { text: string }).text + (e.event as { text: string }).text } as AgentEvent }] };
        if (e.event.t === "tool") {
          const ev = e.event;
          const i = list.findIndex((x) => x.event.t === "tool" && x.event.id === ev.id);
          if (i >= 0) {
            const next = [...list];
            next[i] = { at: list[i].at, event: { ...(list[i].event as typeof ev), ...ev, detail: ev.detail ?? (list[i].event as typeof ev).detail } };
            return { [run]: next };
          }
        }
        return { [run]: [...list, e] };
      });
    }
  }
}
