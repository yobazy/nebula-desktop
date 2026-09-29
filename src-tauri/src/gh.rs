//! The pull request on a checkout's branch, through the GitHub CLI, as the
//! TUI finds it (`nebula-tui/src/pull_request.rs`): `gh pr view` in the
//! checkout. `gh` missing, signed out or pointed at a repo with no GitHub
//! remote is an ordinary "couldn't ask", not an error to flash.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

/// `gh` retries and can hang on a stalled network; a band's PR line isn't
/// worth a lookup that never ends.
const TIMEOUT: Duration = Duration::from_secs(20);

/// The `gh` a login shell would run, else one in the usual places: an app
/// opened from Finder has almost no PATH of its own. Resolved once.
fn gh_path() -> Option<&'static Path> {
    static GH: OnceLock<Option<PathBuf>> = OnceLock::new();
    GH.get_or_init(|| {
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
        Command::new(shell)
            .args(["-l", "-c", "command -v gh"])
            .stdin(Stdio::null())
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
            .filter(|p| p.is_absolute() && p.exists())
            .or_else(|| {
                ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]
                    .into_iter()
                    .map(PathBuf::from)
                    .find(|p| p.exists())
            })
    })
    .as_deref()
}

/// Run `gh` in `dir`: stdout, or stderr on a bad exit.
fn gh(dir: &Path, args: &[&str]) -> Result<String, String> {
    let bin = gh_path().ok_or("The GitHub CLI (gh) isn't installed")?;
    let mut child = Command::new(bin)
        .args(args)
        .current_dir(dir)
        // Never stop to ask: there's no terminal to answer it in.
        .env("GH_PROMPT_DISABLED", "1")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run gh: {e}"))?;
    let drain = |mut pipe: Box<dyn std::io::Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    };
    let out = drain(Box::new(child.stdout.take().expect("piped")));
    let err = drain(Box::new(child.stderr.take().expect("piped")));
    let deadline = Instant::now() + TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("gh took too long to answer".into());
            }
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    if !status.success() {
        let stderr = String::from_utf8_lossy(&err.join().unwrap_or_default()).trim().to_string();
        return Err(if stderr.is_empty() { stdout.trim().to_string() } else { stderr });
    }
    Ok(stdout)
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum PrLookup {
    /// `gh pr view`'s JSON, folded in the webview (prs.ts).
    Found { pr: serde_json::Value },
    /// The branch has no pull request.
    None,
    /// gh can't say: not installed, signed out, no network, no GitHub remote.
    Unavailable { reason: String },
}

fn lookup(dir: &Path) -> PrLookup {
    match gh(
        dir,
        &[
            "pr",
            "view",
            "--json",
            "number,url,title,state,isDraft,mergeable,statusCheckRollup,reviewDecision,headRefName,headRefOid",
        ],
    ) {
        Ok(out) => match serde_json::from_str(&out) {
            Ok(pr) => PrLookup::Found { pr },
            Err(e) => PrLookup::Unavailable { reason: e.to_string() },
        },
        Err(e) if e.contains("no pull requests found") => PrLookup::None,
        Err(reason) => PrLookup::Unavailable { reason },
    }
}

#[tauri::command]
pub async fn gh_pr(path: PathBuf) -> PrLookup {
    tauri::async_runtime::spawn_blocking(move || lookup(&path))
        .await
        .unwrap_or_else(|e| PrLookup::Unavailable { reason: e.to_string() })
}

/// Open a pull request for the checkout's (pushed) branch, titled and
/// described from its commits. Resolves with its URL.
#[tauri::command]
pub async fn gh_pr_create(path: PathBuf, draft: bool) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut args = vec!["pr", "create", "--fill"];
        if draft {
            args.push("--draft");
        }
        let out = gh(&path, &args)?;
        out.lines()
            .map(str::trim)
            .rev()
            .find(|l| l.starts_with("https://"))
            .map(String::from)
            .ok_or_else(|| format!("gh didn't say where the pull request is: {}", out.trim()))
    })
    .await
    .map_err(|e| e.to_string())?
}
