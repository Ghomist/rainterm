// Runtime adapters: ACP agents (Claude Code, Codex, opencode, pi, any custom ACP command),
// locally or on a saved SSH host, and the built-in one — the model from Settings → Agent
// driven here with rainterm's own tools (files, shell, terminals).
import { Channel, ipc, type LlmBlock, type LlmConfig, type LlmEvent, type LlmMessage, type LlmToolDef } from "@/lib/ipc";
import { llmConfig } from "@/lib/agent/agent";
import { handle as terminalTool } from "@/lib/mcp";
import { useMcpStatus } from "@/lib/mcp";
import type { AgentAutonomy } from "@/lib/settings";
import { useApp } from "@/store/app";
import { ensureKb, KB_TOOL_NAMES, kbPrompt, kbTools, runKbTool } from "@/lib/kb";
import { AcpConnection, flattenOptions } from "./acp";
import { acpCommand } from "./config";
import { languageRule } from "./llm";
import { pickOption } from "./policy";
import { Child, resolvePath, run, runShell, shQuote } from "./proc";
import type { AgentEvent, ModelOption, PeerConfig, PermissionCeiling, RuntimeConfig, RuntimeProbe, Usage } from "./types";

export interface SessionOptions {
  runtime: RuntimeConfig;
  peer?: Pick<PeerConfig, "model" | "effort">;
  cwd: string;
  ceiling: PermissionCeiling;
  /** How rainterm's terminal tools ask before acting. */
  terminalMode: AgentAutonomy;
  onEvent(e: AgentEvent): void;
  /** A tool call (ACP ToolCall shape: kind, title, rawInput, locations) → allowed? */
  // biome-ignore lint/suspicious/noExplicitAny: ACP tool call payload
  onPermission(toolCall: any): Promise<boolean>;
}

export interface TurnResult {
  text: string;
  /** The answer itself: what the agent wrote after its last tool call (no "I'll start by…"). */
  final?: string;
  stopReason?: string;
  usage: Usage;
}

export interface AgentSession {
  start(): Promise<void>;
  prompt(text: string): Promise<TurnResult>;
  /** Stop the current turn but keep the session (to say something to the agent). */
  interrupt(): Promise<void>;
  cancel(): Promise<void>;
  close(): void;
}

export function createSession(o: SessionOptions): AgentSession {
  return o.runtime.kind === "rainterm" ? new BuiltinSession(o) : new AcpSession(o);
}

// ------------------------------------------------------------------ remote hosts

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The backend session id of a connected terminal on this saved host, connecting one if needed. */
export async function hostSession(profileId: string): Promise<string> {
  const live = () =>
    Object.values(useApp.getState().panes).find((p) => p.profileId === profileId && p.kind === "ssh" && p.status === "connected" && p.session?.sessionId);
  let p = live();
  if (!p) {
    const st = useApp.getState();
    const profile = st.profiles.find((x) => x.id === profileId);
    if (!profile || profile.kind !== "ssh") throw new Error("the saved SSH host for this runtime is gone");
    if (!Object.values(st.panes).some((x) => x.profileId === profileId && x.status === "connecting")) await st.connect(profile);
    for (let i = 0; i < 240 && !(p = live()); i++) await sleep(500);
    if (!p) throw new Error(`couldn't connect to ${profile.name}`);
  }
  return p.session!.sessionId!;
}

async function launch(rt: RuntimeConfig, cwd: string | undefined, conn: AcpConnection): Promise<Child> {
  const cmd = acpCommand(rt);
  if (!cmd) throw new Error(`no launch command for runtime ${rt.id}`);
  const h = { onLine: (l: string) => conn.line(l), onStderr: (s: string) => conn.stderr(s), onExit: (c: number | null) => conn.exit(c) };
  if (rt.remote) {
    const sid = await hostSession(rt.remote.profileId);
    const env = Object.entries(rt.env ?? {})
      .map(([k, v]) => `${k}=${shQuote(v)}`)
      .join(" ");
    const dir = cwd ?? rt.remote.workdir;
    // a login shell, so PATH has node / the agent CLIs
    const inner = [dir ? `cd ${shQuote(dir)} &&` : "", env ? `env ${env}` : "", "exec", ...cmd.map(shQuote)].filter(Boolean).join(" ");
    return Child.remote(sid, `bash -lc ${shQuote(inner)} 2>/dev/null || sh -lc ${shQuote(inner)}`, h);
  }
  return Child.local(cmd, cwd, rt.env, h);
}

