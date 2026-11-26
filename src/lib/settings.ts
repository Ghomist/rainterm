import type { LangSetting } from "./i18n";
import type { HighlightRule } from "./ipc";

/** Tool views that live in the side docks. */
export type ViewId =
  | "sessions" | "agent" | "files" | "monitor" | "snippets" | "ports" | "containers" | "k8s" | "agents" | "knowledge"
  | "services" | "logs" | "cron";
export type DockSide = "left" | "right";
export const ALL_VIEWS: ViewId[] = ["sessions", "agent", "files", "monitor", "snippets", "ports", "containers", "k8s", "agents", "knowledge", "services", "logs", "cron"];
export const DEFAULT_DOCK: Record<DockSide, ViewId[]> = {
  left: ["sessions", "agent", "files", "snippets"],
  right: ["agents", "knowledge", "monitor", "services", "logs", "ports", "cron", "containers", "k8s"],
};

/** A saved outbound proxy; its password (if any) lives in the OS keychain as `proxy:<id>`. */
export interface ProxyDef {
  id: string;
  name: string;
  kind: "socks5" | "http";
  host: string;
  port: number;
  user: string;
  hasPassword: boolean;
}

export const proxyLabel = (p: ProxyDef) => p.name || `${p.kind === "http" ? "HTTP" : "SOCKS5"} ${p.host}:${p.port}`;

/** How much the built-in agent may do on its own. */
export type AgentAutonomy = "suggest" | "confirm" | "auto";

export interface AgentSettings {
  /** Wire format: OpenAI-compatible Chat Completions, or Anthropic Messages. */
  format: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** Optional reasoning effort ("low" | "medium" | "high" …); "" = provider default. */
  effort: string;
  /** A saved proxy id for model requests (null = direct). */
  proxy: string | null;
  autonomy: AgentAutonomy;
}

export const DEFAULT_AGENT: AgentSettings = {
  format: "openai",
  baseUrl: "https://api.deepseek.com",
  model: "",
  maxTokens: 8192,
  effort: "",
  proxy: null,
  autonomy: "confirm",
};

/** MCP server: lets other agents use rainterm's terminals over HTTP. */
export interface McpSettings {
  enabled: boolean;
  /** Listen address: 127.0.0.1 = this computer only. */
  host: string;
  port: number;
  /** Bearer token clients must send (generated on first enable). */
  token: string;
  /** Same meaning as the built-in agent's modes, applied to MCP clients. */
  autonomy: AgentAutonomy;
  /** Tools switched on / off by the user (missing = the tool's default; see mcp-tools.ts). */
  tools?: Record<string, boolean>;
}

export const DEFAULT_MCP: McpSettings = { enabled: false, host: "127.0.0.1", port: 7323, token: "", autonomy: "confirm" };

/** What the little badge on each command row shows (click it to copy the output). */
export interface BlockBadges {
  exitCode: boolean;
  duration: boolean;
  /** When the command was started. */
  startTime: boolean;
}

export const DEFAULT_BADGES: BlockBadges = { exitCode: true, duration: true, startTime: false };

/** Behind the terminals: plain color, the animated weather scene, or the user's picture. */
export type Backdrop = "none" | "weather" | "image";

