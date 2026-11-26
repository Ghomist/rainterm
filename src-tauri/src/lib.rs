mod commands;
mod winint;
mod files;
mod ops;
mod proxy;
mod llm;
mod mcp;
mod highlight;
mod history;
mod kb;
mod keys;
mod monitor;
mod proc;
mod session;
mod ssh_config;
mod store;

use files::{FsTarget, Listing, Progress};
use serde_json::Value;
use session::local::ShellSpec;
use session::serial::{PortInfo, SerialTarget};
use session::ssh::SshTarget;
use session::{Ctrl, SessionEvent, Sessions};
use tauri::ipc::{Channel, InvokeResponseBody};

type CmdResult<T> = Result<T, String>;
type S<'a> = tauri::State<'a, Sessions>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

// ------------------------------------------------------------------ sessions

#[tauri::command]
fn list_shells() -> Vec<ShellSpec> {
    session::local::detect_shells()
}

#[tauri::command]
fn list_serial_ports() -> Vec<PortInfo> {
    session::serial::list_ports()
}

#[tauri::command]
fn open_local(
    sessions: S<'_>,
    shell: ShellSpec,
    cols: u16,
    rows: u16,
    highlight: bool,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> CmdResult<String> {
    let (id, io) = sessions.create(on_data, on_event, highlight);
    session::local::spawn(shell, cols, rows, io).map_err(err)?;
    Ok(id)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
fn open_ssh(
    sessions: S<'_>,
    target: SshTarget,
    secret: Option<String>,
    jump_secret: Option<String>,
    cols: u16,
    rows: u16,
    highlight: bool,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> CmdResult<String> {
    let (id, io) = sessions.create(on_data, on_event, highlight);
    session::ssh::spawn(target, secret, jump_secret, cols, rows, io);
    Ok(id)
}

#[tauri::command]
fn open_serial(
    sessions: S<'_>,
    target: SerialTarget,
    highlight: bool,
    on_data: Channel<InvokeResponseBody>,
    on_event: Channel<SessionEvent>,
) -> CmdResult<String> {
    let (id, io) = sessions.create(on_data, on_event, highlight);
    session::serial::spawn(target, io).map_err(err)?;
    Ok(id)
}

#[tauri::command]
fn session_write(sessions: S<'_>, id: String, data: String) -> CmdResult<()> {
    if let Ok(shared) = sessions.shared(&id) {
        *shared.last_input.lock() = Some(std::time::Instant::now());
    }
    sessions.send(&id, Ctrl::Write(data.into_bytes()))
}

#[tauri::command]
fn session_resize(sessions: S<'_>, id: String, cols: u16, rows: u16) -> CmdResult<()> {
    sessions.send(&id, Ctrl::Resize { cols, rows })
}

#[tauri::command]
fn session_ack(sessions: S<'_>, id: String, bytes: usize) {
    sessions.ack(&id, bytes);
}

#[tauri::command]
fn session_close(sessions: S<'_>, id: String) {
    let _ = sessions.send(&id, Ctrl::Close);
}

#[tauri::command]
fn session_close_all(sessions: S<'_>) {
    proc::kill_all();
    sessions.close_all();
}

#[tauri::command]
fn host_key_reply(sessions: S<'_>, id: String, accept: bool) {
    sessions.reply_host_key(&id, accept);
}

#[tauri::command]
fn session_set_highlight(sessions: S<'_>, id: String, enabled: bool) -> CmdResult<()> {
    sessions
        .shared(&id)?
        .highlight
        .store(enabled, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Start (with a file name stem) or stop (None) logging. Returns the log path.
#[tauri::command]
fn session_log(sessions: S<'_>, id: String, name: Option<String>) -> CmdResult<Option<String>> {
    let shared = sessions.shared(&id)?;
    let path = match name {
        Some(name) => {
            let safe: String = name
                .chars()
                .map(|c| if c.is_alphanumeric() || "-_.@".contains(c) { c } else { '_' })
                .collect();
            let ts = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            Some(store::config_dir().map_err(err)?.join("logs").join(format!("{safe}-{ts}.log")))
        }
        None => None,
    };
    session::set_logging(&shared, path.clone()).map_err(err)?;
    Ok(path.map(|p| p.display().to_string()))
}

#[tauri::command]
fn session_log_append(sessions: S<'_>, id: String, text: String) -> CmdResult<()> {
    session::append_log(&*sessions.shared(&id)?, &text).map_err(err)
}

/// Hosts from ~/.ssh/config, plus the local user name as a default.
#[tauri::command]
fn ssh_config_hosts() -> CmdResult<(Vec<ssh_config::HostEntry>, String)> {
    let user = std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "root".into());
    Ok((ssh_config::read_default().map_err(err)?, user))
}

#[tauri::command]
async fn commands_local(shell_id: String, program: String) -> Vec<String> {
    tauri::async_runtime::spawn_blocking(move || commands::local(&shell_id, &program))
        .await
        .unwrap_or_default()
}

#[tauri::command]
async fn commands_remote(sessions: S<'_>, session_id: String) -> CmdResult<Vec<String>> {
    commands::remote(&sessions, &session_id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn history_local(shell_id: String) -> Vec<String> {
    history::local(&shell_id)
}

#[tauri::command]
async fn history_remote(sessions: S<'_>, session_id: String) -> CmdResult<Vec<String>> {
    history::remote(&sessions, &session_id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn monitor_local() -> monitor::Snapshot {
    tauri::async_runtime::spawn_blocking(monitor::local).await.unwrap_or_default()
}

#[tauri::command]
async fn monitor_remote(sessions: S<'_>, session_id: String) -> CmdResult<monitor::Snapshot> {
    monitor::remote(&sessions, &session_id).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn process_kill(sessions: S<'_>, session_id: Option<String>, pid: u32, force: bool) -> CmdResult<()> {
    match session_id {
        Some(id) => monitor::kill_remote(&sessions, &id, pid, force).await,
        None => monitor::kill_local(pid, force),
    }
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ports_list(sessions: S<'_>, session_id: Option<String>) -> CmdResult<Vec<ops::PortEntry>> {
    match session_id {
        Some(id) => ops::ports_remote(&sessions, &id).await,
        None => tauri::async_runtime::spawn_blocking(ops::ports_local).await.map_err(anyhow::Error::from).and_then(|r| r),
    }
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn win_admin(kind: String, verb: String, name: String, path: Option<String>) -> CmdResult<()> {
    ops::win_admin(&kind, &verb, &name, path.as_deref()).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn win_open(tool: String) -> CmdResult<()> {
    ops::win_open(&tool).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ops_query(sessions: S<'_>, session_id: Option<String>, query: ops::Query) -> CmdResult<String> {
    ops::query(&sessions, session_id.as_deref(), &query).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ops_run(sessions: S<'_>, session_id: Option<String>, tool: String, args: Vec<String>) -> CmdResult<ops::RunOutput> {
    ops::run(&sessions, session_id.as_deref(), &tool, &args).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ssh_forward_add(
    sessions: S<'_>,
    session_id: String,
    local_port: u16,
    remote_host: String,
    remote_port: u16,
) -> CmdResult<u16> {
    let conn = sessions.ssh(&session_id)?;
    conn.add_forward(local_port, remote_host, remote_port).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn ssh_forward_stop(sessions: S<'_>, session_id: String, local_port: u16) -> CmdResult<bool> {
    Ok(sessions.ssh(&session_id)?.stop_forward(local_port))
}

#[tauri::command]
async fn ssh_ping(sessions: S<'_>, session_id: String) -> CmdResult<f64> {
    let conn = sessions.ssh(&session_id)?;
    conn.ping().await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ssh_keys_list() -> CmdResult<Vec<keys::KeyInfo>> {
    tauri::async_runtime::spawn_blocking(keys::list).await.map_err(|e| e.to_string())?.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn ssh_key_generate(name: String, comment: String, passphrase: Option<String>) -> CmdResult<keys::KeyInfo> {
    // bcrypt-pbkdf takes a moment: off the async runtime.
    tauri::async_runtime::spawn_blocking(move || keys::generate(&name, &comment, passphrase.as_deref()))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{e:#}"))
}

/// Like `ssh-copy-id`: add a public key to ~/.ssh/authorized_keys on a connected server.
/// Returns "added" or "present".
#[tauri::command]
async fn ssh_copy_id(sessions: S<'_>, session_id: String, public_key: String) -> CmdResult<String> {
    let conn = sessions.ssh(&session_id)?;
    let cmd = keys::copy_id_command(&public_key).map_err(|e| format!("{e:#}"))?;
    let (code, out, err) = conn
        .exec_full(&cmd, std::time::Duration::from_secs(20))
        .await
        .map_err(|e| format!("{e:#}"))?;
    let out = out.trim().to_string();
    if code != 0 || (out != "added" && out != "present") {
        return Err(if err.trim().is_empty() { format!("the server answered: {out}") } else { err.trim().to_string() });
    }
    Ok(out)
}

#[tauri::command]
async fn system_proxy() -> proxy::SystemProxy {
    tauri::async_runtime::spawn_blocking(proxy::system_proxy).await.unwrap_or_default()
}

#[tauri::command]
async fn proxy_test(proxy: proxy::ProxySpec, host: String, port: u16) -> CmdResult<u64> {
    proxy::test(&proxy, &host, port).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn monitor_forget(session_id: String) {
    monitor::forget(&session_id);
}

// ------------------------------------------------------------------ highlighting

#[tauri::command]
fn set_highlight_rules(rules: Vec<highlight::RuleSpec>) -> Vec<String> {
    highlight::set_rules(&rules)
}

#[tauri::command]
fn default_highlight_rules() -> Value {
    let rules: Vec<Value> = highlight::default_rules()
        .into_iter()
        .map(|r| serde_json::json!({ "pattern": r.pattern, "sgr": r.sgr, "enabled": r.enabled }))
        .collect();
    Value::Array(rules)
}

// ------------------------------------------------------------------ agents (processes)

#[tauri::command]
async fn proc_spawn(
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    on_event: Channel<proc::ProcEvent>,
) -> CmdResult<u64> {
    proc::spawn_local(argv, cwd, env.unwrap_or_default(), on_event).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn proc_spawn_remote(sessions: S<'_>, session_id: String, command: String, on_event: Channel<proc::ProcEvent>) -> CmdResult<u64> {
    let conn = sessions.ssh(&session_id)?;
    proc::spawn_remote(&conn, command, on_event).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn proc_write(id: u64, data: String) -> CmdResult<()> {
    proc::write(id, data).map_err(err)
}

#[tauri::command]
fn proc_close_stdin(id: u64) {
    proc::close_stdin(id)
}

#[tauri::command]
fn proc_kill(id: u64) {
    proc::kill(id)
}

#[tauri::command]
async fn proc_run(
    argv: Vec<String>,
    cwd: Option<String>,
    env: Option<std::collections::HashMap<String, String>>,
    input: Option<String>,
    timeout_ms: Option<u64>,
) -> CmdResult<proc::RunOutput> {
    proc::run(argv, cwd, env.unwrap_or_default(), input, timeout_ms.unwrap_or(120_000)).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn proc_run_remote(sessions: S<'_>, session_id: String, command: String, timeout_ms: Option<u64>) -> CmdResult<proc::RunOutput> {
    let conn = sessions.ssh(&session_id)?;
    let t = std::time::Duration::from_millis(timeout_ms.unwrap_or(120_000));
    let (code, stdout, stderr) = conn.exec_full(&command, t).await.map_err(|e| format!("{e:#}"))?;
    Ok(proc::RunOutput { code, stdout, stderr })
}

#[tauri::command]
fn agents_home() -> CmdResult<String> {
    proc::home().map(|p| p.to_string_lossy().into_owned()).map_err(err)
}

#[tauri::command]
fn agents_log_append(run: String, text: String) -> CmdResult<()> {
    proc::log_append(&run, &text).map_err(err)
}

#[tauri::command]
fn agents_log_read(run: String) -> CmdResult<String> {
    proc::log_read(&run).map_err(err)
}

// ------------------------------------------------------------------ knowledge base

#[tauri::command]
fn kb_dir() -> CmdResult<String> {
    kb::dir().map(|p| p.to_string_lossy().into_owned()).map_err(err)
}

#[tauri::command]
async fn kb_list() -> CmdResult<Vec<kb::Entry>> {
    tauri::async_runtime::spawn_blocking(kb::list).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn kb_read(id: String) -> CmdResult<kb::Doc> {
    tauri::async_runtime::spawn_blocking(move || kb::read(&id)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn kb_save(id: Option<String>, title: String, tags: Vec<String>, body: String, source: Option<String>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || kb::save(id.as_deref(), &title, &tags, &body, source.as_deref().unwrap_or("user")))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn kb_delete(id: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || kb::delete(&id)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn kb_import(paths: Vec<String>) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || kb::import(&paths)).await.map_err(err)?.map_err(err)
}

#[tauri::command]
async fn kb_search(query: String, limit: Option<usize>) -> CmdResult<Vec<kb::Hit>> {
    tauri::async_runtime::spawn_blocking(move || kb::search(&query, limit.unwrap_or(8))).await.map_err(err)?.map_err(err)
}

/// Search results / a note as text for a model (built-in agent tools).
#[tauri::command]
async fn kb_tool(name: String, args: serde_json::Value) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || kb::tool(&name, &args))
    .await
    .map_err(err)?
    .map_err(err)
}

#[tauri::command]
fn path_stat(path: String) -> proc::PathInfo {
    proc::stat(&path)
}

#[tauri::command]
async fn file_read_text(path: String, max: Option<usize>) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || proc::read_text(&path, max.unwrap_or(256 * 1024)))
        .await
        .map_err(err)?
        .map_err(err)
}

#[tauri::command]
async fn file_write_text(path: String, text: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || proc::write_text(&path, &text)).await.map_err(err)?.map_err(err)
}

// ------------------------------------------------------------------ backup files

/// Read a JSON file the user picked (settings import). Small JSON files only.
#[tauri::command]
fn text_file_read(path: String) -> CmdResult<String> {
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true) {
        return Err("only .json files".into());
    }
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > 8 * 1024 * 1024 {
        return Err("file is too large".into());
    }
    std::fs::read_to_string(p).map_err(|e| e.to_string())
}

/// Write a JSON file the user picked (settings export).
#[tauri::command]
fn text_file_write(path: String, text: String) -> CmdResult<()> {
    let p = std::path::Path::new(&path);
    if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("json")) != Some(true) {
        return Err("only .json files".into());
    }
    std::fs::write(p, text).map_err(|e| e.to_string())
}

// ------------------------------------------------------------------ files

#[tauri::command]
async fn fs_home(sessions: S<'_>, target: FsTarget) -> CmdResult<String> {
    files::home(&sessions, target).await.map_err(err)
}

#[tauri::command]
async fn fs_list(sessions: S<'_>, target: FsTarget, path: String) -> CmdResult<Listing> {
    files::list(&sessions, target, path).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn fs_mkdir(sessions: S<'_>, target: FsTarget, path: String) -> CmdResult<()> {
    files::mkdir(&sessions, target, path).await.map_err(err)
}

#[tauri::command]
async fn fs_rename(sessions: S<'_>, target: FsTarget, from: String, to: String) -> CmdResult<()> {
    files::rename(&sessions, target, from, to).await.map_err(err)
}

#[tauri::command]
async fn fs_remove(sessions: S<'_>, target: FsTarget, paths: Vec<String>) -> CmdResult<()> {
    files::remove(&sessions, target, paths).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn fs_download(
    sessions: S<'_>,
    session_id: String,
    remotes: Vec<String>,
    local_dir: String,
    job_id: String,
    progress: Channel<Progress>,
) -> CmdResult<Vec<String>> {
    files::download(&sessions, session_id, remotes, local_dir, job_id, progress)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn fs_upload(
    sessions: S<'_>,
    session_id: String,
    locals: Vec<String>,
    remote_dir: String,
    job_id: String,
    progress: Channel<Progress>,
) -> CmdResult<()> {
    files::upload(&sessions, session_id, locals, remote_dir, job_id, progress)
        .await
        .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn fs_cancel(job_id: String) {
    files::cancel(&job_id);
}

#[tauri::command]
fn fs_default_download_dir() -> String {
    files::default_download_dir()
}

#[tauri::command]
async fn fs_edit(
    sessions: S<'_>,
    session_id: String,
    remote: String,
    events: Channel<files::EditEvent>,
) -> CmdResult<String> {
    files::edit((*sessions).clone(), session_id, remote, events)
        .await
        .map_err(|e| format!("{e:#}"))
}

// ------------------------------------------------------------------ persistence

#[tauri::command]
fn store_load(name: String) -> CmdResult<Option<Value>> {
    if !matches!(name.as_str(), "profiles" | "settings" | "session" | "history" | "snippets" | "agents") {
        return Err("unknown store".into());
    }
    store::load(&name).map_err(err)
}

#[tauri::command]
fn store_save(name: String, value: Value) -> CmdResult<()> {
    if !matches!(name.as_str(), "profiles" | "settings" | "session" | "history" | "snippets" | "agents") {
        return Err("unknown store".into());
    }
    store::save(&name, &value).map_err(err)
}

#[tauri::command]
fn secret_get(key: String) -> Option<String> {
    // The agent's API key is only ever read by the backend (llm.rs), never handed to the UI.
    if key.starts_with("agent:") {
        return None;
    }
    store::secret_get(&key)
}

/// Whether a secret exists, without revealing it (Settings shows "key saved").
#[tauri::command]
fn secret_has(key: String) -> bool {
    store::secret_get(&key).is_some_and(|v| !v.is_empty())
}

#[tauri::command]
fn secret_set(key: String, value: String) -> CmdResult<()> {
    store::secret_set(&key, &value).map_err(err)
}

#[tauri::command]
fn secret_delete(key: String) {
    store::secret_delete(&key)
}

/// Turn native translucency (Mica on Windows 11, vibrancy on macOS) on or off.
/// Returns whether it is active.
#[tauri::command]
fn set_window_effects(window: tauri::WebviewWindow, enabled: bool, dark: bool) -> bool {
    #[cfg(target_os = "windows")]
    {
        if enabled {
            return window_vibrancy::apply_mica(&window, Some(dark)).is_ok();
        }
        let _ = window_vibrancy::clear_mica(&window);
        false
    }
    #[cfg(target_os = "macos")]
    {
        use window_vibrancy::{NSVisualEffectMaterial, apply_vibrancy, clear_vibrancy};
        let _ = dark;
        if enabled {
            return apply_vibrancy(&window, NSVisualEffectMaterial::Sidebar, None, None).is_ok();
        }
        let _ = clear_vibrancy(&window);
        false
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        let _ = (window, enabled, dark);
        false
    }
}

/// Tell the OS whether the window is light or dark (affects native bits like shadows).
// ------------------------------------------------------------------ agent (model APIs)

#[tauri::command]
fn llm_chat(id: String, config: llm::LlmConfig, request: llm::ChatRequest, on_event: Channel<llm::LlmEvent>) {
    llm::start(id, config, request, on_event);
}

#[tauri::command]
fn llm_cancel(id: String) -> bool {
    llm::cancel(&id)
}

// ------------------------------------------------------------------ MCP server

#[tauri::command]
async fn mcp_start(app: tauri::AppHandle, host: String, port: u16, token: String) -> CmdResult<String> {
    if token.len() < 16 {
        return Err("token too short".into());
    }
    mcp::start(app, host, port, token).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
fn mcp_set_tools(tools: Vec<String>) {
    mcp::set_tools(tools);
}

#[tauri::command]
fn mcp_stop() {
    mcp::stop();
}

#[tauri::command]
fn mcp_status() -> Option<String> {
    mcp::status()
}

#[tauri::command]
fn mcp_reply(id: u64, result: serde_json::Value) {
    mcp::reply(id, result);
}

// ------------------------------------------------------------------ backgrounds

const IMAGE_EXTS: [&str; 7] = ["png", "jpg", "jpeg", "webp", "gif", "bmp", "avif"];

/// Copy a picked image into ~/.rainterm/backgrounds (so moving the original doesn't
/// break it) and return the copy's path.
#[tauri::command]
fn backdrop_import(src: String) -> CmdResult<String> {
    let src = std::path::PathBuf::from(src);
    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return Err("not a supported image (png, jpg, webp, gif, bmp, avif)".into());
    }
    let dir = store::config_dir().map_err(|e| e.to_string())?.join("backgrounds");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("background");
    let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let dest = dir.join(format!("{stem}-{stamp}.{ext}"));
    std::fs::copy(&src, &dest).map_err(|e| format!("copy {}: {e}", src.display()))?;
    Ok(dest.to_string_lossy().into_owned())
}

/// Raw bytes of a background image (only images inside ~/.rainterm/backgrounds).
#[tauri::command]
fn backdrop_read(path: String) -> CmdResult<tauri::ipc::Response> {
    let dir = store::config_dir().map_err(|e| e.to_string())?.join("backgrounds");
    let p = std::path::PathBuf::from(&path);
    let canon = p.canonicalize().map_err(|e| format!("{path}: {e}"))?;
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    if !canon.starts_with(&root) {
        return Err("background images must live in ~/.rainterm/backgrounds".into());
    }
    let bytes = std::fs::read(&canon).map_err(|e| e.to_string())?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
/// `None` = follow the OS. Forcing a theme also changes what the webview reports as
/// `prefers-color-scheme`, so "follow system" must hand control back to the OS.
fn set_window_appearance(window: tauri::WebviewWindow, dark: Option<bool>) {
    let _ = window.set_theme(dark.map(|d| if d { tauri::Theme::Dark } else { tauri::Theme::Light }));
}

// ------------------------------------------------------------------ launching on a folder

/// The folder this launch was asked to open (`rainterm D:\code`, Explorer's menu).
#[tauri::command]
fn launch_folder() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    winint::folder_from_args(&args, &std::env::current_dir().unwrap_or_default())
}

#[tauri::command]
fn win_integration_status() -> bool {
    winint::installed()
}

#[tauri::command]
async fn win_integration_set(on: bool, label: String) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || winint::set(on, &label)).await.map_err(err)?.map_err(err)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // One TLS backend (ring) for every HTTPS client: the model APIs and the updater.
    let _ = rustls::crypto::ring::default_provider().install_default();
    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default();
    // One window: launching again (Explorer's "Open in rainterm", `rainterm .`) opens a tab in
    // the running app. Not in dev builds, so a dev copy can run beside the installed one.
    #[cfg(all(not(debug_assertions), desktop))]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, cwd| {
            use tauri::{Emitter, Manager};
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
            if let Some(folder) = winint::folder_from_args(&argv, std::path::Path::new(&cwd)) {
                let _ = app.emit("open-folder", folder);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        // Updates: signed installers from GitHub releases (latest.json), then a restart.
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_notification::init())
        // Remember window size / position / maximized state between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            list_shells,
            ssh_keys_list,
            ssh_key_generate,
            ssh_copy_id,
            text_file_read,
            text_file_write,
            proc_spawn,
            proc_spawn_remote,
            proc_write,
            proc_close_stdin,
            proc_kill,
            proc_run,
            proc_run_remote,
            agents_home,
            agents_log_append,
            agents_log_read,
            path_stat,
            kb_dir,
            kb_list,
            kb_read,
            kb_save,
            kb_delete,
            kb_import,
            kb_search,
            kb_tool,
            file_read_text,
            file_write_text,
            list_serial_ports,
            open_local,
            open_ssh,
            open_serial,
            session_write,
            session_resize,
            session_ack,
            session_close,
            session_close_all,
            host_key_reply,
            session_set_highlight,
            session_log,
            session_log_append,
            ssh_config_hosts,
            history_local,
            commands_local,
            commands_remote,
            ports_list,
            ops_run,
            ops_query,
            win_admin,
            win_open,
            ssh_forward_add,
            ssh_forward_stop,
            ssh_ping,
            proxy_test,
            system_proxy,
            backdrop_import,
            llm_chat,
            mcp_start,
            launch_folder,
            win_integration_status,
            win_integration_set,
            mcp_set_tools,
            mcp_stop,
            mcp_status,
            mcp_reply,
            secret_has,
            llm_cancel,
            backdrop_read,
            monitor_local,
            monitor_remote,
            monitor_forget,
            process_kill,
            history_remote,
            set_highlight_rules,
            default_highlight_rules,
            fs_home,
            fs_list,
            fs_mkdir,
            fs_rename,
            fs_remove,
            fs_download,
            fs_upload,
            fs_cancel,
            fs_default_download_dir,
            fs_edit,
            store_load,
            store_save,
            secret_get,
            secret_set,
            secret_delete,
            set_window_effects,
            set_window_appearance,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
