// Settings → Agent: which model API the built-in agent talks to. The key goes straight
// into the OS keychain and is only ever read by the backend.
import { Check as CheckIcon, ChevronRight, ClipboardCopy, KeyRound, Minus, RefreshCw, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { NumberInput, Select, Switch } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Channel, ipc, type LlmEvent } from "@/lib/ipc";
import { toast } from "@/lib/overlay";
import { newToken, useMcpStatus } from "@/lib/mcp";
import { MCP_GROUPS, mcpToolOn } from "@/lib/mcp-tools";
import { proxyUrl, SYSTEM_PROXY } from "@/lib/proxy-url";
import { type AgentAutonomy, type AgentSettings, type McpSettings, proxyLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { Field, Segmented } from "./dialogs";
import { tr } from "@/lib/i18n";

const KEY = "agent:api-key";

const PRESETS: { label: string; patch: Partial<AgentSettings>; model: string }[] = [
  { label: "DeepSeek", patch: { format: "openai", baseUrl: "https://api.deepseek.com" }, model: "deepseek-chat" },
  { label: "OpenAI", patch: { format: "openai", baseUrl: "https://api.openai.com/v1" }, model: "" },
  { label: "Anthropic", patch: { format: "anthropic", baseUrl: "https://api.anthropic.com" }, model: "claude-opus-5-5" },
];

export function AgentSection() {
  const a = useApp((s) => s.settings.agent);
  const proxies = useApp((s) => s.settings.proxies);
  const updateSettings = useApp((s) => s.updateSettings);
  const update = (patch: Partial<AgentSettings>) => void updateSettings({ agent: { ...a, ...patch } });
  const [hasKey, setHasKey] = useState(false);
  const [key, setKey] = useState("");
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });

  useEffect(() => {
    void ipc.secretHas(KEY).then(setHasKey, () => setHasKey(false));
  }, []);

  const saveKey = async () => {
    if (!key.trim()) return;
    try {
      await ipc.secretSet(KEY, key.trim());
      setKey("");
      setHasKey(true);
      toast({ kind: "success", title: tr("API key saved to the keychain") });
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't save the key"), description: String(e) });
    }
  };

  const runTest = async () => {
    setTest({ busy: true });
    const t0 = performance.now();
    try {
      if (!a.model.trim()) throw new Error(tr("Set a model first."));
      const proxy = await proxyUrl(a.proxy, proxies);
      const reply = await new Promise<string>((resolve, reject) => {
        let text = "";
        const ch = new Channel<LlmEvent>();
        ch.onmessage = (ev) => {
          if (ev.type === "textDelta") text += ev.text;
          else if (ev.type === "done") resolve(text.trim());
          else if (ev.type === "error") reject(new Error(ev.message));
        };
        void ipc
          .llmChat(
            `test-${Date.now()}`,
            { format: a.format, baseUrl: a.baseUrl.trim(), model: a.model.trim(), maxTokens: 256, effort: a.effort || null, proxy },
            { system: "Reply with exactly: OK", messages: [{ role: "user", content: [{ type: "text", text: "ping" }] }], tools: [] },
            ch,
          )
          .catch(reject);
      });
      setTest({ busy: false, ok: true, text: `Works: ${(performance.now() - t0).toFixed(0)} ms — "${reply.slice(0, 60) || "(empty reply)"}"` });
    } catch (e) {
      setTest({ busy: false, ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <>
      <p className="text-[12.5px] text-muted-foreground">
        {tr("Press")}{" "}<kbd className="rounded border border-border bg-ov/5 px-1 text-[11px]">{tr("Ctrl+I")}</kbd> {tr("in a terminal to ask the agent. It sees what's in that terminal and works in it — you watch every keystroke and can interrupt by typing.")}
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="mr-1 text-[12px] text-muted-foreground">{tr("Presets")}</span>
        {PRESETS.map((p) => (
          <Button
            key={p.label}
            size="sm"
            variant="outline"
            onClick={() => update({ ...p.patch, model: a.model && a.baseUrl === p.patch.baseUrl ? a.model : p.model })}
          >
            {p.label}
          </Button>
        ))}
      </div>
      <Field label={tr("API format")}>
        <Segmented
          value={a.format}
          options={[
            { value: "openai", label: tr("OpenAI-compatible") },
            { value: "anthropic", label: tr("Anthropic") },
          ]}
          onChange={(format) => update({ format })}
        />
      </Field>
      <div className="grid grid-cols-[1fr_200px] gap-2">
        <Field label={tr("Base URL")}>
          <Input
            value={a.baseUrl}
            onChange={(e) => update({ baseUrl: e.target.value })}
            placeholder={a.format === "openai" ? tr("https://api.example.com/v1") : tr("https://api.anthropic.com")}
            className="font-mono text-[12px]"
          />
        </Field>
        <Field label={tr("Model")}>
          <Input value={a.model} onChange={(e) => update({ model: e.target.value })} placeholder={tr("model id")} className="font-mono text-[12px]" />
        </Field>
      </div>
      <p className="-mt-2 text-[11.5px] text-muted-foreground">
        {a.format === "openai"
          ? tr("Requests go to {Base URL}/chat/completions with tool calls (function calling).")
          : tr("Requests go to {Base URL}/v1/messages.")}
      </p>
      <Field label={tr("API key")}>
        <div className="flex gap-1.5">
          <Input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void saveKey()}
            placeholder={hasKey ? tr("saved in the keychain — type to replace") : tr("paste your key")}
          />
          <Button variant="outline" disabled={!key.trim()} onClick={() => void saveKey()}>
            <KeyRound className="size-3.5" /> {tr("Save")}
          </Button>
          {hasKey && (
            <Button
              variant="ghost"
              onClick={async () => {
                await ipc.secretDelete(KEY).catch(() => {});
                setHasKey(false);
              }}
            >
              {tr("Remove")}
            </Button>
          )}
        </div>
      </Field>
      <div className="grid grid-cols-3 gap-2">
        <Field label={tr("Max output tokens")}>
          <NumberInput value={a.maxTokens} min={256} max={128000} step={1024} onChange={(maxTokens) => update({ maxTokens: Math.max(256, maxTokens) })} />
        </Field>
        <Field label={tr("Reasoning effort")}>
          <Select
            value={a.effort}
            onChange={(effort) => update({ effort })}
            options={[
              { value: "", label: tr("Provider default") },
              { value: "low", label: tr("Low") },
              { value: "medium", label: tr("Medium") },
              { value: "high", label: tr("High") },
            ]}
          />
        </Field>
        <Field label={tr("Proxy")}>
          <Select<string | null>
            value={a.proxy}
            onChange={(proxy) => update({ proxy })}
            options={[
              { value: null, label: tr("None") },
              { value: SYSTEM_PROXY, label: tr("System proxy") },
              ...proxies.map((p) => ({ value: p.id, label: proxyLabel(p) })),
            ]}
          />
        </Field>
      </div>
      <Field label={tr("Default mode for new conversations")}>
        <AutonomyPicker
          value={a.autonomy}
          onChange={(autonomy) => update({ autonomy })}
          fullWarning="New conversations run every command without asking. Use it where mistakes are cheap."
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button variant="outline" disabled={test.busy || !hasKey} onClick={() => void runTest()}>
          <Zap className={cn("size-3.5", test.busy && "animate-pulse")} /> {test.busy ? tr("Testing…") : tr("Test connection")}
        </Button>
        {!hasKey && <span className="text-[12px] text-muted-foreground">{tr("Save an API key first.")}</span>}
      </div>
      {test.text && (
        <div
          className={cn(
            "rounded-md px-2.5 py-1.5 text-[12px] break-words",
            test.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          {test.text}
        </div>
      )}
      <McpSection />
      <AgentsBoardSection />
    </>
  );
}

// ------------------------------------------------------------------ agents board (experimental)

function AgentsBoardSection() {
  const on = useApp((s) => s.settings.agentsBoard);
  const updateSettings = useApp((s) => s.updateSettings);
  return (
    <div className="mt-2 flex items-center justify-between gap-4 border-t border-ov/[0.07] pt-4">
      <div>
        <div className="flex items-center gap-1.5 text-[13px] font-medium">
          {tr("Agents board")}
          <span className="rounded bg-warning/15 px-1.5 py-px text-[10.5px] font-medium text-warning">{tr("Experimental")}</span>
        </div>
        <div className="text-[12px] text-muted-foreground">
          {tr("Give a goal and several coding agents plan, split, check and report it, sharing a knowledge base. Off: the board, the agent pool and the knowledge base are hidden everywhere and running agents stop; turned back on, they carry on where they were.")}
        </div>
      </div>
      <Switch
        checked={on}
        onChange={(v) => {
          void updateSettings({ agentsBoard: v }).then(() => v && useApp.getState().openAgents());
        }}
      />
    </div>
  );
}

// ------------------------------------------------------------------ MCP server

function McpSection() {
  const m = useApp((s) => s.settings.mcp);
  const updateSettings = useApp((s) => s.updateSettings);
  const update = (patch: Partial<McpSettings>) => void updateSettings({ mcp: { ...m, ...patch } });
  const { listening, error } = useMcpStatus();
  const [host, setHost] = useState(m.host);
  const [port, setPort] = useState(m.port);
  const [show, setShow] = useState(false);
  useEffect(() => {
    setHost(m.host);
    setPort(m.port);
  }, [m.host, m.port]);

  const shownHost = !m.host || m.host === "0.0.0.0" || m.host === "::" ? "127.0.0.1" : m.host;
  const url = `http://${shownHost.includes(":") ? `[${shownHost}]` : shownHost}:${m.port}/mcp`;
  const json = JSON.stringify(
    { mcpServers: { rainterm: { type: "http", url, headers: { Authorization: `Bearer ${m.token}` } } } },
    null,
    2,
  );
  const cli = `claude mcp add --transport http rainterm ${url} --header "Authorization: Bearer ${m.token}"`;
  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    toast({ kind: "success", title: what, duration: 1500 });
  };
  const exposed = m.host.trim() !== "127.0.0.1" && m.host.trim() !== "localhost" && m.host.trim() !== "::1";

  return (
    <div className="mt-2 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3 border-t border-ov/[0.07] pt-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="text-[13px] font-medium">{tr("MCP server")}</div>
          <div className="text-[12px] text-muted-foreground">
            {tr("Lets other agents (Claude Code, Cursor, your own…) use these terminals — commands run visibly here.")}
          </div>
        </div>
        <Switch checked={m.enabled} onChange={(enabled) => update({ enabled })} />
      </div>
      {m.enabled && (
        <>
          <div className="grid grid-cols-[1fr_110px] gap-2">
            <Field label={tr("Listen address")}>
              <Input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                onBlur={() => host.trim() !== m.host && update({ host: host.trim() || "127.0.0.1" })}
                onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                className="font-mono text-[12px]"
              />
            </Field>
            <Field label={tr("Port")}>
              <NumberInput
                value={port}
                min={1}
                max={65535}
                onChange={(v) => {
                  setPort(v);
                  if (v >= 1 && v <= 65535) update({ port: v });
                }}
              />
            </Field>
          </div>
          {exposed && (
            <div className="-mt-1 rounded-md bg-warning/10 px-2.5 py-1.5 text-[11.5px] text-warning">
              {tr("Reachable from other machines on the network — anyone with the token can drive your terminals.")}
            </div>
          )}
          <div
            className={cn(
              "flex items-center gap-2 text-[12px]",
              listening ? "text-success" : error ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span className={cn("size-2 rounded-full", listening ? "bg-success" : error ? "bg-destructive" : "bg-muted-foreground/40")} />
            <span className="min-w-0 break-words">{listening ? tr("Listening on {0}", { 0: listening }) : (error ?? tr("Starting…"))}</span>
          </div>
          <Field label={tr("Token (clients send it as Authorization: Bearer …)")}>
            <div className="flex gap-1.5">
              <Input readOnly value={show ? m.token : "•".repeat(Math.min(32, m.token.length))} className="font-mono text-[12px]" />
              <Button variant="ghost" onClick={() => setShow(!show)}>
                {show ? tr("Hide") : tr("Show")}
              </Button>
              <Button variant="ghost" size="icon" onClick={() => copy(m.token, tr("Copied the token"))}>
                <ClipboardCopy className="size-3.5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={() => update({ token: newToken() })}>
                <RefreshCw className="size-3.5" />
              </Button>
            </div>
          </Field>
          <Field label={tr("What MCP clients may do")}>
            <AutonomyPicker
              value={m.autonomy}
              onChange={(autonomy) => update({ autonomy })}
              fullWarning="MCP clients can run anything in your terminals, open, close and delete sessions without asking."
            />
          </Field>
          <Field label={tr("Tools clients can use")}>
            <McpToolTree m={m} update={update} />
          </Field>
          <Field label={tr("Client setup")} className="min-w-0">
            <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
              <div className="group relative min-w-0">
                <pre className="overflow-x-auto rounded-md bg-inset py-1.5 pr-16 pl-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
                  {show ? cli : cli.replace(m.token, "<token>")}
                </pre>
                <Button size="sm" variant="ghost" className="absolute top-0.5 right-0.5 h-6" onClick={() => copy(cli, tr("Copied the Claude Code command"))}>
                  <ClipboardCopy className="size-3" /> {tr("Copy")}
                </Button>
              </div>
              <div className="group relative min-w-0">
                <pre className="max-h-40 overflow-auto rounded-md bg-inset py-1.5 pr-16 pl-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground select-text">
                  {show ? json : json.replace(m.token, "<token>")}
                </pre>
                <Button size="sm" variant="ghost" className="absolute top-0.5 right-0.5 h-6" onClick={() => copy(json, tr("Copied the JSON config"))}>
                  <ClipboardCopy className="size-3" /> {tr("Copy")}
                </Button>
              </div>
            </div>
          </Field>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ MCP permissions tree

function Tick({ state, disabled, onClick }: { state: boolean | "mixed"; disabled?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={state === "mixed" ? "mixed" : state}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
        state ? "border-primary bg-primary text-primary-foreground" : "border-ov/25 bg-inset hover:border-ov/40",
        disabled && "opacity-40",
      )}
    >
      {state === "mixed" ? <Minus className="size-3" strokeWidth={3} /> : state ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
    </button>
  );
}

function McpToolTree({ m, update }: { m: McpSettings; update: (patch: Partial<McpSettings>) => void }) {
  const agentsOn = useApp((s) => s.settings.agentsBoard);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const set = (names: string[], on: boolean) => {
    const tools = { ...(m.tools ?? {}) };
    for (const n of names) tools[n] = on;
    update({ tools });
  };
  return (
    <div className="overflow-hidden rounded-lg border border-ov/[0.08] bg-inset/40">
      {MCP_GROUPS.filter((g) => agentsOn || g.id !== "knowledge").map((g, gi) => {
        const ons = g.tools.filter((t) => mcpToolOn(m, t.name)).length;
        const state = ons === 0 ? false : ons === g.tools.length ? true : "mixed";
        const expanded = open[g.id] ?? false;
        return (
          <div key={g.id} className={cn(gi > 0 && "border-t border-ov/[0.06]")}>
            <div className="flex items-center gap-2 px-2 py-1.5">
              <button
                type="button"
                onClick={() => setOpen({ ...open, [g.id]: !expanded })}
                className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/[0.06] hover:text-foreground"
              >
                <ChevronRight className={cn("size-3.5 transition-transform duration-150", expanded && "rotate-90")} />
              </button>
              <Tick state={state} onClick={() => set(g.tools.map((t) => t.name), state !== true)} />
              <button type="button" onClick={() => setOpen({ ...open, [g.id]: !expanded })} className="min-w-0 flex-1 text-left">
                <div className="text-[12.5px] font-medium">{tr(g.label)}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {tr(g.hint)}
                </div>
              </button>
              <span className="shrink-0 text-[11px] text-muted-foreground tabular-nums">{`${ons}/${g.tools.length}`}</span>
            </div>
            {expanded && (
              <div className="pb-1.5">
                {g.tools.map((t) => {
                  const on = mcpToolOn(m, t.name);
                  return (
                    <div key={t.name} className="flex items-center gap-2 py-1 pr-2 pl-[52px]">
                      <Tick state={on} onClick={() => set([t.name], !on)} />
                      <span className="text-[12px] text-foreground/90">{tr(t.label)}</span>
                      <code className="font-mono text-[10.5px] text-muted-foreground/70">{t.name}</code>
                      {t.writes && (
                        <span className="ml-auto rounded bg-ov/[0.07] px-1.5 py-px text-[10px] text-muted-foreground">{tr("changes things")}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

const AUTONOMY: { value: AgentAutonomy; label: string; hint: string }[] = [
  { value: "suggest", label: "Suggest", hint: "Only types commands at the prompt — you press Enter" },
  { value: "confirm", label: "Confirm", hint: "Asks before running each command" },
  { value: "auto", label: "Auto", hint: "Runs read-only commands on its own; asks for anything else" },
  { value: "full", label: "Full auto", hint: "Runs everything without asking" },
];

/** The four approval modes, with a line on what the chosen one does. */
function AutonomyPicker({
  value,
  onChange,
  fullWarning,
}: {
  value: AgentAutonomy;
  onChange: (v: AgentAutonomy) => void;
  fullWarning: string;
}) {
  const cur = AUTONOMY.find((x) => x.value === value) ?? AUTONOMY[1];
  return (
    <>
      <Segmented value={value} options={AUTONOMY.map((x) => ({ value: x.value, label: tr(x.label) }))} onChange={onChange} />
      <span className={cn("text-[11.5px]", value === "full" ? "text-destructive" : "text-muted-foreground")}>
        {value === "full" ? tr(fullWarning) : tr(cur.hint)}
      </span>
    </>
  );
}
