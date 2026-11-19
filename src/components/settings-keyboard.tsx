import { Plus, RotateCcw } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchField } from "@/components/ui/panel";
import { Tooltip } from "@/components/ui/tooltip";
import { ACTIONS, bindingsOf, comboFromEvent, conflictOf, isUsableCombo, keycaps, recording } from "@/lib/keymap";
import { toast } from "@/lib/overlay";
import { useApp } from "@/store/app";
import { Field } from "./dialogs";

const pretty = (combo: string) => keycaps(combo).join(" ");

/** Settings → Shortcuts: every app action with its key combos; click to re-record. */
export function KeyboardSection() {
  const s = useApp((x) => x.settings);
  const update = useApp((x) => x.updateSettings);
  const [query, setQuery] = useState("");
  const [rec, setRec] = useState<{ id: string; index: number } | null>(null);
  const [error, setError] = useState<{ id: string; text: string } | null>(null);

  const setKeys = (id: string, keys: string[], also?: Record<string, string[]>) => {
    const def = ACTIONS.find((a) => a.id === id)?.keys ?? [];
    const next = { ...s.keybindings, ...also };
    if (keys.length === def.length && keys.every((k, i) => k === def[i])) delete next[id];
    else next[id] = keys;
    void update({ keybindings: next });
  };

  // Capture the next combo while recording — ahead of the app's shortcut handler and
  // the dialog's own Esc handling (window capture runs first).
  useEffect(() => {
    if (!rec) return;
    recording.active = true;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        setRec(null);
        return;
      }
      const combo = comboFromEvent(e);
      if (!combo) return; // modifiers alone: keep waiting
      if (!isUsableCombo(combo)) {
        setError({ id: rec.id, text: `${pretty(combo)} would block typing — include Ctrl or Alt, or use an F-key.` });
        return;
      }
      setError(null);
      const keys = [...bindingsOf(s, rec.id)];
      if (rec.index < keys.length) keys[rec.index] = combo;
      else keys.push(combo);
      const other = conflictOf(s, combo, rec.id);
      const also = other ? { [other.id]: bindingsOf(s, other.id).filter((k) => k !== combo) } : undefined;
      setKeys(rec.id, [...new Set(keys)], also);
      if (other) toast({ kind: "info", title: `${pretty(combo)} was moved here from “${other.label}”` });
      setRec(null);
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => {
      recording.active = false;
      window.removeEventListener("keydown", onKey, { capture: true });
    };
  }, [rec, s]);

  const q = query.trim().toLowerCase();
  const groups = [...new Set(ACTIONS.map((a) => a.group))];
  const customized = Object.keys(s.keybindings ?? {}).length > 0;

  return (
    <>
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <SearchField value={query} onChange={setQuery} placeholder="Search shortcuts" />
        </div>
        <Button variant="ghost" size="sm" disabled={!customized} onClick={() => void update({ keybindings: {} })}>
          <RotateCcw /> Reset all
        </Button>
      </div>
      {groups.map((g) => {
        const actions = ACTIONS.filter(
          (a) =>
            a.group === g &&
            (!q ||
              a.label.toLowerCase().includes(q) ||
              bindingsOf(s, a.id).some((k) => pretty(k).toLowerCase().includes(q))),
        );
        if (!actions.length) return null;
        return (
          <Field key={g} label={g}>
            <div className="divide-y divide-ov/[0.05] overflow-hidden rounded-lg border border-ov/[0.07] bg-ov/[0.015]">
              {actions.map((a) => {
                const keys = bindingsOf(s, a.id);
                const custom = !!s.keybindings?.[a.id];
                const here = rec?.id === a.id ? rec : null;
                return (
                  <div key={a.id} className="group/k">
                    <div className="flex min-h-9 items-center gap-3 py-1 pr-2.5 pl-3 transition-colors hover:bg-ov/[0.025]">
                      <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] text-foreground/90">
                        <span className="truncate">{a.label}</span>
                        {custom && (
                          <Tooltip content="Changed from the default">
                            <span className="size-1.5 shrink-0 rounded-full bg-primary" />
                          </Tooltip>
                        )}
                      </span>
                      {/* Row tools only exist while hovering: no space reserved for them. The
                          chips are right-aligned, so they don't move when the tools appear. */}
                      <div className="flex flex-wrap items-center justify-end gap-1.5">
                        <span className="hidden items-center gap-0.5 group-hover/k:flex">
                          {custom && (
                            <Tooltip content="Reset to default">
                              <button
                                type="button"
                                onClick={() => setKeys(a.id, a.keys)}
                                className="press flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
                              >
                                <RotateCcw />
                              </button>
                            </Tooltip>
                          )}
                          <Tooltip content="Add another shortcut">
                            <button
                              type="button"
                              onClick={() => setRec({ id: a.id, index: keys.length })}
                              className="press flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
                            >
                              <Plus />
                            </button>
                          </Tooltip>
                        </span>
                        {keys.map((k, i) =>
                          here && here.index === i ? (
                            <RecordingChip key={k} />
                          ) : (
                            <KeyChip
                              key={k}
                              combo={k}
                              onEdit={() => setRec({ id: a.id, index: i })}
                              onRemove={() => setKeys(a.id, keys.filter((x) => x !== k))}
                            />
                          ),
                        )}
                        {here && here.index >= keys.length && <RecordingChip />}
                        {!keys.length && !here && <span className="text-[11.5px] text-muted-foreground/60">Unbound</span>}
                      </div>
                    </div>
                    {error?.id === a.id && <div className="px-3 pb-1.5 text-[11.5px] text-destructive">{error.text}</div>}
                  </div>
                );
              })}
            </div>
          </Field>
        );
      })}
      <p className="text-[11.5px] leading-relaxed text-muted-foreground">
        Click a shortcut to change it and press the new keys (Esc cancels). A combo used by another action moves
        here. Keys that aren&apos;t app shortcuts go to the shell.
      </p>
    </>
  );
}

function KeyChip({ combo, onEdit, onRemove }: { combo: string; onEdit: () => void; onRemove: () => void }) {
  const keys = keycaps(combo);
  return (
    <span className="group/c relative inline-flex">
      <Tooltip content="Click to change">
        <button
          type="button"
          onClick={onEdit}
          className="press inline-flex h-6 items-center gap-1 rounded-md border border-border bg-ov/5 px-2 font-sans text-[11px] text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-primary"
        >
          {keys.map((k, i) => (
            <span key={`${k}${i}`} className="flex items-center gap-1">
              {i > 0 && <span className="text-[10px] opacity-40">+</span>}
              <span className="text-foreground/80 group-hover/c:text-current">{k}</span>
            </span>
          ))}
        </button>
      </Tooltip>
      <button
        type="button"
        aria-label="Remove shortcut"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 hidden size-3.5 items-center justify-center rounded-full bg-muted-foreground text-[10px] leading-none text-background group-hover/c:flex hover:bg-destructive"
      >
        ×
      </button>
    </span>
  );
}

function RecordingChip() {
  return (
    <span className="inline-flex h-6 items-center rounded-md border border-primary/50 bg-primary/10 px-2 text-[11px] text-primary">
      <motion.span animate={{ opacity: [1, 0.45, 1] }} transition={{ duration: 1.2, repeat: Number.POSITIVE_INFINITY }}>
        Press keys…
      </motion.span>
    </span>
  );
}
