// The built-in terminal agent. One conversation per pane; it sees what you see in that
// pane (recent screen, command blocks) and acts by typing into it. The loop:
//   user text → model (streamed) → tool calls → run them in the pane → results → model …
// Autonomy: "suggest" only types commands for you to run; "confirm" asks before every
// command; "auto" runs read-only commands straight away and asks for anything else.
// Typing in the terminal yourself interrupts it.
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { Channel, ipc, type LlmBlock, type LlmConfig, type LlmEvent, type LlmMessage, type LlmToolDef } from "@/lib/ipc";
import type { AgentAutonomy } from "@/lib/settings";
import type { TermSession } from "@/lib/term-session";
import { useApp } from "@/store/app";
import { proxyUrl } from "@/lib/proxy-url";
import { atPrompt, isReadOnly, keysToBytes, readScreen, runCommand, truncate } from "./terminal";
import { tr } from "@/lib/i18n";
import { ensureKb, KB_TOOL_NAMES, kbPrompt, kbToolLabel, kbTools, runKbTool } from "@/lib/kb";

// ------------------------------------------------------------------ state

export type Step =
  | { kind: "user"; id: string; text: string }
  | { kind: "thinking"; id: string; text: string; ms: number; live: boolean }
  | { kind: "text"; id: string; text: string; live: boolean }
  | {
      kind: "tool";
      id: string;
      tool: string;
      /** What it does, one line ("ls -la", "keys: q"). */
      label: string;
      state: "pending" | "approval" | "running" | "done" | "error" | "declined";
      result?: string;
      exitCode?: number | null;
    }
  | { kind: "error"; id: string; text: string }
  | { kind: "note"; id: string; text: string };

export type AgentStatus = "idle" | "thinking" | "acting" | "approval" | "error";

export interface AgentThread {
  paneId: string;
  steps: Step[];
  messages: LlmMessage[];
  status: AgentStatus;
  /** One line about what it's doing right now. */
  activity: string;
  autonomy: AgentAutonomy;
  /** The tool call waiting for a yes/no. */
  approval: { stepId: string; command: string; resolve: (ok: boolean, why?: string) => void } | null;
  /** Agent is typing into the terminal right now. */
  typing: boolean;
  tokens: { input: number; output: number };
  /** Bar open (input focused) in this pane. */
  open: boolean;
  /** Something finished while the bar was closed. */
  unseen: boolean;
  /** px the terminal view is lifted so the inline agent lines fit under the cursor. */
  shift: number;
}

interface AgentStore {
  threads: Record<string, AgentThread>;
}

// Kept across dev hot updates: modules that weren't re-run (App's shortcut handler, say)
// must keep talking to the same store as the UI.
export const useAgent: UseBoundStore<StoreApi<AgentStore>> =
  import.meta.hot?.data.useAgent ?? create<AgentStore>(() => ({ threads: {} }));
if (import.meta.hot) import.meta.hot.data.useAgent = useAgent;

const uid = () => Math.random().toString(36).slice(2, 10);

function thread(paneId: string): AgentThread {
  const t = useAgent.getState().threads[paneId];
  if (t) return t;
  const fresh: AgentThread = {
    paneId,
    steps: [],
    messages: [],
    status: "idle",
    activity: "",
    autonomy: useApp.getState().settings.agent.autonomy,
    approval: null,
    typing: false,
    tokens: { input: 0, output: 0 },
    open: false,
    unseen: false,
    shift: 0,
  };
  useAgent.setState((s) => ({ threads: { ...s.threads, [paneId]: fresh } }));
  return fresh;
}

export function patchThread(paneId: string, patch: Partial<AgentThread> | ((t: AgentThread) => Partial<AgentThread>)) {
  useAgent.setState((s) => {
    const t = s.threads[paneId] ?? thread(paneId);
    const p = typeof patch === "function" ? patch(t) : patch;
    return { threads: { ...s.threads, [paneId]: { ...t, ...p } } };
  });
}

function patchStep(paneId: string, id: string, patch: Partial<Step>) {
  patchThread(paneId, (t) => ({ steps: t.steps.map((s) => (s.id === id ? ({ ...s, ...patch } as Step) : s)) }));
}

function addStep(paneId: string, step: Step) {
  patchThread(paneId, (t) => ({ steps: [...t.steps, step] }));
}

