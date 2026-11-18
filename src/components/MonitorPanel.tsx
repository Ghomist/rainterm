// Resource monitor dock, organised by resource: Overview / CPU / Memory / GPU / Disk.
// Charts follow one rule set: one y-axis, thin 2px lines, quiet grid, hover crosshair
// with the value read out in the chart header, a legend only for multi-series charts.
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Activity,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ClipboardCopy,
  Cpu,
  FolderOpen,
  Gpu,
  HardDrive,
  MemoryStick,
  OctagonX,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PanelHeader, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { ipc, type MonitorDisk, type MonitorProc, type MonitorSnapshot } from "@/lib/ipc";
import {
  fmtBytes,
  fmtRate,
  fmtUptime,
  type MachineState,
  machineKey,
  type Sample,
  useMonitor,
} from "@/lib/monitor";
import { confirm, toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { useActivePane, useApp } from "@/store/app";

export function useActiveMachine(): { key: string | null; state: MachineState | null } {
  const pane = useActivePane();
  const remoteOk = useApp((s) => s.settings.monitorRemote);
  const raw = pane ? machineKey(pane.kind, pane.status === "connected" ? pane.session.sessionId : null) : null;
  const key = raw && (raw === "local" || remoteOk) ? raw : null;
  const state = useMonitor((s) => (key ? (s.machines[key] ?? null) : null));
  return { key, state };
}

type TabId = "overview" | "cpu" | "memory" | "gpu" | "disk";

export function MonitorPanel() {
  const { key, state } = useActiveMachine();
  const pane = useActivePane();
  const snap = state?.snap;
  const [tab, setTab] = useState<TabId>("overview");
  const tabs: { id: TabId; label: string; icon: React.ReactNode }[] = [
    { id: "overview", label: "Overview", icon: <Activity /> },
    { id: "cpu", label: "CPU", icon: <Cpu /> },
    { id: "memory", label: "Memory", icon: <MemoryStick /> },
    ...(snap?.gpus.length ? [{ id: "gpu" as const, label: "GPU", icon: <Gpu /> }] : []),
    { id: "disk", label: "Disk", icon: <HardDrive /> },
  ];
  const current = tabs.some((t) => t.id === tab) ? tab : "overview";

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <PanelHeader title="Monitor" icon={<Activity />}>
        {snap && <span className="pr-1.5 text-[11px] text-muted-foreground">up {fmtUptime(snap.uptime)}</span>}
      </PanelHeader>
      {!key ? (
        <Empty
          text={
            pane?.kind === "serial"
              ? "Serial sessions have no host to monitor"
              : pane?.kind === "ssh" && pane.status === "connected"
                ? "Remote monitoring is turned off in Settings"
                : "Connect a session to see its machine"
          }
        />
      ) : state?.error && !snap ? (
        <Empty text={state.error} error />
      ) : !snap ? (
        <Empty text="Collecting…" />
      ) : (
        <>
          <div className="px-2 pb-2">
            <div className="truncate px-1 pb-2 text-[11.5px]">
              <span className="font-medium">{snap.host || "—"}</span>
              <span className="text-muted-foreground"> · {snap.os}</span>
            </div>
            <TabStrip active={current} count={tabs.length}>
              {tabs.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  data-active={current === t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    "relative flex h-6.5 shrink-0 items-center justify-center gap-1 rounded-md px-2.5 text-[11.5px] whitespace-nowrap transition-colors [&_svg]:size-3.5",
                    current === t.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  {current === t.id && (
                    <motion.span
                      layoutId="monitor-tab"
                      className="absolute inset-0 rounded-md bg-ov/[0.09] shadow-sm"
                      transition={{ type: "spring", stiffness: 500, damping: 40 }}
                    />
                  )}
                  <span className="relative flex items-center gap-1">
                    {t.icon}
                    {t.label}
                  </span>
                </button>
              ))}
            </TabStrip>
          </div>
          <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-3">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={current}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14 }}
                className="grid grid-cols-[minmax(0,1fr)] gap-2.5"
              >
                {current === "overview" && <Overview state={state!} onOpen={setTab} />}
                {current === "cpu" && <CpuTab state={state!} machine={key} />}
                {current === "memory" && <MemoryTab state={state!} machine={key} />}
                {current === "gpu" && <GpuTab state={state!} machine={key} />}
                {current === "disk" && <DiskTab snap={snap} />}
              </motion.div>
            </AnimatePresence>
          </ScrollArea>
        </>
      )}
    </div>
  );
}

