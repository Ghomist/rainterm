// The agent as a side-panel view: a conversation per terminal, about and acting in the
// terminal you're on (it types there visibly; typing yourself interrupts it).
import {
  ArrowUp,
  Brain,
  Check,
  ChevronRight,
  CircleStop,
  Hand,
  Keyboard,
  Plus,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  X,
  Zap,
} from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { IconButton, PanelHeader } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import {
  type AgentThread,
  answerApproval,
  ask,
  resetThread,
  type Step,
  setAgentOpen,
  setAutonomy,
  stopAgent,
  useAgent,
} from "@/lib/agent/agent";
import type { AgentAutonomy } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { type Pane, useActivePane, useApp } from "@/store/app";

const MODES: { id: AgentAutonomy; label: string; tip: string; icon: React.ReactNode }[] = [
  { id: "suggest", label: "Suggest", tip: "Only types commands at the prompt — you press Enter", icon: <Keyboard /> },
  { id: "confirm", label: "Confirm", tip: "Asks before running each command", icon: <ShieldCheck /> },
  { id: "auto", label: "Auto", tip: "Runs read-only commands on its own; asks for anything else", icon: <Zap /> },
];

/** Ctrl+I focuses this (App dispatches "agent-focus"). */
export const AGENT_INPUT_ID = "agent-composer";

export function AgentPanel() {
  const pane = useActivePane();
  const t = useAgent((s) => (pane ? s.threads[pane.id] : undefined)) as AgentThread | undefined;
  const configured = useApp((s) => !!s.settings.agent.model.trim());
  const set = useApp((s) => s.set);

  // The panel being visible counts as "seen".
  useEffect(() => {
    if (pane) setAgentOpen(pane.id, true);
    return () => {
      if (pane) setAgentOpen(pane.id, false);
    };
  }, [pane?.id]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Agent" icon={<Sparkles />}>
        <IconButton
          tip="New conversation"
          onClick={() => pane && resetThread(pane.id)}
          disabled={!pane || !t?.steps.length || (t.status !== "idle" && t.status !== "error")}
        >
          <Plus />
        </IconButton>
      </PanelHeader>
      {pane && (
        <div className="flex items-center gap-1.5 px-3 pb-2 text-[11.5px] text-muted-foreground [&_svg]:size-3.5">
          <SquareTerminal className="shrink-0" />
          <span className="truncate">
            Working in <span className="text-foreground/85">{pane.title}</span>
            {pane.kind === "ssh" && <span className="opacity-70"> · {pane.subtitle}</span>}
          </span>
        </div>
      )}
      {!pane ? (
        <Empty text="Open a terminal — the agent works in the one you're on." />
      ) : (
        <Conversation key={pane.id} pane={pane} t={t} configured={configured} openSettings={() => set({ settingsOpen: true })} />
      )}
    </div>
  );
}

function Empty({ text, children }: { text: string; children?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12px] leading-relaxed text-muted-foreground">
      <Sparkles className="size-6 text-primary/60" />
      <span className="max-w-60">{text}</span>
      {children}
    </div>
  );
}

