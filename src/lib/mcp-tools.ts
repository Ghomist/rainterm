// What the MCP server offers, grouped for the permission tree in Settings. The schemas
// live in src-tauri/src/mcp.rs; this is the list the user switches on and off.
import type { McpSettings } from "./settings";

export interface McpTool {
  name: string;
  label: string;
  /** Changes something (asks for approval unless the mode is Auto). */
  writes?: boolean;
  /** On until the user turns it off. */
  default: boolean;
}

export interface McpToolGroup {
  id: "terminal" | "sessions" | "files" | "knowledge";
  label: string;
  hint: string;
  tools: McpTool[];
}

export const MCP_GROUPS: McpToolGroup[] = [
  {
    id: "terminal",
    label: "Terminal operations",
    hint: "See terminals, read their screen, run commands, send keys",
    tools: [
      { name: "list_terminals", label: "List open terminals", default: true },
      { name: "read_terminal", label: "Read a terminal's screen", default: true },
      { name: "run_command", label: "Run commands", writes: true, default: true },
      { name: "send_keys", label: "Send keystrokes", writes: true, default: true },
    ],
  },
  {
    id: "sessions",
    label: "Session management",
    hint: "Open, arrange and close terminals; edit the saved sessions list",
    tools: [
      { name: "list_hosts", label: "List saved sessions and shells", default: true },
      { name: "open_terminal", label: "Open terminals (tabs and splits)", writes: true, default: true },
      { name: "focus_terminal", label: "Switch to a terminal", default: true },
      { name: "close_terminal", label: "Close terminals", writes: true, default: true },
      { name: "save_session", label: "Add / edit saved sessions", writes: true, default: false },
      { name: "delete_session", label: "Delete saved sessions", writes: true, default: false },
    ],
  },
  {
    id: "files",
    label: "File transfer",
    hint: "Browse files on a terminal's machine, upload and download",
    tools: [
      { name: "list_files", label: "Browse files", default: true },
      { name: "upload_files", label: "Upload to the server", writes: true, default: true },
      { name: "download_files", label: "Download from the server", writes: true, default: true },
    ],
  },
  {
    id: "knowledge",
    label: "Knowledge base",
    hint: "Search, read and save notes (part of the experimental agents feature)",
    tools: [
      { name: "search_knowledge", label: "Search notes", default: true },
      { name: "read_knowledge", label: "Read notes", default: true },
      { name: "save_knowledge", label: "Save notes", writes: true, default: true },
    ],
  },
];

/** Is this tool switched on (user choice, else its default)? */
export function mcpToolOn(m: McpSettings, name: string): boolean {
  const own = m.tools?.[name];
  if (own !== undefined) return own;
  return MCP_GROUPS.some((g) => g.tools.some((t) => t.name === name && t.default));
}

/** Tools MCP clients get: the ones switched on; knowledge only with the agents feature. */
export function enabledMcpTools(m: McpSettings, agentsOn: boolean): string[] {
  return MCP_GROUPS.filter((g) => agentsOn || g.id !== "knowledge").flatMap((g) =>
    g.tools.filter((t) => mcpToolOn(m, t.name)).map((t) => t.name),
  );
}
