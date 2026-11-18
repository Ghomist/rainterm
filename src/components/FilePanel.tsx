import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  ClipboardCopy,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileKey,
  FileSymlink,
  FileTerminal,
  FileText,
  FileVideo,
  Folder,
  FolderDown,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Home,
  LocateFixed,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  SquareTerminal,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createPortal } from "react-dom";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { fieldCls, IconButton, iconButtonCls, PanelHeader, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { Channel, type EditEvent, type FsEntry, type FsListing, type FsTarget, ipc } from "@/lib/ipc";
import { confirm, toast } from "@/lib/overlay";
import { cancelJob, clearFinished, download, fmtEta, fmtSize, upload, useTransfers } from "@/lib/transfers";
import { POSIX_INTEGRATION } from "@/lib/shell-integration";
import { cn } from "@/lib/utils";
import { type Pane, useActivePane, useApp } from "@/store/app";

// ------------------------------------------------------------------ files view

export function FilesView() {
  const pane = useActivePane();
  const sessionId = pane?.session.sessionId ?? null;
  const target: FsTarget | null = useMemo(() => {
    if (!pane) return null;
    if (pane.kind === "local") return { kind: "local" };
    if (pane.kind === "ssh" && sessionId && pane.status === "connected") return { kind: "ssh", sessionId };
    return null;
  }, [pane?.kind, pane?.status, sessionId]);

  let body: React.ReactNode;
  if (!pane) body = <Empty icon={<FolderOpen />} text="No active session" />;
  else if (pane.kind === "serial") body = <Empty icon={<FolderOpen />} text="Serial sessions have no file system" />;
  else if (!target)
    body = (
      <Empty
        icon={<RefreshCw className="animate-spin" />}
        text={pane.status === "connecting" ? "Connecting…" : "Connect the SSH session to browse files"}
      />
    );
  else body = <Browser key={`${pane.id}:${sessionId}`} pane={pane} target={target} />;

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col">{body}</div>
      <TransferList />
    </>
  );
}

function Empty({ icon, text }: { icon: React.ReactNode; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-[12px] text-muted-foreground [&_svg]:size-6 [&_svg]:opacity-50">
      {icon}
      {text}
    </div>
  );
}

// ------------------------------------------------------------------ browser

type SortKey = "name" | "size" | "mtime";
const lastDir = new Map<string, string>();

