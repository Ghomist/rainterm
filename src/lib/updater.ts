// In-app updates (tauri-plugin-updater): GitHub releases carry a signed latest.json;
// we check at start and every few hours, offer the new version, download it with
// progress and install. On Windows the installer closes the app and opens it again.
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { create } from "zustand";
import { tr } from "@/lib/i18n";
import { proxyUrl, SYSTEM_PROXY } from "@/lib/proxy-url";
import { useApp } from "@/store/app";

export type UpdatePhase = "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "ready" | "error";

interface UpdateState {
  current: string;
  phase: UpdatePhase;
  version: string | null;
  notes: string;
  date: string | null;
  /** Bytes downloaded / total (total 0 when unknown). */
  done: number;
  total: number;
  error: string | null;
  checkedAt: number | null;
  /** The update dialog. */
  open: boolean;
}

export const useUpdate = create<UpdateState>(() => ({
  current: "",
  phase: "idle",
  version: null,
  notes: "",
  date: null,
  done: 0,
  total: 0,
  error: null,
  checkedAt: null,
  open: false,
}));

let pending: Update | null = null;

void getVersion().then((v) => useUpdate.setState({ current: v }));

/** The app's proxy for GitHub: the global one, else the system's (HTTP only for the updater). */
async function proxy(): Promise<string | undefined> {
  const st = useApp.getState().settings;
  for (const choice of [st.globalProxy, SYSTEM_PROXY]) {
    const url = await proxyUrl(choice, st.proxies).catch(() => null);
    if (url?.startsWith("http")) return url;
  }
  return undefined;
}

/** Look for a new version. `quiet` (background checks): no error state, no dialog. */
export async function checkForUpdate(quiet = false) {
  const s = useUpdate.getState();
  if (s.phase === "checking" || s.phase === "downloading" || s.phase === "installing") return;
  useUpdate.setState({ phase: "checking", error: null });
  const attempt = async (p?: string) => check({ timeout: 20_000, proxy: p });
  try {
    const p = await proxy();
    let u: Update | null;
    try {
      u = await attempt(p);
    } catch (e) {
      // A stale proxy setting shouldn't block updates: try straight once more.
      if (!p) throw e;
      u = await attempt(undefined);
    }
    pending = u;
    useUpdate.setState({
      checkedAt: Date.now(),
      phase: u ? "available" : "latest",
      version: u?.version ?? null,
      notes: u?.body ?? "",
      date: u?.date ?? null,
    });
    if (u && !quiet) useUpdate.setState({ open: true });
    return u;
  } catch (e) {
    useUpdate.setState({ phase: quiet ? "idle" : "error", error: explain(e), checkedAt: Date.now() });
    return null;
  }
}

function explain(e: unknown) {
  const s = String(e);
  // The latest release has no latest.json (made before in-app updates existed).
  if (/valid release JSON/i.test(s)) return tr("the latest release can't be installed from inside the app — download it from the releases page");
  if (/signature/i.test(s)) return tr("the download's signature didn't match, so it wasn't installed");
  return s;
}

/** Download, verify and install the pending update, then restart. */
export async function installUpdate() {
  if (!pending) return;
  useUpdate.setState({ phase: "downloading", done: 0, total: 0, error: null });
  try {
    await pending.download((ev) => {
      if (ev.event === "Started") useUpdate.setState({ total: ev.data.contentLength ?? 0 });
      else if (ev.event === "Progress") useUpdate.setState((s) => ({ done: s.done + ev.data.chunkLength }));
    });
    useUpdate.setState({ phase: "installing" });
    // Windows: the installer takes over from here (closes and reopens rainterm).
    await pending.install();
    useUpdate.setState({ phase: "ready" });
    await relaunch();
  } catch (e) {
    useUpdate.setState({ phase: "error", error: String(e) });
  }
}

/** Mounted once (App): a check shortly after start, then every 6 hours. */
let timer: ReturnType<typeof setInterval> | null = null;
export function startUpdateChecks() {
  if (timer || import.meta.env.DEV) return;
  const tick = () => {
    if (useApp.getState().settings.autoUpdate) void checkForUpdate(true);
  };
  setTimeout(tick, 8_000);
  timer = setInterval(tick, 6 * 3600_000);
}

/** Whether the title bar should offer the update (not when the user skipped this version). */
export function useUpdateBadge() {
  const phase = useUpdate((s) => s.phase);
  const version = useUpdate((s) => s.version);
  const skip = useApp((s) => s.settings.skipVersion);
  return (phase === "available" && version !== skip) || phase === "downloading" || phase === "installing" ? version : null;
}
