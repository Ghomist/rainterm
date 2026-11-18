// Saved proxies: one editor dialog (used from Settings and the session editor), a picker
// for sessions, and the Settings → Network section.
import { Globe, Pencil, Plus, Trash2, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { NumberInput, Select } from "@/components/ui/controls";
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
import { ipc } from "@/lib/ipc";
import { confirm, toast } from "@/lib/overlay";
import { type ProxyDef, proxyLabel } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { proxySecretKey, useApp } from "@/store/app";
import { Field, Segmented } from "./dialogs";

// ------------------------------------------------------------------ editor state

interface EditorState {
  open: { proxy: ProxyDef | null; onSaved?: (id: string) => void } | null;
}
const useProxyEditor = create<EditorState>(() => ({ open: null }));

/** Open the proxy dialog: edit `proxy`, or create a new one. `onSaved` gets the id. */
export function editProxy(proxy: ProxyDef | null, onSaved?: (id: string) => void) {
  useProxyEditor.setState({ open: { proxy, onSaved } });
}

export async function deleteProxy(p: ProxyDef) {
  const st = useApp.getState();
  const users = st.profiles.filter((x) => x.kind === "ssh" && x.proxy === p.id);
  const ok = await confirm({
    title: `Delete proxy “${proxyLabel(p)}”?`,
    message: users.length
      ? `${users.length} session${users.length > 1 ? "s use" : " uses"} it; they'll switch to the default proxy setting.`
      : undefined,
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  for (const u of users) if (u.kind === "ssh") await st.saveProfile({ ...u, proxy: null });
  const s = useApp.getState().settings;
  await st.updateSettings({
    proxies: s.proxies.filter((x) => x.id !== p.id),
    globalProxy: s.globalProxy === p.id ? null : s.globalProxy,
  });
  await ipc.secretDelete(proxySecretKey(p.id)).catch(() => {});
}

const blank = (): ProxyDef => ({
  id: crypto.randomUUID(),
  name: "",
  kind: "socks5",
  host: "127.0.0.1",
  port: 1080,
  user: "",
  hasPassword: false,
});

const TEST_HOST = "github.com";
const TEST_PORT = 22;

export function ProxyEditorDialog() {
  const open = useProxyEditor((s) => s.open);
  const proxies = useApp((s) => s.settings.proxies);
  const updateSettings = useApp((s) => s.updateSettings);
  const [p, setP] = useState<ProxyDef>(blank);
  const [password, setPassword] = useState("");
  const [clearPw, setClearPw] = useState(false);
  const [test, setTest] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });

  useEffect(() => {
    if (!open) return;
    setP(open.proxy ? { ...open.proxy } : blank());
    setPassword("");
    setClearPw(false);
    setTest({ busy: false });
  }, [open]);

  const close = () => useProxyEditor.setState({ open: null });
  const valid = !!p.host.trim() && p.port > 0;
  const isNew = !open?.proxy;

  const spec = async () => ({
    kind: p.kind,
    host: p.host.trim(),
    port: p.port,
    user: p.user.trim() || null,
    password: password || (p.hasPassword && !clearPw ? await ipc.secretGet(proxySecretKey(p.id)).catch(() => null) : null),
  });

  const runTest = async () => {
    setTest({ busy: true });
    try {
      const ms = await ipc.proxyTest(await spec(), TEST_HOST, TEST_PORT);
      setTest({ busy: false, ok: true, text: `Works — reached ${TEST_HOST}:${TEST_PORT} in ${ms} ms` });
    } catch (e) {
      setTest({ busy: false, ok: false, text: String(e) });
    }
  };

  const submit = async () => {
    if (!valid) return;
    const def: ProxyDef = {
      ...p,
      name: p.name.trim(),
      host: p.host.trim(),
      user: p.user.trim(),
      hasPassword: password ? true : clearPw ? false : p.hasPassword,
    };
    try {
      if (password) await ipc.secretSet(proxySecretKey(def.id), password);
      else if (clearPw) await ipc.secretDelete(proxySecretKey(def.id)).catch(() => {});
    } catch (e) {
      toast({ kind: "error", title: "Couldn't save the password in the keychain", description: String(e) });
      return;
    }
    const list = useApp.getState().settings.proxies;
    await updateSettings({
      proxies: list.some((x) => x.id === def.id) ? list.map((x) => (x.id === def.id ? def : x)) : [...list, def],
    });
    open?.onSaved?.(def.id);
    close();
  };

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-w-[min(440px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle>{isNew ? "New proxy" : "Edit proxy"}</DialogTitle>
          <DialogDescription>
            {isNew && proxies.length === 0
              ? "Saved proxies can be reused by any session, or set as the default in Settings."
              : "The password is kept in the OS keychain."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Segmented
            value={p.kind}
            options={[
              { value: "socks5", label: "SOCKS5" },
              { value: "http", label: "HTTP (CONNECT)" },
            ]}
            onChange={(kind) =>
              setP({
                ...p,
                kind,
                port: p.port === 1080 && kind === "http" ? 8080 : p.port === 8080 && kind === "socks5" ? 1080 : p.port,
              })
            }
          />
          <div className="grid grid-cols-[1fr_88px] gap-2">
            <Field label="Host">
              <Input autoFocus value={p.host} onChange={(e) => setP({ ...p, host: e.target.value })} />
            </Field>
            <Field label="Port">
              <NumberInput value={p.port} min={1} max={65535} onChange={(port) => setP({ ...p, port })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label="Username">
              <Input placeholder="optional" value={p.user} onChange={(e) => setP({ ...p, user: e.target.value })} />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                placeholder={p.hasPassword && !clearPw ? "saved — type to change" : "optional"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </Field>
          </div>
          {p.hasPassword && !clearPw && !password && (
            <button
              type="button"
              onClick={() => setClearPw(true)}
              className="-mt-1.5 justify-self-end text-[11.5px] text-muted-foreground transition-colors hover:text-foreground"
            >
              Forget saved password
            </button>
          )}
          <Field label="Name">
            <Input
              placeholder={proxyLabel({ ...p, name: "" })}
              value={p.name}
              onChange={(e) => setP({ ...p, name: e.target.value })}
            />
          </Field>
          {test.text && (
            <div
              className={cn(
                "rounded-md px-2.5 py-1.5 text-[11.5px] break-words",
                test.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
              )}
            >
              {test.text}
            </div>
          )}
          <DialogFooter className="items-center">
            <Tooltip content={`Connects to ${TEST_HOST}:${TEST_PORT} through the proxy`}>
              <Button type="button" variant="ghost" className="mr-auto" disabled={!valid || test.busy} onClick={() => void runTest()}>
                <Zap className={cn("size-3.5", test.busy && "animate-pulse")} /> {test.busy ? "Testing…" : "Test"}
              </Button>
            </Tooltip>
            <Button type="button" variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ picker

/**
 * Session proxy picker. `value`: a proxy id, "direct", or null/"" = the global default.
 * `allowDefault` false (Settings' global choice) leaves out the "default" entry.
 */
export function ProxyPicker({
  value,
  onChange,
  allowDefault = true,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  allowDefault?: boolean;
}) {
  const proxies = useApp((s) => s.settings.proxies);
  const globalId = useApp((s) => s.settings.globalProxy);
  const global = proxies.find((x) => x.id === globalId);
  const current = proxies.find((x) => x.id === value);
  const v = allowDefault ? (value && (value === "direct" || current) ? value : null) : (current?.id ?? null);
  return (
    <div className="flex gap-1.5">
      <Select<string | null>
        value={v}
        onChange={onChange}
        options={[
          ...(allowDefault
            ? [{ value: null, label: "Default", hint: global ? proxyLabel(global) : "direct" }]
            : []),
          { value: allowDefault ? "direct" : null, label: "None — connect directly" },
          ...proxies.map((x) => ({
            value: x.id,
            label: proxyLabel(x),
            hint: x.name ? `${x.kind === "http" ? "HTTP" : "SOCKS5"} ${x.host}:${x.port}` : undefined,
          })),
        ]}
      />
      {current && (
        <Tooltip content="Edit this proxy">
          <Button type="button" variant="ghost" size="icon" onClick={() => editProxy(current)}>
            <Pencil className="size-3.5" />
          </Button>
        </Tooltip>
      )}
      <Tooltip content="New proxy…">
        <Button type="button" variant="ghost" size="icon" onClick={() => editProxy(null, (id) => onChange(id))}>
          <Plus className="size-3.5" />
        </Button>
      </Tooltip>
    </div>
  );
}

// ------------------------------------------------------------------ settings section

export function NetworkSection() {
  const proxies = useApp((s) => s.settings.proxies);
  const globalProxy = useApp((s) => s.settings.globalProxy);
  const updateSettings = useApp((s) => s.updateSettings);
  const profiles = useApp((s) => s.profiles);
  const uses = (id: string) => profiles.filter((p) => p.kind === "ssh" && p.proxy === id).length;

  return (
    <>
      <Field label="Default proxy for SSH">
        <ProxyPicker value={globalProxy} allowDefault={false} onChange={(v) => void updateSettings({ globalProxy: v })} />
      </Field>
      <p className="-mt-2 text-[12px] text-muted-foreground">
        Used by every SSH session (and quick connect) that doesn't pick its own proxy. Through a jump host,
        only the jump host's connection goes through a proxy.
      </p>
      <div className="grid gap-2">
        <div className="flex items-center justify-between">
          <span className="text-[12px] font-medium text-foreground/90">Saved proxies</span>
          <Button size="sm" variant="outline" onClick={() => editProxy(null)}>
            <Plus className="size-3.5" /> Add proxy
          </Button>
        </div>
        {proxies.length === 0 ? (
          <div className="rounded-lg border border-dashed border-ov/10 p-4 text-center text-[12px] text-muted-foreground">
            No proxies yet. Add a SOCKS5 or HTTP proxy to reuse it in your sessions.
          </div>
        ) : (
          <div className="grid gap-1">
            {proxies.map((p) => {
              const n = uses(p.id);
              return (
                <div
                  key={p.id}
                  className="group flex items-center gap-2.5 rounded-lg border border-ov/[0.06] bg-ov/[0.02] px-2.5 py-2"
                >
                  <Globe className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5 truncate text-[12.5px]">
                      {proxyLabel(p)}
                      {globalProxy === p.id && (
                        <span className="rounded bg-primary/15 px-1 text-[10px] font-medium text-primary">default</span>
                      )}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {p.kind === "http" ? "HTTP" : "SOCKS5"} {p.user ? `${p.user}@` : ""}
                      {p.host}:{p.port}
                      {n > 0 && ` · used by ${n} session${n > 1 ? "s" : ""}`}
                    </div>
                  </div>
                  <Button variant="ghost" size="icon-sm" onClick={() => editProxy(p)}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void deleteProxy(p)}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
