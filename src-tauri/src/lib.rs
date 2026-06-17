use std::time::UNIX_EPOCH;

/// Read a UTF-8 text file from any path the OS lets us reach.
///
/// QuietPad targets scripts that frequently live outside the user profile
/// (other drives, C:\Scripts, ProgramData, ...), so reads are not constrained
/// by the fs-plugin scope. The picker already gates which path is opened.
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Could not open {path}: {e}"))
}

/// Write a UTF-8 text file to any path the OS lets us reach.
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Could not save {path}: {e}"))
}

/// Return a cheap change signature ("<mtime_millis>:<size>") used to detect
/// external edits. Errors propagate so the caller can stop polling a vanished file.
#[tauri::command]
fn file_signature(path: String) -> Result<String, String> {
    let meta = std::fs::metadata(&path).map_err(|e| format!("Could not stat {path}: {e}"))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0);
    Ok(format!("{mtime}:{}", meta.len()))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_signature
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuietPad");
}
