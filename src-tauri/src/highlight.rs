//! Smart keyword highlighting, done as a stream filter in Rust.
//!
//! A tiny VT state machine walks the output bytes. Plain text that is printed with
//! *default* attributes on the *normal* screen is matched against the rule set and
//! matches are wrapped in SGR sequences. Text the program already colored, anything
//! inside escape sequences, and full-screen apps (alternate screen: vim, htop, less…)
//! pass through untouched, so we never fight the application's own styling.
//!
//! The same walker also produces an ANSI-stripped copy for session logging.

use std::sync::Arc;
use std::sync::LazyLock;

use parking_lot::RwLock;
use regex::Regex;
use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSpec {
    pub pattern: String,
    /// SGR parameters, e.g. "1;31" or "38;5;208".
    pub sgr: String,
    #[serde(default = "yes")]
    pub enabled: bool,
}

fn yes() -> bool {
    true
}

struct Rule {
    re: Regex,
    open: Vec<u8>,
}

static RULES: LazyLock<RwLock<Arc<Vec<Rule>>>> =
    LazyLock::new(|| RwLock::new(Arc::new(compile(&default_rules()).0)));

/// Replace the global rule set. Returns errors for patterns that failed to compile.
pub fn set_rules(specs: &[RuleSpec]) -> Vec<String> {
    let (rules, errors) = compile(specs);
    *RULES.write() = Arc::new(rules);
    errors
}

fn compile(specs: &[RuleSpec]) -> (Vec<Rule>, Vec<String>) {
    let mut rules = Vec::new();
    let mut errors = Vec::new();
    for s in specs.iter().filter(|s| s.enabled && !s.pattern.is_empty()) {
        match Regex::new(&s.pattern) {
            Ok(re) => rules.push(Rule { re, open: format!("\x1b[{}m", s.sgr).into_bytes() }),
            Err(e) => errors.push(format!("{}: {e}", s.pattern)),
        }
    }
    (rules, errors)
}

