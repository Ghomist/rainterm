// Quick-ops panels: listening ports, containers (docker / podman) and Kubernetes —
// for the machine of the active terminal (this computer, or the SSH server).
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  AlertCircle,
  ArrowLeftRight,
  Boxes,
  ClipboardCopy,
  FileText,
  Globe,
  Network,
  Play,
  RefreshCw,
  RotateCw,
  Scaling,
  Ship,
  Skull,
  Square,
  SquareTerminal,
  Trash2,
  Unplug,
  Copy,
  Layers,
} from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Select } from "@/components/ui/controls";
import { IconButton, PanelHeader, SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { ipc, type PortEntry } from "@/lib/ipc";
import { confirm, prompt, toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { useActivePane, useApp } from "@/store/app";
import { openRunDialog, RunContainerDialog } from "./ContainerRun";
import { tr } from "@/lib/i18n";

// ------------------------------------------------------------------ shared

interface Target {
  /** Stable per machine: "local" or the SSH session id. */
  key: string;
  sessionId: string | null;
  label: string;
}

function useTarget(): { target: Target | null; reason: string } {
  const pane = useActivePane();
  if (!pane) return { target: null, reason: tr("Open a terminal first") };
  if (pane.kind === "local") return { target: { key: "local", sessionId: null, label: tr("This computer") }, reason: "" };
  if (pane.kind === "serial") return { target: null, reason: tr("Serial sessions have no host to inspect") };
  const id = pane.session.sessionId;
  if (pane.status !== "connected" || !id) return { target: null, reason: tr("Waiting for the SSH session to connect…") };
  return { target: { key: id, sessionId: id, label: pane.title }, reason: "" };
}

/** Load now, then every `ms` while mounted; reloads at once when `key` changes. */
function usePoll<T>(key: string | null, load: () => Promise<T>, ms: number) {
  const [state, setState] = useState<{ key?: string; data?: T; error?: string; loading: boolean }>({ loading: false });
  const loadRef = useRef(load);
  loadRef.current = load;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!key) return;
    let alive = true;
    let timer = 0;
    const run = async () => {
      setState((s) => (s.key === key ? { ...s, loading: true } : { key, loading: true }));
      try {
        const data = await loadRef.current();
        if (alive) setState({ key, data, loading: false });
      } catch (e) {
        if (alive) setState((s) => ({ ...s, key, error: String(e).replace(/^Error: /, ""), loading: false }));
      }
      if (alive) timer = window.setTimeout(run, ms);
    };
    void run();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, ms, tick]);
  const fresh = state.key === key;
  return {
    data: fresh ? state.data : undefined,
    error: fresh ? state.error : undefined,
    loading: state.loading,
    refresh: () => setTick((t) => t + 1),
  };
}

type Tool = "docker" | "podman" | "kubectl";

/** Run a tool on the target; non-zero exit → Error with its stderr. */
async function run(t: Target, tool: Tool, args: string[]): Promise<string> {
  const r = await ipc.opsRun(t.sessionId, tool, args);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim().split("\n").slice(-3).join("\n");
    throw new Error(r.code === 127 ? `${tool} isn't installed${t.sessionId ? " on this server" : ""}` : msg || `exit code ${r.code}`);
  }
  return r.stdout;
}

/** Type a command line into the active terminal and run it. */
function typeInto(cmd: string) {
  const st = useApp.getState();
  const tab = st.tabs.find((x) => x.id === st.activeTabId);
  const pane = tab ? st.panes[tab.activePane] : undefined;
  if (!pane?.session?.alive) return toast({ kind: "info", title: tr("No connected terminal") });
  pane.session.input(`${cmd}\r`, true);
  pane.session.focus();
}

const copy = (text: string) => {
  void navigator.clipboard.writeText(text);
  toast({ kind: "success", title: tr("Copied"), description: text, duration: 1500 });
};

function fail(title: string, e: unknown) {
  toast({ kind: "error", title, description: String(e).replace(/^Error: /, "") });
}

function age(iso?: string) {
  if (!iso) return "";
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function Header({
  title,
  icon,
  target,
  loading,
  onRefresh,
}: {
  title: string;
  icon: React.ReactNode;
  target: Target | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <PanelHeader title={title} icon={icon}>
      {target && <span className="max-w-32 truncate pr-1 text-[11px] text-muted-foreground">{target.label}</span>}
      <IconButton tip={tr("Refresh")} disabled={!target} onClick={onRefresh}>
        <motion.span
          animate={loading ? { rotate: 360 } : { rotate: 0 }}
          transition={loading ? { duration: 0.9, repeat: Number.POSITIVE_INFINITY, ease: "linear" } : { duration: 0 }}
          className="flex"
        >
          <RefreshCw />
        </motion.span>
      </IconButton>
    </PanelHeader>
  );
}

function Empty({ icon, text, error }: { icon?: React.ReactNode; text: string; error?: boolean }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-[12px] text-muted-foreground [&_svg]:size-5">
      {error ? <AlertCircle className="text-destructive/80" /> : <span className="opacity-60">{icon}</span>}
      <span className="max-w-64 break-words whitespace-pre-line">{text}</span>
    </div>
  );
}

