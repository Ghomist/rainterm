// "Run container" dialog: start a container from an image, pre-filled from how earlier
// containers of that image were started (docker inspect: ports, env, mounts, restart
// policy, network, command). Arguments go to docker/podman as an array — no shell.
import { Play } from "lucide-react";
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
import { toast } from "@/lib/overlay";
import { Field } from "./dialogs";
import { tr } from "@/lib/i18n";

export interface RunSpec {
  image: string;
  name: string;
  ports: string;
  env: string;
  volumes: string;
  restart: string;
  network: string;
  command: string;
  extra: string;
}

interface Earlier {
  id: string;
  name: string;
}

interface RunDialogState {
  open: {
    image: string;
    tool: string;
    /** Containers made from this image (newest first), to copy settings from. */
    earlier: Earlier[];
    /** Pre-select this one (e.g. "Run a copy" of a container). */
    from?: string;
    exec: (args: string[]) => Promise<string>;
    onDone: () => void;
  } | null;
}
const useRunDialog = create<RunDialogState>(() => ({ open: null }));

export function openRunDialog(o: NonNullable<RunDialogState["open"]>) {
  useRunDialog.setState({ open: o });
}

const blank = (image: string): RunSpec => ({
  image,
  name: "",
  ports: "",
  env: "",
  volumes: "",
  restart: "unless-stopped",
  network: "",
  command: "",
  extra: "",
});

