import { Bot, Globe, Info, Keyboard, Lock, Palette, Plus, RotateCcw, Sparkles, SquareTerminal, Trash2 } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { type HighlightRule, ipc } from "@/lib/ipc";
import { DEFAULT_FONT, RULE_NAMES, SGR_COLORS, sha256Hex } from "@/lib/settings";
import { darkThemes, lightThemes, type TermThemeDef } from "@/lib/term-theme";
import { toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { useApp } from "@/store/app";
import { NumberInput, Select, Slider, Switch } from "@/components/ui/controls";
import { Check, Field, Segmented } from "./dialogs";
import { NetworkSection } from "./proxy";
import { BackupSection } from "./settings-backup";
import { SshKeysSection } from "./SshKeys";
import { AgentSection } from "./settings-agent";
import { KeyboardSection } from "./settings-keyboard";
import { AboutSection } from "./Updater";
import { LANGUAGES, systemLang, tr } from "@/lib/i18n";

type Section = "appearance" | "terminal" | "agent" | "network" | "highlight" | "keyboard" | "security" | "about";

const sections: { id: Section; label: string; icon: React.ReactNode }[] = [
  { id: "appearance", label: "Appearance", icon: <Palette /> },
  { id: "terminal", label: "Terminal", icon: <SquareTerminal /> },
  { id: "agent", label: "Agent", icon: <Bot /> },
  { id: "network", label: "Network & keys", icon: <Globe /> },
  { id: "highlight", label: "Highlighting", icon: <Sparkles /> },
  { id: "keyboard", label: "Shortcuts", icon: <Keyboard /> },
  { id: "security", label: "Security & backup", icon: <Lock /> },
  { id: "about", label: "About & updates", icon: <Info /> },
];

export function SettingsDialog() {
  const open = useApp((s) => s.settingsOpen);
  const set = useApp((s) => s.set);
  const [section, setSection] = useState<Section>("appearance");
  const want = useApp((s) => s.settingsSection);
  useEffect(() => {
    if (!open || !want) return;
    if (sections.some((s) => s.id === want)) setSection(want as Section);
    set({ settingsSection: null });
  }, [open, want, set]);

  return (
    <Dialog open={open} onOpenChange={(o) => set({ settingsOpen: o })}>
      <DialogContent className="h-[min(660px,calc(100vh-4rem))] max-w-[min(880px,calc(100%-2rem))] grid-cols-[180px_1fr] gap-0 p-0">
        <nav className="flex flex-col gap-0.5 border-r border-border p-2 pt-4">
          <DialogTitle className="px-2.5 pb-3 text-[13px]">{tr("Settings")}</DialogTitle>
          {sections.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => setSection(s.id)}
              className={cn(
                "relative flex h-8 items-center gap-2 rounded-md px-2.5 text-left text-[12.5px] transition-colors [&_svg]:size-3.5",
                section === s.id ? "text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {section === s.id && (
                <motion.div
                  layoutId="settings-nav"
                  className="absolute inset-0 rounded-md bg-ov/[0.07]"
                  transition={{ type: "spring", stiffness: 500, damping: 40 }}
                />
              )}
              <span className="relative flex items-center gap-2">
                {s.icon}
                {tr(s.label)}
              </span>
            </button>
          ))}
        </nav>
        <div className="min-h-0 overflow-y-auto p-5 pr-10">
          <motion.div
            key={section}
            initial={{ opacity: 0, x: 6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.15 }}
            className="grid grid-cols-[minmax(0,1fr)] gap-4"
          >
            {section === "appearance" && <Appearance />}
            {section === "terminal" && <TerminalSection />}
            {section === "agent" && <AgentSection />}
            {section === "network" && (
              <>
                <NetworkSection />
                <SshKeysSection />
              </>
            )}
            {section === "highlight" && <HighlightSection />}
            {section === "keyboard" && <KeyboardSection />}
            {section === "about" && <AboutSection />}
            {section === "security" && (
              <>
                <Security />
                <BackupSection />
              </>
            )}
          </motion.div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useSettings() {
  return [useApp((s) => s.settings), useApp((s) => s.updateSettings)] as const;
}

