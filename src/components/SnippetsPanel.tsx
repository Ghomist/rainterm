import {
  ClipboardCopy,
  Copy,
  CornerDownLeft,
  Pencil,
  Play,
  Plus,
  Radio,
  TextCursorInput,
  Trash2,
  Zap,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { ComboInput } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { IconButton, PanelHeader, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { confirm } from "@/lib/overlay";
import { type Snippet, snippetVars, useSnippets } from "@/lib/snippets";
import { cn } from "@/lib/utils";
import { useActivePane, useApp } from "@/store/app";
import { Check, Field } from "./dialogs";
import { sendSnippet } from "./SnippetVars";
import { tr } from "@/lib/i18n";

/** Type a snippet into the active terminal (mirrored by broadcast / input groups). */
const send = sendSnippet;

export function SnippetsPanel() {
  const snippets = useSnippets((s) => s.snippets);
  const load = useSnippets((s) => s.load);
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<Snippet | "new" | null>(null);
  const pane = useActivePane();
  const broadcast = useApp((s) => s.broadcast);

  useEffect(() => void load(), [load]);

  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const list = snippets.filter((s) => !q || `${s.name} ${s.command} ${s.group}`.toLowerCase().includes(q));
    const map = new Map<string, Snippet[]>();
    for (const s of list) map.set(s.group.trim(), [...(map.get(s.group.trim()) ?? []), s]);
    return [...map.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)));
  }, [snippets, q]);

  const targetLabel = !pane
    ? tr("No terminal")
    : broadcast !== "off" || pane.group
      ? tr("{0} + broadcast", { 0: pane.title })
      : pane.title;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={tr("Quick commands")} icon={<Zap />}>
        <IconButton tip={tr("New quick command")} onClick={() => setEditing("new")}>
          <Plus />
        </IconButton>
      </PanelHeader>
      <div className="px-2 pb-2">
        <SearchField value={query} onChange={setQuery} placeholder={tr("Search commands")} />
      </div>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
        {snippets.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-ov/10 p-4 text-center text-[12px] leading-relaxed text-muted-foreground">
            {tr("Save command lines you type often — click one to send it to the active terminal.")}<div className="mt-2">
              <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
                <Plus /> {tr("Add a command")}
              </Button>
            </div>
          </div>
        ) : groups.length === 0 ? (
          <div className="py-8 text-center text-[12px] text-muted-foreground">{tr("No matches")}</div>
        ) : (
          groups.map(([g, items]) => (
            <div key={g || "__"} className="mb-2">
              {g && (
                <div className="px-1 pt-1 pb-0.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
                  {g}
                </div>
              )}
              {items.map((s) => (
                <SnippetRow key={s.id} s={s} onEdit={() => setEditing(s)} />
              ))}
            </div>
          ))
        )}
      </ScrollArea>

      <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-ov/[0.06] px-3 text-[11px] text-muted-foreground">
        {broadcast !== "off" || pane?.group ? (
          <Radio className="size-3 text-warning" />
        ) : (
          <CornerDownLeft className="size-3" />
        )}
        <span className="truncate">
          {tr("Sends to")}{" "}<span className="text-foreground/80">{targetLabel}</span>
        </span>
      </div>

      <SnippetEditor value={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

function SnippetRow({ s, onEdit }: { s: Snippet; onEdit: () => void }) {
  const save = useSnippets((x) => x.save);
  const remove = useSnippets((x) => x.remove);
  const [flash, setFlash] = useState(0);
  const fire = (run?: boolean) => {
    void send(s, run).then((ok) => ok && setFlash((n) => n + 1));
  };
  const firstLine = s.command.split(/\r?\n/)[0];
  const lines = s.command.split(/\r?\n/).filter(Boolean).length;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="button"
          tabIndex={0}
          onClick={() => fire()}
          onKeyDown={(e) => e.key === "Enter" && fire()}
          className="group relative flex cursor-default items-center gap-2 overflow-hidden rounded-md px-2 py-1.5 text-left outline-none transition-colors duration-75 hover:bg-ov/[0.05] focus-visible:bg-ov/[0.07]"
        >
          <AnimatePresence>
            {flash > 0 && (
              <motion.span
                key={flash}
                initial={{ opacity: 0.6 }}
                animate={{ opacity: 0 }}
                transition={{ duration: 0.5 }}
                className="pointer-events-none absolute inset-0 bg-primary/25"
              />
            )}
          </AnimatePresence>
          <span
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded [&_svg]:size-3",
              s.run ? "bg-primary/12 text-primary" : "bg-ov/[0.06] text-muted-foreground",
            )}
          >
            {s.run ? <Play /> : <TextCursorInput />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] text-foreground/90">{s.name || firstLine}</div>
            {s.name && (
              <div className="truncate font-mono text-[11px] text-muted-foreground/80">
                {firstLine}
                {lines > 1 && <span className="ml-1 text-muted-foreground/60">+{lines - 1} {tr("lines")}</span>}
              </div>
            )}
          </div>
          <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
            <Tooltip content={s.run ? tr("Type without running") : tr("Type and run")}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  fire(!s.run);
                }}
                className="press flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
              >
                {s.run ? <TextCursorInput /> : <Play />}
              </button>
            </Tooltip>
            <Tooltip content={tr("Edit")}>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit();
                }}
                className="press flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
              >
                <Pencil />
              </button>
            </Tooltip>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => fire(true)}>
          <Play /> {tr("Run")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => fire(false)}>
          <TextCursorInput /> {tr("Type without running")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(s.command)}>
          <ClipboardCopy /> {tr("Copy command")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onEdit}>
          <Pencil /> {tr("Edit…")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void save({ ...s, id: crypto.randomUUID(), name: s.name ? `${s.name} copy` : "" })}>
          <Copy /> {tr("Duplicate")}
        </ContextMenuItem>
        <ContextMenuItem
          destructive
          onSelect={async () => {
            const ok = await confirm({
              title: tr("Delete “{0}”?", { 0: s.name || firstLine }),
              confirmLabel: tr("Delete"),
              danger: true,
            });
            if (ok) void remove(s.id);
          }}
        >
          <Trash2 /> {tr("Delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const blank = (): Snippet => ({ id: crypto.randomUUID(), name: "", command: "", group: "", run: true });

function SnippetEditor({ value, onClose }: { value: Snippet | "new" | null; onClose: () => void }) {
  const snippets = useSnippets((s) => s.snippets);
  const save = useSnippets((s) => s.save);
  const [s, setS] = useState<Snippet>(blank);
  useEffect(() => {
    if (value) setS(value === "new" ? blank() : { ...value });
  }, [value]);
  const groups = [...new Set(snippets.map((x) => x.group.trim()).filter(Boolean))].sort();
  const valid = !!s.command.trim();

  const submit = async () => {
    if (!valid) return;
    await save({ ...s, name: s.name.trim(), group: s.group.trim() });
    onClose();
  };

  return (
    <Dialog open={!!value} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-[min(480px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{value === "new" ? tr("New") : tr("Edit")} {tr("quick command")}</DialogTitle>
          <DialogDescription>{tr("Click it in the Quick commands panel to type it into the active terminal.")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={tr("Command")}>
            <textarea
              autoFocus
              rows={4}
              spellCheck={false}
              value={s.command}
              placeholder={"docker logs -f {{container}}\n(several lines run one after another)"}
              onChange={(e) => setS({ ...s, command: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void submit();
                }
              }}
              className="w-full resize-y rounded-md border border-input bg-inset px-2.5 py-2 font-mono text-[12.5px] leading-relaxed outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/60 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          <p className="-mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
            {tr("Blanks are asked for when it runs:")}{" "}<code className="text-foreground/80">{"{{name}}"}</code>,{" "}
            <code className="text-foreground/80">{"{{port:8080}}"}</code> {tr("(default),")}{" "}
            <code className="text-foreground/80">{"{{env|dev|prod}}"}</code> {tr("(choices).")}{snippetVars(s.command).length > 0 &&
              tr(" This one asks for: {0}.", { 0: snippetVars(s.command)
                .map((v) => v.name)
                .join(", ") })}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <Field label={tr("Name")}>
              <Input placeholder={tr("optional")} value={s.name} onChange={(e) => setS({ ...s, name: e.target.value })} />
            </Field>
            <Field label={tr("Group")}>
              <ComboInput
                placeholder={tr("optional")}
                value={s.group}
                onChange={(v) => setS({ ...s, group: v })}
                options={groups.map((g) => ({ value: g, label: g }))}
              />
            </Field>
          </div>
          <Check checked={s.run} onChange={(v) => setS({ ...s, run: v })}>
            {tr("Run immediately (press Enter after typing)")}
          </Check>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={!valid}>
              {tr("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
