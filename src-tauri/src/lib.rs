#[tauri::command]
fn open_macos_media_settings(target: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let privacy_pane = match target.as_str() {
            "camera" => "Privacy_Camera",
            "microphone" => "Privacy_Microphone",
            _ => return Err(format!("unsupported media settings target: {target}")),
        };
        let url = format!("x-apple.systempreferences:com.apple.preference.security?{privacy_pane}");
        let status = std::process::Command::new("open")
            .arg(url)
            .status()
            .map_err(|error| format!("failed to open macOS System Settings: {error}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("macOS System Settings exited with status {status}"))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = target;
        Err("macOS media settings are only available on macOS".to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![open_macos_media_settings])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
