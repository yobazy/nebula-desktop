//! Writing nebula's settings, the way the TUI does (`Config::write_layers`):
//! a key the local layer (`config.local.json`) already holds is changed
//! there, since that's where this machine keeps it; any other key is patched
//! into `config.json`, leaving every key this app doesn't know untouched.
//! Both writes are atomic and go through a symlinked `config.json`.
//!
//! Plus the desktop app's own preferences (its light/dark look), which the
//! TUI has no use for: `desktop.json` in the app's config directory.

use nebula_core::{paths, settings};
use serde_json::{Map, Value};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

fn object_at(path: &std::path::Path) -> Result<Map<String, Value>, String> {
    // An unreadable file is refused rather than overwritten from a blank
    // view: that would drop every setting in it.
    settings::read_object(path).map(Option::unwrap_or_default)
}

/// Keys the TUI renamed, old → new, as its `RENAMED_KEYS`. Writing the new
/// name drops the old one from both layers (or serde sees the field twice),
/// and a value the local layer held under the old name stays local under
/// the new one, as the TUI's `write_layers` keeps it.
const RENAMED_KEYS: &[(&str, &str)] = &[("hide_terminal_glyphs", "hide_card_marks")];

/// Set one top-level setting. `null` removes it, so it reads as its default.
#[tauri::command]
pub fn write_setting(key: String, value: Value) -> Result<(), String> {
    let local_path = paths::config_local_path();
    let mut local = settings::read_object(&local_path).ok().flatten();
    for (old, new) in RENAMED_KEYS.iter().filter(|(_, new)| *new == key) {
        let config_path = paths::config_path();
        if let Ok(Some(mut root)) = settings::read_object(&config_path) {
            if root.remove(*old).is_some() {
                settings::write_json(&config_path, &Value::Object(root)).map_err(|e| e.to_string())?;
            }
        }
        if let Some(held) = local.as_mut() {
            if let Some(v) = held.remove(*old) {
                held.entry(new.to_string()).or_insert(v);
            }
        }
    }
    if let Some(mut local) = local {
        if local.contains_key(&key) {
            if value.is_null() {
                local.remove(&key);
            } else {
                local.insert(key, value);
            }
            return settings::write_json(&local_path, &Value::Object(local)).map_err(|e| e.to_string());
        }
    }
    let path = paths::config_path();
    let mut root = object_at(&path)?;
    if value.is_null() {
        root.remove(&key);
    } else {
        root.insert(key, value);
    }
    settings::write_json(&path, &Value::Object(root)).map_err(|e| e.to_string())
}

/// Set one field of a project's entry under `projects` (keyed by the repo's
/// path), as the TUI's Project tab does. An empty string removes the field,
/// and an entry left empty is removed, so the file reads as if never edited.
#[tauri::command]
pub fn write_project_setting(repo: String, field: String, value: String) -> Result<(), String> {
    let merged = crate::daemon::read_settings();
    let mut projects = merged
        .get("projects")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut entry = projects
        .get(&repo)
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    if value.trim().is_empty() {
        entry.remove(&field);
    } else {
        entry.insert(field, Value::String(value.trim().to_string()));
    }
    if entry.is_empty() {
        projects.remove(&repo);
    } else {
        projects.insert(repo, Value::Object(entry));
    }
    write_setting("projects".into(), Value::Object(projects))
}

fn desktop_path(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|d| d.join("desktop.json"))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn read_desktop_prefs(app: AppHandle) -> Value {
    desktop_path(&app)
        .ok()
        .and_then(|p| settings::read_object(&p).ok().flatten())
        .map(Value::Object)
        .unwrap_or_else(|| Value::Object(Map::new()))
}

#[tauri::command]
pub fn write_desktop_prefs(app: AppHandle, prefs: Value) -> Result<(), String> {
    settings::write_json(&desktop_path(&app)?, &prefs).map_err(|e| e.to_string())
}

/// A worktree's **Open**, resolved as the TUI's is: the project's
/// `open_command` setting, else the `.nebula.json` "open" (the checkout's,
/// then the main one's), run by the user's shell in the checkout — a login
/// shell, since an app opened from Finder has almost no PATH. Ok(false)
/// when neither sets one, so the caller can fall back to showing the folder.
#[tauri::command]
pub fn open_worktree(path: PathBuf, repo: String) -> Result<bool, String> {
    use nebula_core::project_file::{self, ProjectCommand};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let set = crate::daemon::read_settings()
        .get("projects")
        .and_then(|p| p.get(&repo))
        .and_then(|e| e.get("open_command"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(String::from);
    let command = match set {
        Some(c) => c,
        None => match project_file::lookup(&path, std::path::Path::new(&repo), ProjectCommand::Open)
            .map_err(|e| e.to_string())?
        {
            Some(c) => c,
            None => return Ok(false),
        },
    };
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    Command::new(shell)
        .arg("-lc")
        .arg(&command)
        .current_dir(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .map_err(|e| format!("couldn't run {command}: {e}"))?;
    Ok(true)
}
