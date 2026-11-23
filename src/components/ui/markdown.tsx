// Rich markdown for agent reports and outputs (GFM: tables, task lists, strikethrough),
// selectable, with copy / export actions.
import { BookPlus, Check, Copy, Download } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ipc } from "@/lib/ipc";
import { newNote } from "@/lib/kb";
import { tr } from "@/lib/i18n";
import { toast } from "@/lib/overlay";
import { cn } from "@/lib/utils";
import { IconButton } from "./panel";

export function RichMarkdown({ text, className, compact }: { text: string; className?: string; compact?: boolean }) {
  return (
    <div className={cn("md select-text", compact && "md-compact", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(e) => {
                e.preventDefault();
                if (href && /^https?:\/\//.test(href)) void import("@tauri-apps/plugin-opener").then((o) => o.openUrl(href));
              }}
            >
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Copy, "Save as .md" and "Save to knowledge base" for a piece of markdown. */
export function MarkdownActions({ text, name, className }: { text: string; name: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };
  const exportMd = async () => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const safe = name.replace(/[\\/:*?"<>|\n]+/g, " ").trim().slice(0, 60) || "report";
    const path = await save({ defaultPath: `${safe}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
    if (!path) return;
    try {
      await ipc.fileWriteText(path, text);
      toast({ kind: "success", title: tr("Saved"), description: path });
    } catch (e) {
      toast({ kind: "error", title: tr("Couldn't save"), description: String(e) });
    }
  };
  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <IconButton tip={copied ? tr("Copied") : tr("Copy as markdown")} className="size-7" onClick={() => void copy()}>
        {copied ? <Check className="text-success" /> : <Copy />}
      </IconButton>
      <IconButton tip={tr("Export as .md file")} className="size-7" onClick={() => void exportMd()}>
        <Download />
      </IconButton>
      <IconButton tip={tr("Save to knowledge base")} className="size-7" onClick={() => newNote({ title: name, body: text })}>
        <BookPlus />
      </IconButton>
    </div>
  );
}