/** `docker inspect` of a container (+ its image) → the settings it was started with. */
async function specFrom(exec: (a: string[]) => Promise<string>, image: string, id: string): Promise<RunSpec> {
  const [c] = JSON.parse(await exec(["inspect", id])) as Any[];
  let img: Any = null;
  try {
    [img] = JSON.parse(await exec(["image", "inspect", c?.Config?.Image ?? image])) as Any[];
  } catch {
    /* image gone: keep everything */
  }
  const imgEnv = new Set<string>(img?.Config?.Env ?? []);
  const env = ((c?.Config?.Env ?? []) as string[]).filter((e) => !imgEnv.has(e));
  const ports: string[] = [];
  for (const [cport, binds] of Object.entries((c?.HostConfig?.PortBindings ?? {}) as Record<string, Any[] | null>)) {
    const [num, proto] = cport.split("/");
    for (const b of binds ?? []) {
      const ip = b.HostIp && b.HostIp !== "0.0.0.0" && b.HostIp !== "::" ? `${b.HostIp}:` : "";
      ports.push(`${ip}${b.HostPort || ""}${b.HostPort ? ":" : ""}${num}${proto && proto !== "tcp" ? `/${proto}` : ""}`);
    }
  }
  const imgCmd = JSON.stringify(img?.Config?.Cmd ?? null);
  const cmd = (c?.Config?.Cmd ?? null) as string[] | null;
  const net = c?.HostConfig?.NetworkMode as string | undefined;
  const restart = (c?.HostConfig?.RestartPolicy?.Name as string | undefined) || "no";
  return {
    image,
    name: "",
    ports: [...new Set(ports)].join("\n"),
    env: env.join("\n"),
    volumes: ((c?.HostConfig?.Binds ?? []) as string[]).join("\n"),
    restart,
    network: net && net !== "default" && net !== "bridge" ? net : "",
    command: cmd && JSON.stringify(cmd) !== imgCmd ? cmd.map(quoteArg).join(" ") : "",
    extra: c?.HostConfig?.Privileged ? "--privileged" : "",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: docker inspect JSON
type Any = any;

const quoteArg = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Split like a shell would (quotes and backslashes), without running anything. */
export function shellSplit(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let q: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === q) q = null;
      else if (ch === "\\" && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += ch;
    } else if (ch === "'" || ch === '"') {
      q = ch;
      has = true;
    } else if (ch === "\\" && i + 1 < s.length) {
      cur += s[++i];
      has = true;
    } else if (/\s/.test(ch)) {
      if (cur || has) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (cur || has) out.push(cur);
  return out;
}

export function runArgs(s: RunSpec): string[] {
  const lines = (t: string) =>
    t
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  const args = ["run", "-d"];
  if (s.name.trim()) args.push("--name", s.name.trim());
  for (const p of lines(s.ports)) args.push("-p", p);
  for (const e of lines(s.env)) args.push("-e", e);
  for (const v of lines(s.volumes)) args.push("-v", v);
  if (s.restart && s.restart !== "no") args.push("--restart", s.restart);
  if (s.network.trim()) args.push("--network", s.network.trim());
  args.push(...shellSplit(s.extra));
  args.push(s.image.trim(), ...shellSplit(s.command));
  return args;
}

export function RunContainerDialog() {
  const open = useRunDialog((s) => s.open);
  const [spec, setSpec] = useState<RunSpec>(blank(""));
  const [source, setSource] = useState<string>("");
  const [loadingFrom, setLoadingFrom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = () => useRunDialog.setState({ open: null });

  const load = async (from: string) => {
    if (!open) return;
    setSource(from);
    setError(null);
    if (!from) return setSpec((s) => ({ ...blank(open.image), name: s.name }));
    setLoadingFrom(true);
    try {
      const sp = await specFrom(open.exec, open.image, from);
      setSpec((s) => ({ ...sp, name: s.name }));
    } catch (e) {
      setError(`Couldn't read that container's settings: ${e instanceof Error ? e.message : e}`);
    } finally {
      setLoadingFrom(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setSpec(blank(open.image));
    setError(null);
    setBusy(false);
    const first = open.from ?? open.earlier[0]?.id ?? "";
    void load(first);
  }, [open]);

  const submit = async () => {
    if (!open || !spec.image.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const out = await open.exec(runArgs(spec));
      toast({ kind: "success", title: tr("Started {0}", { 0: spec.name.trim() || spec.image }), description: out.trim().slice(0, 12) });
      open.onDone();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const preview = open ? `${open.tool} ${runArgs(spec).map(quoteArg).join(" ")}` : "";
  const area =
    "min-h-[54px] w-full resize-y rounded-md border border-input bg-inset px-2.5 py-1.5 font-mono text-[12px] leading-relaxed outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-muted-foreground/50 focus-visible:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring/40";

  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="max-h-[calc(100vh-4rem)] max-w-[min(600px,calc(100%-2rem))] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tr("Run a container")}</DialogTitle>
          <DialogDescription>
            {open?.earlier.length
              ? tr("Pre-filled from an earlier container of this image — check it before starting.")
              : tr("Starts detached (-d). One port / variable / mount per line.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-[1fr_200px] gap-2">
            <Field label={tr("Image")}>
              <Input value={spec.image} onChange={(e) => setSpec({ ...spec, image: e.target.value })} className="font-mono text-[12px]" />
            </Field>
            <Field label={tr("Name")}>
              <Input autoFocus placeholder={tr("optional")} value={spec.name} onChange={(e) => setSpec({ ...spec, name: e.target.value })} />
            </Field>
          </div>
          {open && open.earlier.length > 0 && (
            <Field label={loadingFrom ? tr("Copy settings from… (reading)") : tr("Copy settings from")}>
              <Select<string>
                value={source}
                onChange={(v) => void load(v)}
                options={[
                  ...open.earlier.map((c) => ({ value: c.id, label: c.name, hint: c.id.slice(0, 12) })),
                  { value: "", label: tr("Nothing — image defaults only") },
                ]}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-2">
            <Field label={tr("Ports (host:container)")}>
              <textarea
                className={area}
                rows={2}
                spellCheck={false}
                placeholder={"8080:80\n127.0.0.1:5432:5432"}
                value={spec.ports}
                onChange={(e) => setSpec({ ...spec, ports: e.target.value })}
              />
            </Field>
            <Field label={tr("Mounts (host:container[:ro])")}>
              <textarea
                className={area}
                rows={2}
                spellCheck={false}
                placeholder={tr("/srv/data:/data\nmyvolume:/var/lib/x")}
                value={spec.volumes}
                onChange={(e) => setSpec({ ...spec, volumes: e.target.value })}
              />
            </Field>
          </div>
          <Field label={tr("Environment (KEY=value)")}>
            <textarea
              className={area}
              rows={3}
              spellCheck={false}
              placeholder={tr("TZ=Asia/Shanghai\nPOSTGRES_PASSWORD=…")}
              value={spec.env}
              onChange={(e) => setSpec({ ...spec, env: e.target.value })}
            />
          </Field>
          <div className="grid grid-cols-[160px_1fr] gap-2">
            <Field label={tr("Restart")}>
              <Select<string>
                value={spec.restart}
                onChange={(restart) => setSpec({ ...spec, restart })}
                options={["no", "unless-stopped", "always", "on-failure"].map((v) => ({ value: v, label: v }))}
              />
            </Field>
            <Field label={tr("Network")}>
              <Input placeholder={tr("default bridge")} value={spec.network} onChange={(e) => setSpec({ ...spec, network: e.target.value })} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Field label={tr("Command (overrides the image's)")}>
              <Input placeholder={tr("optional")} value={spec.command} onChange={(e) => setSpec({ ...spec, command: e.target.value })} className="font-mono text-[12px]" />
            </Field>
            <Field label={tr("Extra options")}>
              <Input placeholder={tr("--memory 512m --cpus 1")} value={spec.extra} onChange={(e) => setSpec({ ...spec, extra: e.target.value })} className="font-mono text-[12px]" />
            </Field>
          </div>
          <pre className="max-h-24 overflow-auto rounded-md bg-inset px-2.5 py-1.5 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground select-text">
            {preview}
          </pre>
          {error && <div className="rounded-md bg-destructive/10 px-2.5 py-1.5 text-[12px] break-words text-destructive">{error}</div>}
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close}>
              {tr("Cancel")}
            </Button>
            <Button type="submit" disabled={busy || !spec.image.trim()}>
              <Play className="size-3.5" /> {busy ? tr("Starting…") : tr("Run")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
