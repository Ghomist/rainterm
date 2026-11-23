// The knowledge base: the user's own notes (Markdown files in ~/.rainterm/knowledge),
// searched in Rust (src-tauri/src/kb.rs). Every agent can use it: the built-in agent and
// the agents session's built-in workers get search/read tools, ACP workers get them over
// the MCP server, and plan / work prompts carry the best matches up front.
import { create } from "zustand";
import { ipc, type KbEntry, type LlmToolDef } from "@/lib/ipc";

export const useKb = create<{ entries: KbEntry[]; loaded: boolean; error: string | null }>(() => ({
  entries: [],
  loaded: false,
  error: null,
}));

export async function refreshKb() {
  try {
    useKb.setState({ entries: await ipc.kbList(), loaded: true, error: null });
  } catch (e) {
    useKb.setState({ loaded: true, error: String(e) });
  }
}

let first: Promise<void> | null = null;
/** Load once; later callers get the cached list. */
export function ensureKb() {
  if (!first) first = refreshKb();
  return first;
}

// ------------------------------------------------------------------ the editor (components/KnowledgePanel)

export interface KbDraft {
  id: string | null;
  title: string;
  tags: string[];
  body: string;
}

export const useKbEditor = create<{ draft: KbDraft | null; preview: boolean }>(() => ({ draft: null, preview: false }));

/** Open the note editor on a new note (optionally prefilled, e.g. from an agent's report). */
export function newNote(prefill?: Partial<KbDraft>) {
  useKbEditor.setState({ draft: { id: null, title: "", tags: [], body: "", ...prefill }, preview: false });
}

export const hasKnowledge = () => useKb.getState().entries.length > 0;


export const KB_TOOL_NAMES = new Set(["search_knowledge", "read_knowledge", "save_knowledge"]);

const SEARCH: LlmToolDef = {
  name: "search_knowledge",
  description:
    "Search the knowledge base shared by every agent and the user: notes about the user's servers, projects, procedures, conventions and past fixes. Returns the best-matching sections with note ids. Use it before guessing at anything specific to the user's environment.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords or a short question, in the language the notes are likely written in." },
      limit: { type: "number", description: "Default 4, max 10." },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const READ: LlmToolDef = {
  name: "read_knowledge",
  description:
    "Read a note from the knowledge base by id (from search_knowledge); pass a section heading to read only that part. Long notes are cut at ~8k characters.",
  inputSchema: {
    type: "object",
    properties: { id: { type: "string" }, section: { type: "string", description: "A heading in the note (optional)." } },
    required: ["id"],
    additionalProperties: false,
  },
};

const SAVE: LlmToolDef = {
  name: "save_knowledge",
  description:
    "Remember something for future tasks, in the knowledge base every agent shares. Save durable facts only: how the user's machines and projects are set up (hosts, paths, versions, services), procedures that worked, fixes for problems you solved, preferences the user stated. Not progress reports, temporary output or secrets (never passwords, tokens or keys). Search first: to change an existing note pass its id and the complete new content; a new note with an existing title replaces that note.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Short and specific, e.g. “web01 nginx setup”." },
      content: { type: "string", description: "Markdown: the facts, concise, with the names, paths and commands that make it findable." },
      tags: { type: "array", items: { type: "string" } },
      id: { type: "string", description: "An existing note to replace (optional)." },
    },
    required: ["title", "content"],
    additionalProperties: false,
  },
};

/** Saving is always offered (that's how the base fills up); searching once there is something. */
export const kbTools = (): LlmToolDef[] => (hasKnowledge() ? [SEARCH, READ, SAVE] : [SAVE]);

export async function runKbTool(name: string, args: Record<string, unknown>) {
  const out = await ipc.kbTool(name, args);
  if (name === "save_knowledge") void refreshKb();
  return out;
}

/** A tool step's one-line label. */
export function kbToolLabel(name: string, a: Record<string, unknown>) {
  return name === "save_knowledge" ? String(a.title ?? "") : String(a.query ?? a.id ?? "");
}

export const kbPrompt = () =>
  [
    hasKnowledge()
      ? "There is a knowledge base shared by you, the other agents and the user (notes on their servers, projects, procedures, conventions). When the task touches their environment, search_knowledge before guessing, and follow what the notes say."
      : "",
    "When you learn something durable about the user's environment — how a machine or project is set up, a procedure that worked, the fix for a problem, a preference they stated — save it with save_knowledge (short, specific, no secrets) so later tasks don't have to rediscover it. Don't save progress or one-off output.",
  ]
    .filter(Boolean)
    .join(" ");