// ------------------------------------------------------------------ ACP

/** rainterm's MCP server for an ACP agent: terminals + knowledge, or only the knowledge tools. */
function rainMcp(terminals: boolean): unknown[] {
  const st = useApp.getState().settings.mcp;
  const addr = useMcpStatus.getState().listening;
  if (!st.enabled || !addr) return [];
  const path = terminals ? "/mcp" : "/mcp/kb";
  return [{ type: "http", name: "rainterm", url: `http://${addr}${path}`, headers: [{ name: "Authorization", value: `Bearer ${st.token}` }] }];
}

class AcpSession implements AgentSession {
  private conn: AcpConnection;
  private sessionId?: string;
  private text = "";
  private final = "";
  private buf = { text: "", thinking: "" };
  private timer?: ReturnType<typeof setTimeout>;
  private usage: Usage = {};
  private tools = new Map<string, { title: string; kind?: string }>();

  constructor(private o: SessionOptions) {
    this.conn = new AcpConnection({
      onUpdate: (u) => this.onUpdate(u),
      onPermission: async (req) => {
        this.flush();
        const allow = await this.o.onPermission(req.toolCall);
        const optionId = pickOption(req.options ?? [], allow);
        return optionId ? { outcome: "selected", optionId } : { outcome: "cancelled" };
      },
      onStderr: (s) => {
        if (s.trim()) this.o.onEvent({ t: "stderr", text: s.slice(0, 2000) });
      },
    });
  }

  private flush() {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.buf.thinking) this.o.onEvent({ t: "thinking", text: this.buf.thinking });
    if (this.buf.text) this.o.onEvent({ t: "text", text: this.buf.text });
    this.buf = { text: "", thinking: "" };
  }

  private buffer(kind: "text" | "thinking", s: string) {
    this.buf[kind] += s;
    this.timer ??= setTimeout(() => this.flush(), 250);
  }

  // biome-ignore lint/suspicious/noExplicitAny: ACP session update
  private onUpdate(u: any) {
    if (!u) return;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type === "text") {
          this.text += u.content.text;
          this.final += u.content.text;
          this.buffer("text", u.content.text);
        }
        break;
      case "agent_thought_chunk":
        if (u.content?.type === "text") this.buffer("thinking", u.content.text);
        break;
      case "tool_call":
      case "tool_call_update": {
        this.flush();
        if (u.sessionUpdate === "tool_call") this.final = "";
        const prev = this.tools.get(u.toolCallId) ?? { title: "tool" };
        const title = u.title ?? prev.title;
        const kind = u.kind ?? prev.kind;
        this.tools.set(u.toolCallId, { title, kind });
        this.o.onEvent({ t: "tool", id: u.toolCallId, title, kind, status: u.status ?? "pending", detail: toolDetail(u) });
        break;
      }
      case "plan":
        // biome-ignore lint/suspicious/noExplicitAny: ACP plan entry
        this.o.onEvent({ t: "plan", items: (u.entries ?? []).map((e: any) => ({ content: e.content, status: e.status })) });
        break;
      case "usage_update":
        this.usage = {
          ...this.usage,
          contextUsed: u.used,
          contextSize: u.size,
          costUsd: u.cost?.currency === "USD" ? u.cost.amount : this.usage.costUsd,
        };
        this.o.onEvent({ t: "usage", usage: this.usage });
        break;
    }
  }

  async start() {
    const rt = this.o.runtime;
    this.conn.attach(await launch(rt, rt.remote ? undefined : this.o.cwd, this.conn));
    // biome-ignore lint/suspicious/noExplicitAny: ACP responses
    const init: any = await this.conn.initialize();
    await ensureKb();
    // A remote agent can't reach the listener on this computer.
    const mcp = !rt.remote && init?.agentCapabilities?.mcpCapabilities?.http ? rainMcp(this.o.ceiling.terminals) : [];
    // biome-ignore lint/suspicious/noExplicitAny: ACP responses
    const s: any = await this.conn.request("session/new", { cwd: this.o.cwd, mcpServers: mcp }, 180_000);
    this.sessionId = s.sessionId;
    this.o.onEvent({
      t: "start",
      info: `${init?.agentInfo?.title ?? init?.agentInfo?.name ?? rt.kind} ${init?.agentInfo?.version ?? ""}`.trim(),
    });
    // biome-ignore lint/suspicious/noExplicitAny: ACP config options
    const opts: any[] = s.configOptions ?? [];
    const set = async (category: string, value?: string) => {
      if (!value) return;
      const opt = opts.find((x) => x.category === category) ?? opts.find((x) => x.id === category);
      if (!opt) {
        if (category === "model" && s.models)
          await this.conn.request("session/set_model", { sessionId: s.sessionId, modelId: value }, 30_000).catch(() => {});
        return;
      }
      await this.conn.request("session/set_config_option", { sessionId: s.sessionId, configId: opt.id, value }, 30_000);
    };
    await set("model", this.o.peer?.model);
    await set("thought_level", this.o.peer?.effort);
    // Claude Code: route every sensitive action through the policy.
    if (rt.kind === "claude-code") {
      const mode = opts.find((x) => x.category === "mode");
      if (mode && flattenOptions(mode.options).some((v) => v.value === "default")) await set("mode", "default");
    }
  }

  async prompt(text: string): Promise<TurnResult> {
    this.text = "";
    this.final = "";
    // biome-ignore lint/suspicious/noExplicitAny: ACP responses
    const r: any = await this.conn.request("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] });
    this.flush();
    if (r?.usage)
      this.usage = {
        ...this.usage,
        inputTokens: (this.usage.inputTokens ?? 0) + (r.usage.inputTokens ?? 0),
        outputTokens: (this.usage.outputTokens ?? 0) + (r.usage.outputTokens ?? 0),
      };
    this.o.onEvent({ t: "usage", usage: this.usage });
    return { text: this.text, final: this.final, stopReason: r?.stopReason, usage: this.usage };
  }

  async cancel() {
    if (this.sessionId) this.conn.notify("session/cancel", { sessionId: this.sessionId });
    setTimeout(() => this.close(), 3000);
  }

  async interrupt() {
    if (this.sessionId) this.conn.notify("session/cancel", { sessionId: this.sessionId });
  }

  close() {
    this.flush();
    this.conn.close();
  }
}

