// Typed wrappers around the Rust commands in src-tauri/src/lib.rs.
import { Channel, invoke } from "@tauri-apps/api/core";

export interface PortEntry {
  proto: "tcp" | "udp" | string;
  address: string;
  port: number;
  pid: number | null;
  process: string | null;
}

export interface RunOutput {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ShellSpec {
  id: string;
  name: string;
  program: string;
  args: string[];
  /** Start in this folder (default: home). */
  cwd?: string | null;
}

export type SshAuth =
  | { kind: "password" }
  | { kind: "key"; path: string }
  | { kind: "agent" }
  | { kind: "auto" };

/** A key pair in ~/.ssh. */
export interface KeyInfo {
  name: string;
  path: string;
  hasPrivate: boolean;
  encrypted: boolean | null;
  algorithm: string;
  comment: string;
  fingerprint: string;
  publicKey: string;
}

export interface MonitorDisk {
  mount: string;
  device: string;
  fs: string;
  kind: string;
  removable: boolean;
  used: number;
  avail: number;
  total: number;
  readRate: number;
  writeRate: number;
}

export interface MonitorProc {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  gpu: number | null;
  gpuMem: number | null;
  user: string;
  cmd: string;
  exe: string | null;
}

export interface MonitorSnapshot {
  host: string;
  os: string;
  uptime: number;
  cpuName: string;
  cpu: number;
  cores: number[];
  load: [number, number, number] | null;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  disks: MonitorDisk[];
  netRx: number;
  netTx: number;
  procs: MonitorProc[];
  gpus: MonitorGpu[];
}

/** A GPU, or a Huawei Ascend NPU (kind "npu": util = AI Core usage). */
export interface MonitorGpu {
  kind: "gpu" | "npu";
  name: string;
  util: number | null;
  memUsed: number | null;
  memTotal: number | null;
  temp: number | null;
  power: number | null;
  health: string | null;
}

export interface SshConfigHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export type ForwardKind = "local" | "remote" | "dynamic";

/**
 * local (-L): 127.0.0.1:localPort here → remoteHost:remotePort from the server.
 * remote (-R): remoteHost:remotePort on the server (bind address) → localHost:localPort here.
 * dynamic (-D): a SOCKS5 proxy on 127.0.0.1:localPort; traffic leaves from the server.
 */
export interface Forward {
  kind?: ForwardKind;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  localHost?: string;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  jump?: SshTarget | null;
  forwards: Forward[];
  proxy?: ProxySpec | null;
}

// ---- built-in agent: normalized conversation (see src-tauri/src/llm.rs)
export interface LlmConfig {
  format: "openai" | "anthropic";
  baseUrl: string;
  model: string;
  maxTokens: number;
  effort?: string | null;
  proxy?: string | null;
}

export type LlmBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }
  | { type: "thinking"; text: string; raw?: unknown };

export interface LlmMessage {
  role: "user" | "assistant";
  content: LlmBlock[];
}

export interface KbEntry {
  id: string;
  title: string;
  tags: string[];
  /** "agent" for notes agents kept themselves. */
  source: string;
  updated: number;
  size: number;
  excerpt: string;
}
export interface KbDoc extends KbEntry {
  body: string;
}
export interface KbHit {
  id: string;
  title: string;
  section: string;
  snippet: string;
  score: number;
}

export interface LlmToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  tools: LlmToolDef[];
}

export type LlmEvent =
  | { type: "textDelta"; text: string }
  | { type: "thinkingDelta"; text: string }
  | { type: "block"; block: LlmBlock }
  | { type: "done"; stopReason: string; inputTokens: number; outputTokens: number }
  | { type: "error"; message: string };

/** Output of an agent process (see src-tauri/src/proc.rs). */
export type ProcEvent = { t: "out"; line: string } | { t: "err"; text: string } | { t: "exit"; code: number | null };

export interface SystemProxy {
  http?: string | null;
  socks?: string | null;
  source: string;
}

export interface ProxySpec {
  kind: "socks5" | "http";
  host: string;
  port: number;
  user?: string | null;
  password?: string | null;
}

export interface SerialTarget {
  port: string;
  baud: number;
  dataBits: number;
  parity: "none" | "odd" | "even";
  stopBits: number;
}

