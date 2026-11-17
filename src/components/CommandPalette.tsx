import { Command } from "cmdk";
import {
  Activity,
  ArrowLeftRight,
  Cable,
  Columns2,
  FileText,
  FoldVertical,
  FolderTree,
  History,
  Hash,
  Highlighter,
  Lock,
  PanelLeft,
  Plug,
  Plus,
  Radio,
  RotateCw,
  Rows2,
  Search,
  Server,
  Settings2,
  SquareTerminal,
  UnfoldVertical,
  X,
  Zap,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useEffect, useState } from "react";
import { Kbd } from "@/components/ui/input";
import { commands } from "@/lib/history";
import { bindingsOf, keycaps } from "@/lib/keymap";
import { snippetInput, useSnippets } from "@/lib/snippets";
import { useApp } from "@/store/app";

export function CommandPalette() {
  const open = useApp((s) => s.paletteOpen);
  const set = useApp((s) => s.set);
  const shells = useApp((s) => s.shells);
  const profiles = useApp((s) => s.profiles);
  const tabs = useApp((s) => s.tabs);
  const panes = useApp((s) => s.panes);
  const activeTabId = useApp((s) => s.activeTabId);
  const settings = useApp((s) => s.settings);
  const st = useApp.getState();
  const [search, setSearch] = useState("");
  const snippets = useSnippets((x) => x.snippets);
  const loadSnippets = useSnippets((x) => x.load);
  useEffect(() => {
    if (open) void loadSnippets();
  }, [open, loadSnippets]);

  const tab = tabs.find((t) => t.id === activeTabId);
  const pane = tab ? panes[tab.activePane] : undefined;

  const run = (fn: () => void) => {
    set({ paletteOpen: false });
    setSearch("");
    fn();
  };
  const looksLikeHost = /^(?:ssh\s+)?[^@\s]+@[^:\s@]+(?::\d+)?$/.test(search.trim());

  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => set({ paletteOpen: o })}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-inset data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 duration-150" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          className="fixed top-[14%] left-1/2 z-50 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 overflow-hidden rounded-xl border border-ov/10 bg-popover shadow-2xl shadow-shadow outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-[0.97] data-[state=open]:zoom-in-[0.97] data-[state=open]:slide-in-from-top-2 duration-150"
        >
          <DialogPrimitive.Title className="sr-only">Command palette</DialogPrimitive.Title>
          <Command loop className="flex flex-col">
            <Command.Input
              value={search}
              onValueChange={setSearch}
              placeholder="Type a command, session name or user@host…"
              className="h-11 border-b border-border bg-transparent px-4 text-[13.5px] outline-none placeholder:text-muted-foreground/60"
            />
            <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pt-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground">
              <Command.Empty className="py-8 text-center text-[12.5px] text-muted-foreground">
                No results
              </Command.Empty>

              {looksLikeHost && (
                <Command.Group heading="Quick connect">
                  <Item value={`quick ${search}`} onSelect={() => run(() => st.quickConnect(search))}>
                    <Plug /> Connect to {search.trim()}
                  </Item>
                </Command.Group>
              )}

              {tabs.length > 1 && (
                <Command.Group heading="Tabs">
                  {tabs.map((t) => {
                    const p = panes[t.activePane];
                    if (!p) return null;
                    return (
                      <Item
                        key={t.id}
                        value={`tab ${p.title} ${p.subtitle} ${t.id}`}
                        onSelect={() => run(() => st.setActiveTab(t.id))}
                      >
                        <ArrowLeftRight /> {p.title}
                        <span className="ml-auto text-[11px] text-muted-foreground">{p.subtitle}</span>
                      </Item>
                    );
                  })}
                </Command.Group>
              )}

              {profiles.length > 0 && (
                <Command.Group heading="Sessions">
                  {profiles.map((p) => (
                    <Item
                      key={p.id}
                      value={`session ${p.name} ${p.kind === "ssh" ? `${p.user}@${p.host}` : p.target.port} ${p.group ?? ""}`}
                      onSelect={() => run(() => void st.connect(p))}
                    >
                      {p.kind === "ssh" ? <Server /> : <Cable />} {p.name}
                      <span className="ml-auto text-[11px] text-muted-foreground">
                        {p.kind === "ssh" ? `${p.user}@${p.host}` : `${p.target.port} · ${p.target.baud}`}
                      </span>
                    </Item>
                  ))}
                </Command.Group>
              )}

              <Command.Group heading="Local shells">
                {shells.map((sh) => (
                  <Item key={sh.id} value={`shell ${sh.name}`} onSelect={() => run(() => st.openLocal(sh))}>
                    <SquareTerminal /> {sh.name}
                  </Item>
                ))}
              </Command.Group>

              {pane && snippets.length > 0 && (
                <Command.Group heading="Quick commands">
                  {snippets.map((sn) => (
                    <Item
                      key={`s:${sn.id}`}
                      value={`quick command ${sn.name} ${sn.command} ${sn.group}`}
                      onSelect={() =>
                        run(() => {
                          pane.session.input(snippetInput(sn), true);
                          pane.session.focus();
                        })
                      }
                    >
                      <Zap /> <span className="truncate">{sn.name || sn.command.split(/\r?\n/)[0]}</span>
                      {sn.name && (
                        <span className="ml-auto max-w-[45%] truncate font-mono text-[11.5px] text-muted-foreground">
                          {sn.command.split(/\r?\n/)[0]}
                        </span>
                      )}
                    </Item>
                  ))}
                </Command.Group>
              )}

              {pane && search.trim() && (
                <Command.Group heading="Recent commands">
                  {commands(pane.session.hostKey)
                    .slice(0, 400)
                    .map((cmd) => (
                      <Item
                        key={`h:${cmd}`}
                        value={`history ${cmd}`}
                        onSelect={() => run(() => pane.session.acceptCompletion(cmd))}
                      >
                        <History /> <span className="truncate font-mono text-[12.5px]">{cmd}</span>
                      </Item>
                    ))}
                </Command.Group>
              )}

              {pane && (
                <Command.Group heading="Current terminal">
                  <Item value="find search" onSelect={() => run(() => set({ searchOpen: true }))}>
                    <Search /> Find… <Keys id="find" />
                  </Item>
                  <Item value="fold all output" onSelect={() => run(() => pane.session.blocks.foldAll())}>
                    <FoldVertical /> Fold all command output <Keys id="foldAll" />
                  </Item>
                  <Item value="unfold all output" onSelect={() => run(() => pane.session.blocks.unfoldAll())}>
                    <UnfoldVertical /> Unfold all <Keys id="unfoldAll" />
                  </Item>
                  <Item value="split right" onSelect={() => run(() => st.splitActive("row"))}>
                    <Columns2 /> Split right <Keys id="splitRight" />
                  </Item>
                  <Item value="split down" onSelect={() => run(() => st.splitActive("col"))}>
                    <Rows2 /> Split down <Keys id="splitDown" />
                  </Item>
                  <Item value="toggle highlight keywords" onSelect={() => run(() => st.toggleHighlight(pane.id))}>
                    <Highlighter /> {pane.highlight ? "Disable" : "Enable"} keyword highlighting
                  </Item>
                  <Item value="session log record" onSelect={() => run(() => void st.toggleLog(pane.id))}>
                    <FileText /> {pane.logPath ? "Stop logging" : "Start logging to file"}
                  </Item>
                  <Item value="reconnect" onSelect={() => run(() => st.reconnect(pane.id))}>
                    <RotateCw /> Reconnect
                  </Item>
                  <Item value="close pane" onSelect={() => run(() => st.closePane(pane.id))}>
                    <X /> Close pane <Keys id="closePane" />
                  </Item>
                </Command.Group>
              )}

              <Command.Group heading="App">
                <Item value="new ssh session" onSelect={() => run(() => set({ profileEditor: { kind: "ssh" } }))}>
                  <Plus /> New SSH session… <Keys id="newSsh" />
                </Item>
                <Item value="new serial session" onSelect={() => run(() => set({ profileEditor: { kind: "serial" } }))}>
                  <Cable /> New serial session…
                </Item>
                <Item value="broadcast input sync" onSelect={() => run(() => st.toggleBroadcast())}>
                  <Radio /> Toggle broadcast input <Keys id="broadcast" />
                </Item>
                <Item value="resource monitor cpu memory disk gpu processes" onSelect={() => run(() => st.toggleDock("monitor"))}>
                  <Activity /> Toggle resource monitor <Keys id="monitor" />
                </Item>
                <Item value="quick commands snippets" onSelect={() => run(() => st.toggleDock("snippets"))}>
                  <Zap /> Toggle quick commands <Keys id="snippets" />
                </Item>
                <Item value="toggle files sftp" onSelect={() => run(() => st.toggleDock("files"))}>
                  <FolderTree /> Toggle file panel <Keys id="files" />
                </Item>
                <Item value="toggle sidebar" onSelect={() => run(() => set({ sidebarOpen: !st.sidebarOpen }))}>
                  <PanelLeft /> Toggle sidebar <Keys id="sidebar" />
                </Item>
                <Item
                  value="toggle line numbers"
                  onSelect={() => run(() => void st.updateSettings({ lineNumbers: !settings.lineNumbers }))}
                >
                  <Hash /> Toggle line numbers
                </Item>
                <Item value="settings preferences" onSelect={() => run(() => set({ settingsOpen: true }))}>
                  <Settings2 /> Settings <Keys id="settings" />
                </Item>
                {settings.lockHash && (
                  <Item value="lock" onSelect={() => run(() => st.lock())}>
                    <Lock /> Lock <Keys id="lock" />
                  </Item>
                )}
              </Command.Group>
            </Command.List>
          </Command>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function Item({
  children,
  value,
  onSelect,
}: {
  children: React.ReactNode;
  value: string;
  onSelect: () => void;
}) {
  return (
    <Command.Item
      value={value}
      onSelect={onSelect}
      className="flex h-8.5 cursor-default items-center gap-2.5 rounded-md px-2 text-[13px] transition-colors duration-75 data-[selected=true]:bg-accent [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground"
    >
      {children}
    </Command.Item>
  );
}

/** The action's current first binding as keycaps (nothing when unbound). */
function Keys({ id }: { id: string }) {
  const combo = useApp((s) => bindingsOf(s.settings, id)[0]);
  if (!combo) return null;
  return <Kbd className="ml-auto">{keycaps(combo).join(" ")}</Kbd>;
}
