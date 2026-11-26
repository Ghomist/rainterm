// Server panels for the active terminal's Linux machine: services (systemd), logs
// (journal / files), network connections + firewall, and scheduled tasks (cron, timers).
// Everything here only reads; changes are typed into the terminal, where you see them
// and sudo can ask for its password.
import {
  CalendarClock,
  ClipboardCopy,
  Cog,
  ExternalLink,
  FileText,
  Pause,
  Pencil,
  Play,
  Power,
  PowerOff,
  RotateCw,
  ScrollText,
  Shield,
  Skull,
  Square,
  SquareTerminal,
  WrapText,
} from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { create } from "zustand";
import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { ComboInput, Select } from "@/components/ui/controls";
import { SearchField } from "@/components/ui/panel";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { atPrompt } from "@/lib/agent/terminal";
import { tr } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { confirm, toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { isTermPane, useApp } from "@/store/app";
import { Act, copy, Empty, fail, Header, Row, Tabs, type Target, usePoll, useTarget } from "./OpsPanels";

// ------------------------------------------------------------------ shared

type Query =
  | { kind: "services" }
  | { kind: "service"; unit: string }
  | { kind: "journal"; unit: string | null; lines: number; priority: number | null }
  | { kind: "log_file"; path: string; lines: number }
  | { kind: "log_files" }
  | { kind: "connections" }
  | { kind: "firewall" }
  | { kind: "cron" };

const query = (t: Target, q: Query) => ipc.opsQuery(t.sessionId, q);

/** Logs panel source, settable from the other panels ("View logs"). */
export const useLogSource = create<{ mode: "journal" | "file"; unit: string; path: string }>(() => ({
  mode: "journal",
  unit: "",
  path: "",
}));

function openLogs(src: Partial<{ mode: "journal" | "file"; unit: string; path: string }>) {
  useLogSource.setState(src);
  useApp.getState().toggleView("logs", true);
}

/** The SSH login is root: no sudo needed. */
function isRoot() {
  const st = useApp.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const pane = tab ? st.panes[tab.activePane] : undefined;
  return isTermPane(pane) && pane.session.source.kind === "ssh" && pane.session.source.target.user === "root";
}
const sudo = (cmd: string) => (isRoot() ? cmd : `sudo ${cmd}`);

/** Type a command into the active terminal (the panel's machine) and run it, visibly. */
function runInTerminal(cmd: string, enter = true) {
  const st = useApp.getState();
  const tab = st.tabs.find((t) => t.id === st.activeTabId);
  const pane = tab ? st.panes[tab.activePane] : undefined;
  if (!isTermPane(pane) || !pane.session.alive) return toast({ kind: "info", title: tr("No connected terminal") }), false;
  if (!atPrompt(pane.session)) {
    toast({ kind: "info", title: tr("The terminal is busy"), description: tr("Wait for the running command to finish, then try again.") });
    return false;
  }
  pane.session.input(enter ? `${cmd}\r` : cmd, true);
  pane.session.focus();
  return true;
}

const lines = (s: string) => s.split("\n").map((l) => l.trimEnd()).filter(Boolean);

/** Errors a read-only query returns as text: no systemd, no permission… */
function problem(out: string): string | null {
  if (/System has not been booted with systemd|Failed to connect to bus|systemctl: command not found|not found$/m.test(out))
    return tr("This machine doesn't use systemd");
  return null;
}

// ------------------------------------------------------------------ services

interface Service {
  name: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string;
}

function parseServices(out: string): Service[] {
  const [units, files = ""] = out.split("#files");
  const enabled = new Map<string, string>();
  for (const l of lines(files)) {
    const [name, state] = l.split(/\s+/);
    if (name?.endsWith(".service")) enabled.set(name, state ?? "");
  }
  const list = new Map<string, Service>();
  for (const l of lines(units)) {
    const m = l.replace(/^[●*]\s*/, "").match(/^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
    if (!m) continue;
    list.set(m[1], { name: m[1], load: m[2], active: m[3], sub: m[4], description: m[5], enabled: enabled.get(m[1]) ?? "" });
  }
  // installed but never loaded (disabled, not started since boot)
  for (const [name, state] of enabled)
    if (!list.has(name) && !name.includes("@"))
      list.set(name, { name, load: "loaded", active: "inactive", sub: "dead", description: "", enabled: state });
  return [...list.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const svcDot = (s: Service) =>
  s.active === "active" ? "ok" : s.active === "failed" ? "bad" : s.active === "activating" || s.active === "reloading" || s.active === "deactivating" ? "warn" : "off";

const short = (unit: string) => unit.replace(/\.service$/, "");

export function ServicesPanel() {
  const { target, reason } = useTarget();
  const [query_, setQuery] = useState("");
  const [show, setShow] = useState<"running" | "failed" | "all">("running");
  const [open, setOpen] = useState<string | null>(null);
  const { data, error, loading, refresh } = usePoll(target?.key ?? null, () => query(target!, { kind: "services" }), 10000);
  const bad = data ? problem(data) : null;
  const all = useMemo(() => (data && !bad ? parseServices(data) : []), [data, bad]);
  const q = query_.trim().toLowerCase();
  const list = all.filter(
    (s) =>
      (show === "all" || (show === "failed" ? s.active === "failed" : s.active === "active" || s.active === "activating")) &&
      (!q || `${s.name} ${s.description}`.toLowerCase().includes(q)),
  );
  const failed = all.filter((s) => s.active === "failed").length;

  const win = !!target?.windows;
  const act = async (s: Service, verb: string, danger = false) => {
    if (danger) {
      const ok = await confirm({
        title: tr("{0} {1}?", { 0: tr(verb[0].toUpperCase() + verb.slice(1)), 1: short(s.name) }),
        message: win ? tr("Windows will ask for administrator rights.") : tr("Runs `{0}` in the terminal.", { 0: sudo(`systemctl ${verb} ${s.name}`) }),
        confirmLabel: tr(verb[0].toUpperCase() + verb.slice(1)),
        danger: true,
      });
      if (!ok) return;
    }
    if (win) {
      // Windows services change through an administrator (UAC), not a terminal
      const name = short(s.name).replace(/_/g, " ");
      try {
        await ipc.winAdmin("service", verb, name);
        toast({ kind: "success", title: tr("Done: {0} {1}", { 0: tr(verb[0].toUpperCase() + verb.slice(1)), 1: name }), duration: 2000 });
      } catch (e) {
        fail(tr("Couldn't change {0}", { 0: name }), e);
      }
      return refresh();
    }
    if (runInTerminal(sudo(`systemctl ${verb} ${s.name}`))) setTimeout(refresh, 2500);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={tr("System services")} icon={<Cog />} target={target} loading={loading} onRefresh={refresh} />
      {!target ? (
        <Empty icon={<Cog />} text={reason} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <SearchField value={query_} onChange={setQuery} placeholder={tr("Service name or description")} />
            {win && <WinToolLink tool="services.msc" label={tr("Open Windows Services")} />}
            <Tabs
              id="services"
              value={show}
              onChange={setShow}
              options={[
                { value: "running", label: tr("Running") },
                { value: "failed", label: failed ? tr("Failed · {0}", { 0: failed }) : tr("Failed") },
                { value: "all", label: tr("All") },
              ]}
            />
          </div>
          {error && !data ? (
            <Empty error text={error} />
          ) : bad ? (
            <Empty error text={bad} />
          ) : !data ? (
            <Empty icon={<Cog className="animate-pulse" />} text={tr("Listing services…")} />
          ) : !list.length ? (
            <Empty icon={<Cog />} text={q ? tr("No matches") : show === "failed" ? tr("No failed services") : tr("No services")} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {list.map((s) => {
                const running = s.active === "active";
                return (
                  <div key={s.name}>
                    <div onClick={() => setOpen(open === s.name ? null : s.name)}>
                      <Row
                        dot={svcDot(s)}
                        title={short(s.name)}
                        detail={[s.description, s.active === "active" ? s.sub : s.active, s.enabled].filter(Boolean).join(" · ")}
                        right={s.enabled === "enabled" ? tr("on boot") : undefined}
                        actions={
                          <>
                            <Act tip={tr("Logs")} onClick={() => openLogs({ mode: "journal", unit: s.name })}>
                              <ScrollText />
                            </Act>
                            <Act tip={tr("Restart")} onClick={() => void act(s, "restart", running)}>
                              <RotateCw />
                            </Act>
                            {running ? (
                              <Act tip={tr("Stop")} onClick={() => void act(s, "stop", true)} danger>
                                <Square />
                              </Act>
                            ) : (
                              <Act tip={tr("Start")} onClick={() => void act(s, "start")}>
                                <Play />
                              </Act>
                            )}
                          </>
                        }
                        menu={
                          <>
                            <ContextMenuItem onSelect={() => void act(s, "start")}>
                              <Play /> {tr("Start")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => void act(s, "restart", running)}>
                              <RotateCw /> {tr("Restart")}
                            </ContextMenuItem>
                            {!win && (
                              <ContextMenuItem onSelect={() => void act(s, "reload")}>
                                <RotateCw /> {tr("Reload config")}
                              </ContextMenuItem>
                            )}
                            <ContextMenuItem destructive onSelect={() => void act(s, "stop", true)}>
                              <Square /> {tr("Stop")}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            {s.enabled === "enabled" ? (
                              <ContextMenuItem onSelect={() => void act(s, "disable", true)}>
                                <PowerOff /> {tr("Don't start on boot")}
                              </ContextMenuItem>
                            ) : (
                              <ContextMenuItem onSelect={() => void act(s, "enable")}>
                                <Power /> {tr("Start on boot")}
                              </ContextMenuItem>
                            )}
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => openLogs({ mode: "journal", unit: s.name })}>
                              <ScrollText /> {tr("Logs")}
                            </ContextMenuItem>
                            {win ? (
                              <ContextMenuItem onSelect={() => void ipc.winOpen("services.msc")}>
                                <ExternalLink /> {tr("Open Windows Services")}
                              </ContextMenuItem>
                            ) : (
                              <>
                                <ContextMenuItem onSelect={() => runInTerminal(`systemctl status ${s.name} --no-pager`)}>
                                  <SquareTerminal /> {tr("Status in the terminal")}
                                </ContextMenuItem>
                                <ContextMenuItem onSelect={() => runInTerminal(sudo(`systemctl edit ${s.name}`))}>
                                  <Pencil /> {tr("Override settings (systemctl edit)")}
                                </ContextMenuItem>
                              </>
                            )}
                            <ContextMenuItem onSelect={() => copy(s.name)}>
                              <ClipboardCopy /> {tr("Copy name")}
                            </ContextMenuItem>
                          </>
                        }
                      />
                    </div>
                    {open === s.name && <ServiceDetail target={target} unit={s.name} />}
                  </div>
                );
              })}
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

function bytes(n: number) {
  if (!Number.isFinite(n) || n <= 0) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) (n /= 1024), i++;
  return `${n.toFixed(n < 10 && i ? 1 : 0)} ${u[i]}`;
}

function ServiceDetail({ target, unit }: { target: Target; unit: string }) {
  const { data } = usePoll(`${target.key}:${unit}`, () => query(target, { kind: "service", unit }), 5000);
  const kv = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lines(data ?? "")) {
      const i = l.indexOf("=");
      if (i > 0) m.set(l.slice(0, i), l.slice(i + 1));
    }
    return m;
  }, [data]);
  const facts: [string, string][] = [
    [tr("Process"), kv.get("MainPID") && kv.get("MainPID") !== "0" ? `pid ${kv.get("MainPID")}` : ""],
    [tr("Memory"), bytes(Number(kv.get("MemoryCurrent")))],
    [tr("Tasks"), /^\d+$/.test(kv.get("TasksCurrent") ?? "") ? String(kv.get("TasksCurrent")) : ""],
    [tr("Since"), kv.get("ActiveEnterTimestamp") ?? ""],
    [tr("Restarts"), kv.get("NRestarts") && kv.get("NRestarts") !== "0" ? `${kv.get("NRestarts")} (${kv.get("Restart")})` : ""],
    [tr("Last result"), kv.get("Result") && kv.get("Result") !== "success" ? String(kv.get("Result")) : ""],
    [tr("Unit file"), kv.get("FragmentPath") ?? ""],
  ];
  return (
    <div className="mx-2 mb-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 rounded-md bg-inset/70 px-2.5 py-2 text-[11.5px]">
      {!data ? (
        <span className="col-span-2 text-muted-foreground">{tr("Loading…")}</span>
      ) : (
        facts
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <span className="text-muted-foreground">{k}</span>
              <span className="min-w-0 truncate font-mono text-[11px] text-foreground/85" title={v}>
                {v}
              </span>
            </div>
          ))
      )}
    </div>
  );
}

// ------------------------------------------------------------------ logs

const LEVEL = [
  { re: /\b(emerg|alert|crit(ical)?|fatal|panic|error|err|failed|failure|exception|traceback|denied|refused|segfault)\b/i, cls: "text-destructive" },
  { re: /\b(warn(ing)?|timeout|timed out|retry|deprecated)\b/i, cls: "text-warning" },
];

export function LogsPanel() {
  const { target, reason } = useTarget();
  const src = useLogSource();
  const [unitDraft, setUnitDraft] = useState(src.unit);
  const [pathDraft, setPathDraft] = useState(src.path);
  useEffect(() => setUnitDraft(src.unit), [src.unit]);
  useEffect(() => setPathDraft(src.path), [src.path]);
  const [priority, setPriority] = useState<number | null>(null);
  const [count, setCount] = useState(300);
  const [follow, setFollow] = useState(true);
  const [wrap, setWrap] = useState(false);
  const [filter, setFilter] = useState("");

  const q: Query | null = !target
    ? null
    : src.mode === "journal"
      ? { kind: "journal", unit: src.unit.trim() || null, lines: count, priority }
      : src.path.trim()
        ? { kind: "log_file", path: src.path.trim(), lines: count }
        : null;
  const key = target && q ? `${target.key}:${JSON.stringify(q)}:${follow}` : null;
  const { data, error, loading, refresh } = usePoll(key, () => query(target!, q!), follow ? 2500 : 3_600_000);
  const files = usePoll(target && src.mode === "file" ? `${target.key}:files` : null, () => query(target!, { kind: "log_files" }), 120_000);
  const units = usePoll(target && src.mode === "journal" ? `${target.key}:units` : null, () => query(target!, { kind: "services" }), 120_000);
  const unitOptions = useMemo(
    () => (units.data && !problem(units.data) ? parseServices(units.data).filter((s) => s.active !== "inactive").map((s) => ({ value: s.name, label: short(s.name) })) : []),
    [units.data],
  );

  const f = filter.trim().toLowerCase();
  const shown = useMemo(() => {
    const all = (data ?? "").split(/\r?\n/);
    if (all.at(-1) === "") all.pop();
    return f ? all.filter((l) => l.toLowerCase().includes(f)) : all;
  }, [data, f]);

  // Follow: stay pinned to the bottom unless you scrolled up.
  const viewport = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const el = viewport.current;
    if (el && follow && pinned.current) el.scrollTop = el.scrollHeight;
  }, [shown, follow]);

  const needsRoot = /no journal files were found|insufficient permissions|Permission denied/i.test(data ?? "");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={tr("Logs")} icon={<ScrollText />} target={target} loading={loading} onRefresh={refresh} />
      {!target ? (
        <Empty icon={<ScrollText />} text={reason} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <Tabs
              id="logs"
              value={src.mode}
              onChange={(mode) => useLogSource.setState({ mode })}
              options={[
                { value: "journal", label: target.windows ? tr("Event log") : tr("System journal") },
                { value: "file", label: tr("Log file") },
              ]}
            />
            {src.mode === "journal" ? (
              <div className="grid grid-cols-[1fr_108px] gap-1.5">
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    useLogSource.setState({ unit: unitDraft.trim() });
                  }}
                  onBlur={() => unitDraft.trim() !== src.unit && useLogSource.setState({ unit: unitDraft.trim() })}
                >
                  <ComboInput
                    value={unitDraft}
                    onChange={(v) => {
                      setUnitDraft(v);
                      if (unitOptions.some((o) => o.value === v)) useLogSource.setState({ unit: v });
                    }}
                    options={unitOptions}
                    placeholder={target.windows ? tr("All sources (or a service / source name)") : tr("All services (or a unit name)")}
                  />
                </form>
                <Select
                  size="sm"
                  value={priority}
                  onChange={setPriority}
                  options={[
                    { value: null, label: tr("All levels") },
                    { value: 4, label: tr("Warnings +") },
                    { value: 3, label: tr("Errors") },
                  ]}
                />
              </div>
            ) : (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  useLogSource.setState({ path: pathDraft.trim() });
                }}
                onBlur={() => pathDraft.trim() !== src.path && useLogSource.setState({ path: pathDraft.trim() })}
              >
                <ComboInput
                  value={pathDraft}
                  onChange={(v) => {
                    setPathDraft(v);
                    if ((files.data ?? "").split("\n").includes(v)) useLogSource.setState({ path: v });
                  }}
                  options={lines(files.data ?? "").map((p) => ({ value: p, label: p }))}
                  placeholder={tr("/var/log/… (Enter to open)")}
                />
              </form>
            )}
            <div className="flex items-center gap-1">
              <SearchField value={filter} onChange={setFilter} placeholder={tr("Filter lines")} className="flex-1" />
              <Select
                size="sm"
                className="w-[92px]"
                value={count}
                onChange={setCount}
                options={[100, 300, 1000, 3000].map((n) => ({ value: n, label: tr("{0} lines", { 0: n }) }))}
              />
              <Tooltip content={follow ? tr("Following new lines (click to pause)") : tr("Paused (click to follow)")}>
                <button
                  type="button"
                  onClick={() => setFollow(!follow)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
                    follow ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-ov/[0.06]",
                  )}
                >
                  {follow ? <Pause /> : <Play />}
                </button>
              </Tooltip>
              <Tooltip content={tr("Wrap long lines")}>
                <button
                  type="button"
                  onClick={() => setWrap(!wrap)}
                  className={cn(
                    "flex size-7 items-center justify-center rounded-md transition-colors [&_svg]:size-3.5",
                    wrap ? "bg-ov/10 text-foreground" : "text-muted-foreground hover:bg-ov/[0.06]",
                  )}
                >
                  <WrapText />
                </button>
              </Tooltip>
            </div>
          </div>
          {!q ? (
            <Empty icon={<FileText />} text={tr("Pick a log file")} />
          ) : error && !data ? (
            <Empty error text={error} />
          ) : data === undefined ? (
            <Empty icon={<ScrollText className="animate-pulse" />} text={tr("Reading the log…")} />
          ) : (
            <>
              {target.windows && src.mode === "journal" && (
                <div className="mx-2 mb-1.5 flex justify-end">
                  <WinToolLink tool="eventvwr.msc" label={tr("Open Event Viewer")} />
                </div>
              )}
              {needsRoot && !target.windows && (
                <div className="mx-2 mb-1.5 flex items-center gap-2 rounded-md bg-warning/10 px-2.5 py-1.5 text-[11.5px] text-warning">
                  <span className="flex-1">{tr("Some entries need more rights to read.")}</span>
                  <button
                    type="button"
                    className="shrink-0 font-medium underline-offset-2 hover:underline"
                    onClick={() =>
                      runInTerminal(
                        src.mode === "journal"
                          ? sudo(`journalctl -n ${count} --no-pager${src.unit ? ` -u ${src.unit}` : ""}${priority !== null ? ` -p ${priority}` : ""}`)
                          : sudo(`tail -n ${count} ${src.path}`),
                      )
                    }
                  >
                    {tr("Read with sudo in the terminal")}
                  </button>
                </div>
              )}
              <div
                ref={viewport}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
                }}
                className="mx-2 mb-2 min-h-0 flex-1 overflow-auto rounded-md bg-inset/60 px-2 py-1.5 font-mono text-[11px] leading-[1.55] select-text"
              >
                {!shown.length ? (
                  <div className="py-4 text-center font-sans text-[12px] text-muted-foreground">{f ? tr("No matches") : tr("The log is empty")}</div>
                ) : (
                  shown.map((l, i) => <LogLine key={`${i}:${l.length}`} line={l} filter={f} wrap={wrap} />)
                )}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