// ------------------------------------------------------------------ picking what to show an agent

/** Rough query terms (Latin words, CJK pairs), to keep only the lines of a section that matter. */
function terms(text: string) {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? []) out.add(w);
  for (const run of text.match(/[㐀-鿿]+/g) ?? []) for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
  return out;
}

/** The lines of a section that mention the task (plus their heading), within a size. */
function relevantLines(snippet: string, t: Set<string>, max: number) {
  const lines = snippet.split("\n");
  const keep = new Set<number>();
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    for (const x of t)
      if (low.includes(x)) {
        keep.add(i);
        if (i > 0 && /^#/.test(lines[i - 1])) keep.add(i - 1);
        break;
      }
  });
  const picked = keep.size ? [...keep].sort((a, b) => a - b).map((i) => lines[i]) : lines.slice(0, 6);
  const text = picked.join("\n").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

const picks = new Map<string, string>();

/**
 * What an agent should know from the knowledge base before it starts on `text`, as a
 * prompt section ("" when nothing applies). Never the notes wholesale: a few candidate
 * sections are recalled, weak ones dropped, and what's left is cut down to the facts that
 * bear on the task — by the model when `extract` is given, else by keeping matching lines —
 * within `budget` characters. The agent can search for more itself.
 */
export async function knowledgeFor(
  text: string,
  opts: { budget?: number; extract?: (system: string, user: string) => Promise<string> } = {},
): Promise<string> {
  const budget = opts.budget ?? 1800;
  await ensureKb();
  const { entries } = useKb.getState();
  if (!entries.length || !text.trim()) return "";
  const key = `${budget}|${entries.length}|${Math.max(...entries.map((e) => e.updated))}|${text}`;
  const cached = picks.get(key);
  if (cached !== undefined) return cached;

  let hits: Awaited<ReturnType<typeof ipc.kbSearch>> = [];
  try {
    hits = await ipc.kbSearch(text.slice(0, 2000), 10);
  } catch {
    /* nothing to add */
  }
  // Weak matches against a long task are mostly noise: keep those near the best one.
  const best = hits[0]?.score ?? 0;
  const cands = hits.filter((h) => h.score >= best * 0.4).slice(0, 8);
  const head = (h: (typeof hits)[number]) => `${h.title}${h.section && h.section !== h.title ? ` › ${h.section}` : ""} (id: ${h.id})`;
  const whole = () => cands.map((h) => `### ${head(h)}\n${h.snippet.trim()}`).join("\n\n");

  let body = "";
  const total = cands.reduce((n, h) => n + h.snippet.length, 0);
  if (cands.length && total <= budget) body = whole();
  else if (cands.length && opts.extract) {
    const system = `You pick, from notes in a knowledge base, only what an AI agent needs for the task below — nothing else. Quote facts exactly (names, hosts, paths, commands, versions); drop everything unrelated. Reply with a compact Markdown bullet list, each bullet ending with its source note id in parentheses, at most ${Math.round(budget / 1.5)} characters in all. If nothing is relevant, reply exactly NONE.`;
    const user = `Task:\n${text.slice(0, 3000)}\n\nNotes:\n${whole()}`;
    try {
      const out = (await opts.extract(system, user)).trim();
      body = /^NONE\.?$/i.test(out) ? "" : out.slice(0, Math.round(budget * 1.2));
    } catch {
      body = lineCut();
    }
  } else if (cands.length) body = lineCut();

  // No model to summarize with: the lines that mention the task, best sections first.
  function lineCut() {
    const t = terms(text);
    const parts: string[] = [];
    let used = 0;
    for (const h of cands) {
      const room = budget - used;
      if (room < 160) break;
      const lines = relevantLines(h.snippet, t, Math.min(700, room - 60));
      parts.push(`### ${head(h)}\n${lines}`);
      used += lines.length + 60;
    }
    return parts.join("\n\n");
  }

  const out = body
    ? [
        "## From the knowledge base",
        "Picked for this task from notes the user and earlier agents kept (search_knowledge / read_knowledge for more). Follow them where they apply.",
        "",
        body,
      ].join("\n")
    : "";
  picks.set(key, out);
  if (picks.size > 200) picks.delete(picks.keys().next().value as string);
  return out;
}
