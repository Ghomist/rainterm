//! Model APIs for the built-in agent. The frontend speaks one normalized, Anthropic-like
//! message format; this module translates it to either an **OpenAI-compatible** Chat
//! Completions request (OpenAI, DeepSeek, most local servers…) or an **Anthropic**
//! Messages request, streams the response (SSE) and reports normalized events.
//!
//! The API key never reaches the webview: it is read from the OS keychain here.

use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::Duration;

use anyhow::{anyhow, bail, Context};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::ipc::Channel;

pub const KEY_SECRET: &str = "agent:api-key";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Openai,
    Anthropic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    pub format: Format,
    /// e.g. https://api.deepseek.com, https://api.openai.com/v1, https://api.anthropic.com
    pub base_url: String,
    pub model: String,
    #[serde(default = "default_max_tokens")]
    pub max_tokens: u32,
    /// Anthropic `output_config.effort` / OpenAI `reasoning_effort`, when set.
    #[serde(default)]
    pub effort: Option<String>,
    /// http://, https:// or socks5h:// proxy URL for these requests.
    #[serde(default)]
    pub proxy: Option<String>,
}
fn default_max_tokens() -> u32 {
    8192
}

/// One content block of the normalized conversation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: Value,
    },
    ToolResult {
        tool_use_id: String,
        content: String,
        #[serde(default)]
        is_error: bool,
    },
    /// Model reasoning. `raw` = the provider's own block (Anthropic thinking blocks carry a
    /// signature and must be sent back verbatim); OpenAI-style reasoning has only `text`.
    Thinking {
        text: String,
        #[serde(default)]
        raw: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Message {
    pub role: String, // "user" | "assistant"
    pub content: Vec<Block>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolDef {
    pub name: String,
    pub description: String,
    pub input_schema: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatRequest {
    pub system: String,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub tools: Vec<ToolDef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum LlmEvent {
    TextDelta { text: String },
    ThinkingDelta { text: String },
    /// A finished content block (tool calls arrive only once complete).
    Block { block: Block },
    Done {
        #[serde(rename = "stopReason")]
        stop_reason: String,
        #[serde(rename = "inputTokens")]
        input_tokens: u64,
        #[serde(rename = "outputTokens")]
        output_tokens: u64,
    },
    Error { message: String },
}

// ------------------------------------------------------------------ running requests

fn tasks() -> &'static parking_lot::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>> {
    static T: OnceLock<parking_lot::Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>> = OnceLock::new();
    T.get_or_init(Default::default)
}

pub fn start(id: String, cfg: LlmConfig, req: ChatRequest, events: Channel<LlmEvent>) {
    let key = id.clone();
    let task = tauri::async_runtime::spawn(async move {
        let result = match cfg.format {
            Format::Openai => openai(&cfg, &req, &events).await,
            Format::Anthropic => anthropic(&cfg, &req, &events).await,
        };
        if let Err(e) = result {
            let _ = events.send(LlmEvent::Error { message: format!("{e:#}") });
        }
        tasks().lock().remove(&id);
    });
    if let Some(old) = tasks().lock().insert(key, task) {
        old.abort();
    }
}

pub fn cancel(id: &str) -> bool {
    tasks().lock().remove(id).map(|t| t.abort()).is_some()
}

fn api_key() -> anyhow::Result<String> {
    crate::store::secret_get(KEY_SECRET)
        .filter(|k| !k.trim().is_empty())
        .ok_or_else(|| anyhow!("No API key set — add one in Settings → Agent"))
}

fn client(cfg: &LlmConfig) -> anyhow::Result<reqwest::Client> {
    static TLS: OnceLock<()> = OnceLock::new();
    TLS.get_or_init(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
    let mut b = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .read_timeout(Duration::from_secs(180));
    if let Some(p) = cfg.proxy.as_deref().filter(|p| !p.is_empty()) {
        b = b.proxy(reqwest::Proxy::all(p).context("bad proxy URL")?);
    }
    Ok(b.build()?)
}

fn join_url(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), path.trim_start_matches('/'))
}

/// Read an SSE body and hand each `data:` payload (with its `event:` name) to `on`.
async fn sse(resp: reqwest::Response, mut on: impl FnMut(&str, &str) -> anyhow::Result<bool>) -> anyhow::Result<()> {
    let mut stream = resp.bytes_stream();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = stream.next().await {
        buf.extend_from_slice(&chunk?);
        // Events are separated by a blank line (\n\n or \r\n\r\n).
        loop {
            let Some((end, sep)) = find_event_end(&buf) else { break };
            let raw = String::from_utf8_lossy(&buf[..end]).into_owned();
            buf.drain(..end + sep);
            let mut event = "";
            let mut data = String::new();
            for line in raw.lines() {
                if let Some(v) = line.strip_prefix("event:") {
                    event = v.trim();
                } else if let Some(v) = line.strip_prefix("data:") {
                    if !data.is_empty() {
                        data.push('\n');
                    }
                    data.push_str(v.strip_prefix(' ').unwrap_or(v));
                }
            }
            if data.is_empty() {
                continue;
            }
            if !on(event, &data)? {
                return Ok(());
            }
        }
    }
    Ok(())
}

fn find_event_end(buf: &[u8]) -> Option<(usize, usize)> {
    let lf = buf.windows(2).position(|w| w == b"\n\n").map(|i| (i, 2));
    let crlf = buf.windows(4).position(|w| w == b"\r\n\r\n").map(|i| (i, 4));
    match (lf, crlf) {
        (Some(a), Some(b)) => Some(if a.0 < b.0 { a } else { b }),
        (a, b) => a.or(b),
    }
}

async fn check(resp: reqwest::Response) -> anyhow::Result<reqwest::Response> {
    if resp.status().is_success() {
        return Ok(resp);
    }
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    // Most APIs wrap the reason as {"error": {"message": …}}.
    let msg = serde_json::from_str::<Value>(&body)
        .ok()
        .and_then(|v| v.pointer("/error/message").and_then(|m| m.as_str()).map(str::to_string))
        .unwrap_or_else(|| body.chars().take(400).collect());
    bail!("{} {}: {}", status.as_u16(), status.canonical_reason().unwrap_or(""), msg)
}

// ------------------------------------------------------------------ OpenAI-compatible

fn openai_messages(req: &ChatRequest) -> Vec<Value> {
    let mut out = vec![json!({ "role": "system", "content": req.system })];
    for m in &req.messages {
        if m.role == "assistant" {
            let text: String = m
                .content
                .iter()
                .filter_map(|b| if let Block::Text { text } = b { Some(text.as_str()) } else { None })
                .collect::<Vec<_>>()
                .join("");
            let calls: Vec<Value> = m
                .content
                .iter()
                .filter_map(|b| match b {
                    Block::ToolUse { id, name, input } => Some(json!({
                        "id": id, "type": "function",
                        "function": { "name": name, "arguments": input.to_string() }
                    })),
                    _ => None,
                })
                .collect();
            let mut msg = json!({ "role": "assistant", "content": if text.is_empty() { Value::Null } else { Value::String(text) } });
            if !calls.is_empty() {
                msg["tool_calls"] = Value::Array(calls);
                // Reasoning models that think between tool calls (DeepSeek thinking mode)
                // expect their reasoning back within the same turn; others ignore it.
                let reasoning: String = m
                    .content
                    .iter()
                    .filter_map(|b| if let Block::Thinking { text, .. } = b { Some(text.as_str()) } else { None })
                    .collect();
                if !reasoning.is_empty() {
                    msg["reasoning_content"] = Value::String(reasoning);
                }
            }
            out.push(msg);
        } else {
            let mut text = String::new();
            for b in &m.content {
                match b {
                    Block::ToolResult { tool_use_id, content, is_error } => out.push(json!({
                        "role": "tool", "tool_call_id": tool_use_id,
                        "content": if *is_error { format!("ERROR: {content}") } else { content.clone() }
                    })),
                    Block::Text { text: t } => text.push_str(t),
                    _ => {}
                }
            }
            if !text.is_empty() {
                out.push(json!({ "role": "user", "content": text }));
            }
        }
    }
    out
}

async fn openai(cfg: &LlmConfig, req: &ChatRequest, events: &Channel<LlmEvent>) -> anyhow::Result<()> {
    let mut body = json!({
        "model": cfg.model,
        "messages": openai_messages(req),
        "stream": true,
        "stream_options": { "include_usage": true },
        "max_tokens": cfg.max_tokens,
    });
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "type": "function", "function": { "name": t.name, "description": t.description, "parameters": t.input_schema } }))
                .collect(),
        );
    }
    if let Some(e) = cfg.effort.as_deref().filter(|e| !e.is_empty()) {
        body["reasoning_effort"] = Value::String(e.into());
    }
    let resp = client(cfg)?
        .post(join_url(&cfg.base_url, "chat/completions"))
        .bearer_auth(api_key()?)
        .json(&body)
        .send()
        .await
        .context("request failed")?;
    let resp = check(resp).await?;

    struct Call {
        id: String,
        name: String,
        args: String,
    }
    let mut calls: Vec<Call> = Vec::new();
    let (mut text, mut reasoning) = (String::new(), String::new());
    let (mut stop, mut input_tokens, mut output_tokens) = (String::from("end_turn"), 0u64, 0u64);

    sse(resp, |_, data| {
        if data.trim() == "[DONE]" {
            return Ok(false);
        }
        let v: Value = serde_json::from_str(data).context("bad stream chunk")?;
        if let Some(u) = v.get("usage").filter(|u| !u.is_null()) {
            input_tokens = u["prompt_tokens"].as_u64().unwrap_or(input_tokens);
            output_tokens = u["completion_tokens"].as_u64().unwrap_or(output_tokens);
        }
        let Some(choice) = v["choices"].get(0) else { return Ok(true) };
        let d = &choice["delta"];
        if let Some(r) = d["reasoning_content"].as_str().or_else(|| d["reasoning"].as_str()) {
            if !r.is_empty() {
                reasoning.push_str(r);
                let _ = events.send(LlmEvent::ThinkingDelta { text: r.into() });
            }
        }
        if let Some(t) = d["content"].as_str() {
            if !t.is_empty() {
                text.push_str(t);
                let _ = events.send(LlmEvent::TextDelta { text: t.into() });
            }
        }
        if let Some(tc) = d["tool_calls"].as_array() {
            for c in tc {
                let i = c["index"].as_u64().unwrap_or(calls.len() as u64) as usize;
                while calls.len() <= i {
                    calls.push(Call { id: String::new(), name: String::new(), args: String::new() });
                }
                if let Some(id) = c["id"].as_str() {
                    calls[i].id = id.into();
                }
                if let Some(n) = c["function"]["name"].as_str() {
                    calls[i].name.push_str(n);
                }
                if let Some(a) = c["function"]["arguments"].as_str() {
                    calls[i].args.push_str(a);
                }
            }
        }
        if let Some(f) = choice["finish_reason"].as_str() {
            stop = match f {
                "tool_calls" => "tool_use",
                "length" => "max_tokens",
                "stop" => "end_turn",
                other => other,
            }
            .into();
        }
        Ok(true)
    })
    .await?;

    if !reasoning.is_empty() {
        let _ = events.send(LlmEvent::Block { block: Block::Thinking { text: reasoning, raw: None } });
    }
    if !text.is_empty() {
        let _ = events.send(LlmEvent::Block { block: Block::Text { text } });
    }
    for (i, c) in calls.into_iter().enumerate() {
        let input = if c.args.trim().is_empty() {
            json!({})
        } else {
            serde_json::from_str(&c.args).unwrap_or_else(|_| json!({ "__invalid_json": c.args }))
        };
        let id = if c.id.is_empty() { format!("call_{i}") } else { c.id };
        let _ = events.send(LlmEvent::Block { block: Block::ToolUse { id, name: c.name, input } });
        stop = "tool_use".into();
    }
    let _ = events.send(LlmEvent::Done { stop_reason: stop, input_tokens, output_tokens });
    Ok(())
}