export function setAgentOpen(paneId: string, open: boolean) {
  thread(paneId);
  patchThread(paneId, open ? { open, unseen: false } : { open, shift: 0 });
}

export function resetThread(paneId: string) {
  stopAgent(paneId);
  useAgent.setState((s) => {
    const { [paneId]: _, ...rest } = s.threads;
    return { threads: rest };
  });
  thread(paneId);
  patchThread(paneId, { open: true });
}

// ------------------------------------------------------------------ config

/** Settings → request config (proxy resolved to a URL with its password). */
export async function llmConfig(): Promise<LlmConfig> {
  const st = useApp.getState().settings;
  const a = st.agent;
  if (!a.model.trim()) throw new Error("No model set — choose one in Settings → Agent");
  const proxy = await proxyUrl(a.proxy, st.proxies);
  return {
    format: a.format,
    baseUrl: a.baseUrl.trim(),
    model: a.model.trim(),
    maxTokens: a.maxTokens,
    effort: a.effort || null,
    proxy,
  };
}

// ------------------------------------------------------------------ tools

const TOOLS: LlmToolDef[] = [
  {
    name: "run_command",
    description:
      "Type a command into the user's terminal and press Enter, then wait for it to finish. Returns the output (long output is cut to its head and tail) and the exit code when the shell reports it. The user watches it happen. Use non-interactive forms: no pagers (add --no-pager or | cat), no editors, no full-screen programs; bound long-running commands (e.g. tail -n, -c for ping, timeout).",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "One command line for the current shell." },
        timeout_seconds: { type: "number", description: "How long to wait for it (default 30, max 600)." },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_terminal",
    description:
      "Read what is on the terminal now: the last lines before the cursor, or the whole screen when a full-screen program (vim, htop, less…) is open. Use it to check on a command that was still running, or to look at earlier output.",
    inputSchema: {
      type: "object",
      properties: { lines: { type: "number", description: "How many lines back (default 60, max 300)." } },
      additionalProperties: false,
    },
  },
  {
    name: "send_keys",
    description:
      "Send keystrokes to the terminal, e.g. to answer a prompt, quit a program or interrupt one. Plain text is typed as is; special keys in angle brackets: <Enter> <Tab> <Esc> <Up> <Down> <Left> <Right> <Backspace> <C-c> <C-d> <C-z>. Returns the screen afterwards.",
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string" } },
      required: ["keys"],
      additionalProperties: false,
    },
  },
];

