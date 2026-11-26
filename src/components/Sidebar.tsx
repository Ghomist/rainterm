import {
  ArrowRight,
  Cable,
  ChevronRight,
  Columns2,
  Copy,
  FileInput,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Plug,
  Plus,
  Server,
  SquareTerminal,
  Bot,
  Trash2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IconButton, PanelHeader, rowCls, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { confirm, prompt, toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { allGroups, type Profile, type SplitAt, useApp } from "@/store/app";
import { tr } from "@/lib/i18n";

const QUICK = /^(?:ssh\s+)?(?:[^@\s]+@)?[^:\s@]+(?::\d+)?$/;

export async function importSshConfig() {
  try {
    const { added, total } = await useApp.getState().importSshConfig();
    if (!total) toast({ kind: "info", title: tr("No hosts found in ~/.ssh/config") });
    else if (!added) toast({ kind: "info", title: tr("Everything in ~/.ssh/config is already imported") });
    else toast({ kind: "success", title: tr(added > 1 ? "Imported {0} hosts from ~/.ssh/config" : "Imported {0} host from ~/.ssh/config", { 0: added }) });
  } catch (e) {
    toast({ kind: "error", title: tr("Couldn't read ~/.ssh/config"), description: String(e) });
  }
}

const profileLabel = (p: Profile) => p.name || (p.kind === "ssh" ? p.host : p.target.port);

async function newGroup() {
  const s = useApp.getState();
  const existing = allGroups(s.settings.profileGroups, s.profiles);
  const name = await prompt({
    title: tr("New group"),
    placeholder: tr("e.g. Production"),
    confirmLabel: tr("Create"),
    validate: (v) => (!v.trim() ? tr("Enter a name") : existing.includes(v.trim()) ? tr("That group already exists") : null),
  });
  if (name) await s.createGroup(name);
  return name?.trim() ?? null;
}

// ------------------------------------------------------------------ drag to regroup

interface DragState {
  id: string;
  label: string;
  x: number;
  y: number;
  /** Group under the pointer ("" = ungrouped), or null when not over a drop target. */
  over: string | null;
  /** Terminal pane under the pointer: dropping opens the session split beside it. */
  pane: PaneDrop | null;
}

interface PaneDrop {
  paneId: string;
  side: SplitAt["side"];
  /** Where the new pane will go (screen px), for the preview. */
  rect: { left: number; top: number; width: number; height: number };
}

const dropTargetAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup ?? null;

/** Dropping on a terminal pane splits it towards the nearest edge. */
function paneDropAt(x: number, y: number): PaneDrop | null {
  const el = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-pane-id]");
  const paneId = el?.dataset.paneId;
  if (!el || !paneId || !useApp.getState().panes[paneId]?.session) return null;
  const r = el.getBoundingClientRect();
  const fx = (x - r.left) / r.width;
  const fy = (y - r.top) / r.height;
  const d = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
  const side = (Object.keys(d) as SplitAt["side"][]).reduce((a, b) => (d[b] < d[a] ? b : a));
  const half = side === "left" || side === "right" ? r.width / 2 : r.height / 2;
  const rect = {
    left: side === "right" ? r.left + half : r.left,
    top: side === "bottom" ? r.top + half : r.top,
    width: side === "left" || side === "right" ? half : r.width,
    height: side === "top" || side === "bottom" ? half : r.height,
  };
  return { paneId, side, rect };
}

function useProfileDrag() {
  const [drag, setDrag] = useState<DragState | null>(null);
  const start = (e: React.PointerEvent, p: Profile) => {
    if (e.button !== 0) return;
    const sx = e.clientX;
    const sy = e.clientY;
    let active = false;
    const move = (ev: PointerEvent) => {
      if (!active && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
      active = true;
      const over = dropTargetAt(ev.clientX, ev.clientY);
      const pane = over === null ? paneDropAt(ev.clientX, ev.clientY) : null;
      setDrag({ id: p.id, label: profileLabel(p), x: ev.clientX, y: ev.clientY, over, pane });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!active) return;
      const over = dropTargetAt(ev.clientX, ev.clientY);
      const pane = over === null ? paneDropAt(ev.clientX, ev.clientY) : null;
      if (over !== null) void useApp.getState().moveProfile(p.id, over);
      else if (pane) void useApp.getState().connect(p, { at: { paneId: pane.paneId, side: pane.side } });
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return [drag, start] as const;
}

// ------------------------------------------------------------------ content

export function SessionsView() {
  const shells = useApp((s) => s.shells);
  const profiles = useApp((s) => s.profiles);
  const groupOrder = useApp((s) => s.settings.profileGroups);
  const collapsed = useApp((s) => s.settings.collapsedGroups);
  const updateSettings = useApp((s) => s.updateSettings);
  const openLocal = useApp((s) => s.openLocal);
  const quickConnect = useApp((s) => s.quickConnect);
  const set = useApp((s) => s.set);
  const [query, setQuery] = useState("");
  const [drag, startDrag] = useProfileDrag();
  const agentsOn = useApp((s) => s.settings.agentsBoard);

  const q = query.trim().toLowerCase();
  const sections = useMemo(() => {
    const hay = (p: Profile) =>
      p.kind === "ssh" ? `${p.name} ${p.host} ${p.user} ${p.group ?? ""}` : `${p.name} ${p.target.port} ${p.group ?? ""}`;
    const filtered = profiles.filter((p) => !q || hay(p).toLowerCase().includes(q));
    const names = allGroups(groupOrder ?? [], profiles);
    const by = (g: string) => filtered.filter((p) => (p.group?.trim() || "") === g);
    return {
      ungrouped: by(""),
      groups: names.map((g) => [g, by(g)] as const).filter(([, items]) => !q || items.length > 0),
      hasGroups: names.length > 0,
    };
  }, [profiles, groupOrder, q]);
  const localShells = shells.filter((s) => !q || s.name.toLowerCase().includes(q));
  const canQuick = QUICK.test(query.trim()) && query.includes("@");
  const empty = profiles.length === 0 && !sections.hasGroups;

  const toggle = (g: string) =>
    void updateSettings({
      collapsedGroups: collapsed.includes(g) ? collapsed.filter((x) => x !== g) : [...collapsed, g],
    });

  return (
    <>
      <PanelHeader title={tr("Sessions")}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton tip={tr("New session")}>
              <Plus />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "ssh" } })}>
              <Server /> {tr("New SSH session…")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "serial" } })}>
              <Cable /> {tr("New serial session…")}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void newGroup()}>
              <FolderPlus /> {tr("New group…")}</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void importSshConfig()}>
              <FileInput /> {tr("Import from ~/.ssh/config")}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelHeader>

      <div className="px-2 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={tr("Search or user@host")}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canQuick) {
              quickConnect(query);
              setQuery("");
            }
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      <AnimatePresence>
        {canQuick && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden px-2"
          >
            <button
              type="button"
              onClick={() => {
                quickConnect(query);
                setQuery("");
              }}
              className={cn(rowCls, "mb-2 bg-primary/12 text-primary hover:bg-primary/18")}
            >
              <Plug className="size-3.5 shrink-0" />
              <span className="truncate">{tr("Connect to")}{" "}{query.trim()}</span>
              <span className="ml-auto text-[11px] opacity-70">↵</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
        <Group label={tr("Local")} defaultOpen>
          {agentsOn && (!q || "agents".includes(q) || tr("Agents").toLowerCase().includes(q)) && (
            <Row icon={<Bot />} label={tr("Agents")} detail={tr("multi-agent board")} onOpen={() => useApp.getState().openAgents()} />
          )}
          {localShells.map((sh) => (
            <Row key={sh.id} icon={<SquareTerminal />} label={sh.name} onOpen={() => openLocal(sh)} />
          ))}
        </Group>

        {empty && !q && (
          <div className="mt-2 rounded-lg border border-dashed border-ov/10 p-3 text-center text-[12px] leading-relaxed text-muted-foreground">
            {tr("No saved sessions yet.")}<div className="mt-1.5 flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => set({ profileEditor: { kind: "ssh" } })}
                className="text-primary hover:underline"
              >
                {tr("Create an SSH session")}</button>
              <button type="button" onClick={() => void importSshConfig()} className="text-primary hover:underline">
                {tr("Import from ~/.ssh/config")}</button>
            </div>
          </div>
        )}

        {(sections.ungrouped.length > 0 || (drag && sections.hasGroups)) && (
          <ProfileGroup
            group=""
            label={sections.hasGroups ? tr("Ungrouped") : tr("Saved")}
            items={sections.ungrouped}
            open={!collapsed.includes("") || !!q}
            onToggle={() => toggle("")}
            drag={drag}
            startDrag={startDrag}
          />
        )}
        {sections.groups.map(([g, items]) => (
          <ProfileGroup
            key={g}
            group={g}
            label={g}
            items={items}
            open={!collapsed.includes(g) || !!q}
            onToggle={() => toggle(g)}
            drag={drag}
            startDrag={startDrag}
          />
        ))}
      </ScrollArea>

      {drag?.pane &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[99] rounded-md border-2 border-primary/60 bg-primary/10 transition-[left,top,width,height] duration-100"
            style={drag.pane.rect}
          />,
          document.body,
        )}
      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[100] flex items-center gap-1.5 rounded-md border border-ov/10 bg-popover px-2 py-1 text-[12px] shadow-lg shadow-shadow"
            style={{ left: drag.x + 12, top: drag.y + 8 }}
          >
            <Server className="size-3.5 text-muted-foreground" />
            {drag.label}
            {drag.over !== null && (
              <span className="text-muted-foreground">
                → <span className="text-primary">{drag.over || tr("Ungrouped")}</span>
              </span>
            )}
            {drag.pane && <span className="text-muted-foreground">→ <span className="text-primary">{tr("Open in split")}</span></span>}
          </div>,
          document.body,
        )}
    </>
  );
}