function ThemeCard({ t, active, onPick }: { t: TermThemeDef; active: boolean; onPick: () => void }) {
  const c = t.theme;
  return (
    <button
      type="button"
      onClick={onPick}
      className={cn(
        "group overflow-hidden rounded-lg border text-left transition duration-150",
        active ? "border-primary ring-2 ring-primary/30" : "border-ov/10 hover:-translate-y-0.5 hover:border-ov/25",
      )}
    >
      <div className="px-2.5 py-2 font-mono text-[10.5px] leading-[1.55]" style={{ background: c.background, color: c.foreground }}>
        <span style={{ color: c.green }}>{tr("me")}</span>
        <span style={{ color: c.blue }}> {tr("~/src")}</span> {tr("$ ls")}<br />
        <span style={{ color: c.red }}>{tr("error")}</span> <span style={{ color: c.yellow }}>{tr("warn")}</span>{" "}
        <span style={{ color: c.cyan }}>10.0.0.1</span> <span style={{ color: c.magenta }}>12:00</span>
      </div>
      <div className="flex items-center gap-1.5 bg-ov/[0.04] px-2.5 py-1.5 text-[11.5px]">
        <span className="size-2 rounded-full" style={{ background: t.accent }} />
        <span className="truncate">{t.name}</span>
      </div>
    </button>
  );
}

function Appearance() {
  const [s, update] = useSettings();
  return (
    <>
      <Field label={tr("Language")}>
        <Select
          value={s.language}
          onChange={(language) => void update({ language })}
          options={LANGUAGES.map((l) => ({
            value: l.value,
            label: l.value === "system" ? tr("Follow system") : l.label,
            hint: l.value === "system" ? (systemLang() === "zh" ? "简体中文" : tr("English")) : undefined,
          }))}
        />
      </Field>
      <Field label={tr("Mode")}>
        <Segmented
          value={s.themeMode}
          options={[
            { value: "dark", label: tr("Dark") },
            { value: "light", label: tr("Light") },
            { value: "system", label: tr("Follow system") },
          ]}
          onChange={(v) => void update({ themeMode: v })}
        />
      </Field>
      <Field label={tr("Tabs")}>
        <Segmented
          value={s.tabPosition}
          options={[
            { value: "top", label: tr("Across the top") },
            { value: "left", label: tr("Down the left") },
          ]}
          onChange={(v) => void update({ tabPosition: v })}
        />
      </Field>
      <Field label={tr("Dark theme")}>
        <div className="grid grid-cols-3 gap-2">
          {darkThemes.map((t) => (
            <ThemeCard
              key={t.id}
              t={t}
              active={s.darkTheme === t.id}
              onPick={() => void update({ darkTheme: t.id, ...(s.themeMode === "light" ? { themeMode: "dark" } : {}) })}
            />
          ))}
        </div>
      </Field>
      <Field label={tr("Light theme")}>
        <div className="grid grid-cols-3 gap-2">
          {lightThemes.map((t) => (
            <ThemeCard
              key={t.id}
              t={t}
              active={s.lightTheme === t.id}
              onPick={() => void update({ lightTheme: t.id, ...(s.themeMode === "dark" ? { themeMode: "light" } : {}) })}
            />
          ))}
        </div>
      </Field>
      <BackgroundField />
      <Field label={tr("Font family")}>
        <div className="flex gap-1.5">
          <Input
            value={s.fontFamily}
            onChange={(e) => void update({ fontFamily: e.target.value })}
            className="font-mono text-[12px]"
          />
          <Button variant="ghost" size="icon" onClick={() => void update({ fontFamily: DEFAULT_FONT })}>
            <RotateCcw className="size-3.5" />
          </Button>
        </div>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label={tr("Font size · {0}px", { 0: s.fontSize })}>
          <Slider min={10} max={24} value={s.fontSize} onChange={(fontSize) => void update({ fontSize })} />
        </Field>
        <Field label={tr("Line height · {0}", { 0: s.lineHeight.toFixed(2) })}>
          <Slider
            min={1}
            max={1.6}
            step={0.05}
            value={s.lineHeight}
            onChange={(lineHeight) => void update({ lineHeight })}
          />
        </Field>
      </div>
      <Field label={tr("Cursor")}>
        <Segmented
          value={s.cursorStyle}
          options={[
            { value: "bar", label: tr("Bar") },
            { value: "block", label: tr("Block") },
            { value: "underline", label: tr("Underline") },
          ]}
          onChange={(v) => void update({ cursorStyle: v })}
        />
      </Field>
      <Check checked={s.cursorBlink} onChange={(v) => void update({ cursorBlink: v })}>
        {tr("Blinking cursor")}
      </Check>
      <Check checked={s.mica} onChange={(v) => void update({ mica: v })}>
        {tr("Window translucency (Mica, Windows 11)")}
      </Check>
      <Check checked={s.reduceEffects} onChange={(v) => void update({ reduceEffects: v })}>
        {tr("Reduce animations and effects (smoother on integrated graphics)")}
      </Check>
    </>
  );
}

