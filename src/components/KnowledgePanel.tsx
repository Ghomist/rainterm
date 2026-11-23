// The knowledge base view (side dock): the user's notes, searched the same way agents
// search them, plus one editor dialog that anything can open (e.g. "Save to knowledge
// base" on an agent report).
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { BookOpen, Bot, Eye, FileUp, FolderOpen, Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { RichMarkdown } from "@/components/ui/markdown";
import { IconButton, PanelHeader, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { tr } from "@/lib/i18n";
import { ipc, type KbEntry, type KbHit } from "@/lib/ipc";
import { type KbDraft as Draft, newNote, refreshKb, useKb, useKbEditor as useEditor } from "@/lib/kb";
import { useMcpStatus } from "@/lib/mcp";
import { confirm, toast } from "@/lib/overlay";

// ------------------------------------------------------------------ editor host

/** Open the editor on an existing note. */
export async function openNote(id: string, preview = true) {
  try {
    const d = await ipc.kbRead(id);
    useEditor.setState({ draft: { id: d.id, title: d.title, tags: d.tags, body: d.body }, preview });
  } catch (e) {
    toast({ kind: "error", title: tr("Couldn't open the note"), description: String(e) });
  }
}

async function deleteNote(e: { id: string; title: string }) {
  const ok = await confirm({
    title: tr("Delete “{0}”?", { 0: e.title }),
    message: tr("The note goes to the recycle bin."),
    confirmLabel: tr("Delete"),
    danger: true,
  });
  if (!ok) return false;
  try {
    await ipc.kbDelete(e.id);
    await refreshKb();
    return true;
  } catch (err) {
    toast({ kind: "error", title: tr("Couldn't delete"), description: String(err) });
    return false;
  }
}

async function importNotes() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: true, filters: [{ name: "Markdown / text", extensions: ["md", "markdown", "txt"] }] });
  const paths = Array.isArray(picked) ? picked : picked ? [picked] : [];
  if (!paths.length) return;
  try {
    const n = await ipc.kbImport(paths);
    await refreshKb();
    toast({ kind: "success", title: tr("Imported {0} notes", { 0: n }) });
  } catch (e) {
    toast({ kind: "error", title: tr("Couldn't import"), description: String(e) });
  }
}

async function openFolder() {
  const dir = await ipc.kbDir();
  // Reveal a note inside when there is one, so the folder itself opens.
  const first = useKb.getState().entries[0];
  await revealItemInDir(first ? `${dir}/${first.id}` : dir).catch(() => {});
}

// ------------------------------------------------------------------ the panel

export function KnowledgePanel() {
  const entries = useKb((s) => s.entries);
  const loaded = useKb((s) => s.loaded);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<KbHit[] | null>(null);
  const mcp = useMcpStatus((s) => s.listening);

  useEffect(() => void refreshKb(), []);

  // Search like the agents do (ranked sections); a short pause first.
  useEffect(() => {
    const q = query.trim();
    if (!q) return setHits(null);
    let gone = false;
    const t = setTimeout(() => {
      ipc.kbSearch(q, 20).then(
        (h) => !gone && setHits(h),
        () => !gone && setHits([]),
      );
    }, 180);
    return () => {
      gone = true;
      clearTimeout(t);
    };
  }, [query, entries]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PanelHeader title={tr("Knowledge base")} icon={<BookOpen />}>
        <IconButton tip={tr("Import Markdown / text files")} onClick={() => void importNotes()}>
          <FileUp />
        </IconButton>
        <IconButton tip={tr("Open the folder")} onClick={() => void openFolder()}>
          <FolderOpen />
        </IconButton>
        <IconButton tip={tr("New note")} onClick={() => newNote()}>
          <Plus />
        </IconButton>
      </PanelHeader>
      {entries.length > 0 && (
        <div className="px-2 pb-2">
          <SearchField value={query} onChange={setQuery} placeholder={tr("Search notes")} />
        </div>
      )}

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
        {!loaded ? null : entries.length === 0 ? (
          <div className="mt-2 rounded-lg border border-dashed border-ov/10 p-4 text-center text-[12px] leading-relaxed text-muted-foreground">
            <BookOpen className="mx-auto mb-2 size-6 text-muted-foreground/50" />
            {tr("Write down what agents should know: your servers, projects, how you deploy, house rules, past fixes.")}
            <div className="mt-1">{tr("Every agent shares it: they search it on their own and add what they learn.")}</div>
            <div className="mt-3 flex justify-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => newNote()}>
                <Plus /> {tr("New note")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => void importNotes()}>
                <FileUp /> {tr("Import")}
              </Button>
            </div>
          </div>
        ) : hits ? (
          hits.length === 0 ? (
            <div className="py-8 text-center text-[12px] text-muted-foreground">{tr("No matches")}</div>
          ) : (
            hits.map((h, i) => <HitRow key={`${h.id}-${i}`} h={h} query={query} />)
          )
        ) : (
          entries.map((e) => <NoteRow key={e.id} e={e} />)
        )}
      </ScrollArea>

      {entries.length > 0 && (
        <div className="flex h-8 shrink-0 items-center gap-1.5 border-t border-ov/[0.06] px-3 text-[11px] text-muted-foreground">
          <span className="truncate">
            {tr("{0} notes", { 0: entries.length })} ·{" "}
            {mcp ? tr("agents and MCP clients can search them") : tr("agents can search them")}
          </span>
        </div>
      )}
    </div>
  );
}

