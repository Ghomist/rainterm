//! Session layer: one uniform abstraction over local PTYs, SSH shells and serial ports.
//!
//! Data path (hot):   backend --bytes--> [bounded mpsc] --> pump (coalesce, highlight,
//!                    log, flow control) --> tauri::ipc::Channel (raw binary) --> xterm.js
//! Control path:      frontend invoke --> Ctrl enum --> backend
//!
//! Flow control: the pump tracks bytes sent but not yet acknowledged by the
//! frontend (acked after xterm.js finished parsing them). Above HIGH_WATER the
//! pump stops forwarding, the bounded queue fills up and the backend reader
//! blocks, which propagates backpressure all the way to the child process /
//! remote server. This keeps `cat huge.log` or `yes` from freezing the UI.

pub mod local;
mod posix_integration;
pub mod serial;
pub mod ssh;

use std::collections::HashMap;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;

use parking_lot::Mutex;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::sync::{Notify, mpsc, oneshot};

use crate::highlight::StreamFilter;

/// Max bytes in one IPC message.
const MAX_BATCH: usize = 256 * 1024;
/// While output is streaming, wait at most this long to coalesce more of it.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
/// Output arriving within this gap of the previous send counts as "streaming".
const STREAM_GAP: Duration = Duration::from_millis(12);
/// A single drain this large also counts as streaming.
const BURST_THRESHOLD: usize = 16 * 1024;
/// Unacked bytes above which we pause forwarding.
const HIGH_WATER: usize = 2 * 1024 * 1024;
/// Unacked bytes below which a paused pump resumes.
const LOW_WATER: usize = 512 * 1024;

/// Control messages sent to a backend.
pub enum Ctrl {
    Write(Vec<u8>),
    Resize { cols: u16, rows: u16 },
    Close,
    /// Internal: the local child exited; release the PTY master so the reader hits EOF.
    ChildExited,
}

/// Out-of-band events (JSON) sent to the frontend on a separate channel.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SessionEvent {
    Connecting,
    Connected,
    #[serde(rename_all = "camelCase")]
    HostKeyPrompt {
        host: String,
        port: u16,
        key_type: String,
        fingerprint: String,
        /// The host is known with a *different* key (reinstalled server — or an attack).
        /// Accepting replaces the old known_hosts entry.
        changed: bool,
    },
    /// Authentication needs a (new) secret; the session has ended. The frontend
    /// prompts and reconnects with it.
    SecretRequired { kind: String, message: String },
    Error { message: String },
    Exit { code: Option<i32> },
}

pub struct Flow {
    unacked: AtomicUsize,
    resume: Notify,
}

impl Flow {
    fn new() -> Self {
        Self { unacked: AtomicUsize::new(0), resume: Notify::new() }
    }

    pub fn ack(&self, n: usize) {
        let prev = self
            .unacked
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |v| Some(v.saturating_sub(n)))
            .unwrap_or(0);
        if prev.saturating_sub(n) <= LOW_WATER {
            // notify_one stores a permit if the pump isn't waiting yet: no lost wakeups.
            self.resume.notify_one();
        }
    }

    async fn wait_for_capacity(&self) {
        while self.unacked.load(Ordering::Acquire) > HIGH_WATER {
            self.resume.notified().await;
        }
    }
}

/// Per-session state shared between the command layer, the pump and the backend.
pub struct Shared {
    pub flow: Flow,
    /// Pending answer for an SSH host-key prompt.
    pub host_key_reply: Mutex<Option<oneshot::Sender<bool>>>,
    pub highlight: AtomicBool,
    /// When the user last sent input: output right after it (without a newline) is the
    /// shell echoing / redrawing the line being typed, which must not be highlighted.
    pub last_input: Mutex<Option<std::time::Instant>>,
    pub log: Mutex<Option<(PathBuf, std::fs::File)>>,
    /// Live SSH connection (for SFTP / port forwarding on the same transport).
    pub ssh: Mutex<Option<Arc<ssh::Conn>>>,
    pub exit_code: Mutex<Option<i32>>,
}

pub struct SessionHandle {
    pub ctrl: mpsc::UnboundedSender<Ctrl>,
    pub shared: Arc<Shared>,
}

#[derive(Default, Clone)]
pub struct Sessions(Arc<Mutex<HashMap<String, SessionHandle>>>);

/// Everything a backend needs to talk to the outside world.
pub struct BackendIo {
    pub out: mpsc::Sender<Vec<u8>>,
    pub ctrl_rx: mpsc::UnboundedReceiver<Ctrl>,
    pub ctrl_tx: mpsc::UnboundedSender<Ctrl>,
    pub events: Channel<SessionEvent>,
    pub shared: Arc<Shared>,
}

impl Sessions {
    /// Register a new session and start its output pump. Returns the id and the
    /// IO bundle the backend should drive.
    pub fn create(
        &self,
        data: Channel<InvokeResponseBody>,
        events: Channel<SessionEvent>,
        highlight: bool,
    ) -> (String, BackendIo) {
        let id = uuid::Uuid::new_v4().to_string();
        let (out_tx, out_rx) = mpsc::channel::<Vec<u8>>(64);
        let (ctrl_tx, ctrl_rx) = mpsc::unbounded_channel();
        let shared = Arc::new(Shared {
            flow: Flow::new(),
            host_key_reply: Mutex::new(None),
            highlight: AtomicBool::new(highlight),
            last_input: Mutex::new(None),
            log: Mutex::new(None),
            ssh: Mutex::new(None),
            exit_code: Mutex::new(None),
        });

        self.0
            .lock()
            .insert(id.clone(), SessionHandle { ctrl: ctrl_tx.clone(), shared: shared.clone() });

        tauri::async_runtime::spawn(pump(
            id.clone(),
            ctrl_tx.clone(),
            out_rx,
            data,
            events.clone(),
            shared.clone(),
            self.clone(),
        ));

        (id, BackendIo { out: out_tx, ctrl_rx, ctrl_tx, events, shared })
    }