export interface PortInfo {
  name: string;
  description: string;
}

export type SessionEvent =
  | { type: "connecting" }
  | { type: "connected" }
  | { type: "hostKeyPrompt"; host: string; port: number; keyType: string; fingerprint: string; changed: boolean }
  | { type: "secretRequired"; kind: SecretKind; message: string }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | { type: "exit"; code: number | null };

export type SecretKind = "password" | "passphrase" | "jumpPassword" | "jumpPassphrase";

export interface HighlightRule {
  name?: string;
  pattern: string;
  sgr: string;
  enabled: boolean;
}

export type FsTarget = { kind: "local" } | { kind: "ssh"; sessionId: string };

export interface FsEntry {
  name: string;
  kind: "dir" | "file" | "link";
  size: number;
  mtime: number | null;
  mode: number | null;
}

export interface FsListing {
  path: string;
  parent: string | null;
  sep: string;
  entries: FsEntry[];
}

export interface Progress {
  done: number;
  total: number;
  filesDone: number;
  filesTotal: number;
  current: string;
}

export type EditEvent =
  | { type: "opened"; local: string }
  | { type: "synced"; bytes: number }
  | { type: "error"; message: string }
  | { type: "stopped" };

export type DataChannel = Channel<ArrayBuffer | number[]>;