function Conversation({
  pane,
  t,
  configured,
  openSettings,
}: {
  pane: Pane;
  t: AgentThread | undefined;
  configured: boolean;
  openSettings: () => void;
}) {
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const busy = !!t && t.status !== "idle" && t.status !== "error";
  const steps = t?.steps ?? [];
  const autonomy = t?.autonomy ?? useApp.getState().settings.agent.autonomy;

  useEffect(() => {
    const onFocus = () => input.current?.focus();
    window.addEventListener("agent-focus", onFocus);
    return () => window.removeEventListener("agent-focus", onFocus);
  }, []);
  // Stick to the bottom while new steps stream in (unless you scrolled up to read).
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = list.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [t?.steps, t?.approval]);
  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [text]);

  const send = () => {
    const q = text.trim();
    if (!q || busy) return;
    setText("");
    pinned.current = true;
    void ask(pane.id, q);
  };
  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      if (t?.approval) {
        // Empty: run it. Typed text: decline, with that as the reason.
        if (text.trim()) {
          answerApproval(pane.id, false, text.trim());
          setText("");
        } else answerApproval(pane.id, true);
      } else send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (t?.approval) answerApproval(pane.id, false);
      else if (busy) stopAgent(pane.id, "Stopped.");
      else if (text) setText("");
      else pane.session.focus();
    }
  };

  return (
    <>
      <div
        ref={list}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-3 pb-3 text-[12.5px] leading-relaxed"
      >
        {!configured ? (
          <Empty text="Set up a model first (OpenAI-compatible or Anthropic API).">
            <button
              type="button"
              onClick={openSettings}
              className="press rounded-md border border-ov/10 px-2.5 py-1 text-foreground/90 hover:bg-ov/[0.05]"
            >
              Settings → Agent
            </button>
          </Empty>
        ) : steps.length === 0 ? (
          <Empty text="Ask about this terminal, or tell it what to do. It sees what's on screen and runs commands here — you watch, and typing in the terminal stops it.">
            <span className="text-[11px] opacity-70">
              <kbd className="rounded border border-border bg-ov/5 px-1">Ctrl+I</kbd> jumps here and back
            </span>
          </Empty>
        ) : (
          steps.map((s) => <StepView key={s.id} s={s} pane={pane} approving={t?.approval?.stepId === s.id} />)
        )}
      </div>

      <div className="shrink-0 p-2 pt-0">
        <div
          className={cn(
            "rounded-lg border bg-inset transition-colors focus-within:border-primary/50",
            t?.approval ? "border-warning/40" : "border-ov/10",
          )}
        >
          <textarea
            id={AGENT_INPUT_ID}
            ref={input}
            rows={1}
            value={text}
            spellCheck={false}
            disabled={!configured}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKey}
            placeholder={
              t?.approval
                ? "Enter to run · Esc to skip · or say why not"
                : busy
                  ? `${t?.activity || "Working…"} (Esc to stop)`
                  : steps.length
                    ? "Follow up…"
                    : "Ask or tell it what to do…"
            }
            className="block w-full resize-none bg-transparent px-2.5 pt-2 pb-1 text-[12.5px] leading-snug outline-none placeholder:text-muted-foreground/60"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <ModePicker paneId={pane.id} value={autonomy} />
            <span className="min-w-0 flex-1 truncate px-1 text-[10.5px] text-muted-foreground/70">
              {busy ? (
                <span className="inline-flex items-center gap-1.5">
                  <span className="size-1.5 animate-pulse rounded-full bg-primary" />
                  {t?.activity}
                </span>
              ) : t?.tokens.input ? (
                `${fmtK(t.tokens.input)} in · ${fmtK(t.tokens.output)} out`
              ) : null}
            </span>
            {busy ? (
              <Tooltip content="Stop (Esc)" side="top">
                <button
                  type="button"
                  onClick={() => stopAgent(pane.id, "Stopped.")}
                  className="press flex size-6.5 items-center justify-center rounded-md text-destructive hover:bg-destructive/10 [&_svg]:size-4"
                >
                  <CircleStop />
                </button>
              </Tooltip>
            ) : (
              <Tooltip content="Send (Enter)" side="top">
                <button
                  type="button"
                  disabled={!text.trim() || !configured}
                  onClick={send}
                  className="press flex size-6.5 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:bg-ov/[0.08] disabled:text-muted-foreground [&_svg]:size-4"
                >
                  <ArrowUp />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

function ModePicker({ paneId, value }: { paneId: string; value: AgentAutonomy }) {
  const i = Math.max(0, MODES.findIndex((m) => m.id === value));
  const m = MODES[i];
  return (
    <Tooltip content={`${m.label}: ${m.tip} — click to switch`} side="top">
      <button
        type="button"
        onClick={() => setAutonomy(paneId, MODES[(i + 1) % MODES.length].id)}
        className={cn(
          "press flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] font-medium [&_svg]:size-3.5",
          value === "auto" ? "bg-warning/12 text-warning" : value === "suggest" ? "bg-ov/[0.07] text-muted-foreground" : "bg-primary/12 text-primary",
        )}
      >
        {m.icon}
        {m.label}
      </button>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ steps

function StepView({ s, pane, approving }: { s: Step; pane: Pane; approving: boolean }) {
  const [open, setOpen] = useState(false);
  switch (s.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <div className="max-w-[88%] rounded-lg rounded-br-sm bg-primary/14 px-2.5 py-1.5 break-words whitespace-pre-wrap text-foreground">
            {s.text}
          </div>
        </div>
      );
    case "thinking":
      return (
        <div>
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground hover:text-foreground"
          >
            <Brain className={cn("size-3.5", s.live && "text-primary")} />
            {s.live ? <span className="shimmer">Thinking…</span> : `Thought for ${Math.max(1, Math.round(s.ms / 1000))}s`}
            {!s.live && s.text && <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />}
          </button>
          {open && s.text && (
            <div className="mt-1 ml-[7px] max-h-56 overflow-y-auto border-l border-ov/10 pl-3 text-[11.5px] whitespace-pre-wrap text-muted-foreground">
              {s.text}
            </div>
          )}
        </div>
      );
    case "text":
      return (
        <div className="text-foreground/95">
          <Markdown text={s.text} pane={pane} />
          {s.live && <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-primary/70 align-middle" />}
        </div>
      );
    case "tool": {
      const live = s.state === "running" || s.state === "pending";
      const failed = s.state === "error";
      return (
        <div className={cn("overflow-hidden rounded-md border", approving ? "border-warning/40 bg-warning/[0.06]" : "border-ov/[0.07] bg-inset/60")}>
          <button
            type="button"
            onClick={() => s.result && setOpen(!open)}
            className="flex w-full min-w-0 items-center gap-2 px-2 py-1.5 text-left"
          >
            <span
              className={cn(
                "flex size-4 shrink-0 items-center justify-center [&_svg]:size-3.5",
                approving ? "text-warning" : live ? "text-primary" : failed ? "text-destructive" : s.state === "declined" ? "text-muted-foreground" : "text-success",
              )}
            >
              {approving ? <Hand /> : live ? <span className="size-2 animate-pulse rounded-full bg-current" /> : failed || s.state === "declined" ? <X /> : <Check />}
            </span>
            <code
              className={cn(
                "min-w-0 flex-1 font-mono text-[11.5px] text-foreground",
                // What you're asked to approve is shown in full.
                approving ? "break-all whitespace-pre-wrap" : "truncate",
                s.state === "declined" && "line-through opacity-60",
              )}
            >
              {s.tool === "read_terminal" ? `read terminal (${s.label})` : s.tool === "send_keys" ? `keys: ${s.label}` : s.label}
            </code>
            {s.exitCode != null && s.exitCode !== 0 && <span className="shrink-0 font-mono text-[10.5px] text-destructive">exit {s.exitCode}</span>}
            {s.result && <ChevronRight className={cn("size-3 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />}
          </button>
          {approving && (
            <div className="flex items-center gap-1.5 border-t border-warning/20 px-2 py-1.5">
              <span className="flex-1 text-[11px] text-muted-foreground">Run this in the terminal?</span>
              <button
                type="button"
                onClick={() => answerApproval(pane.id, true)}
                className="press rounded-md bg-primary px-2 py-0.5 text-[11.5px] font-medium text-primary-foreground"
              >
                Run ⏎
              </button>
              <button
                type="button"
                onClick={() => answerApproval(pane.id, false)}
                className="press rounded-md px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-ov/[0.06] hover:text-foreground"
              >
                Skip
              </button>
            </div>
          )}
          {open && s.result && (
            <pre className="max-h-64 overflow-auto border-t border-ov/[0.06] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground select-text">
              {s.result}
            </pre>
          )}
        </div>
      );
    }
    case "error":
      return <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] break-words text-destructive">{s.text}</div>;
    case "note":
      return <div className="text-center text-[11px] text-muted-foreground">{s.text}</div>;
  }
}

// ------------------------------------------------------------------ markdown (small)

function Markdown({ text, pane }: { text: string; pane: Pane }) {
  const parts = text.split(/^```[^\n]*\n([\s\S]*?)(?:^```\s*$|$(?![\s\S]))/m);
  return (
    <div className="space-y-1.5">
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split
          <CodeBlock key={i} code={p.replace(/\n$/, "")} pane={pane} />
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split
          <Prose key={i} text={p} />
        ),
      )}
    </div>
  );
}

function Prose({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const L = list.ordered ? "ol" : "ul";
    out.push(
      <L key={out.length} className={cn("space-y-0.5 pl-4.5", list.ordered ? "list-decimal" : "list-disc")}>
        {list.items.map((it, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static
          <li key={j}>{inline(it)}</li>
        ))}
      </L>,
    );
    list = null;
  };
  for (const raw of text.split("\n")) {
    const l = raw.trimEnd();
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(l);
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(l);
    if (bullet || num) {
      const ordered = !!num;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((bullet ?? num)![1]);
      continue;
    }
    flush();
    if (!l.trim()) continue;
    const h = /^(#{1,4})\s+(.*)$/.exec(l);
    out.push(
      h ? (
        <div key={out.length} className="pt-0.5 font-semibold text-foreground">
          {inline(h[2])}
        </div>
      ) : (
        <p key={out.length}>{inline(l)}</p>
      ),
    );
  }
  flush();
  return <>{out}</>;
}

function inline(s: string): React.ReactNode[] {
  return s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("`") && part.endsWith("`") && part.length > 2 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static
      <code key={i} className="rounded bg-inset px-1 py-px font-mono text-[11.5px] text-foreground">
        {part.slice(1, -1)}
      </code>
    ) : part.startsWith("**") && part.endsWith("**") && part.length > 4 ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: static
      <strong key={i} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      part
    ),
  );
}

function CodeBlock({ code, pane }: { code: string; pane: Pane }) {
  const oneLine = !code.includes("\n");
  return (
    <div className="group relative">
      <pre className="overflow-x-auto rounded-md bg-inset px-2.5 py-1.5 font-mono text-[11.5px] leading-relaxed text-foreground select-text">{code}</pre>
      {oneLine && (
        <Tooltip content="Type it at the prompt (you press Enter)" side="left">
          <button
            type="button"
            onClick={() => {
              pane.session.agentInput(code.trim());
              pane.session.focus();
            }}
            className="press absolute top-1 right-1 flex items-center gap-1 rounded bg-popover px-1.5 py-0.5 text-[10.5px] text-muted-foreground opacity-0 shadow-sm transition-opacity group-hover:opacity-100 hover:text-foreground"
          >
            <Keyboard className="size-3" /> Type
          </button>
        </Tooltip>
      )}
    </div>
  );
}
