// The webview half of the MCP server (src-tauri/src/mcp.rs speaks the protocol): it
// starts / stops the listener from Settings and runs the tool calls against the real
// terminals — visibly, with the same approval modes as the built-in agent.
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { AgentAutonomy } from "@/lib/settings";
import { confirm } from "@/lib/overlay";
import { isTermPane, type Pane, type TermPane, useApp } from "@/store/app";
import { atPrompt, isReadOnly, keysToBytes, readScreen, runCommand } from "./agent/terminal";

export const useMcpStatus = create<{ listening: string | null; error: string | null }>(() => ({
  listening: null,
  error: null,
}));

export function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

/** Mounted once (App): keeps the listener in line with Settings and answers tool calls. */
export function useMcpServer() {
  const cfg = useApp((s) => s.settings.mcp);
  const ready = useApp((s) => s.ready);

  useEffect(() => {
    if (!ready) return;
    let gone = false;
    (async () => {
      if (!cfg.enabled) {
        await ipc.mcpStop().catch(() => {});
        if (!gone) useMcpStatus.setState({ listening: null, error: null });
        return;
      }
      let token = cfg.token;
      if (token.length < 16) {
        token = newToken();
        await useApp.getState().updateSettings({ mcp: { ...cfg, token } });
        return; // the settings change re-runs this effect
      }
      try {
        const addr = await ipc.mcpStart(cfg.host.trim() || "127.0.0.1", cfg.port, token);
        if (!gone) useMcpStatus.setState({ listening: addr, error: null });
      } catch (e) {
        if (!gone) useMcpStatus.setState({ listening: null, error: String(e) });
      }
    })();
    return () => {
      gone = true;
    };
  }, [ready, cfg.enabled, cfg.host, cfg.port, cfg.token]);

}

// Tool calls from the server: one listener for the app's lifetime (re-registered on dev
// hot updates, so it always runs the current code).
const unlisten = listen<{ id: number; name: string; args: Record<string, unknown> }>("mcp-call", (e) => {
  const { id, name, args } = e.payload;
  void handle(name, args ?? {}).then(
    (text) => ipc.mcpReply(id, { content: [{ type: "text", text }] }),
    (err) => ipc.mcpReply(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true }),
  );
});
if (import.meta.hot) import.meta.hot.dispose(() => void unlisten.then((f) => f()));

// ------------------------------------------------------------------ tools

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One approval dialog at a time (the overlay shows a single dialog). */
let approvals: Promise<unknown> = Promise.resolve();
function ask(title: string, message: string, confirmLabel: string): Promise<boolean> {
  const next = approvals.then(() => confirm({ title, message, confirmLabel }));
  approvals = next.catch(() => {});
  return next;
}

function paneFor(arg: unknown): TermPane {
  const st = useApp.getState();
  if (typeof arg === "string" && arg) {
    const p = st.panes[arg] ?? Object.values(st.panes).find((x) => x.title === arg && isTermPane(x));
    if (!isTermPane(p)) throw new Error(`No terminal "${arg}" — call list_terminals for ids.`);
    return p;
  }
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const p = tab ? st.panes[tab.activePane] : undefined;
  if (!isTermPane(p)) throw new Error("No terminal is open — use open_terminal first.");
  return p;
}

/** Bring the pane on screen so the user sees what happens in it. */
function reveal(p: Pane) {
  const st = useApp.getState();
  const tab = st.tabs.find((t) => JSON.stringify(t.layout).includes(`"${p.id}"`));
  if (tab && tab.id !== st.activeTabId) st.setActiveTab(tab.id);
}

const where = (p: Pane) => (p.kind === "ssh" ? `${p.title} (${p.subtitle})` : p.title);

