// The entry point of the agents session: you talk, a small model call works out what you
// mean (start a goal, add to one, cancel, retry, or just answer about the board) and the
// engine does the rest. It never does the work itself — that is what goals are for.
import { tr } from "@/lib/i18n";
import type { LlmMessage, LlmToolDef } from "@/lib/ipc";
import { shortName } from "./config";
import { forge } from "./engine";
import { complete, hasModel, languageRule, textOf } from "./llm";
import { useForge } from "./store";
import type { TimelineItem } from "./types";

const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => new Date().toISOString();

const goalName = (id: string) => {
  const g = forge.store.goals.get(id);
  return g ? shortName(g.text, 40) : id;
};

function say(from: TimelineItem["from"], text: string, goal?: string) {
  forge.store.addTimeline({ id: uid(), at: now(), from, text, goal });
}

const TOOLS: LlmToolDef[] = [
  {
    name: "start_goal",
    description:
      "Start a new goal for the worker agents (anything that needs real work: code changes, investigation, checking machines, writing documents). Write the goal as a clear, self-contained task in the user's language, keeping every detail they gave.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        workspace: { type: "string", description: "Local project folder (absolute path) if the work is on one; omit for none. Defaults to the folder selected in the composer." },
      },
      required: ["text"],
      additionalProperties: false,
    },
  },
  {
    name: "follow_up",
    description: "Add information or a correction to an existing goal (answers to its questions, changed requirements). A stopped goal continues with it.",
    inputSchema: { type: "object", properties: { goal_id: { type: "string" }, text: { type: "string" } }, required: ["goal_id", "text"], additionalProperties: false },
  },
  {
    name: "cancel_goal",
    description: "Stop a goal and everything running for it.",
    inputSchema: { type: "object", properties: { goal_id: { type: "string" } }, required: ["goal_id"], additionalProperties: false },
  },
  {
    name: "retry_story",
    description: "Run a stuck or failed story (US-n) again.",
    inputSchema: { type: "object", properties: { story_id: { type: "string" } }, required: ["story_id"], additionalProperties: false },
  },
];

function board(): string {
  const st = useForge.getState();
  const goals = Object.values(st.goals)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 15);
  if (!goals.length) return "(no goals yet)";
  return goals
    .map((g) => {
      const ss = Object.values(st.stories).filter((s) => s.goal === g.id);
      const stories = ss
        .map((s) => `  - ${s.id} [${s.status}] ${s.title}${s.blockedReason ? ` — ${s.blockedReason.slice(0, 200)}` : ""}${s.status === "done" && s.handoff?.summary ? ` — ${s.handoff.summary.slice(0, 300)}` : ""}`)
        .join("\n");
      return `- ${g.id} [${g.status}] ${g.text.slice(0, 300)}${g.workspace ? ` (folder ${g.workspace})` : ""}${g.note ? `\n  note: ${g.note.slice(0, 300)}` : ""}${stories ? `\n${stories}` : ""}${g.report ? `\n  result: ${g.report.slice(0, 1200)}` : ""}`;
    })
    .join("\n");
}

function history(): LlmMessage[] {
  const items = forge.store.timeline.filter((t) => t.from !== "system").slice(-16);
  const out: LlmMessage[] = [];
  for (const t of items) {
    const role = t.from === "user" ? "user" : "assistant";
    const text = t.goal ? `${t.text}\n[${t.goal}]` : t.text;
    const last = out[out.length - 1];
    if (last?.role === role) (last.content[0] as { text: string }).text += `\n\n${text}`;
    else out.push({ role, content: [{ type: "text", text }] });
  }
  while (out.length && out[0].role !== "user") out.shift();
  return out;
}

/** Something the user typed in the agents session. `goal`: the goal they're replying to. */
export async function send(text: string, opts: { workspace?: string; goal?: string } = {}) {
  text = text.trim();
  if (!text) return;
  await forge.start();
  say("user", text, opts.goal);
  if (!hasModel()) {
    // no model for the entry: a reply goes to its goal, anything else is a new goal
    try {
      if (opts.goal) {
        forge.postMessage(opts.goal, text);
        say("system", tr("Added to “{0}”.", { 0: goalName(opts.goal) }), opts.goal);
      } else {
        const g = await forge.submitGoal(text, opts.workspace);
        say("agent", tr("Started: {0}", { 0: shortName(g.text, 40) }), g.id);
      }
    } catch (e) {
      say("system", (e as Error).message);
    }
    return;
  }
  useForge.setState({ thinking: true });
  try {
    const system = `You are the front desk of the agents session in rainterm, a terminal app. A team of worker agents (coding agents and rainterm's own agent, which can use the user's terminals and saved SSH hosts) does the real work as goals: each goal is planned into stories, executed, independently verified, and code changes are merged only after the user approves.
You never do the work yourself. Decide what the user means:
- a task → start_goal (one goal per independent task);
- more information, an answer, or a change for a goal that exists → follow_up;
- stop → cancel_goal; try again → retry_story or follow_up;
- a question about progress or results → answer from the board below;
- small talk → a short reply.
Reply briefly. Refer to goals and tasks by what they are about — never by ids like G-3 or US-7, the user doesn't know them. After calling a tool, say in one short sentence what you did. Don't repeat the board back. When asked about a finished goal, answer from its result.
${languageRule()}
${opts.goal ? `The user is replying to ${opts.goal} (“${goalName(opts.goal)}”).` : ""}
Composer folder: ${opts.workspace || "(none)"}
Recent folders: ${forge.config.workspaces.slice(0, 6).join(", ") || "(none)"}

Board:
${board()}`;
    const blocks = await complete(system, history(), TOOLS);
    let reply = textOf(blocks);
    let goalRef: string | undefined = opts.goal;
    const notes: string[] = [];
    for (const b of blocks) {
      if (b.type !== "tool_use") continue;
      const a = b.input as Record<string, string>;
      try {
        if (b.name === "start_goal") {
          const g = await forge.submitGoal(a.text || text, a.workspace ?? opts.workspace);
          goalRef = g.id;
          notes.push(tr("Started: {0}", { 0: shortName(g.text, 40) }));
        } else if (b.name === "follow_up") {
          forge.postMessage(a.goal_id, a.text);
          goalRef = a.goal_id;
          notes.push(tr("Added to “{0}”.", { 0: goalName(a.goal_id) }));
        } else if (b.name === "cancel_goal") {
          forge.cancelGoal(a.goal_id);
          goalRef = a.goal_id;
          notes.push(tr("Cancelled “{0}”.", { 0: goalName(a.goal_id) }));
        } else if (b.name === "retry_story") {
          forge.retryStory(a.story_id);
          notes.push(tr("Retrying “{0}”.", { 0: forge.store.stories.get(a.story_id)?.title ?? a.story_id }));
        }
      } catch (e) {
        notes.push((e as Error).message);
      }
    }
    if (!reply) reply = notes.join(" ") || "…";
    say("agent", reply, goalRef);
  } catch (e) {
    say("system", tr("The entry agent failed: {0}", { 0: (e as Error).message }));
  } finally {
    useForge.setState({ thinking: false });
  }
}
