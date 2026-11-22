import { KeyRound, Plus, RefreshCw, ShieldAlert, Trash2 } from "lucide-react";
import * as React from "react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ComboInput, NumberInput, Select, Switch } from "@/components/ui/controls";
import { Input, Label } from "@/components/ui/input";
import { type Forward, type ForwardKind, ipc, type PortInfo } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { allGroups, type Profile, type SerialProfile, type SshProfile, useApp } from "@/store/app";
import { Tooltip } from "@/components/ui/tooltip";
import { ProxyEditorDialog, ProxyPicker } from "./proxy";
import { tr } from "@/lib/i18n";

export function Dialogs() {
  return (
    <>
      <ProfileEditor />
      <SecretPrompt />
      <HostKeyDialog />
      <ProxyEditorDialog />
    </>
  );
}

// ------------------------------------------------------------------ shared bits

export function Field({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="grid gap-1 rounded-lg bg-inset p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cn(
            "h-7 rounded-md text-[12.5px] transition",
            value === o.value
              ? "bg-ov/10 text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Check({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
}) {
  const id = React.useId();
  return (
    <div className="flex min-h-7 items-center justify-between gap-4 text-[12.5px] text-foreground/90">
      <label htmlFor={id} className="cursor-default leading-snug">
        {children}
      </label>
      <Switch id={id} checked={checked} onChange={onChange} />
    </div>
  );
}

// ------------------------------------------------------------------ profile editor

const blankSsh = (): SshProfile => ({
  kind: "ssh",
  id: crypto.randomUUID(),
  name: "",
  group: "",
  host: "",
  port: 22,
  user: "root",
  auth: { kind: "auto" },
  jumpId: null,
  forwards: [],
  remember: false,
});

const blankSerial = (): SerialProfile => ({
  kind: "serial",
  id: crypto.randomUUID(),
  name: "",
  group: "",
  target: { port: "", baud: 115200, dataBits: 8, parity: "none", stopBits: 1 },
});