/** Run one of rainterm's terminal tools (MCP clients, and the agents session's workers). */
export async function handle(name: string, args: Record<string, unknown>, modeOverride?: AgentAutonomy): Promise<string> {
  const mode = modeOverride ?? useApp.getState().settings.mcp.autonomy;
  switch (name) {
    case "list_terminals": {
      const st = useApp.getState();
      const activeTab = st.tabs.find((t) => t.id === st.activeTabId);
      const rows = Object.values(st.panes).filter(isTermPane).map((p) => ({
        id: p.id,
        title: p.title,
        kind: p.kind,
        host: p.kind === "local" ? "this computer" : p.subtitle,
        status: p.status,
        active: activeTab?.activePane === p.id,
        at_prompt: p.status === "connected" && atPrompt(p.session),
        cwd: p.cwd ?? null,
      }));
      return JSON.stringify(rows, null, 2);
    }

    case "read_terminal": {
      const p = paneFor(args.terminal);
      const n = Math.min(300, Math.max(5, Number(args.lines) || 60));
      return readScreen(p.session, n) || "(empty)";
    }

    case "run_command": {
      const p = paneFor(args.terminal);
      const command = String(args.command ?? "").trim();
      if (!command) throw new Error("Empty command.");
      if (p.status !== "connected") throw new Error(`Terminal ${p.id} is not connected (${p.status}).`);
      if (!atPrompt(p.session)) throw new Error(`Terminal ${p.id} is busy (not at a prompt). Screen:\n${readScreen(p.session, 20)}`);
      reveal(p);
      if (mode === "suggest") {
        await runCommand(p.session, command, { timeoutMs: 0, submit: false });
        return "Typed at the prompt for the user to review and run (rainterm is in Suggest mode for MCP clients); it has not run.";
      }
      if (mode === "confirm" || !isReadOnly(command)) {
        const ok = await ask(`An MCP client wants to run a command in ${where(p)}`, command, "Run");
        if (!ok) throw new Error("The user declined to run this command.");
      }
      const timeout = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 30)) * 1000;
      const r = await runCommand(p.session, command, { timeoutMs: timeout });
      const head = r.fullscreen
        ? "A full-screen program took over the terminal. Screen:"
        : r.running
          ? `Still running after ${timeout / 1000}s (read_terminal later, or send_keys <C-c>). Output so far:`
          : `Exit code: ${r.exitCode ?? "unknown"}.${r.omitted ? ` (${r.omitted} lines omitted)` : ""} Output:`;
      return `${head}\n${r.output || "(no output)"}`;
    }

    case "send_keys": {
      const p = paneFor(args.terminal);
      const keys = String(args.keys ?? "");
      if (!keys) throw new Error("No keys.");
      reveal(p);
      const harmless = /^(?:<c-c>|<esc>|q)$/i.test(keys.trim());
      if (mode !== "auto" || !harmless) {
        const ok = await ask(`An MCP client wants to send keys to ${where(p)}`, keys, "Send");
        if (!ok) throw new Error("The user declined.");
      }
      p.session.agentInput(keysToBytes(keys));
      await sleep(600);
      return readScreen(p.session, 40) || "(empty)";
    }

    case "list_hosts": {
      const st = useApp.getState();
      return JSON.stringify(
        {
          sessions: st.profiles.map((p) =>
            p.kind === "ssh"
              ? { id: p.id, name: p.name, kind: "ssh", host: `${p.user}@${p.host}:${p.port}`, group: p.group || null }
              : { id: p.id, name: p.name, kind: "serial", port: p.target.port, group: p.group || null },
          ),
          local_shells: st.shells.map((s) => ({ id: s.id, name: s.name })),
        },
        null,
        2,
      );
    }

    case "open_terminal": {
      const st = useApp.getState();
      const sess = typeof args.session === "string" ? args.session : "";
      const sh = typeof args.shell === "string" ? args.shell : "";
      const profile = sess ? st.profiles.find((p) => p.id === sess || p.name === sess) : undefined;
      if (sess && !profile) throw new Error(`No saved session "${sess}" — see list_hosts.`);
      const shell = !profile ? (sh ? st.shells.find((s) => s.id === sh || s.name === sh) : undefined) : undefined;
      if (sh && !shell && !profile) throw new Error(`No local shell "${sh}" — see list_hosts.`);
      const label = profile ? `session “${profile.name}”` : `a ${(shell ?? st.shells[0])?.name ?? "local"} terminal`;
      if (mode !== "auto") {
        const ok = await ask("An MCP client wants to open a terminal", `Open ${label}?`, "Open");
        if (!ok) throw new Error("The user declined.");
      }
      const before = new Set(Object.keys(useApp.getState().panes));
      if (profile) await st.connect(profile);
      else st.openLocal(shell);
      const id = Object.keys(useApp.getState().panes).find((x) => !before.has(x));
      if (!id) throw new Error("Couldn't open it.");
      // Wait for the connection (password prompts etc. are the user's to answer).
      for (let i = 0; i < 120; i++) {
        const p = useApp.getState().panes[id];
        if (!p || p.status === "connected" || p.status === "error" || p.status === "exited") break;
        await sleep(250);
      }
      const p = useApp.getState().panes[id];
      if (!isTermPane(p)) throw new Error("The terminal was closed.");
      if (p.status !== "connected") throw new Error(`Opened ${id} but it is ${p.status}${p.error ? `: ${p.error}` : ""}.`);
      // Let the shell finish starting (profile, first prompt): output quiet and at a prompt.
      for (let i = 0; i < 60; i++) {
        if (atPrompt(p.session) && performance.now() - p.session.lastOutputAt > 800) break;
        await sleep(200);
      }
      return JSON.stringify({ id, title: p.title, kind: p.kind, host: p.kind === "local" ? "this computer" : p.subtitle });
    }
  }
  throw new Error(`Unknown tool ${name}`);
}
