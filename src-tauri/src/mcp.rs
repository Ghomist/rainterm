//! MCP server (Model Context Protocol, Streamable HTTP transport) so other agents can use
//! rainterm's terminals: `POST /mcp` with JSON-RPC 2.0, answered as `application/json`.
//!
//! The protocol lives here; the tools themselves run in the webview (that's where the
//! terminals are): a `tools/call` is emitted as an `mcp-call` event and the frontend
//! answers through `mcp_reply`. Every request needs `Authorization: Bearer <token>`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use anyhow::{bail, Context};
use parking_lot::Mutex;
use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;

const PROTOCOL: &str = "2025-06-18";
const MAX_BODY: usize = 4 * 1024 * 1024;

#[derive(Default)]
struct State {
    task: Option<tauri::async_runtime::JoinHandle<()>>,
    addr: Option<String>,
}

fn state() -> &'static Mutex<State> {
    static S: OnceLock<Mutex<State>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Tool calls waiting for the frontend, by call id.
fn pending() -> &'static Mutex<HashMap<u64, oneshot::Sender<Value>>> {
    static P: OnceLock<Mutex<HashMap<u64, oneshot::Sender<Value>>>> = OnceLock::new();
    P.get_or_init(Default::default)
}
static NEXT: AtomicU64 = AtomicU64::new(1);

/// Tools the user switched on in Settings (None = not told yet: everything).
fn allowed() -> &'static Mutex<Option<std::collections::HashSet<String>>> {
    static A: OnceLock<Mutex<Option<std::collections::HashSet<String>>>> = OnceLock::new();
    A.get_or_init(Default::default)
}

/// Settings → MCP permissions: only these tools are listed and callable.
pub fn set_tools(names: Vec<String>) {
    *allowed().lock() = Some(names.into_iter().collect());
}

fn is_allowed(name: &str) -> bool {
    allowed().lock().as_ref().is_none_or(|a| a.contains(name))
}

#[derive(Serialize, Clone)]
struct CallEvent {
    id: u64,
    name: String,
    args: Value,
}

/// (Re)start listening on host:port. Returns the bound address.
pub async fn start(app: AppHandle, host: String, port: u16, token: String) -> anyhow::Result<String> {
    stop();
    let listener = TcpListener::bind((host.as_str(), port)).await.with_context(|| format!("listen on {host}:{port}"))?;
    let addr = listener.local_addr()?.to_string();
    let token = Arc::new(token);
    let task = tauri::async_runtime::spawn(async move {
        loop {
            let Ok((sock, _)) = listener.accept().await else { break };
            let (app, token) = (app.clone(), token.clone());
            tauri::async_runtime::spawn(async move {
                let _ = serve(sock, app, token).await;
            });
        }
    });
    let mut st = state().lock();
    st.task = Some(task);
    st.addr = Some(addr.clone());
    Ok(addr)
}

pub fn stop() {
    let mut st = state().lock();
    if let Some(t) = st.task.take() {
        t.abort();
    }
    st.addr = None;
}

pub fn status() -> Option<String> {
    state().lock().addr.clone()
}

/// The frontend's answer to a tool call: an MCP `CallToolResult`.
pub fn reply(id: u64, result: Value) {
    if let Some(tx) = pending().lock().remove(&id) {
        let _ = tx.send(result);
    }
}

// ------------------------------------------------------------------ HTTP

