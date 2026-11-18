# rainterm

A fast, good-looking terminal emulator and SSH/SFTP client, inspired by WindTerm.
Built with **Tauri 2** (Rust) + **React** + **shadcn/ui**, rendered by **xterm.js** (WebGL).

## Download

Grab the latest installer from **[Releases](https://github.com/Ghomist/rainterm/releases/latest)**:

| Platform | File |
| --- | --- |
| Windows 10/11 (x64) | `rainterm_<version>_x64-setup.exe` |
| macOS Apple Silicon | `rainterm_<version>_aarch64.dmg` |
| macOS Intel | `rainterm_<version>_x64.dmg` |
| Linux (x64) | `rainterm_<version>_amd64.AppImage` or `.deb` |

The builds aren't code-signed yet: on Windows click "More info → Run anyway" if SmartScreen asks;
on macOS right-click the app → Open the first time.

## Features

**Terminal**
- Local shells (PowerShell, cmd, WSL, Git Bash; your login shell on macOS/Linux), SSH, serial ports
- Tabs (drag to reorder, rename, duplicate) and split panes with draggable dividers, maximize/restore
- Line numbers, **command blocks & output folding** (shell integration via OSC 133, with a fallback for any shell)
- **Smart keyword highlighting** (errors, warnings, IPs, URLs, dates…) done in the Rust output pipeline;
  leaves already-colored text and full-screen apps alone; rules are editable
- **Input groups**: put terminals in group A–D to type into all of them at once (across tabs);
  plus broadcast to the current tab / all terminals
- Find (Ctrl+Shift+F), copy on select, right-click copy/paste, clickable links (Ctrl+click)
- Session logging (rendered text, not raw escape codes)
- Completion popup while typing: command history, file paths and every command on `PATH`

**SSH**
- Password, private key (with passphrase prompt), SSH agent / Pageant, or **Auto** (agent → default keys → password)
- Passwords optionally stored in the OS keychain; never written to disk
- known_hosts verification with a fingerprint prompt; changed keys are refused
- Jump host (ProxyJump), local port forwarding (-L)
- **Proxies**: SOCKS5 / HTTP CONNECT (with optional login), saved once in Settings → Network and
  reused per session, plus a default proxy for every SSH connection
- Live round-trip latency of connected servers in the status bar
- **Import from `~/.ssh/config`** (Host/HostName/User/Port/IdentityFile/ProxyJump, `Include`, wildcards)
- Quick connect: type `user@host[:port]` in the sidebar search or the command palette
- **Session groups**: create / rename groups, drag sessions between them, connect a whole group

**Side panels** — an icon rail on each edge; left and right panels open side by side, both resizable.
Right-click an icon to move it to the other side. Default: Sessions, Files, Quick commands on the left;
Monitor, Ports, Containers, Kubernetes on the right. Ctrl+Shift+B hides both.

**Quick ops** (for the active terminal's machine — this computer, or the SSH server)
- **Resource monitor**: CPU, memory, GPU, disks, processes (end / copy / reveal)
- **Ports**: listening ports with their process; open in a browser, or **forward a remote port to this computer** in one click
- **Containers** (docker / podman): start, stop, restart, remove, follow logs, open a shell
- **Kubernetes** (kubectl): pods / deployments / services per namespace; logs, shell, describe, delete, rollout restart, scale
- **Quick commands**: saved command lines (single or multi-line) sent to the terminal with one click

**File panel** (Ctrl+Shift+E)
- Local files, or SFTP on the active SSH session — follows the terminal's `cd`
- Breadcrumbs, back/forward, sort, filter, keyboard navigation (F2 rename, Del, Backspace, type-ahead)
- Recursive upload/download with progress, speed, ETA and cancel; drag files in from the OS to upload;
  drag rows onto a terminal to insert their paths
- Open & edit remote files: changes are uploaded every time you save

**App**
- **Backgrounds** (off by default): an animated rainy window — rain beyond the glass, drops
  running down it, ripples in the puddle below — that turns into a rainbow after the rain on
  light themes; or your own picture with dim / blur. Terminals become adjustable "glass" over it
- 16 themes (Catppuccin, One Dark/Light, Nord, Dracula, Tokyo Night, Gruvbox, Solarized, GitHub…),
  dark / light / follow system; optional Mica translucency on Windows 11
- Restores tabs and splits on launch, remembers window size, asks before closing live remote sessions
- Command palette (Ctrl+Shift+P), lock screen with idle auto-lock (Ctrl+Shift+L)
- Every shortcut is configurable (Settings → Shortcuts)
- "Reduce animations and effects" for smoother running on integrated graphics

## Keyboard shortcuts

| Action | Shortcut |
| --- | --- |
| New tab / close pane | Ctrl+Shift+T / Ctrl+Shift+W |
| Split right / down | Alt+Shift+Plus / Alt+Shift+Minus |
| Focus next pane / maximize pane | Alt+Arrows / Ctrl+Shift+Z |
| Next / previous tab, jump to tab | Ctrl+Tab / Ctrl+Shift+Tab, Alt+1…9 |
| Command palette, settings | Ctrl+Shift+P, Ctrl+, |
| Find in terminal | Ctrl+Shift+F |
| Previous / next command | Ctrl+Up / Ctrl+Down |
| Fold / unfold all output | Ctrl+Shift+[ / Ctrl+Shift+] |
| Hide / show side panels | Ctrl+Shift+B |
| Sessions / files / quick commands / monitor | Ctrl+Shift+S / E / K / M |
| Broadcast to tab | Ctrl+Shift+I |
| Copy / paste | Ctrl+C (with selection) or Ctrl+Shift+C / Ctrl+Shift+V |
| Lock | Ctrl+Shift+L |

## Development

Requirements: Node 20+, pnpm, Rust (stable), and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm tauri dev      # run the app with hot reload
pnpm tauri build    # release build + installer (src-tauri/target/release/bundle)
```

Checks:

```bash
pnpm exec tsc --noEmit
cd src-tauri && cargo test --lib
```

## Project layout

```
src/                     React frontend
  lib/term-session.ts    one xterm.js instance + backend session (flow control, acks)
  lib/blocks.ts          command blocks, folding, OSC 133 handling
  store/app.ts           app state: tabs, panes, layouts, profiles, settings, session restore
  components/            UI (title bar, sidebar, terminal area, file panel, dialogs…)
src-tauri/src/           Rust backend
  session/               local PTY, SSH (russh), serial; output pump with batching + backpressure
  highlight.rs           keyword highlighting stream filter
  files.rs               local FS + SFTP, transfers, remote edit sync
  ssh_config.rs          ~/.ssh/config reader
src-tauri/vendor/conpty  Microsoft ConPTY (conpty.dll + OpenConsole.exe, MIT) shipped on Windows
```

## Data locations

Settings, saved sessions, command history and logs live in `~/.rainterm` on every platform
(`%USERPROFILE%\.rainterm` on Windows; override with the `RAINTERM_HOME` environment variable).
Data from older versions (the OS config dir) is copied over on first start.
Secrets are stored only in the OS keychain.
