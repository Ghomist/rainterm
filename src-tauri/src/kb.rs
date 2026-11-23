//! The knowledge base: plain Markdown / text files in `<rainterm home>/knowledge`
//! (sub-folders allowed, so people can drop notes in by hand), searched with BM25 over
//! heading-sized chunks. Latin text is matched by word, CJK text by character pairs, so
//! both "nginx reload" and "重启服务" find their notes without an embedding model.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context};
use serde::Serialize;

const EXTS: [&str; 3] = ["md", "markdown", "txt"];
const MAX_FILE: u64 = 2 * 1024 * 1024;
const MAX_FILES: usize = 5000;
const CHUNK: usize = 1000;

pub fn dir() -> anyhow::Result<PathBuf> {
    let d = crate::store::config_dir()?.join("knowledge");
    std::fs::create_dir_all(&d)?;
    Ok(d)
}

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    /// Path relative to the knowledge folder, with `/`.
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    /// "user", or "agent" for notes agents wrote themselves.
    pub source: String,
    /// Modified time, ms since the epoch.
    pub updated: u64,
    pub size: u64,
    pub excerpt: String,
}

#[derive(Serialize, Debug)]
pub struct Doc {
    #[serde(flatten)]
    pub entry: Entry,
    pub body: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct Hit {
    pub id: String,
    pub title: String,
    /// The heading of the matching section ("" at the top of the note).
    pub section: String,
    pub snippet: String,
    pub score: f32,
}

// ------------------------------------------------------------------ files

fn files(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for e in rd.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                stack.push(p);
            } else if ft.is_file() && p.extension().and_then(|x| x.to_str()).is_some_and(|x| EXTS.contains(&x.to_ascii_lowercase().as_str())) {
                out.push(p);
                if out.len() >= MAX_FILES {
                    return out;
                }
            }
        }
    }
    out
}

fn rel_id(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

/// The file for an id, refusing anything that would leave the knowledge folder.
fn resolve(root: &Path, id: &str) -> anyhow::Result<PathBuf> {
    let id = id.trim().trim_start_matches(['/', '\\']);
    if id.is_empty() || id.split(['/', '\\']).any(|s| s == ".." || s.is_empty()) || id.contains(':') {
        bail!("bad knowledge id: {id}");
    }
    Ok(root.join(id))
}

fn mtime(m: &std::fs::Metadata) -> u64 {
    m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `---\ntitle: x\ntags: [a, b]\n---\n` front matter, then the body.
#[cfg(test)]
fn parse(text: &str) -> (Option<String>, Vec<String>, &str) {
    let (t, tags, body, _) = parse_full(text);
    (t, tags, body)
}

/// Front matter fields plus the source ("user" unless it says `source: agent`).
fn parse_full(text: &str) -> (Option<String>, Vec<String>, &str, String) {
    let t = text.strip_prefix('\u{feff}').unwrap_or(text);
    let user = || "user".to_string();
    let Some(rest) = t.strip_prefix("---\n").or_else(|| t.strip_prefix("---\r\n")) else { return (None, vec![], t, user()) };
    let Some(end) = rest.find("\n---") else { return (None, vec![], t, user()) };
    let head = &rest[..end];
    let body = rest[end + 4..].trim_start_matches(['\r', '\n']);
    let mut title = None;
    let mut tags = vec![];
    let mut source = user();
    for line in head.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.trim();
        match k.trim().to_ascii_lowercase().as_str() {
            "title" => title = Some(v.trim_matches(['"', '\'']).to_string()).filter(|s| !s.is_empty()),
            "tags" => {
                tags = v
                    .trim_matches(['[', ']'])
                    .split([',', '，'])
                    .map(|s| s.trim().trim_matches(['"', '\'']).to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            }
            "source" => source = v.trim_matches(['"', '\'']).to_string(),
            _ => {}
        }
    }
    (title, tags, body, source)
}

fn first_heading(body: &str) -> Option<String> {
    body.lines().find_map(|l| l.strip_prefix("# ").map(|h| h.trim().to_string())).filter(|s| !s.is_empty())
}

fn excerpt(body: &str, n: usize) -> String {
    let flat: String = body
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty() && !l.starts_with('#') && !l.starts_with("```") && !l.starts_with("---"))
        .map(|l| l.trim_start_matches(['-', '*', '>', '+']).trim_start())
        .collect::<Vec<_>>()
        .join(" ")
        .replace(['`', '*'], "");
    cut(&flat, n)
}

fn cut(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        return s.to_string();
    }
    let mut out: String = s.chars().take(n).collect();
    out.push('…');
    out
}

