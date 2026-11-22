import { Activity } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { fmtLatency, latencyTone, useLatency } from "@/lib/latency";
import { cn } from "@/lib/utils";
import type { Pane } from "@/store/app";
import { tr } from "@/lib/i18n";

/** Round-trip time to a connected SSH server; nothing for other sessions. */
export function Latency({ pane, className }: { pane: Pane; className?: string }) {
  const id = pane.kind === "ssh" && pane.status === "connected" ? pane.session?.sessionId : null;
  const ms = useLatency((s) => (id ? s.ms[id] : undefined));
  if (!id || ms === undefined) return null;
  return (
    <Tooltip content={ms == null ? tr("The server didn't answer the last ping") : tr("Round trip to the server (SSH ping)")} side="top">
      <span className={cn("flex shrink-0 items-center gap-1 tabular-nums", className)}>
        <Activity className={cn("size-3", latencyTone(ms))} />
        {fmtLatency(ms)}
      </span>
    </Tooltip>
  );
}