// biome-ignore lint/suspicious/noExplicitAny: ACP tool call update
function toolDetail(u: any): string | undefined {
  const parts: string[] = [];
  const ri = u.rawInput;
  if (ri && typeof ri === "object" && Object.keys(ri).length) {
    const cmd = ri.command ?? ri.cmd ?? ri.file_path ?? ri.filePath ?? ri.path ?? ri.pattern ?? ri.url;
    parts.push(cmd ? String(cmd) : JSON.stringify(ri).slice(0, 300));
  }
  for (const l of u.locations ?? []) if (l?.path && !parts.some((p) => p.includes(l.path))) parts.push(l.path);
  for (const c of u.content ?? []) {
    if (c?.type === "content" && c.content?.type === "text") parts.push(String(c.content.text).slice(0, 600));
    else if (c?.type === "diff") parts.push(`diff ${c.path}`);
  }
  return parts.length ? parts.join("\n").slice(0, 1200) : undefined;
}

// ------------------------------------------------------------------ built-in (rainterm model)

const S = (props: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties: props,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: "string", description });
const TERM = str("Terminal id from list_terminals (default: the one the user is looking at).");

function builtinTools(c: PermissionCeiling): LlmToolDef[] {
  const t: LlmToolDef[] = [];
  if (c.fs !== "none") {
    t.push(
      {
        name: "read_file",
        description: "Read a text file (path relative to the working directory, or absolute). Returns numbered lines.",
        inputSchema: S({ path: str("File path"), offset: { type: "number", description: "First line (1-based)" }, limit: { type: "number", description: "Max lines (default 400)" } }, ["path"]),
      },
      { name: "list_dir", description: "List a directory (default: the working directory).", inputSchema: S({ path: str("Directory path") }) },
      {
        name: "search",
        description: "Search file contents with a regular expression (git grep). Returns file:line:text, at most 200 matches.",
        inputSchema: S({ pattern: str("Extended regular expression"), path: str("Folder or file to search (default: working directory)") }, ["pattern"]),
      },
    );
  }
  if (c.fs === "workspace" || c.fs === "any") {
    t.push(
      { name: "write_file", description: "Create or overwrite a text file.", inputSchema: S({ path: str("File path"), content: str("Full new content") }, ["path", "content"]) },
      {
        name: "edit_file",
        description: "Replace one exact occurrence of old_text with new_text in a file (old_text must be unique).",
        inputSchema: S({ path: str("File path"), old_text: str("Exact text to replace"), new_text: str("Replacement") }, ["path", "old_text", "new_text"]),
      },
    );
  }
  if (c.shell !== "none")
    t.push({
      name: "shell",
      description: `Run a command with bash in the working directory (Git Bash on Windows) and return exit code and output.${c.shell === "readonly" ? " Read-only commands only." : ""} Non-interactive commands only.`,
      inputSchema: S({ command: str("Command line"), timeout_seconds: { type: "number", description: "Default 120, max 900" } }, ["command"]),
    });
  if (c.terminals)
    t.push(
      { name: "list_terminals", description: "List the terminals open in rainterm: id, title, kind, host, whether at a prompt.", inputSchema: S({}) },
      { name: "list_hosts", description: "List saved sessions (SSH hosts, serial ports) and local shells that open_terminal can open.", inputSchema: S({}) },
      {
        name: "open_terminal",
        description: "Open a terminal: a saved session (id or name from list_hosts) or a local shell. Returns its terminal id once connected.",
        inputSchema: S({ session: str("Saved session id or name"), shell: str("Local shell id or name") }),
      },
      {
        name: "run_command",
        description: "Type a command into a terminal and press Enter, visibly; wait for it to finish and return output and exit code. Risky commands need the user's OK. Non-interactive, bounded commands only.",
        inputSchema: S({ command: str("Command"), terminal: TERM, timeout_seconds: { type: "number", description: "Default 30, max 600" } }, ["command"]),
      },
      { name: "read_terminal", description: "Read the last lines of a terminal.", inputSchema: S({ terminal: TERM, lines: { type: "number", description: "Default 60" } }) },
      {
        name: "send_keys",
        description: "Send keys to a terminal: text as is, special keys like <Enter> <C-c> <Esc> <Up>. Returns the screen.",
        inputSchema: S({ keys: str("Keys"), terminal: TERM }, ["keys"]),
      },
    );
  return t;
}

