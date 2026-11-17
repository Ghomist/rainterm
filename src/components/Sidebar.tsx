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
import { allGroups, type Profile, useApp } from "@/store/app";

export const SIDEBAR_WIDTH = 248;
const QUICK = /^(?:ssh\s+)?(?:[^@\s]+@)?[^:\s@]+(?::\d+)?$/;

export function Sidebar() {
  const open = useApp((s) => s.sidebarOpen);
  return (
    <motion.aside
      initial={false}
      animate={{ width: open ? SIDEBAR_WIDTH : 0, opacity: open ? 1 : 0 }}
      transition={{ type: "spring", stiffness: 420, damping: 42 }}
      className="shrink-0 overflow-hidden bg-chrome"
    >
      <div style={{ width: SIDEBAR_WIDTH }} className="flex h-full flex-col">
        <SidebarContent />
      </div>
    </motion.aside>
  );
}

export async function importSshConfig() {
  try {
    const { added, total } = await useApp.getState().importSshConfig();
    if (!total) toast({ kind: "info", title: "No hosts found in ~/.ssh/config" });
    else if (!added) toast({ kind: "info", title: "Everything in ~/.ssh/config is already imported" });
    else toast({ kind: "success", title: `Imported ${added} host${added > 1 ? "s" : ""} from ~/.ssh/config` });
  } catch (e) {
    toast({ kind: "error", title: "Couldn't read ~/.ssh/config", description: String(e) });
  }
}

const profileLabel = (p: Profile) => p.name || (p.kind === "ssh" ? p.host : p.target.port);

async function newGroup() {
  const s = useApp.getState();
  const existing = allGroups(s.settings.profileGroups, s.profiles);
  const name = await prompt({
    title: "New group",
    placeholder: "e.g. Production",
    confirmLabel: "Create",
    validate: (v) => (!v.trim() ? "Enter a name" : existing.includes(v.trim()) ? "That group already exists" : null),
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
}

const dropTargetAt = (x: number, y: number) =>
  document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-group]")?.dataset.dropGroup ?? null;

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
      setDrag({ id: p.id, label: profileLabel(p), x: ev.clientX, y: ev.clientY, over: dropTargetAt(ev.clientX, ev.clientY) });
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      if (!active) return;
      const over = dropTargetAt(ev.clientX, ev.clientY);
      if (over !== null) void useApp.getState().moveProfile(p.id, over);
      setDrag(null);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return [drag, start] as const;
}

// ------------------------------------------------------------------ content