function ProfileEditor() {
  const editor = useApp((s) => s.profileEditor);
  const profiles = useApp((s) => s.profiles);
  const set = useApp((s) => s.set);
  const saveProfile = useApp((s) => s.saveProfile);
  const connect = useApp((s) => s.connect);
  const [p, setP] = useState<Profile>(blankSsh);
  const groupOrder = useApp((s) => s.settings.profileGroups);
  const groupNames = allGroups(groupOrder ?? [], profiles);

  useEffect(() => {
    if (!editor) return;
    if (editor.profile) setP(structuredClone(editor.profile));
    else setP({ ...(editor.kind === "serial" ? blankSerial() : blankSsh()), group: editor.group ?? "" });
  }, [editor]);

  const valid =
    p.kind === "ssh"
      ? !!p.host.trim() && !!p.user.trim() && p.port > 0 && (p.auth.kind !== "key" || !!p.auth.path)
      : !!p.target.port && p.target.baud > 0;

  const submit = async (andConnect: boolean) => {
    if (!valid) return;
    const profile: Profile =
      p.kind === "ssh"
        ? { ...p, name: p.name.trim() || p.host.trim(), host: p.host.trim() }
        : { ...p, name: p.name.trim() || p.target.port };
    await saveProfile(profile);
    set({ profileEditor: null });
    if (andConnect) void connect(profile);
  };

  const isNew = !editor?.profile;

  return (
    <Dialog open={!!editor} onOpenChange={(o) => !o && set({ profileEditor: null })}>
      <DialogContent className="max-h-[calc(100vh-4rem)] max-w-[min(520px,calc(100%-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? (p.kind === "ssh" ? tr("New SSH session") : tr("New serial session")) : p.kind === "ssh" ? tr("Edit SSH session") : tr("Edit serial session")}
          </DialogTitle>
          <DialogDescription>
            {p.kind === "ssh"
              ? tr("You'll be asked for a password when connecting, if the server needs one.")
              : tr("Connect to a serial device (COM port / tty).")}
          </DialogDescription>
        </DialogHeader>
        {isNew && (
          <Segmented
            value={p.kind}
            options={[
              { value: "ssh", label: tr("SSH") },
              { value: "serial", label: tr("Serial") },
            ]}
            onChange={(k) => setP(k === "ssh" ? blankSsh() : blankSerial())}
          />
        )}
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          {p.kind === "ssh" ? (
            <SshFields p={p} setP={setP} profiles={profiles} />
          ) : (
            <SerialFields p={p} setP={setP} />
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label={tr("Name")}>
              <Input
                placeholder={tr("optional")}
                value={p.name}
                onChange={(e) => setP({ ...p, name: e.target.value })}
              />
            </Field>
            <Field label={tr("Group")}>
              <ComboInput
                placeholder={tr("none, or e.g. Production")}
                value={p.group ?? ""}
                onChange={(v) => setP({ ...p, group: v })}
                options={groupNames.map((g) => ({ value: g, label: g }))}
              />
            </Field>
          </div>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => set({ profileEditor: null })}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={!valid}>
              {tr("Save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SshFields({
  p,
  setP,
  profiles,
}: {
  p: SshProfile;
  setP: (p: Profile) => void;
  profiles: Profile[];
}) {
  const keyPath = p.auth.kind === "key" ? p.auth.path : "";
  const jumpCandidates = profiles.filter((x) => x.kind === "ssh" && x.id !== p.id);
  return (
    <>
      <div className="grid grid-cols-[1fr_88px] gap-2">
        <Field label={tr("Host")}>
          <Input
            autoFocus
            placeholder={tr("example.com")}
            value={p.host}
            onChange={(e) => setP({ ...p, host: e.target.value })}
          />
        </Field>
        <Field label={tr("Port")}>
          <NumberInput value={p.port} min={1} max={65535} onChange={(port) => setP({ ...p, port })} />
        </Field>
      </div>
      <Field label={tr("Username")}>
        <Input value={p.user} onChange={(e) => setP({ ...p, user: e.target.value })} />
      </Field>
      <Field label={tr("Authentication")}>
        <Segmented
          value={p.auth.kind}
          options={[
            { value: "auto", label: tr("Auto") },
            { value: "password", label: tr("Password") },
            { value: "key", label: tr("Key file") },
            { value: "agent", label: tr("Agent") },
          ]}
          onChange={(k) =>
            setP({
              ...p,
              auth:
                k === "key"
                  ? { kind: "key", path: "~/.ssh/id_ed25519" }
                  : k === "agent"
                    ? { kind: "agent" }
                    : k === "auto"
                      ? { kind: "auto" }
                      : { kind: "password" },
            })
          }
        />
      </Field>
      {p.auth.kind === "auto" && (
        <p className="-mt-1 text-[11.5px] text-muted-foreground">
          {tr("Tries your SSH agent, then ~/.ssh/id_ed25519 / id_ecdsa / id_rsa, then asks for a password — like the ssh command.")}
        </p>
      )}
      {p.auth.kind === "key" && (
        <Field label={tr("Private key path")}>
          <Input
            value={keyPath}
            onChange={(e) => setP({ ...p, auth: { kind: "key", path: e.target.value } })}
          />
        </Field>
      )}
      {p.remember && p.auth.kind !== "agent" && (
        <div className="-mt-1 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          <KeyRound className="size-3.5" />
          <span className="flex-1">{p.auth.kind === "key" ? tr("Passphrase") : tr("Password")} {tr("saved in the OS keychain")}</span>
          <button
            type="button"
            className="transition-colors hover:text-foreground"
            onClick={() => setP({ ...p, remember: false })}
          >
            {tr("Forget")}
          </button>
        </div>
      )}
      <Field label={tr("Jump host (ProxyJump)")}>
        <Select<string | null>
          value={p.jumpId ?? null}
          onChange={(jumpId) => setP({ ...p, jumpId })}
          options={[
            { value: null, label: tr("None — connect directly") },
            ...jumpCandidates.map((j) => ({
              value: j.id,
              label: j.name,
              hint: j.kind === "ssh" ? `${j.user}@${j.host}` : undefined,
            })),
          ]}
        />
      </Field>
      <Field label={tr("Proxy")}>
        <ProxyPicker value={p.proxy ?? null} onChange={(proxy) => setP({ ...p, proxy })} />
      </Field>
      <Field label={tr("Port forwarding")}>
        <ForwardsEditor value={p.forwards} onChange={(forwards) => setP({ ...p, forwards })} />
      </Field>
    </>
  );
}

function SerialFields({ p, setP }: { p: SerialProfile; setP: (p: Profile) => void }) {
  const [ports, setPorts] = useState<PortInfo[]>([]);
  const refresh = () => void ipc.listSerialPorts().then(setPorts, () => setPorts([]));
  useEffect(refresh, []);
  const t = p.target;
  const upd = (patch: Partial<SerialProfile["target"]>) =>
    setP({ ...p, target: { ...t, ...patch } });
  return (
    <>
      <Field label={tr("Port")}>
        <div className="flex gap-1.5">
          <ComboInput
            placeholder={navigator.userAgent.includes("Windows") ? tr("COM3") : tr("/dev/ttyUSB0")}
            value={t.port}
            onChange={(port) => upd({ port })}
            options={ports.map((x) => ({ value: x.name, label: x.name, hint: x.description }))}
          />
          <Button type="button" variant="ghost" size="icon" onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
        {ports.length > 0 && (
          <div className="text-[11px] text-muted-foreground">
            {tr("Found:")}{" "}{ports.map((x) => `${x.name}${x.description ? ` (${x.description})` : ""}`).join(", ")}
          </div>
        )}
      </Field>
      <div className="grid grid-cols-4 gap-2">
        <Field label={tr("Baud")}>
          <ComboInput
            numeric
            value={String(t.baud || "")}
            onChange={(v) => upd({ baud: Number(v) || 0 })}
            options={[9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600].map((b) => ({
              value: String(b),
              label: String(b),
            }))}
          />
        </Field>
        <Field label={tr("Data bits")}>
          <Select
            value={t.dataBits}
            onChange={(dataBits) => upd({ dataBits })}
            options={[8, 7, 6, 5].map((b) => ({ value: b, label: String(b) }))}
          />
        </Field>
        <Field label={tr("Parity")}>
          <Select<SerialProfile["target"]["parity"]>
            value={t.parity}
            onChange={(parity) => upd({ parity })}
            options={[
              { value: "none", label: tr("None") },
              { value: "odd", label: tr("Odd") },
              { value: "even", label: tr("Even") },
            ]}
          />
        </Field>
        <Field label={tr("Stop bits")}>
          <Select
            value={t.stopBits}
            onChange={(stopBits) => upd({ stopBits })}
            options={[
              { value: 1, label: "1" },
              { value: 2, label: "2" },
            ]}
          />
        </Field>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ secret prompt

function SecretPrompt() {
  const prompt = useApp((s) => s.secretPrompt);
  const answer = useApp((s) => s.answerSecret);
  const [value, setValue] = useState("");
  const [remember, setRemember] = useState(false);

  useEffect(() => {
    setValue("");
    setRemember(!!prompt?.remembered);
  }, [prompt]);
  const isPass = prompt?.kind.toLowerCase().includes("passphrase");
  const retry = prompt?.message.toLowerCase().includes("wrong");

  return (
    <Dialog open={!!prompt} onOpenChange={(o) => !o && void answer(null, false)}>
      <DialogContent className="max-w-[min(380px,calc(100%-2rem))]">
        <DialogHeader>
          <div
            className={cn(
              "mb-1 flex size-9 items-center justify-center rounded-lg",
              retry ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
            )}
          >
            <KeyRound className="size-4.5" />
          </div>
          <DialogTitle>{isPass ? tr("Key passphrase") : tr("Password")}</DialogTitle>
          <DialogDescription className="truncate">
            {retry ? `${prompt?.message.replace(/Wrong (password|passphrase), try again/, (m) => tr(m))} — ` : ""}
            {prompt?.label}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void answer(value, remember);
          }}
        >
          <Input autoFocus type="password" value={value} onChange={(e) => setValue(e.target.value)} />
          {prompt?.canRemember && (
            <Check checked={remember} onChange={setRemember}>
              {tr("Remember in the OS keychain")}
            </Check>
          )}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => void answer(null, false)}>
              {tr("Cancel")}
            </Button>
            <Button type="submit">{tr("Connect")}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------------ host key

function HostKeyDialog() {
  const prompt = useApp((s) => s.hostKeyPrompt);
  const answer = useApp((s) => s.answerHostKey);

  return (
    <Dialog open={!!prompt} onOpenChange={(o) => !o && answer(false)}>
      <DialogContent showClose={false} className="max-w-[min(480px,calc(100%-2rem))]">
        <DialogHeader>
          <div
            className={cn(
              "mb-1 flex size-9 items-center justify-center rounded-lg",
              prompt?.changed ? "bg-destructive/15 text-destructive" : "bg-warning/15 text-warning",
            )}
          >
            <ShieldAlert className="size-4.5" />
          </div>
          <DialogTitle>{prompt?.changed ? tr("Host key changed") : tr("Unknown host")}</DialogTitle>
          <DialogDescription>
            {prompt?.changed ? (
              <>
                <span className="text-foreground">
                  {prompt.host}:{prompt.port}
                </span>{" "}
                {tr("presents a different key than the one saved in known_hosts. That's expected after the server was reinstalled or its keys regenerated — otherwise someone may be intercepting the connection. Only continue if you know why it changed.")}</>
            ) : (
              <>
                {tr("The authenticity of")}{" "}
                <span className="text-foreground">
                  {prompt?.host}:{prompt?.port}
                </span>{" "}
                {tr("can't be established. Verify the fingerprint before trusting it.")}</>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-1 rounded-lg bg-inset p-3 font-mono text-[12px]">
          <span className="text-muted-foreground">{prompt?.keyType}</span>
          <span className="break-all text-foreground select-text">{prompt?.fingerprint}</span>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => answer(false)}>
            {tr("Cancel")}
          </Button>
          {prompt?.changed ? (
            <Button variant="destructive" onClick={() => answer(true)}>
              {tr("Replace key & connect")}
            </Button>
          ) : (
            <Button autoFocus onClick={() => answer(true)}>
              {tr("Trust & Connect")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const FORWARD_KINDS: { value: ForwardKind; label: string; hint: string }[] = [
  { value: "local", label: "Local  -L", hint: "A port here reaches a host:port from the server" },
  { value: "remote", label: "Remote  -R", hint: "A port on the server reaches a host:port from here" },
  { value: "dynamic", label: "SOCKS  -D", hint: "A SOCKS5 proxy here; traffic leaves from the server" },
];

/** -L / -R / -D rules of an SSH session (started with every connection). */
function ForwardsEditor({ value, onChange }: { value: Forward[]; onChange: (v: Forward[]) => void }) {
  const set = (i: number, patch: Partial<Forward>) => onChange(value.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const port = (v: number | null | undefined) => v || null;
  return (
    <div className="grid gap-1.5">
      {value.map((f, i) => {
        const kind = f.kind ?? "local";
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
          <div key={i} className="grid grid-cols-[112px_minmax(0,1fr)_auto] items-center gap-1.5">
            <Select
              value={kind}
              onChange={(k) => set(i, { kind: k })}
              options={FORWARD_KINDS.map((k) => ({ value: k.value, label: tr(k.label), hint: tr(k.hint) }))}
            />
            {kind === "dynamic" ? (
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{tr("SOCKS5 on 127.0.0.1 :")}</span>
                <NumberInput placeholder="1080" min={1} max={65535} value={port(f.localPort)} onChange={(localPort) => set(i, { localPort })} />
              </div>
            ) : kind === "remote" ? (
              <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_76px_auto_minmax(0,1fr)_76px] items-center gap-1">
                <Tooltip content={tr("Address the server listens on (127.0.0.1 = only the server itself)")}>
                  <Input placeholder="127.0.0.1" value={f.remoteHost} onChange={(e) => set(i, { remoteHost: e.target.value })} />
                </Tooltip>
                <NumberInput placeholder={tr("server port")} min={0} max={65535} value={port(f.remotePort)} onChange={(remotePort) => set(i, { remotePort })} />
                <span className="text-muted-foreground">→</span>
                <Input placeholder="127.0.0.1" value={f.localHost ?? "127.0.0.1"} onChange={(e) => set(i, { localHost: e.target.value })} />
                <NumberInput placeholder={tr("local port")} min={1} max={65535} value={port(f.localPort)} onChange={(localPort) => set(i, { localPort })} />
              </div>
            ) : (
              <div className="grid min-w-0 grid-cols-[76px_auto_minmax(0,1fr)_76px] items-center gap-1">
                <NumberInput placeholder={tr("local")} min={0} max={65535} value={port(f.localPort)} onChange={(localPort) => set(i, { localPort })} />
                <span className="text-muted-foreground">→</span>
                <Input placeholder={tr("remote host")} value={f.remoteHost} onChange={(e) => set(i, { remoteHost: e.target.value })} />
                <NumberInput placeholder={tr("port")} min={0} max={65535} value={port(f.remotePort)} onChange={(remotePort) => set(i, { remotePort })} />
              </div>
            )}
            <Button type="button" variant="ghost" size="icon-sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap gap-1.5">
        {FORWARD_KINDS.map((k) => (
          <Button
            key={k.value}
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              onChange([
                ...value,
                k.value === "dynamic"
                  ? { kind: "dynamic", localPort: 1080, remoteHost: "", remotePort: 0 }
                  : k.value === "remote"
                    ? { kind: "remote", localPort: 0, remoteHost: "127.0.0.1", remotePort: 0, localHost: "127.0.0.1" }
                    : { kind: "local", localPort: 0, remoteHost: "127.0.0.1", remotePort: 0 },
              ])
            }
          >
            <Plus className="size-3.5" /> {tr(k.label).split(/\s+/)[0]}
          </Button>
        ))}
      </div>
    </div>
  );
}