export interface Settings {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  cursorStyle: "bar" | "block" | "underline";
  cursorBlink: boolean;
  scrollback: number;
  /** Resolved at runtime from themeMode/darkTheme/lightTheme (kept for older configs). */
  theme: string;
  themeMode: "dark" | "light" | "system";
  darkTheme: string;
  lightTheme: string;
  /** Where downloads go without asking. */
  downloadDir: string | null;
  showHiddenFiles: boolean;
  /** Native window translucency (Mica). Off = solid, theme-colored chrome. */
  mica: boolean;
  /** Auto-install the bash/zsh prompt hook in SSH sessions (folding + cwd sync). */
  /** Type the bash/zsh/fish prompt hook into new SSH sessions automatically. Off by
   *  default: typed at the wrong moment it answers login-time questions (omz updates…). */
  sshAutoIntegration: boolean;
  /** Reopen last session's tabs and splits on launch. */
  restoreSession: boolean;
  /** Experimental multi-agent board (goals → plans → agents). Off: no board, no pool panel. */
  agentsBoard: boolean;
  /** Tabs across the title bar, or as a list down the left. */
  tabPosition: "top" | "left";
  /** Vertical tab list: width (px) and folded down to icons. */
  vtabsWidth: number;
  vtabsCollapsed: boolean;
  /** Completion popup while typing (history + paths); Ctrl+Space opens it manually. */
  suggestions: boolean;
  /** Poll SSH hosts for CPU/memory/disk (runs a read-only command on the server). */
  monitorRemote: boolean;
  /** Hovering a tab this long (ms) switches to it; 0 = off. */
  tabHoverSwitchMs: number;
  /** Ask before closing the window while SSH / serial sessions are connected. */
  confirmClose: boolean;
  /** Ask before pasting several lines into a program that would run each one. */
  confirmMultilinePaste: boolean;
  filesWidth: number;
  lineNumbers: boolean;
  highlight: boolean;
  highlightRules: HighlightRule[] | null; // null = built-in defaults
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  autoLog: boolean;
  defaultShell: string | null;
  /** SHA-256 (hex) of salt + password; null = no lock password set. */
  lockHash: string | null;
  lockSalt: string | null;
  lockAfterMinutes: number;
  /** Shortcut overrides: action id → key combos ("Ctrl+Shift+T"); [] = unbound. */
  keybindings: Record<string, string[]>;
  /** Session groups in display order (a group may be empty). */
  profileGroups: string[];
  /** Sidebar groups the user collapsed. */
  collapsedGroups: string[];
  /** Which views sit in which dock, in rail order. */
  dock: Record<DockSide, ViewId[]>;
  /** The view shown in each dock (null = that dock's panel is closed). */
  leftView: ViewId | null;
  rightView: ViewId | null;
  leftWidth: number;
  rightWidth: number;
  /** Saved proxies, reusable by sessions. */
  proxies: ProxyDef[];
  /** Proxy every SSH session uses unless it picks its own (null = connect directly). */
  globalProxy: string | null;
  /** Fewer animations, no blur / glow: smoother on integrated graphics. */
  reduceEffects: boolean;
  backdrop: Backdrop;
  /** Copied into ~/.rainterm/backgrounds. */
  backdropImage: string | null;
  /** 0–0.9: darken (dark themes) / wash out (light themes) the picture. */
  backdropDim: number;
  /** px */
  backdropBlur: number;
  /** 0.2–1: how much rain / how lively the scene is. */
  weatherIntensity: number;
  /** 0.3–0.97: how solid the terminal "glass" over the background is. */
  glassOpacity: number;
  agent: AgentSettings;
  mcp: McpSettings;
  blockBadges: BlockBadges;
  /** Pin the command whose output fills the screen to the top of the terminal. */
  stickyCommand: boolean;
  /** Notify when a command that ran at least this many seconds finishes out of sight; 0 = off. */
  notifyAfterSeconds: number;
  /** Reconnect SSH sessions by themselves when the connection drops. */
  autoReconnect: boolean;
  /** UI language ("system" = the OS language). */
  language: LangSetting;
  /** Look for a new version at start and every few hours. */
  autoUpdate: boolean;
  /** A version the user chose to skip (no reminder until a newer one). */
  skipVersion: string | null;
}

export const DEFAULT_FONT =
  '"JetBrains Mono", "Cascadia Mono", "Cascadia Code", "SF Mono", Menlo, Consolas, "Sarasa Mono SC", "Microsoft YaHei UI", monospace';

