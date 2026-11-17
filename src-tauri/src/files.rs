//! File browser backend: one API over the local filesystem and SFTP, plus a transfer
//! engine (recursive, cancellable, with progress) and "edit remote file" sync.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant, UNIX_EPOCH};

use parking_lot::Mutex;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::session::Sessions;

#[derive(Debug, Clone, Deserialize)]
// `rename_all` only renames variants; `rename_all_fields` is what maps the
// frontend's `sessionId` onto `session_id`.
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase", tag = "kind")]
pub enum FsTarget {
    Local,
    Ssh { session_id: String },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub kind: &'static str, // "dir" | "file" | "link"
    pub size: u64,
    pub mtime: Option<u64>,
    pub mode: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub parent: Option<String>,
    pub sep: &'static str,
    pub entries: Vec<Entry>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub done: u64,
    pub total: u64,
    pub files_done: u32,
    pub files_total: u32,
    pub current: String,
}

async fn sftp_of(sessions: &Sessions, id: &str) -> anyhow::Result<Arc<SftpSession>> {
    sessions.ssh(id).map_err(anyhow::Error::msg)?.sftp().await
}

fn remote_parent(path: &str) -> Option<String> {
    if path == "/" || path.is_empty() {
        return None;
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => Some("/".into()),
        Some(i) => Some(trimmed[..i].into()),
        None => None,
    }
}

pub fn remote_join(dir: &str, name: &str) -> String {
    if dir.ends_with('/') { format!("{dir}{name}") } else { format!("{dir}/{name}") }
}

fn remote_name(path: &str) -> String {
    path.trim_end_matches('/').rsplit('/').next().unwrap_or(path).to_string()
}

/// Strip Windows' `\\?\` verbatim prefix for display.
fn display_local(p: &Path) -> String {
    let s = p.display().to_string();
    s.strip_prefix(r"\\?\").map(str::to_string).unwrap_or(s)
}

pub async fn home(sessions: &Sessions, target: FsTarget) -> anyhow::Result<String> {
    match target {
        FsTarget::Local => Ok(dirs::home_dir().unwrap_or_else(|| PathBuf::from("/")).display().to_string()),
        FsTarget::Ssh { session_id } => Ok(sftp_of(sessions, &session_id).await?.canonicalize(".").await?),
    }
}

pub async fn list(sessions: &Sessions, target: FsTarget, path: String) -> anyhow::Result<Listing> {
    match target {
        FsTarget::Local => {
            let p = std::fs::canonicalize(&path)?;
            let mut entries = Vec::new();
            for e in std::fs::read_dir(&p)? {
                let Ok(e) = e else { continue };
                let Ok(meta) = e.metadata() else { continue };
                let ft = e.file_type().ok();
                entries.push(Entry {
                    name: e.file_name().to_string_lossy().into_owned(),
                    kind: if ft.is_some_and(|t| t.is_symlink()) {
                        "link"
                    } else if meta.is_dir() {
                        "dir"
                    } else {
                        "file"
                    },
                    size: meta.len(),
                    mtime: meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_secs()),
                    mode: None,
                });
            }
            Ok(Listing {
                parent: p.parent().map(display_local),
                path: display_local(&p),
                sep: std::path::MAIN_SEPARATOR_STR,
                entries,
            })
        }
        FsTarget::Ssh { session_id } => {
            let sftp = sftp_of(sessions, &session_id).await?;
            let path = sftp.canonicalize(path).await?;
            let mut entries = Vec::new();
            for e in sftp.read_dir(path.clone()).await? {
                let name = e.file_name();
                if name == "." || name == ".." {
                    continue;
                }
                let m = e.metadata();
                let mut kind = if m.is_symlink() {
                    "link"
                } else if m.is_dir() {
                    "dir"
                } else {
                    "file"
                };
                // Symlinks to directories should behave like directories.
                if kind == "link" {
                    if let Ok(t) = sftp.metadata(remote_join(&path, &name)).await {
                        if t.is_dir() {
                            kind = "dir";
                        }
                    }
                }
                entries.push(Entry { name, kind, size: m.size.unwrap_or(0), mtime: m.mtime.map(u64::from), mode: m.permissions });
            }
            Ok(Listing { parent: remote_parent(&path), path, sep: "/", entries })
        }
    }
}

pub async fn mkdir(sessions: &Sessions, target: FsTarget, path: String) -> anyhow::Result<()> {
    match target {
        FsTarget::Local => Ok(std::fs::create_dir(path)?),
        FsTarget::Ssh { session_id } => Ok(sftp_of(sessions, &session_id).await?.create_dir(path).await?),
    }
}

pub async fn rename(sessions: &Sessions, target: FsTarget, from: String, to: String) -> anyhow::Result<()> {
    match target {
        FsTarget::Local => Ok(std::fs::rename(from, to)?),
        FsTarget::Ssh { session_id } => Ok(sftp_of(sessions, &session_id).await?.rename(from, to).await?),
    }
}

