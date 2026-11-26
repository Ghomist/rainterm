// In-app replacements for confirm()/prompt()/notifications. Promise-based so call
// sites read like the browser APIs: `if (await confirm({...})) ...`.
import { create } from "zustand";

export interface ConfirmOpts {
  title: string;
  message?: string;
  /** Shown as-is in a monospace block (a command, pasted text…). */
  detail?: string;
  confirmLabel?: string;
  danger?: boolean;
}

export interface PromptOpts {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Return an error message to block submit. */
  validate?: (v: string) => string | null;
  /** Pre-select the name part (before the extension), like file managers do. */
  selectBaseName?: boolean;
}

export type ToastKind = "info" | "success" | "error" | "progress";

export interface Toast {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
  progress?: number; // 0..1 for kind "progress"
  action?: { label: string; run: () => void };
}

type Dialog =
  | { kind: "confirm"; opts: ConfirmOpts; resolve: (v: boolean) => void }
  | { kind: "prompt"; opts: PromptOpts; resolve: (v: string | null) => void };

interface OverlayState {
  dialog: Dialog | null;
  toasts: Toast[];
}

export const useOverlay = create<OverlayState>(() => ({ dialog: null, toasts: [] }));

export function confirm(opts: ConfirmOpts): Promise<boolean> {
  return new Promise((resolve) => useOverlay.setState({ dialog: { kind: "confirm", opts, resolve } }));
}

export function prompt(opts: PromptOpts): Promise<string | null> {
  return new Promise((resolve) => useOverlay.setState({ dialog: { kind: "prompt", opts, resolve } }));
}

export function closeDialog(value: boolean | string | null) {
  const d = useOverlay.getState().dialog;
  if (!d) return;
  useOverlay.setState({ dialog: null });
  if (d.kind === "confirm") d.resolve(value === true);
  else d.resolve(typeof value === "string" ? value : null);
}

let toastSeq = 0;
const timers = new Map<number, number>();

export function toast(t: Omit<Toast, "id"> & { duration?: number }): number {
  const id = ++toastSeq;
  const { duration, ...rest } = t;
  useOverlay.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, ...rest }] }));
  scheduleDismiss(id, duration ?? (t.kind === "error" ? 7000 : t.kind === "progress" ? 0 : 3500));
  return id;
}

export function updateToast(id: number, patch: Partial<Toast> & { duration?: number }) {
  const { duration, ...rest } = patch;
  useOverlay.setState((s) => ({ toasts: s.toasts.map((x) => (x.id === id ? { ...x, ...rest } : x)) }));
  if (duration !== undefined) scheduleDismiss(id, duration);
}

export function dismissToast(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  useOverlay.setState((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) }));
}

function scheduleDismiss(id: number, ms: number) {
  clearTimeout(timers.get(id));
  if (ms > 0) timers.set(id, window.setTimeout(() => dismissToast(id), ms));
}
