import { create, type StoreApi, type UseBoundStore } from "zustand";
import {
  type Forward,
  ipc,
  type SecretKind,
  type SerialTarget,
  type SessionEvent,
  type ShellSpec,
  type SshAuth,
  type ProxySpec,
  type SshTarget,
} from "@/lib/ipc";
import { loadHistory } from "@/lib/history";
import {
  DEFAULT_DOCK,
  DEFAULT_SETTINGS,
  type DockSide,
  normalizeDock,
  resolveTheme,
  type Settings,
  sha256Hex,
  DEFAULT_AGENT,
  DEFAULT_MCP,
  DEFAULT_BADGES,
  type ViewId,
} from "@/lib/settings";
import { SYSTEM_PROXY, systemProxySpec } from "@/lib/proxy-url";
import type { Block } from "@/lib/blocks";
import { type SessionSource, TermSession } from "@/lib/term-session";
import { toast } from "@/lib/overlay";
import { fmtDuration } from "@/lib/utils";

// ------------------------------------------------------------------ model

export type TabStatus = "connecting" | "connected" | "exited" | "error";

interface ProfileBase {
  id: string;
  name: string;
  group?: string | null;
}

export interface SshProfile extends ProfileBase {
  kind: "ssh";
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  jumpId?: string | null;
  forwards: Forward[];
  /** Save the password / passphrase in the OS keychain. */
  remember?: boolean;
  /** Proxy: a saved proxy's id, "direct" for none, or empty/null for the global default. */
  proxy?: string | null;
}

export interface SerialProfile extends ProfileBase {
  kind: "serial";
  target: SerialTarget;
}

export type Profile = SshProfile | SerialProfile;