/// Delete entries. Local: moved to the Recycle Bin / Trash. Remote: permanent,
/// directories are removed recursively.
pub async fn remove(sessions: &Sessions, target: FsTarget, paths: Vec<String>) -> anyhow::Result<()> {
    match target {
        FsTarget::Local => Ok(trash::delete_all(&paths)?),
        FsTarget::Ssh { session_id } => {
            let sftp = sftp_of(sessions, &session_id).await?;
            for p in paths {
                remove_remote(&sftp, &p).await?;
            }
            Ok(())
        }
    }
}

async fn remove_remote(sftp: &SftpSession, path: &str) -> anyhow::Result<()> {
    let meta = sftp.symlink_metadata(path.to_string()).await?;
    if meta.is_dir() {
        for e in sftp.read_dir(path.to_string()).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            Box::pin(remove_remote(sftp, &remote_join(path, &name))).await?;
        }
        sftp.remove_dir(path.to_string()).await?;
    } else {
        sftp.remove_file(path.to_string()).await?;
    }
    Ok(())
}

// ------------------------------------------------------------------ transfers

static JOBS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = LazyLock::new(Default::default);

pub fn cancel(job_id: &str) {
    if let Some(flag) = JOBS.lock().get(job_id) {
        flag.store(true, Ordering::Relaxed);
    }
}

struct Job {
    cancel: Arc<AtomicBool>,
    progress: Channel<Progress>,
    p: Progress,
    last: Instant,
    id: String,
}

impl Job {
    fn new(id: String, progress: Channel<Progress>) -> Self {
        let cancel = Arc::new(AtomicBool::new(false));
        JOBS.lock().insert(id.clone(), cancel.clone());
        Self {
            cancel,
            progress,
            p: Progress { done: 0, total: 0, files_done: 0, files_total: 0, current: String::new() },
            last: Instant::now() - Duration::from_secs(1),
            id,
        }
    }
    fn check(&self) -> anyhow::Result<()> {
        if self.cancel.load(Ordering::Relaxed) {
            anyhow::bail!("cancelled");
        }
        Ok(())
    }
    fn report(&mut self, force: bool) {
        if force || self.last.elapsed() > Duration::from_millis(120) {
            let _ = self.progress.send(self.p.clone());
            self.last = Instant::now();
        }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        JOBS.lock().remove(&self.id);
    }
}

const CHUNK: usize = 256 * 1024;

async fn pump<R, W>(src: &mut R, dst: &mut W, job: &mut Job) -> anyhow::Result<()>
where
    R: tokio::io::AsyncRead + Unpin,
    W: tokio::io::AsyncWrite + Unpin,
{
    let mut buf = vec![0u8; CHUNK];
    loop {
        job.check()?;
        let n = src.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        dst.write_all(&buf[..n]).await?;
        job.p.done += n as u64;
        job.report(false);
    }
    dst.flush().await?;
    Ok(())
}

/// Plan of a recursive transfer: (source, destination, size); None size = directory.
type Plan = Vec<(String, PathBuf, Option<u64>)>;

async fn plan_download(sftp: &SftpSession, remote: &str, local: PathBuf, plan: &mut Plan) -> anyhow::Result<()> {
    let meta = sftp.metadata(remote.to_string()).await?;
    if meta.is_dir() {
        plan.push((remote.to_string(), local.clone(), None));
        for e in sftp.read_dir(remote.to_string()).await? {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            Box::pin(plan_download(sftp, &remote_join(remote, &name), local.join(&name), plan)).await?;
        }
    } else {
        plan.push((remote.to_string(), local, Some(meta.size.unwrap_or(0))));
    }
    Ok(())
}

/// Download remote files/folders into `local_dir`. Returns the local paths created.
pub async fn download(
    sessions: &Sessions,
    session_id: String,
    remotes: Vec<String>,
    local_dir: String,
    job_id: String,
    progress: Channel<Progress>,
) -> anyhow::Result<Vec<String>> {
    let sftp = sftp_of(sessions, &session_id).await?;
    let mut job = Job::new(job_id, progress);
    let mut plan = Plan::new();
    let mut roots = Vec::new();
    for r in &remotes {
        let dst = unique_local(&Path::new(&local_dir).join(remote_name(r)));
        roots.push(dst.display().to_string());
        plan_download(&sftp, r, dst, &mut plan).await?;
        job.check()?;
    }
    job.p.total = plan.iter().filter_map(|x| x.2).sum();
    job.p.files_total = plan.iter().filter(|x| x.2.is_some()).count() as u32;
    job.report(true);
    for (src, dst, size) in plan {
        job.check()?;
        match size {
            None => tokio::fs::create_dir_all(&dst).await?,
            Some(_) => {
                job.p.current = remote_name(&src);
                let mut s = sftp.open(src).await?;
                let mut d = tokio::fs::File::create(&dst).await?;
                if let Err(e) = pump(&mut s, &mut d, &mut job).await {
                    drop(d);
                    let _ = tokio::fs::remove_file(&dst).await; // no half-written files
                    return Err(e);
                }
                job.p.files_done += 1;
            }
        }
    }
    job.report(true);
    Ok(roots)
}