function Group({
  label,
  defaultOpen,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="mb-1.5">
      <GroupHeader label={label} open={open} onToggle={() => setOpen(!open)} />
      <Collapse open={open}>{children}</Collapse>
    </div>
  );
}

function GroupHeader({
  label,
  open,
  onToggle,
  folder,
  count,
  actions,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  folder?: boolean;
  count?: number;
  actions?: React.ReactNode;
}) {
  return (
    <div className="group/h flex h-7 items-center rounded-md pr-0.5">
      <button
        type="button"
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-1 px-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
      >
        <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }}>
          <ChevronRight className="size-3.5" />
        </motion.span>
        {folder && (open ? <FolderOpen className="size-3.5 shrink-0" /> : <Folder className="size-3.5 shrink-0" />)}
        <span className="truncate">{label}</span>
        {count !== undefined && (
          <span className="ml-0.5 font-normal tracking-normal text-muted-foreground/60 normal-case">{count}</span>
        )}
      </button>
      {actions && <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover/h:opacity-100 has-[[data-state=open]]:opacity-100">{actions}</div>}
    </div>
  );
}

function Collapse({ open, children }: { open: boolean; children: React.ReactNode }) {
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: "auto", opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.18, ease: [0.2, 0.8, 0.2, 1] }}
          className="overflow-hidden"
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ProfileGroup({
  group,
  label,
  items,
  open,
  onToggle,
  drag,
  startDrag,
}: {
  group: string;
  label: string;
  items: Profile[];
  open: boolean;
  onToggle: () => void;
  drag: DragState | null;
  startDrag: (e: React.PointerEvent, p: Profile) => void;
}) {
  const set = useApp((s) => s.set);
  const connect = useApp((s) => s.connect);
  const renameGroup = useApp((s) => s.renameGroup);
  const deleteGroup = useApp((s) => s.deleteGroup);
  const profiles = useApp((s) => s.profiles);
  const groupOrder = useApp((s) => s.settings.profileGroups);
  const isOver = drag?.over === group;
  const draggingFromHere = drag && items.some((p) => p.id === drag.id);

  const connectAll = () => {
    if (!items.length) return;
    for (const p of items) void connect(p);
  };
  const rename = async () => {
    const existing = allGroups(groupOrder ?? [], profiles);
    const name = await prompt({
      title: tr("Rename group"),
      value: group,
      confirmLabel: tr("Rename"),
      validate: (v) =>
        !v.trim() ? tr("Enter a name") : v.trim() !== group && existing.includes(v.trim()) ? tr("That group already exists") : null,
    });
    if (name) await renameGroup(group, name);
  };
  const remove = async () => {
    const ok = await confirm({
      title: tr("Delete group “{0}”?", { 0: group }),
      message: items.length
        ? tr(items.length > 1 ? "Its {0} sessions will move to Ungrouped — nothing is deleted." : "Its {0} session will move to Ungrouped — nothing is deleted.", { 0: items.length })
        : tr("The group is empty."),
      confirmLabel: tr("Delete group"),
      danger: true,
    });
    if (ok) await deleteGroup(group);
  };

  const menu = (Item: typeof ContextMenuItem | typeof DropdownMenuItem, Sep: React.ElementType) => (
    <>
      <Item onSelect={() => set({ profileEditor: { kind: "ssh", group } })}>
        <Plus /> {tr("New session here…")}</Item>
      <Item disabled={!items.length} onSelect={connectAll}>
        <Plug /> {tr("Connect all (")}{items.length})
      </Item>
      {group && (
        <>
          <Sep />
          <Item onSelect={() => void rename()}>
            <Pencil /> {tr("Rename…")}</Item>
          <Item onSelect={() => void remove()} className="text-destructive data-[highlighted]:bg-destructive/15 [&_svg]:text-destructive">
            <Trash2 /> {tr("Delete group")}</Item>
        </>
      )}
    </>
  );

  return (
    <div
      data-drop-group={group}
      className={cn(
        "mb-1.5 rounded-lg transition-colors duration-150",
        isOver && !draggingFromHere && "bg-primary/10 ring-1 ring-primary/40",
      )}
    >
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div>
            <GroupHeader
              label={label}
              open={open}
              onToggle={onToggle}
              folder={!!group}
              count={group ? items.length : undefined}
              actions={
                <>
                  <Tooltip content={tr("New session in this group")}>
                    <button
                      type="button"
                      onClick={() => set({ profileEditor: { kind: "ssh", group } })}
                      className="press flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
                    >
                      <Plus />
                    </button>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="press flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground data-[state=open]:bg-ov/10 [&_svg]:size-3.5"
                      >
                        <MoreHorizontal />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">{menu(DropdownMenuItem, DropdownMenuSeparator)}</DropdownMenuContent>
                  </DropdownMenu>
                </>
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu(ContextMenuItem, ContextMenuSeparator)}</ContextMenuContent>
      </ContextMenu>
      <Collapse open={open}>
        {items.map((p) => (
          <ProfileRow key={p.id} profile={p} dragging={drag?.id === p.id} onPointerDown={(e) => startDrag(e, p)} />
        ))}
        {group && items.length === 0 && (
          <div className="py-1.5 pl-6 text-[11.5px] text-muted-foreground/60">{tr("Empty — drag sessions here")}</div>
        )}
      </Collapse>
    </div>
  );
}

