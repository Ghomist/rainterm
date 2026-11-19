// In-terminal signs of the agent (the conversation itself lives in the Agent side view):
// the pane glows while the agent is typing into it, and a small chip shows up when the
// agent is working here (or finished) while its conversation isn't on screen.
import { Sparkles } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { type AgentThread, useAgent } from "@/lib/agent/agent";
import { cn } from "@/lib/utils";
import { type Pane, useApp } from "@/store/app";

export function AgentBar({ pane }: { pane: Pane }) {
  const t = useAgent((s) => s.threads[pane.id]) as AgentThread | undefined;
  const toggleView = useApp((s) => s.toggleView);
  if (!t) return null;
  const busy = t.status !== "idle" && t.status !== "error";
  return (
    <>
      <div
        className={cn(
          "pointer-events-none absolute inset-0 z-[15] ring-1 ring-primary/45 ring-inset transition-opacity duration-300",
          t.typing ? "opacity-100" : "opacity-0",
        )}
      />
      <AnimatePresence>
        {!t.open && (busy || t.unseen) && (
          <motion.button
            key="chip"
            type="button"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            onClick={() => toggleView("agent", true)}
            className="press absolute right-4 bottom-3 z-20 flex items-center gap-1.5 rounded-full border border-primary/30 bg-popover px-2.5 py-1 text-[11.5px] text-foreground shadow-lg shadow-shadow"
          >
            <Sparkles className={cn("size-3.5 text-primary", busy && "animate-pulse")} />
            {t.status === "approval" ? "Waiting for your OK" : busy ? t.activity || "Working…" : "Agent finished — view"}
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}
