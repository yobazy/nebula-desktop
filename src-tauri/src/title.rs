//! Rename (auto): a short title for a task, written by Claude from what the
//! task has been asked and what its terminal last showed.

use std::io::{Read, Write};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const TIMEOUT: Duration = Duration::from_secs(60);
const MAX_TITLE: usize = 60;

const INSTRUCTIONS: &str = "Name this coding-agent task for a sidebar list: 2 to 5 words, \
Title Case, no quotes, no trailing punctuation. Describe what the task is about now, going \
by the latest prompts and output more than the first. Reply with the name only.";

/// `claude -p` on a cheap model, run by a login shell since an app opened
/// from Finder has almost no PATH. No tools, no saved session, no MCP.
fn ask_claude(input: String) -> Result<String, String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let mut child = Command::new(shell)
        .args([
            "-lc",
            r#"exec claude -p --model haiku --tools "" --no-session-persistence --strict-mcp-config"#,
        ])
        .current_dir(std::env::temp_dir())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run claude: {e}"))?;
    let mut stdin = child.stdin.take().expect("piped");
    std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let drain = |mut pipe: Box<dyn Read + Send>| {
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
            None if Instant::now() > deadline => {
                let _ = child.kill();
                return Err("claude took too long to suggest a name".into());
            }
            None => std::thread::sleep(Duration::from_millis(100)),
        }
    };
    let out = String::from_utf8_lossy(&out.join().unwrap_or_default()).into_owned();
    if !status.success() {
        let err = String::from_utf8_lossy(&err.join().unwrap_or_default()).trim().to_string();
        let why = if err.is_empty() { out.trim().to_string() } else { err };
        return Err(format!("claude couldn't suggest a name: {why}"));
    }
    Ok(out)
}

/// The model's reply cut down to one clean title, or None if nothing's left.
fn clean(reply: &str) -> Option<String> {
    let line = reply.lines().map(str::trim).filter(|l| !l.is_empty()).last()?;
    let line = line.trim_matches(|c: char| matches!(c, '"' | '\'' | '`' | '*' | '.' | ':'));
    let title: String = line.split_whitespace().collect::<Vec<_>>().join(" ");
    let title: String = title.chars().take(MAX_TITLE).collect();
    (!title.is_empty()).then_some(title)
}

fn prompt_for(prompts: &[String], output: &str) -> String {
    let mut input = format!("{INSTRUCTIONS}\n\nPrompts, oldest first:\n");
    for p in prompts {
        let p: String = p.chars().take(1_500).collect();
        input.push_str(&format!("- {}\n", p.trim()));
    }
    if !output.trim().is_empty() {
        input.push_str(&format!("\nEnd of the task's terminal output:\n{}\n", output.trim()));
    }
    input
}

#[tauri::command]
pub async fn suggest_title(prompts: Vec<String>, output: String) -> Result<String, String> {
    if prompts.is_empty() && output.trim().is_empty() {
        return Err("Nothing to name it from yet".into());
    }
    let input = prompt_for(&prompts, &output);
    let reply = tauri::async_runtime::spawn_blocking(move || ask_claude(input))
        .await
        .map_err(|e| e.to_string())??;
    clean(&reply).ok_or_else(|| "claude didn't suggest a name".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_replies() {
        assert_eq!(clean("\"Fix Login Redirect.\"\n").as_deref(), Some("Fix Login Redirect"));
        assert_eq!(clean("Sure!\n\n**Auto  Rename Tasks**").as_deref(), Some("Auto Rename Tasks"));
        assert_eq!(clean("  \n"), None);
    }
}