function Tabs<T extends string>({
  id,
  value,
  options,
  onChange,
}: {
  id: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex gap-0.5 rounded-lg bg-inset p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "relative flex h-6 flex-1 items-center justify-center rounded-md text-[11.5px] transition-colors",
            value === o.value ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === o.value && (
            <motion.span
              layoutId={`ops-tab-${id}`}
              className="absolute inset-0 rounded-md bg-ov/[0.09] shadow-sm"
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
            />
          )}
          <span className="relative">{o.label}</span>
        </button>
      ))}
    </div>
  );
}

const dotCls = {
  ok: "bg-success",
  warn: "bg-warning",
  bad: "bg-destructive",
  off: "bg-muted-foreground/40",
} as const;

function Row({
  dot,
  title,
  detail,
  right,
  actions,
  menu,
  busy,
  mono,
}: {
  dot?: keyof typeof dotCls;
  title: React.ReactNode;
  detail?: React.ReactNode;
  right?: React.ReactNode;
  actions?: React.ReactNode;
  menu: React.ReactNode;
  busy?: boolean;
  mono?: boolean;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          className={cn(
            "group relative flex min-h-9 cursor-default items-center gap-2 rounded-md px-2 py-1 transition-colors duration-75 hover:bg-ov/[0.05] data-[state=open]:bg-ov/[0.06]",
            busy && "animate-pulse",
          )}
        >
          {dot && <span className={cn("size-2 shrink-0 rounded-full", dotCls[dot])} />}
          <div className="min-w-0 flex-1">
            <div className={cn("truncate text-[12.5px] text-foreground/90", mono && "font-mono text-[12px]")}>{title}</div>
            {detail && <div className="truncate text-[11px] text-muted-foreground">{detail}</div>}
          </div>
          {right && <div className="shrink-0 text-right text-[11px] text-muted-foreground group-hover:hidden">{right}</div>}
          {actions && <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">{actions}</div>}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  );
}

function Act({ tip, onClick, children, danger }: { tip: string; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <Tooltip content={tip}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        className={cn(
          "press flex size-6 items-center justify-center rounded text-muted-foreground [&_svg]:size-3.5",
          danger ? "hover:bg-destructive/15 hover:text-destructive" : "hover:bg-ov/10 hover:text-foreground",
        )}
      >
        {children}
      </button>
    </Tooltip>
  );
}

// ------------------------------------------------------------------ ports

interface Forwarded {
  local: number;
  remotePort: number;
  remoteHost: string;
}
/** Live SSH forwards made from this panel, per session id. */
const forwards = new Map<string, Forwarded[]>();

const wildcard = (a: string) => a === "*" || a === "0.0.0.0" || a === "::" || a === "[::]";

/** One listening socket, with its IPv4 and IPv6 bindings folded together. */
type PortRow = PortEntry & { addresses: string[] };

function mergeFamilies(entries: PortEntry[]): PortRow[] {
  const byKey = new Map<string, PortRow>();
  for (const e of entries) {
    const key = `${e.proto}|${e.port}|${e.pid ?? ""}|${e.process ?? ""}`;
    const row = byKey.get(key);
    if (!row) byKey.set(key, { ...e, addresses: [e.address] });
    else if (!row.addresses.includes(e.address)) {
      row.addresses.push(e.address);
      // Address used for copy / forward: prefer the IPv4 one.
      if (row.address.includes(":") && !e.address.includes(":")) row.address = e.address;
    }
  }
  return [...byKey.values()];
}

/** "all interfaces", or the addresses, with the IP families it covers. */
function bindLabel(addrs: string[]) {
  const v4 = addrs.some((a) => !a.includes(":") || a === "*");
  const v6 = addrs.some((a) => a.includes(":"));
  const fam = v4 && v6 ? "IPv4 + IPv6" : v6 ? "IPv6" : "IPv4";
  if (addrs.every(wildcard)) return `all interfaces · ${fam}`;
  return `${addrs.join(", ")}${v4 && v6 ? ` · ${fam}` : ""}`;
}

export function PortsPanel() {
  const { target, reason } = useTarget();
  const [query, setQuery] = useState("");
  const [proto, setProto] = useState<"all" | "tcp" | "udp">("tcp");
  const [, bump] = useState(0);
  const { data, error, loading, refresh } = usePoll(
    target?.key ?? null,
    () => ipc.portsList(target!.sessionId),
    5000,
  );
  const fw = target?.sessionId ? (forwards.get(target.sessionId) ?? []) : [];

  const q = query.trim().toLowerCase();
  const list = useMemo(
    () =>
      mergeFamilies(data ?? []).filter(
        (p) =>
          (proto === "all" || p.proto === proto) &&
          (!q || `${p.port} ${p.addresses.join(" ")} ${p.process ?? ""} ${p.pid ?? ""}`.toLowerCase().includes(q)),
      ),
    [data, proto, q],
  );

  const forward = async (p: PortEntry) => {
    if (!target?.sessionId) return;
    const host = wildcard(p.address) ? "127.0.0.1" : p.address;
    let local: number;
    try {
      local = await ipc.sshForwardAdd(target.sessionId, p.port, host, p.port);
    } catch {
      try {
        local = await ipc.sshForwardAdd(target.sessionId, 0, host, p.port); // port taken here: any free one
      } catch (e) {
        return fail("Couldn't forward the port", e);
      }
    }
    forwards.set(target.sessionId, [...fw.filter((f) => f.local !== local), { local, remotePort: p.port, remoteHost: host }]);
    bump((n) => n + 1);
    toast({
      kind: "success",
      title: tr("localhost:{0} → {1}:{2}", { 0: local, 1: target.label, 2: p.port }),
      action: { label: tr("Open"), run: () => void openUrl(`http://localhost:${local}`) },
    });
  };
  const unforward = async (f: Forwarded) => {
    if (!target?.sessionId) return;
    await ipc.sshForwardStop(target.sessionId, f.local).catch(() => {});
    forwards.set(target.sessionId, fw.filter((x) => x.local !== f.local));
    bump((n) => n + 1);
  };
  const kill = async (p: PortEntry) => {
    if (!target || !p.pid) return;
    const ok = await confirm({
      title: tr("End {0} ({1})?", { 0: p.process ?? "process", 1: p.pid }),
      message: tr("It's listening on {0} {1}{2}.", { 0: p.proto.toUpperCase(), 1: p.port, 2: target.sessionId ? ` on ${target.label}` : "" }),
      confirmLabel: tr("End process"),
      danger: true,
    });
    if (!ok) return;
    await ipc.processKill(target.sessionId, p.pid, false).then(refresh, (e) => fail("Couldn't end the process", e));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={tr("Ports")} icon={<Network />} target={target} loading={loading} onRefresh={refresh} />
      {!target ? (
        <Empty icon={<Network />} text={reason} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <SearchField value={query} onChange={setQuery} placeholder={tr("Port, address or process")} />
            <Tabs
              id="ports"
              value={proto}
              onChange={setProto}
              options={[
                { value: "tcp", label: tr("TCP") },
                { value: "udp", label: tr("UDP") },
                { value: "all", label: tr("All") },
              ]}
            />
          </div>
          {fw.length > 0 && (
            <div className="mx-2 mb-2 rounded-lg border border-primary/25 bg-primary/[0.06] p-1">
              <div className="px-1.5 pt-0.5 pb-1 text-[11px] font-medium text-primary">{tr("Forwarded to this computer")}</div>
              {fw.map((f) => (
                <Row
                  key={f.local}
                  mono
                  title={tr("localhost:{0}", { 0: f.local })}
                  detail={tr("→ {0}{1} on {2}", { 0: f.remoteHost === "127.0.0.1" ? "" : `${f.remoteHost}:`, 1: f.remotePort, 2: target.label })}
                  actions={
                    <>
                      <Act tip={tr("Open in browser")} onClick={() => void openUrl(`http://localhost:${f.local}`)}>
                        <Globe />
                      </Act>
                      <Act tip={tr("Stop forwarding")} onClick={() => void unforward(f)} danger>
                        <Unplug />
                      </Act>
                    </>
                  }
                  menu={
                    <>
                      <ContextMenuItem onSelect={() => void openUrl(`http://localhost:${f.local}`)}>
                        <Globe /> {tr("Open in browser")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => copy(`localhost:${f.local}`)}>
                        <ClipboardCopy /> {tr("Copy address")}
                      </ContextMenuItem>
                      <ContextMenuItem destructive onSelect={() => void unforward(f)}>
                        <Unplug /> {tr("Stop forwarding")}
                      </ContextMenuItem>
                    </>
                  }
                />
              ))}
            </div>
          )}
          {error && !data ? (
            <Empty error text={error} />
          ) : !data ? (
            <Empty icon={<Network className="animate-pulse" />} text={tr("Listing ports…")} />
          ) : !list.length ? (
            <Empty icon={<Network />} text={q ? tr("No matches") : tr("Nothing is listening")} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {list.map((p) => {
                const local = !target.sessionId;
                const web = p.proto === "tcp";
                return (
                  <Row
                    key={`${p.proto}${p.port}${p.pid ?? ""}${p.addresses.join()}`}
                    title={
                      <span className="flex items-baseline gap-2">
                        <span className="font-mono text-[12.5px] font-medium">{p.port}</span>
                        <span className="truncate text-foreground/80">{p.process ?? "—"}</span>
                      </span>
                    }
                    detail={`${p.proto.toUpperCase()} · ${bindLabel(p.addresses)}${p.pid ? ` · pid ${p.pid}` : ""}`}
                    actions={
                      <>
                        {web && local && (
                          <Act tip={tr("Open in browser")} onClick={() => void openUrl(`http://localhost:${p.port}`)}>
                            <Globe />
                          </Act>
                        )}
                        {web && !local && (
                          <Act tip={tr("Forward to this computer")} onClick={() => void forward(p)}>
                            <ArrowLeftRight />
                          </Act>
                        )}
                        {p.pid && (
                          <Act tip={tr("End process")} onClick={() => void kill(p)} danger>
                            <Skull />
                          </Act>
                        )}
                      </>
                    }
                    menu={
                      <>
                        {web && local && (
                          <ContextMenuItem onSelect={() => void openUrl(`http://localhost:${p.port}`)}>
                            <Globe /> {tr("Open in browser")}
                          </ContextMenuItem>
                        )}
                        {web && !local && (
                          <ContextMenuItem onSelect={() => void forward(p)}>
                            <ArrowLeftRight /> {tr("Forward to this computer")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem onSelect={() => copy(`${wildcard(p.address) ? "localhost" : p.address}:${p.port}`)}>
                          <ClipboardCopy /> {tr("Copy address")}
                        </ContextMenuItem>
                        {p.pid && (
                          <>
                            <ContextMenuSeparator />
                            <ContextMenuItem destructive onSelect={() => void kill(p)}>
                              <Skull /> {tr("End process")}
                            </ContextMenuItem>
                          </>
                        )}
                      </>
                    }
                  />
                );
              })}
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ containers

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
}

const SEP = "|~|";
const toolFor = new Map<string, "docker" | "podman">();

async function containerTool(t: Target) {
  const hit = toolFor.get(t.key);
  if (hit) return hit;
  for (const tool of ["docker", "podman"] as const) {
    const r = await ipc.opsRun(t.sessionId, tool, ["--version"]);
    if (r.code === 0) {
      toolFor.set(t.key, tool);
      return tool;
    }
  }
  throw new Error(`Neither docker nor podman is installed${t.sessionId ? " on this server" : ""}`);
}

const stateDot = (s: string): keyof typeof dotCls =>
  s === "running" ? "ok" : s === "paused" || s === "restarting" || s === "created" ? "warn" : s === "dead" ? "bad" : "off";

export function ContainersPanel() {
  const { target, reason } = useTarget();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [view, setView] = useState<"containers" | "images">("containers");
  const { data, error, loading, refresh } = usePoll(
    target?.key ?? null,
    async () => {
      const tool = await containerTool(target!);
      const out = await run(target!, tool, [
        "ps",
        "-a",
        "--format",
        ["{{.ID}}", "{{.Names}}", "{{.Image}}", "{{.State}}", "{{.Status}}", "{{.Ports}}"].join(SEP),
      ]);
      const list = out
        .split("\n")
        .filter((l) => l.includes(SEP))
        .map((l) => {
          const [id, name, image, state, status, ports] = l.split(SEP);
          return { id, name, image, state: state.toLowerCase(), status, ports } satisfies Container;
        })
        .sort((a, b) => Number(b.state === "running") - Number(a.state === "running") || a.name.localeCompare(b.name));
      return { tool, list };
    },
    5000,
  );

  const images = usePoll(
    view === "images" && target ? `${target.key}:images` : null,
    async () => {
      const tool = await containerTool(target!);
      const out = await run(target!, tool, [
        "images",
        "--format",
        ["{{.Repository}}", "{{.Tag}}", "{{.ID}}", "{{.Size}}", "{{.CreatedSince}}"].join(SEP),
      ]);
      return out
        .split("\n")
        .filter((l) => l.includes(SEP))
        .map((l) => {
          const [repo, tag, id, size, created] = l.split(SEP);
          return { repo, tag, id, size, created, ref: tag && tag !== "<none>" ? `${repo}:${tag}` : id };
        });
    },
    15000,
  );

  const q = query.trim().toLowerCase();
  const list = (data?.list ?? []).filter((c) => !q || `${c.name} ${c.image} ${c.id} ${c.ports}`.toLowerCase().includes(q));
  const imageList = (images.data ?? []).filter((i) => !q || `${i.repo} ${i.tag} ${i.id}`.toLowerCase().includes(q));

  /** Containers made from an image (by ref, bare repo = :latest, or image id). */
  const usersOf = (ref: string, id?: string) =>
    (data?.list ?? []).filter((c) => {
      const img = c.image;
      return img === ref || `${img}:latest` === ref || img === ref.replace(/:latest$/, "") || (!!id && id.startsWith(img));
    });
  const runFrom = (image: string, from?: string, imageId?: string) => {
    if (!target) return;
    openRunDialog({
      image,
      tool: data?.tool ?? "docker",
      earlier: usersOf(image, imageId).map((c) => ({ id: c.id, name: c.name })),
      from,
      exec: (args) => run(target, data?.tool ?? "docker", args),
      onDone: () => refresh(),
    });
  };
  const removeImage = async (i: { ref: string; id: string }) => {
    if (!target) return;
    const n = usersOf(i.ref, i.id).length;
    const ok = await confirm({
      title: tr("Remove image “{0}”?", { 0: i.ref }),
      message: n ? tr(n > 1 ? "{0} containers use it — removal fails while they exist." : "{0} container uses it — removal fails while it exists.", { 0: n }) : tr("It can be pulled again later."),
      confirmLabel: tr("Remove"),
      danger: true,
    });
    if (!ok) return;
    try {
      await run(target, data?.tool ?? "docker", ["rmi", i.ref]);
      images.refresh();
    } catch (e) {
      fail(`Couldn't remove ${i.ref}`, e);
    }
  };
  const tool = data?.tool ?? "docker";
  const running = (data?.list ?? []).filter((c) => c.state === "running").length;

  const act = async (c: Container, verb: "start" | "stop" | "restart" | "rm", label: string) => {
    if (!target) return;
    if (verb === "rm") {
      const ok = await confirm({
        title: tr("Remove container “{0}”?", { 0: c.name }),
        message: c.state === "running" ? tr("It's running — it will be stopped and removed.") : tr("Its filesystem changes are lost."),
        confirmLabel: tr("Remove"),
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(c.id);
    try {
      await run(target, tool, verb === "rm" ? ["rm", "-f", c.id] : [verb, c.id]);
      refresh();
    } catch (e) {
      fail(`Couldn't ${label} ${c.name}`, e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={tr("Containers")}
        icon={<Boxes />}
        target={target}
        loading={view === "images" ? images.loading : loading}
        onRefresh={view === "images" ? images.refresh : refresh}
      />
      <RunContainerDialog />
      {!target ? (
        <Empty icon={<Boxes />} text={reason} />
      ) : error && !data ? (
        <Empty error text={error} />
      ) : !data ? (
        <Empty icon={<Boxes className="animate-pulse" />} text={tr("Asking docker…")} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-1.5">
            <Tabs
              id="containers"
              value={view}
              onChange={setView}
              options={[
                { value: "containers", label: tr("Containers ({0}/{1})", { 0: running, 1: data.list.length }) },
                { value: "images", label: images.data ? tr("Images ({0})", { 0: images.data.length }) : tr("Images") },
              ]}
            />
            <SearchField value={query} onChange={setQuery} placeholder={view === "images" ? tr("Repository, tag or ID") : tr("Name, image or port")} />
          </div>
          {view === "images" ? (
            images.error && !images.data ? (
              <Empty error text={images.error} />
            ) : !images.data ? (
              <Empty icon={<Layers className="animate-pulse" />} text={tr("Listing images…")} />
            ) : !imageList.length ? (
              <Empty icon={<Layers />} text={q ? tr("No matches") : tr("No images")} />
            ) : (
              <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
                {imageList.map((i) => {
                  const n = usersOf(i.ref, i.id).length;
                  return (
                    <Row
                      key={i.id + i.ref}
                      title={i.ref}
                      detail={`${i.id.slice(0, 12)} · ${i.size} · ${i.created}${n ? ` · ${n} container${n > 1 ? "s" : ""}` : ""}`}
                      actions={
                        <Act tip={tr("Run a container…")} onClick={() => runFrom(i.ref, undefined, i.id)}>
                          <Play />
                        </Act>
                      }
                      menu={
                        <>
                          <ContextMenuItem onSelect={() => typeInto(`${tool} image inspect ${i.ref}`)}>
                            <FileText /> {tr("Inspect")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => typeInto(`${tool} history ${i.ref}`)}>
                            <FileText /> {tr("Layer history")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => copy(i.ref)}>
                            <ClipboardCopy /> {tr("Copy name")}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem onSelect={() => runFrom(i.ref, undefined, i.id)}>
                            <Play /> {tr("Run a container…")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => typeInto(`${tool} pull ${i.ref}`)}>
                            <RotateCw /> {tr("Pull again")}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem destructive onSelect={() => void removeImage(i)}>
                            <Trash2 /> {tr("Remove image")}
                          </ContextMenuItem>
                        </>
                      }
                    />
                  );
                })}
              </ScrollArea>
            )
          ) : !list.length ? (
            <Empty icon={<Boxes />} text={q ? tr("No matches") : tr("No containers")} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {list.map((c) => {
                const up = c.state === "running";
                return (
                  <Row
                    key={c.id}
                    dot={stateDot(c.state)}
                    busy={busy === c.id}
                    title={c.name}
                    detail={c.ports ? `${c.image} · ${c.ports}` : c.image}
                    right={c.status.replace(/ \(.*\)$/, "")}
                    actions={
                      <>
                        {up ? (
                          <>
                            <Act tip={tr("Follow logs in terminal")} onClick={() => typeInto(`${tool} logs -f --tail 200 ${c.name}`)}>
                              <FileText />
                            </Act>
                            <Act tip={tr("Open a shell in terminal")} onClick={() => typeInto(`${tool} exec -it ${c.name} sh`)}>
                              <SquareTerminal />
                            </Act>
                            <Act tip={tr("Stop")} onClick={() => void act(c, "stop", "stop")}>
                              <Square />
                            </Act>
                          </>
                        ) : (
                          <Act tip={tr("Start")} onClick={() => void act(c, "start", "start")}>
                            <Play />
                          </Act>
                        )}
                      </>
                    }
                    menu={
                      <>
                        {/* Looking first; anything that changes the container last. */}
                        {up ? (
                          <>
                            <ContextMenuItem onSelect={() => typeInto(`${tool} logs -f --tail 200 ${c.name}`)}>
                              <FileText /> {tr("Follow logs")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => typeInto(`${tool} exec -it ${c.name} sh`)}>
                              <SquareTerminal /> {tr("Open shell")}
                            </ContextMenuItem>
                          </>
                        ) : (
                          <ContextMenuItem onSelect={() => typeInto(`${tool} logs --tail 200 ${c.name}`)}>
                            <FileText /> {tr("Show logs")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem onSelect={() => typeInto(`${tool} inspect ${c.name}`)}>
                          <FileText /> {tr("Inspect")}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => copy(c.id)}>
                          <ClipboardCopy /> {tr("Copy ID")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => runFrom(c.image, c.id)}>
                          <Copy /> {tr("Run a copy…")}
                        </ContextMenuItem>
                        {up ? (
                          <>
                            <ContextMenuItem onSelect={() => void act(c, "restart", "restart")}>
                              <RotateCw /> {tr("Restart")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => void act(c, "stop", "stop")}>
                              <Square /> {tr("Stop")}
                            </ContextMenuItem>
                          </>
                        ) : (
                          <ContextMenuItem onSelect={() => void act(c, "start", "start")}>
                            <Play /> {tr("Start")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        <ContextMenuItem destructive onSelect={() => void act(c, "rm", "remove")}>
                          <Trash2 /> {tr("Remove")}
                        </ContextMenuItem>
                      </>
                    }
                  />
                );
              })}
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ kubernetes

type Kind = "pods" | "deployments" | "services";
const ALL_NS = "*all*";
/** Chosen namespace per machine (kept while the app runs). */
const nsChoice = new Map<string, string>();

// biome-ignore lint/suspicious/noExplicitAny: kubectl JSON
type K = any;

function podInfo(p: K) {
  const cs: K[] = p.status?.containerStatuses ?? [];
  const ready = cs.filter((c) => c.ready).length;
  const restarts = cs.reduce((n, c) => n + (c.restartCount ?? 0), 0);
  const waiting = cs.map((c) => c.state?.waiting?.reason ?? c.state?.terminated?.reason).find(Boolean);
  const phase: string = p.metadata?.deletionTimestamp ? "Terminating" : (waiting ?? p.status?.phase ?? "Unknown");
  const dot: keyof typeof dotCls =
    phase === "Running" && ready === cs.length
      ? "ok"
      : phase === "Succeeded" || phase === "Completed"
        ? "off"
        : /Err|BackOff|Failed|OOM|Unknown/.test(phase)
          ? "bad"
          : "warn";
  return { name: p.metadata.name as string, ns: p.metadata.namespace as string, phase, ready, total: cs.length, restarts, age: age(p.metadata.creationTimestamp), node: p.spec?.nodeName as string | undefined, dot };
}

export function K8sPanel() {
  const { target, reason } = useTarget();
  const [kind, setKind] = useState<Kind>("pods");
  const [query, setQuery] = useState("");
  const [nsState, setNs] = useState<string | null>(null);
  const ns = nsState ?? (target ? (nsChoice.get(target.key) ?? null) : null);

  const meta = usePoll(
    target ? `meta:${target.key}` : null,
    async () => {
      const ctx = (await run(target!, "kubectl", ["config", "current-context"])).trim();
      const nsOut = await run(target!, "kubectl", ["get", "ns", "-o", "jsonpath={.items[*].metadata.name}", "--request-timeout=8s"]).catch(() => "");
      const cur = (await run(target!, "kubectl", ["config", "view", "--minify", "-o", "jsonpath={..namespace}"]).catch(() => "")).trim();
      return { ctx, namespaces: nsOut.split(/\s+/).filter(Boolean), current: cur || "default" };
    },
    30000,
  );
  const namespace = ns ?? meta.data?.current ?? "default";
  const nsArgs = namespace === ALL_NS ? ["-A"] : ["-n", namespace];

  const list = usePoll(
    target && meta.data ? `${target.key}:${kind}:${namespace}` : null,
    async () => JSON.parse(await run(target!, "kubectl", ["get", kind, ...nsArgs, "-o", "json", "--request-timeout=10s"])).items as K[],
    6000,
  );

  const pickNs = (v: string) => {
    if (target) nsChoice.set(target.key, v);
    setNs(v);
  };
  const nsFlag = (itemNs: string) => `-n ${itemNs}`;
  const q = query.trim().toLowerCase();
  const items = (list.data ?? []).filter((i) => !q || JSON.stringify(i.metadata?.name ?? "").toLowerCase().includes(q));
  const showNs = namespace === ALL_NS;

  const kubectl = async (args: string[], what: string) => {
    if (!target) return;
    try {
      await run(target, "kubectl", args);
      toast({ kind: "success", title: what });
      list.refresh();
    } catch (e) {
      fail(`Couldn't ${what.toLowerCase()}`, e);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        title={tr("Kubernetes")}
        icon={<Ship />}
        target={target}
        loading={meta.loading || list.loading}
        onRefresh={() => {
          meta.refresh();
          list.refresh();
        }}
      />
      {!target ? (
        <Empty icon={<Ship />} text={reason} />
      ) : meta.error && !meta.data ? (
        <Empty error text={meta.error} />
      ) : !meta.data ? (
        <Empty icon={<Ship className="animate-pulse" />} text={tr("Asking kubectl…")} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <div className="flex items-center gap-1.5">
              <Tooltip content={tr("Context: {0}", { 0: meta.data.ctx })}>
                <span className="min-w-0 flex-1 truncate rounded-md bg-ov/[0.05] px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {meta.data.ctx}
                </span>
              </Tooltip>
              <Select
                size="sm"
                className="w-36"
                value={namespace}
                onChange={pickNs}
                options={[
                  { value: ALL_NS, label: tr("All namespaces") },
                  ...[...new Set([...meta.data.namespaces, namespace])]
                    .filter((n) => n !== ALL_NS)
                    .map((n) => ({ value: n, label: n })),
                ]}
              />
            </div>
            <Tabs
              id="k8s"
              value={kind}
              onChange={setKind}
              options={[
                { value: "pods", label: tr("Pods") },
                { value: "deployments", label: tr("Deployments") },
                { value: "services", label: tr("Services") },
              ]}
            />
            <SearchField value={query} onChange={setQuery} placeholder={tr("Filter {0}", { 0: kind })} />
          </div>
          {list.error && !list.data ? (
            <Empty error text={list.error} />
          ) : !list.data ? (
            <Empty icon={<Ship className="animate-pulse" />} text={tr("Loading {0}…", { 0: kind })} />
          ) : !items.length ? (
            <Empty icon={<Ship />} text={q ? tr("No matches") : tr("No {0} in {1}", { 0: kind, 1: showNs ? tr("any namespace") : namespace })} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {kind === "pods" &&
                items.map((raw) => {
                  const p = podInfo(raw);
                  const logs = `kubectl logs -f --tail=200 ${nsFlag(p.ns)} ${p.name}`;
                  const shell = `kubectl exec -it ${nsFlag(p.ns)} ${p.name} -- sh`;
                  return (
                    <Row
                      key={`${p.ns}/${p.name}`}
                      dot={p.dot}
                      title={p.name}
                      detail={[`${p.ready}/${p.total} ready`, p.phase !== "Running" && p.phase, p.restarts > 0 && `${p.restarts} restarts`, showNs && p.ns]
                        .filter(Boolean)
                        .join(" · ")}
                      right={p.age}
                      actions={
                        <>
                          <Act tip={tr("Follow logs in terminal")} onClick={() => typeInto(logs)}>
                            <FileText />
                          </Act>
                          <Act tip={tr("Open a shell in terminal")} onClick={() => typeInto(shell)}>
                            <SquareTerminal />
                          </Act>
                        </>
                      }
                      menu={
                        <>
                          <ContextMenuItem onSelect={() => typeInto(logs)}>
                            <FileText /> {tr("Follow logs")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => typeInto(shell)}>
                            <SquareTerminal /> {tr("Open shell")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => typeInto(`kubectl describe pod ${nsFlag(p.ns)} ${p.name}`)}>
                            <FileText /> {tr("Describe")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => copy(p.name)}>
                            <ClipboardCopy /> {tr("Copy name")}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            destructive
                            onSelect={async () => {
                              const ok = await confirm({
                                title: tr("Delete pod “{0}”?", { 0: p.name }),
                                message: tr("If a controller manages it, a replacement is created."),
                                confirmLabel: tr("Delete"),
                                danger: true,
                              });
                              if (ok) void kubectl(["delete", "pod", "-n", p.ns, p.name, "--wait=false"], `Deleted ${p.name}`);
                            }}
                          >
                            <Trash2 /> {tr("Delete")}
                          </ContextMenuItem>
                        </>
                      }
                    />
                  );
                })}
              {kind === "deployments" &&
                items.map((d) => {
                  const name: string = d.metadata.name;
                  const dns: string = d.metadata.namespace;
                  const want = d.spec?.replicas ?? 0;
                  const ready = d.status?.readyReplicas ?? 0;
                  return (
                    <Row
                      key={`${dns}/${name}`}
                      dot={want === 0 ? "off" : ready === want ? "ok" : ready === 0 ? "bad" : "warn"}
                      title={name}
                      detail={[`${ready}/${want} ready`, `${d.status?.updatedReplicas ?? 0} up to date`, showNs && dns].filter(Boolean).join(" · ")}
                      right={age(d.metadata.creationTimestamp)}
                      actions={
                        <Act
                          tip={tr("Restart (rollout)")}
                          onClick={() => void kubectl(["rollout", "restart", "deployment", "-n", dns, name], `Restarting ${name}`)}
                        >
                          <RotateCw />
                        </Act>
                      }
                      menu={
                        <>
                          <ContextMenuItem onSelect={() => typeInto(`kubectl rollout status deployment ${nsFlag(dns)} ${name}`)}>
                            <FileText /> {tr("Rollout status")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => typeInto(`kubectl describe deployment ${nsFlag(dns)} ${name}`)}>
                            <FileText /> {tr("Describe")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => copy(name)}>
                            <ClipboardCopy /> {tr("Copy name")}
                          </ContextMenuItem>
                          <ContextMenuSeparator />
                          <ContextMenuItem
                            onSelect={async () => {
                              const ok = await confirm({
                                title: tr("Restart “{0}”?", { 0: name }),
                                message: tr("Pods are replaced one by one (kubectl rollout restart)."),
                                confirmLabel: tr("Restart"),
                              });
                              if (ok) void kubectl(["rollout", "restart", "deployment", "-n", dns, name], `Restarting ${name}`);
                            }}
                          >
                            <RotateCw /> {tr("Rollout restart")}
                          </ContextMenuItem>
                          <ContextMenuItem
                            onSelect={async () => {
                              const v = await prompt({
                                title: tr("Scale “{0}”", { 0: name }),
                                message: tr("Number of replicas"),
                                value: String(want),
                                confirmLabel: tr("Scale"),
                                validate: (x) => (/^\d+$/.test(x.trim()) && Number(x) <= 500 ? null : tr("Enter a number from 0 to 500")),
                              });
                              if (v !== null)
                                void kubectl(["scale", "deployment", "-n", dns, name, `--replicas=${v.trim()}`], `Scaled ${name} to ${v.trim()}`);
                            }}
                          >
                            <Scaling /> {tr("Scale…")}
                          </ContextMenuItem>
                        </>
                      }
                    />
                  );
                })}
              {kind === "services" &&
                items.map((s) => {
                  const name: string = s.metadata.name;
                  const sns: string = s.metadata.namespace;
                  const ports = ((s.spec?.ports ?? []) as K[])
                    .map((p) => `${p.port}${p.nodePort ? `:${p.nodePort}` : ""}/${p.protocol ?? "TCP"}`)
                    .join(", ");
                  return (
                    <Row
                      key={`${sns}/${name}`}
                      title={name}
                      detail={[s.spec?.type, s.spec?.clusterIP, ports, showNs && sns].filter(Boolean).join(" · ")}
                      right={age(s.metadata.creationTimestamp)}
                      menu={
                        <>
                          <ContextMenuItem onSelect={() => typeInto(`kubectl describe service ${nsFlag(sns)} ${name}`)}>
                            <FileText /> {tr("Describe")}
                          </ContextMenuItem>
                          <ContextMenuItem onSelect={() => copy(`${name}.${sns}.svc`)}>
                            <ClipboardCopy /> {tr("Copy DNS name")}
                          </ContextMenuItem>
                          {s.spec?.clusterIP && s.spec.clusterIP !== "None" && (
                            <ContextMenuItem onSelect={() => copy(s.spec.clusterIP)}>
                              <ClipboardCopy /> {tr("Copy cluster IP")}
                            </ContextMenuItem>
                          )}
                        </>
                      }
                    />
                  );
                })}
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}