export const DEFAULT_SETTINGS: Settings = {
  fontFamily: DEFAULT_FONT,
  fontSize: 14,
  lineHeight: 1.2,
  cursorStyle: "bar",
  cursorBlink: true,
  scrollback: 10000,
  theme: "rain",
  themeMode: "dark",
  darkTheme: "rain",
  lightTheme: "rain-light",
  downloadDir: null,
  showHiddenFiles: false,
  mica: false,
  sshAutoIntegration: false,
  restoreSession: true,
  agentsBoard: false,
  tabPosition: "top",
  vtabsWidth: 220,
  vtabsCollapsed: false,
  suggestions: true,
  monitorRemote: true,
  tabHoverSwitchMs: 300,
  confirmClose: true,
  confirmMultilinePaste: true,
  filesWidth: 340,
  lineNumbers: true,
  highlight: true,
  highlightRules: null,
  copyOnSelect: false,
  rightClickPaste: true,
  autoLog: false,
  defaultShell: null,
  lockHash: null,
  lockSalt: null,
  lockAfterMinutes: 0,
  keybindings: {},
  profileGroups: [],
  collapsedGroups: [],
  dock: DEFAULT_DOCK,
  leftView: "sessions",
  rightView: null,
  leftWidth: 260,
  rightWidth: 340,
  proxies: [],
  globalProxy: null,
  reduceEffects: false,
  backdrop: "none",
  backdropImage: null,
  backdropDim: 0.35,
  backdropBlur: 0,
  weatherIntensity: 0.6,
  glassOpacity: 0.6,
  autoUpdate: true,
  skipVersion: null,
  agent: DEFAULT_AGENT,
  mcp: DEFAULT_MCP,
  blockBadges: DEFAULT_BADGES,
  stickyCommand: true,
  notifyAfterSeconds: 10,
  autoReconnect: true,
  language: "system",
};

/** Every view exactly once, each in a dock; new views land in their default dock. */
export function normalizeDock(dock: Partial<Record<DockSide, ViewId[]>> | undefined): Record<DockSide, ViewId[]> {
  const seen = new Set<ViewId>();
  const clean = (list: unknown) =>
    (Array.isArray(list) ? list : []).filter((v): v is ViewId => ALL_VIEWS.includes(v) && !seen.has(v) && !!seen.add(v));
  const out = { left: clean(dock?.left), right: clean(dock?.right) };
  for (const v of [...DEFAULT_DOCK.left, ...DEFAULT_DOCK.right]) {
    if (seen.has(v)) continue;
    const side: DockSide = DEFAULT_DOCK.left.includes(v) ? "left" : "right";
    // Next to the view it follows by default (knowledge after agents), else at the end.
    const def = DEFAULT_DOCK[side];
    const before = def.slice(0, def.indexOf(v)).reverse().find((x) => out[side].includes(x));
    const at = before ? out[side].indexOf(before) + 1 : out[side].length;
    out[side].splice(at, 0, v);
  }
  return out;
}

/** Rail sections: a divider where one ends and the next starts (agents | monitoring). */
export const VIEW_GROUP: Record<ViewId, string> = {
  sessions: "general",
  agent: "general",
  files: "general",
  snippets: "general",
  agents: "ai",
  knowledge: "ai",
  monitor: "ops",
  ports: "ops",
  containers: "ops",
  k8s: "ops",
  services: "ops",
  logs: "ops",
  cron: "ops",
};

export async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const SGR_COLORS: { label: string; sgr: string; css: string }[] = [
  { label: "Red", sgr: "1;31", css: "var(--term-red)" },
  { label: "Yellow", sgr: "33", css: "var(--term-yellow)" },
  { label: "Green", sgr: "32", css: "var(--term-green)" },
  { label: "Blue", sgr: "4;34", css: "var(--term-blue)" },
  { label: "Magenta", sgr: "35", css: "var(--term-magenta)" },
  { label: "Cyan", sgr: "36", css: "var(--term-cyan)" },
  { label: "Bold", sgr: "1", css: "var(--foreground)" },
  { label: "Inverse", sgr: "7", css: "var(--foreground)" },
];

export const RULE_NAMES = [
  "Errors",
  "Warnings",
  "Success",
  "URLs",
  "IPv4 addresses",
  "MAC addresses",
  "Dates",
  "Times",
];

export function resolveTheme(s: Settings, systemDark: boolean) {
  const dark = s.themeMode === "system" ? systemDark : s.themeMode === "dark";
  return dark ? s.darkTheme : s.lightTheme;
}
