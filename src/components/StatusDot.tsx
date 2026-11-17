import { cn } from "@/lib/utils";
import type { TabStatus } from "@/store/app";

const color: Record<TabStatus, string> = {
  connecting: "bg-warning",
  connected: "bg-success",
  exited: "bg-muted-foreground/50",
  error: "bg-destructive",
};

export function StatusDot({ status, className }: { status: TabStatus; className?: string }) {
  return (
    <span className={cn("relative inline-flex size-1.5 shrink-0", className)}>
      {status === "connecting" && (
        <span className={cn("absolute inset-0 animate-ping rounded-full opacity-75", color[status])} />
      )}
      <span
        className={cn(
          "relative inline-flex size-1.5 rounded-full transition-colors duration-300",
          color[status],
        )}
      />
    </span>
  );
}