function when(t: number) {
  if (!t) return "";
  const d = new Date(t);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : undefined);
}

function NoteMenu({ e, children }: { e: KbEntry | { id: string; title: string }; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void openNote(e.id, true)}>
          <Eye /> {tr("Open")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void openNote(e.id, false)}>
          <Pencil /> {tr("Edit…")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem destructive onSelect={() => void deleteNote(e)}>
          <Trash2 /> {tr("Delete")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const rowCls =
  "press group mb-1 block w-full rounded-lg border border-transparent px-2.5 py-2 text-left outline-none hover:border-ov/[0.06] hover:bg-ov/[0.04] focus-visible:ring-2 focus-visible:ring-ring/50";

function NoteRow({ e }: { e: KbEntry }) {
  return (
    <NoteMenu e={e}>
      <button type="button" className={rowCls} onClick={() => void openNote(e.id)}>
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">{e.title}</span>
          {e.source === "agent" && (
            <Tooltip content={tr("Kept by an agent")}>
              <Bot className="size-3 shrink-0 text-muted-foreground/70" />
            </Tooltip>
          )}
          <span className="shrink-0 text-[10.5px] text-muted-foreground/80 tabular-nums">{when(e.updated)}</span>
        </div>
        {e.excerpt && <div className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">{e.excerpt}</div>}
        {e.tags.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {e.tags.map((t) => (
              <span key={t} className="rounded bg-ov/[0.06] px-1.5 py-px text-[10.5px] text-muted-foreground">
                {t}
              </span>
            ))}
          </div>
        )}
      </button>
    </NoteMenu>
  );
}

/** Marks the query's words in a snippet. */
function Marked({ text, query }: { text: string; query: string }) {
  const parts = useMemo(() => {
    const words = query
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length > 1 || /[^\x00-\x7f]/.test(w))
      .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    if (!words.length) return [text];
    return text.split(new RegExp(`(${words.join("|")})`, "gi"));
  }, [text, query]);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static split
          <mark key={i} className="rounded-sm bg-primary/20 px-px text-foreground">
            {p}
          </mark>
        ) : (
          p
        ),
      )}
    </>
  );
}

