//! Getting nebula itself in place, so the app can be the whole install: find
//! the `nebula` binary, report its version against the one this app is built
//! for, and install that exact release when it's missing or older — from
//! the same release files nebula's own install.sh downloads.

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The nebula release this app speaks to (the nebula-core tag, via build.rs).
pub const PIN: &str = env!("NEBULA_PIN");

fn home() -> PathBuf {
    PathBuf::from(std::env::var_os("HOME").unwrap_or_default())
}

/// Where nebula's installer puts the binary, and where this app does.
fn install_dir() -> PathBuf {
    std::env::var_os("NEBULA_INSTALL_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".local/bin"))
}

/// The `nebula` a login shell would run, else one in the usual install
/// places: an app opened from Finder has almost no PATH of its own.
pub fn find() -> Option<PathBuf> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let from_shell = Command::new(shell)
        .args(["-l", "-c", "command -v nebula"])
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| PathBuf::from(String::from_utf8_lossy(&o.stdout).trim()))
        .filter(|p| p.is_absolute() && p.exists());
    from_shell.or_else(|| {
        [
            install_dir().join("nebula"),
            home().join(".cargo/bin/nebula"),
            PathBuf::from("/opt/homebrew/bin/nebula"),
            PathBuf::from("/usr/local/bin/nebula"),
        ]
        .into_iter()
        .find(|p| p.exists())
    })
}

fn version_of(bin: &Path) -> Option<String> {
    let out = Command::new(bin).arg("--version").output().ok()?;
    // "nebula 0.40.2"
    String::from_utf8_lossy(&out.stdout)
        .split_whitespace()
        .nth(1)
        .map(String::from)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NebulaStatus {
    /// The version this app needs.
    pinned: String,
    path: Option<String>,
    version: Option<String>,
}

#[tauri::command]
pub async fn nebula_status() -> NebulaStatus {
    tauri::async_runtime::spawn_blocking(|| {
        let path = find();
        let version = path.as_deref().and_then(version_of);
        NebulaStatus {
            pinned: PIN.into(),
            path: path.map(|p| p.display().to_string()),
            version,
        }
    })
    .await
    .unwrap_or(NebulaStatus { pinned: PIN.into(), path: None, version: None })
}

fn target() -> Result<&'static str, String> {
    match std::env::consts::ARCH {
        "aarch64" => Ok("aarch64-apple-darwin"),
        "x86_64" => Ok("x86_64-apple-darwin"),
        other => Err(format!("no nebula build for {other}")),
    }
}

/// Download nebula `PIN` for this Mac and install it into `dir`.
fn install_into(dir: &Path) -> Result<PathBuf, String> {
    let url = format!(
        "https://github.com/AgentSystemLabs/nebula/releases/download/v{PIN}/nebula-{}.tar.gz",
        target()?
    );
    let tmp = std::env::temp_dir().join(format!("nebula-install-{}", std::process::id()));
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let tarball = tmp.join("nebula.tar.gz");
    let run = |cmd: &mut Command, what: &str| -> Result<(), String> {
        let out = cmd.output().map_err(|e| format!("couldn't {what}: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(format!("couldn't {what}: {}", String::from_utf8_lossy(&out.stderr).trim()))
        }
    };
    let result = (|| {
        run(Command::new("curl").args(["-fsSL", "-o"]).arg(&tarball).arg(&url), "download nebula")?;
        run(Command::new("tar").arg("-xzf").arg(&tarball).arg("-C").arg(&tmp), "unpack nebula")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let dest = dir.join("nebula");
        // Replace by rename, so a running daemon keeps its old binary intact.
        let staged = dir.join(".nebula.new");
        std::fs::copy(tmp.join("nebula"), &staged).map_err(|e| e.to_string())?;
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o755))
                .map_err(|e| e.to_string())?;
        }
        std::fs::rename(&staged, &dest).map_err(|e| e.to_string())?;
        Ok(dest)
    })();
    let _ = std::fs::remove_dir_all(&tmp);
    result
}

#[tauri::command]
pub async fn install_nebula() -> Result<NebulaStatus, String> {
    let dest = tauri::async_runtime::spawn_blocking(|| install_into(&install_dir()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(NebulaStatus {
        pinned: PIN.into(),
        version: version_of(&dest),
        path: Some(dest.display().to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pin_is_a_version() {
        assert!(PIN.split('.').count() == 3 && PIN.split('.').all(|n| n.parse::<u32>().is_ok()), "{PIN}");
    }

    /// Downloads a real release: `cargo test -- --ignored installs_the_pinned_release`.
    #[test]
    #[ignore]
    fn installs_the_pinned_release() {
        let dir = std::env::temp_dir().join("nebula-install-test");
        let _ = std::fs::remove_dir_all(&dir);
        let bin = install_into(&dir).unwrap();
        assert_eq!(version_of(&bin).as_deref(), Some(PIN));
    }
}
