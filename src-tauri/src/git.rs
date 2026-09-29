//! Where a checkout's code stands: changed files, lines, and commits not yet
//! pushed. The daemon doesn't report any of this (the TUI shells out to git
//! too), so the app asks git directly, off the async runtime.

use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// A git that hangs (a stuck fsmonitor, a lock) is killed rather than left
/// holding the checkout's poll slot forever.
const GIT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// None on a detached HEAD.
    branch: Option<String>,
    /// The commit checked out; None in a repo with no commits yet.
    head: Option<String>,
    /// e.g. `origin/feature`; None when the branch was never pushed.
    upstream: Option<String>,
    /// The upstream is configured but gone from the remote — usually a
    /// merged PR's branch, deleted on merge. git reports no ahead/behind then.
    upstream_gone: bool,
    /// Commits the upstream lacks, and the upstream's commits this lacks.
    ahead: u32,
    behind: u32,
    staged: u32,
    unstaged: u32,
    untracked: u32,
    conflicted: u32,
    /// Tracked lines changed against HEAD (untracked files not counted).
    insertions: u32,
    deletions: u32,
    /// Commits on this branch that `base` lacks, when a base was given.
    base_ahead: Option<u32>,
    last_commit: Option<LastCommit>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LastCommit {
    subject: String,
    /// Unix seconds.
    time: i64,
}

pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String, String> {
    let mut child = Command::new("git")
        .arg("-C")
        .arg(dir)
        // Read-only status must never take the index lock from an agent
        // that is committing in the same checkout.
        .env("GIT_OPTIONAL_LOCKS", "0")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("couldn't run git: {e}"))?;
    // Drain the pipes off-thread so a large output can't stall the child
    // while this thread waits on it.
    let drain = |mut pipe: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = pipe.read_to_end(&mut buf);
            buf
        })
    };
    let out = drain(Box::new(child.stdout.take().expect("piped")));
    let err = drain(Box::new(child.stderr.take().expect("piped")));
    let deadline = Instant::now() + GIT_TIMEOUT;
    let status = loop {
        match child.try_wait().map_err(|e| e.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("git {} timed out", args.first().unwrap_or(&"")));
            }
            None => std::thread::sleep(Duration::from_millis(15)),
        }
    };
    let stdout = out.join().unwrap_or_default();
    if !status.success() {
        let stderr = err.join().unwrap_or_default();
        return Err(String::from_utf8_lossy(&stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// `git status --porcelain=v2 --branch -z`: `# branch.*` headers, then one
/// entry per path. A rename (`2`) carries its original path as an extra
/// NUL-separated field, which is skipped.
fn parse_status(out: &str, s: &mut GitStatus) {
    let mut saw_ab = false;
    let mut fields = out.split('\0');
    while let Some(entry) = fields.next() {
        if let Some(o) = entry.strip_prefix("# branch.oid ") {
            s.head = (o != "(initial)").then(|| o.to_string());
        } else if let Some(h) = entry.strip_prefix("# branch.head ") {
            s.branch = (h != "(detached)").then(|| h.to_string());
        } else if let Some(u) = entry.strip_prefix("# branch.upstream ") {
            s.upstream = Some(u.to_string());
        } else if let Some(ab) = entry.strip_prefix("# branch.ab ") {
            saw_ab = true;
            let mut it = ab.split(' ');
            s.ahead = it.next().and_then(|a| a.trim_start_matches('+').parse().ok()).unwrap_or(0);
            s.behind = it.next().and_then(|b| b.trim_start_matches('-').parse().ok()).unwrap_or(0);
        } else if entry.starts_with("1 ") || entry.starts_with("2 ") {
            let xy = entry.as_bytes().get(2..4).unwrap_or(b"..");
            if xy[0] != b'.' {
                s.staged += 1;
            }
            if xy[1] != b'.' {
                s.unstaged += 1;
            }
            if entry.starts_with("2 ") {
                fields.next();
            }
        } else if entry.starts_with("u ") {
            s.conflicted += 1;
        } else if entry.starts_with("? ") {
            s.untracked += 1;
        }
    }
    s.upstream_gone = s.upstream.is_some() && !saw_ab;
}

/// `git diff --shortstat HEAD`: " 3 files changed, 10 insertions(+), 2 deletions(-)".
fn parse_shortstat(out: &str, s: &mut GitStatus) {
    for part in out.split(',') {
        let part = part.trim();
        let n = part.split(' ').next().and_then(|n| n.parse().ok()).unwrap_or(0);
        if part.contains("insertion") {
            s.insertions = n;
        } else if part.contains("deletion") {
            s.deletions = n;
        }
    }
}

fn status(dir: &Path, base: Option<&str>) -> Result<GitStatus, String> {
    let mut s = GitStatus::default();
    parse_status(&git(dir, &["status", "--porcelain=v2", "--branch", "-z"])?, &mut s);
    // A repo with no commits has no HEAD to diff or log against.
    if let Ok(out) = git(dir, &["diff", "--shortstat", "HEAD"]) {
        parse_shortstat(&out, &mut s);
    }
    if let Ok(out) = git(dir, &["log", "-1", "--format=%ct%x00%s"]) {
        if let Some((time, subject)) = out.trim_end().split_once('\0') {
            s.last_commit = Some(LastCommit {
                subject: subject.to_string(),
                time: time.parse().unwrap_or(0),
            });
        }
    }
    // Only a branch has commits of its own to count; a detached HEAD doesn't.
    let on_branch = s.branch.clone();
    if let Some(base) = base.filter(|b| on_branch.as_deref().is_some_and(|br| br != *b)) {
        let range = format!("{base}..HEAD");
        s.base_ahead = git(dir, &["rev-list", "--count", &range])
            .ok()
            .and_then(|n| n.trim().parse().ok());
    }
    Ok(s)
}

/// Status of the checkout at `path`; `base` is the branch it forked from
/// (the project's main checkout), for "N commits not on main".
#[tauri::command]
pub async fn git_status(path: PathBuf, base: Option<String>) -> Result<GitStatus, String> {
    tauri::async_runtime::spawn_blocking(move || status(&path, base.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// Past this, a diff is cut off: the review pane would choke on it long
/// before anyone read it all.
const MAX_PATCH: usize = 4 * 1024 * 1024;
const MAX_UNTRACKED: usize = 200;
const MAX_UNTRACKED_BYTES: u64 = 256 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UntrackedFile {
    path: String,
    /// None for a binary file or one too big to show.
    text: Option<String>,
    size: u64,
    /// Over the size cap: not read, so not known to be binary.
    too_big: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Diff {
    /// `git diff` output: tracked files only, renames detected.
    patch: String,
    untracked: Vec<UntrackedFile>,
    /// The patch or the untracked list was cut short.
    truncated: bool,
    /// What the patch is against: HEAD, or the merge base with `base`.
    against: String,
}

fn untracked(dir: &Path) -> (Vec<UntrackedFile>, bool) {
    let Ok(out) = git(dir, &["ls-files", "--others", "--exclude-standard", "-z"]) else {
        return (vec![], false);
    };
    let paths: Vec<&str> = out.split('\0').filter(|p| !p.is_empty()).collect();
    let truncated = paths.len() > MAX_UNTRACKED;
    let files = paths
        .into_iter()
        .take(MAX_UNTRACKED)
        .map(|p| {
            let full = dir.join(p);
            let size = std::fs::metadata(&full).map(|m| m.len()).unwrap_or(0);
            let text = (size <= MAX_UNTRACKED_BYTES)
                .then(|| std::fs::read(&full).ok())
                .flatten()
                .filter(|b| !b[..b.len().min(8192)].contains(&0))
                .map(|b| String::from_utf8_lossy(&b).into_owned());
            UntrackedFile { path: p.to_string(), text, size, too_big: size > MAX_UNTRACKED_BYTES }
        })
        .collect();
    (files, truncated)
}

/// Where the branch left `base`: its merge base with the local branch or
/// with `origin/<base>`, whichever is newer — a worktree cut from a fresher
/// origin than the local branch would otherwise count origin's commits as
/// its own.
fn fork_point(dir: &Path, base: &str) -> Result<String, String> {
    let local = git(dir, &["merge-base", base, "HEAD"]).map(|s| s.trim().to_string());
    let remote_ref = format!("refs/remotes/origin/{base}");
    let remote = git(dir, &["rev-parse", "--verify", "--quiet", &remote_ref])
        .and_then(|_| git(dir, &["merge-base", &remote_ref, "HEAD"]))
        .map(|s| s.trim().to_string());
    match (local, remote) {
        (Ok(l), Ok(r)) => {
            // The later of the two: the one the other is an ancestor of.
            let r_newer = git(dir, &["merge-base", "--is-ancestor", &l, &r]).is_ok();
            Ok(if r_newer { r } else { l })
        }
        (Ok(l), Err(_)) => Ok(l),
        (Err(_), Ok(r)) => Ok(r),
        (Err(e), Err(_)) => Err(format!("couldn't find where this branch left {base}: {e}")),
    }
}

fn diff(dir: &Path, base: Option<&str>) -> Result<Diff, String> {
    // The whole branch: everything since it left `base`, committed or not.
    let against = match base {
        Some(b) => fork_point(dir, b)?,
        None => "HEAD".to_string(),
    };
    let mut patch = git(
        dir,
        &[
            // Paths as they are, not octal-escaped, so the view can show them.
            "-c",
            "core.quotePath=false",
            "diff",
            "--no-color",
            "--no-ext-diff",
            "-M",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            &against,
        ],
    )?;
    let mut truncated = false;
    if patch.len() > MAX_PATCH {
        let mut cut = MAX_PATCH;
        while !patch.is_char_boundary(cut) {
            cut -= 1;
        }
        patch.truncate(cut);
        truncated = true;
    }
    let (untracked, more) = untracked(dir);
    Ok(Diff { patch, untracked, truncated: truncated || more, against })
}

/// The changes in the checkout at `path`: uncommitted ones against HEAD, or
/// with `base` the branch's whole change since it forked from it.
#[tauri::command]
pub async fn git_diff(path: PathBuf, base: Option<String>) -> Result<Diff, String> {
    tauri::async_runtime::spawn_blocking(move || diff(&path, base.as_deref()))
        .await
        .map_err(|e| e.to_string())?
}

/// The repo's local branch names, so new ones can steer clear of them.
#[tauri::command]
pub async fn local_branches(repo: PathBuf) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        git(&repo, &["for-each-ref", "--format=%(refname:short)", "refs/heads"])
            .map(|out| out.lines().map(str::to_string).collect())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Delete a local branch after its worktree is gone, as Clean up does.
/// `force` (`-D`) only when the caller knows its work landed — a squash
/// merge leaves it "unmerged" to git; otherwise `-d`, which refuses to lose
/// commits.
#[tauri::command]
pub async fn delete_branch(repo: PathBuf, branch: String, force: bool) -> Result<(), String> {
    if branch.starts_with('-') {
        return Err(format!("refusing to delete a branch named {branch}"));
    }
    let flag = if force { "-D" } else { "-d" };
    tauri::async_runtime::spawn_blocking(move || git(&repo, &["branch", flag, &branch]).map(|_| ()))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_porcelain_v2() {
        let out = "# branch.oid abc\0# branch.head feat\0# branch.upstream origin/feat\0# branch.ab +2 -1\0\
                   1 M. N... 100644 100644 100644 a b src/a.rs\0\
                   1 .M N... 100644 100644 100644 a b src/b.rs\0\
                   2 R. N... 100644 100644 100644 a b R100 new.rs\0old.rs\0\
                   u UU N... 1 2 3 4 a b c x.rs\0? notes.txt\0";
        let mut s = GitStatus::default();
        parse_status(out, &mut s);
        assert_eq!(s.branch.as_deref(), Some("feat"));
        assert_eq!(s.upstream.as_deref(), Some("origin/feat"));
        assert_eq!((s.ahead, s.behind), (2, 1));
        assert_eq!((s.staged, s.unstaged, s.untracked, s.conflicted), (2, 1, 1, 1));
        assert!(!s.upstream_gone);
    }

    #[test]
    fn upstream_without_ahead_behind_is_gone() {
        let mut s = GitStatus::default();
        parse_status("# branch.head feat\0# branch.upstream origin/feat\0", &mut s);
        assert!(s.upstream_gone);
        let mut s = GitStatus::default();
        parse_status("# branch.head feat\0", &mut s);
        assert!(!s.upstream_gone);
    }

    #[test]
    fn parses_shortstat() {
        let mut s = GitStatus::default();
        parse_shortstat(" 3 files changed, 10 insertions(+), 2 deletions(-)\n", &mut s);
        assert_eq!((s.insertions, s.deletions), (10, 2));
        parse_shortstat(" 1 file changed, 4 deletions(-)\n", &mut s);
        assert_eq!(s.deletions, 4);
    }

    #[test]
    fn diffs_a_real_checkout() {
        let dir = std::env::temp_dir().join(format!("nebula-diff-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let run = |args: &[&str]| git(&dir, args).unwrap();
        run(&["init", "-q", "-b", "main"]);
        run(&["config", "user.email", "t@example.com"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(dir.join("a.txt"), "one\ntwo\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-qm", "first"]);
        run(&["checkout", "-qb", "feat"]);
        std::fs::write(dir.join("a.txt"), "one\n2\n").unwrap();
        run(&["commit", "-qam", "second"]);
        std::fs::write(dir.join("a.txt"), "one\n2\nthree\n").unwrap();
        std::fs::write(dir.join("new.txt"), "hi\n").unwrap();
        std::fs::write(dir.join("bin.dat"), [0u8, 1, 2]).unwrap();

        let d = diff(&dir, None).unwrap();
        assert_eq!(d.against, "HEAD");
        assert!(d.patch.contains("+three") && !d.patch.contains("-two"));
        let names: Vec<_> = d.untracked.iter().map(|u| (u.path.as_str(), u.text.is_some())).collect();
        assert!(names.contains(&("new.txt", true)) && names.contains(&("bin.dat", false)));

        let d = diff(&dir, Some("main")).unwrap();
        assert!(d.patch.contains("-two") && d.patch.contains("+three"));
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