fn load(root: &Path, p: &Path) -> Option<Doc> {
    let m = std::fs::metadata(p).ok()?;
    if m.len() > MAX_FILE {
        return None;
    }
    let raw = std::fs::read(p).ok()?;
    let text = String::from_utf8_lossy(&raw);
    let (title, tags, body, source) = parse_full(&text);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let title = title.or_else(|| first_heading(body)).unwrap_or(stem);
    Some(Doc {
        entry: Entry { id: rel_id(root, p), title, tags, source, updated: mtime(&m), size: m.len(), excerpt: excerpt(body, 140) },
        body: body.to_string(),
    })
}

pub fn list() -> anyhow::Result<Vec<Entry>> {
    let root = dir()?;
    let mut out: Vec<Entry> = files(&root).iter().filter_map(|p| load(&root, p)).map(|d| d.entry).collect();
    out.sort_by(|a, b| b.updated.cmp(&a.updated));
    Ok(out)
}

pub fn read(id: &str) -> anyhow::Result<Doc> {
    let root = dir()?;
    let p = resolve(&root, id)?;
    load(&root, &p).with_context(|| format!("no knowledge note “{id}”"))
}

fn slug(title: &str) -> String {
    let s: String = title
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '-' })
        .collect();
    let s = s.split('-').filter(|x| !x.is_empty()).collect::<Vec<_>>().join("-");
    let s: String = s.trim_matches('.').chars().take(60).collect();
    if s.is_empty() { "note".into() } else { s }
}

/// Save a note; a new one (no id) gets a file named after its title. Returns its id.
pub fn save(id: Option<&str>, title: &str, tags: &[String], body: &str, source: &str) -> anyhow::Result<String> {
    let root = dir()?;
    // An agent saving a note under an existing title updates that note instead of adding a twin.
    let same = if source == "agent" && id.is_none_or(|s| s.trim().is_empty()) {
        let t = title.trim().to_lowercase();
        files(&root).into_iter().find(|p| !t.is_empty() && load(&root, p).is_some_and(|d| d.entry.title.trim().to_lowercase() == t))
    } else {
        None
    };
    let p = match id.filter(|s| !s.trim().is_empty()) {
        Some(id) => resolve(&root, id)?,
        None if same.is_some() => same.unwrap(),
        None => {
            let base = slug(title);
            let mut p = root.join(format!("{base}.md"));
            let mut n = 2;
            while p.exists() {
                p = root.join(format!("{base}-{n}.md"));
                n += 1;
            }
            p
        }
    };
    let clean: Vec<String> = tags.iter().map(|t| t.trim().replace([',', '[', ']', '\n'], " ")).filter(|t| !t.is_empty()).collect();
    let mut text = String::new();
    let title = title.trim().replace('\n', " ");
    // An agent updating the user's own note leaves it the user's.
    let agent = source == "agent" && !load(&root, &p).is_some_and(|d| d.entry.source != "agent");
    if !title.is_empty() || !clean.is_empty() || agent {
        text.push_str("---\n");
        if !title.is_empty() {
            text.push_str(&format!("title: {title}\n"));
        }
        if !clean.is_empty() {
            text.push_str(&format!("tags: [{}]\n", clean.join(", ")));
        }
        if agent {
            text.push_str("source: agent\n");
        }
        text.push_str("---\n\n");
    }
    text.push_str(body.trim_end());
    text.push('\n');
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(&p, text)?;
    Ok(rel_id(&root, &p))
}