function HitRow({ h, query }: { h: KbHit; query: string }) {
  const flat = h.snippet
    .replace(/^#+\s.*$/gm, "")
    .replace(/^\s*(?:[-*+>]|\d+\.)\s+/gm, "")
    .replace(/[`*]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return (
    <NoteMenu e={h}>
      <button type="button" className={rowCls} onClick={() => void openNote(h.id)}>
        <div className="truncate text-[12.5px] font-medium text-foreground">
          {h.title}
          {h.section && h.section !== h.title && <span className="font-normal text-muted-foreground"> › {h.section}</span>}
        </div>
        <div className="mt-0.5 line-clamp-3 text-[11.5px] leading-snug text-muted-foreground">
          <Marked text={flat.slice(0, 260)} query={query} />
        </div>
      </button>
    </NoteMenu>
  );
}

// ------------------------------------------------------------------ the editor

/** Mounted once (App). */
export function KnowledgeEditor() {
  const draft = useEditor((s) => s.draft);
  const preview = useEditor((s) => s.preview);
  const [d, setD] = useState<Draft | null>(null);
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!draft) return;
    setD(draft);
    setTags(draft.tags.join(", "));
  }, [draft]);

  const close = () => useEditor.setState({ draft: null });
  const dirty = !!d && !!draft && (d.title !== draft.title || d.body !== draft.body || tags !== draft.tags.join(", "));
  const valid = !!d && (!!d.title.trim() || !!d.body.trim());

  const save = async () => {
    if (!d || !valid || busy) return;
    setBusy(true);
    try {
      const title = d.title.trim() || d.body.trim().split("\n")[0].replace(/^#+\s*/, "").slice(0, 60);
      const list = tags
        .split(/[,，]/)
        .map((t) => t.trim())
        .filter(Boolean);
      const id = await ipc.kbSave(d.id, title, list, d.body);
      await refreshKb();
      useEditor.setState({ draft: { id, title, tags: list, body: d.body }, preview: true });
      toast({ kind: "success", title: tr("Saved to the knowledge base") });
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't save"), description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const tryClose = async () => {
    if (dirty && !(await confirm({ title: tr("Discard your changes?"), confirmLabel: tr("Discard"), danger: true }))) return;
    close();
  };

  return (
    <Dialog open={!!draft} onOpenChange={(o) => !o && void tryClose()}>
      <DialogContent
        className="flex h-[min(760px,calc(100vh-4rem))] max-w-[min(860px,calc(100%-2rem))] flex-col gap-3"
        onKeyDown={(e) => {
          if (e.key === "s" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void save();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <BookOpen className="size-4 text-primary" />
            {draft?.id ? (preview ? d?.title || tr("Note") : tr("Edit note")) : tr("New note")}
          </DialogTitle>
          <DialogDescription>
            {preview
              ? draft?.tags.length
                ? draft.tags.join(" · ")
                : tr("Agents find this when a task touches it.")
              : tr("Markdown. Agents search it by its words, so name the hosts, projects and commands it's about.")}
          </DialogDescription>
        </DialogHeader>

        {d && preview ? (
          <>
            <ScrollArea className="min-h-0 flex-1 rounded-lg border border-ov/[0.06] bg-inset/50" viewportClassName="px-5 py-4">
              {d.body.trim() ? <RichMarkdown text={d.body} /> : <div className="text-[12px] text-muted-foreground">{tr("(empty)")}</div>}
            </ScrollArea>
            <div className="flex items-center gap-2">
              <Button variant="ghost" className="text-destructive hover:text-destructive" onClick={async () => d.id && (await deleteNote({ id: d.id, title: d.title })) && close()}>
                <Trash2 /> {tr("Delete")}
              </Button>
              <div className="flex-1" />
              <Button variant="ghost" onClick={close}>
                {tr("Close")}
              </Button>
              <Button
                onClick={() => {
                  useEditor.setState({ preview: false });
                  setTimeout(() => area.current?.focus(), 50);
                }}
              >
                <Pencil /> {tr("Edit")}
              </Button>
            </div>
          </>
        ) : d ? (
          <>
            <div className="grid grid-cols-[1fr_minmax(0,0.6fr)] gap-2">
              <Input autoFocus={!d.id} placeholder={tr("Title")} value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} />
              <Input placeholder={tr("Tags, comma separated")} value={tags} onChange={(e) => setTags(e.target.value)} />
            </div>
            <textarea
              ref={area}
              autoFocus={!!d.id}
              spellCheck={false}
              value={d.body}
              placeholder={tr("## Production servers\n- web01 (10.0.0.5): nginx, reload with `sudo systemctl reload nginx`\n- Deploys go through the `deploy` user, never root")}
              onChange={(e) => setD({ ...d, body: e.target.value })}
              className="min-h-0 w-full flex-1 resize-none rounded-lg border border-input bg-inset px-3 py-2.5 font-mono text-[12.5px] leading-relaxed outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/50 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40"
            />
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">{tr("Ctrl+S to save")}</span>
              <div className="flex-1" />
              <Button variant="ghost" onClick={() => void tryClose()}>
                {tr("Cancel")}
              </Button>
              <Button disabled={!valid || busy || (!!d.id && !dirty)} onClick={() => void save()}>
                {tr("Save")}
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