function systemPrompt(s: TermSession, autonomy: AgentAutonomy, title: string, subtitle: string) {
  const src = s.source;
  const where =
    src.kind === "local"
      ? `a local ${src.shell.name} shell on the user's ${navigator.userAgent.includes("Windows") ? "Windows" : navigator.userAgent.includes("Mac") ? "macOS" : "Linux"} computer`
      : src.kind === "ssh"
        ? `an SSH session to ${subtitle} (a remote machine)`
        : `a serial console (${subtitle})`;
  const mode = {
    suggest:
      "Mode SUGGEST: run_command only types the command at the prompt without running it; the user decides. Prefer finishing with one well-chosen command typed for them, and explain briefly what it does. read_terminal is fine.",
    confirm: "Mode CONFIRM: every run_command / send_keys is shown to the user to approve first. If one is declined, adapt or ask.",
    auto: "Mode AUTO: read-only commands run straight away; anything that changes something is shown to the user to approve first.",
  }[autonomy];
  return [
    `You are the assistant built into rainterm, a terminal emulator. You work inside one terminal pane, "${title}": ${where}. You see what the user sees there and act by typing into it with your tools; the user watches every keystroke and can interrupt you by typing.`,
    mode,
    "Work in small, safe steps: look before you change things, prefer read-only checks, never run destructive commands (deleting data, restarting services, force pushes…) unless the user clearly asked for exactly that. Don't type passwords or secrets; if a command asks for one, stop and tell the user.",
    "Keep commands non-interactive and bounded. If a command is still running when the tool returns, read_terminal later or interrupt it with send_keys <C-c> if it is stuck.",
    "Answer in the user's language. Be brief: a few sentences or a short list; code and commands in backticks or fenced blocks. Don't repeat output the user can already see in the terminal — summarize what matters.",
    kbPrompt(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ------------------------------------------------------------------ the loop

const runs: Map<string, { abort: AbortController; llmId: string | null }> = import.meta.hot?.data.runs ?? new Map();
if (import.meta.hot) import.meta.hot.data.runs = runs;

export function stopAgent(paneId: string, why?: string) {
  const r = runs.get(paneId);
  if (!r) return;
  r.abort.abort();
  if (r.llmId) void ipc.llmCancel(r.llmId);
  const t = useAgent.getState().threads[paneId];
  t?.approval?.resolve(false, "stopped");
  if (why) addStep(paneId, { kind: "note", id: uid(), text: why });
}

export function answerApproval(paneId: string, ok: boolean, why?: string) {
  const t = useAgent.getState().threads[paneId];
  t?.approval?.resolve(ok, why);
}

export function setAutonomy(paneId: string, autonomy: AgentAutonomy) {
  thread(paneId);
  patchThread(paneId, { autonomy });
}

export async function ask(paneId: string, text: string) {
  const pane = useApp.getState().panes[paneId];
  if (!pane?.session || runs.has(paneId)) return;
  const s = pane.session;
  thread(paneId);
  const abort = new AbortController();
  const run = { abort, llmId: null as string | null };
  runs.set(paneId, run);

  // You typing in the terminal takes over from the agent.
  const offKeys = s.onUserKeys((data) => {
    // The terminal's own replies (focus in/out, cursor / device reports) aren't keystrokes.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences
    if (/^(?:\x1b\[[\d;?>]*[Rcn]|\x1b\[[IO]|\x1b\][^]*|\x1bP[^]*)+$/.test(data)) return;
    stopAgent(paneId, "Stopped — you typed in the terminal.");
  });

  // What's on screen goes along with the question ("what does this error mean?").
  const screen = readScreen(s, 40);
  const userContent = `${text}\n\n<terminal_screen note="what the user currently sees in this pane, most recent last">\n${screen}\n</terminal_screen>`;
  addStep(paneId, { kind: "user", id: uid(), text });
  patchThread(paneId, (t) => ({
    messages: [...t.messages, { role: "user", content: [{ type: "text", text: userContent }] }],
    status: "thinking",
    activity: tr("Thinking…"),
    unseen: false,
  }));

  try {
    const config = await llmConfig();
    await ensureKb();
    for (let turn = 0; turn < 30 && !abort.signal.aborted; turn++) {
      const t = useAgent.getState().threads[paneId];
      const assistant = await callModel(paneId, run, config, {
        system: systemPrompt(s, t.autonomy, pane.title, pane.subtitle),
        messages: t.messages,
        tools: [...TOOLS, ...kbTools()],
      });
      if (!assistant || abort.signal.aborted) break;
      patchThread(paneId, (th) => ({ messages: [...th.messages, { role: "assistant", content: assistant.blocks }] }));
      const calls = assistant.blocks.filter((b): b is Extract<LlmBlock, { type: "tool_use" }> => b.type === "tool_use");
      if (!calls.length) break;
      const results: LlmBlock[] = [];
      for (const call of calls) {
        if (abort.signal.aborted) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: "Stopped by the user.", is_error: true });
          continue;
        }
        results.push(await runTool(paneId, s, call, abort.signal));
      }
      patchThread(paneId, (th) => ({ messages: [...th.messages, { role: "user", content: results }] }));
    }
  } catch (e) {
    addStep(paneId, { kind: "error", id: uid(), text: String(e instanceof Error ? e.message : e) });
    patchThread(paneId, { status: "error" });
  } finally {
    offKeys();
    runs.delete(paneId);
    patchThread(paneId, (t) => ({
      status: t.status === "error" ? "error" : "idle",
      activity: "",
      approval: null,
      typing: false,
      unseen: !t.open,
      // A run cut short mid-tool-call must still leave a valid conversation.
      messages: closeDangling(t.messages),
    }));
  }
}

/** If the last assistant message has tool calls without results, answer them. */
function closeDangling(messages: LlmMessage[]): LlmMessage[] {
  const last = messages.at(-1);
  if (!last || last.role !== "assistant") return messages;
  const calls = last.content.filter((b) => b.type === "tool_use") as Extract<LlmBlock, { type: "tool_use" }>[];
  if (!calls.length) return messages;
  return [
    ...messages,
    {
      role: "user",
      content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "Stopped by the user.", is_error: true })),
    },
  ];
}

