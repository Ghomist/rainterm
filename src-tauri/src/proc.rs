//! Child processes for the agents session: worker agents speak ACP (JSON-RPC, one message
//! per line) over stdin/stdout, locally or on an SSH host through an exec channel. Each
//! process streams its stdout line by line, stderr in chunks, then its exit code, over a
//! Tauri channel; the webview writes to its stdin and can kill it (with its whole tree).
//! Also one-shot runs (git, acceptance checks) and the agents data directory.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::Context;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::Channel;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::sync::mpsc;

use crate::session::ssh::Conn;

#[derive(Serialize, Clone)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ProcEvent {
    Out { line: String },
    Err { text: String },
    Exit { code: Option<i32> },
}

enum Cmd {
    Write(Vec<u8>),
    CloseStdin,
    Kill,
}

type Entry = (mpsc::UnboundedSender<Cmd>, Option<u32>);

fn procs() -> &'static Mutex<HashMap<u64, Entry>> {
    static P: OnceLock<Mutex<HashMap<u64, Entry>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Find an executable on PATH the way a shell would (Windows: PATHEXT, so `npx` → npx.cmd).
pub fn resolve(program: &str) -> PathBuf {
    let p = PathBuf::from(program);
    if p.components().count() > 1 || p.is_absolute() {
        return p;
    }
    let exts: Vec<String> = if cfg!(windows) {
        if p.extension().is_some() {
            vec![String::new()]
        } else {
            std::env::var("PATHEXT")
                .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into())
                .split(';')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_ascii_lowercase())
                .collect()
        }
    } else {
        vec![String::new()]
    };
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for e in &exts {
                let cand = dir.join(format!("{program}{e}"));
                if cand.is_file() {
                    return cand;
                }
            }
        }
    }
    p
}

fn command(argv: &[String], cwd: Option<&str>, env: &HashMap<String, String>) -> anyhow::Result<tokio::process::Command> {
    let (prog, args) = argv.split_first().context("empty command")?;
    let mut cmd = tokio::process::Command::new(resolve(prog));
    cmd.args(args).envs(env).kill_on_drop(true);
    if let Some(d) = cwd.filter(|d| !d.is_empty()) {
        cmd.current_dir(d);
    }
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    #[cfg(unix)]
    cmd.process_group(0);
    Ok(cmd)
}

fn kill_tree(pid: Option<u32>) {
    let Some(pid) = pid else { return };
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(0x0800_0000)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(unix)]
    unsafe {
        libc_kill(-(pid as i32), 15);
    }
}

#[cfg(unix)]
extern "C" {
    #[link_name = "kill"]
    fn libc_kill(pid: i32, sig: i32) -> i32;
}

/// Read lines (lossy UTF-8, no trailing newline) until EOF.
async fn pump_lines<R: tokio::io::AsyncRead + Unpin>(r: R, ch: Channel<ProcEvent>) {
    let mut r = BufReader::with_capacity(64 * 1024, r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match r.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                while matches!(buf.last(), Some(b'\n' | b'\r')) {
                    buf.pop();
                }
                let _ = ch.send(ProcEvent::Out { line: String::from_utf8_lossy(&buf).into_owned() });
            }
        }
    }
}

async fn pump_chunks<R: tokio::io::AsyncRead + Unpin>(mut r: R, ch: Channel<ProcEvent>) {
    let mut buf = vec![0u8; 8192];
    loop {
        match r.read(&mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let _ = ch.send(ProcEvent::Err { text: String::from_utf8_lossy(&buf[..n]).into_owned() });
            }
        }
    }
}