/// To the recycle bin rather than gone for good.
pub fn delete(id: &str) -> anyhow::Result<()> {
    let p = resolve(&dir()?, id)?;
    if p.exists() {
        trash::delete(&p).or_else(|_| std::fs::remove_file(&p)).context("couldn't delete the note")?;
    }
    Ok(())
}

/// Copy files (or folders of them) in; returns how many notes were added.
pub fn import(paths: &[String]) -> anyhow::Result<usize> {
    let root = dir()?;
    let mut n = 0;
    for src in paths {
        let src = PathBuf::from(src);
        let (base, list) = if src.is_dir() {
            (src.parent().map(Path::to_path_buf).unwrap_or_default(), files(&src))
        } else {
            (src.parent().map(Path::to_path_buf).unwrap_or_default(), vec![src.clone()])
        };
        for f in list {
            if std::fs::metadata(&f).map(|m| m.len() > MAX_FILE).unwrap_or(true) {
                continue;
            }
            let rel = f.strip_prefix(&base).unwrap_or(&f).to_path_buf();
            let mut to = root.join(&rel);
            let stem = to.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
            let ext = to.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "md".into());
            let mut k = 2;
            while to.exists() {
                to.set_file_name(format!("{stem}-{k}.{ext}"));
                k += 1;
            }
            if let Some(d) = to.parent() {
                std::fs::create_dir_all(d)?;
            }
            std::fs::copy(&f, &to)?;
            n += 1;
        }
    }
    Ok(n)
}

// ------------------------------------------------------------------ search

fn is_cjk(c: char) -> bool {
    matches!(c as u32, 0x3040..=0x30ff | 0x3400..=0x4dbf | 0x4e00..=0x9fff | 0xac00..=0xd7af | 0xf900..=0xfaff)
}

/// Words for Latin text, overlapping character pairs for CJK runs.
pub fn tokens(text: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut word = String::new();
    let mut run: Vec<char> = Vec::new();
    let flush_run = |run: &mut Vec<char>, out: &mut Vec<String>| {
        if run.len() == 1 {
            out.push(run[0].to_string());
        }
        for w in run.windows(2) {
            out.push(w.iter().collect());
        }
        run.clear();
    };
    for c in text.chars() {
        if is_cjk(c) {
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
            run.push(c);
        } else if c.is_alphanumeric() || c == '_' {
            flush_run(&mut run, &mut out);
            word.extend(c.to_lowercase());
        } else {
            flush_run(&mut run, &mut out);
            if !word.is_empty() {
                out.push(std::mem::take(&mut word));
            }
        }
    }
    flush_run(&mut run, &mut out);
    if !word.is_empty() {
        out.push(word);
    }
    out.retain(|t| t.chars().count() > 1 || t.chars().all(is_cjk) || t.chars().all(|c| c.is_ascii_digit()));
    out
}

struct Chunk {
    doc: usize,
    section: String,
    text: String,
    tf: HashMap<String, f32>,
    len: f32,
}

/// Split a note at its headings, then long sections at blank lines.
fn chunks(body: &str) -> Vec<(String, String)> {
    let mut sections: Vec<(String, String)> = vec![(String::new(), String::new())];
    let mut fence = false;
    for line in body.lines() {
        if line.trim_start().starts_with("```") {
            fence = !fence;
        }
        if !fence && line.starts_with('#') && line.trim_start_matches('#').starts_with(' ') {
            sections.push((line.trim_start_matches('#').trim().to_string(), String::new()));
        }
        let s = &mut sections.last_mut().unwrap().1;
        s.push_str(line);
        s.push('\n');
    }
    let mut out = Vec::new();
    for (h, text) in sections {
        if text.trim().is_empty() {
            continue;
        }
        let mut cur = String::new();
        for para in text.split("\n\n") {
            if !cur.is_empty() && cur.chars().count() + para.chars().count() > CHUNK {
                out.push((h.clone(), std::mem::take(&mut cur)));
            }
            cur.push_str(para);
            cur.push_str("\n\n");
        }
        if !cur.trim().is_empty() {
            out.push((h.clone(), cur));
        }
    }
    out
}