function LogLine({ line, filter, wrap }: { line: string; filter: string; wrap: boolean }) {
  // journal short-iso: "2026-11-26T10:00:00+0800 host unit[pid]: message" (Windows events alike)
  const m = line.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[^ ]*)\s+(\S+)\s+([^:]+:)\s?(.*)$/);
  const body = m ? m[4] : line;
  // the level shows in the message, not in a source's name ("Windows Error Reporting")
  const lvl = LEVEL.find((x) => x.re.test(body));
  const mark = (t: string) => {
    if (!filter) return t;
    const i = t.toLowerCase().indexOf(filter);
    if (i < 0) return t;
    return (
      <>
        {t.slice(0, i)}
        <mark className="rounded-sm bg-primary/30 text-foreground">{t.slice(i, i + filter.length)}</mark>
        {t.slice(i + filter.length)}
      </>
    );
  };
  return (
    <div className={cn(wrap ? "break-all whitespace-pre-wrap" : "whitespace-pre", "hover:bg-ov/[0.04]")}>
      {m && (
        <>
          <span className="text-muted-foreground/70">{m[1].slice(5, 19).replace("T", " ")} </span>
          <span className="text-primary/80">{m[3]} </span>
        </>
      )}
      <span className={cn("text-foreground/85", lvl?.cls)}>{mark(body)}</span>
    </div>
  );
}

