// Proxy choices → what the backend dials. A proxy choice is a saved proxy's id or
// SYSTEM_PROXY (the OS-wide setting, read when needed so it follows changes).
import { ipc, type ProxySpec, type SystemProxy } from "./ipc";
import type { ProxyDef } from "./settings";

export const SYSTEM_PROXY = "system";

/** "host:port" → parts ("[::1]:8080" too). */
export function splitHostPort(hp: string): { host: string; port: number } {
  const i = hp.lastIndexOf(":");
  const host = hp.slice(0, i).replace(/^\[|\]$/g, "");
  return { host, port: Number(hp.slice(i + 1)) || 80 };
}

export const systemProxyLabel = (sp: SystemProxy | null) =>
  !sp
    ? "reading…"
    : [sp.http && `HTTP ${sp.http}`, sp.socks && `SOCKS ${sp.socks}`].filter(Boolean).join(" · ") || "not set (direct)";

/** For SSH: SOCKS when the system has one (any port works through it), else HTTP CONNECT. */
export async function systemProxySpec(): Promise<ProxySpec | null> {
  const sp = await ipc.systemProxy().catch(() => null);
  const hp = sp?.socks ?? sp?.http;
  if (!sp || !hp) return null;
  const { host, port } = splitHostPort(hp);
  return { kind: sp.socks ? "socks5" : "http", host, port, user: null, password: null };
}

/** For HTTP clients (the agent's model API): a proxy URL, or null for direct. */
export async function proxyUrl(choice: string | null | undefined, saved: ProxyDef[]): Promise<string | null> {
  if (!choice) return null;
  if (choice === SYSTEM_PROXY) {
    const sp = await ipc.systemProxy().catch(() => null);
    return sp?.http ? `http://${sp.http}` : sp?.socks ? `socks5h://${sp.socks}` : null;
  }
  const def = saved.find((p) => p.id === choice);
  if (!def) return null;
  const pw = def.hasPassword ? await ipc.secretGet(`proxy:${def.id}`).catch(() => null) : null;
  const auth = def.user ? `${encodeURIComponent(def.user)}${pw ? `:${encodeURIComponent(pw)}` : ""}@` : "";
  return `${def.kind === "http" ? "http" : "socks5h"}://${auth}${def.host}:${def.port}`;
}
