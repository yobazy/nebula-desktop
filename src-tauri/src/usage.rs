//! Local agent usage. Claude Code logs are parsed here; other adapters live
//! in `usage_sources.rs`. Claude Code logs
//! (`~/.claude/projects/<cwd>/<session>.jsonl`, subagents under
//! `<session>/subagents/`). Every assistant response is logged with its token
//! usage, cwd and session id; the webview maps those onto nebula projects and
//! tasks. Logs only grow, so each file is read from where the last scan
//! stopped, and a first scan skips files untouched for longer than asked.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::State;

#[path = "usage_sources.rs"]
mod sources;

#[derive(Default)]
pub struct UsageState(Arc<Mutex<Scan>>);

#[derive(Default)]
struct Scan {
    /// Bytes of each log already read (always up to a line break).
    offsets: HashMap<PathBuf, u64>,
    /// One per API response, keyed by message id + request id: Claude Code
    /// writes a response once per content block, each copy with its usage.
    records: HashMap<String, Record>,
    other: sources::Sources,
    errors: Vec<String>,
}

#[derive(Clone)]
struct Record {
    time: i64,
    session: String,
    cwd: String,
    model: String,
    usage: Tokens,
}

#[derive(Clone, Copy, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tokens {
    input: u64,
    output: u64,
    cache_write_5m: u64,
    cache_write_1h: u64,
    cache_read: u64,
}

impl Tokens {
    fn add(&mut self, o: &Tokens) {
        self.input += o.input;
        self.output += o.output;
        self.cache_write_5m += o.cache_write_5m;
        self.cache_write_1h += o.cache_write_1h;
        self.cache_read += o.cache_read;
    }
}

/// Usage summed per hour, session, cwd and model — small enough to send whole,
/// fine enough for the webview to cut by project, task, day or 5-hour window.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bucket {
    source: String,
    recorded_cost: Option<f64>,
    /// Unix seconds at the top of the hour.
    hour: i64,
    session: String,
    cwd: String,
    model: String,
    #[serde(flatten)]
    tokens: Tokens,
    responses: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageReport {
    files: usize,
    sources: Vec<sources::Coverage>,
    buckets: Vec<Bucket>,
}

// ---- the log line, only the fields read ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line {
    #[serde(rename = "type")]
    kind: Option<String>,
    session_id: Option<String>,
    cwd: Option<String>,
    timestamp: Option<String>,
    request_id: Option<String>,
    message: Option<Message>,
}

#[derive(Deserialize)]
struct Message {
    id: Option<String>,
    model: Option<String>,
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u64,
    #[serde(default)]
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    cache_creation: Option<CacheCreation>,
}

#[derive(Deserialize)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

fn logs_root() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(dir).join("projects"));
    }
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".claude").join("projects"))
}

/// Every `.jsonl` up to two levels below a project folder (the session log,
/// and its `subagents/` logs).
fn collect(dir: &Path, depth: u8, out: &mut Vec<PathBuf>) -> Vec<String> {
    let mut errors = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return errors,
        Err(e) => return vec![e.to_string()],
    };
    for entry in entries {
        let e = match entry {
            Ok(e) => e,
            Err(e) => {
                errors.push(e.to_string());
                continue;
            }
        };
        let path = e.path();
        let ft = match e.file_type() {
            Ok(ft) => ft,
            Err(e) => {
                errors.push(e.to_string());
                continue;
            }
        };
        if ft.is_dir() && depth > 0 {
            errors.extend(collect(&path, depth - 1, out));
        } else if ft.is_file() && path.extension().is_some_and(|x| x == "jsonl") {
            out.push(path);
        }
    }
    errors
}

/// "2026-09-26T08:35:44.008Z" → Unix seconds (UTC; the logs always write Z).
fn parse_time(ts: &str) -> Option<i64> {
    let b = ts.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let num = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, m, d) = (num(0..4)?, num(5..7)?, num(8..10)?);
    let (hh, mm, ss) = (num(11..13)?, num(14..16)?, num(17..19)?);
    // Days from the civil date (Howard Hinnant's algorithm).
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3_600 + mm * 60 + ss)
}