function callModel(
  paneId: string,
  run: { abort: AbortController; llmId: string | null },
  config: LlmConfig,
  request: { system: string; messages: LlmMessage[]; tools: LlmToolDef[] },
): Promise<{ blocks: LlmBlock[] } | null> {
  return new Promise((resolve, reject) => {
    const llmId = uid();
    run.llmId = llmId;
    const blocks: LlmBlock[] = [];
    let textStep: string | null = null;
    let thinkStep: string | null = null;
    let thinkStart = 0;
    const endThinking = () => {
      if (!thinkStep) return;
      patchStep(paneId, thinkStep, { live: false, ms: performance.now() - thinkStart } as Partial<Step>);
      thinkStep = null;
    };
    const ch = new Channel<LlmEvent>();
    ch.onmessage = (ev) => {
      if (run.abort.signal.aborted) return;
      switch (ev.type) {
        case "thinkingDelta":
          if (!thinkStep) {
            thinkStep = uid();
            thinkStart = performance.now();
            addStep(paneId, { kind: "thinking", id: thinkStep, text: "", ms: 0, live: true });
            patchThread(paneId, { status: "thinking", activity: tr("Thinking…") });
          }
          patchThread(paneId, (t) => ({
            steps: t.steps.map((s) => (s.id === thinkStep && s.kind === "thinking" ? { ...s, text: s.text + ev.text } : s)),
          }));
          break;
        case "textDelta":
          endThinking();
          if (!textStep) {
            textStep = uid();
            addStep(paneId, { kind: "text", id: textStep, text: "", live: true });
            patchThread(paneId, { activity: tr("Writing…") });
          }
          patchThread(paneId, (t) => ({
            steps: t.steps.map((s) => (s.id === textStep && s.kind === "text" ? { ...s, text: s.text + ev.text } : s)),
          }));
          break;
        case "block":
          blocks.push(ev.block);
          if (ev.block.type !== "thinking") endThinking();
          if (ev.block.type === "text") textStep = null;
          break;
        case "done":
          endThinking();
          patchThread(paneId, (t) => ({
            tokens: { input: t.tokens.input + ev.inputTokens, output: t.tokens.output + ev.outputTokens },
            steps: t.steps.map((s) => (s.kind === "text" && s.live ? { ...s, live: false } : s)),
          }));
          if (ev.stopReason === "max_tokens") addStep(paneId, { kind: "note", id: uid(), text: "The reply hit the output limit (Settings → Agent → max tokens)." });
          resolve({ blocks });
          break;
        case "error":
          endThinking();
          reject(new Error(ev.message));
          break;
      }
    };
    run.abort.signal.addEventListener("abort", () => resolve(null), { once: true });
    ipc.llmChat(llmId, config, request, ch).catch(reject);
  });
}

async function approve(paneId: string, stepId: string, command: string): Promise<{ ok: boolean; why?: string }> {
  return new Promise((resolve) => {
    patchStep(paneId, stepId, { state: "approval" });
    patchThread(paneId, {
      status: "approval",
      activity: tr("Waiting for your OK"),
      approval: { stepId, command, resolve: (ok, why) => resolve({ ok, why }) },
    });
  }).finally(() => patchThread(paneId, { approval: null })) as Promise<{ ok: boolean; why?: string }>;
}