function Browser({ pane, target }: { pane: Pane; target: FsTarget }) {
  const remote = target.kind === "ssh";
  const showHidden = useApp((s) => s.settings.showHiddenFiles);
  const downloadDir = useApp((s) => s.settings.downloadDir);
  const updateSettings = useApp((s) => s.updateSettings);

  const [listing, setListing] = useState<FsListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [back, setBack] = useState<string[]>([]);
  const [fwd, setFwd] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<string | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [follow, setFollow] = useState(true);
  const [dropHover, setDropHover] = useState(false);
  /** Slide direction for the list animation: 1 = into a folder, -1 = out of it. */
  const [nav, setNav] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  /** Rows render only once the dock has finished sliding in: switching views stays smooth. */
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 240);
    return () => clearTimeout(t);
  }, []);
  /** What the (single, shared) context menu is for: rows, or null = the folder background. */
  const [menuFor, setMenuFor] = useState<FsEntry[] | null>(null);
  const tip = useRowTip();

  const sep = listing?.sep ?? (remote ? "/" : navigator.userAgent.includes("Windows") ? "\\" : "/");
  const join = useCallback(
    (dir: string, name: string) => (dir.endsWith(sep) || dir.endsWith("/") ? dir + name : dir + sep + name),
    [sep],
  );

  const load = useCallback(
    async (path: string, opts: { push?: boolean; keepSelection?: boolean } = {}) => {
      setLoading(true);
      try {
        const l = await ipc.fsList(target, path);
        setListing((prev) => {
          if (prev && prev.path !== l.path) {
            const a = prev.path.replace(/[\\/]+$/, "");
            const b = l.path.replace(/[\\/]+$/, "");
            setNav(b.startsWith(a) ? 1 : a.startsWith(b) ? -1 : 0);
          }
          if (opts.push && prev && prev.path !== l.path) {
            setBack((b) => [...b, prev.path]);
            setFwd([]);
          }
          return l;
        });
        if (!opts.keepSelection) {
          setSelected(new Set());
          setCursor(null);
          setFilter("");
        }
        setError(null);
        lastDir.set(pane.id, l.path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [target, pane.id],
  );
  const go = (path: string) => void load(path, { push: true });
  const refresh = () => listing && void load(listing.path, { keepSelection: true });

  // Initial directory: remembered > shell cwd (OSC 7) > home.
  useEffect(() => {
    const start = lastDir.get(pane.id) ?? pane.cwd;
    const t = setTimeout(() => {
      if (start) void load(start);
      else void ipc.fsHome(target).then((h) => load(h), (e) => setError(String(e)));
    }, 200);
    return () => clearTimeout(t);
  }, [target]);

  // Follow the terminal's working directory when the shell reports it (OSC 7).
  useEffect(() => {
    if (follow && pane.cwd && pane.cwd !== listing?.path) void load(pane.cwd, { push: true });
  }, [pane.cwd, follow]);

  const entries = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = (listing?.entries ?? []).filter(
      (e) => (showHidden || !e.name.startsWith(".")) && (!q || e.name.toLowerCase().includes(q)),
    );
    const dir = sort.asc ? 1 : -1;
    return list.sort((a, b) => {
      const da = a.kind === "dir" ? 0 : 1;
      const db = b.kind === "dir" ? 0 : 1;
      if (da !== db) return da - db;
      let c = 0;
      if (sort.key === "size") c = a.size - b.size;
      else if (sort.key === "mtime") c = (a.mtime ?? 0) - (b.mtime ?? 0);
      if (c === 0) c = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return c * dir;
    });
  }, [listing, filter, showHidden, sort]);

  const names = entries.map((e) => e.name);
  const selEntries = entries.filter((e) => selected.has(e.name));
  const pathOf = (name: string) => (listing ? join(listing.path, name) : name);

  // ---------------------------------------------------------------- actions

  const openEntry = async (e: FsEntry) => {
    if (e.kind === "dir") return go(pathOf(e.name));
    if (!remote) return void openPath(pathOf(e.name));
    if (target.kind !== "ssh") return;
    // Remote: edit in place — saves are uploaded back automatically.
    const ch = new Channel<EditEvent>();
    ch.onmessage = (ev) => {
      if (ev.type === "synced") toast({ kind: "success", title: `Saved ${e.name} to server`, description: fmtSize(ev.bytes) });
      if (ev.type === "error") toast({ kind: "error", title: `Couldn't upload ${e.name}`, description: ev.message });
    };
    try {
      const local = await ipc.fsEdit(target.sessionId, pathOf(e.name), ch);
      await openPath(local);
      toast({ kind: "info", title: `Editing ${e.name}`, description: "Changes are uploaded every time you save." });
    } catch (err) {
      toast({ kind: "error", title: `Couldn't open ${e.name}`, description: String(err) });
    }
  };

  const downloadSel = async (items: FsEntry[], ask = false) => {
    if (target.kind !== "ssh" || !items.length) return;
    let dir = downloadDir ?? (await ipc.fsDefaultDownloadDir());
    if (ask) {
      const picked = await openDialog({ directory: true, title: "Download to", defaultPath: dir });
      if (!picked || Array.isArray(picked)) return;
      dir = picked;
    }
    void download(target.sessionId, items.map((e) => pathOf(e.name)), dir);
  };

  const uploadPaths = async (paths: string[]) => {
    if (target.kind !== "ssh" || !listing || !paths.length) return;
    const dir = listing.path;
    if (await upload(target.sessionId, paths, dir)) void load(dir, { keepSelection: true });
  };

  const pickUpload = async (directory: boolean) => {
    const picked = await openDialog({ multiple: true, directory, title: directory ? "Upload folder" : "Upload files" });
    if (picked) void uploadPaths(Array.isArray(picked) ? picked : [picked]);
  };

  const deleteSel = async (items: FsEntry[]) => {
    if (!items.length) return;
    const what = items.length === 1 ? `"${items[0].name}"` : `${items.length} items`;
    const hasDir = items.some((e) => e.kind === "dir");
    const ok = await confirm({
      title: `Delete ${what}?`,
      message: remote
        ? `This permanently deletes ${what} on the server${hasDir ? ", including everything inside" : ""}. This cannot be undone.`
        : `${what} will be moved to the Recycle Bin.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.fsRemove(target, items.map((e) => pathOf(e.name)));
      toast({ kind: "success", title: `Deleted ${what}` });
    } catch (e) {
      toast({ kind: "error", title: "Delete failed", description: String(e) });
    }
    refresh();
  };

  const commitRename = async (from: string, to: string) => {
    setRenaming(null);
    if (!to || to === from) return;
    try {
      await ipc.fsRename(target, pathOf(from), pathOf(to));
      await load(listing!.path, { keepSelection: true });
      setSelected(new Set([to]));
      setCursor(to);
    } catch (e) {
      toast({ kind: "error", title: "Rename failed", description: String(e) });
    }
  };

  const commitCreate = async (name: string) => {
    setCreating(false);
    if (!name || !listing) return;
    try {
      await ipc.fsMkdir(target, pathOf(name));
      await load(listing.path, { keepSelection: true });
      setSelected(new Set([name]));
      setCursor(name);
    } catch (e) {
      toast({ kind: "error", title: "Couldn't create folder", description: String(e) });
    }
  };

  const toTerminal = (paths: string[]) => {
    pane.session.input(paths.map((p) => quote(p, remote)).join(" "));
    pane.session.focus();
  };
  const cdHere = (path: string) => {
    pane.session.input(`cd ${quote(path, remote)}\r`);
    pane.session.focus();
  };

  // ---------------------------------------------------------------- selection + keys

  const click = (e: React.MouseEvent, name: string) => {
    if (e.shiftKey && anchor) {
      const [a, b] = [names.indexOf(anchor), names.indexOf(name)].sort((x, y) => x - y);
      setSelected(new Set(names.slice(a, b + 1)));
    } else if (e.ctrlKey || e.metaKey) {
      const next = new Set(selected);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      setSelected(next);
      setAnchor(name);
    } else {
      setSelected(new Set([name]));
      setAnchor(name);
    }
    setCursor(name);
  };

  const moveCursor = (delta: number, extend: boolean) => {
    if (!names.length) return;
    const idx = cursor ? names.indexOf(cursor) : -1;
    const next = names[Math.max(0, Math.min(names.length - 1, idx < 0 ? 0 : idx + delta))];
    setCursor(next);
    if (extend && anchor) {
      const [a, b] = [names.indexOf(anchor), names.indexOf(next)].sort((x, y) => x - y);
      setSelected(new Set(names.slice(a, b + 1)));
    } else {
      setSelected(new Set([next]));
      setAnchor(next);
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (renaming || creating) return;
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    const cur = entries.find((x) => x.name === cursor);
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (k === "ArrowDown") return handled(), moveCursor(1, e.shiftKey);
    if (k === "ArrowUp") return handled(), moveCursor(-1, e.shiftKey);
    if (k === "Home") return handled(), moveCursor(-1e9, e.shiftKey);
    if (k === "End") return handled(), moveCursor(1e9, e.shiftKey);
    if (k === "Enter" && cur) return handled(), void openEntry(cur);
    if (k === "Backspace" || (e.altKey && k === "ArrowLeft"))
      return handled(), listing?.parent && go(listing.parent);
    if (k === "F2" && cur) return handled(), setRenaming(cur.name);
    if (k === "Delete" && selEntries.length) return handled(), void deleteSel(selEntries);
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "a") return handled(), setSelected(new Set(names));
    if ((e.ctrlKey || e.metaKey) && k.toLowerCase() === "c" && selEntries.length)
      return handled(), void navigator.clipboard.writeText(selEntries.map((x) => pathOf(x.name)).join("\n"));
    if (k === "Escape") return handled(), setSelected(new Set());
    // Type-ahead: jump to the first entry starting with the typed letter.
    if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const hit = names.find((n) => n.toLowerCase().startsWith(k.toLowerCase()) && n !== cursor) ?? null;
      if (hit) {
        handled();
        setCursor(hit);
        setSelected(new Set([hit]));
        setAnchor(hit);
      }
    }
  };

  // Keep the keyboard cursor visible.
  useLayoutEffect(() => {
    if (!cursor) return;
    listRef.current?.querySelector(`[data-name="${CSS.escape(cursor)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  // ---------------------------------------------------------------- OS drag & drop upload

  useEffect(() => {
    if (!remote) return;
    let un: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((ev) => {
        const el = rootRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const pos = "position" in ev.payload ? ev.payload.position : null;
        const scale = window.devicePixelRatio || 1;
        const inside =
          !!pos && pos.x / scale >= r.left && pos.x / scale <= r.right && pos.y / scale >= r.top && pos.y / scale <= r.bottom;
        if (ev.payload.type === "over" || ev.payload.type === "enter") setDropHover(inside);
        else if (ev.payload.type === "drop") {
          setDropHover(false);
          if (inside) void uploadPaths(ev.payload.paths);
        } else setDropHover(false);
      })
      .then((f) => {
        un = f;
      });
    return () => un?.();
  });

  // ---------------------------------------------------------------- render

  const totalSel = selEntries.reduce((n, e) => n + (e.kind === "file" ? e.size : 0), 0);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      onKeyDown={onKey}
      className="relative flex min-h-0 flex-1 flex-col outline-none"
    >
      {/* header: source + toolbar */}
      <PanelHeader
        title={remote ? `SFTP · ${pane.subtitle}` : "Local files"}
        icon={<span className={cn("size-1.5 rounded-full", remote ? "bg-success" : "bg-primary")} />}
      >
        <ToolBtn tip="Back" disabled={!back.length} onClick={() => {
          const prev = back.at(-1);
          if (!prev || !listing) return;
          setBack(back.slice(0, -1));
          setFwd([listing.path, ...fwd]);
          void load(prev);
        }}>
          <ArrowLeft />
        </ToolBtn>
        <ToolBtn tip="Forward" disabled={!fwd.length} onClick={() => {
          const next = fwd[0];
          if (!next || !listing) return;
          setFwd(fwd.slice(1));
          setBack([...back, listing.path]);
          void load(next);
        }}>
          <ArrowRight />
        </ToolBtn>
        <ToolBtn tip="Up one level" shortcut="Backspace" disabled={!listing?.parent} onClick={() => listing?.parent && go(listing.parent)}>
          <ArrowUp />
        </ToolBtn>
        <ToolBtn tip="Refresh" onClick={refresh}>
          <RefreshCw className={cn(loading && "animate-spin")} />
        </ToolBtn>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton tip="More">
              <MoreHorizontal />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setCreating(true)}>
              <FolderPlus /> New folder
            </DropdownMenuItem>
            {remote && (
              <>
                <DropdownMenuItem onSelect={() => void pickUpload(false)}>
                  <Upload /> Upload files…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => void pickUpload(true)}>
                  <FolderUp /> Upload folder…
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void ipc.fsHome(target).then(go)}>
              <Home /> Home folder
            </DropdownMenuItem>
            {listing && (
              <DropdownMenuItem onSelect={() => cdHere(listing.path)}>
                <SquareTerminal /> cd here in terminal
              </DropdownMenuItem>
            )}
            {!remote && listing && (
              <DropdownMenuItem onSelect={() => void openPath(listing.path)}>
                <FolderOpen /> Open in system file manager
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void updateSettings({ showHiddenFiles: !showHidden })}>
              {showHidden ? <EyeOff /> : <Eye />} {showHidden ? "Hide" : "Show"} hidden files
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setFollow(!follow)}>
              <LocateFixed /> {follow ? "Stop following" : "Follow"} terminal directory
            </DropdownMenuItem>
            {!pane.cwd && (
              <DropdownMenuItem
                onSelect={() => {
                  // One-off (not persisted) hook: bash/zsh report $PWD (OSC 7) and
                  // prompt marks (OSC 133) for exact command folding.
                  pane.session.input(`${POSIX_INTEGRATION}\r`);
                  setFollow(true);
                  pane.session.focus();
                }}
              >
                <LocateFixed /> Enable shell integration (bash / zsh)
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelHeader>

      <Breadcrumb
        path={listing?.path ?? ""}
        sep={sep}
        onGo={go}
        locate={{
          following: follow,
          known: !!pane.cwd,
          here: !!pane.cwd && pane.cwd === listing?.path,
          onClick: () => {
            if (!pane.cwd) {
              // Shell doesn't report its directory yet: install the bash/zsh hook.
              pane.session.input(`${POSIX_INTEGRATION}\r`);
              setFollow(true);
              return;
            }
            if (follow && pane.cwd === listing?.path) return setFollow(false);
            setFollow(true);
            go(pane.cwd);
          },
        }}
      />

      {/* filter */}
      <div className="px-2 pb-2">
        <SearchField
          value={filter}
          onChange={setFilter}
          placeholder="Filter"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setFilter("");
              rootRef.current?.focus();
            }
            if (e.key === "ArrowDown") {
              e.preventDefault();
              rootRef.current?.focus();
              moveCursor(1, false);
            }
            if (e.key === "Enter" && entries[0]) void openEntry(entries[0]);
          }}
        />
      </div>

      {/* column header */}
      <div className="grid h-6 grid-cols-[1fr_64px_78px] items-center gap-2 border-b border-ov/[0.06] px-4 text-[10.5px] font-medium text-muted-foreground select-none">
        <SortHead label="Name" k="name" sort={sort} setSort={setSort} />
        <SortHead label="Size" k="size" sort={sort} setSort={setSort} right />
        <SortHead label="Modified" k="mtime" sort={sort} setSort={setSort} right />
      </div>

      <AnimatePresence>
        {error && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mx-2 mt-1.5 flex items-start gap-2 rounded-md bg-destructive/10 px-2 py-1.5 text-[11.5px] break-words text-destructive"
          >
            <span className="flex-1">{error}</span>
            <button type="button" onClick={() => setError(null)}>
              <X className="size-3" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* list */}
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            className="relative min-h-0 flex-1"
            onPointerDown={(e) => {
              tip.hide();
              if (!(e.target as HTMLElement).closest("[data-name]")) setSelected(new Set());
              rootRef.current?.focus({ preventScroll: true });
            }}
            onContextMenu={(ev) => {
              tip.hide();
              const name = (ev.target as HTMLElement).closest<HTMLElement>("[data-name]")?.dataset.name;
              const entry = name != null ? entries.find((x) => x.name === name) : undefined;
              if (!entry) return setMenuFor(null);
              if (selected.has(entry.name)) setMenuFor(selEntries);
              else {
                setSelected(new Set([entry.name]));
                setAnchor(entry.name);
                setMenuFor([entry]);
              }
              setCursor(entry.name);
            }}
            onPointerOver={(ev) => tip.over(ev, entries)}
            onPointerLeave={tip.hide}
          >
            <ScrollArea className="h-full" viewportRef={listRef}>
            <motion.div
              key={listing?.path ?? ""}
              initial={{ opacity: 0, x: nav * 18 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
              className="px-1 py-1"
            >
            {creating && (
              <RowShell icon={<Folder className="size-4 shrink-0 fill-primary/25 text-primary" />} active>
                <InlineInput initial="New folder" onDone={(v) => void commitCreate(v)} />
              </RowShell>
            )}
            {(ready ? entries : []).map((e) => (
              <Row
                key={e.name}
                entry={e}
                selected={selected.has(e.name)}
                cursor={cursor === e.name}
                renaming={renaming === e.name}
                remote={remote}
                onClick={(ev) => click(ev, e.name)}
                onOpen={() => void openEntry(e)}
                onRename={(v) => void commitRename(e.name, v)}
                dragPaths={() => (selected.has(e.name) ? selEntries : [e]).map((x) => pathOf(x.name))}
              />
            ))}
            {ready && listing && entries.length === 0 && !creating && (
              <div className="py-10 text-center text-[12px] text-muted-foreground">
                {filter ? `Nothing matches “${filter}”` : "This folder is empty"}
              </div>
            )}
            </motion.div>
            </ScrollArea>
          </div>
        </ContextMenuTrigger>
        {menuFor ? (
          <EntryMenu
            items={menuFor}
            remote={remote}
            pathOf={pathOf}
            onOpen={openEntry}
            onDownload={downloadSel}
            onDelete={deleteSel}
            onRename={(name) => setRenaming(name)}
            onTerminal={toTerminal}
            onCd={cdHere}
          />
        ) : (
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => setCreating(true)}>
            <FolderPlus /> New folder
          </ContextMenuItem>
          {remote && (
            <>
              <ContextMenuItem onSelect={() => void pickUpload(false)}>
                <Upload /> Upload files…
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void pickUpload(true)}>
                <FolderUp /> Upload folder…
              </ContextMenuItem>
            </>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={refresh}>
            <RefreshCw /> Refresh
          </ContextMenuItem>
          {listing && (
            <>
              <ContextMenuItem onSelect={() => cdHere(listing.path)}>
                <SquareTerminal /> cd here in terminal
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(listing.path)}>
                <ClipboardCopy /> Copy folder path
              </ContextMenuItem>
            </>
          )}
          <ContextMenuItem onSelect={() => void updateSettings({ showHiddenFiles: !showHidden })}>
            {showHidden ? <EyeOff /> : <Eye />} {showHidden ? "Hide" : "Show"} hidden files
          </ContextMenuItem>
        </ContextMenuContent>
        )}
      </ContextMenu>
      {tip.node}

      {/* footer */}
      <div className="flex h-8 shrink-0 items-center gap-1 border-t border-ov/[0.06] pr-1.5 pl-4 text-[11px] text-muted-foreground">
        <span className="truncate">
          {selEntries.length
            ? `${selEntries.length} selected${totalSel ? ` · ${fmtSize(totalSel)}` : ""}`
            : `${entries.length} items`}
        </span>
        <div className="flex-1" />
        {remote && selEntries.length > 0 && (
          <Tooltip content="Download selected">
            <button type="button" onClick={() => void downloadSel(selEntries)} className={toolCls}>
              <Download />
            </button>
          </Tooltip>
        )}
        {remote && (
          <Tooltip content="Upload files">
            <button type="button" onClick={() => void pickUpload(false)} className={toolCls}>
              <Upload />
            </button>
          </Tooltip>
        )}
      </div>

      <AnimatePresence>
        {dropHover && (
          <motion.div
            initial={{ opacity: 0, scale: 0.98 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.98 }}
            className="pointer-events-none absolute inset-2 z-30 flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/60 bg-[color-mix(in_oklab,var(--primary)_12%,var(--surface))] text-[12.5px] text-primary"
          >
            <Upload className="size-6" />
            Drop to upload to
            <span className="max-w-[90%] truncate font-mono text-[11px]">{listing?.path}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ pieces

const toolCls = iconButtonCls;

function ToolBtn({
  tip,
  shortcut,
  children,
  onClick,
  disabled,
}: {
  tip: string;
  shortcut?: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <IconButton tip={tip} shortcut={shortcut} disabled={disabled} onClick={onClick}>
      {children}
    </IconButton>
  );
}

function SortHead({
  label,
  k,
  sort,
  setSort,
  right,
}: {
  label: string;
  k: SortKey;
  sort: { key: SortKey; asc: boolean };
  setSort: (s: { key: SortKey; asc: boolean }) => void;
  right?: boolean;
}) {
  const active = sort.key === k;
  return (
    <button
      type="button"
      onClick={() => setSort({ key: k, asc: active ? !sort.asc : k === "name" })}
      className={cn("flex items-center gap-0.5 transition hover:text-foreground", right && "justify-end", active && "text-foreground")}
    >
      {label}
      {active && (sort.asc ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />)}
    </button>
  );
}

interface Locate {
  following: boolean;
  known: boolean;
  here: boolean;
  onClick: () => void;
}

function Breadcrumb({ path, sep, onGo, locate }: { path: string; sep: string; onGo: (p: string) => void; locate: Locate }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(path);
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => setValue(path), [path]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [path, editing]);

  const parts = splitPath(path, sep);

  if (editing)
    return (
      <div className="px-2 pb-2">
        <input
          autoFocus
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={() => setEditing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              setEditing(false);
              if (value.trim()) onGo(value.trim());
            }
            if (e.key === "Escape") setEditing(false);
          }}
          spellCheck={false}
          className={fieldCls("border-primary/50 px-2 font-mono text-[11.5px]")}
        />
      </div>
    );

  return (
    <div className="flex items-center gap-1 px-2 pb-2">
      <div
        ref={scrollRef}
        onClick={(e) => e.target === e.currentTarget && setEditing(true)}
        className="no-scrollbar flex h-7 min-w-0 flex-1 cursor-text items-center overflow-x-auto rounded-md border border-ov/[0.07] bg-inset px-1"
      >
        {parts.map((p, i) => (
          <span key={p.path} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/50" />}
            <button
              type="button"
              onClick={() => onGo(p.path)}
              className={cn(
                "rounded px-1.5 py-0.5 text-[12px] transition hover:bg-ov/[0.08]",
                i === parts.length - 1 ? "font-medium text-foreground" : "text-muted-foreground",
              )}
            >
              {p.label}
            </button>
          </span>
        ))}
        <div className="h-full min-w-6 flex-1" onClick={() => setEditing(true)} />
      </div>
      <LocateButton {...locate} />
    </div>
  );
}

function LocateButton({ following, known, here, onClick }: Locate) {
  const tip = !known
    ? "Terminal directory unknown — click to enable shell integration (bash/zsh)"
    : following && here
      ? "Following the terminal's directory · click to stop"
      : "Go to the terminal's directory and follow it";
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md border transition-colors [&_svg]:size-[15px]",
          following && known
            ? "border-primary/40 bg-primary/12 text-primary hover:bg-primary/20"
            : "border-ov/[0.07] bg-inset text-muted-foreground hover:text-foreground",
        )}
      >
        <LocateFixed className={cn(following && known && !here && "animate-pulse")} />
      </button>
    </Tooltip>
  );
}

