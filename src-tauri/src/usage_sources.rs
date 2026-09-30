//! Read-only adapters for local agent histories. No prompts leave the process.
//! Pi: packages/ai/src/types.ts and coding-agent/src/core/session-manager.ts.
//! OpenCode: packages/core/src/session/sql.ts and schema/src/session-message.ts.
use super::{collect, parse_time, Bucket, Tokens, UsageReport};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

#[derive(Default)]
pub(super) struct Sources {
    logs: HashMap<PathBuf, Log>,
}

#[derive(Default)]
struct Log {
    offset: u64,
    modified: Option<SystemTime>,
    session: String,
    cwd: String,
    model: String,
    totals: Option<[u64; 4]>,
    records: HashMap<String, Bucket>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Coverage {
    pub source: String,
    pub roots: Vec<String>,
    pub files: usize,
    pub status: String,
    pub detail: Option<String>,
}

fn number(v: &Value, key: &str) -> u64 {
    v[key].as_u64().unwrap_or(0)
}
fn text(v: &Value, key: &str) -> String {
    v[key].as_str().unwrap_or_default().to_owned()
}
fn cost(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}
fn home_dir(env: &str, fallback: &str) -> PathBuf {
    std::env::var_os(env).map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var_os("HOME").unwrap_or_default()).join(fallback)
    })
}

impl Log {
    fn ingest(&mut self, line: &str, source: &str) {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let kind = v["type"].as_str().unwrap_or_default();
        if source == "codex" {
            let p = &v["payload"];
            match kind {
                "session_meta" => {
                    self.session = text(p, "id");
                    self.cwd = text(p, "cwd");
                }
                "turn_context" => {
                    self.model = text(p, "model");
                    if let Some(cwd) = p["cwd"].as_str() {
                        self.cwd = cwd.into();
                    }
                }
                "event_msg" if p["type"] == "token_count" => {
                    let total = &p["info"]["total_token_usage"];
                    if !total.is_object() {
                        return;
                    }
                    let next = [
                        number(total, "input_tokens"),
                        number(total, "cached_input_tokens"),
                        number(total, "output_tokens"),
                        number(total, "cache_write_input_tokens"),
                    ];
                    let prev = self.totals.unwrap_or([0; 4]);
                    // Rate-limit updates repeat the same cumulative counters. Context
                    // compaction can lower counters: rebase, don't count history again.
                    self.totals = Some(next);
                    if next == prev || next[0] < prev[0] || next[2] < prev[2] {
                        return;
                    }
                    let d: Vec<u64> = next
                        .iter()
                        .zip(prev)
                        .map(|(n, p)| n.saturating_sub(p))
                        .collect();
                    let cached = d[1].min(d[0]);
                    let write = d[3].min(d[0].saturating_sub(cached));
                    let tokens = Tokens {
                        input: d[0].saturating_sub(cached + write),
                        cache_read: cached,
                        cache_write_5m: write,
                        output: d[2],
                        ..Tokens::default()
                    };
                    // Reasoning is already included in output_tokens.
                    let key = format!(
                        "{}:{}:{}:{}",
                        self.session,
                        text(&v, "timestamp"),
                        next[0],
                        next[2]
                    );
                    self.insert(key, &v, source, tokens, None);
                }
                _ => {}
            }
        } else if source == "pi" {
            if kind == "session" {
                self.session = text(&v, "id");
                self.cwd = text(&v, "cwd");
            } else if kind == "message" && v["message"]["role"] == "assistant" {
                let m = &v["message"];
                let u = &m["usage"];
                if !u.is_object() {
                    return;
                }
                self.model = text(m, "model");
                let w1 = number(u, "cacheWrite1h").min(number(u, "cacheWrite"));
                let tokens = Tokens {
                    input: number(u, "input"),
                    output: number(u, "output"),
                    cache_read: number(u, "cacheRead"),
                    cache_write_1h: w1,
                    cache_write_5m: number(u, "cacheWrite").saturating_sub(w1),
                };
                let id = text(&v, "id");
                if id.is_empty() {
                    return;
                }
                self.insert(
                    format!("{}:{id}", self.session),
                    &v,
                    source,
                    tokens,
                    cost(&u["cost"]["total"]),
                );
            }
        }
    }

