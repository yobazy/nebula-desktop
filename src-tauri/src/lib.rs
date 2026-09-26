mod daemon;
mod git;
mod icons;
mod nebula_setup;
mod settings;
mod usage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