function SidebarContent() {
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
      <PanelHeader title="Sessions">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton tip="New session">
              <Plus />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "ssh" } })}>
              <Server /> New SSH session…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => set({ profileEditor: { kind: "serial" } })}>
              <Cable /> New serial session…
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void newGroup()}>
              <FolderPlus /> New group…
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => void importSshConfig()}>
              <FileInput /> Import from ~/.ssh/config
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PanelHeader>

      <div className="px-2 pb-2">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Search or user@host"
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
              <span className="truncate">Connect to {query.trim()}</span>
              <span className="ml-auto text-[11px] opacity-70">↵</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
        <Group label="Local" defaultOpen>
          {localShells.map((sh) => (
            <Row key={sh.id} icon={<SquareTerminal />} label={sh.name} onOpen={() => openLocal(sh)} />
          ))}
        </Group>

        {empty && !q && (
          <div className="mt-2 rounded-lg border border-dashed border-ov/10 p-3 text-center text-[12px] leading-relaxed text-muted-foreground">
            No saved sessions yet.
            <div className="mt-1.5 flex flex-col gap-0.5">
              <button
                type="button"
                onClick={() => set({ profileEditor: { kind: "ssh" } })}
                className="text-primary hover:underline"
              >
                Create an SSH session
              </button>
              <button type="button" onClick={() => void importSshConfig()} className="text-primary hover:underline">
                Import from ~/.ssh/config
              </button>
            </div>
          </div>
        )}

        {(sections.ungrouped.length > 0 || (drag && sections.hasGroups)) && (
          <ProfileGroup
            group=""
            label={sections.hasGroups ? "Ungrouped" : "Saved"}
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
                → <span className="text-primary">{drag.over || "Ungrouped"}</span>
              </span>
            )}
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
      title: "Rename group",
      value: group,
      confirmLabel: "Rename",
      validate: (v) =>
        !v.trim() ? "Enter a name" : v.trim() !== group && existing.includes(v.trim()) ? "That group already exists" : null,
    });
    if (name) await renameGroup(group, name);
  };
  const remove = async () => {
    const ok = await confirm({
      title: `Delete group “${group}”?`,
      message: items.length
        ? `Its ${items.length} session${items.length > 1 ? "s" : ""} will move to Ungrouped — nothing is deleted.`
        : "The group is empty.",
      confirmLabel: "Delete group",
      danger: true,
    });
    if (ok) await deleteGroup(group);
  };

  const menu = (Item: typeof ContextMenuItem | typeof DropdownMenuItem, Sep: React.ElementType) => (
    <>
      <Item onSelect={() => set({ profileEditor: { kind: "ssh", group } })}>
        <Plus /> New session here…
      </Item>
      <Item disabled={!items.length} onSelect={connectAll}>
        <Plug /> Connect all ({items.length})
      </Item>
      {group && (
        <>
          <Sep />
          <Item onSelect={() => void rename()}>
            <Pencil /> Rename…
          </Item>
          <Item onSelect={() => void remove()} className="text-destructive data-[highlighted]:bg-destructive/15 [&_svg]:text-destructive">
            <Trash2 /> Delete group
          </Item>
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
                  <Tooltip content="New session in this group">
                    <button
                      type="button"
                      onClick={() => set({ profileEditor: { kind: "ssh", group } })}
                      className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
                    >
                      <Plus />
                    </button>
                  </Tooltip>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground data-[state=open]:bg-ov/10 [&_svg]:size-3.5"
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
          <div className="py-1.5 pl-6 text-[11.5px] text-muted-foreground/60">Empty — drag sessions here</div>
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
      <Tooltip content="Open" side="right">
        <button
          type="button"
          tabIndex={-1}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            onOpen();
          }}
          className="-mr-1 hidden size-5 shrink-0 items-center justify-center rounded text-muted-foreground transition hover:bg-primary/15 hover:text-primary group-hover:flex"
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
          <Plug /> Connect
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void connect(profile, { split: "row" })}>
          <Columns2 /> Connect in split
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => set({ profileEditor: { profile, kind: profile.kind } })}>
          <Pencil /> Edit…
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            void saveProfile({ ...profile, id: crypto.randomUUID(), name: `${profile.name} copy` })
          }
        >
          <Copy /> Duplicate
        </ContextMenuItem>
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <FolderInput /> Move to group
          </ContextMenuSubTrigger>
          <ContextMenuSubContent>
            {groups.map((g) => (
              <ContextMenuItem key={g} disabled={g === current} onSelect={() => void moveProfile(profile.id, g)}>
                <Folder /> {g}
              </ContextMenuItem>
            ))}
            {current && (
              <ContextMenuItem onSelect={() => void moveProfile(profile.id, "")}>
                <span className="size-3.5" /> Ungrouped
              </ContextMenuItem>
            )}
            {(groups.length > 0 || current) && <ContextMenuSeparator />}
            <ContextMenuItem
              onSelect={async () => {
                const g = await newGroup();
                if (g) await moveProfile(profile.id, g);
              }}
            >
              <FolderPlus /> New group…
            </ContextMenuItem>
          </ContextMenuSubContent>
        </ContextMenuSub>
        <ContextMenuSeparator />
        <ContextMenuItem
          destructive
          onSelect={async () => {
            const ok = await confirm({
              title: `Delete “${profile.name}”?`,
              message: "The saved session (and any password stored for it) will be removed.",
              confirmLabel: "Delete",
              danger: true,
            });
            if (ok) void deleteProfile(profile.id);
          }}
        >
          <Trash2 /> Delete
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
