// Quick commands ("snippets"): saved command lines sent to the terminal with one click.
// Stored in ~/.rainterm/snippets.json.
import { create } from "zustand";
import { ipc } from "./ipc";

export interface Snippet {
  id: string;
  name: string;
  /** May span lines; each line is sent as if typed and followed by Enter. */
  command: string;
  group: string;
  /** Press Enter after the last line (run it) — otherwise just type it in. */
  run: boolean;
}

interface SnippetState {
  snippets: Snippet[];
  loaded: boolean;
  load(): Promise<void>;
  save(s: Snippet): Promise<void>;
  remove(id: string): Promise<void>;
  move(id: string, before: string | null): Promise<void>;
}

const persist = (list: Snippet[]) => ipc.storeSave("snippets", list).catch(() => {});

export const useSnippets = create<SnippetState>((set, get) => ({
  snippets: [],
  loaded: false,
  async load() {
    if (get().loaded) return;
    const list = await ipc.storeLoad<Snippet[]>("snippets").catch(() => null);
    set({ snippets: Array.isArray(list) ? list : [], loaded: true });
  },
  async save(s) {
    const list = get().snippets;
    const next = list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s];
    set({ snippets: next });
    await persist(next);
  },
  async remove(id) {
    const next = get().snippets.filter((x) => x.id !== id);
    set({ snippets: next });
    await persist(next);
  },
  async move(id, before) {
    const list = [...get().snippets];
    const from = list.findIndex((x) => x.id === id);
    if (from < 0) return;
    const [item] = list.splice(from, 1);
    const to = before ? list.findIndex((x) => x.id === before) : list.length;
    list.splice(to < 0 ? list.length : to, 0, item);
    set({ snippets: list });
    await persist(list);
  },
}));

/** A blank in a quick command: {{name}}, {{name:default}} or {{name|choice|choice}}. */
export interface SnippetVar {
  name: string;
  def: string | null;
  choices: string[];
}

const VAR = /\{\{\s*([\w.-]+)\s*(?::([^}|]*)|((?:\|[^}|]*)+))?\s*\}\}/g;

/** The distinct blanks in a command, in order of appearance. */
export function snippetVars(command: string): SnippetVar[] {
  const out: SnippetVar[] = [];
  for (const m of command.matchAll(VAR)) {
    const name = m[1];
    const choices = m[3] ? m[3].split("|").slice(1).map((c) => c.trim()).filter(Boolean) : [];
    const def = m[2] !== undefined ? m[2].trim() : null;
    const seen = out.find((v) => v.name === name);
    if (seen) {
      if (!seen.def && def) seen.def = def;
      if (!seen.choices.length) seen.choices = choices;
    } else out.push({ name, def, choices });
  }
  return out;
}

/** Replace every blank with its value (a blank left empty falls back to its default). */
export function fillVars(command: string, values: Record<string, string>) {
  return command.replace(VAR, (_all, name: string, def?: string) => values[name] || def?.trim() || "");
}

/** What actually gets written to the shell. */
export function snippetInput(s: Pick<Snippet, "command" | "run">, run = s.run) {
  const text = s.command.replace(/\r\n?/g, "\n").replace(/\n+$/, "").replace(/\n/g, "\r");
  return run ? `${text}\r` : text;
}