// ------------------------------------------------------------------ network: connections + firewall

interface Conn {
  proto: string;
  state: string;
  local: string;
  peer: string;
  process: string | null;
  pid: number | null;
}

function parseConnections(out: string): Conn[] {
  const rows: Conn[] = [];
  for (const l of lines(out)) {
    if (l.startsWith("#")) continue;
    const f = l.split(/\s+/);
    const p = l.match(/\("([^"]+)",pid=(\d+)/);
    if (out.startsWith("#ss")) {
      if (f.length < 6) continue;
      rows.push({ proto: f[0], state: f[1], local: f[4], peer: f[5], process: p?.[1] ?? null, pid: p ? Number(p[2]) : null });
    } else {
      // netstat -tunap: proto recv send local foreign state pid/prog
      if (f.length < 5 || !/^(tcp|udp)/.test(f[0])) continue;
      const udp = f[0].startsWith("udp");
      const prog = (udp ? f[5] : f[6])?.split("/") ?? [];
      rows.push({
        proto: f[0].replace(/6$/, ""),
        state: udp ? "UNCONN" : f[5],
        local: f[3],
        peer: f[4],
        process: prog[1] ?? null,
        pid: Number(prog[0]) || null,
      });
    }
  }
  return rows;
}

const hostOf = (a: string) => a.replace(/^\[|\](?=:)/g, "").replace(/:(\d+|\*)$/, "").replace(/%\S+$/, "");
const portOf = (a: string) => a.match(/:(\d+|\*)$/)?.[1] ?? "";
const stateLabel: Record<string, string> = { ESTAB: "ESTABLISHED", "TIME-WAIT": "TIME_WAIT", "CLOSE-WAIT": "CLOSE_WAIT", "SYN-SENT": "SYN_SENT", "SYN-RECV": "SYN_RECV" };

