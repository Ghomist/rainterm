import { getCurrentWindow } from "@tauri-apps/api/window";
import { MotionConfig } from "motion/react";
import { useEffect } from "react";
import { CommandPalette } from "@/components/CommandPalette";
import { Dialogs } from "@/components/dialogs";
import { Dock } from "@/components/Dock";
import { LockScreen } from "@/components/LockScreen";
import { Overlays } from "@/components/Overlays";
import { SnippetVarsDialog } from "@/components/SnippetVars";
import { SshKeyDialogs } from "@/components/SshKeys";
import { SettingsDialog } from "@/components/SettingsDialog";
import { StatusBar } from "@/components/StatusBar";
import { TerminalArea } from "@/components/TerminalArea";
import { TitleBar } from "@/components/TitleBar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ipc } from "@/lib/ipc";
import { comboFromEvent, keymap, recording } from "@/lib/keymap";
import { AGENT_INPUT_ID } from "@/components/AgentPanel";
import { useLatencyPolling } from "@/lib/latency";
import { useMcpServer } from "@/lib/mcp";
import { machineKey, pollMachine } from "@/lib/monitor";
import { confirm } from "@/lib/overlay";
import { themeById } from "@/lib/term-theme";
import { isViewOpen, useApp, useThemeId } from "@/store/app";

