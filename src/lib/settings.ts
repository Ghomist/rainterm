import type { HighlightRule } from "./ipc";

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
  shellIntegration: boolean;
  /** Reopen last session's tabs and splits on launch. */
  restoreSession: boolean;
  /** Completion popup while typing (history + paths); Ctrl+Space opens it manually. */
  suggestions: boolean;
  /** Poll SSH hosts for CPU/memory/disk (runs a read-only command on the server). */
  monitorRemote: boolean;
  /** Hovering a tab this long (ms) switches to it; 0 = off. */
  tabHoverSwitchMs: number;
  /** Ask before closing the window while SSH / serial sessions are connected. */
  confirmClose: boolean;
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
  shellIntegration: true,
  restoreSession: true,
  suggestions: true,
  monitorRemote: true,
  tabHoverSwitchMs: 300,
  confirmClose: true,
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
