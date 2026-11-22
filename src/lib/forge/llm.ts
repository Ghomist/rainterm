// One-shot calls to the model from Settings → Agent (entry agent, final reports), and the
// language agents should write in.
import { llmConfig } from "@/lib/agent/agent";
import { resolveLang } from "@/lib/i18n";
import { Channel, ipc, type LlmBlock, type LlmEvent, type LlmMessage, type LlmToolDef } from "@/lib/ipc";
import { useApp } from "@/store/app";
import { useForge } from "./store";

export const hasModel = () => !!useApp.getState().settings.agent.model.trim();

/** Run one model turn and return its blocks (text and tool calls). */
export function complete(system: string, messages: LlmMessage[], tools: LlmToolDef[] = [], maxTokens = 4096): Promise<LlmBlock[]> {
  return llmConfig().then(
    (config) =>
      new Promise((resolve, reject) => {
        const blocks: LlmBlock[] = [];
        const ch = new Channel<LlmEvent>();
        ch.onmessage = (ev) => {
          if (ev.type === "block") blocks.push(ev.block);
          else if (ev.type === "done") resolve(blocks);
          else if (ev.type === "error") reject(new Error(ev.message));
        };
        const id = `forge-${Math.random().toString(36).slice(2, 10)}`;
        ipc.llmChat(id, { ...config, maxTokens: Math.min(config.maxTokens, maxTokens) }, { system, messages, tools }, ch).catch(reject);
      }),
  );
}

export const textOf = (blocks: LlmBlock[]) =>
  blocks
    .filter((b) => b.type === "text")
    .map((b) => (b as { text: string }).text)
    .join("")
    .trim();

export const OUTPUT_LANGUAGES: { value: string; label: string; prompt: string }[] = [
  { value: "system", label: "Follow the system", prompt: "" },
  { value: "zh", label: "简体中文", prompt: "Simplified Chinese (简体中文)" },
  { value: "en", label: "English", prompt: "English" },
  { value: "ja", label: "日本語", prompt: "Japanese (日本語)" },
];

/** The language agents write human-readable text in (setting, or the UI language). */
export function outputLanguage(): string {
  const v = useForge.getState().config.outputLanguage ?? "system";
  const fixed = OUTPUT_LANGUAGES.find((l) => l.value === v && l.prompt);
  if (fixed) return fixed.prompt;
  if (v !== "system") return v; // free text from an older/hand-edited config
  return resolveLang(useApp.getState().settings.language) === "zh" ? "Simplified Chinese (简体中文)" : "English";
}

/** The line every prompt carries so agents answer in the chosen language. */
export const languageRule = () =>
  `Language: write everything a person will read — titles, instructions, summaries, findings, questions, reasons and your replies — in ${outputLanguage()}. Keep code, commands, file paths and identifiers as they are.`;