function splitPath(path: string, sep: string) {
  if (!path) return [];
  if (sep === "/") {
    const segs = path.split("/").filter(Boolean);
    return [{ label: "/", path: "/" }, ...segs.map((s, i) => ({ label: s, path: `/${segs.slice(0, i + 1).join("/")}` }))];
  }
  const segs = path.split(/[\\/]/).filter(Boolean);
  return segs.map((s, i) => ({
    label: s,
    path: i === 0 ? `${s}\\` : segs.slice(0, i + 1).join("\\"),
  }));
}

function RowShell({ icon, children, active }: { icon: React.ReactNode; children: React.ReactNode; active?: boolean }) {
  return (
    <div className={cn("flex h-7 items-center gap-2 rounded-md px-2", active && "bg-primary/10")}>
      {icon}
      {children}
    </div>
  );
}

function Row({
  entry: e,
  selected,
  cursor,
  renaming,
  remote,
  onClick,
  onOpen,
  onRename,
  dragPaths,
}: {
  entry: FsEntry;
  selected: boolean;
  cursor: boolean;
  renaming: boolean;
  remote: boolean;
  onClick: (e: React.MouseEvent) => void;
  onOpen: () => void;
  onRename: (v: string) => void;
  dragPaths: () => string[];
}) {
  const hidden = e.name.startsWith(".");
  return (
    <div
      data-name={e.name}
      onClick={onClick}
      onDoubleClick={onOpen}
      onPointerDown={(ev) => startPathDrag(ev, dragPaths, remote)}
      className={cn(
        "grid h-7 cursor-default grid-cols-[1fr_64px_78px] items-center gap-2 rounded-md px-2 text-[12.5px] transition-colors duration-75",
        selected ? "bg-primary/15 text-foreground" : "text-foreground/90 hover:bg-ov/[0.05]",
        cursor && "ring-1 ring-primary/40 ring-inset",
      )}
    >
      <span className={cn("flex min-w-0 items-center gap-2", hidden && "opacity-60")}>
        <EntryIcon e={e} />
        {renaming ? (
          <InlineInput initial={e.name} selectBase={e.kind !== "dir"} onDone={onRename} />
        ) : (
          <span className="truncate">{e.name}</span>
        )}
      </span>
      <span className="truncate text-right text-[11px] text-muted-foreground tabular-nums">
        {e.kind === "file" ? fmtSize(e.size) : ""}
      </span>
      <span className="truncate text-right text-[11px] text-muted-foreground tabular-nums">{fmtTime(e.mtime)}</span>
    </div>
  );
}