    fn insert(
        &mut self,
        key: String,
        v: &Value,
        source: &str,
        tokens: Tokens,
        recorded_cost: Option<f64>,
    ) {
        let Some(time) = v["timestamp"].as_str().and_then(parse_time) else {
            return;
        };
        if self.session.is_empty() {
            return;
        }
        self.records.insert(
            key,
            Bucket {
                source: source.into(),
                recorded_cost,
                hour: time - time.rem_euclid(3600),
                session: self.session.clone(),
                cwd: self.cwd.clone(),
                model: if self.model.is_empty() {
                    "unknown".into()
                } else {
                    self.model.clone()
                },
                tokens,
                responses: 1,
            },
        );
    }

    fn read(&mut self, path: &Path, source: &str) -> Result<(), String> {
        let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
        let modified = meta.modified().ok();
        if meta.len() < self.offset || (meta.len() == self.offset && self.modified != modified) {
            *self = Self::default();
        }
        if meta.len() == self.offset {
            return Ok(());
        }
        let mut f = File::open(path).map_err(|e| e.to_string())?;
        f.seek(SeekFrom::Start(self.offset))
            .map_err(|e| e.to_string())?;
        let mut reader = BufReader::new(f);
        let mut line = Vec::new();
        loop {
            line.clear();
            let n = reader
                .read_until(b'\n', &mut line)
                .map_err(|e| e.to_string())?;
            if n == 0 || line.last() != Some(&b'\n') {
                break;
            }
            if let Ok(s) = std::str::from_utf8(&line) {
                self.ingest(s, source);
            }
            self.offset += n as u64;
        }
        self.modified = modified;
        Ok(())
    }
}

fn read_logs(
    state: &mut Sources,
    source: &str,
    roots: Vec<PathBuf>,
    report: &mut UsageReport,
    since: i64,
) {
    let mut files = Vec::new();
    let mut errors = Vec::new();
    for root in &roots {
        match std::fs::read_dir(root) {
            Ok(_) => errors.extend(collect(root, 4, &mut files)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => errors.push(e.to_string()),
        }
    }
    let present: HashSet<_> = files.iter().cloned().collect();
    state
        .logs
        .retain(|p, _| !roots.iter().any(|r| p.starts_with(r)) || present.contains(p));
    let mut seen = HashSet::new();
    let mut read = 0;
    for path in files {
        // Old untouched files cannot contain usage in this report's range.
        if std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .is_some_and(|t| (t.as_secs() as i64) < since)
        {
            state.logs.remove(&path);
            continue;
        }
        let log = state.logs.entry(path.clone()).or_default();
        if let Err(e) = log.read(&path, source) {
            errors.push(e);
            continue;
        }
        read += 1;
        log.records.retain(|_, b| b.hour + 3600 >= since);
        for (id, b) in &log.records {
            // Archived/moved copies of the same session don't count twice.
            if seen.insert(id.clone()) {
                report.buckets.push(b.clone());
            }
        }
    }
    report.files += read;
    report.sources.push(Coverage {
        source: source.into(),
        roots: roots
            .iter()
            .map(|p| p.to_string_lossy().into_owned())
            .collect(),
        files: read,
        status: if !errors.is_empty() {
            "error"
        } else if read == 0 {
            "empty"
        } else {
            "available"
        }
        .into(),
        detail: errors.first().cloned(),
    });
}

fn opencode_row(
    id: String,
    session: String,
    cwd: String,
    time: i64,
    v: Value,
) -> Option<(String, Bucket)> {
    let u = &v["tokens"];
    if !u.is_object() {
        return None;
    }
    let model = v["modelID"]
        .as_str()
        .or_else(|| v["model"]["id"].as_str())
        .unwrap_or("unknown");
    Some((
        id,
        Bucket {
            source: "open_code".into(),
            session,
            cwd,
            model: model.into(),
            hour: time / 1000 - (time / 1000).rem_euclid(3600),
            recorded_cost: cost(&v["cost"]),
            tokens: Tokens {
                input: number(u, "input"),
                output: number(u, "output") + number(u, "reasoning"),
                cache_read: number(&u["cache"], "read"),
                cache_write_5m: number(&u["cache"], "write"),
                ..Tokens::default()
            },
            responses: 1,
        },
    ))
}

fn read_opencode(db: &Path, since: i64) -> Result<Vec<Bucket>, String> {
    let conn =
        rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| e.to_string())?;
    conn.busy_timeout(Duration::from_secs(2))
        .map_err(|e| e.to_string())?;
    let mut records = HashMap::new();
    let mut found = false;
    // New versions keep a compatibility projection in `message`. Read it
    // first, then replace matching IDs with the current session_message row.
    for table in ["message", "session_message"] {
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                [table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            continue;
        }
        found = true;
        let role = if table == "message" {
            "json_extract(m.data, '$.role')"
        } else {
            "m.type"
        };
        let sql = format!("SELECT m.id, m.session_id, s.directory, m.time_created, m.data FROM {table} m JOIN session s ON s.id=m.session_id WHERE m.time_created >= ?1 AND {role}='assistant'");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([since * 1000], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (id, session, cwd, time, data) = row.map_err(|e| e.to_string())?;
            let v = serde_json::from_str(&data).map_err(|e| e.to_string())?;
            if let Some((id, bucket)) = opencode_row(id, session, cwd, time, v) {
                records.insert(id, bucket);
            }
        }
    }
    if !found {
        return Err("Unrecognized OpenCode database schema".into());
    }
    Ok(records.into_values().collect())
}

