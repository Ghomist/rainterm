// Agent pool settings: runtimes (which agent programs, where), peers (runtime × model ×
// effort with roles and a tier), roles, and limits. Edits apply right away.
import { Check, Loader2, Plus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { ComboInput, NumberInput, Select, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { IconButton } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import { effectiveRoles, PRESET_ROLES, RUNTIME_KINDS, runtimeLabel, tierLabel } from "@/lib/forge/config";
import { forge } from "@/lib/forge/engine";
import { OUTPUT_LANGUAGES } from "@/lib/forge/llm";
import { useForge } from "@/lib/forge/store";
import { type ForgeConfig, type PeerConfig, type RoleDef, type RuntimeConfig, type RuntimeKind, TIERS, type Tier } from "@/lib/forge/types";
import { tr } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { AUTONOMY } from "./AgentsView";

const useDlg = create<{ open: boolean; tab: Tab }>(() => ({ open: false, tab: "pool" }));
type Tab = "pool" | "runtimes" | "roles" | "limits";

export function openAgentsSettings(tab: Tab = "pool") {
  void forge.start();
  useDlg.setState({ open: true, tab });
}

const TABS: { id: Tab; label: string }[] = [
  { id: "pool", label: "Agent pool" },
  { id: "runtimes", label: "Runtimes" },
  { id: "roles", label: "Roles" },
  { id: "limits", label: "Policy" },
];

const field = "h-7 rounded-md border border-input bg-inset px-2 text-[12px] outline-none focus:border-primary/60";

function update(fn: (c: ForgeConfig) => ForgeConfig) {
  forge.updateConfig(fn(structuredClone(forge.config)));
}

export function AgentsSettingsDialog() {
  const { open, tab } = useDlg();
  const loaded = useForge((s) => s.loaded);
  return (
    <Dialog open={open} onOpenChange={(o) => useDlg.setState({ open: o })}>
      <DialogContent className="flex h-[min(640px,calc(100vh-4rem))] max-w-[min(860px,calc(100%-2rem))] flex-col gap-3 p-0">
        <DialogHeader className="px-5 pt-5">
          <DialogTitle>{tr("Agents")}</DialogTitle>
          <DialogDescription>
            {tr("Who does the work: agent programs (runtimes), the pool built from them with roles and tiers, and how much they may do on their own.")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex gap-1 border-b border-ov/[0.07] px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => useDlg.setState({ tab: t.id })}
              className={cn(
                "-mb-px border-b-2 px-2.5 pb-2 text-[12.5px] transition-colors",
                tab === t.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {tr(t.label)}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
          {!loaded ? (
            <Loader2 className="mx-auto mt-10 size-5 animate-spin text-muted-foreground" />
          ) : tab === "pool" ? (
            <PoolTab />
          ) : tab === "runtimes" ? (
            <RuntimesTab />
          ) : tab === "roles" ? (
            <RolesTab />
          ) : (
            <LimitsTab />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ pool

function PoolTab() {
  const config = useForge((s) => s.config);
  const roles = useMemo(() => effectiveRoles(config), [config]);
  const add = () =>
    update((c) => {
      const rt = c.runtimes.find((r) => r.enabled !== false) ?? c.runtimes[0];
      let id = rt?.id ?? "agent";
      for (let i = 2; c.peers.some((p) => p.id === id); i++) id = `${rt?.id ?? "agent"}-${i}`;
      c.peers.push({ id, runtime: rt?.id ?? "rainterm", roles: ["research"], tier: "L2", maxConcurrent: 1, enabled: true });
      return c;
    });
  return (
    <div className="flex flex-col gap-2 pt-3">
      <p className="text-[12px] text-muted-foreground">
        {tr(
          "Each agent is a runtime with a model and effort. Roles say what kind of task it may be given; its level how hard (lightweight, standard, senior, expert). Tasks go to the cheapest agent that qualifies and move up a level after repeated failures.",
        )}
      </p>
      {config.peers.map((p, i) => (
        <PeerRow key={`${i}-${p.id}`} peer={p} index={i} roles={roles} config={config} />
      ))}
      <div>
        <Button size="sm" variant="secondary" onClick={add}>
          <Plus className="size-3.5" /> {tr("Add agent")}
        </Button>
      </div>
    </div>
  );
}

function PeerRow({ peer: p, index, roles, config }: { peer: PeerConfig; index: number; roles: RoleDef[]; config: ForgeConfig }) {
  const probes = useForge((s) => s.probes);
  const probe = probes[p.runtime];
  const set = (patch: Partial<PeerConfig>) =>
    update((c) => {
      c.peers[index] = { ...c.peers[index], ...patch };
      return c;
    });
  return (
    <div className={cn("rounded-lg border border-ov/[0.08] p-2.5", p.enabled === false && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={p.enabled !== false} onChange={(v) => set({ enabled: v })} />
        <input className={cn(field, "w-36 font-medium")} value={p.id} onChange={(e) => set({ id: e.target.value.replace(/\s+/g, "-") })} />
        <Select<string>
          size="sm"
          className="w-40"
          value={p.runtime}
          options={config.runtimes.map((r) => ({ value: r.id, label: r.id, hint: runtimeLabel(r.kind) }))}
          onChange={(v) => set({ runtime: v, model: undefined, effort: undefined })}
        />
        <ComboInput
          className="h-7 w-44 text-[12px]"
          value={p.model ?? ""}
          placeholder={tr("default model")}
          options={(probe?.models ?? []).map((m) => ({ value: m.value, label: m.name, hint: m.group }))}
          onChange={(v) => set({ model: v || undefined })}
        />
        <ComboInput
          className="h-7 w-28 text-[12px]"
          value={p.effort ?? ""}
          placeholder={tr("effort")}
          options={(probe?.efforts ?? []).map((m) => ({ value: m.value, label: m.name }))}
          onChange={(v) => set({ effort: v || undefined })}
        />
        <Select<Tier> size="sm" className="w-24" value={p.tier} options={TIERS.map((t) => ({ value: t, label: tierLabel(t), hint: undefined }))} onChange={(v) => set({ tier: v })} />
        <Tooltip content={tr("At most this many tasks at once")}>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            ×
            <NumberInput value={p.maxConcurrent} min={1} max={8} onChange={(v) => set({ maxConcurrent: v })} className="h-7 w-14" />
          </div>
        </Tooltip>
        <div className="flex-1" />
        <IconButton
          tip={tr("Remove")}
          danger
          className="size-6"
          onClick={() =>
            update((c) => {
              c.peers.splice(index, 1);
              return c;
            })
          }
        >
          <Trash2 />
        </IconButton>
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {roles
          .filter((r) => r.enabled !== false)
          .map((r) => {
            const on = p.roles.includes(r.id);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => set({ roles: on ? p.roles.filter((x) => x !== r.id) : [...p.roles, r.id] })}
                className={cn("press rounded-md px-2 py-0.5 text-[11px] font-medium transition", on ? "" : "opacity-45 hover:opacity-80")}
                style={{ background: `${r.color}${on ? "30" : "14"}`, color: r.color }}
              >
                {on && <Check className="mr-0.5 inline size-3" />}
                {tr(r.name)}
              </button>
            );
          })}
        {probe && !probe.ok && !probe.probing && (
          <span className="ml-auto flex items-center gap-1 text-[11px] text-warning">
            <TriangleAlert className="size-3.5" /> {tr("runtime unavailable")}
          </span>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ runtimes

function RuntimesTab() {
  const config = useForge((s) => s.config);
  const [kind, setKind] = useState<RuntimeKind>("custom");
  const add = () =>
    update((c) => {
      let id: string = kind === "custom" ? "custom" : kind;
      for (let i = 2; c.runtimes.some((r) => r.id === id); i++) id = `${kind}-${i}`;
      c.runtimes.push({ id, kind, enabled: true, ...(kind === "custom" ? { command: [] } : {}) });
      return c;
    });
  return (
    <div className="flex flex-col gap-2 pt-3">
      <p className="text-[12px] text-muted-foreground">
        {tr(
          "Agent programs, spoken to over ACP (Agent Client Protocol). Claude Code, Codex and pi run through their npx ACP adapters (Node.js needed; the first start downloads them); opencode has ACP built in. “rainterm model” is the model from Settings → Agent with rainterm's own tools.",
        )}
      </p>
      {config.runtimes.map((r, i) => (
        <RuntimeRow key={`${i}-${r.id}`} rt={r} index={i} />
      ))}
      <div className="flex items-center gap-2">
        <Select<RuntimeKind> size="sm" className="w-48" value={kind} options={RUNTIME_KINDS.map((k) => ({ value: k.kind, label: tr(k.label) }))} onChange={setKind} />
        <Button size="sm" variant="secondary" onClick={add}>
          <Plus className="size-3.5" /> {tr("Add runtime")}
        </Button>
        <div className="flex-1" />
        <Button size="sm" variant="ghost" onClick={() => void forge.probeAll()}>
          <RefreshCw className="size-3.5" /> {tr("Probe all")}
        </Button>
      </div>
    </div>
  );
}

function RuntimeRow({ rt, index }: { rt: RuntimeConfig; index: number }) {
  const probe = useForge((s) => s.probes[rt.id]);
  const profiles = useApp((s) => s.profiles);
  const ssh = profiles.filter((p) => p.kind === "ssh");
  const set = (patch: Partial<RuntimeConfig>) =>
    update((c) => {
      c.runtimes[index] = { ...c.runtimes[index], ...patch };
      return c;
    });
  const [cmd, setCmd] = useState((rt.command ?? []).join(" "));
  const builtin = rt.kind === "rainterm";
  return (
    <div className={cn("rounded-lg border border-ov/[0.08] p-2.5", rt.enabled === false && "opacity-60")}>
      <div className="flex flex-wrap items-center gap-2">
        <Switch checked={rt.enabled !== false} onChange={(v) => set({ enabled: v })} />
        <span className="w-28 truncate font-medium">{rt.id}</span>
        <span className="text-[11.5px] text-muted-foreground">{tr(runtimeLabel(rt.kind))}</span>
        <div className="flex-1" />
        {probe?.probing ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" /> {tr("probing…")}
          </span>
        ) : probe?.ok ? (
          <span className="flex items-center gap-1 text-[11px] text-success">
            <Check className="size-3.5" /> {probe.version || tr("ready")}
            {probe.models.length > 0 && <span className="text-muted-foreground">· {tr("{0} models", { 0: probe.models.length })}</span>}
          </span>
        ) : probe ? (
          <span className="text-[11px] text-warning">{tr("unavailable")}</span>
        ) : null}
        <IconButton tip={tr("Probe again")} className="size-6" onClick={() => void forge.probe(rt.id)}>
          <RefreshCw />
        </IconButton>
        {!builtin && (
          <IconButton
            tip={tr("Remove")}
            danger
            className="size-6"
            onClick={() =>
              update((c) => {
                c.runtimes.splice(index, 1);
                c.peers = c.peers.filter((p) => p.runtime !== rt.id);
                return c;
              })
            }
          >
            <Trash2 />
          </IconButton>
        )}
      </div>
      {!builtin && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            className={cn(field, "min-w-64 flex-1 font-mono text-[11.5px]")}
            value={cmd}
            placeholder={rt.kind === "custom" ? tr("ACP command, e.g. my-agent --acp") : tr("default launch command")}
            onChange={(e) => setCmd(e.target.value)}
            onBlur={() => set({ command: cmd.trim() ? splitArgs(cmd) : undefined })}
          />
          <Select<string>
            size="sm"
            className="w-48"
            value={rt.remote?.profileId ?? ""}
            options={[{ value: "", label: tr("This computer") }, ...ssh.map((p) => ({ value: p.id, label: p.name || p.id, hint: tr("SSH") }))]}
            onChange={(v) => set({ remote: v ? { profileId: v, workdir: rt.remote?.workdir } : undefined })}
          />
          {rt.remote && (
            <input
              className={cn(field, "w-40 font-mono text-[11.5px]")}
              defaultValue={rt.remote.workdir ?? ""}
              placeholder={tr("remote folder (/tmp)")}
              onBlur={(e) => set({ remote: { ...rt.remote!, workdir: e.target.value.trim() || undefined } })}
            />
          )}
        </div>
      )}
      {probe && !probe.ok && !probe.probing && probe.error && (
        <pre className="mt-2 max-h-24 overflow-auto rounded-md bg-inset px-2 py-1 text-[11px] whitespace-pre-wrap text-muted-foreground">{probe.error}</pre>
      )}
    </div>
  );
}

function splitArgs(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// ------------------------------------------------------------------ roles

function RolesTab() {
  const config = useForge((s) => s.config);
  const roles = useMemo(() => effectiveRoles(config), [config]);
  const setRole = (id: string, patch: Partial<RoleDef>) =>
    update((c) => {
      const i = c.roles.findIndex((r) => r.id === id);
      const base = roles.find((r) => r.id === id)!;
      if (i >= 0) c.roles[i] = { ...c.roles[i], ...patch };
      else c.roles.push({ ...base, ...patch });
      return c;
    });
  const add = () =>
    update((c) => {
      let id = "custom";
      for (let i = 2; roles.some((r) => r.id === id); i++) id = `custom-${i}`;
      const parent = PRESET_ROLES.find((r) => r.id === "build")!;
      c.roles.push({ ...parent, id, name: "Custom", description: "", kind: "custom", parent: "build", color: "#2dd4bf" });
      return c;
    });
  return (
    <div className="flex flex-col gap-2 pt-3">
      <p className="text-[12px] text-muted-foreground">
        {tr("The planner picks a role per task from these descriptions; a role also caps what its agents may do (files, shell, web, terminals). Custom roles inherit the limits of their parent.")}
      </p>
      {roles.map((r) => (
        <div key={r.id} className={cn("rounded-lg border border-ov/[0.08] p-2.5", r.enabled === false && "opacity-60")}>
          <div className="flex items-center gap-2">
            {r.kind !== "system" && <Switch checked={r.enabled !== false} onChange={(v) => setRole(r.id, { enabled: v })} />}
            <span className="size-2.5 rounded-full" style={{ background: r.color }} />
            {r.kind === "custom" ? (
              <input className={cn(field, "w-36 font-medium")} value={r.name} onChange={(e) => setRole(r.id, { name: e.target.value })} />
            ) : (
              <span className="font-medium">{tr(r.name)}</span>
            )}
            <code className="text-[11px] text-muted-foreground">{r.id}</code>
            <span className="text-[11px] text-muted-foreground">
              {r.kind === "system" ? tr("built-in step") : r.kind === "preset" ? tr("preset") : tr("custom · from {0}", { 0: r.parent ?? "" })}
            </span>
            <div className="flex-1" />
            <span className="text-[10.5px] text-muted-foreground">{ceilingText(r)}</span>
            {r.kind === "custom" && (
              <IconButton
                tip={tr("Remove")}
                danger
                className="size-6"
                onClick={() =>
                  update((c) => {
                    c.roles = c.roles.filter((x) => x.id !== r.id);
                    return c;
                  })
                }
              >
                <Trash2 />
              </IconButton>
            )}
          </div>
          <textarea
            rows={2}
            className="mt-1.5 w-full resize-y rounded-md border border-input bg-inset px-2 py-1 text-[12px] outline-none focus:border-primary/60"
            defaultValue={r.kind === "custom" ? r.description : tr(r.description)}
            placeholder={tr("What kind of task this role is for (the planner reads this)")}
            onBlur={(e) => e.target.value !== (r.kind === "custom" ? r.description : tr(r.description)) && setRole(r.id, { description: e.target.value })}
          />
        </div>
      ))}
      <div>
        <Button size="sm" variant="secondary" onClick={add}>
          <Plus className="size-3.5" /> {tr("Add role")}
        </Button>
      </div>
    </div>
  );
}

function ceilingText(r: RoleDef) {
  const c = r.permissionCeiling;
  const fs = { none: tr("no files"), read: tr("read files"), workspace: tr("edit workspace"), any: tr("edit anywhere") }[c.fs];
  const sh = { none: "", readonly: tr("read-only shell"), workspace: tr("shell"), any: tr("any shell") }[c.shell];
  return [fs, sh, c.web && tr("web"), c.terminals && tr("terminals")].filter(Boolean).join(" · ");
}

// ------------------------------------------------------------------ limits

function LimitsTab() {
  const config = useForge((s) => s.config);
  const mcp = useApp((s) => s.settings.mcp.enabled);
  return (
    <div className="flex flex-col gap-4 pt-4 text-[12.5px]">
      <Row label={tr("Autonomy")} hint={tr("What agents may do without asking you.")}>
        <Select
          size="sm"
          className="w-56"
          value={config.autonomy}
          options={AUTONOMY.map((a) => ({ value: a.value, label: tr(a.label), hint: tr(a.hint) }))}
          onChange={(v) => update((c) => ({ ...c, autonomy: v }))}
        />
      </Row>
      <Row label={tr("Output language")} hint={tr("What agents write in: plans, task titles, findings and reports.")}>
        <Select<string>
          size="sm"
          className="w-56"
          value={config.outputLanguage ?? "system"}
          options={OUTPUT_LANGUAGES.map((l) => ({ value: l.value, label: l.value === "system" ? tr(l.label) : l.label }))}
          onChange={(v) => update((c) => ({ ...c, outputLanguage: v }))}
        />
      </Row>
      <Row label={tr("Agents at once")} hint={tr("Across the whole pool.")}>
        <NumberInput value={config.limits.maxConcurrentRuns} min={1} max={16} onChange={(v) => update((c) => ({ ...c, limits: { ...c.limits, maxConcurrentRuns: v } }))} className="h-7 w-20" />
      </Row>
      <Row label={tr("Daily spend limit (USD)")} hint={tr("Dispatching pauses when agents that report cost reach it; 0 = no limit.")}>
        <NumberInput value={config.limits.dailyCostUsd} min={0} max={10000} onChange={(v) => update((c) => ({ ...c, limits: { ...c.limits, dailyCostUsd: v } }))} className="h-7 w-20" />
      </Row>
      <div className="rounded-lg border border-ov/[0.08] p-3 text-[12px] text-muted-foreground">
        <div className="mb-1 font-medium text-foreground">{tr("Terminals and SSH hosts")}</div>
        {tr(
          "Tasks with the Operate role work on your machines through rainterm's terminals. The rainterm model can always do this; Claude Code and other ACP agents need the MCP server (Settings → Agent) to be on.",
        )}
        <div className={cn("mt-1.5", mcp ? "text-success" : "text-warning")}>{mcp ? tr("MCP server is on.") : tr("MCP server is off.")}</div>
      </div>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div>{label}</div>
        {hint && <div className="text-[11.5px] text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}
