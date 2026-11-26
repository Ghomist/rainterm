// The webview half of the MCP server (src-tauri/src/mcp.rs speaks the protocol): it
// starts / stops the listener from Settings and runs the tool calls against the real
// terminals — visibly, with the same approval modes as the built-in agent.
import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { create } from "zustand";
import { ipc } from "@/lib/ipc";
import type { AgentAutonomy } from "@/lib/settings";
import { confirm } from "@/lib/overlay";
import { isTermPane, type Pane, type SshProfile, type SplitAt, type TermPane, useApp } from "@/store/app";
import { enabledMcpTools } from "./mcp-tools";
import { download, upload } from "./transfers";
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

  // Permissions: the server lists and accepts only the tools switched on.
  const agentsOn = useApp((s) => s.settings.agentsBoard);
  const tools = enabledMcpTools(cfg, agentsOn).join(",");
  useEffect(() => {
    if (ready) void ipc.mcpSetTools(tools ? tools.split(",") : []).catch(() => {});
  }, [ready, tools]);
}

// Tool calls from the server: one listener for the app's lifetime (re-registered on dev
// hot updates, so it always runs the current code).
const unlisten = listen<{ id: number; name: string; args: Record<string, unknown> }>("mcp-call", (e) => {
  const { id, name, args } = e.payload;
  const st = useApp.getState().settings;
  const run = enabledMcpTools(st.mcp, st.agentsBoard).includes(name)
    ? handle(name, args ?? {})
    : Promise.reject(new Error(`${name} is turned off in rainterm (Settings → Agent → MCP server).`));
  void run.then(
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
      const split = typeof args.split === "string" ? (args.split as "right" | "left" | "down" | "up") : null;
      const beside = split ? paneFor(args.beside) : null;
      const before = new Set(Object.keys(useApp.getState().panes));
      if (beside && split) {
        const side: SplitAt["side"] = split === "down" ? "bottom" : split === "up" ? "top" : split;
        if (profile) await st.connect(profile, { at: { paneId: beside.id, side } });
        else {
          reveal(beside);
          st.focusPane(beside.id);
          st.openLocal(shell, { split: side === "left" || side === "right" ? "row" : "col" });
        }
      } else if (profile) await st.connect(profile);
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

    case "focus_terminal": {
      const p = paneFor(args.terminal);
      reveal(p);
      useApp.getState().focusPane(p.id);
      return `Focused ${p.id} (${where(p)}).`;
    }

    case "close_terminal": {
      const p = paneFor(args.terminal);
      reveal(p);
      if (mode !== "auto") {
        const ok = await ask("An MCP client wants to close a terminal", `Close ${where(p)}?`, "Close");
        if (!ok) throw new Error("The user declined.");
      }
      useApp.getState().closePane(p.id);
      return `Closed ${p.id}.`;
    }

    case "save_session": {
      const st = useApp.getState();
      const key = typeof args.session === "string" ? args.session : "";
      const cur = key ? st.profiles.find((p) => p.id === key || p.name === key) : undefined;
      if (key && !cur) throw new Error(`No saved session "${key}" — see list_hosts.`);
      if (cur && cur.kind !== "ssh") throw new Error("Only SSH sessions can be changed this way.");
      const str = (k: string) => (typeof args[k] === "string" ? String(args[k]).trim() : undefined);
      const host = str("host") ?? cur?.host;
      if (!host) throw new Error("A host is needed.");
      const authKind = str("auth") ?? cur?.auth.kind ?? "auto";
      const keyPath = str("key_path") ?? (cur?.auth.kind === "key" ? cur.auth.path : "");
      if (authKind === "key" && !keyPath) throw new Error("auth = key needs key_path.");
      const next: SshProfile = {
        kind: "ssh",
        id: cur?.id ?? crypto.randomUUID(),
        name: str("name") ?? cur?.name ?? host,
        group: str("group") ?? cur?.group ?? "",
        host,
        port: Number(args.port) || cur?.port || 22,
        user: str("user") ?? cur?.user ?? "root",
        auth: authKind === "key" ? { kind: "key", path: keyPath } : { kind: authKind as "auto" | "password" | "agent" },
        jumpId: cur?.jumpId ?? null,
        forwards: cur?.forwards ?? [],
        remember: cur?.remember ?? false,
        proxy: cur?.proxy ?? null,
      };
      if (mode !== "auto") {
        const what = `${next.name}: ${next.user}@${next.host}:${next.port}${next.group ? ` · ${next.group}` : ""}`;
        const ok = await ask(cur ? "An MCP client wants to change a saved session" : "An MCP client wants to add a saved session", what, cur ? "Save" : "Add");
        if (!ok) throw new Error("The user declined.");
      }
      await st.saveProfile(next);
      return JSON.stringify({ id: next.id, name: next.name, host: `${next.user}@${next.host}:${next.port}`, group: next.group || null, updated: !!cur });
    }

    case "delete_session": {
      const st = useApp.getState();
      const key = String(args.session ?? "");
      const p = st.profiles.find((x) => x.id === key || x.name === key);
      if (!p) throw new Error(`No saved session "${key}" — see list_hosts.`);
      const ok = await ask("An MCP client wants to delete a saved session", `Delete “${p.name}” from the sessions list?`, "Delete");
      if (!ok) throw new Error("The user declined.");
      await st.deleteProfile(p.id);
      return `Deleted saved session ${p.name}.`;
    }

    case "list_files": {
      const p = paneFor(args.terminal);
      const target = fsTarget(p);
      const path = typeof args.path === "string" && args.path ? args.path : await ipc.fsHome(target);
      const l = await ipc.fsList(target, path);
      const rows = l.entries.slice(0, 500).map((e) => ({ name: e.name, kind: e.kind, size: e.size }));
      return JSON.stringify({ path: l.path, entries: rows, more: Math.max(0, l.entries.length - rows.length) }, null, 1);
    }

    case "upload_files": {
      const p = paneFor(args.terminal);
      const sid = sshSession(p);
      const locals = Array.isArray(args.local_paths) ? args.local_paths.map(String).filter(Boolean) : [];
      const dir = String(args.remote_dir ?? "");
      if (!locals.length || !dir) throw new Error("local_paths and remote_dir are needed.");
      if (mode !== "auto") {
        const ok = await ask(`An MCP client wants to upload to ${where(p)}`, `${locals.join("\n")}\n→ ${dir}`, "Upload");
        if (!ok) throw new Error("The user declined.");
      }
      if (!(await upload(sid, locals, dir))) throw new Error("The upload failed (details in rainterm's transfers).");
      return `Uploaded ${locals.length} item(s) to ${dir}.`;
    }

    case "download_files": {
      const p = paneFor(args.terminal);
      const sid = sshSession(p);
      const remotes = Array.isArray(args.remote_paths) ? args.remote_paths.map(String).filter(Boolean) : [];
      if (!remotes.length) throw new Error("remote_paths is needed.");
      const dir = typeof args.local_dir === "string" && args.local_dir ? args.local_dir : await ipc.fsDefaultDownloadDir();
      if (mode !== "auto") {
        const ok = await ask(`An MCP client wants to download from ${where(p)}`, `${remotes.join("\n")}\n→ ${dir}`, "Download");
        if (!ok) throw new Error("The user declined.");
      }
      const created = await download(sid, remotes, dir);
      if (!created) throw new Error("The download failed (details in rainterm's transfers).");
      return JSON.stringify({ saved: created });
    }
  }
  throw new Error(`Unknown tool ${name}`);
}

function fsTarget(p: TermPane) {
  if (p.kind === "local") return { kind: "local" as const };
  return { kind: "ssh" as const, sessionId: sshSession(p) };
}

function sshSession(p: TermPane): string {
  const sid = p.session.sessionId;
  if (p.kind !== "ssh") throw new Error(`${p.id} is not an SSH terminal: files move between this computer and an SSH host.`);
  if (!sid || p.status !== "connected") throw new Error(`Terminal ${p.id} is not connected (${p.status}).`);
  return sid;
}