struct Request {
    method: String,
    path: String,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

async fn read_request(r: &mut BufReader<&mut TcpStream>) -> anyhow::Result<Option<Request>> {
    let mut line = String::new();
    if r.read_line(&mut line).await? == 0 {
        return Ok(None);
    }
    let mut parts = line.split_whitespace();
    let method = parts.next().unwrap_or("").to_string();
    let path = parts.next().unwrap_or("").to_string();
    let mut headers = HashMap::new();
    loop {
        let mut h = String::new();
        if r.read_line(&mut h).await? == 0 || h == "\r\n" || h == "\n" {
            break;
        }
        if headers.len() > 100 {
            bail!("too many headers");
        }
        if let Some((k, v)) = h.split_once(':') {
            headers.insert(k.trim().to_ascii_lowercase(), v.trim().to_string());
        }
    }
    let len: usize = headers.get("content-length").and_then(|v| v.parse().ok()).unwrap_or(0);
    if len > MAX_BODY {
        bail!("body too large");
    }
    let mut body = vec![0; len];
    r.read_exact(&mut body).await?;
    Ok(Some(Request { method, path, headers, body }))
}

async fn respond(w: &mut TcpStream, status: &str, ctype: &str, body: &[u8], extra: &[(&str, String)]) -> std::io::Result<()> {
    let mut head = format!("HTTP/1.1 {status}\r\nContent-Length: {}\r\n", body.len());
    if !ctype.is_empty() {
        head.push_str(&format!("Content-Type: {ctype}\r\n"));
    }
    for (k, v) in extra {
        head.push_str(&format!("{k}: {v}\r\n"));
    }
    head.push_str("\r\n");
    w.write_all(head.as_bytes()).await?;
    w.write_all(body).await?;
    w.flush().await
}

/// Constant-time-ish comparison (length leak only).
fn same(a: &str, b: &str) -> bool {
    a.len() == b.len() && a.bytes().zip(b.bytes()).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

async fn serve(mut sock: TcpStream, app: AppHandle, token: Arc<String>) -> anyhow::Result<()> {
    loop {
        let req = {
            let mut r = BufReader::new(&mut sock);
            match read_request(&mut r).await? {
                Some(r) => r,
                None => return Ok(()),
            }
        };
        let path = req.path.split('?').next().unwrap_or("");
        // `/mcp/kb` serves only the knowledge tools (for agents that get no terminals).
        let kb_only = match path {
            "/mcp" => false,
            "/mcp/kb" => true,
            _ => {
                respond(&mut sock, "404 Not Found", "text/plain", b"rainterm MCP endpoint is /mcp", &[]).await?;
                continue;
            }
        };
        let auth_ok = req
            .headers
            .get("authorization")
            .and_then(|v| v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")))
            .is_some_and(|t| same(t.trim(), &token));
        if !auth_ok {
            let body = json!({"jsonrpc":"2.0","id":null,"error":{"code":-32001,"message":"Unauthorized: send Authorization: Bearer <token> (Settings → Agent → MCP server)"}});
            respond(&mut sock, "401 Unauthorized", "application/json", body.to_string().as_bytes(), &[("WWW-Authenticate", "Bearer".into())]).await?;
            continue;
        }
        match req.method.as_str() {
            "POST" => {}
            // No server-initiated stream: we only answer requests.
            "GET" => {
                respond(&mut sock, "405 Method Not Allowed", "", b"", &[("Allow", "POST".into())]).await?;
                continue;
            }
            "DELETE" => {
                respond(&mut sock, "200 OK", "", b"", &[]).await?;
                continue;
            }
            _ => {
                respond(&mut sock, "405 Method Not Allowed", "", b"", &[("Allow", "POST".into())]).await?;
                continue;
            }
        }
        let msg: Value = match serde_json::from_slice(&req.body) {
            Ok(v) => v,
            Err(e) => {
                let body = json!({"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":format!("parse error: {e}")}});
                respond(&mut sock, "400 Bad Request", "application/json", body.to_string().as_bytes(), &[]).await?;
                continue;
            }
        };
        // A batch or a single message.
        let replies: Vec<Value> = match msg {
            Value::Array(items) => {
                let mut out = Vec::new();
                for m in items {
                    if let Some(r) = handle(&app, m, kb_only).await {
                        out.push(r);
                    }
                }
                out
            }
            m => handle(&app, m, kb_only).await.into_iter().collect(),
        };
        let session = [("Mcp-Session-Id", "rainterm".to_string())];
        if replies.is_empty() {
            // Notifications / responses only.
            respond(&mut sock, "202 Accepted", "", b"", &session).await?;
        } else {
            let body = if replies.len() == 1 { replies[0].to_string() } else { Value::Array(replies).to_string() };
            respond(&mut sock, "200 OK", "application/json", body.as_bytes(), &session).await?;
        }
    }
}

// ------------------------------------------------------------------ JSON-RPC

async fn handle(app: &AppHandle, m: Value, kb_only: bool) -> Option<Value> {
    let id = m.get("id").cloned();
    let method = m.get("method").and_then(|v| v.as_str()).unwrap_or("");
    // Notifications (no id) and client responses get no reply.
    let id = id?;
    let ok = |result: Value| Some(json!({"jsonrpc":"2.0","id":id,"result":result}));
    let err = |code: i64, message: String| Some(json!({"jsonrpc":"2.0","id":id,"error":{"code":code,"message":message}}));
    match method {
        "initialize" => {
            let requested = m.pointer("/params/protocolVersion").and_then(|v| v.as_str()).unwrap_or(PROTOCOL);
            let version = if ["2025-06-18", "2025-03-26", "2024-11-05"].contains(&requested) { requested } else { PROTOCOL };
            ok(json!({
                "protocolVersion": version,
                "capabilities": { "tools": { "listChanged": false } },
                "serverInfo": { "name": "rainterm", "version": env!("CARGO_PKG_VERSION") },
                "instructions": if kb_only { KB_HINT.to_string() } else { format!("Terminals of the rainterm app the user is looking at. Commands you run appear in a real, visible terminal tab and may need the user's approval. Use list_terminals first; prefer non-interactive, bounded commands. {KB_HINT}") }
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": listed(kb_only) })),
        "tools/call" => {
            let name = m.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !listed(kb_only).iter().any(|t| t["name"] == name) {
                let known = tools(kb_only).iter().any(|t| t["name"] == name);
                return err(-32602, if known { format!("tool {name} is turned off in rainterm (Settings → Agent → MCP server → permissions)") } else { format!("unknown tool: {name}") });
            }
            let args = m.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            let r = if crate::kb::TOOLS.contains(&name.as_str()) { knowledge(&name, &args).await } else { call(app, name, args).await };
            match r {
                Ok(r) => ok(r),
                Err(e) => ok(json!({ "content": [{ "type": "text", "text": format!("{e:#}") }], "isError": true })),
            }
        }
        "resources/list" => ok(json!({ "resources": [] })),
        "prompts/list" => ok(json!({ "prompts": [] })),
        _ => err(-32601, format!("method not found: {method}")),
    }
}

async fn call(app: &AppHandle, name: String, args: Value) -> anyhow::Result<Value> {
    let id = NEXT.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = oneshot::channel();
    pending().lock().insert(id, tx);
    if let Err(e) = app.emit("mcp-call", CallEvent { id, name, args }) {
        pending().lock().remove(&id);
        bail!("rainterm window unavailable: {e}");
    }
    // Long enough for a command plus the user's approval.
    match tokio::time::timeout(Duration::from_secs(15 * 60), rx).await {
        Ok(Ok(v)) => Ok(v),
        _ => {
            pending().lock().remove(&id);
            bail!("no answer from rainterm (window closed or call timed out)")
        }
    }
}

const KB_HINT: &str = "The knowledge base (notes on the user's servers, projects, procedures and conventions, shared by every agent) is searchable with search_knowledge: check it before guessing at hosts, paths or house rules. When you learn something durable about their environment, save it with save_knowledge for next time.";

/// The knowledge tools run here, without the window.
async fn knowledge(name: &str, args: &Value) -> anyhow::Result<Value> {
    let name = name.to_string();
    let args = args.clone();
    let text = tokio::task::spawn_blocking(move || crate::kb::tool(&name, &args)).await??;
    Ok(json!({ "content": [{ "type": "text", "text": text }] }))
}

pub fn kb_tools() -> Vec<Value> {
    crate::kb::tool_defs()
}

/// What a client may see and call: the user's choice (the knowledge-only endpoint serves
/// rainterm's own agents and isn't filtered).
fn listed(kb_only: bool) -> Vec<Value> {
    let all = tools(kb_only);
    if kb_only {
        return all;
    }
    all.into_iter().filter(|t| t["name"].as_str().is_some_and(is_allowed)).collect()
}

fn tools(kb_only: bool) -> Vec<Value> {
    if kb_only {
        return kb_tools();
    }
    let term = json!({ "type": "string", "description": "Terminal id from list_terminals (default: the one the user is looking at)." });
    vec![
        json!({
            "name": "list_terminals",
            "description": "List the terminals open in rainterm: id, title, kind (local / ssh / serial), host, whether it's the active one and whether it's at a prompt.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "run_command",
            "description": "Type a command into a terminal and press Enter, visibly; wait for it to finish and return its output (long output is cut to head and tail) and exit code when known. The user may have to approve it. Use non-interactive, bounded commands (no pagers / editors).",
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string" },
                "terminal": term,
                "timeout_seconds": { "type": "number", "description": "Default 30, max 600." }
            }, "required": ["command"], "additionalProperties": false }
        }),
        json!({
            "name": "read_terminal",
            "description": "Read the last lines of a terminal (or the whole screen when a full-screen program is open).",
            "inputSchema": { "type": "object", "properties": {
                "terminal": term,
                "lines": { "type": "number", "description": "Default 60, max 300." }
            }, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "send_keys",
            "description": "Send keystrokes to a terminal: plain text as is, special keys in angle brackets: <Enter> <Tab> <Esc> <Up> <Down> <Left> <Right> <Backspace> <C-c> <C-d>. Returns the screen afterwards. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "keys": { "type": "string" },
                "terminal": term
            }, "required": ["keys"], "additionalProperties": false }
        }),
        json!({
            "name": "list_hosts",
            "description": "List the saved sessions (SSH hosts and serial ports) and the local shells that open_terminal can open.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "open_terminal",
            "description": "Open a terminal: a saved session (by id or name from list_hosts) or a local shell, in a new tab or split beside an open terminal (different hosts can share one tab). Returns its terminal id once connected. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "session": { "type": "string", "description": "Saved session id or name." },
                "shell": { "type": "string", "description": "Local shell id or name (when no session is given)." },
                "split": { "type": "string", "enum": ["right", "left", "down", "up"], "description": "Open it split beside `beside` (default: the active terminal) instead of in a new tab." },
                "beside": term
            }, "additionalProperties": false }
        }),
        json!({
            "name": "focus_terminal",
            "description": "Bring a terminal on screen and focus it (switches to its tab).",
            "inputSchema": { "type": "object", "properties": { "terminal": term }, "required": ["terminal"], "additionalProperties": false }
        }),
        json!({
            "name": "close_terminal",
            "description": "Close a terminal (disconnects it). The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": { "terminal": term }, "required": ["terminal"], "additionalProperties": false },
            "annotations": { "destructiveHint": true }
        }),
        json!({
            "name": "save_session",
            "description": "Add a saved SSH session to the sessions list, or change one (pass `session`, its id or name). Passwords are never set this way: the user types them on first connect. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "session": { "type": "string", "description": "Existing session id or name to change (omit to add a new one)." },
                "name": { "type": "string" },
                "host": { "type": "string" },
                "port": { "type": "number" },
                "user": { "type": "string" },
                "group": { "type": "string", "description": "Group (folder) in the sessions list; empty = ungrouped." },
                "auth": { "type": "string", "enum": ["auto", "password", "key", "agent"] },
                "key_path": { "type": "string", "description": "Private key file, for auth = key." },
                "startup": { "type": "string", "description": "Commands typed after every connect, one per line (e.g. `cd /srv/app`). Empty string clears them." }
            }, "additionalProperties": false }
        }),
        json!({
            "name": "delete_session",
            "description": "Remove a saved session from the sessions list (asks the user unless rainterm is in Full auto mode).",
            "inputSchema": { "type": "object", "properties": { "session": { "type": "string", "description": "Session id or name." } }, "required": ["session"], "additionalProperties": false },
            "annotations": { "destructiveHint": true }
        }),
        json!({
            "name": "list_snippets",
            "description": "List the user's saved quick commands (snippets): id, name, group, the command (may span lines; `{{name}}`, `{{name:default}}` and `{{name|a|b}}` are blanks to fill), whether it runs or only types itself in, and its blanks.",
            "inputSchema": { "type": "object", "properties": {}, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "run_snippet",
            "description": "Run one of the user's quick commands in a terminal, visibly, and return the output and exit code (each line in turn; stops at the first failure). Fill its blanks with `values`. A quick command that isn't set to run is only typed at the prompt. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "snippet": { "type": "string", "description": "Quick command id or name (see list_snippets)." },
                "terminal": term,
                "values": { "type": "object", "additionalProperties": { "type": "string" }, "description": "Values for its blanks, by name." },
                "timeout_seconds": { "type": "number", "description": "Per line, default 30, max 600." }
            }, "required": ["snippet"], "additionalProperties": false }
        }),
        json!({
            "name": "save_snippet",
            "description": "Add a quick command to the user's list, or change one (pass `snippet`, its id or name). Blanks: `{{name}}`, `{{name:default}}`, `{{name|choice|choice}}`. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "snippet": { "type": "string", "description": "Existing quick command id or name to change (omit to add one)." },
                "name": { "type": "string" },
                "command": { "type": "string", "description": "One or more lines." },
                "group": { "type": "string" },
                "run": { "type": "boolean", "description": "Press Enter after it (default true); false = only type it in." }
            }, "additionalProperties": false }
        }),
        json!({
            "name": "delete_snippet",
            "description": "Remove a quick command from the user's list (asks the user unless rainterm is in Full auto mode).",
            "inputSchema": { "type": "object", "properties": { "snippet": { "type": "string", "description": "Quick command id or name." } }, "required": ["snippet"], "additionalProperties": false },
            "annotations": { "destructiveHint": true }
        }),
        json!({
            "name": "list_files",
            "description": "List a folder on a terminal's machine (the SSH host for SSH terminals, this computer for local ones). Default: the terminal's home folder.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": term,
                "path": { "type": "string" }
            }, "additionalProperties": false },
            "annotations": { "readOnlyHint": true }
        }),
        json!({
            "name": "upload_files",
            "description": "Upload files or folders from this computer to an SSH terminal's host (shown in rainterm's transfers). The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": term,
                "local_paths": { "type": "array", "items": { "type": "string" } },
                "remote_dir": { "type": "string" }
            }, "required": ["local_paths", "remote_dir"], "additionalProperties": false }
        }),
        json!({
            "name": "download_files",
            "description": "Download files or folders from an SSH terminal's host to this computer (default: the Downloads folder). Returns the local paths. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": term,
                "remote_paths": { "type": "array", "items": { "type": "string" } },
                "local_dir": { "type": "string" }
            }, "required": ["remote_paths"], "additionalProperties": false }
        }),
    ]
    .into_iter()
    .chain(kb_tools())
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_compare() {
        assert!(same("abc", "abc"));
        assert!(!same("abc", "abd"));
        assert!(!same("abc", "abcd"));
    }

    #[test]
    fn tool_schemas() {
        for t in tools(false).into_iter().chain(tools(true)) {
            assert!(t["name"].is_string() && t["inputSchema"]["type"] == "object");
        }
    }
}
