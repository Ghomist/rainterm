// SSH key pairs: list ~/.ssh, generate ed25519 keys, and install a public key on a
// connected server (like ssh-copy-id) — then optionally switch that session to the key.
import { Check, ClipboardCopy, KeyRound, Lock, Plus, RefreshCw, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tooltip } from "@/components/ui/tooltip";
import { ipc, type KeyInfo } from "@/lib/ipc";
import { toast } from "@/lib/overlay";
import { useApp } from "@/store/app";
import { Field } from "./dialogs";
import { tr } from "@/lib/i18n";

// ------------------------------------------------------------------ shared state

interface KeysState {
  keys: KeyInfo[] | null;
  error: string | null;
  generateOpen: boolean;
  /** Install dialog: which key / which terminal to start with. */
  install: { keyPath: string | null; paneId: string | null } | null;
}

const useKeys = create<KeysState>(() => ({ keys: null, error: null, generateOpen: false, install: null }));

export async function reloadKeys() {
  try {
    useKeys.setState({ keys: await ipc.sshKeysList(), error: null });
  } catch (e) {
    useKeys.setState({ keys: [], error: String(e) });
  }
}

export const openGenerateKey = () => useKeys.setState({ generateOpen: true });

/** Install a public key on a connected server (either may be preselected). */
export function openInstallKey(opts: { keyPath?: string | null; paneId?: string | null } = {}) {
  void reloadKeys();
  useKeys.setState({ install: { keyPath: opts.keyPath ?? null, paneId: opts.paneId ?? null } });
}

/** Connected SSH terminals (targets for installing a key). */
function useSshPanes() {
  const panes = useApp((s) => s.panes);
  return Object.values(panes).filter((p) => p.kind === "ssh" && p.status === "connected" && p.session?.alive);
}

// ------------------------------------------------------------------ settings section

export function SshKeysSection() {
  const keys = useKeys((s) => s.keys);
  const error = useKeys((s) => s.error);
  useEffect(() => void reloadKeys(), []);

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-foreground/90">{tr("SSH keys in ~/.ssh")}</span>
        <div className="flex gap-1">
          <Tooltip content={tr("Read ~/.ssh again")}>
            <Button size="icon-sm" variant="ghost" onClick={() => void reloadKeys()}>
              <RefreshCw className="size-3.5" />
            </Button>
          </Tooltip>
          <Button size="sm" variant="outline" onClick={openGenerateKey}>
            <Plus className="size-3.5" /> {tr("Generate key")}
          </Button>
        </div>
      </div>
      {error && <div className="text-[12px] text-destructive">{error}</div>}
      {keys && keys.length === 0 ? (
        <div className="rounded-lg border border-dashed border-ov/10 p-4 text-center text-[12px] text-muted-foreground">
          {tr("No keys yet. Generate one, install it on your servers, and log in without passwords.")}
        </div>
      ) : (
        <div className="grid gap-1">
          {(keys ?? []).map((k) => (
            <KeyRow key={k.path} k={k} />
          ))}
        </div>
      )}
    </div>
  );
}

function KeyRow({ k }: { k: KeyInfo }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <div className="flex items-center gap-2.5 rounded-lg border border-ov/[0.06] bg-ov/[0.02] px-2.5 py-2">
      <KeyRound className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 truncate text-[12.5px]">
          <span className="font-mono">{k.name}</span>
          <span className="rounded bg-ov/[0.08] px-1 text-[10px] text-muted-foreground">{k.algorithm}</span>
          {k.encrypted && (
            <span className="flex items-center gap-0.5 rounded bg-ov/[0.08] px-1 text-[10px] text-muted-foreground">
              <Lock className="size-2.5" /> {tr("passphrase")}
            </span>
          )}
          {!k.hasPrivate && <span className="rounded bg-warning/15 px-1 text-[10px] text-warning">{tr("public only")}</span>}
        </div>
        <div className="truncate font-mono text-[11px] text-muted-foreground">
          {k.fingerprint}
          {k.comment && ` · ${k.comment}`}
        </div>
      </div>
      <Tooltip content={copied ? tr("Copied") : tr("Copy the public key")}>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            void navigator.clipboard.writeText(k.publicKey);
            setCopied(true);
          }}
        >
          {copied ? <Check className="size-3.5 text-success" /> : <ClipboardCopy className="size-3.5" />}
        </Button>
      </Tooltip>
      <Tooltip content={tr("Install on a connected server (ssh-copy-id)")}>
        <Button variant="ghost" size="icon-sm" onClick={() => openInstallKey({ keyPath: k.path })}>
          <Upload className="size-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

