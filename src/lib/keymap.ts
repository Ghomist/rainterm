// App shortcuts: one table of actions with default key combos, user overrides from
// settings.keybindings, and event → combo matching. Combos use physical keys (e.code),
// so they work the same on every keyboard layout: "Ctrl+Shift+T", "Alt+Left", "F11".
import type { Settings } from "./settings";
import { isMac } from "./utils";

export interface ActionDef {
  id: string;
  label: string;
  group: "Tabs & panes" | "Panels" | "Terminal" | "App";
  keys: string[];
}

export const ACTIONS: ActionDef[] = [
  { id: "newTab", label: "New tab", group: "Tabs & panes", keys: ["Ctrl+Shift+T"] },
  { id: "closePane", label: "Close pane", group: "Tabs & panes", keys: ["Ctrl+Shift+W"] },
  { id: "nextTab", label: "Next tab", group: "Tabs & panes", keys: ["Ctrl+Tab"] },
  { id: "prevTab", label: "Previous tab", group: "Tabs & panes", keys: ["Ctrl+Shift+Tab"] },
  { id: "splitRight", label: "Split right", group: "Tabs & panes", keys: ["Alt+Shift+=", "Alt+Shift+NumAdd"] },
  { id: "splitDown", label: "Split down", group: "Tabs & panes", keys: ["Alt+Shift+-", "Alt+Shift+NumSub"] },
  { id: "prevPane", label: "Previous pane", group: "Tabs & panes", keys: ["Alt+Left", "Alt+Up"] },
  { id: "nextPane", label: "Next pane", group: "Tabs & panes", keys: ["Alt+Right", "Alt+Down"] },
  { id: "zoomPane", label: "Maximize / restore pane", group: "Tabs & panes", keys: ["Ctrl+Shift+Z"] },
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    id: `tab${n}`,
    label: `Go to tab ${n}`,
    group: "Tabs & panes" as const,
    keys: [`Alt+${n}`],
  })),
  { id: "lastTab", label: "Go to last tab", group: "Tabs & panes", keys: ["Alt+9"] },

  { id: "palette", label: "Command palette", group: "Panels", keys: ["Ctrl+Shift+P"] },
  { id: "sidebar", label: "Toggle sidebar", group: "Panels", keys: ["Ctrl+Shift+B"] },
  { id: "files", label: "Files", group: "Panels", keys: ["Ctrl+Shift+E"] },
  { id: "monitor", label: "Resource monitor", group: "Panels", keys: ["Ctrl+Shift+M"] },
  { id: "snippets", label: "Quick commands", group: "Panels", keys: ["Ctrl+Shift+K"] },
  { id: "settings", label: "Settings", group: "Panels", keys: ["Ctrl+,"] },

  { id: "find", label: "Find in terminal", group: "Terminal", keys: ["Ctrl+Shift+F"] },
  { id: "broadcast", label: "Broadcast input", group: "Terminal", keys: ["Ctrl+Shift+I"] },
  { id: "foldAll", label: "Fold all output", group: "Terminal", keys: ["Ctrl+Shift+["] },
  { id: "unfoldAll", label: "Unfold all output", group: "Terminal", keys: ["Ctrl+Shift+]"] },

  { id: "newSsh", label: "New SSH session", group: "App", keys: ["Ctrl+Shift+N"] },
  { id: "lock", label: "Lock screen", group: "App", keys: ["Ctrl+Shift+L"] },
];

const CODE_NAMES: Record<string, string> = {
  Equal: "=",
  Minus: "-",
  NumpadAdd: "NumAdd",
  NumpadSubtract: "NumSub",
  NumpadMultiply: "NumMul",
  NumpadDivide: "NumDiv",
  BracketLeft: "[",
  BracketRight: "]",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Escape: "Esc",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Insert: "Insert",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
};

/** The key part of a combo for an event's physical key; null for bare modifiers. */
function keyName(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code;
  return CODE_NAMES[code] ?? null;
}

/** "Ctrl+Shift+T" for a keydown (Cmd counts as Ctrl on macOS); null for modifier-only. */
export function comboFromEvent(e: KeyboardEvent): string | null {
  const key = keyName(e.code);
  if (!key) return null;
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  parts.push(key);
  return parts.join("+");
}

/** A combo that won't swallow ordinary typing: needs Ctrl/Alt, or is a function key. */
export function isUsableCombo(combo: string) {
  return /(^|\+)(Ctrl|Alt)\+/.test(combo) || /(^|\+)F\d{1,2}$/.test(combo);
}

export function bindingsOf(settings: Pick<Settings, "keybindings">, id: string): string[] {
  return settings.keybindings?.[id] ?? ACTIONS.find((a) => a.id === id)?.keys ?? [];
}

let cache: { src: Settings["keybindings"] | undefined; map: Map<string, string> } | null = null;

/** combo → action id for the current settings (memoized on the overrides object). */
export function keymap(settings: Pick<Settings, "keybindings">): Map<string, string> {
  if (cache && cache.src === settings.keybindings) return cache.map;
  const map = new Map<string, string>();
  for (const a of ACTIONS) for (const k of bindingsOf(settings, a.id)) if (!map.has(k)) map.set(k, a.id);
  cache = { src: settings.keybindings, map };
  return map;
}

/** Which action (if any) already uses `combo`, other than `except`. */
export function conflictOf(settings: Pick<Settings, "keybindings">, combo: string, except: string) {
  return ACTIONS.find((a) => a.id !== except && bindingsOf(settings, a.id).includes(combo)) ?? null;
}

/** Keycaps for display: "Ctrl+Shift+T" → ["Ctrl", "Shift", "T"] (⌘ ⇧ ⌥ on macOS). */
export function keycaps(combo: string): string[] {
  const parts = combo.split("+");
  if (!isMac) return parts;
  const mac: Record<string, string> = { Ctrl: "⌘", Shift: "⇧", Alt: "⌥" };
  return parts.map((p) => mac[p] ?? p);
}

/** Space-separated form the Tooltip `shortcut` prop takes. */
export function tooltipKeys(settings: Pick<Settings, "keybindings">, id: string): string | undefined {
  const first = bindingsOf(settings, id)[0];
  return first ? first.split("+").join(" ") : undefined;
}

/** While true, the global shortcut handler stands down (the settings page is recording). */
export const recording = { active: false };