/** Tabs sized to their labels. When they don't fit: the cut-off side fades out and gets an
 *  arrow, the wheel scrolls one notch at a time (smoothly), and the active tab is kept in view. */
function TabStrip({ active, count, children }: { active: string; count: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdge((e) => (e.left === left && e.right === right ? e : { left, right }));
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    // Plain wheels scroll sideways, ~one tab per notch (non-passive so the page doesn't scroll).
    const wheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      e.preventDefault();
      // Mouse wheel notches (~100px) step one tab smoothly; touchpads (small deltas) track 1:1.
      if (Math.abs(e.deltaY) >= 50) el.scrollBy({ left: Math.sign(e.deltaY) * 72, behavior: "smooth" });
      else el.scrollLeft += e.deltaY;
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => {
      ro.disconnect();
      el.removeEventListener("wheel", wheel);
    };
  }, []);
  // Tabs come and go (GPU): re-check the edges then. (Size changes come via the observer.)
  useEffect(measure, [count]);
  // Keep the selected tab visible (also after clicking a half-hidden one).
  useEffect(() => {
    const el = ref.current;
    const tab = el?.querySelector<HTMLElement>('[data-active="true"]');
    if (!el || !tab) return;
    const pad = 28;
    if (tab.offsetLeft - pad < el.scrollLeft) el.scrollTo({ left: tab.offsetLeft - pad, behavior: "smooth" });
    else if (tab.offsetLeft + tab.offsetWidth + pad > el.scrollLeft + el.clientWidth)
      el.scrollTo({ left: tab.offsetLeft + tab.offsetWidth + pad - el.clientWidth, behavior: "smooth" });
  }, [active]);
  const fade = 28;
  const mask = `linear-gradient(to right, ${edge.left ? `transparent, black ${fade}px` : "black, black"}, ${edge.right ? `black calc(100% - ${fade}px), transparent` : "black"})`;
  const arrow = (side: "left" | "right") => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={side === "left" ? "Scroll tabs left" : "Scroll tabs right"}
      onClick={() => ref.current?.scrollBy({ left: (side === "left" ? -1 : 1) * 96, behavior: "smooth" })}
      className={cn(
        "press absolute inset-y-0.5 z-10 flex w-5 items-center justify-center rounded-md bg-inset text-muted-foreground transition-opacity duration-150 hover:text-foreground [&_svg]:size-3.5",
        side === "left" ? "left-0.5" : "right-0.5",
        edge[side] ? "opacity-100" : "pointer-events-none opacity-0",
      )}
    >
      {side === "left" ? <ChevronLeft /> : <ChevronRight />}
    </button>
  );
  return (
    <div className="relative rounded-lg bg-inset p-0.5">
      {arrow("left")}
      <div
        ref={ref}
        onScroll={measure}
        className="no-scrollbar flex gap-0.5 overflow-x-auto"
        style={{ maskImage: mask, WebkitMaskImage: mask }}
      >
        {children}
      </div>
      {arrow("right")}
    </div>
  );
}

function Empty({ text, error }: { text: string; error?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-muted-foreground">
      {error ? <AlertCircle className="size-5 text-destructive/80" /> : <Activity className="size-5 animate-pulse opacity-60" />}
      <span className="max-w-60 break-words">{text}</span>
    </div>
  );
}

// ------------------------------------------------------------------ tabs