fn ingest(line: &str, records: &mut HashMap<String, Record>) {
    // Cheap reject before parsing: most lines are tool results and user turns.
    if !line.contains("\"usage\"") {
        return;
    }
    let Ok(l) = serde_json::from_str::<Line>(line) else {
        return;
    };
    if l.kind.as_deref() != Some("assistant") {
        return;
    }
    let Some(msg) = l.message else { return };
    let (Some(u), Some(model)) = (msg.usage, msg.model) else {
        return;
    };
    // Claude Code's own placeholder turns (errors, interrupts) cost nothing.
    if model.starts_with('<') {
        return;
    }
    let Some(time) = l.timestamp.as_deref().and_then(parse_time) else {
        return;
    };
    let (w5, w1) = match u.cache_creation {
        Some(c) if c.ephemeral_5m_input_tokens + c.ephemeral_1h_input_tokens > 0 => {
            (c.ephemeral_5m_input_tokens, c.ephemeral_1h_input_tokens)
        }
        _ => (u.cache_creation_input_tokens, 0),
    };
    let usage = Tokens {
        input: u.input_tokens,
        output: u.output_tokens,
        cache_write_5m: w5,
        cache_write_1h: w1,
        cache_read: u.cache_read_input_tokens,
    };
    let key = format!(
        "{}:{}",
        msg.id.as_deref().unwrap_or(""),
        l.request_id.as_deref().unwrap_or("")
    );
    // A response logged more than once keeps its most complete usage.
    if records
        .get(&key)
        .is_some_and(|r| r.usage.output > usage.output)
    {
        return;
    }
    records.insert(
        key,
        Record {
            time,
            session: l.session_id.unwrap_or_default(),
            cwd: l.cwd.unwrap_or_default(),
            model,
            usage,
        },
    );
}

/// Read what each log gained since the last scan, a line at a time (some
/// logs run to tens of megabytes), and forget logs that are gone.
fn scan(state: &mut Scan, root: &Path, since: SystemTime) -> usize {
    let mut files = Vec::new();
    state.errors = collect(root, 3, &mut files);
    let present: std::collections::HashSet<&PathBuf> = files.iter().collect();
    state.offsets.retain(|p, _| present.contains(p));
    let mut read = 0;
    for path in &files {
        let Ok(meta) = std::fs::metadata(path) else {
            continue;
        };
        if meta.modified().map_or(true, |t| t < since) {
            continue;
        }
        let len = meta.len();
        let mut from = state.offsets.get(path).copied().unwrap_or(0);
        // A log that shrank was rewritten: read it again from the top.
        if len < from {
            from = 0;
        }
        if len == from {
            continue;
        }
        let mut f = match File::open(path) {
            Ok(f) => f,
            Err(e) => {
                state.errors.push(e.to_string());
                continue;
            }
        };
        if f.seek(SeekFrom::Start(from)).is_err() {
            continue;
        }
        let mut reader = BufReader::new(f);
        let mut line = Vec::new();
        let mut at = from;
        loop {
            line.clear();
            let Ok(n) = reader.read_until(b'\n', &mut line) else {
                break;
            };
            // Stop before a line still being written; it's read next time.
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            at += n as u64;
            if let Ok(text) = std::str::from_utf8(&line) {
                ingest(text, &mut state.records);
            }
        }
        state.offsets.insert(path.clone(), at);
        read += 1;
    }
    read
}