    pub fn send(&self, id: &str, msg: Ctrl) -> Result<(), String> {
        let map = self.0.lock();
        let h = map.get(id).ok_or_else(|| format!("no such session: {id}"))?;
        h.ctrl.send(msg).map_err(|_| "session closed".to_string())
    }

    pub fn shared(&self, id: &str) -> Result<Arc<Shared>, String> {
        self.0
            .lock()
            .get(id)
            .map(|h| h.shared.clone())
            .ok_or_else(|| format!("no such session: {id}"))
    }

    pub fn ssh(&self, id: &str) -> Result<Arc<ssh::Conn>, String> {
        self.shared(id)?.ssh.lock().clone().ok_or_else(|| "not an SSH session (or not connected)".into())
    }

    pub fn ack(&self, id: &str, bytes: usize) {
        if let Some(h) = self.0.lock().get(id) {
            h.shared.flow.ack(bytes);
        }
    }

    pub fn reply_host_key(&self, id: &str, accept: bool) {
        if let Some(h) = self.0.lock().get(id) {
            if let Some(tx) = h.shared.host_key_reply.lock().take() {
                let _ = tx.send(accept);
            }
        }
    }

    /// Close every session (used when the webview (re)loads with no tabs).
    pub fn close_all(&self) {
        for h in self.0.lock().values() {
            let _ = h.ctrl.send(Ctrl::Close);
        }
    }

    fn remove(&self, id: &str) {
        self.0.lock().remove(id);
    }
}

/// Start or stop logging a session's output (ANSI-stripped) to a file.
pub fn set_logging(shared: &Shared, path: Option<PathBuf>) -> anyhow::Result<()> {
    let mut log = shared.log.lock();
    *log = None;
    if let Some(path) = path {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let file = std::fs::OpenOptions::new().create(true).append(true).open(&path)?;
        *log = Some((path, file));
    }
    Ok(())
}

/// Append already-rendered text lines to the session log (if logging is on).
pub fn append_log(shared: &Shared, text: &str) -> anyhow::Result<()> {
    if let Some((_, f)) = shared.log.lock().as_mut() {
        f.write_all(text.as_bytes())?;
    }
    Ok(())
}

/// Output this soon after a keystroke, without a newline, counts as input echo.
const ECHO_WINDOW: std::time::Duration = std::time::Duration::from_millis(150);

/// Coalesce backend output into large binary IPC messages, respecting flow control.
async fn pump(
    id: String,
    ctrl: mpsc::UnboundedSender<Ctrl>,
    mut rx: mpsc::Receiver<Vec<u8>>,
    data: Channel<InvokeResponseBody>,
    events: Channel<SessionEvent>,
    shared: Arc<Shared>,
    sessions: Sessions,
) {
    let mut buf: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut filter = StreamFilter::default();
    let mut last_send = tokio::time::Instant::now() - STREAM_GAP;
    'outer: loop {
        let Some(first) = rx.recv().await else { break };
        buf.extend_from_slice(&first);

        // Drain whatever is already queued.
        let mut closed = false;
        while buf.len() < MAX_BATCH {
            match rx.try_recv() {
                Ok(chunk) => buf.extend_from_slice(&chunk),
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    closed = true;
                    break;
                }
            }
        }

        // Adaptive batching. Idle -> send immediately (keystroke echo stays instant).
        // Streaming (ConPTY emits ~100-byte chunks per line) -> hold a few ms to build
        // big batches; per-message IPC overhead otherwise caps throughput.
        let streaming = last_send.elapsed() < STREAM_GAP || buf.len() >= BURST_THRESHOLD;
        if !closed && streaming {
            let deadline = tokio::time::Instant::now() + COALESCE_WINDOW;
            while buf.len() < MAX_BATCH {
                match tokio::time::timeout_at(deadline, rx.recv()).await {
                    Ok(Some(chunk)) => buf.extend_from_slice(&chunk),
                    Ok(None) => {
                        closed = true;
                        break;
                    }
                    Err(_) => break,
                }
            }
        }

        // Keyword highlighting. (Logging is line-based from the rendered screen, see
        // `append_log`: a raw-stream log is full of ConPTY repaint noise.)
        // Not the echo of what you're typing: the line editor redraws parts of the line as
        // you edit, so colors there would end up on fragments (half a URL stays colored).
        let echo = !buf.contains(&b'\n') && shared.last_input.lock().is_some_and(|t| t.elapsed() < ECHO_WINDOW);
        filter.highlight = shared.highlight.load(Ordering::Relaxed) && !echo;
        let chunk = filter.process(&buf, None);
        buf.clear();

        shared.flow.wait_for_capacity().await;
        shared.flow.unacked.fetch_add(chunk.len(), Ordering::AcqRel);
        if data.send(InvokeResponseBody::Raw(chunk)).is_err() {
            // Webview gone (closed or reloaded): don't leave an orphaned process behind.
            let _ = ctrl.send(Ctrl::Close);
            break 'outer;
        }
        last_send = tokio::time::Instant::now();
        if closed {
            break;
        }
    }

    let code = *shared.exit_code.lock();
    let _ = events.send(SessionEvent::Exit { code });
    sessions.remove(&id);
}