function BackgroundField() {
  const [s, update] = useSettings();
  const pick = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      title: tr("Background picture"),
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"] }],
    });
    if (!picked || Array.isArray(picked)) return;
    try {
      const path = await ipc.backdropImport(picked);
      await update({ backdrop: "image", backdropImage: path });
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't use that picture"), description: String(e) });
    }
  };
  const fileName = s.backdropImage?.split(/[\\/]/).pop()?.replace(/-\d+(\.\w+)$/, "$1");
  return (
    <div className="grid gap-3 rounded-lg border border-ov/[0.07] bg-ov/[0.02] p-3">
      <Field label={tr("Background")}>
        <Segmented
          value={s.backdrop}
          options={[
            { value: "none", label: tr("Solid color") },
            { value: "weather", label: tr("Rain / rainbow") },
            { value: "image", label: tr("Picture") },
          ]}
          onChange={(v) => (v === "image" && !s.backdropImage ? void pick() : void update({ backdrop: v }))}
        />
      </Field>
      {s.backdrop === "weather" && (
        <>
          <p className="-mt-1 text-[12px] text-muted-foreground">
            {tr("Dark themes: a rainy night through the window, rain running down the glass and pooling below. Light themes: a rainbow after the rain. It stays behind the text and pauses while the window is hidden.")}
          </p>
          <Field label={tr("Liveliness · {0}%", { 0: Math.round(s.weatherIntensity * 100) })}>
            <Slider min={0.2} max={1} step={0.05} value={s.weatherIntensity} onChange={(weatherIntensity) => void update({ weatherIntensity })} />
          </Field>
        </>
      )}
      {s.backdrop === "image" && (
        <>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[12px] text-muted-foreground">{fileName ?? tr("No picture chosen")}</span>
            <Button size="sm" variant="outline" onClick={() => void pick()}>
              {tr("Choose picture…")}
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label={tr("Dim · {0}%", { 0: Math.round(s.backdropDim * 100) })}>
              <Slider min={0} max={0.9} step={0.05} value={s.backdropDim} onChange={(backdropDim) => void update({ backdropDim })} />
            </Field>
            <Field label={tr("Blur · {0}px", { 0: s.backdropBlur })}>
              <Slider min={0} max={24} step={1} value={s.backdropBlur} onChange={(backdropBlur) => void update({ backdropBlur })} />
            </Field>
          </div>
        </>
      )}
      {s.backdrop !== "none" && (
        <Field label={tr("Terminal glass · {0}% opaque", { 0: Math.round(s.glassOpacity * 100) })}>
          <Slider min={0.3} max={0.97} step={0.01} value={s.glassOpacity} onChange={(glassOpacity) => void update({ glassOpacity })} />
        </Field>
      )}
    </div>
  );
}