/** Session groups in display order: the user's ordered list, then any others in use. */
export function allGroups(order: string[], profiles: Profile[]): string[] {
  const out = [...order];
  for (const p of profiles) {
    const g = p.group?.trim();
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

export interface Pane {
  id: string;
  title: string;
  subtitle: string;
  kind: SessionSource["kind"];
  status: TabStatus;
  error?: string;
  exitCode?: number | null;
  awaitingSecret?: boolean;
  session: TermSession;
  highlight: boolean;
  logPath: string | null;
  cwd: string | null;
  profileId?: string;
  /** Input group id: typing in one member goes to all members (any tab). */
  group: string | null;
  /** A long command finished while you weren't looking (cleared when you look). */
  attention?: "ok" | "fail" | null;
  /** The SSH connection dropped and will be retried (auto-reconnect). */
  retry?: { attempt: number; at: number } | null;
}

export const INPUT_GROUPS = [
  { id: "a", name: "Group A", color: "#f87171" },
  { id: "b", name: "Group B", color: "#fbbf24" },
  { id: "c", name: "Group C", color: "#34d399" },
  { id: "d", name: "Group D", color: "#a78bfa" },
] as const;

export const groupById = (id: string | null) => INPUT_GROUPS.find((g) => g.id === id) ?? null;

export type BroadcastMode = "off" | "tab" | "all";

export type Layout =
  | { type: "pane"; paneId: string }
  | { type: "split"; id: string; dir: "row" | "col"; ratio: number; a: Layout; b: Layout };

export interface Tab {
  id: string;
  layout: Layout;
  activePane: string;
  /** Pane shown full-size (others stay alive in the background). */
  zoomed: string | null;
  /** User-given name; defaults to the active pane's title. */
  name: string | null;
}

// Persisted session (tabs + layout). No secrets, ever.
type SavedSource =
  | { kind: "local"; shellId: string }
  | { kind: "ssh"; profileId: string }
  | { kind: "ssh"; target: SshTarget; title?: string; subtitle?: string }
  | { kind: "serial"; profileId: string };

type SavedLayout =
  | { type: "pane"; source: SavedSource; group: string | null }
  | { type: "split"; dir: "row" | "col"; ratio: number; a: SavedLayout; b: SavedLayout };

interface SavedSession {
  tabs: { name: string | null; layout: SavedLayout; active: number }[];
  active: number;
}

export interface HostKeyPrompt {
  paneId: string;
  host: string;
  port: number;
  keyType: string;
  fingerprint: string;
  /** Known with a different key: accepting replaces the old entry. */
  changed: boolean;
}

export interface SecretPrompt {
  paneId: string;
  kind: SecretKind;
  message: string;
  label: string;
  canRemember: boolean;
  /** The secret is already in the keychain (it was wrong): default to updating it. */
  remembered?: boolean;
}

interface AppState {
  ready: boolean;
  effects: boolean;
  settings: Settings;
  systemDark: boolean;
  shells: ShellSpec[];
  profiles: Profile[];
  panes: Record<string, Pane>;
  tabs: Tab[];
  activeTabId: string | null;

  /** Ctrl+Shift+B: both side panels hidden (rails stay). */
  panelsHidden: boolean;
  paletteOpen: boolean;
  settingsOpen: boolean;
  searchOpen: boolean;
  broadcast: BroadcastMode;
  locked: boolean;
  profileEditor: { profile?: Profile; kind: Profile["kind"]; group?: string } | null;
  secretPrompt: SecretPrompt | null;
  hostKeyPrompt: HostKeyPrompt | null;

  init(): Promise<void>;
  openLocal(shell?: ShellSpec, opts?: { split?: "row" | "col" }): void;
  connect(profile: Profile, opts?: { split?: "row" | "col" }): Promise<void>;
  quickConnect(spec: string): void;
  reconnect(paneId: string): void;
  /** Stop retrying a dropped connection. */
  cancelRetry(paneId: string): void;
  splitActive(dir: "row" | "col"): void;
  closePane(paneId: string): void;
  closeTab(tabId: string): void;
  setActiveTab(tabId: string): void;
  focusPane(paneId: string): void;
  cycleTab(dir: 1 | -1): void;
  cyclePane(dir: 1 | -1): void;
  setRatio(tabId: string, splitId: string, ratio: number): void;
  answerHostKey(accept: boolean): void;
  answerSecret(secret: string | null, remember: boolean): Promise<void>;
  toggleHighlight(paneId: string): void;
  toggleLog(paneId: string): Promise<void>;
  toggleBroadcast(): void;
  setBroadcast(mode: BroadcastMode): void;
  setPaneGroup(paneId: string, group: string | null): void;
  toggleZoom(): void;
  renameTab(tabId: string, name: string | null): void;
  closeOtherTabs(tabId: string): void;
  duplicateTab(tabId: string): void;

  saveProfile(p: Profile): Promise<void>;
  importSshConfig(): Promise<{ added: number; total: number }>;
  deleteProfile(id: string): Promise<void>;
  /** Session groups: create (may stay empty), rename, delete (sessions move to ungrouped). */
  createGroup(name: string): Promise<void>;
  renameGroup(from: string, to: string): Promise<void>;
  deleteGroup(name: string): Promise<void>;
  moveProfile(id: string, group: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  lock(): void;
  unlock(password: string): Promise<boolean>;

  setSystemDark(dark: boolean): void;
  /** Show a tool view in its dock, or close that dock's panel if the view is already showing. */
  toggleView(id: ViewId, show?: boolean): void;
  /** Move a view to a dock (optionally at an index in its rail). */
  moveView(id: ViewId, side: DockSide, index?: number): void;
  resetDock(): void;
  togglePanels(): void;
  /** Flush the session snapshot to disk right away (e.g. before the window closes). */
  saveSessionNow(): Promise<void>;
  set(patch: Partial<AppState>): void;
}

let seq = 0;
const uid = (p: string) => `${p}${++seq}`;

// ------------------------------------------------------------------ layout helpers

export function layoutPanes(l: Layout): string[] {
  return l.type === "pane" ? [l.paneId] : [...layoutPanes(l.a), ...layoutPanes(l.b)];
}

function removeLeaf(l: Layout, paneId: string): Layout | null {
  if (l.type === "pane") return l.paneId === paneId ? null : l;
  const a = removeLeaf(l.a, paneId);
  const b = removeLeaf(l.b, paneId);
  if (!a) return b;
  if (!b) return a;
  return { ...l, a, b };
}

function replaceLeaf(l: Layout, paneId: string, node: Layout): Layout {
  if (l.type === "pane") return l.paneId === paneId ? node : l;
  return { ...l, a: replaceLeaf(l.a, paneId, node), b: replaceLeaf(l.b, paneId, node) };
}

function setSplitRatio(l: Layout, id: string, ratio: number): Layout {
  if (l.type === "pane") return l;
  if (l.id === id) return { ...l, ratio };
  return { ...l, a: setSplitRatio(l.a, id, ratio), b: setSplitRatio(l.b, id, ratio) };
}

/** Old profiles (pre-serial) have no `kind`. */
function migrateProfile(p: Record<string, unknown>): Profile {
  if (p.kind === "serial") return p as unknown as SerialProfile;
  return { forwards: [], ...p, kind: "ssh" } as unknown as SshProfile;
}

const secretKey = (profileId: string) => `ssh:${profileId}`;
export const proxySecretKey = (proxyId: string) => `proxy:${proxyId}`;

// ------------------------------------------------------------------ store

// Kept across dev hot updates: re-creating the store would re-run startup (restore) and
// orphan the live terminals of the old one.
export const useApp: UseBoundStore<StoreApi<AppState>> =
  import.meta.hot?.data.useApp ??
  create<AppState>((set, get) => {
  /** Settings with `theme` resolved from mode + system appearance. */
  const eff = (): Settings => {
    const s = get().settings;
    return { ...s, theme: resolveTheme(s, get().systemDark) };
  };
  const applyAll = () => {
    const e = eff();
    for (const pane of Object.values(get().panes)) pane.session.applySettings(e);
  };

  const patchPane = (id: string, patch: Partial<Pane>) =>
    set((s) => (s.panes[id] ? { panes: { ...s.panes, [id]: { ...s.panes[id], ...patch } } } : {}));

  const tabOfPane = (paneId: string) =>
    get().tabs.find((t) => layoutPanes(t.layout).includes(paneId)) ?? null;

  /** A long command finished out of sight: mark its tab and send a system notification. */
  const commandDone = async (paneId: string, b: Block) => {
    const min = get().settings.notifyAfterSeconds;
    if (!min || b.finishedAt === null) return;
    const ms = b.finishedAt - b.startedAt;
    if (ms < min * 1000) return;
    const tab = tabOfPane(paneId);
    const pane = get().panes[paneId];
    if (!tab || !pane) return;
    const seen = document.hasFocus() && !document.hidden && get().activeTabId === tab.id;
    if (seen) return;
    const failed = b.exitCode !== null && b.exitCode !== 0;
    patchPane(paneId, { attention: failed ? "fail" : "ok" });
    if (document.hasFocus()) return; // another tab of this window: the tab mark is enough
    try {
      const n = await import("@tauri-apps/plugin-notification");
      let ok = await n.isPermissionGranted();
      if (!ok) ok = (await n.requestPermission()) === "granted";
      if (!ok) return;
      const cmd = b.command.length > 60 ? `${b.command.slice(0, 57)}…` : b.command || "Command";
      n.sendNotification({
        title: `${failed ? "✗" : "✓"} ${cmd}`,
        body: `${failed ? `Failed (exit ${b.exitCode})` : "Finished"} after ${fmtDuration(ms)} · ${tab.name ?? pane.title}`,
      });
    } catch {
      /* notifications unavailable: the tab mark still shows */
    }
  };
  const clearAttention = (paneIds: string[]) => {
    const ps = get().panes;
    if (paneIds.some((id) => ps[id]?.attention))
      set((s) => {
        const panes = { ...s.panes };
        for (const id of paneIds) if (panes[id]?.attention) panes[id] = { ...panes[id], attention: null };
        return { panes };
      });
  };

  // Several sessions may ask at once (e.g. restoring tabs): queue the prompts and show
  // them one after another instead of letting them overwrite each other.
  const hostQueue: HostKeyPrompt[] = [];
  const secretQueue: SecretPrompt[] = [];
  const showHostKey = (p: HostKeyPrompt) => {
    if (get().hostKeyPrompt) hostQueue.push(p);
    else set({ hostKeyPrompt: p });
  };
  const showSecret = (p: SecretPrompt) => {
    if (get().secretPrompt) secretQueue.push(p);
    else set({ secretPrompt: p });
  };
  const nextPrompts = () => {
    if (!get().hostKeyPrompt && hostQueue.length) set({ hostKeyPrompt: hostQueue.shift() });
    if (!get().secretPrompt && secretQueue.length) set({ secretPrompt: secretQueue.shift() });
  };
  const dropPrompts = (paneId: string) => {
    for (const q of [hostQueue, secretQueue] as { paneId: string }[][])
      for (let i = q.length - 1; i >= 0; i--) if (q[i].paneId === paneId) q.splice(i, 1);
    if (get().hostKeyPrompt?.paneId === paneId) set({ hostKeyPrompt: null });
    nextPrompts();
  };

  // ---- auto-reconnect: an SSH connection that was up and dropped (no exit status from the
  // shell = not a normal `exit`) is retried with backoff, waiting for the network to be back.
  const RETRY_MAX = 12;
  const live = new Set<string>();
  const retryTimers = new Map<string, number>();
  const stopRetry = (paneId: string) => {
    const t = retryTimers.get(paneId);
    if (t !== undefined) clearTimeout(t);
    retryTimers.delete(paneId);
    if (get().panes[paneId]?.retry) patchPane(paneId, { retry: null });
  };
  const scheduleRetry = (paneId: string) => {
    const pane = get().panes[paneId];
    if (!pane) return;
    const attempt = (pane.retry?.attempt ?? 0) + 1;
    if (attempt > RETRY_MAX) {
      stopRetry(paneId);
      pane.session.term.write("\r\n\x1b[2m── gave up reconnecting · press Enter to try again ──\x1b[0m\r\n");
      return;
    }
    if (attempt === 1) pane.session.term.write("\r\n\x1b[2m── connection lost · reconnecting… ──\x1b[0m\r\n");
    const delay = Math.min(30, 2 ** attempt) * 1000;
    patchPane(paneId, { retry: { attempt, at: Date.now() + delay } });
    const fire = () => {
      retryTimers.delete(paneId);
      const p = get().panes[paneId];
      if (!p?.retry || p.session.alive) return;
      if (!navigator.onLine) {
        // Offline: wait for the network instead of burning attempts.
        const back = () => fire();
        window.addEventListener("online", back, { once: true });
        return;
      }
      patchPane(paneId, { status: "connecting", error: undefined, exitCode: undefined, awaitingSecret: false });
      void p.session.connect();
    };
    retryTimers.set(paneId, window.setTimeout(fire, delay));
  };

  const handleEvent = (paneId: string) => (ev: SessionEvent) => {
    const pane = get().panes[paneId];
    if (!pane) return;
    if (ev.type === "hostKeyPrompt" || ev.type === "secretRequired") stopRetry(paneId); // needs you
    switch (ev.type) {
      case "connecting":
        patchPane(paneId, { status: "connecting", error: undefined });
        break;
      case "connected":
        live.add(paneId);
        if (pane.retry) {
          stopRetry(paneId);
          pane.session.term.write("\x1b[2m── reconnected ──\x1b[0m\r\n");
        }
        patchPane(paneId, { status: "connected", error: undefined, awaitingSecret: false });
        if (get().settings.autoLog && !pane.logPath) void get().toggleLog(paneId);
        break;
      case "hostKeyPrompt":
        showHostKey({ paneId, ...ev });
        break;
      case "secretRequired": {
        const src = pane.session.source;
        const profile = get().profiles.find((p) => p.id === pane.profileId);
        const jumpProfile =
          profile?.kind === "ssh" ? get().profiles.find((p) => p.id === profile.jumpId) : undefined;
        const isJump = ev.kind.startsWith("jump");
        const owner = isJump ? jumpProfile : profile;
        const target =
          src.kind === "ssh" ? (isJump ? (src.target.jump ?? src.target) : src.target) : null;
        patchPane(paneId, { awaitingSecret: true });
        showSecret({
          paneId,
          kind: ev.kind,
          message: ev.message,
          label: target ? `${target.user}@${target.host}` : pane.subtitle,
          canRemember: !!owner,
          remembered: owner?.kind === "ssh" && !!owner.remember,
        });
        break;
      }
      case "error":
        patchPane(paneId, { status: "error", error: ev.message });
        break;
      case "notice":
        toast({ kind: "info", title: pane.title, description: ev.message, duration: 8000 });
        break;
      case "exit": {
        const p = get().panes[paneId];
        const wasLive = live.delete(paneId);
        if (p && p.status !== "error" && !p.awaitingSecret)
          patchPane(paneId, { status: "exited", exitCode: ev.code });
        // Dropped (no exit status from the shell) after being connected, or a retry failed.
        if (
          p?.kind === "ssh" &&
          ev.code == null &&
          !p.awaitingSecret &&
          get().settings.autoReconnect &&
          (wasLive || p.retry)
        )
          scheduleRetry(paneId);
        dropPrompts(paneId);
        if (p?.logPath) {
          p.session.setLogging(false);
          patchPane(paneId, { logPath: null });
        }
        break;
      }
    }
  };

  const makePane = (
    source: SessionSource,
    title: string,
    subtitle: string,
    profileId?: string,
  ): Pane => {
    const id = uid("p");
    const session = new TermSession(source, eff(), handleEvent(id));
    session.onCwd = (cwd) => patchPane(id, { cwd });
    session.blocks.onFinish((b, quiet) => {
      if (!quiet) void commandDone(id, b);
    });
    return {
      id,
      title,
      subtitle,
      kind: source.kind,
      status: "connecting",
      session,
      highlight: get().settings.highlight,
      logPath: null,
      cwd: null,
      profileId,
      group: null,
    };
  };

  /** Put a pane in a new tab, or split the active pane with it. */
  const place = (pane: Pane, split?: "row" | "col") => {
    const s = get();
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    if (split && tab) {
      const node: Layout = {
        type: "split",
        id: uid("s"),
        dir: split,
        ratio: 0.5,
        a: { type: "pane", paneId: tab.activePane },
        b: { type: "pane", paneId: pane.id },
      };
      set({
        panes: { ...s.panes, [pane.id]: pane },
        tabs: s.tabs.map((t) =>
          t.id === tab.id
            ? {
                ...t,
                layout: replaceLeaf(t.layout, tab.activePane, node),
                activePane: pane.id,
                zoomed: null,
              }
            : t,
        ),
      });
    } else {
      const newTab: Tab = {
        id: uid("t"),
        layout: { type: "pane", paneId: pane.id },
        activePane: pane.id,
        zoomed: null,
        name: null,
      };
      const idx = s.tabs.findIndex((t) => t.id === s.activeTabId);
      const tabs = [...s.tabs];
      tabs.splice(idx < 0 ? tabs.length : idx + 1, 0, newTab);
      set({ panes: { ...s.panes, [pane.id]: pane }, tabs, activeTabId: newTab.id });
    }
    wireBroadcast();
  };

  /** Recompute where each pane's keystrokes are mirrored to. */
  const wireBroadcast = () => {
    const { broadcast, tabs, panes } = get();
    const all = Object.keys(panes);
    for (const tab of tabs) {
      const tabIds = layoutPanes(tab.layout);
      for (const id of tabIds) {
        const pane = panes[id];
        if (!pane) continue;
        const targets = new Set<string>();
        if (broadcast === "tab") for (const x of tabIds) targets.add(x);
        if (broadcast === "all") for (const x of all) targets.add(x);
        if (pane.group) for (const x of all) if (panes[x].group === pane.group) targets.add(x);
        targets.delete(id);
        pane.session.inputHook =
          targets.size > 0
            ? (data) => {
                for (const other of targets) get().panes[other]?.session.input(data);
              }
            : null;
      }
    }
  };

  /** A profile's proxy choice → what the backend dials (password read from the keychain). */
  const resolveProxy = async (ref: string | null | undefined): Promise<ProxySpec | null> => {
    const s = get().settings;
    const id = ref === "direct" ? null : ref || s.globalProxy;
    if (id === SYSTEM_PROXY) return systemProxySpec();
    const def = id ? s.proxies.find((x) => x.id === id) : undefined;
    if (!def) return null;
    const password = def.hasPassword ? await ipc.secretGet(proxySecretKey(def.id)).catch(() => null) : null;
    return { kind: def.kind, host: def.host, port: def.port, user: def.user || null, password };
  };

  const toTarget = async (p: SshProfile, depth = 0): Promise<SshTarget> => {
    const jumpProfile = p.jumpId ? get().profiles.find((x) => x.id === p.jumpId) : undefined;
    const jump =
      jumpProfile?.kind === "ssh" && jumpProfile.id !== p.id && depth < 3
        ? { ...(await toTarget(jumpProfile, depth + 1)), forwards: [] }
        : null;
    return {
      host: p.host,
      port: p.port,
      user: p.user,
      auth: p.auth,
      forwards: p.forwards ?? [],
      jump,
      // Through a jump host only the first hop dials out, so only it uses a proxy.
      proxy: jump ? null : await resolveProxy(p.proxy),
    };
  };

  const paneForProfile = async (profile: Profile): Promise<Pane> => {
    if (profile.kind === "serial") {
      const t = profile.target;
      return makePane(
        { kind: "serial", target: t },
        profile.name || t.port,
        `${t.port} · ${t.baud}`,
        profile.id,
      );
    }
    const target = await toTarget(profile);
    const jumpProfile = profile.jumpId ? get().profiles.find((p) => p.id === profile.jumpId) : undefined;
    const secret = profile.remember ? await ipc.secretGet(secretKey(profile.id)).catch(() => null) : null;
    const jumpSecret =
      jumpProfile?.kind === "ssh" && jumpProfile.remember
        ? await ipc.secretGet(secretKey(jumpProfile.id)).catch(() => null)
        : null;
    return makePane(
      { kind: "ssh", profileId: profile.id, target, secret, jumpSecret },
      profile.name || profile.host,
      `${profile.user}@${profile.host}${profile.port === 22 ? "" : `:${profile.port}`}`,
      profile.id,
    );
  };

  // ---------------------------------------------------------------- session restore

  const saveSource = (pane: Pane): SavedSource | null => {
    const src = pane.session.source;
    if (src.kind === "local") return { kind: "local", shellId: src.shell.id };
    if (src.kind === "serial") return pane.profileId ? { kind: "serial", profileId: pane.profileId } : null;
    // Never persist secrets: profiles re-read the keychain, quick connects re-prompt.
    return pane.profileId
      ? { kind: "ssh", profileId: pane.profileId }
      : { kind: "ssh", target: { ...src.target, proxy: null }, title: pane.title, subtitle: pane.subtitle };
  };

  const saveLayout = (l: Layout): SavedLayout | null => {
    if (l.type === "pane") {
      const pane = get().panes[l.paneId];
      const source = pane && saveSource(pane);
      return source ? { type: "pane", source, group: pane.group } : null;
    }
    const a = saveLayout(l.a);
    const b = saveLayout(l.b);
    if (!a || !b) return a ?? b;
    return { type: "split", dir: l.dir, ratio: l.ratio, a, b };
  };

  const snapshot = (): SavedSession => {
    const { tabs, activeTabId } = get();
    const out: SavedSession = { tabs: [], active: 0 };
    for (const t of tabs) {
      const layout = saveLayout(t.layout);
      if (!layout) continue;
      if (t.id === activeTabId) out.active = out.tabs.length;
      out.tabs.push({ name: t.name, layout, active: Math.max(0, layoutPanes(t.layout).indexOf(t.activePane)) });
    }
    return out;
  };

  const restorePane = async (src: SavedSource): Promise<Pane | null> => {
    const { shells, profiles } = get();
    if (src.kind === "local") {
      const sh = shells.find((x) => x.id === src.shellId) ?? shells[0];
      return sh ? makePane({ kind: "local", shell: sh }, sh.name, "local") : null;
    }
    const profile = "profileId" in src ? profiles.find((x) => x.id === src.profileId) : undefined;
    if (profile) return paneForProfile(profile);
    if (src.kind === "ssh" && "target" in src)
      return makePane(
        { kind: "ssh", target: { ...src.target, proxy: await resolveProxy(null) }, secret: null, jumpSecret: null },
        src.title ?? src.target.host,
        src.subtitle ?? src.target.host,
      );
    return null; // profile was deleted
  };

  const restoreLayout = async (l: SavedLayout, out: Pane[]): Promise<Layout | null> => {
    if (l.type === "pane") {
      const pane = await restorePane(l.source);
      if (!pane) return null;
      pane.group = l.group ?? null;
      out.push(pane);
      return { type: "pane", paneId: pane.id };
    }
    const a = await restoreLayout(l.a, out);
    const b = await restoreLayout(l.b, out);
    if (!a || !b) return a ?? b;
    return { type: "split", id: uid("s"), dir: l.dir, ratio: l.ratio, a, b };
  };

  const restoreSession = async (saved: SavedSession) => {
    const panes: Record<string, Pane> = {};
    const tabs: Tab[] = [];
    let activeTabId: string | null = null;
    for (const [i, st] of saved.tabs.entries()) {
      const created: Pane[] = [];
      const layout = await restoreLayout(st.layout, created);
      if (!layout) continue;
      for (const p of created) panes[p.id] = p;
      const ids = layoutPanes(layout);
      const tab: Tab = { id: uid("t"), layout, activePane: ids[Math.min(st.active, ids.length - 1)], zoomed: null, name: st.name };
      tabs.push(tab);
      if (i === saved.active) activeTabId = tab.id;
    }
    if (!tabs.length) return false;
    set({ panes, tabs, activeTabId: activeTabId ?? tabs[0].id });
    wireBroadcast();
    return true;
  };

  let restored = false;
  let saveTimer: number | null = null;
  const saveSessionNow = async () => {
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = null;
    if (!restored) return;
    await ipc.storeSave("session", get().settings.restoreSession ? snapshot() : { tabs: [], active: 0 }).catch(() => {});
  };
  const scheduleSave = () => {
    if (!restored) return;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void saveSessionNow(), 1000);
  };
  // Save whenever tabs/layout/groups change (debounced).
  queueMicrotask(() =>
    useApp.subscribe((s, prev) => {
      if (s.tabs !== prev.tabs || s.panes !== prev.panes || s.activeTabId !== prev.activeTabId) scheduleSave();
    }),
  );

  const persistProfiles = async (profiles: Profile[]) => {
    set({ profiles });
    await ipc.storeSave("profiles", profiles);
  };

  const applyRules = async (s: Settings) => {
    const rules = s.highlightRules ?? (await ipc.defaultHighlightRules());
    await ipc.setHighlightRules(rules);
  };

  return {
    ready: false,
    effects: false,
    settings: DEFAULT_SETTINGS,
    systemDark: window.matchMedia("(prefers-color-scheme: dark)").matches,
    shells: [],
    profiles: [],
    panes: {},
    tabs: [],
    activeTabId: null,
    panelsHidden: false,
    paletteOpen: false,
    settingsOpen: false,
    searchOpen: false,
    broadcast: "off",
    locked: false,
    profileEditor: null,
    secretPrompt: null,
    hostKeyPrompt: null,

    async init() {
      if (get().ready) return;
      set({ ready: true });
      // A fresh webview (first launch or reload) owns no sessions yet: reap leftovers.
      await ipc.closeAll().catch(() => {});
      const [shells, profiles, settings, effects] = await Promise.all([
        ipc.listShells().catch(() => []),
        ipc.storeLoad<Record<string, unknown>[]>("profiles").catch(() => null),
        ipc.storeLoad<Partial<Settings>>("settings").catch(() => null),
        Promise.resolve(false),
      ]);
      await loadHistory();
      const merged: Settings = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
      merged.dock = normalizeDock(settings?.dock);
      merged.agent = { ...DEFAULT_AGENT, ...(settings?.agent ?? {}) };
      merged.mcp = { ...DEFAULT_MCP, ...(settings?.mcp ?? {}) };
      merged.blockBadges = { ...DEFAULT_BADGES, ...(settings?.blockBadges ?? {}) };
      // The right dock's width used to be `filesWidth`.
      const legacy = (settings as { filesWidth?: number } | null)?.filesWidth;
      if (settings && !("rightWidth" in settings) && legacy) merged.rightWidth = legacy;
      // Hover-switch delays from older versions that are no longer offered.
      if (![0, 150, 300, 500, 800, 1000].includes(merged.tabHoverSwitchMs)) merged.tabHoverSwitchMs = 300;
      // Older configs only had `theme`.
      if (settings && !("darkTheme" in settings) && settings.theme) merged.darkTheme = settings.theme;
      set({
        shells,
        profiles: (profiles ?? []).map(migrateProfile),
        settings: merged,
        effects,
        locked: !!merged.lockHash && merged.lockAfterMinutes > 0,
      });
      await applyRules(merged).catch(() => {});
      const saved = merged.restoreSession
        ? await ipc.storeLoad<SavedSession>("session").catch(() => null)
        : null;
      const ok = saved?.tabs?.length ? await restoreSession(saved).catch(() => false) : false;
      if (!ok && get().tabs.length === 0 && shells.length > 0) get().openLocal();
      restored = true;
      scheduleSave();
    },

    openLocal(shell, opts) {
      const { shells, settings } = get();
      const sh = shell ?? shells.find((s) => s.id === settings.defaultShell) ?? shells[0];
      if (!sh) return;
      place(makePane({ kind: "local", shell: sh }, sh.name, "local"), opts?.split);
    },

    async connect(profile, opts) {
      place(await paneForProfile(profile), opts?.split);
    },

    quickConnect(spec) {
      // user@host[:port]
      const m = spec.trim().match(/^(?:ssh\s+)?(?:([^@\s]+)@)?([^:\s]+)(?::(\d+))?$/);
      if (!m) return;
      const [, user = "root", host, port = "22"] = m;
      void resolveProxy(null).then((proxy) => {
        const target: SshTarget = {
          host,
          port: Number(port),
          user,
          auth: { kind: "auto" },
          forwards: [],
          proxy,
        };
        place(
          makePane(
            { kind: "ssh", target, secret: null, jumpSecret: null },
            host,
            `${user}@${host}${port === "22" ? "" : `:${port}`}`,
          ),
        );
      });
    },

    reconnect(paneId) {
      const pane = get().panes[paneId];
      if (!pane || pane.session.alive) return;
      stopRetry(paneId);
      pane.session.term.write("\r\n\x1b[2m── reconnecting ──\x1b[0m\r\n");
      patchPane(paneId, {
        status: "connecting",
        error: undefined,
        exitCode: undefined,
        awaitingSecret: false,
      });
      void pane.session.connect();
    },

    cancelRetry(paneId) {
      stopRetry(paneId);
    },

    splitActive(dir) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const pane = tab && s.panes[tab.activePane];
      if (!pane) return get().openLocal();
      const src = pane.session.source;
      if (src.kind === "local") return get().openLocal(src.shell, { split: dir });
      if (src.kind === "ssh") {
        place(makePane({ ...src }, pane.title, pane.subtitle, pane.profileId), dir);
        return;
      }
      get().openLocal(undefined, { split: dir }); // a serial port can't be opened twice
    },

    closePane(paneId) {
      const s = get();
      const tab = tabOfPane(paneId);
      const closing = s.panes[paneId];
      const sid = closing?.session.sessionId;
      stopRetry(paneId);
      live.delete(paneId);
      if (closing?.kind === "ssh" && sid) void ipc.monitorForget(sid).catch(() => {});
      closing?.session.dispose();
      const panes = { ...s.panes };
      delete panes[paneId];
      if (!tab) return set({ panes });
      const layout = removeLeaf(tab.layout, paneId);
      if (!layout) {
        const idx = s.tabs.findIndex((t) => t.id === tab.id);
        const tabs = s.tabs.filter((t) => t.id !== tab.id);
        const activeTabId =
          s.activeTabId === tab.id ? ((tabs[idx] ?? tabs[idx - 1])?.id ?? null) : s.activeTabId;
        set({ panes, tabs, activeTabId });
      } else {
        const remaining = layoutPanes(layout);
        const activePane = tab.activePane === paneId ? remaining[0] : tab.activePane;
        const zoomed = tab.zoomed === paneId ? null : tab.zoomed;
        set({
          panes,
          tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, layout, activePane, zoomed } : t)),
        });
      }
      wireBroadcast();
    },

    closeTab(tabId) {
      const tab = get().tabs.find((t) => t.id === tabId);
      if (!tab) return;
      for (const id of layoutPanes(tab.layout)) get().closePane(id);
    },

    setActiveTab(tabId) {
      set({ activeTabId: tabId });
      const tab = get().tabs.find((t) => t.id === tabId);
      if (tab && document.hasFocus()) clearAttention(layoutPanes(tab.layout));
    },

    focusPane(paneId) {
      const tab = tabOfPane(paneId);
      if (!tab || tab.activePane === paneId) return;
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, activePane: paneId } : t)),
      }));
    },

    cycleTab(dir) {
      const { tabs, activeTabId } = get();
      if (tabs.length < 2) return;
      const idx = tabs.findIndex((t) => t.id === activeTabId);
      set({ activeTabId: tabs[(idx + dir + tabs.length) % tabs.length].id });
    },

    cyclePane(dir) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab) return;
      const ids = layoutPanes(tab.layout);
      const idx = ids.indexOf(tab.activePane);
      get().focusPane(ids[(idx + dir + ids.length) % ids.length]);
    },

    setRatio(tabId, splitId, ratio) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.id === tabId ? { ...t, layout: setSplitRatio(t.layout, splitId, ratio) } : t,
        ),
      }));
    },

    answerHostKey(accept) {
      const p = get().hostKeyPrompt;
      if (!p) return;
      get().panes[p.paneId]?.session.replyHostKey(accept);
      set({ hostKeyPrompt: null });
      setTimeout(nextPrompts, 180); // let the closing animation play
    },

    async answerSecret(secret, remember) {
      const prompt = get().secretPrompt;
      if (!prompt) return;
      set({ secretPrompt: null });
      setTimeout(nextPrompts, 180);
      const pane = get().panes[prompt.paneId];
      if (!pane) return;
      const src = pane.session.source;
      if (secret === null || src.kind !== "ssh") {
        patchPane(pane.id, { status: "exited", awaitingSecret: false, exitCode: null });
        return;
      }
      const isJump = prompt.kind.startsWith("jump");
      if (isJump) src.jumpSecret = secret;
      else src.secret = secret;
      const profile = get().profiles.find((p) => p.id === pane.profileId);
      const owner = isJump && profile?.kind === "ssh" ? profile.jumpId : profile?.id;
      const target = owner ? get().profiles.find((p) => p.id === owner) : undefined;
      if (remember && owner) {
        await ipc.secretSet(secretKey(owner), secret).catch(() => {});
        if (target?.kind === "ssh" && !target.remember) await get().saveProfile({ ...target, remember: true });
      } else if (!remember && target?.kind === "ssh" && target.remember) {
        // Unticked a saved (and evidently wrong) secret: forget it.
        await get().saveProfile({ ...target, remember: false });
      }
      get().reconnect(pane.id);
    },

    toggleHighlight(paneId) {
      const pane = get().panes[paneId];
      if (!pane) return;
      pane.session.setHighlight(!pane.highlight);
      patchPane(paneId, { highlight: !pane.highlight });
    },

    async toggleLog(paneId) {
      const pane = get().panes[paneId];
      const id = pane?.session.sessionId;
      if (!pane || !id) return;
      const stopping = !!pane.logPath;
      if (stopping) pane.session.setLogging(false);
      const path = await ipc.sessionLog(id, stopping ? null : pane.title).catch(() => null);
      if (path) pane.session.setLogging(true);
      patchPane(paneId, { logPath: path });
    },

    toggleBroadcast() {
      get().setBroadcast(get().broadcast === "off" ? "tab" : "off");
    },

    setBroadcast(mode) {
      set({ broadcast: mode });
      wireBroadcast();
    },

    setPaneGroup(paneId, group) {
      patchPane(paneId, { group });
      wireBroadcast();
    },

    toggleZoom() {
      const s = get();
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      if (!tab || tab.layout.type === "pane") return;
      set({
        tabs: s.tabs.map((t) =>
          t.id === tab.id ? { ...t, zoomed: t.zoomed ? null : t.activePane } : t,
        ),
      });
    },

    renameTab(tabId, name) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.id === tabId ? { ...t, name: name?.trim() || null } : t)),
      }));
    },

    closeOtherTabs(tabId) {
      for (const t of get().tabs) if (t.id !== tabId) get().closeTab(t.id);
    },

    duplicateTab(tabId) {
      const s = get();
      const tab = s.tabs.find((t) => t.id === tabId);
      const pane = tab && s.panes[tab.activePane];
      if (!pane) return;
      set({ activeTabId: tabId });
      const src = pane.session.source;
      if (src.kind === "local") get().openLocal(src.shell);
      else if (src.kind === "ssh") place(makePane({ ...src }, pane.title, pane.subtitle, pane.profileId));
    },

    async saveProfile(p) {
      const profiles = get().profiles;
      const exists = profiles.some((x) => x.id === p.id);
      if (p.kind === "ssh" && !p.remember) await ipc.secretDelete(secretKey(p.id)).catch(() => {});
      await persistProfiles(
        exists ? profiles.map((x) => (x.id === p.id ? p : x)) : [...profiles, p],
      );
    },

    async importSshConfig() {
      const [hosts, localUser] = await ipc.sshConfigHosts();
      const existing = get().profiles;
      const byAlias = new Map<string, SshProfile>();
      const created: SshProfile[] = [];
      for (const h of hosts) {
        if (existing.some((p) => p.kind === "ssh" && p.name === h.alias)) continue;
        const p: SshProfile = {
          kind: "ssh",
          id: crypto.randomUUID(),
          name: h.alias,
          group: "SSH config",
          host: h.hostName ?? h.alias,
          port: h.port ?? 22,
          user: h.user ?? localUser,
          auth: h.identityFile ? { kind: "key", path: h.identityFile } : { kind: "auto" },
          forwards: [],
          jumpId: null,
        };
        byAlias.set(h.alias, p);
        created.push(p);
      }
      // ProxyJump: link to the profile of the hop right before the target.
      for (const h of hosts) {
        const p = byAlias.get(h.alias);
        if (!p || !h.proxyJump) continue;
        const hop = h.proxyJump.split(",").pop()?.trim() ?? "";
        const j = byAlias.get(hop) ?? existing.find((x) => x.kind === "ssh" && x.name === hop);
        if (j) p.jumpId = j.id;
      }
      if (created.length) await persistProfiles([...existing, ...created]);
      return { added: created.length, total: hosts.length };
    },

    async deleteProfile(id) {
      await ipc.secretDelete(secretKey(id)).catch(() => {});
      await persistProfiles(
        get()
          .profiles.filter((p) => p.id !== id)
          .map((p) => (p.kind === "ssh" && p.jumpId === id ? { ...p, jumpId: null } : p)),
      );
    },

    async createGroup(name) {
      const g = name.trim();
      const s = get().settings;
      if (!g || s.profileGroups.includes(g)) return;
      await get().updateSettings({ profileGroups: [...allGroups(s.profileGroups, get().profiles), g] });
    },

    async renameGroup(from, to) {
      const g = to.trim();
      if (!g || g === from) return;
      const s = get().settings;
      const order = allGroups(s.profileGroups, get().profiles);
      await persistProfiles(get().profiles.map((p) => (p.group?.trim() === from ? { ...p, group: g } : p)));
      await get().updateSettings({
        profileGroups: [...new Set(order.map((x) => (x === from ? g : x)))],
        collapsedGroups: s.collapsedGroups.map((x) => (x === from ? g : x)),
      });
    },

    async deleteGroup(name) {
      const s = get().settings;
      await persistProfiles(get().profiles.map((p) => (p.group?.trim() === name ? { ...p, group: "" } : p)));
      await get().updateSettings({
        profileGroups: allGroups(s.profileGroups, get().profiles).filter((x) => x !== name),
        collapsedGroups: s.collapsedGroups.filter((x) => x !== name),
      });
    },

    async moveProfile(id, group) {
      const p = get().profiles.find((x) => x.id === id);
      if (!p || (p.group ?? "") === group) return;
      const order = allGroups(get().settings.profileGroups, get().profiles);
      await persistProfiles(get().profiles.map((x) => (x.id === id ? { ...x, group } : x)));
      // Keep the group listed even if this was its last session.
      if (!get().settings.profileGroups.length || order.some((g) => !get().settings.profileGroups.includes(g)))
        await get().updateSettings({ profileGroups: order });
    },

    async updateSettings(patch) {
      const settings = { ...get().settings, ...patch };
      set({ settings });
      applyAll();
      if ("highlightRules" in patch) await applyRules(settings).catch(() => {});
      await ipc.storeSave("settings", settings);
    },

    lock() {
      if (get().settings.lockHash) set({ locked: true, paletteOpen: false });
    },

    async unlock(password) {
      const { lockHash, lockSalt } = get().settings;
      if (!lockHash) return true;
      const ok = (await sha256Hex(`${lockSalt ?? ""}${password}`)) === lockHash;
      if (ok) set({ locked: false });
      return ok;
    },

    saveSessionNow() {
      return saveSessionNow();
    },

    toggleView(id, show) {
      const s = get();
      const side: DockSide = s.settings.dock.left.includes(id) ? "left" : "right";
      const key = side === "left" ? "leftView" : "rightView";
      const visible = s.settings[key] === id && !s.panelsHidden;
      const open = show ?? !visible;
      if (s.panelsHidden && open) set({ panelsHidden: false });
      if (open !== visible || s.settings[key] !== id) void s.updateSettings({ [key]: open ? id : null });
    },

    moveView(id, side, index) {
      const s = get().settings;
      const dock = { left: s.dock.left.filter((v) => v !== id), right: s.dock.right.filter((v) => v !== id) };
      const list = dock[side];
      list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, id);
      const from: DockSide = s.dock.left.includes(id) ? "left" : "right";
      const patch: Partial<Settings> = { dock };
      if (from !== side) {
        // Showing on the old side → keep it showing on the new side.
        const fromKey = from === "left" ? "leftView" : "rightView";
        const toKey = side === "left" ? "leftView" : "rightView";
        if (s[fromKey] === id) {
          patch[fromKey] = null;
          patch[toKey] = id;
        }
      }
      void get().updateSettings(patch);
    },

    resetDock() {
      void get().updateSettings({ dock: DEFAULT_DOCK, leftView: "sessions", rightView: null });
    },

    togglePanels() {
      set({ panelsHidden: !get().panelsHidden });
    },

    setSystemDark(dark) {
      if (dark === get().systemDark) return;
      set({ systemDark: dark });
      applyAll();
    },

    set(patch) {
      set(patch);
    },
  };
});
if (import.meta.hot) import.meta.hot.data.useApp = useApp;

/** The active terminal theme id (mode + system appearance resolved). */
export const useThemeId = () => useApp((s) => resolveTheme(s.settings, s.systemDark));

export const useActiveTab = () =>
  useApp((s) => s.tabs.find((t) => t.id === s.activeTabId) ?? null);

/** The view is showing in its dock right now. */
export function isViewOpen(s: Pick<AppState, "settings" | "panelsHidden">, id: ViewId) {
  if (s.panelsHidden) return false;
  return (s.settings.dock.left.includes(id) ? s.settings.leftView : s.settings.rightView) === id;
}

export const useActivePane = () =>
  useApp((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    return tab ? (s.panes[tab.activePane] ?? null) : null;
  });

// Dev-only handle for debugging / automated checks over CDP.
if (import.meta.env.DEV) (window as unknown as { __app: typeof useApp }).__app = useApp;