async function runTool(
  paneId: string,
  s: TermSession,
  call: Extract<LlmBlock, { type: "tool_use" }>,
  signal: AbortSignal,
): Promise<LlmBlock> {
  const res = (content: string, is_error = false): LlmBlock => ({ type: "tool_result", tool_use_id: call.id, content, is_error });
  const input = call.input as Record<string, unknown>;
  const stepId = uid();
  const autonomy = useAgent.getState().threads[paneId]?.autonomy ?? "confirm";
  if ("__invalid_json" in input) return res("Tool input was not valid JSON; try again.", true);

  if (KB_TOOL_NAMES.has(call.name)) {
    const label = kbToolLabel(call.name, input);
    addStep(paneId, { kind: "tool", id: stepId, tool: call.name, label, state: "running" });
    try {
      const out = await runKbTool(call.name, input);
      patchStep(paneId, stepId, { state: "done", result: out });
      return res(out);
    } catch (e) {
      patchStep(paneId, stepId, { state: "error", result: String(e) });
      return res(String(e), true);
    }
  }

  if (call.name === "read_terminal") {
    const n = Math.min(300, Math.max(5, Number(input.lines) || 60));
    addStep(paneId, { kind: "tool", id: stepId, tool: call.name, label: `read ${n} lines`, state: "done" });
    return res(readScreen(s, n) || "(empty)");
  }

  if (call.name === "send_keys") {
    const keys = String(input.keys ?? "");
    addStep(paneId, { kind: "tool", id: stepId, tool: call.name, label: keys, state: "pending" });
    // Keys go to whatever is running (they could confirm a prompt): ask, except for plain
    // "get out" keys in auto mode.
    const harmless = /^(?:<c-c>|<esc>|q)$/i.test(keys.trim());
    if (autonomy !== "auto" || !harmless) {
      const a = await approve(paneId, stepId, `keys: ${keys}`);
      if (!a.ok) {
        patchStep(paneId, stepId, { state: "declined" });
        return res(`The user declined${a.why && a.why !== "stopped" ? `: ${a.why}` : "."}`, true);
      }
    }
    if (signal.aborted) return res("Stopped by the user.", true);
    patchStep(paneId, stepId, { state: "running" });
    await typing(paneId, () => s.agentInput(keysToBytes(keys)));
    await new Promise((r) => setTimeout(r, 600));
    const screen = readScreen(s, 40);
    patchStep(paneId, stepId, { state: "done", result: screen });
    return res(screen || "(empty)");
  }

  if (call.name === "run_command") {
    const command = String(input.command ?? "").trim();
    if (!command) return res("Empty command.", true);
    const timeout = Math.min(600, Math.max(1, Number(input.timeout_seconds) || 30)) * 1000;
    addStep(paneId, { kind: "tool", id: stepId, tool: call.name, label: command, state: "pending" });
    if (!atPrompt(s)) {
      patchStep(paneId, stepId, { state: "error", result: "The terminal is busy." });
      return res(
        `The terminal is not at a prompt (something is still running or a full-screen program is open). Screen:\n${readScreen(s, 30)}`,
        true,
      );
    }
    if (autonomy === "suggest") {
      await typing(paneId, () => runCommand(s, command, { timeoutMs: 0, submit: false }));
      patchStep(paneId, stepId, { state: "done", result: "Typed at the prompt for you to review." });
      return res("Typed at the prompt; the user will review and run it themselves. Don't run anything else — briefly say what it does and stop.");
    }
    if (autonomy === "confirm" || !isReadOnly(command)) {
      const a = await approve(paneId, stepId, command);
      if (!a.ok) {
        patchStep(paneId, stepId, { state: "declined" });
        return res(`The user declined to run it${a.why && a.why !== "stopped" ? `: ${a.why}` : "."}`, true);
      }
    }
    if (signal.aborted) return res("Stopped by the user.", true);
    patchStep(paneId, stepId, { state: "running" });
    patchThread(paneId, { status: "acting", activity: `Running ${command.length > 48 ? `${command.slice(0, 48)}…` : command}` });
    const r = await typing(paneId, () => runCommand(s, command, { timeoutMs: timeout, signal }));
    patchThread(paneId, { status: "thinking", activity: tr("Reading the output…") });
    const head = r.fullscreen
      ? "A full-screen program took over the terminal. Screen:"
      : r.running
        ? `Still running after ${timeout / 1000}s. Output so far:`
        : `Exit code: ${r.exitCode ?? "unknown"}.${r.omitted ? ` (${r.omitted} lines omitted)` : ""} Output:`;
    patchStep(paneId, stepId, {
      state: r.exitCode && r.exitCode !== 0 ? "error" : "done",
      result: r.output,
      exitCode: r.exitCode,
    });
    return res(`${head}\n${r.output || "(no output)"}`);
  }

  return res(`Unknown tool ${call.name}.`, true);
}

/** Mark "agent is typing / driving the terminal" while `fn` runs (shown in the pane). */
async function typing<T>(paneId: string, fn: () => Promise<T> | T): Promise<T> {
  patchThread(paneId, { typing: true });
  try {
    return await fn();
  } finally {
    patchThread(paneId, { typing: false });
  }
}

export { truncate };

// Dev-only handle for automated checks over CDP (always the current module instance).
if (import.meta.env.DEV)
  (window as unknown as { __agent: unknown }).__agent = { ask, useAgent, setAgentOpen, setAutonomy, answerApproval, stopAgent, resetThread };