pub fn search_in(docs: &[Doc], query: &str, limit: usize) -> Vec<Hit> {
    let q: Vec<String> = {
        let mut t = tokens(query);
        t.sort();
        t.dedup();
        t
    };
    if q.is_empty() {
        return vec![];
    }
    let mut all: Vec<Chunk> = Vec::new();
    for (i, d) in docs.iter().enumerate() {
        // The title and tags count toward every section of the note.
        let head = format!("{} {}", d.entry.title, d.entry.tags.join(" "));
        let head_t = tokens(&head);
        for (section, text) in chunks(&d.body) {
            let mut tf: HashMap<String, f32> = HashMap::new();
            for t in tokens(&text) {
                *tf.entry(t).or_default() += 1.0;
            }
            for t in tokens(&section).into_iter().chain(head_t.iter().cloned()) {
                *tf.entry(t).or_default() += 2.0;
            }
            let len = tf.values().sum::<f32>().max(1.0);
            all.push(Chunk { doc: i, section, text, tf, len });
        }
        if d.body.trim().is_empty() {
            let mut tf: HashMap<String, f32> = HashMap::new();
            for t in &head_t {
                *tf.entry(t.clone()).or_default() += 2.0;
            }
            all.push(Chunk { doc: i, section: String::new(), text: String::new(), len: tf.values().sum::<f32>().max(1.0), tf });
        }
    }
    if all.is_empty() {
        return vec![];
    }
    let n = all.len() as f32;
    let avg = all.iter().map(|c| c.len).sum::<f32>() / n;
    let idf: HashMap<&str, f32> = q
        .iter()
        .map(|t| {
            let df = all.iter().filter(|c| c.tf.contains_key(t)).count() as f32;
            (t.as_str(), ((n - df + 0.5) / (df + 0.5) + 1.0).ln())
        })
        .collect();
    let (k1, b) = (1.2f32, 0.75f32);
    let mut scored: Vec<(f32, usize)> = all
        .iter()
        .enumerate()
        .filter_map(|(i, c)| {
            let mut s = 0.0;
            let mut matched = 0;
            for t in &q {
                let Some(&f) = c.tf.get(t) else { continue };
                matched += 1;
                s += idf[t.as_str()] * f * (k1 + 1.0) / (f + k1 * (1.0 - b + b * c.len / avg));
            }
            // Covering more of the query beats repeating one word.
            (matched > 0).then(|| (s * (0.5 + matched as f32 / q.len() as f32), i))
        })
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    let mut per_doc: HashMap<usize, usize> = HashMap::new();
    let mut out = Vec::new();
    for (s, i) in scored {
        let c = &all[i];
        let k = per_doc.entry(c.doc).or_default();
        if *k >= 2 {
            continue;
        }
        *k += 1;
        let d = &docs[c.doc];
        out.push(Hit { id: d.entry.id.clone(), title: d.entry.title.clone(), section: c.section.clone(), snippet: cut(c.text.trim(), 900), score: s });
        if out.len() >= limit {
            break;
        }
    }
    out
}

pub fn search(query: &str, limit: usize) -> anyhow::Result<Vec<Hit>> {
    let root = dir()?;
    let docs: Vec<Doc> = files(&root).iter().filter_map(|p| load(&root, p)).collect();
    Ok(search_in(&docs, query, limit.clamp(1, 20)))
}