// ------------------------------------------------------------------ dialogs

export function SshKeyDialogs() {
  return (
    <>
      <GenerateKeyDialog />
      <InstallKeyDialog />
    </>
  );
}

function GenerateKeyDialog() {
  const open = useKeys((s) => s.generateOpen);
  const keys = useKeys((s) => s.keys);
  const [name, setName] = useState("id_ed25519");
  const [comment, setComment] = useState("");
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    const taken = new Set((keys ?? []).map((k) => k.name));
    let n = "id_ed25519";
    for (let i = 2; taken.has(n); i++) n = `id_ed25519_${i}`;
    setName(n);
    setComment("");
    setPass("");
    setPass2("");
  }, [open, keys]);
  const close = () => useKeys.setState({ generateOpen: false });
  const nameOk = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name);
  const exists = (keys ?? []).some((k) => k.name === name);
  const mismatch = pass !== pass2;
  const valid = nameOk && !exists && !mismatch && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const k = await ipc.sshKeyGenerate(name, comment.trim(), pass || null);
      await reloadKeys();
      close();
      toast({
        kind: "success",
        title: tr("Created ~/.ssh/{0}", { 0: k.name }),
        description: k.fingerprint,
        action: { label: tr("Install on a server"), run: () => openInstallKey({ keyPath: k.path }) },
      });
    } catch (e) {
      toast({ kind: "error", title: tr("Could not create the key"), description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[min(440px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{tr("Generate an SSH key")}</DialogTitle>
          <DialogDescription>{tr("An ed25519 key pair in ~/.ssh, like ssh-keygen -t ed25519.")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field label={tr("File name")}>
            <Input autoFocus className="font-mono" value={name} onChange={(e) => setName(e.target.value.trim())} />
          </Field>
          {(!nameOk || exists) && (
            <p className="-mt-2 text-[11.5px] text-destructive">
              {exists ? tr("A key with this name already exists.") : tr("Letters, digits, '.', '_' and '-' only.")}
            </p>
          )}
          <Field label={tr("Comment")}>
            <Input placeholder={tr("e.g. me@laptop (optional)")} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label={tr("Passphrase")}>
              <Input type="password" placeholder={tr("optional")} value={pass} onChange={(e) => setPass(e.target.value)} />
            </Field>
            <Field label={tr("Repeat")}>
              <Input type="password" value={pass2} onChange={(e) => setPass2(e.target.value)} />
            </Field>
          </div>
          {mismatch && pass2 && <p className="-mt-2 text-[11.5px] text-destructive">{tr("The passphrases don't match.")}</p>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={!valid}>
              {busy ? tr("Generating…") : tr("Generate")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function InstallKeyDialog() {
  const install = useKeys((s) => s.install);
  const keys = useKeys((s) => s.keys) ?? [];
  const panes = useSshPanes();
  const profiles = useApp((s) => s.profiles);
  const [keyPath, setKeyPath] = useState<string | null>(null);
  const [paneId, setPaneId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"added" | "present" | null>(null);

  useEffect(() => {
    if (!install) return;
    setDone(null);
    setKeyPath(install.keyPath);
    setPaneId(install.paneId);
  }, [install]);
  // Defaults once the lists are known: the first key / the active terminal.
  useEffect(() => {
    if (install && !keyPath && keys.length) setKeyPath(keys.find((k) => k.hasPrivate)?.path ?? keys[0].path);
  }, [install, keyPath, keys]);
  useEffect(() => {
    if (!install || paneId || !panes.length) return;
    const st = useApp.getState();
    const active = st.tabs.find((t) => t.id === st.activeTabId)?.activePane;
    setPaneId(panes.find((p) => p.id === active)?.id ?? panes[0].id);
  }, [install, paneId, panes]);

  const close = () => useKeys.setState({ install: null });
  const key = keys.find((k) => k.path === keyPath);
  const pane = panes.find((p) => p.id === paneId);
  const profile = pane?.profileId ? profiles.find((p) => p.id === pane.profileId) : undefined;
  const sshProfile = profile?.kind === "ssh" ? profile : undefined;
  const usesKey = sshProfile?.auth.kind === "key" && sshProfile.auth.path === key?.path;

  const run = async () => {
    if (!key || !pane?.session?.sessionId) return;
    setBusy(true);
    try {
      setDone((await ipc.sshCopyId(pane.session.sessionId, key.publicKey)) as "added" | "present");
    } catch (e) {
      toast({ kind: "error", title: tr("Could not install the key"), description: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const useForSession = async () => {
    if (!sshProfile || !key) return;
    await useApp.getState().saveProfile({ ...sshProfile, auth: { kind: "key", path: key.path } });
    toast({ kind: "success", title: tr("{0} now logs in with {1}", { 0: sshProfile.name, 1: key.name }) });
    close();
  };

  return (
    <Dialog open={!!install} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[min(480px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{tr("Install a public key on a server")}</DialogTitle>
          <DialogDescription>
            {tr("Adds it to ~/.ssh/authorized_keys on the server (like ssh-copy-id), so you can log in with the key.")}
          </DialogDescription>
        </DialogHeader>
        {done ? (
          <div className="grid gap-3">
            <div className="flex items-start gap-2.5 rounded-lg border border-success/25 bg-success/10 p-3 text-[12.5px]">
              <Check className="mt-0.5 size-4 shrink-0 text-success" />
              <div>
                {tr(done === "added" ? "Key installed on {0}." : "The key was already installed on {0}.", { 0: pane?.subtitle || pane?.title })}
                {sshProfile && !usesKey && (
                  <div className="mt-1 text-muted-foreground">
                    {tr("The session “{0}” still logs in with {1}.", {
                      0: sshProfile.name,
                      1: sshProfile.auth.kind === "password" ? tr("a password") : sshProfile.auth.kind,
                    })}
                  </div>
                )}
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={close}>
                {tr("Close")}
              </Button>
              {sshProfile && !usesKey && (
                <Button onClick={() => void useForSession()}>
                  <KeyRound className="size-3.5" /> {tr("Log in with this key from now on")}
                </Button>
              )}
            </DialogFooter>
          </div>
        ) : (
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void run();
            }}
          >
            <Field label={tr("Key")}>
              {keys.length ? (
                <Select
                  value={keyPath}
                  onChange={setKeyPath}
                  options={keys.map((k) => ({ value: k.path, label: k.name, hint: k.algorithm }))}
                />
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  className="justify-self-start"
                  onClick={() => {
                    close();
                    openGenerateKey();
                  }}
                >
                  <Plus className="size-3.5" /> {tr("Generate a key first")}
                </Button>
              )}
            </Field>
            <Field label={tr("Server (a connected SSH terminal)")}>
              {panes.length ? (
                <Select
                  value={paneId}
                  onChange={setPaneId}
                  options={panes.map((p) => ({ value: p.id, label: p.title, hint: p.subtitle }))}
                />
              ) : (
                <div className="text-[12px] text-muted-foreground">{tr("Connect to the server first, then come back here.")}</div>
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {tr("Cancel")}
              </Button>
              <Button type="submit" disabled={!key || !pane || busy}>
                <Upload className="size-3.5" /> {busy ? tr("Installing…") : tr("Install")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