/** One hover tooltip for the whole list (a Radix tooltip per row made big folders slow to open). */
function useRowTip() {
  const [tip, setTip] = useState<{ text: string; x: number; y: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const row = useRef<string | null>(null);
  const hide = () => {
    clearTimeout(timer.current);
    row.current = null;
    setTip(null);
  };
  const over = (ev: React.PointerEvent, entries: FsEntry[]) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-name]");
    const name = el?.dataset.name ?? null;
    if (name === row.current) return;
    hide();
    row.current = name;
    if (!el || name == null || ev.buttons) return;
    timer.current = setTimeout(() => {
      const e = entries.find((x) => x.name === name);
      if (!e || !el.isConnected) return;
      const r = el.getBoundingClientRect();
      const text = [
        e.name,
        e.kind === "file" ? fmtSize(e.size) : null,
        e.mode != null ? fmtMode(e.mode) : null,
        e.mtime ? new Date(e.mtime * 1000).toLocaleString() : null,
      ]
        .filter(Boolean)
        .join(" · ");
      setTip({ text, x: r.left + 28, y: r.bottom + 4 });
    }, 900);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  const node = tip
    ? createPortal(
        <div
          className="pointer-events-none fixed z-[95] max-w-72 rounded-md border border-ov/10 bg-popover px-2 py-1 text-[11.5px] leading-snug break-words text-popover-foreground shadow-lg shadow-shadow animate-in fade-in-0 zoom-in-95 duration-150"
          style={{ left: Math.min(tip.x, window.innerWidth - 296), top: Math.min(tip.y, window.innerHeight - 60) }}
        >
          {tip.text}
        </div>,
        document.body,
      )
    : null;
  return { over, hide, node };
}

