// Quick commands with blanks: `docker logs -f {{container}}`, `{{name:default}}`,
// `{{env|dev|staging|prod}}` (choices). Running one asks for the values first; the last
// value given for each name is remembered and offered next time.
import { Braces, Play, TextCursorInput } from "lucide-react";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { ComboInput } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toast } from "@/lib/overlay";
import { fillVars, type Snippet, snippetInput, snippetVars, type SnippetVar } from "@/lib/snippets";
import { useApp } from "@/store/app";
import { Field } from "./dialogs";
import { tr } from "@/lib/i18n";

const MEMORY_KEY = "rainterm.snippetVars";

function remembered(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(MEMORY_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function remember(values: Record<string, string>) {
  try {
    localStorage.setItem(MEMORY_KEY, JSON.stringify({ ...remembered(), ...values }));
  } catch {
    /* only a convenience */
  }
}

interface Ask {
  snippet: Snippet;
  vars: SnippetVar[];
  run: boolean;
  resolve: (values: Record<string, string> | null) => void;
}

const useAsk = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Type a quick command into the active terminal, asking for its blanks first. */
export async function sendSnippet(s: Snippet, run = s.run): Promise<boolean> {
  const target = () => {
    const st = useApp.getState();
    const tab = st.tabs.find((t) => t.id === st.activeTabId);
    return tab ? st.panes[tab.activePane] : undefined;
  };
  if (!target()?.session?.alive) {
    toast({ kind: "info", title: tr("No connected terminal to send to") });
    return false;
  }
  let command = s.command;
  const vars = snippetVars(command);
  if (vars.length) {
    const values = await new Promise<Record<string, string> | null>((resolve) =>
      useAsk.setState({ ask: { snippet: s, vars, run, resolve } }),
    );
    if (!values) return false;
    remember(values);
    command = fillVars(command, values);
  }
  const pane = target();
  if (!pane?.session?.alive) return false;
  pane.session.input(snippetInput({ command, run }), true);
  pane.session.focus();
  return true;
}

export function SnippetVarsDialog() {
  const ask = useAsk((s) => s.ask);
  const [values, setValues] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!ask) return;
    const mem = remembered();
    setValues(Object.fromEntries(ask.vars.map((v) => [v.name, mem[v.name] ?? v.def ?? v.choices[0] ?? ""])));
  }, [ask]);

  const close = (result: Record<string, string> | null) => {
    ask?.resolve(result);
    useAsk.setState({ ask: null });
  };
  const preview = ask ? fillVars(ask.snippet.command, values) : "";

  return (
    <Dialog open={!!ask} onOpenChange={(o) => !o && close(null)}>
      <DialogContent className="max-w-[min(500px,calc(100%-2rem))]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Braces className="size-4 text-primary" />
            {ask?.snippet.name || tr("Fill in the command")}
          </DialogTitle>
          <DialogDescription>{tr("The last values you used are filled in.")}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            close(values);
          }}
        >
          {ask?.vars.map((v, i) => (
            <Field key={v.name} label={v.name}>
              {v.choices.length ? (
                <ComboInput
                  autoFocus={i === 0}
                  value={values[v.name] ?? ""}
                  placeholder={v.def ?? ""}
                  onChange={(x) => setValues((s) => ({ ...s, [v.name]: x }))}
                  options={v.choices.map((c) => ({ value: c, label: c }))}
                />
              ) : (
                <Input
                  autoFocus={i === 0}
                  spellCheck={false}
                  className="font-mono"
                  value={values[v.name] ?? ""}
                  placeholder={v.def ?? ""}
                  onChange={(e) => setValues((s) => ({ ...s, [v.name]: e.target.value }))}
                />
              )}
            </Field>
          ))}
          <pre className="max-h-32 overflow-auto rounded-md border border-ov/[0.07] bg-inset px-2.5 py-2 font-mono text-[12px] leading-relaxed break-all whitespace-pre-wrap text-muted-foreground">
            {preview}
          </pre>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => close(null)}>
              {tr("Cancel")}
            </Button>
            <Button type="submit">
              {ask?.run ? <Play className="size-3.5" /> : <TextCursorInput className="size-3.5" />}
              {ask?.run ? tr("Run") : tr("Type it in")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
