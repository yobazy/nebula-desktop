//! Open a checkout in a code editor: the macOS apps found installed, opened
//! with `open -a`, which needs no command-line shim on PATH.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

/// Editors worth offering, by their app bundle name.
const KNOWN: &[&str] = &[
    "Cursor",
    "Visual Studio Code",
    "Zed",
    "Windsurf",
    "Sublime Text",
    "Nova",
    "Xcode",
    "IntelliJ IDEA",
    "WebStorm",
    "Fleet",
];

#[derive(Serialize)]
pub struct Editor {
    name: String,
}

fn installed(name: &str) -> bool {
    let home = std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    [PathBuf::from("/Applications"), home.join("Applications")]
        .iter()
        .any(|dir| dir.join(format!("{name}.app")).exists())
}

/// The known editors installed on this Mac, in order of preference.
#[tauri::command]
pub async fn list_editors() -> Vec<Editor> {
    KNOWN
        .iter()
        .filter(|n| installed(n))
        .map(|n| Editor { name: n.to_string() })
        .collect()
}

/// Async and off the runtime: `open -a` waits while the editor launches,
/// and a sync command would hold the main thread (and the UI) meanwhile.
#[tauri::command]
pub async fn open_in_editor(path: PathBuf, app: String) -> Result<(), String> {
    if !KNOWN.contains(&app.as_str()) {
        return Err(format!("{app} isn't an editor this app knows"));
    }
    tauri::async_runtime::spawn_blocking(move || {
        let out = Command::new("/usr/bin/open")
            .arg("-a")
            .arg(&app)
            .arg(&path)
            .output()
            .map_err(|e| format!("couldn't run open: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("{app} didn't open: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