function Row({
  icon,
  label,
  detail,
  onOpen,
  onPointerDown,
  dragging,
}: {
  icon: React.ReactNode;
  label: string;
  detail?: string;
  onOpen: () => void;
  onPointerDown?: (e: React.PointerEvent) => void;
  dragging?: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={0}
      onDoubleClick={onOpen}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => e.key === "Enter" && onOpen()}
      className={cn(
        rowCls,
        "group cursor-default pl-6 text-foreground/85 hover:bg-ov/[0.05] hover:text-foreground focus-visible:bg-ov/[0.07]",
        "[&>svg]:size-3.5 [&>svg]:shrink-0 [&>svg]:text-muted-foreground",
        dragging && "opacity-40",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {detail && (
        <span className="min-w-0 max-w-[45%] truncate text-[11px] text-muted-foreground/70 group-hover:hidden">
          {detail}
        </span>
      )}
      <Tooltip content={tr("Open")} side="right">
        <button
          type="button"
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="press -mr-1 hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-primary/15 hover:text-primary group-hover:flex"
        >
          <ArrowRight className="size-3.5" />
        </button>
      </Tooltip>
    </div>
  );
}

function ProfileRow({
  profile,
  dragging,
  onPointerDown,
}: {
  profile: Profile;
  dragging?: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
}) {
  const connect = useApp((s) => s.connect);
  const set = useApp((s) => s.set);
  const saveProfile = useApp((s) => s.saveProfile);
  const deleteProfile = useApp((s) => s.deleteProfile);
  const moveProfile = useApp((s) => s.moveProfile);
  const profiles = useApp((s) => s.profiles);
  const groupOrder = useApp((s) => s.settings.profileGroups);
  const groups = allGroups(groupOrder ?? [], profiles);
  const current = profile.group?.trim() || "";

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div>
          <Row
            icon={profile.kind === "serial" ? <Cable /> : <Server />}
            label={profileLabel(profile)}
            detail={profile.kind === "ssh" ? profile.host : `${profile.target.port} · ${profile.target.baud}`}
            onOpen={() => void connect(profile)}
            onPointerDown={onPointerDown}
            dragging={dragging}
          />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => void connect(profile)}>
          <Plug /> {tr("Connect")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => void connect(profile, { split: "row" })}>
          <Columns2 /> {tr("Connect in split")}</ContextMenuItem>
        <ContextMenuItem onSelect={() => set({ profileEditor: { profile, kind: profile.kind } })}>
          <Pencil /> {tr("Edit…")}</ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void saveProfile({ ...profile, id: crypto.randomUUID(), name: `${profile.name} copy` })
          }
        >
          <Copy /> {tr("Duplicate")}</ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput /> {tr("Move to group")}</ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groups.map((g) => (
              <ContextMenuItem key={g} disabled={g === current} onSelect={() => void moveProfile(profile.id, g)}>
                <Folder /> {g}
              </ContextMenuItem>
            ))}
            {current && (
              <ContextMenuItem onSelect={() => void moveProfile(profile.id, "")}>
                <span className="size-3.5" /> {tr("Ungrouped")}</ContextMenuItem>
            )}
            {(groups.length > 0 || current) && <ContextMenuSeparator />}
            <ContextMenuItem
              onSelect={async () => {
                const g = await newGroup();
                if (g) await moveProfile(profile.id, g);
              }}
            >
              <FolderPlus /> {tr("New group…")}</ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          destructive
          onSelect={async () => {
            const ok = await confirm({
              title: tr("Delete “{0}”?", { 0: profile.name }),
              message: tr("The saved session (and any password stored for it) will be removed."),
              confirmLabel: tr("Delete"),
              danger: true,
            });
            if (ok) void deleteProfile(profile.id);
          }}
        >
          <Trash2 /> {tr("Delete")}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
