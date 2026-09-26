//! Project icons: images turned into data URLs the webview can show (it has
//! no access to arbitrary files), and a repo's own logo found where web and
//! app projects usually keep one.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use std::path::{Path, PathBuf};

/// Big enough for any sane icon, small enough to keep in the prefs file.
const MAX_BYTES: u64 = 512 * 1024;

/// Where projects tend to keep a logo, most specific first.
const CANDIDATES: &[&str] = &[
    "icon.svg",
    "logo.svg",
    "public/favicon.svg",
    "public/logo.svg",
    "public/icon.svg",
    "static/favicon.svg",
    "app/icon.svg",
    "src/app/icon.svg",
    "assets/icon.png",
    "assets/logo.png",
    "icon.png",
    "logo.png",
    "app/icon.png",
    "src/app/icon.png",
    "public/logo.png",
    "public/icon.png",
    "public/apple-touch-icon.png",
    "public/favicon.png",
    "static/favicon.png",
    "src-tauri/icons/icon.png",
    "public/favicon.ico",
    "static/favicon.ico",
    "app/favicon.ico",
    "src/app/favicon.ico",
    "favicon.ico",
];

fn mime(path: &Path) -> Option<&'static str> {
    match path.extension()?.to_str()?.to_ascii_lowercase().as_str() {
        "svg" => Some("image/svg+xml"),
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

fn data_url(path: &Path) -> Result<String, String> {
    let kind = mime(path).ok_or("that isn't an image this app can show (png, jpg, gif, webp, svg or ico)")?;
    let len = std::fs::metadata(path).map_err(|e| e.to_string())?.len();
    if len > MAX_BYTES {
        return Err(format!("that image is {} KB; icons can be up to {} KB", len / 1024, MAX_BYTES / 1024));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    Ok(format!("data:{kind};base64,{}", B64.encode(bytes)))
}

/// A picked image, ready to show and to keep in the prefs.
#[tauri::command]
pub fn read_icon(path: PathBuf) -> Result<String, String> {
    data_url(&path)
}

/// The repo's own logo, if it keeps one in a usual place.
#[tauri::command]
pub fn project_logo(repo: PathBuf) -> Option<String> {
    CANDIDATES
        .iter()
        .map(|c| repo.join(c))
        .find(|p| p.is_file() && data_url(p).is_ok())
        .and_then(|p| data_url(&p).ok())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_most_specific_logo() {
        let repo = std::env::temp_dir().join(format!("icons-test-{}", std::process::id()));
        std::fs::create_dir_all(repo.join("public")).unwrap();
        std::fs::write(repo.join("public/favicon.ico"), b"ico").unwrap();
        std::fs::write(repo.join("public/favicon.svg"), b"<svg/>").unwrap();
        let url = project_logo(repo.clone()).unwrap();
        assert!(url.starts_with("data:image/svg+xml;base64,"), "{url}");
        std::fs::remove_dir_all(&repo).unwrap();
        assert!(project_logo(repo).is_none());
    }

    #[test]
    fn refuses_what_it_cant_show() {
        assert!(read_icon(PathBuf::from("/etc/hosts")).is_err());
    }
}