export default function App() {
  const init = useApp((s) => s.init);
  const effects = useApp((s) => s.effects);
  const reduce = useApp((s) => s.settings.reduceEffects);
  const themeId = useThemeId();
  const followSystem = useApp((s) => s.settings.themeMode === "system");

  useEffect(() => {
    void init();
  }, [init]);

  useEffect(() => {
    document.documentElement.dataset.effects = effects ? "on" : "off";
  }, [effects]);

  useEffect(() => {
    document.documentElement.dataset.reduce = reduce ? "on" : "off";
  }, [reduce]);

  // Follow the OS light/dark setting (used by themeMode "system").
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => useApp.getState().setSystemDark(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  // The whole UI follows the active terminal theme: surface, accent, light/dark chrome.
  useEffect(() => {
    const def = themeById(themeId);
    const t = def.theme;
    const html = document.documentElement;
    html.classList.toggle("dark", def.appearance === "dark");
    html.classList.toggle("light", def.appearance === "light");
    html.style.setProperty("--surface", t.background);
    html.style.setProperty("--primary", def.accent);
    for (const c of ["red", "yellow", "green", "blue", "magenta", "cyan"] as const)
      html.style.setProperty(`--term-${c}`, String(t[c]));
    void ipc
      .setWindowAppearance(followSystem ? null : def.appearance === "dark")
      // Un-forcing the window theme flips prefers-color-scheme back to the OS value
      // without always firing a change event: re-read it.
      .then(() => useApp.getState().setSystemDark(window.matchMedia("(prefers-color-scheme: dark)").matches))
      .catch(() => {});
  }, [themeId, followSystem]);

  // Mica is opt-in: solid themed chrome by default.
  const mica = useApp((s) => s.settings.mica);
  useEffect(() => {
    const dark = themeById(themeId).appearance === "dark";
    void ipc
      .setWindowEffects(mica, dark)
      .then((on) => useApp.getState().set({ effects: on }))
      .catch(() => useApp.getState().set({ effects: false }));
  }, [mica, themeId]);

  useShortcuts();
  useIdleLock();

  // Before the window closes: save the session, and ask if remote sessions are live.
  useEffect(() => {
    const win = getCurrentWindow();
    const un = win.onCloseRequested(async (e) => {
      const s = useApp.getState();
      await s.saveSessionNow();
      const live = Object.values(s.panes).filter((p) => p.kind !== "local" && p.session.alive);
      if (!s.settings.confirmClose || !live.length) return;
      e.preventDefault();
      const ok = await confirm({
        title: `Close rainterm?`,
        message: `${live.length} remote session${live.length > 1 ? "s are" : " is"} still connected (${live
          .slice(0, 3)
          .map((p) => p.title)
          .join(", ")}${live.length > 3 ? "…" : ""}). Closing will disconnect ${live.length > 1 ? "them" : "it"}.`,
        confirmLabel: "Close",
        danger: true,
      });
      if (ok) await win.destroy();
    });
    return () => void un.then((f) => f());
  }, []);

  // Never show the browser's native context menu. Our own menus (Radix) handle the
  // event in React first, so they keep working; everywhere else right-click is inert.
  useEffect(() => {
    const block = (e: MouseEvent) => e.preventDefault();
    window.addEventListener("contextmenu", block);
    return () => window.removeEventListener("contextmenu", block);
  }, []);

  return (
    <MotionConfig reducedMotion={reduce ? "always" : "user"}>
      <TooltipProvider>
        <div className="flex h-full flex-col bg-chrome">
          <TitleBar />
          <div className="flex min-h-0 flex-1">
            <Dock side="left" />
            <TerminalArea />
            <Dock side="right" />
          </div>
          <StatusBar />
        </div>
        <Pollers />
        <CommandPalette />
        <Dialogs />
        <SettingsDialog />
        <Overlays />
        <SnippetVarsDialog />
        <SshKeyDialogs />
        <LockScreen />
      </TooltipProvider>
    </MotionConfig>
  );
}

/** App-level shortcuts (configurable, see lib/keymap). Captured before xterm sees them;
 *  everything else goes to the shell. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useApp.getState();
      if (s.locked || recording.active) return;
      const combo = comboFromEvent(e);
      const action = combo ? keymap(s.settings).get(combo) : undefined;
      if (!action) return;
      const tab = s.tabs.find((t) => t.id === s.activeTabId);
      const pane = tab ? s.panes[tab.activePane] : undefined;
      runAction(action, pane);
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);
}

function runAction(action: string, pane: ReturnType<typeof useApp.getState>["panes"][string] | undefined) {
  const s = useApp.getState();
  const tabN = /^tab(\d)$/.exec(action);
  if (tabN) {
    const t = s.tabs[Number(tabN[1]) - 1];
    if (t) s.setActiveTab(t.id);
    return;
  }
  switch (action) {
    case "newTab": return s.openLocal();
    case "closePane": return pane && s.closePane(pane.id);
    case "nextTab": return s.cycleTab(1);
    case "prevTab": return s.cycleTab(-1);
    case "splitRight": return s.splitActive("row");
    case "splitDown": return s.splitActive("col");
    case "prevPane": return s.cyclePane(-1);
    case "nextPane": return s.cyclePane(1);
    case "zoomPane": return s.toggleZoom();
    case "lastTab": {
      const t = s.tabs.at(-1);
      return t && s.setActiveTab(t.id);
    }
    case "palette": return s.set({ paletteOpen: !s.paletteOpen });
    case "sidebar": return s.togglePanels();
    case "sessionsView": return s.toggleView("sessions");
    case "files":
    case "monitor":
    case "snippets":
    case "ports":
    case "containers":
    case "k8s":
      return s.toggleView(action);
    case "settings": return s.set({ settingsOpen: true });
    case "find": return s.set({ searchOpen: true });
    case "broadcast": return s.toggleBroadcast();
    case "agent": {
      if (document.activeElement?.id === AGENT_INPUT_ID) {
        pane?.session.focus();
        return;
      }
      s.toggleView("agent", true);
      // The view may mount (and only then listen) a frame or two later.
      const focus = (n: number) => {
        const el = document.getElementById(AGENT_INPUT_ID);
        if (el) el.focus();
        else if (n > 0) setTimeout(() => focus(n - 1), 60);
      };
      focus(10);
      return;
    }
    case "foldAll": return pane?.session.blocks.foldAll();
    case "unfoldAll": return pane?.session.blocks.unfoldAll();
    case "newSsh": return s.set({ profileEditor: { kind: "ssh" } });
    case "lock": return s.lock();
  }
}

function useIdleLock() {
  useEffect(() => {
    let last = Date.now();
    const bump = () => {
      last = Date.now();
    };
    const evs = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const e of evs) window.addEventListener(e, bump, { passive: true, capture: true });
    const timer = window.setInterval(() => {
      const s = useApp.getState();
      const mins = s.settings.lockAfterMinutes;
      if (!s.locked && s.settings.lockHash && mins > 0 && Date.now() - last > mins * 60_000) s.lock();
    }, 15_000);
    return () => {
      for (const e of evs) window.removeEventListener(e, bump, { capture: true });
      clearInterval(timer);
    };
  }, []);
}

/** Background polling (monitor, SSH latency). A component of its own so that what it
 *  watches (active tab, panel open, connections) doesn't re-render the whole app. */
function Pollers() {
  useMcpServer();
  const sshIds = useApp((s) =>
    Object.values(s.panes)
      .filter((p) => p.kind === "ssh" && p.status === "connected" && p.session.sessionId)
      .map((p) => p.session.sessionId)
      .join(","),
  );
  useLatencyPolling(sshIds ? sshIds.split(",") : []);

  // Resource monitor: poll the active session's machine (faster while the panel is open).
  const monitorOpen = useApp((s) => isViewOpen(s, "monitor"));
  const machine = useApp((s) => {
    const tab = s.tabs.find((t) => t.id === s.activeTabId);
    const pane = tab ? s.panes[tab.activePane] : null;
    const key = pane ? machineKey(pane.kind, pane.status === "connected" ? pane.session.sessionId : null) : null;
    return key && key !== "local" && !s.settings.monitorRemote ? null : key;
  });
  useEffect(() => {
    pollMachine(machine, monitorOpen ? 2000 : 5000);
  }, [machine, monitorOpen]);
  return null;
}