/// Search results as text for a model.
pub fn search_text(query: &str, limit: usize) -> anyhow::Result<String> {
    let hits = search(query, limit)?;
    if hits.is_empty() {
        return Ok(format!("Nothing in the knowledge base matches “{query}”. Try other words (synonyms, the product or command name)."));
    }
    let mut s = String::new();
    for h in hits {
        let sec = if h.section.is_empty() || h.section == h.title { String::new() } else { format!(" › {}", h.section) };
        s.push_str(&format!("### {}{}\nid: {}\n\n{}\n\n", h.title, sec, h.id, cut(&h.snippet, 600)));
    }
    s.push_str("(read_knowledge with an id, and optionally a section heading, returns more.)");
    Ok(s)
}

/// A note for a model: one section when asked, and never more than ~8k characters.
pub fn read_text(id: &str, section: Option<&str>) -> anyhow::Result<String> {
    let d = read(id)?;
    let tags = if d.entry.tags.is_empty() { String::new() } else { format!("\ntags: {}", d.entry.tags.join(", ")) };
    let heads = || {
        let mut h: Vec<String> = Vec::new();
        for (x, _) in chunks(&d.body) {
            if !x.is_empty() && !h.contains(&x) {
                h.push(x);
            }
        }
        h.join(" / ")
    };
    let body = match section.map(str::trim).filter(|s| !s.is_empty()) {
        Some(sec) => {
            let want = sec.trim_start_matches('#').trim().to_lowercase();
            let parts: Vec<String> = chunks(&d.body).into_iter().filter(|(h, _)| h.to_lowercase() == want).map(|(_, t)| t).collect();
            if parts.is_empty() {
                bail!("No section “{sec}” in this note. Sections: {}", heads())
            }
            parts.join("")
        }
        None => d.body.clone(),
    };
    let n = body.chars().count();
    let text = if n > 8000 {
        format!("{}\n\n… (cut: {n} characters in all; read one section at a time. Sections: {})", cut(&body, 8000), heads())
    } else {
        body
    };
    Ok(format!("# {}{}\n\n{}", d.entry.title, tags, text))
}

// ------------------------------------------------------------------ tools for models

pub const TOOLS: [&str; 3] = ["search_knowledge", "read_knowledge", "save_knowledge"];

/// The knowledge tools' schemas (MCP; the webview has the same definitions in lib/kb.ts).
pub fn tool_defs() -> Vec<serde_json::Value> {
    use serde_json::json;
    vec![
        json!({
            "name": "search_knowledge",
            "description": "Search the knowledge base shared by every agent and the user: notes about the user's servers, projects, procedures, conventions and past fixes. Returns the best-matching sections with note ids. Use it before guessing at anything specific to the user's environment.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Keywords or a short question, in the language the notes are likely written in." },
                "limit": { "type": "number", "description": "Default 4, max 10." }
            }, "required": ["query"] }
        }),
        json!({
            "name": "read_knowledge",
            "description": "Read a note from the knowledge base by id (from search_knowledge); pass a section heading to read only that part. Long notes are cut at ~8k characters.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" },
                "section": { "type": "string", "description": "A heading in the note (optional)." }
            }, "required": ["id"] }
        }),
        json!({
            "name": "save_knowledge",
            "description": "Remember something for future tasks, in the knowledge base every agent shares. Save durable facts only: how the user's machines and projects are set up (hosts, paths, versions, services), procedures that worked, fixes for problems you solved, preferences the user stated. Not progress reports, temporary output or secrets (never passwords, tokens or keys). Search first: to change an existing note pass its id and the complete new content; a new note with an existing title replaces that note.",
            "inputSchema": { "type": "object", "properties": {
                "title": { "type": "string", "description": "Short and specific, e.g. “web01 nginx setup”." },
                "content": { "type": "string", "description": "Markdown: the facts, concise, with the names, paths and commands that make it findable." },
                "tags": { "type": "array", "items": { "type": "string" } },
                "id": { "type": "string", "description": "An existing note to replace (optional)." }
            }, "required": ["title", "content"] }
        }),
    ]
}

