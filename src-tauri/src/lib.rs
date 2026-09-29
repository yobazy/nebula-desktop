mod daemon;
mod editor;
mod gh;
mod git;
mod icons;
mod nebula_setup;
mod settings;
mod title;
mod tray;
mod usage;

/// Show and focus the main window, e.g. for the quick-capture hotkey.
#[tauri::command]
fn show_main_window(app: tauri::AppHandle) {
    tray::show_main(&app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .setup(|app| {
            tray::install(app.handle())?;
            Ok(())
        })
        .manage(daemon::DaemonState::default())
        .manage(usage::UsageState::default())
        .invoke_handler(tauri::generate_handler![
            daemon::connect,
            daemon::send,
            daemon::send_input,
            daemon::start_daemon,
            daemon::read_settings,
            daemon::read_presets,
            daemon::debug_log,
            daemon::inspect_folder,
            git::git_status,
            git::git_diff,
            git::delete_branch,
            git::local_branches,
            gh::gh_pr,
            gh::gh_pr_create,
            usage::usage_report,
            settings::write_setting,
            settings::write_project_setting,
            settings::read_desktop_prefs,
            settings::write_desktop_prefs,
            settings::open_worktree,
            nebula_setup::nebula_status,
            nebula_setup::install_nebula,
            icons::read_icon,
            icons::project_logo,
            title::suggest_title,
            tray::update_tray,
            editor::list_editors,
            editor::open_in_editor,
            show_main_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Clicking the dock icon brings back a window closed to the menu bar.
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { .. } = event {
                tray::show_main(app);
            }
            let _ = (app, event);
        });
}
