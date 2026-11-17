mod commands;
mod files;
mod highlight;
mod history;
mod monitor;
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
    if !matches!(name.as_str(), "profiles" | "settings" | "session" | "history" | "snippets") {
        return Err("unknown store".into());
    }
    store::load(&name).map_err(err)
}

#[tauri::command]
fn store_save(name: String, value: Value) -> CmdResult<()> {
    if !matches!(name.as_str(), "profiles" | "settings" | "session" | "history" | "snippets") {
        return Err("unknown store".into());
    }
    store::save(&name, &value).map_err(err)
}

#[tauri::command]
fn secret_get(key: String) -> Option<String> {
    store::secret_get(&key)
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
#[tauri::command]
fn set_window_appearance(window: tauri::WebviewWindow, dark: bool) {
    let _ = window.set_theme(Some(if dark { tauri::Theme::Dark } else { tauri::Theme::Light }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        // Remember window size / position / maximized state between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(Sessions::default())
        .invoke_handler(tauri::generate_handler![
            list_shells,
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
