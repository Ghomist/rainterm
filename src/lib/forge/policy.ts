// Autonomy policy (agent-forge PLAN.md §6.2): decides each tool call an agent asks to make.
import { inside } from "./proc";
import type { Autonomy, PermissionCeiling } from "./types";

export type Decision = { decision: "allow" | "deny" | "ask"; reason: string };

const READONLY_CMD =
  /^\s*(ls|dir|cat|type|head|tail|wc|pwd|echo|which|where|whoami|date|env|printenv|tree|stat|file|du|df|uname|hostname|grep|rg|ag|find|fd|git\s+(status|log|diff|show|branch|blame|rev-parse|ls-files|grep|remote\s+-v)|node\s+(-v|--version)|npm\s+(ls|view|-v)|pnpm\s+(ls|-v)|python3?\s+--version|cargo\s+(--version|tree|metadata)|Get-ChildItem|Get-Content|Select-String|Test-Path|journalctl|systemctl\s+status|docker\s+(ps|logs|inspect)|kubectl\s+(get|describe|logs))\b/i;
const DESTRUCTIVE =
  /(rm\s+-[a-z]*r[a-z]*f?\s+(\/|~|\.\.|\*)(\s|$)|rmdir\s+\/s|Remove-Item\s+.*-Recurse.*(\\|\/)\s*$|mkfs|format\s+[a-z]:|shutdown|reboot|drop\s+(table|database)|truncate\s+table|kubectl\s+delete|terraform\s+(apply|destroy)|docker\s+system\s+prune|git\s+push\s+.*--force|git\s+reset\s+--hard\s+origin|reg\s+delete|dd\s+if=)/i;
const OUTWARD = /(git\s+push|npm\s+publish|pnpm\s+publish|cargo\s+publish|gh\s+(pr|release)\s+create|deploy|twine\s+upload|docker\s+push)/i;

// biome-ignore lint/suspicious/noExplicitAny: ACP tool call payload
export function commandOf(toolCall: any): string {
  const ri = toolCall?.rawInput ?? {};
  return (
    String(ri.command ?? ri.cmd ?? (Array.isArray(ri.argv) ? ri.argv.join(" ") : "") ?? "") || String(toolCall?.title ?? "")
  );
}

export function isReadOnlyCommand(cmd: string) {
  return READONLY_CMD.test(cmd) && !/[>|;&]\s*\S/.test(cmd.replace(/2>&1|\|\s*(head|tail|grep|wc|sort|less)\b/g, ""));
}

export function decide(args: {
  // biome-ignore lint/suspicious/noExplicitAny: ACP tool call payload
  toolCall: any;
  ceiling: PermissionCeiling;
  autonomy: Autonomy;
  /** Folders it may write in (worktree, scratch). */
  roots: string[];
}): Decision {
  const { toolCall: tc, ceiling: c, autonomy, roots } = args;
  const kind: string = tc?.kind ?? "other";
  // biome-ignore lint/suspicious/noExplicitAny: ACP location
  const locs: string[] = (tc?.locations ?? []).map((l: any) => l?.path).filter(Boolean);
  const title = String(tc?.title ?? "");

  switch (kind) {
    case "think":
    case "switch_mode":
      return { decision: "allow", reason: kind };
    case "read":
    case "search":
      return c.fs === "none" ? { decision: "deny", reason: "role has no file access" } : { decision: "allow", reason: "read-only" };
    case "fetch":
      return c.web ? { decision: "allow", reason: "web allowed" } : { decision: "deny", reason: "role has no web access" };
    case "edit":
    case "delete":
    case "move": {
      if (c.fs === "none" || c.fs === "read") return { decision: "deny", reason: `role is read-only (${kind} not allowed)` };
      const outside = locs.filter((p) => !roots.some((r) => inside(r, p)));
      if (outside.length === 0) return { decision: "allow", reason: "inside the workspace" };
      if (c.fs === "any" && autonomy === "hands-off") return { decision: "allow", reason: "hands-off" };
      return { decision: "ask", reason: `${kind} outside the workspace: ${outside.join(", ")}` };
    }
    case "execute": {
      const cmd = commandOf(tc);
      if (c.shell === "none") return { decision: "deny", reason: "role has no shell access" };
      if (DESTRUCTIVE.test(cmd)) return { decision: "ask", reason: `destructive command: ${cmd}` };
      if (c.shell === "readonly")
        return isReadOnlyCommand(cmd)
          ? { decision: "allow", reason: "read-only command" }
          : { decision: "deny", reason: `role only allows read-only commands (got: ${cmd.slice(0, 120)})` };
      if (OUTWARD.test(cmd))
        return autonomy === "hands-off"
          ? { decision: "allow", reason: "outward action (hands-off)" }
          : { decision: "ask", reason: `outward action: ${cmd}` };
      return { decision: "allow", reason: "workspace command" };
    }
    default: {
      // MCP and unknown tools. rainterm's own terminal tools ask on their own (MCP autonomy).
      const name = String(tc?.name ?? title);
      if (/rainterm|terminal/i.test(name)) return c.terminals ? { decision: "allow", reason: "terminal tool" } : { decision: "deny", reason: "role may not use terminals" };
      if (autonomy === "cautious" && c.fs !== "workspace" && c.fs !== "any") return { decision: "ask", reason: `unknown tool: ${name}` };
      return { decision: "allow", reason: "other tool" };
    }
  }
}

// biome-ignore lint/suspicious/noExplicitAny: ACP permission options
export function pickOption(options: any[], allow: boolean): string | undefined {
  const order = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
  for (const k of order) {
    const o = options.find((x) => x.kind === k);
    if (o) return o.optionId;
  }
  return allow ? options[0]?.optionId : options[options.length - 1]?.optionId;
}