/// Run a knowledge tool for a model.
pub fn tool(name: &str, args: &serde_json::Value) -> anyhow::Result<String> {
    let s = |k: &str| args[k].as_str().unwrap_or("").trim().to_string();
    match name {
        "search_knowledge" => {
            let q = s("query");
            anyhow::ensure!(!q.is_empty(), "Empty query.");
            search_text(&q, (args["limit"].as_u64().unwrap_or(4) as usize).min(10))
        }
        "read_knowledge" => read_text(&s("id"), args["section"].as_str()),
        "save_knowledge" => {
            let (title, content) = (s("title"), s("content"));
            anyhow::ensure!(!title.is_empty() && !content.is_empty(), "A note needs a title and content.");
            static SECRET: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let secret = SECRET.get_or_init(|| {
                regex::Regex::new(r"(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk|ghp|gho|xox[bp])-?[A-Za-z0-9_]{20,}|password\s*[:=]\s*\S{4,}").unwrap()
            });
            anyhow::ensure!(!secret.is_match(&content), "That looks like it contains a secret (a key, token or password). Leave secrets out of the knowledge base; say where they are kept instead.");
            anyhow::ensure!(content.chars().count() <= 12_000, "Too long: keep a note under ~12k characters (split it, or keep only the durable facts).");
            let tags: Vec<String> = args["tags"].as_array().map(|a| a.iter().filter_map(|t| t.as_str().map(String::from)).collect()).unwrap_or_default();
            let id = s("id");
            let id = save(Some(id.as_str()).filter(|x| !x.is_empty()), &title, &tags, &content, "agent")?;
            Ok(format!("Saved as {id}."))
        }
        _ => bail!("unknown tool {name}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(id: &str, title: &str, body: &str) -> Doc {
        Doc { entry: Entry { id: id.into(), title: title.into(), tags: vec![], source: "user".into(), updated: 0, size: 0, excerpt: String::new() }, body: body.into() }
    }

    #[test]
    fn tokenizes_mixed_text() {
        assert_eq!(tokens("重启 nginx 服务"), vec!["重启", "nginx", "服务"]);
        assert_eq!(tokens("数据库备份"), vec!["数据", "据库", "库备", "备份"]);
        assert_eq!(tokens("Hello, World_2"), vec!["hello", "world_2"]);
    }

    #[test]
    fn front_matter() {
        let (_, _, _, src) = parse_full("---\ntitle: x\nsource: agent\n---\n\nbody");
        assert_eq!(src, "agent");
        let (t, tags, body) = parse("---\ntitle: Deploy\ntags: [ops, prod]\n---\n\nbody");
        assert_eq!(t.as_deref(), Some("Deploy"));
        assert_eq!(tags, vec!["ops", "prod"]);
        assert_eq!(body, "body");
        let (t, _, body) = parse("# Plain\ntext");
        assert!(t.is_none());
        assert_eq!(first_heading(body).as_deref(), Some("Plain"));
    }

    #[test]
    fn finds_the_right_section() {
        let docs = vec![
            doc("a.md", "服务器清单", "# 服务器清单\n\n## 生产环境\nweb01 跑 nginx，重启用 systemctl reload nginx\n\n## 测试环境\ntest01 只有 docker"),
            doc("b.md", "Backups", "Database backups run nightly with pg_dump to /srv/backup."),
            doc("c.md", "Unrelated", "Coffee machine is on the third floor."),
        ];
        let h = search_in(&docs, "怎么重启 nginx", 5);
        assert_eq!(h[0].id, "a.md");
        assert_eq!(h[0].section, "生产环境");
        let h = search_in(&docs, "postgres backup pg_dump", 5);
        assert_eq!(h[0].id, "b.md");
        assert!(search_in(&docs, "kubernetes", 5).is_empty());
    }

    #[test]
    fn ids_stay_inside() {
        let root = Path::new("/kb");
        assert!(resolve(root, "../x.md").is_err());
        assert!(resolve(root, "a/../../x.md").is_err());
        assert!(resolve(root, "C:/x.md").is_err());
        assert!(resolve(root, "ops/deploy.md").is_ok());
        assert_eq!(slug("部署 / 发布: v2"), "部署-发布-v2");
    }
}
