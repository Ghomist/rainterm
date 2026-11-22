import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Circle, Hash, Highlighter, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { isViewOpen, groupById, useActivePane, useApp } from "@/store/app";
import { useActiveMachine } from "./MonitorPanel";
import { Latency } from "./Latency";
import { StatusDot } from "./StatusDot";
import { tr } from "@/lib/i18n";

const label = {
  connecting: "Connecting",
  connected: "Connected",
  exited: "Exited",
  error: "Error",
} as const;

export function StatusBar() {
  const pane = useActivePane();
  const lineNumbers = useApp((s) => s.settings.lineNumbers);
  const broadcast = useApp((s) => s.broadcast);
  const { toggleHighlight, toggleLog, updateSettings, toggleBroadcast } = useApp.getState();
  const [size, setSize] = useState<{ cols: number; rows: number } | null>(null);

  useEffect(() => {
    if (!pane) return setSize(null);
    const term = pane.session.term;
    setSize({ cols: term.cols, rows: term.rows });
    const d = term.onResize(setSize);
    return () => d.dispose();
  }, [pane?.session]);

  const item =
    "flex h-full items-center gap-1 rounded px-1.5 transition-colors hover:bg-ov/[0.06] hover:text-foreground [&_svg]:size-3";

  return (
    <footer className="flex h-6 shrink-0 items-center gap-1 bg-chrome px-2 text-[11px] text-muted-foreground select-none">
      {pane ? (
        <>
          <span className="flex items-center gap-1.5 px-1">
            <StatusDot status={pane.status} />
            {tr(label[pane.status])}
          </span>
          <span className="truncate px-1">{pane.subtitle}</span>
          <Latency pane={pane} className="px-1" />
          {broadcast !== "off" && (
            <button type="button" className={cn(item, "text-warning")} onClick={toggleBroadcast}>
              <Radio /> {tr("Broadcasting to")}{" "}{broadcast === "tab" ? tr("this tab") : tr("all terminals")}
            </button>
          )}
          {groupById(pane.group) && (
            <span className={cn(item, "font-medium")} style={{ color: groupById(pane.group)?.color }}>
              <Radio /> {tr(groupById(pane.group)?.name ?? "")}
            </span>
          )}
          <div className="flex-1" />
          {pane.logPath && (
            <Tooltip content={pane.logPath} side="top">
              <button
                type="button"
                className={cn(item, "text-destructive")}
                onClick={() => pane.logPath && void revealItemInDir(pane.logPath)}
              >
                <Circle className="animate-pulse fill-current" /> {tr("REC")}</button>
            </Tooltip>
          )}
          <Tooltip content={pane.logPath ? tr("Stop logging") : tr("Log session output to a file")} side="top">
            <button
              type="button"
              disabled={!pane.session.alive}
              className={cn(item, "disabled:opacity-40")}
              onClick={() => void toggleLog(pane.id)}
            >
              {pane.logPath ? tr("Stop log") : tr("Log")}
            </button>
          </Tooltip>
          <Tooltip content={tr("Keyword highlighting")} side="top">
            <button
              type="button"
              className={cn(item, pane.highlight && "text-primary")}
              onClick={() => toggleHighlight(pane.id)}
            >
              <Highlighter /> {tr("Highlight")}</button>
          </Tooltip>
          <Tooltip content={tr("Line numbers")} side="top">
            <button
              type="button"
              className={cn(item, lineNumbers && "text-primary")}
              onClick={() => void updateSettings({ lineNumbers: !lineNumbers })}
            >
              <Hash /> {tr("Lines")}</button>
          </Tooltip>
          <span className="px-1.5 tabular-nums">{size && `${size.cols} × ${size.rows}`}</span>
          <span className="px-1.5">{pane.kind === "ssh" ? tr("SSH") : pane.kind === "serial" ? tr("Serial") : tr("PTY")}</span>
        </>
      ) : (
        <span className="flex-1 px-1">{tr("Ready")}</span>
      )}
      <MonitorChip />
    </footer>
  );
}

/** Bottom-left resource summary of the active session's machine; click for the panel. */
function MonitorChip() {
  const { key, state } = useActiveMachine();
  const open = useApp((s) => isViewOpen(s, "monitor"));
  const toggleView = useApp((s) => s.toggleView);
  const snap = state?.snap;
  if (!key || !snap) return null;
  const mem = snap.memTotal ? (snap.memUsed / snap.memTotal) * 100 : 0;
  const gpu = snap.gpus.find((g) => g.util != null)?.util;
  const bar = (pct: number) => (
    <span className="relative h-2 w-1 overflow-hidden rounded-full bg-ov/15">
      <span
        className={cn(
          "absolute inset-x-0 bottom-0 rounded-full transition-[height] duration-500",
          pct > 90 ? "bg-destructive" : pct > 75 ? "bg-warning" : "bg-primary",
        )}
        style={{ height: `${Math.max(8, pct)}%` }}
      />
    </span>
  );
  return (
    <Tooltip content={tr("{0} · resource monitor", { 0: key === "local" ? "This computer" : snap.host })} shortcut="monitor" side="top">
      <button
        type="button"
        onClick={() => toggleView("monitor")}
        className={cn(
          "ml-1 flex h-[18px] items-center gap-2 rounded px-1.5 tabular-nums transition-colors hover:bg-ov/[0.07] hover:text-foreground",
          open && "bg-primary/12 text-primary",
        )}
      >
        <span className="flex items-center gap-1">
          {bar(snap.cpu)}{tr("CPU")}{" "}{snap.cpu.toFixed(0)}%
        </span>
        <span className="flex items-center gap-1">
          {bar(mem)}{tr("MEM")}{" "}{mem.toFixed(0)}%
        </span>
        {gpu != null && (
          <span className="flex items-center gap-1">
            {bar(gpu)}{tr("GPU")}{" "}{gpu.toFixed(0)}%
          </span>
        )}
      </button>
    </Tooltip>
  );
}