function Overview({ state, onOpen }: { state: MachineState; onOpen: (t: TabId) => void }) {
  const snap = state.snap!;
  const h = state.history;
  const memPct = pct(snap.memUsed, snap.memTotal);
  const gpu = snap.gpus[0];
  const rootDisk = snap.disks.find((d) => d.mount === "/" || /^C:/i.test(d.mount)) ?? snap.disks[0];
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <Tile icon={<Cpu />} label="CPU" value={`${snap.cpu.toFixed(0)}%`} sub={snap.load ? `load ${snap.load.map((l) => l.toFixed(2)).join(" ")}` : `${snap.cores.length} cores`} onClick={() => onOpen("cpu")} />
        <Tile icon={<MemoryStick />} label="Memory" value={`${memPct.toFixed(0)}%`} sub={`${fmtBytes(snap.memUsed)} / ${fmtBytes(snap.memTotal)}`} onClick={() => onOpen("memory")} />
        {gpu ? (
          <Tile icon={<Gpu />} label="GPU" value={gpu.util != null ? `${gpu.util.toFixed(0)}%` : "–"} sub={gpu.temp != null ? `${gpu.temp.toFixed(0)}°C · ${gpu.name}` : gpu.name} onClick={() => onOpen("gpu")} />
        ) : (
          <Tile icon={<ArrowDown />} label="Network" value={fmtRate(snap.netRx)} sub={`↑ ${fmtRate(snap.netTx)}`} />
        )}
        <Tile icon={<HardDrive />} label="Disk" value={rootDisk ? `${pct(rootDisk.used, rootDisk.total).toFixed(0)}%` : "–"} sub={rootDisk ? `${fmtBytes(rootDisk.avail)} free on ${rootDisk.mount}` : ""} onClick={() => onOpen("disk")} />
      </div>
      <Card title="CPU">
        <AreaChart samples={h} pick={(s) => s.cpu} max={100} format={(v) => `${v.toFixed(0)}%`} />
      </Card>
      <Card title="Memory">
        <AreaChart samples={h} pick={(s) => s.mem} max={100} format={(v) => `${v.toFixed(0)}%`} />
      </Card>
      <Card title="Network">
        <NetChart samples={h} />
      </Card>
    </>
  );
}

function CpuTab({ state, machine }: { state: MachineState; machine: string }) {
  const snap = state.snap!;
  return (
    <>
      <Card title="Usage" detail={snap.cpuName}>
        <AreaChart samples={state.history} pick={(s) => s.cpu} max={100} format={(v) => `${v.toFixed(0)}%`} />
        <div className="flex justify-between text-[11px] text-muted-foreground tabular-nums">
          <span>{snap.cores.length} logical cores</span>
          {snap.load && <span>load {snap.load.map((l) => l.toFixed(2)).join(" · ")}</span>}
        </div>
      </Card>
      <Card title="Per core">
        <Cores cores={snap.cores} />
      </Card>
      <Processes procs={snap.procs} machine={machine} memTotal={snap.memTotal} sortBy="cpu" />
    </>
  );
}

function MemoryTab({ state, machine }: { state: MachineState; machine: string }) {
  const snap = state.snap!;
  return (
    <>
      <Card title="Usage">
        <AreaChart samples={state.history} pick={(s) => s.mem} max={100} format={(v) => `${v.toFixed(0)}%`} />
        <Meter label="RAM" used={snap.memUsed} total={snap.memTotal} />
        {snap.swapTotal > 0 && <Meter label="Swap" used={snap.swapUsed} total={snap.swapTotal} />}
      </Card>
      <Processes procs={snap.procs} machine={machine} memTotal={snap.memTotal} sortBy="mem" />
    </>
  );
}

function GpuTab({ state, machine }: { state: MachineState; machine: string }) {
  const snap = state.snap!;
  const gpuProcs = snap.procs.filter((p) => p.gpu != null || p.gpuMem != null);
  return (
    <>
      {snap.gpus.map((g, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: GPU index is its identity
        <Card key={i} title={snap.gpus.length > 1 ? `GPU ${i}` : "GPU"} detail={g.name}>
          {i === 0 && g.util != null && (
            <AreaChart samples={state.history} pick={(s) => s.gpu ?? 0} max={100} format={(v) => `${v.toFixed(0)}%`} />
          )}
          {g.memTotal != null && g.memUsed != null && <Meter label="VRAM" used={g.memUsed} total={g.memTotal} />}
          {g.temp != null && (
            <div className="flex justify-between text-[11px] text-muted-foreground">
              <span>Temperature</span>
              <span className={cn("tabular-nums", g.temp > 80 && "text-warning")}>{g.temp.toFixed(0)}°C</span>
            </div>
          )}
        </Card>
      ))}
      {gpuProcs.length > 0 ? (
        <Processes procs={gpuProcs} machine={machine} memTotal={snap.memTotal} sortBy="gpu" />
      ) : (
        <div className="px-1 text-[11.5px] text-muted-foreground">No processes are using the GPU right now.</div>
      )}
    </>
  );
}