/** Windows: "Open in rainterm" in Explorer's folder menu, and `rainterm` on PATH. */
function ExplorerIntegration() {
  const [on, setOn] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void ipc.winIntegrationStatus().then(setOn, () => setOn(false));
  }, []);
  const flip = async (v: boolean) => {
    setBusy(true);
    try {
      await ipc.winIntegrationSet(v, tr("Open in rainterm"));
      setOn(v);
      toast({
        kind: "success",
        title: v ? tr("Added to Explorer and PATH") : tr("Removed from Explorer and PATH"),
        description: v ? tr("Right-click a folder → Open in rainterm. New terminals can run `rainterm .`") : undefined,
      });
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't change it"), description: String(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg border border-ov/[0.07] px-3 py-2.5">
      <div>
        <div className="text-[12.5px] font-medium">{tr("Open folders from Explorer")}</div>
        <div className="text-[11.5px] text-muted-foreground">
          {tr("Adds “Open in rainterm” to folders' right-click menu (Windows 11: under Show more options), and puts rainterm on your PATH so `rainterm .` works. For you only; no administrator needed.")}
        </div>
      </div>
      <Switch checked={!!on} disabled={on === null || busy} onChange={(v) => void flip(v)} />
    </div>
  );
}

function TerminalSection() {
  const [s, update] = useSettings();
  const shells = useApp((x) => x.shells);
  return (
    <>
      <Field label={tr("Default shell")}>
        <Select<string | null>
          value={s.defaultShell}
          onChange={(defaultShell) => void update({ defaultShell })}
          options={[
            { value: null, label: tr("Auto ({0})", { 0: shells[0]?.name ?? "none" }) },
            ...shells.map((sh) => ({ value: sh.id, label: sh.name })),
          ]}
        />
      </Field>
      {navigator.userAgent.includes("Windows") && <ExplorerIntegration />}
      <Field label={tr("Download folder (SFTP)")}>
        <div className="flex gap-1.5">
          <Input
            readOnly
            value={s.downloadDir ?? "System Downloads folder"}
            className={cn("text-[12px]", !s.downloadDir && "text-muted-foreground")}
          />
          <Button
            variant="outline"
            onClick={async () => {
              const { open } = await import("@tauri-apps/plugin-dialog");
              const picked = await open({ directory: true, title: tr("Download folder") });
              if (picked && !Array.isArray(picked)) void update({ downloadDir: picked });
            }}
          >
            {tr("Choose…")}
          </Button>
          {s.downloadDir && (
            <Button variant="ghost" size="icon" onClick={() => void update({ downloadDir: null })}>
              <RotateCcw className="size-3.5" />
            </Button>
          )}
        </div>
      </Field>
      <Field label={tr("Switch to a tab when hovering it for")}>
        <Select
          value={s.tabHoverSwitchMs}
          onChange={(tabHoverSwitchMs) => void update({ tabHoverSwitchMs })}
          options={[
            { value: 0, label: tr("Never") },
            ...[150, 300, 500, 800, 1000].map((ms) => ({
              value: ms,
              label: ms >= 1000 ? `${ms / 1000} s` : tr("{0} ms", { 0: ms }),
            })),
          ]}
        />
      </Field>
      <Field label={tr("Scrollback lines")}>
        <NumberInput
          value={s.scrollback}
          min={100}
          max={1000000}
          step={1000}
          onChange={(v) => void update({ scrollback: Math.max(100, v) })}
        />
      </Field>
      <div className="grid gap-2.5">
        <Label>{tr("Commands")}</Label>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-[12.5px] text-muted-foreground">{tr("Badge on each command shows")}</span>
          {(
            [
              ["exitCode", "Exit code"],
              ["duration", "Duration"],
              ["startTime", "Start time"],
            ] as const
          ).map(([k, label]) => (
            <Check
              key={k}
              checked={s.blockBadges[k]}
              onChange={(v) => void update({ blockBadges: { ...s.blockBadges, [k]: v } })}
            >
              {tr(label)}
            </Check>
          ))}
        </div>
        <p className="-mt-1 text-[11.5px] text-muted-foreground">
          {tr("Click a badge to copy that command's output (Shift+click: with the command). Ctrl+↑ / Ctrl+↓ jump between commands.")}
        </p>
        <Check checked={s.stickyCommand} onChange={(v) => void update({ stickyCommand: v })}>
          {tr("Keep the command at the top while scrolling through its output")}
        </Check>
      </div>
      <Field label={tr("Notify when a long command finishes while you're elsewhere")}>
        <Select
          value={s.notifyAfterSeconds}
          onChange={(notifyAfterSeconds) => void update({ notifyAfterSeconds })}
          options={[
            { value: 0, label: tr("Never") },
            ...[5, 10, 30, 60, 300].map((n) => ({
              value: n,
              label: n >= 60 ? tr("If it ran {0} min or longer", { 0: n / 60 }) : tr("If it ran {0} s or longer", { 0: n }),
            })),
          ]}
        />
      </Field>
      <div className="grid gap-2.5">
        <Label>{tr("Behavior")}</Label>
        <Check checked={s.autoReconnect} onChange={(v) => void update({ autoReconnect: v })}>
          {tr("Reconnect SSH sessions automatically when the connection drops")}
        </Check>
        <Check checked={s.lineNumbers} onChange={(v) => void update({ lineNumbers: v })}>
          {tr("Show line numbers")}
        </Check>
        <Check checked={s.copyOnSelect} onChange={(v) => void update({ copyOnSelect: v })}>
          {tr("Copy on select")}
        </Check>
        <Check checked={s.rightClickPaste} onChange={(v) => void update({ rightClickPaste: v })}>
          {tr("Right click copies selection / pastes")}
        </Check>
        <Check checked={s.confirmMultilinePaste} onChange={(v) => void update({ confirmMultilinePaste: v })}>
          {tr("Ask before pasting several lines a program would run one by one")}
        </Check>
        <Check checked={s.sshShellIntegration} onChange={(v) => void update({ sshShellIntegration: v })}>
          {tr("Shell integration for SSH (bash / zsh / fish): file panel follows cd, command folding, exit codes — set up out of sight on connect, nothing is typed")}
        </Check>
        <Check checked={s.sshAutoIntegration} onChange={(v) => void update({ sshAutoIntegration: v })}>
          {tr("Where that isn't possible, type a setup line at the first prompt instead (can answer login-time questions by mistake; you can also enable it per terminal from the command palette)")}
        </Check>
        <Check checked={s.suggestions} onChange={(v) => void update({ suggestions: v })}>
          {tr("Completion suggestions while typing: history, commands, paths (Ctrl+Space to pick)")}
        </Check>
        <Check checked={s.monitorRemote} onChange={(v) => void update({ monitorRemote: v })}>
          {tr("Monitor SSH hosts (runs a small read-only command on the server every few seconds)")}
        </Check>
        <Check checked={s.restoreSession} onChange={(v) => void update({ restoreSession: v })}>
          {tr("Reopen tabs and splits from last time on launch")}
        </Check>
        <Check checked={s.confirmClose} onChange={(v) => void update({ confirmClose: v })}>
          {tr("Ask before closing the window while SSH / serial sessions are connected")}
        </Check>
        <Check checked={s.autoLog} onChange={(v) => void update({ autoLog: v })}>
          {tr("Log every session to a file automatically")}
        </Check>
      </div>
    </>
  );
}