export const ipc = {
  listShells: () => invoke<ShellSpec[]>("list_shells"),
  listSerialPorts: () => invoke<PortInfo[]>("list_serial_ports"),
  openLocal: (
    shell: ShellSpec,
    cols: number,
    rows: number,
    highlight: boolean,
    onData: DataChannel,
    onEvent: Channel<SessionEvent>,
  ) => invoke<string>("open_local", { shell, cols, rows, highlight, onData, onEvent }),
  openSsh: (
    target: SshTarget,
    secret: string | null,
    jumpSecret: string | null,
    cols: number,
    rows: number,
    highlight: boolean,
    onData: DataChannel,
    onEvent: Channel<SessionEvent>,
  ) =>
    invoke<string>("open_ssh", {
      target,
      secret,
      jumpSecret,
      cols,
      rows,
      highlight,
      onData,
      onEvent,
    }),
  openSerial: (
    target: SerialTarget,
    highlight: boolean,
    onData: DataChannel,
    onEvent: Channel<SessionEvent>,
  ) => invoke<string>("open_serial", { target, highlight, onData, onEvent }),
  write: (id: string, data: string) => invoke<void>("session_write", { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>("session_resize", { id, cols, rows }),
  ack: (id: string, bytes: number) => invoke<void>("session_ack", { id, bytes }),
  close: (id: string) => invoke<void>("session_close", { id }),
  closeAll: () => invoke<void>("session_close_all"),
  hostKeyReply: (id: string, accept: boolean) => invoke<void>("host_key_reply", { id, accept }),
  setHighlight: (id: string, enabled: boolean) =>
    invoke<void>("session_set_highlight", { id, enabled }),
  logAppend: (id: string, text: string) => invoke<void>("session_log_append", { id, text }),
  sessionLog: (id: string, name: string | null) =>
    invoke<string | null>("session_log", { id, name }),

  monitorLocal: () => invoke<MonitorSnapshot>("monitor_local"),
  monitorRemote: (sessionId: string) => invoke<MonitorSnapshot>("monitor_remote", { sessionId }),
  monitorForget: (sessionId: string) => invoke<void>("monitor_forget", { sessionId }),
  processKill: (sessionId: string | null, pid: number, force: boolean) =>
    invoke<void>("process_kill", { sessionId, pid, force }),
  historyLocal: (shellId: string) => invoke<string[]>("history_local", { shellId }),
  historyRemote: (sessionId: string) => invoke<string[]>("history_remote", { sessionId }),
  commandsLocal: (shellId: string, program: string) => invoke<string[]>("commands_local", { shellId, program }),
  commandsRemote: (sessionId: string) => invoke<string[]>("commands_remote", { sessionId }),
  portsList: (sessionId: string | null) => invoke<PortEntry[]>("ports_list", { sessionId }),
  /** Fixed read-only queries for the server panels (see src-tauri/src/ops.rs `Query`). */
  opsQuery: (sessionId: string | null, query: { kind: string } & Record<string, unknown>) => invoke<string>("ops_query", { sessionId, query }),
  opsRun: (sessionId: string | null, tool: "docker" | "podman" | "kubectl", args: string[]) =>
    invoke<RunOutput>("ops_run", { sessionId, tool, args }),
  sshForwardAdd: (sessionId: string, localPort: number, remoteHost: string, remotePort: number) =>
    invoke<number>("ssh_forward_add", { sessionId, localPort, remoteHost, remotePort }),
  sshForwardStop: (sessionId: string, localPort: number) => invoke<boolean>("ssh_forward_stop", { sessionId, localPort }),
  backdropImport: (src: string) => invoke<string>("backdrop_import", { src }),
  backdropRead: (path: string) => invoke<ArrayBuffer>("backdrop_read", { path }),
  llmChat: (id: string, config: LlmConfig, request: LlmRequest, onEvent: Channel<LlmEvent>) =>
    invoke<void>("llm_chat", { id, config, request, onEvent }),
  llmCancel: (id: string) => invoke<boolean>("llm_cancel", { id }),
  mcpStart: (host: string, port: number, token: string) => invoke<string>("mcp_start", { host, port, token }),
  mcpSetTools: (tools: string[]) => invoke<void>("mcp_set_tools", { tools }),
  /** The folder this launch was asked to open (`rainterm D:\\code`, Explorer's menu). */
  launchFolder: () => invoke<string | null>("launch_folder"),
  winIntegrationStatus: () => invoke<boolean>("win_integration_status"),
  winIntegrationSet: (on: boolean, label: string) => invoke<void>("win_integration_set", { on, label }),
  /** A Windows change that needs an administrator (UAC): services and scheduled tasks. */
  winAdmin: (kind: "service" | "task", verb: string, name: string, path?: string) =>
    invoke<void>("win_admin", { kind, verb, name, path: path ?? null }),
  winOpen: (tool: "services.msc" | "eventvwr.msc" | "wf.msc" | "taskschd.msc" | "resmon") => invoke<void>("win_open", { tool }),
  mcpStop: () => invoke<void>("mcp_stop"),
  mcpStatus: () => invoke<string | null>("mcp_status"),
  mcpReply: (id: number, result: unknown) => invoke<void>("mcp_reply", { id, result }),
  secretHas: (key: string) => invoke<boolean>("secret_has", { key }),
  sshPing: (sessionId: string) => invoke<number>("ssh_ping", { sessionId }),
  systemProxy: () => invoke<SystemProxy>("system_proxy"),
  procSpawn: (argv: string[], cwd: string | null, env: Record<string, string> | null, onEvent: Channel<ProcEvent>) =>
    invoke<number>("proc_spawn", { argv, cwd, env, onEvent }),
  procSpawnRemote: (sessionId: string, command: string, onEvent: Channel<ProcEvent>) =>
    invoke<number>("proc_spawn_remote", { sessionId, command, onEvent }),
  procWrite: (id: number, data: string) => invoke<void>("proc_write", { id, data }),
  procCloseStdin: (id: number) => invoke<void>("proc_close_stdin", { id }),
  procKill: (id: number) => invoke<void>("proc_kill", { id }),
  procRun: (argv: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string; timeoutMs?: number } = {}) =>
    invoke<RunOutput>("proc_run", { argv, cwd: opts.cwd ?? null, env: opts.env ?? null, input: opts.input ?? null, timeoutMs: opts.timeoutMs ?? null }),
  procRunRemote: (sessionId: string, command: string, timeoutMs?: number) =>
    invoke<RunOutput>("proc_run_remote", { sessionId, command, timeoutMs: timeoutMs ?? null }),
  agentsHome: () => invoke<string>("agents_home"),
  agentsLogAppend: (run: string, text: string) => invoke<void>("agents_log_append", { run, text }),
  agentsLogRead: (run: string) => invoke<string>("agents_log_read", { run }),
  kbDir: () => invoke<string>("kb_dir"),
  kbList: () => invoke<KbEntry[]>("kb_list"),
  kbRead: (id: string) => invoke<KbDoc>("kb_read", { id }),
  kbSave: (id: string | null, title: string, tags: string[], body: string, source?: "user" | "agent") =>
    invoke<string>("kb_save", { id, title, tags, body, source: source ?? null }),
  kbDelete: (id: string) => invoke<void>("kb_delete", { id }),
  kbImport: (paths: string[]) => invoke<number>("kb_import", { paths }),
  kbSearch: (query: string, limit?: number) => invoke<KbHit[]>("kb_search", { query, limit: limit ?? null }),
  kbTool: (name: string, args: Record<string, unknown>) => invoke<string>("kb_tool", { name, args }),
  pathStat: (path: string) => invoke<{ exists: boolean; dir: boolean }>("path_stat", { path }),
  fileReadText: (path: string, max?: number) => invoke<string>("file_read_text", { path, max: max ?? null }),
  fileWriteText: (path: string, text: string) => invoke<void>("file_write_text", { path, text }),
  textFileRead: (path: string) => invoke<string>("text_file_read", { path }),
  textFileWrite: (path: string, text: string) => invoke<void>("text_file_write", { path, text }),
  sshKeysList: () => invoke<KeyInfo[]>("ssh_keys_list"),
  sshKeyGenerate: (name: string, comment: string, passphrase: string | null) =>
    invoke<KeyInfo>("ssh_key_generate", { name, comment, passphrase }),
  sshCopyId: (sessionId: string, publicKey: string) => invoke<string>("ssh_copy_id", { sessionId, publicKey }),
  proxyTest: (proxy: ProxySpec, host: string, port: number) => invoke<number>("proxy_test", { proxy, host, port }),
  sshConfigHosts: () => invoke<[SshConfigHost[], string]>("ssh_config_hosts"),
  setHighlightRules: (rules: HighlightRule[]) => invoke<string[]>("set_highlight_rules", { rules }),
  defaultHighlightRules: () => invoke<HighlightRule[]>("default_highlight_rules"),

  fsHome: (target: FsTarget) => invoke<string>("fs_home", { target }),
  fsList: (target: FsTarget, path: string) => invoke<FsListing>("fs_list", { target, path }),
  fsMkdir: (target: FsTarget, path: string) => invoke<void>("fs_mkdir", { target, path }),
  fsRename: (target: FsTarget, from: string, to: string) =>
    invoke<void>("fs_rename", { target, from, to }),
  fsRemove: (target: FsTarget, paths: string[]) => invoke<void>("fs_remove", { target, paths }),
  fsDownload: (
    sessionId: string,
    remotes: string[],
    localDir: string,
    jobId: string,
    progress: Channel<Progress>,
  ) => invoke<string[]>("fs_download", { sessionId, remotes, localDir, jobId, progress }),
  fsUpload: (
    sessionId: string,
    locals: string[],
    remoteDir: string,
    jobId: string,
    progress: Channel<Progress>,
  ) => invoke<void>("fs_upload", { sessionId, locals, remoteDir, jobId, progress }),
  fsCancel: (jobId: string) => invoke<void>("fs_cancel", { jobId }),
  fsDefaultDownloadDir: () => invoke<string>("fs_default_download_dir"),
  fsEdit: (sessionId: string, remote: string, events: Channel<EditEvent>) =>
    invoke<string>("fs_edit", { sessionId, remote, events }),

  storeLoad: <T>(name: "profiles" | "settings" | "session" | "history" | "snippets" | "agents") => invoke<T | null>("store_load", { name }),
  storeSave: (name: "profiles" | "settings" | "session" | "history" | "snippets" | "agents", value: unknown) =>
    invoke<void>("store_save", { name, value }),
  secretGet: (key: string) => invoke<string | null>("secret_get", { key }),
  secretSet: (key: string, value: string) => invoke<void>("secret_set", { key, value }),
  secretDelete: (key: string) => invoke<void>("secret_delete", { key }),

  setWindowEffects: (enabled: boolean, dark: boolean) =>
    invoke<boolean>("set_window_effects", { enabled, dark }),
  setWindowAppearance: (dark: boolean | null) => invoke<void>("set_window_appearance", { dark }),
};

export { Channel };