const TERMINAL_TOOLS = new Set(["list_terminals", "list_hosts", "open_terminal", "run_command", "read_terminal", "send_keys"]);

class BuiltinSession implements AgentSession {
  private messages: LlmMessage[] = [];
  private llmId = `forge-${Math.random().toString(36).slice(2)}`;
  private cancelled = false;
  private usage: Usage = { inputTokens: 0, outputTokens: 0 };
  private config!: LlmConfig;
  private tools: LlmToolDef[];

  constructor(private o: SessionOptions) {
    this.tools = builtinTools(o.ceiling);
  }

  async start() {
    await ensureKb();
    this.tools = [...builtinTools(this.o.ceiling), ...kbTools()];
    const base = await llmConfig();
    this.config = { ...base, model: this.o.peer?.model || base.model, effort: this.o.peer?.effort || base.effort };
    this.o.onEvent({ t: "start", info: `rainterm · ${this.config.model}` });
  }

  private system() {
    return `You are an autonomous agent working for the user of the rainterm terminal app. Working directory: ${this.o.cwd}
Use the tools to inspect and act; be concise in prose. Never type passwords or secrets. When the task is done, give your final answer in the format requested.
${kbPrompt()}
${languageRule()}`;
  }

  private chat(): Promise<LlmBlock[] | null> {
    return new Promise((resolve, reject) => {
      const blocks: LlmBlock[] = [];
      const ch = new Channel<LlmEvent>();
      ch.onmessage = (ev) => {
        if (ev.type === "textDelta") this.o.onEvent({ t: "text", text: ev.text });
        else if (ev.type === "thinkingDelta") this.o.onEvent({ t: "thinking", text: ev.text });
        else if (ev.type === "block") blocks.push(ev.block);
        else if (ev.type === "done") {
          this.usage = { inputTokens: (this.usage.inputTokens ?? 0) + ev.inputTokens, outputTokens: (this.usage.outputTokens ?? 0) + ev.outputTokens };
          this.o.onEvent({ t: "usage", usage: this.usage });
          resolve(blocks);
        } else if (ev.type === "error") reject(new Error(ev.message));
      };
      ipc.llmChat(this.llmId, this.config, { system: this.system(), messages: this.messages, tools: this.tools }, ch).catch(reject);
    });
  }

