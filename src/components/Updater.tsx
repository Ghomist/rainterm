// Update UI: the title-bar badge when a new version is out, the update dialog (notes,
// download progress, install) and the "About & updates" settings section.
import { ArrowUpCircle, CheckCircle2, Download, ExternalLink, LoaderCircle, RefreshCw, TriangleAlert } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RichMarkdown } from "@/components/ui/markdown";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip } from "@/components/ui/tooltip";
import { tr } from "@/lib/i18n";
import { checkForUpdate, installUpdate, useUpdate, useUpdateBadge } from "@/lib/updater";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import logo from "../../src-tauri/icons/128x128.png";

const RELEASES = "https://github.com/Ghomist/rainterm/releases";
const openUrl = (u: string) => void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(u));

function mb(n: number) {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Title bar: shows up only when there is something to install. */
export function UpdateBadge() {
  const version = useUpdateBadge();
  const phase = useUpdate((s) => s.phase);
  const done = useUpdate((s) => s.done);
  const total = useUpdate((s) => s.total);
  if (!version) return null;
  const busy = phase === "downloading" || phase === "installing";
  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <Tooltip content={busy ? tr("Downloading the update") : tr("rainterm {0} is available", { 0: version })}>
      <motion.button
        type="button"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        onClick={() => useUpdate.setState({ open: true })}
        className="press relative mr-1 flex h-6 items-center gap-1 overflow-hidden rounded-full bg-primary/15 px-2.5 text-[11.5px] font-medium text-primary hover:bg-primary/25 [&_svg]:size-3.5"
      >
        {busy && <span className="absolute inset-y-0 left-0 bg-primary/20 transition-[width]" style={{ width: `${pct}%` }} />}
        <span className="relative flex items-center gap-1">
          {busy ? <LoaderCircle className="animate-spin" /> : <ArrowUpCircle />}
          {busy ? (total ? `${pct}%` : tr("Updating…")) : tr("Update")}
        </span>
      </motion.button>
    </Tooltip>
  );
}