function HighlightSection() {
  const [s, update] = useSettings();
  const [rules, setRules] = useState<HighlightRule[]>([]);
  const [errors, setErrors] = useState<string[]>([]);

  useEffect(() => {
    if (s.highlightRules) setRules(s.highlightRules);
    else
      void ipc.defaultHighlightRules().then((r) =>
        setRules(r.map((x, i) => ({ ...x, name: RULE_NAMES[i] ?? `Rule ${i + 1}` }))),
      );
  }, []);

  const commit = async (next: HighlightRule[]) => {
    setRules(next);
    await update({ highlightRules: next });
    setErrors(await ipc.setHighlightRules(next));
  };

  return (
    <>
      <Check checked={s.highlight} onChange={(v) => void update({ highlight: v })}>
        {tr("Highlight keywords in new sessions (errors, warnings, IPs, URLs, dates…)")}
      </Check>
      <p className="-mt-2 text-[12px] text-muted-foreground">
        {tr("Runs in the Rust output pipeline. Text the program already colored and full-screen apps (vim, htop…) are left alone. Patterns are Rust regexes.")}
      </p>
      <div className="grid gap-1.5">
        {rules.map((r, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: editable rows
          <div key={i} className="grid grid-cols-[auto_120px_1fr_124px_auto] items-center gap-1.5">
            <Switch
              checked={r.enabled}
              onChange={(enabled) => void commit(rules.map((x, j) => (j === i ? { ...x, enabled } : x)))}
            />
            <Input
              value={r.name ?? ""}
              placeholder={tr("Name")}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
              onBlur={() => void commit(rules)}
              className="h-7 text-[12px]"
            />
            <Input
              value={r.pattern}
              onChange={(e) => setRules(rules.map((x, j) => (j === i ? { ...x, pattern: e.target.value } : x)))}
              onBlur={() => void commit(rules)}
              className="h-7 font-mono text-[11px]"
            />
            <Select
              size="sm"
              value={r.sgr}
              onChange={(sgr) => void commit(rules.map((x, j) => (j === i ? { ...x, sgr } : x)))}
              options={[
                ...SGR_COLORS.map((c) => ({
                  value: c.sgr,
                  label: (
                    <span className="flex items-center gap-2">
                      <span className="size-2.5 rounded-full" style={{ background: c.css }} />
                      {tr(c.label)}
                    </span>
                  ),
                })),
                ...(!SGR_COLORS.some((c) => c.sgr === r.sgr) ? [{ value: r.sgr, label: tr("SGR {0}", { 0: r.sgr }) }] : []),
              ]}
            />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void commit(rules.filter((_, j) => j !== i))}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        ))}
      </div>
      {errors.length > 0 && (
        <div className="rounded-md bg-destructive/10 p-2 font-mono text-[11px] text-destructive">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setRules([...rules, { name: "", pattern: "", sgr: "36", enabled: true }])}
        >
          <Plus className="size-3.5" /> {tr("Add rule")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await update({ highlightRules: null });
            const r = await ipc.defaultHighlightRules();
            setRules(r.map((x, i) => ({ ...x, name: RULE_NAMES[i] ?? `Rule ${i + 1}` })));
            setErrors([]);
          }}
        >
          <RotateCcw className="size-3.5" /> {tr("Reset to defaults")}
        </Button>
      </div>
    </>
  );
}

