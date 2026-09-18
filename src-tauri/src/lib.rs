use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager};

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

/// Holds the file path QuietPad was launched with (via file association or
/// "Open with"), until the frontend picks it up on startup.
struct LaunchFile(Mutex<Option<String>>);

/// The frontend calls this once on startup to load any launch file. Returns
/// (and clears) the stored path, so a later reload does not reopen it.
#[tauri::command]
fn take_launch_file(state: tauri::State<LaunchFile>) -> Option<String> {
    state.0.lock().ok().and_then(|mut slot| slot.take())
}

/// Pick the first non-flag argument as a file path (Windows passes the opened
/// file as a bare path; there are no QuietPad flags to skip).
fn file_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<String> {
    args.into_iter().skip(1).find(|a| !a.starts_with('-'))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let launch_file = file_from_args(std::env::args());

    tauri::Builder::default()
        // single-instance must be registered first: a second launch (opening
        // another file) forwards its argv to the running window instead of
        // spawning a duplicate.
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            if let Some(path) = file_from_args(argv) {
                let _ = app.emit("open-file", path);
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(LaunchFile(Mutex::new(launch_file)))
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_signature,
            take_launch_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuietPad");
}
