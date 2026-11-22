// Minimal ACP (Agent Client Protocol) client: newline-delimited JSON-RPC 2.0 over stdio.
import type { Child } from "./proc";

// biome-ignore lint/suspicious/noExplicitAny: protocol payloads are loosely typed JSON
type Json = any;

export interface AcpHandlers {
  onUpdate(update: Json): void;
  /** Returns the RequestPermissionOutcome. */
  onPermission(req: Json): Promise<Json>;
  onStderr?(text: string): void;
}

export class AcpConnection {
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void; method: string }>();
  private errBuf = "";
  closed = false;
  exitError?: string;
  child!: Child;

  constructor(private h: AcpHandlers) {}

  /** Wire to a child process (call from its handlers). */
  attach(child: Child) {
    this.child = child;
  }

  line(line: string) {
    void this.onLine(line);
  }

  stderr(s: string) {
    this.errBuf = (this.errBuf + s).slice(-4000);
    this.h.onStderr?.(s);
  }

  exit(code: number | null) {
    this.closed = true;
    this.fail(`agent exited (code ${code})${this.errBuf ? `: ${this.errBuf.trim().slice(-800)}` : ""}`);
  }

  private fail(msg: string) {
    this.exitError ??= msg;
    for (const [, p] of this.pending) p.reject(new Error(msg));
    this.pending.clear();
  }

  private send(obj: Json) {
    if (this.closed) return;
    this.child.write(`${JSON.stringify(obj)}\n`);
  }

  request<T = Json>(method: string, params: Json, timeoutMs = 0): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      if (this.closed) return reject(new Error(this.exitError ?? "agent is not running"));
      this.pending.set(id, { resolve, reject, method });
      this.send({ jsonrpc: "2.0", id, method, params });
      if (timeoutMs)
        setTimeout(() => {
          if (this.pending.delete(id)) reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
    });
  }

  notify(method: string, params: Json) {
    this.send({ jsonrpc: "2.0", method, params });
  }

  private async onLine(raw: string) {
    const line = raw.trim();
    if (!line.startsWith("{")) {
      if (line) this.stderr(`${line}\n`);
      return;
    }
    let msg: Json;
    try {
      msg = JSON.parse(line);
    } catch {
      this.stderr(`${line}\n`);
      return;
    }
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error)
        p.reject(
          new Error(
            `${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}${msg.error.data ? ` ${JSON.stringify(msg.error.data).slice(0, 300)}` : ""}`,
          ),
        );
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === "session/update") {
      this.h.onUpdate(msg.params?.update);
      return;
    }
    if (msg.id !== undefined) {
      // agent → client request
      try {
        if (msg.method !== "session/request_permission")
          throw Object.assign(new Error(`method not supported: ${msg.method}`), { code: -32601 });
        const outcome = await this.h.onPermission(msg.params);
        this.send({ jsonrpc: "2.0", id: msg.id, result: { outcome } });
      } catch (e) {
        const err = e as Error & { code?: number };
        this.send({ jsonrpc: "2.0", id: msg.id, error: { code: err.code ?? -32603, message: err.message } });
      }
    }
  }

  initialize() {
    return this.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "rainterm", version: "0.6.0" },
      },
      120_000,
    );
  }

  close() {
    this.closed = true;
    this.fail("closed");
    this.child?.closeStdin();
    setTimeout(() => this.child?.kill(), 1500);
  }
}

/** Flatten ACP select options (possibly grouped) into a list. */
export function flattenOptions(opts: Json[] | undefined): { value: string; name: string; group?: string }[] {
  const out: { value: string; name: string; group?: string }[] = [];
  for (const o of opts ?? []) {
    if (Array.isArray(o?.options)) for (const x of o.options) out.push({ value: x.value, name: x.name, group: o.name });
    else if (o?.value !== undefined) out.push({ value: o.value, name: o.name ?? o.value });
  }
  return out;
}
