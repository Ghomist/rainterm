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
        if path != "/mcp" {
            respond(&mut sock, "404 Not Found", "text/plain", b"rainterm MCP endpoint is /mcp", &[]).await?;
            continue;
        }
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
                    if let Some(r) = handle(&app, m).await {
                        out.push(r);
                    }
                }
                out
            }
            m => handle(&app, m).await.into_iter().collect(),
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

async fn handle(app: &AppHandle, m: Value) -> Option<Value> {
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
                "instructions": "Terminals of the rainterm app the user is looking at. Commands you run appear in a real, visible terminal tab and may need the user's approval. Use list_terminals first; prefer non-interactive, bounded commands."
            }))
        }
        "ping" => ok(json!({})),
        "tools/list" => ok(json!({ "tools": tools() })),
        "tools/call" => {
            let name = m.pointer("/params/name").and_then(|v| v.as_str()).unwrap_or("").to_string();
            if !tools().iter().any(|t| t["name"] == name) {
                return err(-32602, format!("unknown tool: {name}"));
            }
            let args = m.pointer("/params/arguments").cloned().unwrap_or(json!({}));
            match call(app, name, args).await {
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

fn tools() -> Vec<Value> {
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
            "description": "Open a new terminal tab: a saved session (by id or name from list_hosts) or a local shell. Returns its terminal id once connected. The user may have to approve it.",
            "inputSchema": { "type": "object", "properties": {
                "session": { "type": "string", "description": "Saved session id or name." },
                "shell": { "type": "string", "description": "Local shell id or name (when no session is given)." }
            }, "additionalProperties": false }
        }),
    ]
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
        for t in tools() {
            assert!(t["name"].is_string() && t["inputSchema"]["type"] == "object");
        }
    }
}