// ------------------------------------------------------------------ Anthropic

fn anthropic_messages(req: &ChatRequest) -> Vec<Value> {
    req.messages
        .iter()
        .map(|m| {
            let content: Vec<Value> = m
                .content
                .iter()
                .filter_map(|b| match b {
                    Block::Text { text } if !text.is_empty() => Some(json!({ "type": "text", "text": text })),
                    Block::Text { .. } => None,
                    Block::ToolUse { id, name, input } => Some(json!({ "type": "tool_use", "id": id, "name": name, "input": input })),
                    Block::ToolResult { tool_use_id, content, is_error } => Some(json!({
                        "type": "tool_result", "tool_use_id": tool_use_id, "content": content, "is_error": is_error
                    })),
                    // Thinking blocks go back exactly as received (signature included).
                    Block::Thinking { raw: Some(raw), .. } => Some(raw.clone()),
                    Block::Thinking { .. } => None,
                })
                .collect();
            json!({ "role": m.role, "content": content })
        })
        .collect()
}

async fn anthropic(cfg: &LlmConfig, req: &ChatRequest, events: &Channel<LlmEvent>) -> anyhow::Result<()> {
    let official = cfg.base_url.contains("anthropic.com");
    let mut body = json!({
        "model": cfg.model,
        "max_tokens": cfg.max_tokens,
        "system": req.system,
        "messages": anthropic_messages(req),
        "stream": true,
    });
    if !req.tools.is_empty() {
        body["tools"] = Value::Array(
            req.tools
                .iter()
                .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.input_schema }))
                .collect(),
        );
    }
    if official {
        // Cache the stable prefix (tools + system + earlier turns) across the agent loop.
        body["cache_control"] = json!({ "type": "ephemeral" });
    }
    if let Some(e) = cfg.effort.as_deref().filter(|e| !e.is_empty()) {
        body["output_config"] = json!({ "effort": e });
    }
    let base = cfg.base_url.trim_end_matches('/');
    let url = if base.ends_with("/v1") { join_url(base, "messages") } else { join_url(base, "v1/messages") };
    let key = api_key()?;
    let mut rb = client(cfg)?.post(url).header("x-api-key", &key);
    if !official {
        // Some Anthropic-compatible gateways authenticate with a bearer token instead.
        rb = rb.bearer_auth(&key);
    }
    let resp = rb
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .context("request failed")?;
    let resp = check(resp).await?;

    // Blocks under construction, by index.
    let mut open: HashMap<u64, Value> = HashMap::new();
    let mut json_buf: HashMap<u64, String> = HashMap::new();
    let (mut stop, mut input_tokens, mut output_tokens) = (String::from("end_turn"), 0u64, 0u64);
    let mut failure: Option<String> = None;

    sse(resp, |event, data| {
        let v: Value = serde_json::from_str(data).context("bad stream event")?;
        let kind = v["type"].as_str().unwrap_or(event);
        match kind {
            "message_start" => {
                let u = &v["message"]["usage"];
                input_tokens = u["input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_read_input_tokens"].as_u64().unwrap_or(0)
                    + u["cache_creation_input_tokens"].as_u64().unwrap_or(0);
            }
            "content_block_start" => {
                let i = v["index"].as_u64().unwrap_or(0);
                open.insert(i, v["content_block"].clone());
            }
            "content_block_delta" => {
                let i = v["index"].as_u64().unwrap_or(0);
                let d = &v["delta"];
                let Some(b) = open.get_mut(&i) else { return Ok(true) };
                match d["type"].as_str().unwrap_or("") {
                    "text_delta" => {
                        let t = d["text"].as_str().unwrap_or("");
                        let cur = b["text"].as_str().unwrap_or("").to_string();
                        b["text"] = Value::String(cur + t);
                        let _ = events.send(LlmEvent::TextDelta { text: t.into() });
                    }
                    "thinking_delta" => {
                        let t = d["thinking"].as_str().unwrap_or("");
                        let cur = b["thinking"].as_str().unwrap_or("").to_string();
                        b["thinking"] = Value::String(cur + t);
                        let _ = events.send(LlmEvent::ThinkingDelta { text: t.into() });
                    }
                    "signature_delta" => {
                        let t = d["signature"].as_str().unwrap_or("");
                        let cur = b["signature"].as_str().unwrap_or("").to_string();
                        b["signature"] = Value::String(cur + t);
                    }
                    "input_json_delta" => json_buf.entry(i).or_default().push_str(d["partial_json"].as_str().unwrap_or("")),
                    _ => {}
                }
            }
            "content_block_stop" => {
                let i = v["index"].as_u64().unwrap_or(0);
                if let Some(mut b) = open.remove(&i) {
                    let block = match b["type"].as_str().unwrap_or("") {
                        "text" => Some(Block::Text { text: b["text"].as_str().unwrap_or("").into() }),
                        "tool_use" => {
                            let raw = json_buf.remove(&i).unwrap_or_default();
                            let input = if raw.trim().is_empty() {
                                json!({})
                            } else {
                                serde_json::from_str(&raw).unwrap_or_else(|_| json!({ "__invalid_json": raw }))
                            };
                            b["input"] = input.clone();
                            Some(Block::ToolUse {
                                id: b["id"].as_str().unwrap_or("").into(),
                                name: b["name"].as_str().unwrap_or("").into(),
                                input,
                            })
                        }
                        "thinking" | "redacted_thinking" => Some(Block::Thinking {
                            text: b["thinking"].as_str().unwrap_or("").into(),
                            raw: Some(b),
                        }),
                        _ => None,
                    };
                    if let Some(block) = block {
                        let _ = events.send(LlmEvent::Block { block });
                    }
                }
            }
            "message_delta" => {
                if let Some(s) = v["delta"]["stop_reason"].as_str() {
                    stop = s.into();
                }
                output_tokens = v["usage"]["output_tokens"].as_u64().unwrap_or(output_tokens);
            }
            "message_stop" => return Ok(false),
            "error" => {
                failure = Some(v["error"]["message"].as_str().unwrap_or("stream error").into());
                return Ok(false);
            }
            _ => {}
        }
        Ok(true)
    })
    .await?;

    if let Some(f) = failure {
        bail!(f);
    }
    let _ = events.send(LlmEvent::Done { stop_reason: stop, input_tokens, output_tokens });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv() -> ChatRequest {
        ChatRequest {
            system: "sys".into(),
            tools: vec![],
            messages: vec![
                Message { role: "user".into(), content: vec![Block::Text { text: "hi".into() }] },
                Message {
                    role: "assistant".into(),
                    content: vec![
                        Block::Thinking { text: "hmm".into(), raw: Some(json!({"type":"thinking","thinking":"hmm","signature":"sig"})) },
                        Block::Text { text: "running".into() },
                        Block::ToolUse { id: "t1".into(), name: "run_command".into(), input: json!({"command":"ls"}) },
                    ],
                },
                Message {
                    role: "user".into(),
                    content: vec![Block::ToolResult { tool_use_id: "t1".into(), content: "a b".into(), is_error: false }],
                },
            ],
        }
    }

    #[test]
    fn to_openai() {
        let m = openai_messages(&conv());
        assert_eq!(m[0]["role"], "system");
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], "{\"command\":\"ls\"}");
        assert_eq!(m[2]["reasoning_content"], "hmm");
        assert_eq!(m[3]["role"], "tool");
        assert_eq!(m[3]["tool_call_id"], "t1");
    }

    #[test]
    fn to_anthropic() {
        let m = anthropic_messages(&conv());
        assert_eq!(m[1]["content"][0]["signature"], "sig");
        assert_eq!(m[1]["content"][2]["type"], "tool_use");
        assert_eq!(m[2]["content"][0]["type"], "tool_result");
    }

    #[test]
    fn sse_split() {
        assert_eq!(find_event_end(b"data: x\n\ndata: y"), Some((7, 2)));
        assert_eq!(find_event_end(b"data: x\r\n\r\n"), Some((7, 4)));
        assert_eq!(find_event_end(b"data: x\n"), None);
    }
}
