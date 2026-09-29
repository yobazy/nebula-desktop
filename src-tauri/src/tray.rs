//! The menu bar icon: how many tasks are waiting on you (as its title) and
//! a menu to jump to one, so the window can be closed and the app still
//! says when something needs you. The webview owns the state and sends it
//! here on every change (`update_tray`); a pick goes back as an event.

use serde::Deserialize;
use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

pub const OPEN_AGENT: &str = "nebula://open-agent";
pub const QUICK_CAPTURE: &str = "nebula://quick-capture";
const TRAY_ID: &str = "main";

#[derive(Deserialize)]
pub struct TrayTask {
    id: String,
    label: String,
}

#[derive(Deserialize)]
pub struct TrayState {
    waiting: Vec<TrayTask>,
    working: u32,
}

/// Bring the main window back, from the tray, the dock or a hotkey.
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn menu(app: &AppHandle, state: Option<&TrayState>) -> tauri::Result<Menu<Wry>> {
    let menu = Menu::new(app)?;
    match state {
        Some(s) if !s.waiting.is_empty() => {
            let head = MenuItem::with_id(app, "head", format!("Waiting on you ({})", s.waiting.len()), false, None::<&str>)?;
            menu.append(&head)?;
            for t in s.waiting.iter().take(12) {
                let item = MenuItem::with_id(app, format!("agent:{}", t.id), &t.label, true, None::<&str>)?;
                menu.append(&item)?;
            }
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
        _ => {
            let idle = MenuItem::with_id(app, "head", "Nothing waiting on you", false, None::<&str>)?;
            menu.append(&idle)?;
            menu.append(&PredefinedMenuItem::separator(app)?)?;
        }
    }
    if let Some(s) = state.filter(|s| s.working > 0) {
        let n = s.working;
        let working = MenuItem::with_id(app, "working", format!("{n} {} working", if n == 1 { "task" } else { "tasks" }), false, None::<&str>)?;
        menu.append(&working)?;
        menu.append(&PredefinedMenuItem::separator(app)?)?;
    }
    menu.append(&MenuItem::with_id(app, "capture", "New task…", true, None::<&str>)?)?;
    menu.append(&MenuItem::with_id(app, "show", "Show Nebula", true, None::<&str>)?)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&MenuItem::with_id(app, "quit", "Quit Nebula", true, None::<&str>)?)?;
    Ok(menu)
}

pub fn install(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let icon = Image::from_bytes(include_bytes!("../icons/tray.png"))?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Nebula")
        .menu(&menu(app, None)?)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            if let Some(agent) = id.strip_prefix("agent:") {
                show_main(app);
                let _ = app.emit(OPEN_AGENT, agent.to_string());
            } else if id == "capture" {
                show_main(app);
                let _ = app.emit(QUICK_CAPTURE, ());
            } else if id == "show" {
                show_main(app);
            } else if id == "quit" {
                app.exit(0);
            }
        })
        .build(app)
}

#[tauri::command]
pub fn update_tray(app: AppHandle, state: TrayState) -> Result<(), String> {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return Ok(());
    };
    let n = state.waiting.len();
    tray.set_title(if n > 0 { Some(n.to_string()) } else { None::<String> })
        .map_err(|e| e.to_string())?;
    let tip = match (n, state.working) {
        (0, 0) => "Nebula".to_string(),
        (0, w) => format!("Nebula: {w} working"),
        (n, 0) => format!("Nebula: {n} waiting on you"),
        (n, w) => format!("Nebula: {n} waiting on you, {w} working"),
    };
    tray.set_tooltip(Some(tip)).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu(&app, Some(&state)).map_err(|e| e.to_string())?))
        .map_err(|e| e.to_string())
}