fn report(state: &Scan, root: PathBuf, since: i64) -> UsageReport {
    let mut buckets: HashMap<(i64, &str, &str, &str), (Tokens, u32)> = HashMap::new();
    for r in state.records.values().filter(|r| r.time >= since) {
        let hour = r.time - r.time.rem_euclid(3_600);
        let e = buckets
            .entry((hour, &r.session, &r.cwd, &r.model))
            .or_default();
        e.0.add(&r.usage);
        e.1 += 1;
    }
    let mut buckets: Vec<Bucket> = buckets
        .into_iter()
        .map(
            |((hour, session, cwd, model), (tokens, responses))| Bucket {
                source: "claude".into(),
                recorded_cost: None,
                hour,
                session: session.to_string(),
                cwd: cwd.to_string(),
                model: model.to_string(),
                tokens,
                responses,
            },
        )
        .collect();
    buckets.sort_by_key(|b| b.hour);
    UsageReport {
        sources: vec![sources::Coverage {
            source: "claude".into(),
            roots: vec![root.to_string_lossy().into_owned()],
            files: state.offsets.len(),
            status: if !state.errors.is_empty() {
                "error"
            } else if state.offsets.is_empty() {
                "empty"
            } else {
                "available"
            }
            .into(),
            detail: state.errors.first().cloned(),
        }],
        files: state.offsets.len(),
        buckets,
    }
}

/// Preserve measured vs estimated costs while combining responses for transport.
fn compact_buckets(report: &mut UsageReport) {
    let mut grouped: HashMap<(String, i64, String, String, String, bool), Bucket> = HashMap::new();
    for b in report.buckets.drain(..) {
        let key = (
            b.source.clone(),
            b.hour,
            b.session.clone(),
            b.cwd.clone(),
            b.model.clone(),
            b.recorded_cost.is_some(),
        );
        if let Some(old) = grouped.get_mut(&key) {
            old.tokens.add(&b.tokens);
            old.responses += b.responses;
            if let (Some(a), Some(n)) = (old.recorded_cost.as_mut(), b.recorded_cost) {
                *a += n;
            }
        } else {
            grouped.insert(key, b);
        }
    }
    report.buckets = grouped.into_values().collect();
    report.buckets.sort_by_key(|b| b.hour);
}

/// Usage over the last `days` days, in hourly buckets.
#[tauri::command]
pub async fn usage_report(days: u32, state: State<'_, UsageState>) -> Result<UsageReport, String> {
    let root = logs_root().ok_or("no home directory")?;
    let shared = state.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let window = Duration::from_secs(u64::from(days.max(1)) * 86_400);
        let now = SystemTime::now();
        let since = now.checked_sub(window).unwrap_or(UNIX_EPOCH);
        let mut scan_state = shared.lock().map_err(|_| "usage scan poisoned")?;
        scan(&mut scan_state, &root, since);
        let since_secs = since
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| d.as_secs() as i64);
        // Nothing older than the window is ever reported again: let it go,
        // so a long-running app holds a month of records, not all of them.
        scan_state.records.retain(|_, r| r.time >= since_secs);
        let mut result = report(&scan_state, root, since_secs);
        sources::extend(&mut scan_state.other, &mut result, since_secs);
        compact_buckets(&mut result);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_log_timestamps() {
        assert_eq!(parse_time("1970-01-01T00:00:00.000Z"), Some(0));
        assert_eq!(parse_time("2026-09-26T08:35:44.008Z"), Some(1_790_411_744));
        assert_eq!(parse_time("2024-02-29T12:00:00Z"), Some(1_709_208_000));
    }

    #[test]
    fn keeps_one_record_per_response() {
        let mut records = HashMap::new();
        let line = |out: u64| {
            format!(
                r#"{{"type":"assistant","sessionId":"s","cwd":"/r","timestamp":"2026-09-26T08:00:00Z","requestId":"q","message":{{"id":"m","model":"claude-opus-5-5","usage":{{"input_tokens":2,"output_tokens":{out},"cache_creation_input_tokens":10,"cache_read_input_tokens":5,"cache_creation":{{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":10}}}}}}}}"#
            )
        };
        ingest(&line(3), &mut records);
        ingest(&line(40), &mut records);
        ingest(&line(3), &mut records);
        assert_eq!(records.len(), 1);
        let r = records.values().next().unwrap();
        assert_eq!(
            (
                r.usage.output,
                r.usage.cache_write_1h,
                r.usage.cache_write_5m
            ),
            (40, 10, 0)
        );
        ingest(
            r#"{"type":"assistant","message":{"model":"<synthetic>","usage":{}}}"#,
            &mut records,
        );
        assert_eq!(records.len(), 1);
    }
}