pub fn spawn_local(argv: Vec<String>, cwd: Option<String>, env: HashMap<String, String>, ch: Channel<ProcEvent>) -> anyhow::Result<u64> {
    let mut cmd = command(&argv, cwd.as_deref(), &env)?;
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn().with_context(|| format!("start {}", argv[0]))?;
    let pid = child.id();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel();
    procs().lock().insert(id, (tx, pid));
    let mut stdin = child.stdin.take();
    let out = tauri::async_runtime::spawn(pump_lines(child.stdout.take().unwrap(), ch.clone()));
    let err = tauri::async_runtime::spawn(pump_chunks(child.stderr.take().unwrap(), ch.clone()));
    tauri::async_runtime::spawn(async move {
        let status = loop {
            tokio::select! {
                st = child.wait() => break st.ok().and_then(|s| s.code()),
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Write(b)) => {
                        if let Some(w) = stdin.as_mut() {
                            if w.write_all(&b).await.is_err() || w.flush().await.is_err() { stdin = None; }
                        }
                    }
                    Some(Cmd::CloseStdin) => stdin = None,
                    Some(Cmd::Kill) | None => {
                        kill_tree(pid);
                        let _ = child.kill().await;
                        break child.wait().await.ok().and_then(|s| s.code());
                    }
                },
            }
        };
        let _ = tokio::time::timeout(Duration::from_secs(3), async {
            let _ = out.await;
            let _ = err.await;
        })
        .await;
        procs().lock().remove(&id);
        let _ = ch.send(ProcEvent::Exit { code: status });
    });
    Ok(id)
}

/// Run `command` on the SSH host behind `conn` with stdio streamed like a local process.
pub async fn spawn_remote(conn: &Conn, command: String, ch: Channel<ProcEvent>) -> anyhow::Result<u64> {
    let channel = conn.handle.channel_open_session().await?;
    channel.exec(true, command.as_bytes().to_vec()).await?;
    let (mut read, write) = channel.split();
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, mut rx) = mpsc::unbounded_channel();
    procs().lock().insert(id, (tx, None));
    tauri::async_runtime::spawn(async move {
        let mut partial: Vec<u8> = Vec::new();
        let mut code = None;
        let emit = |partial: &mut Vec<u8>, ch: &Channel<ProcEvent>| {
            while let Some(i) = partial.iter().position(|&b| b == b'\n') {
                let mut line: Vec<u8> = partial.drain(..=i).collect();
                while matches!(line.last(), Some(b'\n' | b'\r')) {
                    line.pop();
                }
                let _ = ch.send(ProcEvent::Out { line: String::from_utf8_lossy(&line).into_owned() });
            }
        };
        loop {
            tokio::select! {
                msg = read.wait() => match msg {
                    Some(russh::ChannelMsg::Data { data }) => { partial.extend_from_slice(&data); emit(&mut partial, &ch); }
                    Some(russh::ChannelMsg::ExtendedData { data, .. }) => {
                        let _ = ch.send(ProcEvent::Err { text: String::from_utf8_lossy(&data).into_owned() });
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status }) => code = Some(exit_status as i32),
                    Some(russh::ChannelMsg::Close) | None => break,
                    Some(_) => {}
                },
                cmd = rx.recv() => match cmd {
                    Some(Cmd::Write(b)) => { let _ = write.data_bytes(b).await; }
                    Some(Cmd::CloseStdin) => { let _ = write.eof().await; }
                    Some(Cmd::Kill) | None => { let _ = write.close().await; break; }
                },
            }
        }
        if !partial.is_empty() {
            let _ = ch.send(ProcEvent::Out { line: String::from_utf8_lossy(&partial).into_owned() });
        }
        procs().lock().remove(&id);
        let _ = ch.send(ProcEvent::Exit { code });
    });
    Ok(id)
}

pub fn write(id: u64, data: String) -> anyhow::Result<()> {
    let tx = procs().lock().get(&id).map(|e| e.0.clone()).context("process has exited")?;
    tx.send(Cmd::Write(data.into_bytes())).map_err(|_| anyhow::anyhow!("process has exited"))
}

pub fn close_stdin(id: u64) {
    if let Some((tx, _)) = procs().lock().get(&id) {
        let _ = tx.send(Cmd::CloseStdin);
    }
}

pub fn kill(id: u64) {
    if let Some((tx, _)) = procs().lock().get(&id) {
        let _ = tx.send(Cmd::Kill);
    }
}

