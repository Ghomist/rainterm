import { AlertTriangle, RotateCcw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { tr } from "@/lib/i18n";

/** Keeps one broken panel from taking the whole window (terminals included) down with it. */
export class ErrorBoundary extends Component<{ children: ReactNode; label?: string }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error(`[${this.props.label ?? "panel"}]`, error);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-muted-foreground">
        <AlertTriangle className="size-5 text-warning" />
        <span>{this.props.label ?? tr("This panel")} {tr("hit an error.")}</span>
        <span className="max-w-64 break-words font-mono text-[11px] opacity-70">{String(this.state.error.message)}</span>
        <button
          type="button"
          onClick={() => this.setState({ error: null })}
          className="press mt-1 flex items-center gap-1.5 rounded-md border border-ov/10 px-2.5 py-1 text-foreground/90 hover:bg-ov/[0.05]"
        >
          <RotateCcw className="size-3.5" /> {tr("Try again")}
        </button>
      </div>
    );
  }
}
