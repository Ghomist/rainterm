import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { closeDialog, dismissToast, type Toast, useOverlay } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { tr } from "@/lib/i18n";

export function Overlays() {
  return (
    <>
      <DialogHost />
      <Toaster />
    </>
  );
}

function DialogHost() {
  const dialog = useOverlay((s) => s.dialog);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (dialog?.kind !== "prompt") return;
    setValue(dialog.opts.value ?? "");
    setError(null);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const v = dialog.opts.value ?? "";
      const dot = v.lastIndexOf(".");
      if (dialog.opts.selectBaseName && dot > 0) el.setSelectionRange(0, dot);
      else el.select();
    });
  }, [dialog]);

  const open = !!dialog;
  const opts = dialog?.opts;
  const danger = dialog?.kind === "confirm" && dialog.opts.danger;

  const submit = () => {
    if (dialog?.kind === "prompt") {
      const err = dialog.opts.validate?.(value) ?? (value.trim() ? null : "Required");
      if (err) return setError(err);
      closeDialog(value);
    } else closeDialog(true);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && closeDialog(dialog?.kind === "prompt" ? null : false)}>
      <DialogContent showClose={false} className="max-w-[min(400px,calc(100%-2rem))] gap-3.5">
        <DialogHeader>
          {danger && (
            <div className="mb-1 flex size-9 items-center justify-center rounded-lg bg-destructive/15 text-destructive">
              <AlertTriangle className="size-4.5" />
            </div>
          )}
          <DialogTitle>{opts?.title}</DialogTitle>
          {opts?.message && <DialogDescription className="break-words">{opts.message}</DialogDescription>}
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          {dialog?.kind === "prompt" && (
            <div className="grid gap-1">
              <Input
                ref={inputRef}
                value={value}
                placeholder={dialog.opts.placeholder}
                onChange={(e) => {
                  setValue(e.target.value);
                  setError(null);
                }}
                className={cn(error && "border-destructive/70")}
              />
              <AnimatePresence>
                {error && (
                  <motion.span
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="text-[11.5px] text-destructive"
                  >
                    {error}
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          )}
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => closeDialog(dialog?.kind === "prompt" ? null : false)}
            >
              {tr("Cancel")}
            </Button>
            <Button type="submit" variant={danger ? "destructive" : "default"} autoFocus={dialog?.kind === "confirm"}>
              {opts?.confirmLabel ?? tr("OK")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const icons = {
  info: <Info className="size-4 text-primary" />,
  success: <CheckCircle2 className="size-4 text-success" />,
  error: <XCircle className="size-4 text-destructive" />,
  progress: <Loader2 className="size-4 animate-spin text-primary" />,
};

function Toaster() {
  const toasts = useOverlay((s) => s.toasts);
  return (
    <div className="pointer-events-none fixed right-4 bottom-9 z-[90] flex w-80 flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((t) => (
          <ToastView key={t.id} t={t} />
        ))}
      </AnimatePresence>
    </div>
  );
}

function ToastView({ t }: { t: Toast }) {
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, x: 40, transition: { duration: 0.15 } }}
      transition={{ type: "spring", stiffness: 480, damping: 34 }}
      className="pointer-events-auto w-full overflow-hidden rounded-xl border border-ov/10 bg-popover shadow-xl shadow-shadow"
    >
      <div className="flex items-start gap-2.5 p-3">
        <div className="mt-px">{icons[t.kind]}</div>
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-medium">{t.title}</div>
          {t.description && (
            <div className="mt-0.5 text-[11.5px] break-words text-muted-foreground select-text">
              {t.description}
            </div>
          )}
          {t.action && (
            <button
              type="button"
              onClick={() => {
                t.action?.run();
                dismissToast(t.id);
              }}
              className="mt-1.5 text-[12px] font-medium text-primary hover:underline"
            >
              {t.action.label}
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={() => dismissToast(t.id)}
          className="rounded p-0.5 text-muted-foreground opacity-60 transition hover:bg-ov/10 hover:opacity-100"
        >
          <X className="size-3.5" />
        </button>
      </div>
      {t.kind === "progress" && (
        <div className="h-0.5 bg-ov/[0.06]">
          <motion.div
            className="h-full bg-primary"
            animate={{ width: `${Math.round((t.progress ?? 0) * 100)}%` }}
            transition={{ ease: "easeOut", duration: 0.2 }}
          />
        </div>
      )}
    </motion.div>
  );
}