function Security() {
  const [s, update] = useSettings();
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  const setPassword = async () => {
    if (pw.length < 4) return setMsg(tr("Use at least 4 characters."));
    if (pw !== pw2) return setMsg(tr("Passwords don't match."));
    const salt = crypto.randomUUID();
    await update({ lockSalt: salt, lockHash: await sha256Hex(`${salt}${pw}`) });
    setPw("");
    setPw2("");
    setMsg(tr("Lock password saved."));
  };

  return (
    <>
      <p className="text-[12.5px] text-muted-foreground">
        {tr("Lock the window with a password (Ctrl+Shift+L). Sessions keep running behind the lock screen.")}
      </p>
      <div className="grid grid-cols-2 gap-2">
        <Field label={s.lockHash ? tr("New lock password") : tr("Lock password")}>
          <Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </Field>
        <Field label={tr("Repeat")}>
          <Input type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void setPassword()}>
          {s.lockHash ? tr("Change password") : tr("Set password")}
        </Button>
        {s.lockHash && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void update({ lockHash: null, lockSalt: null, lockAfterMinutes: 0 })}
          >
            {tr("Remove")}
          </Button>
        )}
        {msg && <span className="text-[12px] text-muted-foreground">{msg}</span>}
      </div>
      <Field label={tr("Auto-lock after inactivity (also locks on launch)")}>
        <Select
          disabled={!s.lockHash}
          value={s.lockAfterMinutes}
          onChange={(lockAfterMinutes) => void update({ lockAfterMinutes })}
          options={[{ value: 0, label: tr("Never") }, ...[5, 10, 15, 30, 60].map((m) => ({ value: m, label: tr("{0} minutes", { 0: m }) }))]}
        />
      </Field>
    </>
  );
}