/** Mounted once (App). */
export function UpdateDialog() {
  const s = useUpdate();
  const skip = () => {
    void useApp.getState().updateSettings({ skipVersion: s.version });
    useUpdate.setState({ open: false });
  };
  const busy = s.phase === "downloading" || s.phase === "installing" || s.phase === "ready";
  const pct = s.total ? Math.min(100, (s.done / s.total) * 100) : 0;
  return (
    <Dialog open={s.open} onOpenChange={(o) => !busy && useUpdate.setState({ open: o })}>
      <DialogContent className="flex max-h-[min(640px,calc(100vh-4rem))] max-w-[min(560px,calc(100%-2rem))] flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ArrowUpCircle className="size-4.5 text-primary" />
            {s.version ? tr("rainterm {0} is available", { 0: s.version }) : tr("Updates")}
          </DialogTitle>
          <DialogDescription>
            {s.version
              ? [tr("You have {0}.", { 0: s.current }), s.date ? tr("Released {0}.", { 0: new Date(s.date).toLocaleDateString() }) : ""].join(" ").trim()
              : tr("You have {0}.", { 0: s.current })}
          </DialogDescription>
        </DialogHeader>

        {s.notes.trim() && (
          <ScrollArea className="min-h-0 flex-1 rounded-lg border border-ov/[0.06] bg-inset/50" viewportClassName="max-h-[320px] px-4 py-3">
            <div className="mb-1 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">{tr("What's new")}</div>
            <RichMarkdown text={s.notes} compact />
          </ScrollArea>
        )}

        {busy && (
          <div className="grid gap-1.5">
            <div className="h-1.5 overflow-hidden rounded-full bg-ov/[0.08]">
              <div
                className={cn("h-full rounded-full bg-primary transition-[width] duration-200", !s.total && s.phase === "downloading" && "w-1/3 animate-pulse")}
                style={s.total || s.phase !== "downloading" ? { width: `${s.phase === "downloading" ? pct : 100}%` } : undefined}
              />
            </div>
            <div className="flex justify-between text-[11.5px] text-muted-foreground tabular-nums">
              <span>
                {s.phase === "downloading" ? tr("Downloading…") : s.phase === "installing" ? tr("Installing — rainterm will restart") : tr("Restarting…")}
              </span>
              {s.phase === "downloading" && <span>{s.total ? `${mb(s.done)} / ${mb(s.total)}` : mb(s.done)}</span>}
            </div>
          </div>
        )}

        {s.phase === "error" && (
          <div className="flex gap-2 rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
            <div className="min-w-0 break-words">
              {tr("The update didn't go through: {0}", { 0: s.error ?? "" })}{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => openUrl(`${RELEASES}/latest`)}>
                {tr("Download it from the releases page")}
              </button>
            </div>
          </div>
        )}

        {!busy && s.version && (
          <p className="text-[11.5px] leading-relaxed text-muted-foreground">
            {tr("Installing closes rainterm: open SSH sessions disconnect, your saved sessions and layout come back after the restart.")}
          </p>
        )}

        <div className="flex items-center gap-2">
          {!busy && s.version && (
            <Button variant="ghost" className="text-muted-foreground" onClick={skip}>
              {tr("Skip this version")}
            </Button>
          )}
          <div className="flex-1" />
          {!busy && (
            <Button variant="ghost" onClick={() => useUpdate.setState({ open: false })}>
              {s.version ? tr("Later") : tr("Close")}
            </Button>
          )}
          {s.version && (
            <Button disabled={busy} onClick={() => void installUpdate()}>
              {busy ? <LoaderCircle className="animate-spin" /> : <Download />}
              {s.phase === "error" ? tr("Try again") : tr("Update and restart")}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Settings → About & updates. */
export function AboutSection() {
  const s = useUpdate();
  const auto = useApp((x) => x.settings.autoUpdate);
  const update = useApp((x) => x.updateSettings);
  const checking = s.phase === "checking";
  const status =
    s.phase === "checking"
      ? tr("Checking…")
      : s.phase === "latest"
        ? tr("You're on the latest version.")
        : s.phase === "available" || s.phase === "downloading" || s.phase === "installing"
          ? tr("rainterm {0} is available", { 0: s.version ?? "" })
          : s.phase === "error"
            ? tr("Couldn't check: {0}", { 0: s.error ?? "" })
            : null;
  return (
    <>
      <div className="flex items-center gap-4 rounded-xl border border-ov/[0.07] bg-ov/[0.03] p-4">
        <img src={logo} alt="" className="size-12" draggable={false} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold">rainterm</div>
          <div className="text-[12px] text-muted-foreground tabular-nums">{tr("Version {0}", { 0: s.current || "…" })}</div>
        </div>
        <Button variant="ghost" size="sm" onClick={() => openUrl(RELEASES)}>
          <ExternalLink /> {tr("Releases")}
        </Button>
      </div>

      <div className="grid gap-2">
        <div className="flex items-center gap-2">
          <Button variant="secondary" size="sm" disabled={checking} onClick={() => void checkForUpdate(false)}>
            {checking ? <LoaderCircle className="animate-spin" /> : <RefreshCw />} {tr("Check for updates")}
          </Button>
          {s.version && s.phase !== "checking" && (
            <Button size="sm" onClick={() => useUpdate.setState({ open: true })}>
              <ArrowUpCircle /> {tr("Install {0}", { 0: s.version })}
            </Button>
          )}
        </div>
        {status && (
          <div className={cn("flex items-center gap-1.5 text-[12px]", s.phase === "error" ? "text-destructive" : "text-muted-foreground")}>
            {s.phase === "latest" && <CheckCircle2 className="size-3.5 text-success" />}
            <span className="min-w-0 break-words">{status}</span>
          </div>
        )}
      </div>

      <label className="flex items-center justify-between gap-4 rounded-lg py-1">
        <div>
          <div className="text-[12.5px]">{tr("Check for updates automatically")}</div>
          <div className="text-[11.5px] text-muted-foreground">{tr("At start and every few hours; a button appears in the title bar when one is out. Uses your proxy settings.")}</div>
        </div>
        <Switch checked={auto} onChange={(v) => void update({ autoUpdate: v })} />
      </label>
    </>
  );
}