pub(super) fn extend(state: &mut Sources, report: &mut UsageReport, since: i64) {
    let codex = home_dir("CODEX_HOME", ".codex");
    read_logs(
        state,
        "codex",
        vec![codex.join("sessions"), codex.join("archived_sessions")],
        report,
        since,
    );
    read_logs(
        state,
        "pi",
        vec![home_dir("PI_CODING_AGENT_DIR", ".pi/agent").join("sessions")],
        report,
        since,
    );
    let db = home_dir("XDG_DATA_HOME", ".local/share").join("opencode/opencode.db");
    let result = if db.exists() {
        read_opencode(&db, since)
    } else {
        Ok(Vec::new())
    };
    let status = match &result {
        Err(_) => "error",
        Ok(_) if !db.exists() => "empty",
        _ => "available",
    };
    let detail = result.as_ref().err().cloned();
    if let Ok(buckets) = result {
        report.buckets.extend(buckets);
    }
    let files = usize::from(db.exists());
    report.files += files;
    report.sources.push(Coverage {
        source: "open_code".into(),
        roots: vec![db.to_string_lossy().into_owned()],
        files,
        status: status.into(),
        detail,
    });
    for source in ["cursor", "muse", "grok", "custom"] {
        report.sources.push(Coverage {
            source: source.into(),
            roots: vec![],
            files: 0,
            status: "unsupported".into(),
            detail: Some("Usage collection is not available for this agent yet.".into()),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn codex_event(input: u64, cached: u64, output: u64) -> String {
        json!({"type":"event_msg","timestamp":"2026-09-29T12:00:00Z","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":input,"cached_input_tokens":cached,"output_tokens":output,"reasoning_output_tokens":output / 2}}}}).to_string()
    }
    fn codex_log() -> Log {
        let mut log = Log::default();
        log.ingest(
            r#"{"type":"session_meta","payload":{"id":"s","cwd":"/repo"}}"#,
            "codex",
        );
        log.ingest(
            r#"{"type":"turn_context","payload":{"model":"gpt-6-astra"}}"#,
            "codex",
        );
        log
    }

    #[test]
    fn codex_uses_deltas_and_does_not_double_count_cache_or_reasoning() {
        let mut log = codex_log();
        log.ingest(&codex_event(100, 60, 20), "codex");
        log.ingest(&codex_event(100, 60, 20), "codex");
        log.ingest(&codex_event(250, 160, 50), "codex");
        assert_eq!(log.records.len(), 2);
        let mut tokens = Tokens::default();
        for b in log.records.values() {
            tokens.add(&b.tokens);
        }
        assert_eq!(
            (tokens.input, tokens.cache_read, tokens.output),
            (90, 160, 50)
        );
        log.ingest(&codex_event(10, 0, 5), "codex");
        assert_eq!(log.records.len(), 2); // Counter reset isn't new consumption.
        log.ingest(&codex_event(30, 0, 15), "codex");
        assert_eq!(log.records.len(), 3);
    }

    #[test]
    fn pi_preserves_reported_cost_and_cache_retention() {
        let mut log = Log::default();
        log.ingest(r#"{"type":"session","id":"p","cwd":"/repo"}"#, "pi");
        let line = r#"{"type":"message","id":"m","timestamp":"2026-09-29T12:00:00Z","message":{"role":"assistant","model":"another-model","usage":{"input":100,"output":20,"cacheRead":60,"cacheWrite":30,"cacheWrite1h":10,"reasoning":5,"cost":{"total":0.42}}}}"#;
        log.ingest(line, "pi");
        log.ingest(line, "pi");
        assert_eq!(log.records.len(), 1);
        let b = log.records.values().next().unwrap();
        assert_eq!(b.recorded_cost, Some(0.42));
        assert_eq!(
            (
                b.tokens.output,
                b.tokens.cache_write_5m,
                b.tokens.cache_write_1h
            ),
            (20, 20, 10)
        );
    }

    #[test]
    fn incremental_reads_wait_for_complete_lines_and_reset_on_truncation() {
        use std::io::Write;
        let path = std::env::temp_dir().join(format!("nebula-usage-{}.jsonl", std::process::id()));
        let header = "{\"type\":\"session_meta\",\"payload\":{\"id\":\"s\",\"cwd\":\"/repo\"}}\n";
        let event = codex_event(100, 60, 20);
        std::fs::write(&path, format!("{header}{event}")).unwrap();
        let mut log = Log::default();
        log.read(&path, "codex").unwrap();
        assert!(log.records.is_empty());
        File::options()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"\n")
            .unwrap();
        log.read(&path, "codex").unwrap();
        log.read(&path, "codex").unwrap();
        assert_eq!(log.records.len(), 1);
        std::fs::write(&path, header).unwrap();
        log.read(&path, "codex").unwrap();
        assert!(log.records.is_empty());
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn opencode_reads_both_schemas_once_and_adds_reasoning() {
        let path = std::env::temp_dir().join(format!("nebula-usage-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let c = rusqlite::Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE session(id TEXT, directory TEXT); INSERT INTO session VALUES ('s','/repo'); CREATE TABLE message(id TEXT, session_id TEXT, time_created INTEGER, data TEXT); CREATE TABLE session_message(id TEXT, session_id TEXT, time_created INTEGER, type TEXT, data TEXT);").unwrap();
        let v = json!({"role":"assistant", "modelID":"claude-sonnet-4-6", "tokens":{"input":100,"output":20,"reasoning":5,"cache":{"read":60,"write":10}}, "cost":0.2});
        c.execute(
            "INSERT INTO message VALUES ('m','s',1790683200000,?1)",
            [v.to_string()],
        )
        .unwrap();
        let mut new = v.clone();
        new["cost"] = json!(0.3);
        new["model"] = json!({"id":"gpt-6-astra"});
        new.as_object_mut().unwrap().remove("modelID");
        c.execute(
            "INSERT INTO session_message VALUES ('m','s',1790683200000,'assistant',?1)",
            [new.to_string()],
        )
        .unwrap();
        let rows = read_opencode(&path, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].tokens.output, 25);
        assert_eq!(rows[0].recorded_cost, Some(0.3));
        assert_eq!(rows[0].model, "gpt-6-astra");
        assert!(read_opencode(&path, 2000000000).unwrap().is_empty());
        drop(c);
        std::fs::remove_file(path).unwrap();
    }
}