fn plan_upload(local: &Path, remote: String, plan: &mut Plan) -> anyhow::Result<()> {
    let meta = std::fs::metadata(local)?;
    if meta.is_dir() {
        plan.push((remote.clone(), local.to_path_buf(), None));
        for e in std::fs::read_dir(local)? {
            let e = e?;
            let name = e.file_name().to_string_lossy().into_owned();
            plan_upload(&e.path(), remote_join(&remote, &name), plan)?;
        }
    } else {
        plan.push((remote, local.to_path_buf(), Some(meta.len())));
    }
    Ok(())
}

/// Upload local files/folders into `remote_dir`.
pub async fn upload(
    sessions: &Sessions,
    session_id: String,
    locals: Vec<String>,
    remote_dir: String,
    job_id: String,
    progress: Channel<Progress>,
) -> anyhow::Result<()> {
    let sftp = sftp_of(sessions, &session_id).await?;
    let mut job = Job::new(job_id, progress);
    let mut plan = Plan::new();
    for l in &locals {
        let p = Path::new(l);
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        plan_upload(p, remote_join(&remote_dir, &name), &mut plan)?;
    }
    job.p.total = plan.iter().filter_map(|x| x.2).sum();
    job.p.files_total = plan.iter().filter(|x| x.2.is_some()).count() as u32;
    job.report(true);
    for (dst, src, size) in plan {
        job.check()?;
        match size {
            None => {
                if !sftp.try_exists(dst.clone()).await.unwrap_or(false) {
                    sftp.create_dir(dst).await?;
                }
            }
            Some(_) => {
                job.p.current = src.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
                let mut s = tokio::fs::File::open(&src).await?;
                let mut d = sftp.create(dst).await?;
                pump(&mut s, &mut d, &mut job).await?;
                d.shutdown().await?;
                job.p.files_done += 1;
            }
        }
    }
    job.report(true);
    Ok(())
}

/// `name`, `name (1)`, `name (2)`… so downloads never overwrite.
fn unique_local(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let ext = p.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    for i in 1.. {
        let c = p.with_file_name(format!("{stem} ({i}){ext}"));
        if !c.exists() {
            return c;
        }
    }
    unreachable!()
}

pub fn default_download_dir() -> String {
    dirs::download_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
        .display()
        .to_string()
}

// ------------------------------------------------------------------ edit remote file

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum EditEvent {
    Opened { local: String },
    Synced { bytes: u64 },
    Error { message: String },
    Stopped,
}

/// Download a remote file to a temp dir, return its local path, and watch it: every
/// save is uploaded back. Watching stops when the SSH session goes away.
pub async fn edit(
    sessions: Sessions,
    session_id: String,
    remote: String,
    events: Channel<EditEvent>,
) -> anyhow::Result<String> {
    let sftp = sftp_of(&sessions, &session_id).await?;
    let dir = std::env::temp_dir().join("rainterm-edit").join(uuid::Uuid::new_v4().to_string());
    tokio::fs::create_dir_all(&dir).await?;
    let local = dir.join(remote_name(&remote));
    let data = sftp.read(remote.clone()).await?;
    tokio::fs::write(&local, &data).await?;
    let local_str = local.display().to_string();
    let _ = events.send(EditEvent::Opened { local: local_str.clone() });

    tokio::spawn(async move {
        let mtime = |p: &Path| std::fs::metadata(p).and_then(|m| m.modified()).ok();
        let mut last = mtime(&local);
        loop {
            tokio::time::sleep(Duration::from_millis(800)).await;
            let Ok(conn) = sessions.ssh(&session_id) else { break };
            let now = mtime(&local);
            if now.is_none() {
                break; // temp file deleted
            }
            if now != last {
                last = now;
                // Editors often write in two steps; give them a moment.
                tokio::time::sleep(Duration::from_millis(150)).await;
                let res = async {
                    let bytes = tokio::fs::read(&local).await?;
                    // `create` truncates (plain `write` would leave a stale tail).
                    let mut f = conn.sftp().await?.create(remote.clone()).await?;
                    f.write_all(&bytes).await?;
                    f.shutdown().await?;
                    Ok::<_, anyhow::Error>(bytes.len() as u64)
                }
                .await;
                let _ = events.send(match res {
                    Ok(bytes) => EditEvent::Synced { bytes },
                    Err(e) => EditEvent::Error { message: format!("{e:#}") },
                });
            }
        }
        let _ = events.send(EditEvent::Stopped);
    });
    Ok(local_str)
}