export function ConnectionsView({ target }: { target: Target }) {
  const [filter, setFilter] = useState("");
  const [state, setState] = useState<"estab" | "wait" | "all">("estab");
  const { data, error, refresh } = usePoll(`${target.key}:conns`, () => query(target, { kind: "connections" }), 5000);
  const all = useMemo(() => parseConnections(data ?? "").filter((c) => c.state !== "LISTEN" && c.state !== "UNCONN"), [data]);
  const norm = (s: string) => stateLabel[s] ?? s;
  const q = filter.trim().toLowerCase();
  const list = all.filter(
    (c) =>
      (state === "all" || (state === "estab" ? norm(c.state) === "ESTABLISHED" : /WAIT/.test(norm(c.state)))) &&
      (!q || `${c.local} ${c.peer} ${c.process ?? ""} ${c.pid ?? ""}`.toLowerCase().includes(q)),
  );
  // the busiest remote hosts, for a quick read of who's connected
  const top = useMemo(() => {
    const m = new Map<string, number>();
    for (const c of all) if (norm(c.state) === "ESTABLISHED") m.set(hostOf(c.peer), (m.get(hostOf(c.peer)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  }, [all]);
  const waits = all.filter((c) => /WAIT/.test(norm(c.state))).length;
  const estab = all.filter((c) => norm(c.state) === "ESTABLISHED").length;

  const kill = async (c: Conn) => {
    if (!c.pid) return;
    const ok = await confirm({
      title: tr("End {0} ({1})?", { 0: c.process ?? "process", 1: c.pid }),
      message: tr("It holds the connection {0} → {1}.", { 0: c.local, 1: c.peer }),
      confirmLabel: tr("End process"),
      danger: true,
    });
    if (ok) await ipc.processKill(target.sessionId, c.pid, false).then(refresh, (e) => fail(tr("Couldn't end the process"), e));
  };

  return (
    <>
      <div className="grid gap-1.5 px-2 pb-2">
        <SearchField value={filter} onChange={setFilter} placeholder={tr("Address, port or process")} />
        <Tabs
          id="conns"
          value={state}
          onChange={setState}
          options={[
            { value: "estab", label: tr("Established · {0}", { 0: estab }) },
            { value: "wait", label: tr("Waiting · {0}", { 0: waits }) },
            { value: "all", label: tr("All") },
          ]}
        />
        {top.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {top.map(([h, n]) => (
              <button
                key={h}
                type="button"
                onClick={() => setFilter(h)}
                className="rounded-md bg-ov/[0.06] px-1.5 py-0.5 font-mono text-[10.5px] text-muted-foreground transition-colors hover:bg-ov/10 hover:text-foreground"
              >
                {h} <span className="text-primary">×{n}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && !data ? (
        <Empty error text={error} />
      ) : !data ? (
        <Empty text={tr("Listing connections…")} />
      ) : !list.length ? (
        <Empty text={q ? tr("No matches") : tr("No connections")} />
      ) : (
        <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
          {list.slice(0, 500).map((c, i) => (
            <Row
              key={`${c.local}-${c.peer}-${i}`}
              dot={norm(c.state) === "ESTABLISHED" ? "ok" : /WAIT/.test(norm(c.state)) ? "warn" : "off"}
              title={
                <span className="flex items-baseline gap-1.5 font-mono text-[11.5px]">
                  <span className="truncate">{c.peer}</span>
                  <span className="text-muted-foreground">→ :{portOf(c.local)}</span>
                </span>
              }
              detail={`${c.proto.toUpperCase()} · ${norm(c.state).toLowerCase().replace("_", " ")}${c.process ? ` · ${c.process}` : ""}${c.pid ? ` (${c.pid})` : ""}`}
              actions={
                c.pid ? (
                  <Act tip={tr("End process")} onClick={() => void kill(c)} danger>
                    <Skull />
                  </Act>
                ) : undefined
              }
              menu={
                <>
                  <ContextMenuItem onSelect={() => copy(hostOf(c.peer))}>
                    <ClipboardCopy /> {tr("Copy remote address")}
                  </ContextMenuItem>
                  <ContextMenuItem onSelect={() => setFilter(hostOf(c.peer))}>
                    <Shield /> {tr("Only this host")}
                  </ContextMenuItem>
                  {c.pid && (
                    <>
                      <ContextMenuSeparator />
                      <ContextMenuItem destructive onSelect={() => void kill(c)}>
                        <Skull /> {tr("End process")}
                      </ContextMenuItem>
                    </>
                  )}
                </>
              }
            />
          ))}
          {list.length > 500 && <div className="py-2 text-center text-[11px] text-muted-foreground">{tr("Showing 500 of {0}", { 0: list.length })}</div>}
        </ScrollArea>
      )}
    </>
  );
}

const FW_NAMES: Record<string, string> = { ufw: "ufw", firewalld: "firewalld", nft: "nftables", iptables: "iptables", windows: "Windows Defender Firewall" };
const FW_CMD: Record<string, string> = {
  ufw: "ufw status verbose",
  firewalld: "firewall-cmd --list-all",
  nft: "nft list ruleset",
  iptables: "iptables -S",
};

export function FirewallView({ target }: { target: Target }) {
  const { data, error } = usePoll(`${target.key}:fw`, () => query(target, { kind: "firewall" }), 30000);
  const sections = useMemo(() => {
    const out: { tool: string; text: string }[] = [];
    for (const part of (data ?? "").split(/^#/m).slice(1)) {
      const nl = part.indexOf("\n");
      out.push({ tool: (nl < 0 ? part : part.slice(0, nl)).trim(), text: nl < 0 ? "" : part.slice(nl + 1).trim() });
    }
    return out;
  }, [data]);
  if (error && !data) return <Empty error text={error} />;
  if (data === undefined) return <Empty text={tr("Reading firewall rules…")} />;
  if (!sections.length) return <Empty icon={<Shield />} text={tr("No firewall tool found (ufw, firewalld, nftables, iptables)")} />;
  return (
    <ScrollArea className="min-h-0 flex-1" viewportClassName="grid gap-2 px-2 pb-2">
      {sections.map((s) => {
        const locked = /a password is required|sudo:|permission denied|must be root|you need to be root/i.test(s.text);
        const active =
          s.tool === "ufw" ? /Status: active/.test(s.text) : s.tool === "firewalld" ? !/not running/i.test(s.text) : s.tool === "windows" ? /^\S+\s+on\b/m.test(s.text) : null;
        const open = () => (s.tool === "windows" ? void ipc.winOpen("wf.msc") : runInTerminal(sudo(FW_CMD[s.tool] ?? s.tool)));
        return (
          <div key={s.tool} className="overflow-hidden rounded-lg border border-ov/[0.08]">
            <div className="flex items-center gap-2 border-b border-ov/[0.06] bg-ov/[0.03] px-2.5 py-1.5">
              <Shield className="size-3.5 text-muted-foreground" />
              <span className="flex-1 text-[12px] font-medium">{FW_NAMES[s.tool] ?? s.tool}</span>
              {!locked && active !== null && (
                <span className={cn("rounded px-1.5 py-px text-[10.5px]", active ? "bg-success/15 text-success" : "bg-ov/10 text-muted-foreground")}>
                  {active ? tr("Active") : tr("Inactive")}
                </span>
              )}
              <Tooltip content={s.tool === "windows" ? tr("Open Windows Firewall settings") : tr("Show in the terminal")}>
                <button
                  type="button"
                  onClick={open}
                  className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-ov/10 hover:text-foreground [&_svg]:size-3.5"
                >
                  <SquareTerminal />
                </button>
              </Tooltip>
            </div>
            {locked ? (
              <div className="px-2.5 py-2 text-[11.5px] text-muted-foreground">
                {tr("Reading the rules needs root.")}{" "}
                <button type="button" className="text-primary hover:underline" onClick={() => runInTerminal(sudo(FW_CMD[s.tool] ?? s.tool))}>
                  {tr("Show them with sudo in the terminal")}
                </button>
              </div>
            ) : (
              <pre className="max-h-72 overflow-auto px-2.5 py-2 font-mono text-[11px] leading-[1.5] text-foreground/85 select-text">{s.text || tr("(no rules)")}</pre>
            )}
          </div>
        );
      })}
    </ScrollArea>
  );
}

// ------------------------------------------------------------------ scheduled tasks

interface CronJob {
  source: string;
  schedule: string;
  user: string | null;
  command: string;
}
interface Timer {
  unit: string;
  activates: string;
  next: string;
  left: string;
  last: string;
}

function parseCron(out: string): { jobs: CronJob[]; timers: Timer[]; noUserCrontab: boolean; timersError: string | null } {
  const jobs: CronJob[] = [];
  const timers: Timer[] = [];
  let noUserCrontab = false;
  let timersError: string | null = null;
  for (const part of out.split(/^#(?=user|etc |timers)/m).slice(1)) {
    const nl = part.indexOf("\n");
    const head = (nl < 0 ? part : part.slice(0, nl)).trim();
    const body = nl < 0 ? "" : part.slice(nl + 1);
    if (head === "timers") {
      if (problem(body)) timersError = problem(body);
      for (const l of lines(body)) {
        const m = l.match(/^(.*?)\s+(\S+\.timer)\s+(\S+)\s*$/);
        if (!m) continue;
        const dates = [...m[1].matchAll(/\w{3} \d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?: \S+)?/g)].map((d) => d[0]);
        // "Thu 2026-11-26 11:00:00 CST 52min left Thu …": what sits between the next run and "left"
        const afterNext = dates[0] ? m[1].slice(m[1].indexOf(dates[0]) + dates[0].length) : "";
        const left = afterNext.match(/^\s*(.+?)\s+left\b/)?.[1] ?? "";
        const startsNa = /^n\/a/.test(m[1].trim());
        timers.push({ unit: m[2], activates: m[3], next: startsNa ? "" : (dates[0] ?? ""), left: startsNa ? "" : left, last: startsNa ? (dates[0] ?? "") : (dates[1] ?? "") });
      }
      continue;
    }
    const system = head.startsWith("etc");
    const source = system ? head.slice(4) : tr("Your crontab");
    if (!system && /no crontab for/i.test(body)) noUserCrontab = true;
    for (const raw of lines(body)) {
      const l = raw.trim();
      if (!l || l.startsWith("#") || /^[A-Za-z_][A-Za-z0-9_]*\s*=/.test(l) || /no crontab for/i.test(l)) continue;
      const f = l.split(/\s+/);
      const special = f[0].startsWith("@");
      const n = special ? 1 : 5;
      if (f.length < n + (system ? 2 : 1)) continue;
      jobs.push({
        source,
        schedule: f.slice(0, n).join(" "),
        user: system ? f[n] : null,
        command: f.slice(n + (system ? 1 : 0)).join(" "),
      });
    }
  }
  return { jobs, timers, noUserCrontab, timersError };
}

/** "Thu 2026-11-26 11:00:00 CST" → "11-26 11:00" (the server's local time). */
const shortDate = (d: string) => d.replace(/^\w{3} \d{4}-/, "").replace(/:\d\d(?: \S+)?$/, "");

/** "*\/5 * * * *" → "Every 5 minutes"; falls back to the expression. */
export function describeCron(expr: string): string {
  const at: Record<string, string> = {
    "@reboot": tr("At boot"),
    "@yearly": tr("Yearly"),
    "@annually": tr("Yearly"),
    "@monthly": tr("Monthly"),
    "@weekly": tr("Weekly"),
    "@daily": tr("Daily"),
    "@midnight": tr("Daily"),
    "@hourly": tr("Hourly"),
  };
  if (at[expr]) return at[expr];
  const [mi, h, dom, mon, dow] = expr.split(" ");
  if (!dow) return expr;
  const num = (s: string) => /^\d+$/.test(s);
  const time = num(h) && num(mi) ? `${h.padStart(2, "0")}:${mi.padStart(2, "0")}` : null;
  const days = [tr("Sun"), tr("Mon"), tr("Tue"), tr("Wed"), tr("Thu"), tr("Fri"), tr("Sat"), tr("Sun")];
  if (mon === "*" && dom === "*" && dow === "*") {
    if (mi === "*" && h === "*") return tr("Every minute");
    if (/^\*\/\d+$/.test(mi) && h === "*") return tr("Every {0} minutes", { 0: mi.slice(2) });
    if (num(mi) && h === "*") return tr("Hourly at :{0}", { 0: mi.padStart(2, "0") });
    if (num(mi) && /^\*\/\d+$/.test(h)) return tr("Every {0} hours at :{1}", { 0: h.slice(2), 1: mi.padStart(2, "0") });
    if (time) return tr("Daily at {0}", { 0: time });
  }
  if (mon === "*" && dom === "*" && time && /^[0-7](,[0-7])*$/.test(dow)) return tr("{0} at {1}", { 0: dow.split(",").map((d) => days[Number(d)]).join(", "), 1: time });
  if (mon === "*" && dow === "*" && time && num(dom)) return tr("Monthly on day {0} at {1}", { 0: dom, 1: time });
  return expr;
}

export function CronPanel() {
  const { target } = useTarget();
  return target?.windows ? <WinTasksPanel /> : <LinuxCronPanel />;
}

function LinuxCronPanel() {
  const { target, reason } = useTarget();
  const [view, setView] = useState<"cron" | "timers">("cron");
  const [filter, setFilter] = useState("");
  const { data, error, loading, refresh } = usePoll(target?.key ?? null, () => query(target!, { kind: "cron" }), 30000);
  const parsed = useMemo(() => parseCron(data ?? ""), [data]);
  const q = filter.trim().toLowerCase();
  const jobs = parsed.jobs.filter((j) => !q || `${j.command} ${j.source} ${j.user ?? ""}`.toLowerCase().includes(q));
  const timers = parsed.timers.filter((t) => !q || `${t.unit} ${t.activates}`.toLowerCase().includes(q));
  const bySource = useMemo(() => {
    const m = new Map<string, CronJob[]>();
    for (const j of jobs) m.set(j.source, [...(m.get(j.source) ?? []), j]);
    return [...m.entries()];
  }, [jobs]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={tr("Scheduled tasks")} icon={<CalendarClock />} target={target} loading={loading} onRefresh={refresh} />
      {!target ? (
        <Empty icon={<CalendarClock />} text={reason} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <SearchField value={filter} onChange={setFilter} placeholder={tr("Command or unit")} />
            <Tabs
              id="cron"
              value={view}
              onChange={setView}
              options={[
                { value: "cron", label: tr("cron · {0}", { 0: parsed.jobs.length }) },
                { value: "timers", label: tr("systemd timers · {0}", { 0: parsed.timers.length }) },
              ]}
            />
          </div>
          {error && !data ? (
            <Empty error text={error} />
          ) : data === undefined ? (
            <Empty icon={<CalendarClock className="animate-pulse" />} text={tr("Reading schedules…")} />
          ) : view === "cron" ? (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              <div className="mb-1 flex items-center justify-between px-1">
                <span className="text-[11px] text-muted-foreground">
                  {parsed.noUserCrontab ? tr("You have no crontab yet") : tr("Times are the server's local time")}
                </span>
                <button type="button" className="text-[11.5px] text-primary hover:underline" onClick={() => runInTerminal("crontab -e")}>
                  {tr("Edit your crontab")}
                </button>
              </div>
              {!bySource.length ? (
                <Empty icon={<CalendarClock />} text={q ? tr("No matches") : tr("No cron jobs")} />
              ) : (
                bySource.map(([source, list]) => (
                  <div key={source} className="mb-1.5">
                    <div className="px-1 pt-1 pb-0.5 font-mono text-[10.5px] text-muted-foreground/80">{source}</div>
                    {list.map((j, i) => (
                      <Row
                        key={`${j.schedule}-${i}`}
                        title={<span className="font-mono text-[11.5px]">{j.command}</span>}
                        detail={
                          <span>
                            <span className="text-foreground/75">{describeCron(j.schedule)}</span>
                            <span className="font-mono text-[10.5px]"> · {j.schedule}</span>
                            {j.user && <span> · {j.user}</span>}
                          </span>
                        }
                        actions={
                          <Act tip={tr("Run it now in the terminal")} onClick={() => runInTerminal(j.command, false)}>
                            <Play />
                          </Act>
                        }
                        menu={
                          <>
                            <ContextMenuItem onSelect={() => runInTerminal(j.command, false)}>
                              <Play /> {tr("Put the command in the terminal")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => copy(j.command)}>
                              <ClipboardCopy /> {tr("Copy command")}
                            </ContextMenuItem>
                            <ContextMenuItem onSelect={() => copy(`${j.schedule} ${j.user ? `${j.user} ` : ""}${j.command}`)}>
                              <ClipboardCopy /> {tr("Copy line")}
                            </ContextMenuItem>
                            <ContextMenuSeparator />
                            <ContextMenuItem onSelect={() => runInTerminal(j.source.startsWith("/") ? sudo(`\${EDITOR:-vi} ${j.source}`) : "crontab -e")}>
                              <Pencil /> {tr("Edit")}
                            </ContextMenuItem>
                          </>
                        }
                      />
                    ))}
                  </div>
                ))
              )}
            </ScrollArea>
          ) : parsed.timersError ? (
            <Empty error text={parsed.timersError} />
          ) : !timers.length ? (
            <Empty icon={<CalendarClock />} text={q ? tr("No matches") : tr("No timers")} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {timers.map((t) => (
                <Row
                  key={t.unit}
                  dot={t.next ? "ok" : "off"}
                  title={t.unit.replace(/\.timer$/, "")}
                  detail={t.next ? tr("Next {0}{1}", { 0: shortDate(t.next), 1: t.left ? ` (${t.left})` : "" }) : tr("Not scheduled")}
                  right={t.last ? tr("last {0}", { 0: shortDate(t.last) }) : undefined}
                  actions={
                    <>
                      <Act tip={tr("Logs")} onClick={() => openLogs({ mode: "journal", unit: t.activates })}>
                        <ScrollText />
                      </Act>
                      <Act tip={tr("Run now")} onClick={() => runInTerminal(sudo(`systemctl start ${t.activates}`))}>
                        <Play />
                      </Act>
                    </>
                  }
                  menu={
                    <>
                      <ContextMenuItem onSelect={() => runInTerminal(sudo(`systemctl start ${t.activates}`))}>
                        <Play /> {tr("Run now")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => openLogs({ mode: "journal", unit: t.activates })}>
                        <ScrollText /> {tr("Logs")}
                      </ContextMenuItem>
                      <ContextMenuItem onSelect={() => runInTerminal(`systemctl cat ${t.unit} ${t.activates} --no-pager`)}>
                        <FileText /> {tr("Show its unit files")}
                      </ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem destructive onSelect={() => runInTerminal(sudo(`systemctl disable --now ${t.unit}`), false)}>
                        <PowerOff /> {tr("Turn off (put the command in the terminal)")}
                      </ContextMenuItem>
                    </>
                  }
                />
              ))}
            </ScrollArea>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Windows bits

function WinToolLink({ tool, label }: { tool: Parameters<typeof ipc.winOpen>[0]; label: string }) {
  return (
    <button
      type="button"
      onClick={() => void ipc.winOpen(tool).catch((e) => fail(label, e))}
      className="flex items-center gap-1 justify-self-end text-[11px] text-muted-foreground transition-colors hover:text-primary [&_svg]:size-3"
    >
      <ExternalLink /> {label}
    </button>
  );
}

interface WinTask {
  name: string;
  path: string;
  state: string;
  next: string;
  last: string;
  result: number;
  action: string;
}

/** Task Scheduler's tasks (Microsoft's own are left out), with run / stop / on / off. */
function WinTasksPanel() {
  const { target, reason } = useTarget();
  const [filter, setFilter] = useState("");
  const { data, error, loading, refresh } = usePoll(target?.key ?? null, () => query(target!, { kind: "cron" }), 30000);
  const tasks = useMemo<WinTask[]>(() => {
    const json = (data ?? "").split("#wintasks")[1]?.trim();
    if (!json) return [];
    try {
      const v = JSON.parse(json);
      return (Array.isArray(v) ? v : [v]).filter(Boolean);
    } catch {
      return [];
    }
  }, [data]);
  const q = filter.trim().toLowerCase();
  const list = tasks.filter((t) => !q || `${t.name} ${t.path} ${t.action}`.toLowerCase().includes(q));
  const act = async (t: WinTask, verb: "run" | "stop" | "enable" | "disable") => {
    try {
      await ipc.winAdmin("task", verb, t.name, t.path);
      toast({ kind: "success", title: tr("Done: {0} {1}", { 0: tr(verb[0].toUpperCase() + verb.slice(1)), 1: t.name }), duration: 2000 });
    } catch (e) {
      fail(tr("Couldn't change {0}", { 0: t.name }), e);
    }
    refresh();
  };
  // Task Scheduler's result codes: 0 fine, 0x41301 still running, 0x41303 not run yet
  const resultText = (r: number) =>
    r === 0 ? "" : r === 0x41301 ? tr("running") : r === 0x41303 ? tr("not run yet") : tr("last result 0x{0}", { 0: (r >>> 0).toString(16) });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header title={tr("Scheduled tasks")} icon={<CalendarClock />} target={target} loading={loading} onRefresh={refresh} />
      {!target ? (
        <Empty icon={<CalendarClock />} text={reason} />
      ) : (
        <>
          <div className="grid gap-1.5 px-2 pb-2">
            <SearchField value={filter} onChange={setFilter} placeholder={tr("Task name or command")} />
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] text-muted-foreground">{tr("Your tasks (Windows' own are hidden)")}</span>
              <WinToolLink tool="taskschd.msc" label={tr("Open Task Scheduler")} />
            </div>
          </div>
          {error && !data ? (
            <Empty error text={error} />
          ) : data === undefined ? (
            <Empty icon={<CalendarClock className="animate-pulse" />} text={tr("Reading schedules…")} />
          ) : !list.length ? (
            <Empty icon={<CalendarClock />} text={q ? tr("No matches") : tr("No scheduled tasks of yours")} />
          ) : (
            <ScrollArea className="min-h-0 flex-1" viewportClassName="px-2 pb-2">
              {list.map((t) => {
                const off = t.state === "Disabled";
                const running = t.state === "Running";
                // failures: HRESULT errors (0x8…) and programs' own exit codes; 0x4130x are notes
                const r = t.result >>> 0;
                const bad = !off && (r >= 0x80000000 || (r > 0 && r < 0x10000));
                return (
                  <Row
                    key={t.path + t.name}
                    dot={off ? "off" : bad ? "bad" : running ? "warn" : "ok"}
                    title={t.name}
                    detail={[
                      off ? tr("Disabled") : t.next ? tr("Next {0}{1}", { 0: t.next.slice(5), 1: "" }) : tr("Not scheduled"),
                      resultText(t.result),
                      t.path !== "\\" ? t.path : "",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    right={t.last ? tr("last {0}", { 0: t.last.slice(5) }) : undefined}
                    actions={
                      <>
                        {running ? (
                          <Act tip={tr("Stop")} onClick={() => void act(t, "stop")} danger>
                            <Square />
                          </Act>
                        ) : (
                          <Act tip={tr("Run now")} onClick={() => void act(t, "run")}>
                            <Play />
                          </Act>
                        )}
                      </>
                    }
                    menu={
                      <>
                        <ContextMenuItem onSelect={() => void act(t, "run")}>
                          <Play /> {tr("Run now")}
                        </ContextMenuItem>
                        {running && (
                          <ContextMenuItem onSelect={() => void act(t, "stop")}>
                            <Square /> {tr("Stop")}
                          </ContextMenuItem>
                        )}
                        {off ? (
                          <ContextMenuItem onSelect={() => void act(t, "enable")}>
                            <Power /> {tr("Enable")}
                          </ContextMenuItem>
                        ) : (
                          <ContextMenuItem onSelect={() => void act(t, "disable")}>
                            <PowerOff /> {tr("Disable")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuSeparator />
                        {t.action && (
                          <ContextMenuItem onSelect={() => copy(t.action)}>
                            <ClipboardCopy /> {tr("Copy command")}
                          </ContextMenuItem>
                        )}
                        <ContextMenuItem onSelect={() => void ipc.winOpen("taskschd.msc")}>
                          <ExternalLink /> {tr("Open Task Scheduler")}
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