function InlineInput({ initial, onDone, selectBase }: { initial: string; onDone: (v: string) => void; selectBase?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (selectBase && dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, []);
  const finish = (v: string) => {
    if (done.current) return;
    done.current = true;
    onDone(v.trim());
  };
  return (
    <input
      ref={ref}
      defaultValue={initial}
      spellCheck={false}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") finish(e.currentTarget.value);
        if (e.key === "Escape") finish("");
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      className="h-5.5 min-w-0 flex-1 rounded border border-primary/60 bg-inset px-1.5 text-[12.5px] outline-none"
    />
  );
}

function EntryMenu({
  items,
  remote,
  pathOf,
  onOpen,
  onDownload,
  onDelete,
  onRename,
  onTerminal,
  onCd,
}: {
  items: FsEntry[];
  remote: boolean;
  pathOf: (n: string) => string;
  onOpen: (e: FsEntry) => void;
  onDownload: (e: FsEntry[], ask?: boolean) => void;
  onDelete: (e: FsEntry[]) => void;
  onRename: (name: string) => void;
  onTerminal: (paths: string[]) => void;
  onCd: (path: string) => void;
}) {
  const one = items.length === 1 ? items[0] : null;
  const paths = items.map((e) => pathOf(e.name));
  const files = items.filter((e) => e.kind !== "dir");
  const dirs = items.length - files.length;
  const s = items.length > 1 ? "s" : "";
  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    toast({ kind: "success", title: `Copied ${what}`, duration: 1600 });
  };
  const key = (k: string) => <span className="ml-auto pl-4 text-[10.5px] text-muted-foreground">{k}</span>;

  // Groups are joined with separators, so a group that ends up empty leaves no stray line.
  const groups: React.ReactNode[][] = [
    one
      ? [
          <ContextMenuItem key="open" onSelect={() => onOpen(one)}>
            {one.kind === "dir" ? <FolderOpen /> : remote ? <Pencil /> : <File />}
            {one.kind === "dir" ? "Open" : remote ? "Open & edit (auto-upload)" : "Open"}
            {key("Enter")}
          </ContextMenuItem>,
        ]
      : !remote && files.length > 0 && files.length <= 20
        ? [
            <ContextMenuItem key="open" onSelect={() => files.forEach((f) => onOpen(f))}>
              <File /> Open {files.length} file{files.length > 1 ? "s" : ""}
            </ContextMenuItem>,
          ]
        : [],
    remote
      ? [
          <ContextMenuItem key="dl" onSelect={() => onDownload(items)}>
            <Download /> Download{items.length > 1 ? ` ${items.length} items` : ""}
          </ContextMenuItem>,
          <ContextMenuItem key="dlto" onSelect={() => onDownload(items, true)}>
            <FolderDown /> Download to…
          </ContextMenuItem>,
        ]
      : [
          <ContextMenuItem key="reveal" onSelect={() => void revealItemInDir(one ? paths[0] : paths)}>
            <FolderOpen /> Show in file manager
          </ContextMenuItem>,
        ],
    [
      ...(one?.kind === "dir"
        ? [
            <ContextMenuItem key="cd" onSelect={() => onCd(pathOf(one.name))}>
              <SquareTerminal /> cd here in terminal
            </ContextMenuItem>,
          ]
        : []),
      <ContextMenuItem key="term" onSelect={() => onTerminal(paths)}>
        <SquareTerminal /> Insert path{s} into terminal
      </ContextMenuItem>,
      <ContextMenuItem key="cp" onSelect={() => copy(paths.join("\n"), one ? "path" : `${items.length} paths`)}>
        <ClipboardCopy /> Copy path{s}
      </ContextMenuItem>,
      <ContextMenuItem key="cn" onSelect={() => copy(items.map((e) => e.name).join("\n"), one ? "name" : `${items.length} names`)}>
        <ClipboardCopy /> Copy name{s}
      </ContextMenuItem>,
    ],
    [
      ...(one
        ? [
            <ContextMenuItem key="ren" onSelect={() => onRename(one.name)}>
              <Pencil /> Rename {key("F2")}
            </ContextMenuItem>,
          ]
        : []),
      <ContextMenuItem key="del" destructive onSelect={() => onDelete(items)}>
        <Trash2 /> Delete{items.length > 1 ? ` ${items.length} items` : ""}
        <span className="ml-auto pl-4 text-[10.5px] opacity-70">Del</span>
      </ContextMenuItem>,
    ],
  ].filter((g) => g.length > 0);

  return (
    <ContextMenuContent className="min-w-52">
      {!one && (
        <div className="flex items-center gap-1.5 px-2 pt-1 pb-1.5 text-[11px] text-muted-foreground">
          <span className="font-medium text-foreground/85">{items.length} selected</span>
          <span className="truncate">
            {[files.length && `${files.length} file${files.length > 1 ? "s" : ""}`, dirs && `${dirs} folder${dirs > 1 ? "s" : ""}`]
              .filter(Boolean)
              .join(", ")}
            {files.length > 0 && ` · ${fmtSize(files.reduce((n, f) => n + f.size, 0))}`}
          </span>
        </div>
      )}
      {groups.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: fixed group order
        <Fragment key={i}>
          {(i > 0 || !one) && <ContextMenuSeparator />}
          {g}
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}

// ------------------------------------------------------------------ transfers

function TransferList() {
  const jobs = useTransfers((s) => s.jobs);
  const [open, setOpen] = useState(true);
  if (!jobs.length) return null;
  const running = jobs.filter((j) => j.status === "running").length;
  return (
    <div className="shrink-0 border-t border-ov/[0.08] bg-ov/[0.02]">
      <div className="flex h-7 items-center gap-2 px-3 text-[11px] font-medium text-muted-foreground">
        <button type="button" onClick={() => setOpen(!open)} className="flex items-center gap-1 hover:text-foreground">
          <motion.span animate={{ rotate: open ? 90 : 0 }}>
            <ChevronRight className="size-3" />
          </motion.span>
          Transfers {running ? `· ${running} active` : ""}
        </button>
        <div className="flex-1" />
        {jobs.length > running && (
          <button type="button" onClick={clearFinished} className="hover:text-foreground">
            Clear
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: "auto" }}
            exit={{ height: 0 }}
            className="max-h-48 overflow-y-auto"
          >
            {jobs.map((j) => {
              const pct = j.progress.total ? j.progress.done / j.progress.total : j.status === "done" ? 1 : 0;
              const eta = j.speed > 0 ? (j.progress.total - j.progress.done) / j.speed : 0;
              return (
                <div key={j.id} className="px-3 pb-2">
                  <div className="flex items-center gap-2 text-[11.5px]">
                    {j.dir === "up" ? <Upload className="size-3 shrink-0" /> : <Download className="size-3 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate">{j.label}</span>
                    <span
                      className={cn(
                        "shrink-0 tabular-nums",
                        j.status === "error" ? "text-destructive" : j.status === "done" ? "text-success" : "text-muted-foreground",
                      )}
                    >
                      {j.status === "running"
                        ? `${Math.floor(pct * 100)}%`
                        : j.status === "done"
                          ? "Done"
                          : j.status === "cancelled"
                            ? "Cancelled"
                            : "Failed"}
                    </span>
                    {j.status === "running" && (
                      <button type="button" onClick={() => cancelJob(j.id)} className="rounded p-0.5 text-muted-foreground hover:bg-ov/10 hover:text-foreground">
                        <X className="size-3" />
                      </button>
                    )}
                  </div>
                  <div className="mt-1 h-1 overflow-hidden rounded-full bg-ov/[0.08]">
                    <motion.div
                      className={cn(
                        "h-full rounded-full",
                        j.status === "error" ? "bg-destructive" : j.status === "done" ? "bg-success" : j.status === "cancelled" ? "bg-muted-foreground" : "bg-primary",
                      )}
                      animate={{ width: `${Math.max(2, pct * 100)}%` }}
                      transition={{ ease: "easeOut", duration: 0.2 }}
                    />
                  </div>
                  {j.status === "running" && (
                    <div className="mt-0.5 flex gap-2 text-[10.5px] text-muted-foreground tabular-nums">
                      <span className="min-w-0 flex-1 truncate">
                        {j.progress.filesTotal > 1 ? `${j.progress.filesDone}/${j.progress.filesTotal} · ` : ""}
                        {j.progress.current}
                      </span>
                      <span>{j.speed ? `${fmtSize(j.speed)}/s` : ""}</span>
                      <span>{fmtEta(eta)}</span>
                    </div>
                  )}
                  {j.status === "error" && <div className="mt-0.5 text-[10.5px] break-words text-destructive">{j.error}</div>}
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ------------------------------------------------------------------ drag rows into a terminal

/** Pointer-based drag (HTML5 DnD is disabled by Tauri's native file-drop on Windows). */
function startPathDrag(ev: React.PointerEvent, getPaths: () => string[], remote: boolean) {
  if (ev.button !== 0) return;
  const sx = ev.clientX;
  const sy = ev.clientY;
  let ghost: HTMLDivElement | null = null;
  let paths: string[] = [];
  const move = (e: PointerEvent) => {
    if (!ghost) {
      if (Math.hypot(e.clientX - sx, e.clientY - sy) < 6) return;
      paths = getPaths();
      ghost = document.createElement("div");
      ghost.className =
        "pointer-events-none fixed z-[200] rounded-md border border-ov/15 bg-popover px-2 py-1 text-[12px] text-popover-foreground shadow-xl shadow-shadow";
      ghost.textContent = paths.length === 1 ? (paths[0].split(/[\\/]/).pop() ?? "") : `${paths.length} items`;
      document.body.appendChild(ghost);
      document.body.style.cursor = "copy";
    }
    ghost.style.left = `${e.clientX + 12}px`;
    ghost.style.top = `${e.clientY + 10}px`;
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-pane-id]");
    ghost.style.opacity = target ? "1" : "0.6";
  };
  const up = (e: PointerEvent) => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    document.body.style.cursor = "";
    if (!ghost) return;
    ghost.remove();
    const id = document.elementFromPoint(e.clientX, e.clientY)?.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
    const pane = id ? useApp.getState().panes[id] : null;
    if (pane) {
      pane.session.input(paths.map((p) => quote(p, remote)).join(" "));
      useApp.getState().focusPane(pane.id);
      pane.session.focus();
    }
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

// ------------------------------------------------------------------ helpers


function quote(p: string, posix: boolean) {
  if (!/[\s'"$`&|;<>()*?!#~]/.test(p)) return p;
  return posix ? `'${p.replace(/'/g, `'\\''`)}'` : `"${p}"`;
}

function fmtTime(sec: number | null) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const now = new Date();
  const diff = (now.getTime() - d.getTime()) / 1000;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return `Yesterday`;
  if (d.getFullYear() === now.getFullYear())
    return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return String(d.getFullYear());
}

function fmtMode(mode: number) {
  const t = (mode & 0o170000) === 0o040000 ? "d" : (mode & 0o170000) === 0o120000 ? "l" : "-";
  const rwx = (b: number) => `${b & 4 ? "r" : "-"}${b & 2 ? "w" : "-"}${b & 1 ? "x" : "-"}`;
  return t + rwx((mode >> 6) & 7) + rwx((mode >> 3) & 7) + rwx(mode & 7);
}

const EXT: Record<string, typeof File> = {};
for (const [icon, exts] of [
  [FileCode, "js ts tsx jsx rs go py rb java c h cpp hpp cs php swift kt lua vue svelte html css scss sql"],
  [FileJson, "json jsonc json5 lock"],
  [FileCog, "toml yaml yml ini conf cfg env properties xml service"],
  [FileTerminal, "sh bash zsh fish ps1 bat cmd exe"],
  [FileText, "txt md log csv rst"],
  [FileImage, "png jpg jpeg gif svg webp ico bmp"],
  [FileArchive, "zip tar gz tgz bz2 xz 7z rar zst deb rpm"],
  [FileVideo, "mp4 mkv mov avi webm"],
  [FileKey, "pem key crt cer pub"],
] as const) {
  for (const x of exts.split(" ")) EXT[x] = icon;
}

function EntryIcon({ e }: { e: FsEntry }) {
  if (e.kind === "dir") return <Folder className="size-4 shrink-0 fill-primary/25 text-primary" />;
  if (e.kind === "link") return <FileSymlink className="size-4 shrink-0 text-muted-foreground" />;
  const ext = e.name.includes(".") ? e.name.split(".").pop()!.toLowerCase() : "";
  const Icon = EXT[ext] ?? (e.name.startsWith("id_") ? FileKey : File);
  return <Icon className="size-4 shrink-0 text-muted-foreground" />;
}