pub fn default_rules() -> Vec<RuleSpec> {
    let r = |pattern: &str, sgr: &str| RuleSpec { pattern: pattern.into(), sgr: sgr.into(), enabled: true };
    vec![
        r(r"(?i)\b(?:errors?|fail(?:ed|ure|s)?|fatal|panic(?:ked)?|exception|denied|refused|critical|invalid|unreachable|timed? ?out)\b", "1;31"),
        r(r"(?i)\b(?:warn(?:ing|ings)?|deprecated|caution)\b", "33"),
        r(r"(?i)\b(?:ok|success(?:ful(?:ly)?)?|succeeded|passed|done|completed?|active|running|enabled|listening)\b", "32"),
        r(r#"\bhttps?://[^\s"'<>]+"#, "4;34"),
        r(r"\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:/\d{1,2})?(?::\d{1,5})?\b", "36"),
        r(r"\b[0-9a-fA-F]{2}(?::[0-9a-fA-F]{2}){5}\b", "36"),
        r(r"\b\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2}(?:[.,]\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b", "35"),
        r(r"\b\d{1,2}:\d{2}:\d{2}\b", "35"),
    ]
}

#[derive(Clone, Copy, PartialEq)]
enum State {
    Ground,
    Esc,
    EscInter,
    Csi,
    Str,    // OSC / DCS / APC / PM / SOS body
    StrEsc, // ESC seen inside a string (expecting '\')
}

pub struct StreamFilter {
    state: State,
    params: Vec<u8>,
    sgr_default: bool,
    alt_screen: bool,
    pub highlight: bool,
}

impl Default for StreamFilter {
    fn default() -> Self {
        Self { state: State::Ground, params: Vec::new(), sgr_default: true, alt_screen: false, highlight: true }
    }
}

impl StreamFilter {
    /// Process one chunk. Returns the (possibly highlighted) output; if `plain` is
    /// given, appends the ANSI-stripped text to it.
    pub fn process(&mut self, input: &[u8], mut plain: Option<&mut Vec<u8>>) -> Vec<u8> {
        let rules = RULES.read().clone();
        let active = self.highlight && !rules.is_empty();
        let mut out = Vec::with_capacity(input.len() + input.len() / 16);
        let mut run_start: Option<usize> = None;

        macro_rules! flush {
            ($end:expr) => {
                if let Some(s) = run_start.take() {
                    let run = &input[s..$end];
                    if let Some(p) = plain.as_deref_mut() {
                        p.extend_from_slice(run);
                    }
                    if active && self.sgr_default && !self.alt_screen {
                        highlight_run(run, &rules, &mut out);
                    } else {
                        out.extend_from_slice(run);
                    }
                }
            };
        }

        for (i, &b) in input.iter().enumerate() {
            match self.state {
                State::Ground => {
                    if b == 0x1b {
                        flush!(i);
                        self.state = State::Esc;
                        out.push(b);
                    } else if b < 0x20 || b == 0x7f {
                        flush!(i);
                        if let Some(p) = plain.as_deref_mut() {
                            if b == b'\n' || b == b'\t' {
                                p.push(b);
                            }
                        }
                        out.push(b);
                    } else if run_start.is_none() {
                        run_start = Some(i);
                    }
                }
                State::Esc => {
                    out.push(b);
                    self.state = match b {
                        b'[' => {
                            self.params.clear();
                            State::Csi
                        }
                        b']' | b'P' | b'X' | b'^' | b'_' => State::Str,
                        0x20..=0x2f => State::EscInter,
                        _ => State::Ground,
                    };
                }
                State::EscInter => {
                    out.push(b);
                    if (0x30..=0x7e).contains(&b) {
                        self.state = State::Ground;
                    }
                }
                State::Csi => {
                    out.push(b);
                    if (0x40..=0x7e).contains(&b) {
                        self.on_csi(b);
                        self.state = State::Ground;
                    } else if self.params.len() < 64 {
                        self.params.push(b);
                    }
                }
                State::Str => {
                    out.push(b);
                    if b == 0x07 {
                        self.state = State::Ground;
                    } else if b == 0x1b {
                        self.state = State::StrEsc;
                    }
                }
                State::StrEsc => {
                    out.push(b);
                    self.state = State::Ground;
                }
            }
        }
        flush!(input.len());
        out
    }

    fn on_csi(&mut self, fin: u8) {
        let params = std::str::from_utf8(&self.params).unwrap_or("");
        match fin {
            b'm' => {
                // Conservative tracking: only an explicit reset makes text "default" again.
                let mut default = self.sgr_default;
                for p in params.split([';', ':']) {
                    match p {
                        "" | "0" => default = true,
                        _ => default = false,
                    }
                }
                self.sgr_default = default;
            }
            b'h' | b'l' if params.starts_with('?') => {
                if params[1..].split(';').any(|p| matches!(p, "1049" | "1047" | "47")) {
                    self.alt_screen = fin == b'h';
                }
            }
            _ => {}
        }
    }
}

fn highlight_run(run: &[u8], rules: &[Rule], out: &mut Vec<u8>) {
    // Only highlight the valid UTF-8 prefix (a chunk may end mid-character).
    let valid = match std::str::from_utf8(run) {
        Ok(s) => s.len(),
        Err(e) => e.valid_up_to(),
    };
    let text = std::str::from_utf8(&run[..valid]).unwrap_or_default();

    let mut spans: Vec<(usize, usize, usize)> = Vec::new();
    for (ri, rule) in rules.iter().enumerate() {
        for m in rule.re.find_iter(text) {
            if m.start() < m.end() {
                spans.push((m.start(), m.end(), ri));
            }
        }
    }
    if spans.is_empty() {
        out.extend_from_slice(run);
        return;
    }
    // Earliest first, longest wins; drop overlaps.
    spans.sort_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)));
    let mut pos = 0;
    for (s, e, ri) in spans {
        if s < pos {
            continue;
        }
        out.extend_from_slice(&run[pos..s]);
        out.extend_from_slice(&rules[ri].open);
        out.extend_from_slice(&run[s..e]);
        out.extend_from_slice(b"\x1b[0m");
        pos = e;
    }
    out.extend_from_slice(&run[pos..]);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &str) -> String {
        let mut f = StreamFilter::default();
        String::from_utf8(f.process(input.as_bytes(), None)).unwrap()
    }

    #[test]
    fn highlights_plain_text() {
        assert_eq!(run("build failed\r\n"), "build \x1b[1;31mfailed\x1b[0m\r\n");
        assert!(run("see https://x.io/a now").contains("\x1b[4;34mhttps://x.io/a\x1b[0m"));
        assert!(run("host 10.0.0.1:22 up").contains("\x1b[36m10.0.0.1:22\x1b[0m"));
    }

    #[test]
    fn leaves_colored_text_alone() {
        let s = "\x1b[31mERROR already red\x1b[0m error";
        assert_eq!(run(s), "\x1b[31mERROR already red\x1b[0m \x1b[1;31merror\x1b[0m");
    }

    #[test]
    fn skips_alt_screen_and_escapes() {
        assert_eq!(run("\x1b[?1049herror\x1b[?1049l"), "\x1b[?1049herror\x1b[?1049l");
        assert_eq!(run("\x1b]0;error title\x07"), "\x1b]0;error title\x07");
    }

    #[test]
    fn strips_for_log() {
        let mut f = StreamFilter::default();
        let mut plain = Vec::new();
        f.process(b"\x1b[32mok\x1b[0m line\r\n\x1b]0;t\x07next", Some(&mut plain));
        assert_eq!(String::from_utf8(plain).unwrap(), "ok line\nnext");
    }
}