function DiskTab({ snap }: { snap: MonitorSnapshot }) {
  const totals = snap.disks.reduce((a, d) => ({ r: a.r + d.readRate, w: a.w + d.writeRate }), { r: 0, w: 0 });
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        <Tile icon={<ArrowDown />} label="Read" value={fmtRate(totals.r)} sub="all disks" />
        <Tile icon={<ArrowUp />} label="Write" value={fmtRate(totals.w)} sub="all disks" />
      </div>
      <Card title="File systems" detail="like df -h">
        <div className="grid grid-cols-[minmax(0,1fr)] gap-3">
          {snap.disks.map((d) => (
            <DiskRow key={`${d.mount}:${d.device}`} d={d} />
          ))}
        </div>
      </Card>
    </>
  );
}

function DiskRow({ d }: { d: MonitorDisk }) {
  const p = pct(d.used, d.total);
  const detail = [d.device, d.fs, d.kind, d.removable ? "removable" : ""].filter(Boolean).join(" · ");
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        {/* Long mount points / device paths shrink (mount first keeps more room), never the % */}
        <Tooltip content={`${d.mount}${detail ? ` · ${detail}` : ""}`} side="top" delay={500}>
          <span className="min-w-0 shrink truncate text-[12.5px] font-medium">{d.mount}</span>
        </Tooltip>
        <span className="min-w-0 flex-1 shrink-[3] truncate text-[10.5px] text-muted-foreground">{detail}</span>
        <span className={cn("ml-auto shrink-0 text-[12px] font-medium tabular-nums", p > 90 && "text-destructive", p > 75 && p <= 90 && "text-warning")}>
          {p.toFixed(0)}%
        </span>
      </div>
      <Bar pct={p} />
      <div className="grid grid-cols-3 gap-2 text-[10.5px] text-muted-foreground tabular-nums">
        <span>
          Size <span className="text-foreground/85">{fmtBytes(d.total)}</span>
        </span>
        <span>
          Used <span className="text-foreground/85">{fmtBytes(d.used)}</span>
        </span>
        <span className="text-right">
          Free <span className="text-foreground/85">{fmtBytes(d.avail)}</span>
        </span>
      </div>
      {(d.readRate > 0 || d.writeRate > 0) && (
        <div className="flex gap-3 text-[10.5px] text-muted-foreground tabular-nums">
          <span>↓ read {fmtRate(d.readRate)}</span>
          <span>↑ write {fmtRate(d.writeRate)}</span>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ processes

type SortKey = "cpu" | "mem" | "gpu";

function Processes({
  procs,
  machine,
  memTotal,
  sortBy,
}: {
  procs: MonitorProc[];
  machine: string;
  memTotal: number;
  sortBy: SortKey;
}) {
  const [sort, setSort] = useState<SortKey>(sortBy);
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const f = q.trim().toLowerCase();
    const val = (p: MonitorProc) => (sort === "cpu" ? p.cpu : sort === "mem" ? p.mem : (p.gpu ?? 0) * 1e12 + (p.gpuMem ?? 0));
    return procs
      .filter((p) => !f || p.name.toLowerCase().includes(f) || String(p.pid).includes(f) || p.cmd.toLowerCase().includes(f))
      .sort((a, b) => val(b) - val(a))
      .slice(0, 30);
  }, [procs, sort, q]);
  const cols: readonly SortKey[] = sortBy === "gpu" ? ["gpu", "mem"] : ["cpu", "mem"];
  const head = { cpu: "CPU", mem: sortBy === "gpu" ? "VRAM" : "Memory", gpu: "GPU" };
  return (
    <Card title="Processes" detail="right-click for actions">
      <SearchField value={q} onChange={setQ} placeholder="Filter by name, PID or command" />
      <div className="grid grid-cols-[minmax(0,1fr)_56px_64px] gap-2 px-1 text-[10.5px] font-medium text-muted-foreground">
        <span>Name</span>
        {cols.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setSort(k)}
            className={cn("text-right transition-colors hover:text-foreground", sort === k && "text-foreground")}
          >
            {head[k]}
            {sort === k && " ↓"}
          </button>
        ))}
      </div>
      <div className="grid">
        <AnimatePresence initial={false}>
          {rows.map((p) => (
            <ProcRow key={p.pid} p={p} cols={cols} gpuView={sortBy === "gpu"} machine={machine} memTotal={memTotal} />
          ))}
        </AnimatePresence>
      </div>
    </Card>
  );
}

