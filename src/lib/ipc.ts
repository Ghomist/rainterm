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
}

export type SshAuth =
  | { kind: "password" }
  | { kind: "key"; path: string }
  | { kind: "agent" }
  | { kind: "auto" };

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
  gpus: { name: string; util: number | null; memUsed: number | null; memTotal: number | null; temp: number | null }[];
}

export interface SshConfigHost {
  alias: string;
  hostName: string | null;
  user: string | null;
  port: number | null;
  identityFile: string | null;
  proxyJump: string | null;
}

export interface Forward {
  localPort: number;
  remoteHost: string;
  remotePort: number;
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  auth: SshAuth;
  jump?: SshTarget | null;
  forwards: Forward[];
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
  | { type: "hostKeyPrompt"; host: string; port: number; keyType: string; fingerprint: string }
  | { type: "secretRequired"; kind: SecretKind; message: string }
  | { type: "error"; message: string }
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
  opsRun: (sessionId: string | null, tool: "docker" | "podman" | "kubectl", args: string[]) =>
    invoke<RunOutput>("ops_run", { sessionId, tool, args }),
  sshForwardAdd: (sessionId: string, localPort: number, remoteHost: string, remotePort: number) =>
    invoke<number>("ssh_forward_add", { sessionId, localPort, remoteHost, remotePort }),
  sshForwardStop: (sessionId: string, localPort: number) => invoke<boolean>("ssh_forward_stop", { sessionId, localPort }),
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

  storeLoad: <T>(name: "profiles" | "settings" | "session" | "history" | "snippets") => invoke<T | null>("store_load", { name }),
  storeSave: (name: "profiles" | "settings" | "session" | "history" | "snippets", value: unknown) =>
    invoke<void>("store_save", { name, value }),
  secretGet: (key: string) => invoke<string | null>("secret_get", { key }),
  secretSet: (key: string, value: string) => invoke<void>("secret_set", { key, value }),
  secretDelete: (key: string) => invoke<void>("secret_delete", { key }),

  setWindowEffects: (enabled: boolean, dark: boolean) =>
    invoke<boolean>("set_window_effects", { enabled, dark }),
  setWindowAppearance: (dark: boolean) => invoke<void>("set_window_appearance", { dark }),
};

export { Channel };
