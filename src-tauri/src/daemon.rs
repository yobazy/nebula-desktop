//! The one connection to the nebula daemon: version handshake, a writer task
//! fed by `send`, and a reader task that forwards every `ServerEvent` to the
//! webview. PTY bytes travel on their own event as base64 so the webview never
//! sees a JSON array of numbers.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use nebula_core::codec::{read_frame, write_frame};
use nebula_core::{paths, ClientRequest, ServerEvent, SessionRef, PROTOCOL_VERSION};
use serde::Serialize;
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::net::UnixStream;
use tokio::sync::{mpsc, Mutex};

pub const EVENT: &str = "nebula://event";
pub const PTY: &str = "nebula://pty";
pub const LINK: &str = "nebula://link";

#[derive(Default)]
pub struct DaemonState {
    tx: Mutex<Option<mpsc::Sender<ClientRequest>>>,
}

#[derive(Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
enum LinkState {
    Connected { daemon_pid: u32 },
    Disconnected { reason: String },
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyChunk {
    session: SessionRef,
    /// True for the ring replay that follows an Attach: the terminal resets first.
    replay: bool,
    seq: u64,
    data: String,
}

/// Connect (a no-op when already connected), handshake and subscribe. The
/// Snapshot and every delta after it arrive on `nebula://event`.
#[tauri::command]
pub async fn connect(app: AppHandle, state: State<'_, DaemonState>) -> Result<u32, String> {
    let mut slot = state.tx.lock().await;
    if slot.as_ref().is_some_and(|tx| !tx.is_closed()) {
        return Err("already connected".into());
    }

    let sock = paths::socket_path();
    let mut stream = UnixStream::connect(&sock).await.map_err(|e| {
        format!("No nebula daemon is listening on {} ({e}).", sock.display())
    })?;
    write_frame(
        &mut stream,
        &ClientRequest::Hello {
            protocol_version: PROTOCOL_VERSION,
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    let daemon_pid = match read_frame::<ServerEvent, _>(&mut stream).await {
        Ok(Some(ServerEvent::HelloOk { daemon_pid, .. })) => daemon_pid,
        Ok(Some(ServerEvent::Incompatible {
            daemon_protocol_version,
        })) => {
            return Err(format!(
                "The daemon speaks protocol v{daemon_protocol_version}, this app v{PROTOCOL_VERSION}. \
                 Rebuild the app against the nebula release you have installed."
            ))
        }
        Ok(other) => return Err(format!("Unexpected handshake reply: {other:?}")),
        Err(e) => return Err(e.to_string()),
    };

    let (mut read_half, mut write_half) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<ClientRequest>(256);

    tokio::spawn(async move {
        while let Some(req) = rx.recv().await {
            if write_frame(&mut write_half, &req).await.is_err() {
                break;
            }
        }
    });

    let reader_app = app.clone();
    tokio::spawn(async move {
        let reason = loop {
            match read_frame::<ServerEvent, _>(&mut read_half).await {
                Ok(Some(event)) => forward(&reader_app, event),
                Ok(None) => break "The daemon closed the connection.".to_string(),
                Err(e) => break format!("Lost the daemon connection: {e}"),
            }
        };
        // Dropping the sender ends the writer task and lets `connect` retry.
        if let Some(state) = reader_app.try_state::<DaemonState>() {
            *state.tx.lock().await = None;
        }
        let _ = reader_app.emit(LINK, LinkState::Disconnected { reason });
    });

    tx.send(ClientRequest::Subscribe)
        .await
        .map_err(|e| e.to_string())?;
    *slot = Some(tx);
    let _ = app.emit(LINK, LinkState::Connected { daemon_pid });
    Ok(daemon_pid)
}

fn forward(app: &AppHandle, event: ServerEvent) {
    let chunk = match event {
        ServerEvent::Scrollback {
            session,
            base_seq,
            data,
        } => PtyChunk {
            session,
            replay: true,
            seq: base_seq,
            data: B64.encode(data),
        },
        ServerEvent::Output { session, seq, data } => PtyChunk {
            session,
            replay: false,
            seq,
            data: B64.encode(data),
        },
        // A run terminal's latest output (runs.ts reads its address off it).
        // Its bytes would serialize as a JSON array of numbers, so they go
        // as base64 like the PTY stream does.
        ServerEvent::OutputTail { req_id, session, tail } => {
            let tail = tail.map(|t| {
                serde_json::json!({ "end_seq": t.end_seq, "data": B64.encode(t.data) })
            });
            let _ = app.emit(
                EVENT,
                serde_json::json!({ "OutputTail": { "req_id": req_id, "session": session, "tail": tail } }),
            );
            return;
        }
        other => {
            let _ = app.emit(EVENT, other);
            return;
        }
    };
    let _ = app.emit(PTY, chunk);
}

async fn sender(state: &State<'_, DaemonState>) -> Result<mpsc::Sender<ClientRequest>, String> {
    state
        .tx
        .lock()
        .await
        .clone()
        .filter(|tx| !tx.is_closed())
        .ok_or_else(|| "Not connected to the nebula daemon.".to_string())
}

/// Any `ClientRequest`, in serde's externally tagged JSON shape
/// (`{"CreateAgent": {...}}`, `"Subscribe"`).
#[tauri::command]
pub async fn send(request: serde_json::Value, state: State<'_, DaemonState>) -> Result<(), String> {
    let req: ClientRequest =
        serde_json::from_value(request).map_err(|e| format!("Malformed request: {e}"))?;
    sender(&state).await?.send(req).await.map_err(|e| e.to_string())
}

/// Keystrokes for an attached session, as the text xterm.js produced.
#[tauri::command]
pub async fn send_input(
    session: SessionRef,
    data: String,
    state: State<'_, DaemonState>,
) -> Result<(), String> {
    let req = ClientRequest::Input {
        session,
        data: data.into_bytes(),
    };
    sender(&state).await?.send(req).await.map_err(|e| e.to_string())
}

/// Start `nebula daemon` through the user's interactive login shell, so it
/// gets the PATH a terminal would (a Finder-launched app has almost none),
/// in a session of its own so it outlives this app.
#[tauri::command]
pub fn start_daemon() -> Result<(), String> {
    use std::os::unix::process::CommandExt;
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    // By its full path when found, so a nebula this app installed into
    // ~/.local/bin starts even if the shell profile doesn't put it on PATH.
    let nebula = crate::nebula_setup::find()
        .map(|p| format!("'{}'", p.display().to_string().replace('\'', "'\\''")))
        .unwrap_or_else(|| "nebula".into());
    let mut cmd = std::process::Command::new(shell);
    cmd.args(["-l", "-i", "-c", &format!("exec {nebula} daemon")])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    unsafe {
        cmd.pre_exec(|| {
            extern "C" {
                fn setsid() -> i32;
            }
            if setsid() < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

fn read_json(path: PathBuf) -> serde_json::Value {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(serde_json::Value::Null)
}

/// nebula's settings: `config.json` with `config.local.json` laid over it key
/// by key, the same merge the TUI and daemon read.
#[tauri::command]
pub fn read_settings() -> serde_json::Value {
    let mut merged = match read_json(paths::config_path()) {
        serde_json::Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    if let serde_json::Value::Object(local) = read_json(paths::config_local_path()) {
        merged.extend(local);
    }
    serde_json::Value::Object(merged)
}

/// The AGENT PRESETS list the TUI edits; empty when there is none.
#[tauri::command]
pub fn read_presets() -> serde_json::Value {
    match read_json(paths::data_dir().join("agent_presets.json")) {
        v @ serde_json::Value::Array(_) => v,
        _ => serde_json::Value::Array(vec![]),
    }
}

/// A line from the webview on stdout, for debugging a build you can't see.
#[tauri::command]
pub fn debug_log(msg: String) {
    println!("[webview] {msg}");
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderInfo {
    exists: bool,
    /// Symlinks resolved when the folder exists, so it compares against the
    /// daemon's own paths; the path as given otherwise.
    path: PathBuf,
    /// A `.git` (directory, or a linked worktree's file) in it or above it —
    /// the same stat-per-ancestor test the TUI makes before `git init`.
    in_git_repo: bool,
}

/// What the add-project flow needs to know before asking the daemon: the
/// webview cannot stat the filesystem itself.
#[tauri::command]
pub fn inspect_folder(path: PathBuf) -> FolderInfo {
    let exists = path.exists();
    let path = std::fs::canonicalize(&path).unwrap_or(path);
    let in_git_repo = exists && path.ancestors().any(|d| d.join(".git").exists());
    FolderInfo {
        exists,
        path,
        in_git_repo,
    }
}