  async prompt(text: string): Promise<TurnResult> {
    this.turnStop = false;
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    let final = "";
    for (let turn = 0; turn < 80 && !this.cancelled && !this.turnStop; turn++) {
      let blocks: LlmBlock[] | null;
      try {
        blocks = await this.chat();
      } catch (e) {
        if (this.turnStop) break;
        throw e;
      }
      if (!blocks || this.cancelled || this.turnStop) break;
      this.messages.push({ role: "assistant", content: blocks });
      final = blocks.map((b) => (b.type === "text" ? b.text : "")).join("");
      const calls = blocks.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (!calls.length) break;
      const results: LlmBlock[] = [];
      for (const c of calls) results.push(await this.runTool(c));
      this.messages.push({ role: "user", content: results });
    }
    // a tool call left without its result would break the next request
    const last = this.messages[this.messages.length - 1];
    if (this.turnStop && last?.role === "assistant" && last.content.some((b) => b.type === "tool_use"))
      this.messages.push({
        role: "user",
        content: last.content
          .filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use")
          .map((b) => ({ type: "tool_result", tool_use_id: b.id, content: "Interrupted.", is_error: true }) as LlmBlock),
      });
    return { text: final, final, stopReason: this.cancelled || this.turnStop ? "cancelled" : "end_turn", usage: this.usage };
  }