/// App is closing: kill every agent process tree now (tasks may never run again).
pub fn kill_all() {
    for (_, (tx, pid)) in procs().lock().drain() {
        kill_tree(pid);
        let _ = tx.send(Cmd::Kill);
    }
}

#[derive(Serialize)]
pub struct RunOutput {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run to completion. `timeout_ms` 0 = no limit; on timeout the tree is killed and code is -2.
pub async fn run(
    argv: Vec<String>,
    cwd: Option<String>,
    env: HashMap<String, String>,
    input: Option<String>,
    timeout_ms: u64,
) -> anyhow::Result<RunOutput> {
    let mut cmd = command(&argv, cwd.as_deref(), &env)?;
    cmd.stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() }).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RunOutput { code: 127, stdout: String::new(), stderr: format!("{}: command not found", argv[0]) })
        }
        Err(e) => return Err(e.into()),
    };
    let pid = child.id();
    if let (Some(text), Some(mut w)) = (input, child.stdin.take()) {
        tokio::spawn(async move {
            let _ = w.write_all(text.as_bytes()).await;
        });
    }
    let mut so = child.stdout.take().unwrap();
    let mut se = child.stderr.take().unwrap();
    let collect = async {
        let (mut a, mut b) = (Vec::new(), Vec::new());
        let _ = tokio::join!(so.read_to_end(&mut a), se.read_to_end(&mut b));
        let st = child.wait().await;
        (st.ok().and_then(|s| s.code()).unwrap_or(-1), a, b)
    };
    let (code, out, err) = if timeout_ms == 0 {
        collect.await
    } else {
        match tokio::time::timeout(Duration::from_millis(timeout_ms), collect).await {
            Ok(r) => r,
            Err(_) => {
                kill_tree(pid);
                return Ok(RunOutput { code: -2, stdout: String::new(), stderr: format!("timed out after {}s", timeout_ms / 1000) });
            }
        }
    };
    Ok(RunOutput { code, stdout: String::from_utf8_lossy(&out).into_owned(), stderr: String::from_utf8_lossy(&err).into_owned() })
}

// ------------------------------------------------------------------ data directory

/// `<rainterm home>/agents`, with runs/, worktrees/ and scratch/ inside.
pub fn home() -> anyhow::Result<PathBuf> {
    let d = crate::store::config_dir()?.join("agents");
    for sub in ["runs", "worktrees", "scratch"] {
        std::fs::create_dir_all(d.join(sub))?;
    }
    Ok(d)
}

fn run_file(run: &str) -> anyhow::Result<PathBuf> {
    anyhow::ensure!(run.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'), "bad run id");
    Ok(home()?.join("runs").join(format!("{run}.jsonl")))
}

pub fn log_append(run: &str, text: &str) -> anyhow::Result<()> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create(true).append(true).open(run_file(run)?)?;
    f.write_all(text.as_bytes())?;
    Ok(())
}

pub fn log_read(run: &str) -> anyhow::Result<String> {
    let p = run_file(run)?;
    Ok(if p.exists() { std::fs::read_to_string(p)? } else { String::new() })
}

#[derive(Serialize)]
pub struct PathInfo {
    pub exists: bool,
    pub dir: bool,
}

pub fn stat(path: &str) -> PathInfo {
    match std::fs::metadata(path) {
        Ok(m) => PathInfo { exists: true, dir: m.is_dir() },
        Err(_) => PathInfo { exists: false, dir: false },
    }
}

/// Read a UTF-8 text file (for the built-in agent's read-only tools). Capped at 1 MB.
pub fn read_text(path: &str, max: usize) -> anyhow::Result<String> {
    let f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    std::io::Read::read_to_end(&mut std::io::Read::take(f, max.min(1024 * 1024) as u64), &mut buf)?;
    Ok(String::from_utf8_lossy(&buf).into_owned())
}

/// Write a text file (built-in agent's write tools), creating parent folders.
pub fn write_text(path: &str, text: &str) -> anyhow::Result<()> {
    let p = std::path::Path::new(path);
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(p, text)?;
    Ok(())
}