function ProcRow({
  p,
  cols,
  gpuView,
  machine,
  memTotal,
}: {
  p: MonitorProc;
  cols: readonly SortKey[];
  gpuView: boolean;
  machine: string;
  memTotal: number;
}) {
  const remote = machine !== "local";
  const cell = (k: SortKey) =>
    k === "cpu" ? (
      <span key={k} className={cn("text-right tabular-nums", p.cpu > 50 && "text-warning")}>
        {p.cpu.toFixed(1)}%
      </span>
    ) : k === "mem" ? (
      <span key={k} className="text-right text-muted-foreground tabular-nums">
        {gpuView ? (p.gpuMem != null ? fmtBytes(p.gpuMem) : "–") : fmtBytes(p.mem)}
      </span>
    ) : (
      <span key={k} className="text-right tabular-nums">
        {p.gpu != null ? `${p.gpu.toFixed(0)}%` : "–"}
      </span>
    );

  const kill = async (force: boolean) => {
    const ok = await confirm({
      title: `${force ? "Force kill" : "End"} ${p.name} (${p.pid})?`,
      message: force
        ? "The process is killed immediately (SIGKILL) — unsaved work in it is lost."
        : "The process is asked to exit (SIGTERM). It may take a moment, or refuse.",
      confirmLabel: force ? "Force kill" : "End process",
      danger: true,
    });
    if (!ok) return;
    try {
      await ipc.processKill(remote ? machine.slice(4) : null, p.pid, force);
      toast({ kind: "success", title: `${force ? "Killed" : "Ended"} ${p.name}` });
    } catch (e) {
      toast({ kind: "error", title: `Couldn't end ${p.name}`, description: String(e) });
    }
  };

  const copy = (text: string, what: string) => {
    void navigator.clipboard.writeText(text);
    toast({ kind: "success", title: `Copied ${what}`, description: text.length > 80 ? `${text.slice(0, 80)}…` : text, duration: 1800 });
  };

  return (
    <ContextMenu>
      <Tooltip
        delay={700}
        side="left"
        content={[p.cmd || p.name, p.user && `user ${p.user}`, memTotal ? `${pct(p.mem, memTotal).toFixed(1)}% of RAM` : ""]
          .filter(Boolean)
          .join(" · ")}
      >
        <ContextMenuTrigger asChild>
          <motion.div
            layout="position"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="grid h-6 cursor-default grid-cols-[minmax(0,1fr)_56px_64px] items-center gap-2 rounded px-1 text-[11.5px] hover:bg-ov/[0.05] data-[state=open]:bg-primary/12"
          >
            <span className="min-w-0 truncate">
              {p.name} <span className="text-[10px] text-muted-foreground/70">{p.pid}</span>
            </span>
            {cols.map(cell)}
          </motion.div>
        </ContextMenuTrigger>
      </Tooltip>
      <ContextMenuContent className="min-w-48">
        <ContextMenuItem onSelect={() => void kill(false)}>
          <X /> End process
        </ContextMenuItem>
        <ContextMenuItem destructive onSelect={() => void kill(true)}>
          <OctagonX /> Force kill
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => copy(String(p.pid), "PID")}>
          <ClipboardCopy /> Copy PID
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => copy(p.name, "name")}>
          <ClipboardCopy /> Copy name
        </ContextMenuItem>
        {p.cmd && (
          <ContextMenuItem onSelect={() => copy(p.cmd, "command line")}>
            <ClipboardCopy /> Copy command line
          </ContextMenuItem>
        )}
        {!remote && p.exe && (
          <ContextMenuItem onSelect={() => void revealItemInDir(p.exe!)}>
            <FolderOpen /> Open file location
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

// ------------------------------------------------------------------ pieces

const pct = (used: number, total: number) => (total ? Math.min(100, (used / total) * 100) : 0);

function Tile({
  icon,
  label,
  value,
  sub,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      className="rounded-lg border border-ov/[0.06] bg-ov/[0.03] px-2.5 py-2 text-left transition-colors enabled:hover:border-ov/[0.12] enabled:hover:bg-ov/[0.05] disabled:cursor-default"
    >
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground [&_svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 text-[17px] font-semibold tabular-nums">{value}</div>
      <div className="truncate text-[10.5px] text-muted-foreground tabular-nums">{sub}</div>
    </button>
  );
}

function Card({ title, detail, children }: { title: string; detail?: string; children: React.ReactNode }) {
  return (
    <section className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-2 rounded-lg border border-ov/[0.06] bg-ov/[0.02] p-2.5">
      <header className="flex min-w-0 items-baseline gap-2">
        <h3 className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
        {detail && <span className="min-w-0 truncate text-[11px] text-muted-foreground/70">{detail}</span>}
      </header>
      {children}
    </section>
  );
}

function Bar({ pct: p }: { pct: number }) {
  return (
    <div className="h-1.5 overflow-hidden rounded-full bg-ov/[0.08]">
      <motion.div
        className={cn("h-full rounded-full", p > 90 ? "bg-destructive" : p > 75 ? "bg-warning" : "bg-primary")}
        initial={false}
        animate={{ width: `${p}%` }}
        transition={{ duration: 0.5, ease: "easeOut" }}
      />
    </div>
  );
}

function Meter({ label, used, total }: { label: string; used: number; total: number }) {
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline gap-2 text-[11.5px]">
        <span className="min-w-0 truncate">{label}</span>
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {fmtBytes(used)} / {fmtBytes(total)}
        </span>
      </div>
      <Bar pct={pct(used, total)} />
    </div>
  );
}

/** Per-core load. Up to 20 cores: bars in at most two rows, numbered. More than that
 *  (big servers): a compact numbered heat grid plus the busiest cores spelled out. */
function Cores({ cores }: { cores: number[] }) {
  if (!cores.length) return null;
  if (cores.length > 20) return <CoreHeat cores={cores} />;
  const cols = cores.length <= 10 ? cores.length : Math.ceil(cores.length / 2);
  return (
    <div className="grid gap-x-[3px] gap-y-1.5" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {cores.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: core index is its identity
        <Tooltip key={i} content={`Core ${i} · ${c.toFixed(0)}%`} side="top" delay={150}>
          <div className="grid gap-0.5">
            <div className="relative h-7 overflow-hidden rounded-[3px] bg-ov/[0.07]">
              <div
                className={cn(
                  "absolute inset-x-0 bottom-0 rounded-[3px] transition-[height] duration-500 ease-out",
                  "bg-primary",
                )}
                style={{ height: `${Math.max(4, c)}%` }}
              />
            </div>
            <span className="text-center text-[9px] leading-none text-muted-foreground/80 tabular-nums">{i}</span>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

function CoreHeat({ cores }: { cores: number[] }) {
  const avg = cores.reduce((a, b) => a + b, 0) / cores.length;
  const busy = cores.filter((c) => c >= 80).length;
  const top = cores
    .map((c, i) => [i, c] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  return (
    <div className="grid gap-1.5">
      <div className="grid gap-[2px]" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(24px, 1fr))" }}>
        {cores.map((c, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: core index is its identity
          <Tooltip key={i} content={`Core ${i} · ${c.toFixed(0)}%`} side="top" delay={150}>
            <div
              className={cn(
                "flex h-[18px] items-center justify-center rounded-[3px] text-[9px] tabular-nums transition-colors duration-500",
                c >= 55 ? "text-primary-foreground" : "text-muted-foreground",
              )}
              style={{
                background: `color-mix(in oklab, var(--primary) ${Math.round(6 + c * 0.94)}%, color-mix(in oklab, var(--ov) 7%, transparent))`,
              }}
            >
              {i}
            </div>
          </Tooltip>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10.5px] text-muted-foreground tabular-nums">
        <span>
          avg <span className="text-foreground/85">{avg.toFixed(0)}%</span>
        </span>
        <span>
          ≥80% <span className="text-foreground/85">{busy}</span>
        </span>
        <span className="min-w-0 truncate">
          busiest{" "}
          {top.map(([i, c], k) => (
            <span key={i}>
              {k > 0 && ", "}
              <span className="text-foreground/85">#{i}</span> {c.toFixed(0)}%
            </span>
          ))}
        </span>
        <span className="ml-auto flex items-center gap-1">
          0
          <span className="h-1.5 w-10 rounded-full bg-gradient-to-r from-ov/[0.07] to-primary" />
          100%
        </span>
      </div>
    </div>
  );
}

const W = 300;
const H = 64;

function path(values: number[], max: number) {
  const n = Math.max(values.length - 1, 1);
  return values.map((v, i) => [(i / n) * W, H - 2 - (Math.min(v, max) / max) * (H - 6)] as const);
}

function useHover(len: number) {
  const [idx, setIdx] = useState<number | null>(null);
  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    setIdx(Math.round(x * Math.max(len - 1, 1)));
  };
  return { idx: idx !== null && idx < len ? idx : null, onMove, onLeave: () => setIdx(null) };
}

function ago(t: number) {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 2 ? "now" : `${s}s ago`;
}

function AreaChart({
  samples,
  pick,
  max,
  format,
}: {
  samples: Sample[];
  pick: (s: Sample) => number;
  max: number;
  format: (v: number) => string;
}) {
  const values = samples.map(pick);
  const pts = path(values, max);
  const { idx, onMove, onLeave } = useHover(values.length);
  const id = useMemo(() => `g${Math.random().toString(36).slice(2)}`, []);
  const cur = idx ?? values.length - 1;
  if (values.length < 2) return <div className="h-16 rounded-md bg-ov/[0.03]" />;
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  return (
    <div className="grid gap-1">
      <div className="flex items-baseline justify-between text-[10.5px] text-muted-foreground tabular-nums">
        <span className="text-[12px] font-medium text-foreground">{format(values[cur])}</span>
        <span>{idx !== null ? ago(samples[cur].t) : "last 2 min"}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full cursor-crosshair overflow-visible"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--primary)" stopOpacity="0.28" />
            <stop offset="1" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--ov)" strokeOpacity="0.06" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={`${line}L${W},${H}L0,${H}Z`} fill={`url(#${id})`} />
        <path d={line} fill="none" stroke="var(--primary)" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        {idx !== null && (
          <>
            <line x1={pts[idx][0]} x2={pts[idx][0]} y1="0" y2={H} stroke="var(--ov)" strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />
            <circle cx={pts[idx][0]} cy={pts[idx][1]} r="3.5" fill="var(--primary)" stroke="var(--surface)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>
    </div>
  );
}

function NetChart({ samples }: { samples: Sample[] }) {
  const rx = samples.map((s) => s.rx);
  const tx = samples.map((s) => s.tx);
  const max = Math.max(1024, ...rx, ...tx) * 1.15;
  const { idx, onMove, onLeave } = useHover(samples.length);
  const cur = idx ?? samples.length - 1;
  if (samples.length < 2) return <div className="h-16 rounded-md bg-ov/[0.03]" />;
  const toLine = (v: number[]) => path(v, max).map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const series = [
    { label: "Down", values: rx, color: "var(--primary)" },
    { label: "Up", values: tx, color: "var(--term-magenta)" },
  ];
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-3 text-[11px] tabular-nums">
        {series.map((s) => (
          <span key={s.label} className="flex items-center gap-1">
            <span className="h-0.5 w-3 rounded-full" style={{ background: s.color }} />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium">{fmtRate(s.values[cur])}</span>
          </span>
        ))}
        <span className="ml-auto text-[10.5px] text-muted-foreground">{idx !== null ? ago(samples[cur].t) : ""}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-16 w-full cursor-crosshair overflow-visible"
        onPointerMove={onMove}
        onPointerLeave={onLeave}
      >
        {[0.25, 0.5, 0.75].map((g) => (
          <line key={g} x1="0" x2={W} y1={H * g} y2={H * g} stroke="var(--ov)" strokeOpacity="0.06" vectorEffect="non-scaling-stroke" />
        ))}
        {series.map((s) => (
          <path key={s.label} d={toLine(s.values)} fill="none" stroke={s.color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        ))}
        {idx !== null && (
          <line x1={(idx / Math.max(samples.length - 1, 1)) * W} x2={(idx / Math.max(samples.length - 1, 1)) * W} y1="0" y2={H} stroke="var(--ov)" strokeOpacity="0.3" vectorEffect="non-scaling-stroke" />
        )}
      </svg>
    </div>
  );
}