  private async runTool(call: Extract<LlmBlock, { type: "tool_use" }>): Promise<LlmBlock> {
    const a = call.input as Record<string, unknown>;
    const res = (content: string, is_error = false): LlmBlock => ({ type: "tool_result", tool_use_id: call.id, content: content.slice(0, 60_000), is_error });
    const p = (x: unknown) => resolvePath(this.o.cwd, String(x ?? "."));
    const kinds: Record<string, string> = { read_file: "read", list_dir: "read", search: "search", write_file: "edit", edit_file: "edit", shell: "execute" };
    const title =
      call.name === "shell" || call.name === "run_command"
        ? String(a.command ?? "")
        : call.name === "search"
          ? `search ${a.pattern}`
          : `${call.name} ${String(a.path ?? a.terminal ?? a.session ?? "")}`.trim();
    const tc = {
      toolCallId: call.id,
      kind: TERMINAL_TOOLS.has(call.name) ? "other" : kinds[call.name] ?? "other",
      name: TERMINAL_TOOLS.has(call.name) ? `rainterm.${call.name}` : call.name,
      title,
      rawInput: a,
      locations: a.path != null ? [{ path: p(a.path) }] : [],
    };
    if (KB_TOOL_NAMES.has(call.name)) {
      // Reading the user's own notes needs no permission.
      const t =
        call.name === "search_knowledge"
          ? `search knowledge: ${a.query ?? ""}`
          : call.name === "save_knowledge"
            ? `save to knowledge: ${a.title ?? ""}`
            : `read note ${a.id ?? ""}`;
      this.o.onEvent({ t: "tool", id: call.id, title: t, kind: "search", status: "in_progress" });
      try {
        const out = await runKbTool(call.name, a);
        this.o.onEvent({ t: "tool", id: call.id, title: t, kind: "search", status: "completed", detail: out.slice(0, 1200) });
        return res(out);
      } catch (e) {
        this.o.onEvent({ t: "tool", id: call.id, title: t, kind: "search", status: "failed", detail: String(e) });
        return res(String(e), true);
      }
    }
    this.o.onEvent({ t: "tool", id: call.id, title, kind: tc.kind, status: "pending" });
    const end = (status: "completed" | "failed", detail?: string) =>
      this.o.onEvent({ t: "tool", id: call.id, title, kind: tc.kind, status, detail: detail?.slice(0, 1200) });
    if (!(await this.o.onPermission(tc))) {
      end("failed", "declined");
      return res("Not allowed (declined by policy or the user).", true);
    }
    this.o.onEvent({ t: "tool", id: call.id, title, kind: tc.kind, status: "in_progress" });
    try {
      let out: string;
      switch (call.name) {
        case "read_file": {
          const lines = (await ipc.fileReadText(p(a.path), 1024 * 1024)).split("\n");
          const from = Math.max(1, Number(a.offset) || 1);
          const n = Math.min(2000, Math.max(1, Number(a.limit) || 400));
          out = lines
            .slice(from - 1, from - 1 + n)
            .map((l, i) => `${from + i}\t${l}`)
            .join("\n");
          if (from - 1 + n < lines.length) out += `\n… (${lines.length} lines total)`;
          break;
        }
        case "list_dir": {
          const l = await ipc.fsList({ kind: "local" }, p(a.path));
          out = l.entries.map((e) => (e.kind === "dir" ? `${e.name}/` : `${e.name}  ${e.size}`)).join("\n") || "(empty)";
          break;
        }
        case "search": {
          const r = await run(["git", "grep", "--no-index", "-n", "-I", "-E", "--max-count=50", "-e", String(a.pattern), "--", p(a.path)], {
            cwd: this.o.cwd,
            timeoutMs: 60_000,
          });
          out = r.stdout.split("\n").slice(0, 200).join("\n") || (r.code === 1 ? "(no matches)" : r.stderr);
          break;
        }
        case "write_file":
          await writeText(p(a.path), String(a.content ?? ""));
          out = "Written.";
          break;
        case "edit_file": {
          const path = p(a.path);
          const text = await ipc.fileReadText(path, 1024 * 1024);
          const old = String(a.old_text ?? "");
          const n = old ? text.split(old).length - 1 : 0;
          if (n !== 1) throw new Error(n ? `old_text occurs ${n} times; make it unique` : "old_text not found");
          await writeText(path, text.replace(old, () => String(a.new_text ?? "")));
          out = "Edited.";
          break;
        }
        case "shell": {
          const t = Math.min(900, Math.max(1, Number(a.timeout_seconds) || 120)) * 1000;
          const r = await runShell(String(a.command ?? ""), this.o.cwd, t);
          const body = `${r.stdout}${r.stderr ? `\n[stderr]\n${r.stderr}` : ""}`.trim();
          out = `exit ${r.code}\n${body.length > 20_000 ? `${body.slice(0, 8000)}\n…\n${body.slice(-12_000)}` : body}`;
          break;
        }
        default:
          if (!TERMINAL_TOOLS.has(call.name)) throw new Error(`unknown tool ${call.name}`);
          out = await terminalTool(call.name, a, this.o.terminalMode);
      }
      end("completed", out);
      return res(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      end("failed", msg);
      return res(msg, true);
    }
  }

  async cancel() {
    this.cancelled = true;
    await ipc.llmCancel(this.llmId).catch(() => false);
  }

  private turnStop = false;
  async interrupt() {
    this.turnStop = true;
    await ipc.llmCancel(this.llmId).catch(() => false);
  }

  close() {
    void ipc.llmCancel(this.llmId).catch(() => false);
  }
}

const writeText = (path: string, text: string) => ipc.fileWriteText(path, text);

// ------------------------------------------------------------------ probing

const CLAUDE_EFFORTS: ModelOption[] = ["low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, name: v }));

export async function probeRuntime(rt: RuntimeConfig, cwd: string): Promise<RuntimeProbe> {
  const base = { runtime: rt.id, probedAt: new Date().toISOString(), models: [] as ModelOption[], efforts: [] as ModelOption[] };
  if (rt.kind === "rainterm") {
    const a = useApp.getState().settings.agent;
    if (!a.model.trim()) return { ...base, ok: false, error: "No model set — choose one in Settings → Agent" };
    return { ...base, ok: true, version: `${a.format} · ${a.model}`, models: [{ value: a.model, name: a.model }], efforts: CLAUDE_EFFORTS };
  }
  let stderr = "";
  const conn = new AcpConnection({ onUpdate() {}, onPermission: async () => ({ outcome: "cancelled" }), onStderr: (s) => (stderr += s) });
  try {
    conn.attach(await launch(rt, rt.remote ? undefined : cwd, conn));
    // biome-ignore lint/suspicious/noExplicitAny: ACP responses
    const init: any = await conn.initialize();
    // biome-ignore lint/suspicious/noExplicitAny: ACP responses
    const s: any = await conn.request("session/new", { cwd: rt.remote ? (rt.remote.workdir ?? "/tmp") : cwd, mcpServers: [] }, 180_000);
    // biome-ignore lint/suspicious/noExplicitAny: ACP config options
    const opts: any[] = s.configOptions ?? [];
    const model = opts.find((o) => o.category === "model");
    const effort = opts.find((o) => o.category === "thought_level");
    let models = flattenOptions(model?.options);
    if (!models.length && s.models?.availableModels)
      // biome-ignore lint/suspicious/noExplicitAny: ACP model entry
      models = s.models.availableModels.map((m: any) => ({ value: m.modelId, name: m.name ?? m.modelId }));
    return {
      ...base,
      ok: true,
      version: `${init?.agentInfo?.name ?? ""} ${init?.agentInfo?.version ?? ""}`.trim(),
      models,
      efforts: flattenOptions(effort?.options),
    };
  } catch (e) {
    const msg = conn.exitError && conn.exitError !== "closed" ? conn.exitError : e instanceof Error ? e.message : String(e);
    return { ...base, ok: false, error: msg.slice(0, 600) + (stderr && !msg.includes(stderr.trim().slice(-200)) ? `\n${stderr.slice(-400)}` : "") };
  } finally {
    conn.close();
  }
}
