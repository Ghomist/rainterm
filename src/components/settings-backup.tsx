// Backup: settings, sessions and quick commands to one JSON file and back (a new computer,
// or a second one). Passwords stay in the OS keychain and are never exported.
import { Download, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/lib/ipc";
import { confirm, toast } from "@/lib/overlay";
import type { Settings } from "@/lib/settings";
import { type Snippet, useSnippets } from "@/lib/snippets";
import { type Profile, useApp } from "@/store/app";

interface Backup {
  app: "rainterm";
  version: 1;
  exportedAt: string;
  settings: Partial<Settings>;
  profiles: Profile[];
  snippets: Snippet[];
}

/** Settings that only make sense on this computer (or are secrets): never exported / imported. */
const LOCAL_ONLY: (keyof Settings)[] = [
  "lockHash",
  "lockSalt",
  "downloadDir",
  "defaultShell",
  "backdropImage",
  "leftView",
  "rightView",
  "collapsedGroups",
];

function portableSettings(s: Settings): Partial<Settings> {
  const out: Partial<Settings> = { ...s };
  for (const k of LOCAL_ONLY) delete out[k];
  // The MCP token is a credential: a fresh one is generated where it's needed.
  out.mcp = { ...s.mcp, token: "", enabled: false };
  return out;
}

async function exportBackup() {
  const st = useApp.getState();
  await useSnippets.getState().load();
  const data: Backup = {
    app: "rainterm",
    version: 1,
    exportedAt: new Date().toISOString(),
    settings: portableSettings(st.settings),
    profiles: st.profiles,
    snippets: useSnippets.getState().snippets,
  };
  const { save } = await import("@tauri-apps/plugin-dialog");
  const day = new Date().toISOString().slice(0, 10);
  const path = await save({
    title: "Export rainterm settings",
    defaultPath: `rainterm-backup-${day}.json`,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  if (!path) return;
  try {
    await ipc.textFileWrite(path, JSON.stringify(data, null, 2));
    toast({
      kind: "success",
      title: "Exported",
      description: `${data.profiles.length} sessions, ${data.snippets.length} quick commands and your settings`,
    });
  } catch (e) {
    toast({ kind: "error", title: "Export failed", description: String(e) });
  }
}

async function importBackup() {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const path = await open({ title: "Import rainterm settings", filters: [{ name: "JSON", extensions: ["json"] }] });
  if (!path || Array.isArray(path)) return;
  let data: Backup;
  try {
    data = JSON.parse(await ipc.textFileRead(path));
    if (data?.app !== "rainterm" || !Array.isArray(data.profiles)) throw new Error("not a rainterm backup");
  } catch (e) {
    toast({ kind: "error", title: "Can't import this file", description: String(e) });
    return;
  }
  const st = useApp.getState();
  const ids = new Set(st.profiles.map((p) => p.id));
  const newProfiles = data.profiles.filter((p) => !ids.has(p.id)).length;
  const snippets = Array.isArray(data.snippets) ? data.snippets : [];
  const ok = await confirm({
    title: "Import this backup?",
    message:
      `${data.profiles.length} sessions (${newProfiles} new, the rest replace the ones with the same id), ` +
      `${snippets.length} quick commands, and the settings in it. ` +
      "Passwords aren't in backups — you'll be asked again when you connect.",
    confirmLabel: "Import",
  });
  if (!ok) return;
  const settings: Partial<Settings> = { ...(data.settings ?? {}) };
  for (const k of LOCAL_ONLY) delete settings[k];
  if (settings.mcp) settings.mcp = { ...st.settings.mcp, ...settings.mcp, token: st.settings.mcp.token };
  await st.updateSettings(settings);
  for (const p of data.profiles) await useApp.getState().saveProfile(p);
  await useSnippets.getState().load();
  for (const s of snippets) await useSnippets.getState().save(s);
  toast({ kind: "success", title: "Imported", description: `${data.profiles.length} sessions, ${snippets.length} quick commands` });
}

export function BackupSection() {
  return (
    <div className="grid gap-2">
      <span className="text-[12px] font-medium text-foreground/90">Backup</span>
      <p className="text-[12px] text-muted-foreground">
        Sessions, quick commands and settings in one file — to set up another computer, or keep a copy.
        Passwords and the lock password stay in this computer's keychain and are never included.
      </p>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => void exportBackup()}>
          <Download className="size-3.5" /> Export…
        </Button>
        <Button variant="outline" size="sm" onClick={() => void importBackup()}>
          <Upload className="size-3.5" /> Import…
        </Button>
      </div>
    </div>
  );
}
