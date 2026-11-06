use std::path::PathBuf;
use std::process::Command;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{Emitter, Manager};

/// Read a UTF-8 text file from any path the OS lets us reach.
///
/// QuietPad targets scripts that frequently live outside the user profile
/// (other drives, C:\Scripts, ProgramData, ...), so reads are not constrained
/// by the fs-plugin scope. The picker already gates which path is opened.
#[tauri::command]
fn read_file(path: String) -> Result<OpenedFile, String> {
    let text = std::fs::read_to_string(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let hash = content_hash(text.as_bytes());
    Ok(OpenedFile { text, hash })
}

/// Text plus the content hash of exactly those bytes, so the frontend's
/// change-detection baseline matches what it loaded (no read/hash race).
#[derive(serde::Serialize)]
struct OpenedFile {
    text: String,
    hash: String,
}

/// Content hash ("<len>:<siphash>"). Compares bytes like the old full-text
/// check (reliable for live logs) but only a short string crosses the IPC
/// bridge, so polling a 30 MB file no longer freezes the UI.
fn content_hash(bytes: &[u8]) -> String {
    use std::hash::Hasher;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hasher.write(bytes);
    format!("{}:{:016x}", bytes.len(), hasher.finish())
}

/// Hash the file's current bytes on disk (see `content_hash`).
#[tauri::command]
fn file_hash(path: String) -> Result<String, String> {
    let bytes = std::fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(content_hash(&bytes))
}

/// One batch of a large file, for the read-only excerpt view.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Chunk {
    text: String,
    next_offset: u64,
    eof: bool,
    file_size: u64,
}

/// Read up to `max_lines` lines (or `max_bytes`, whichever comes first) from
/// byte `offset`. Cuts after a newline when it can, otherwise on a UTF-8
/// boundary, so consecutive chunks concatenate to the exact file text.
/// Never touches the rest of the file, so opening a 2 GB file is instant.
#[tauri::command]
fn read_chunk(path: String, offset: u64, max_lines: usize, max_bytes: usize) -> Result<Chunk, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
    let file_size = file.metadata().map_err(|e| e.to_string())?.len();
    file.seek(SeekFrom::Start(offset)).map_err(|e| e.to_string())?;
    let mut buf = Vec::with_capacity(max_bytes.min(file_size.saturating_sub(offset) as usize));
    file.take(max_bytes as u64).read_to_end(&mut buf).map_err(|e| e.to_string())?;
    let reached_end = offset + buf.len() as u64 >= file_size;

    let mut cut = buf.len();
    let mut lines = 0;
    let mut cut_on_line = false;
    for (i, b) in buf.iter().enumerate() {
        if *b == b'\n' {
            lines += 1;
            if lines >= max_lines {
                cut = i + 1;
                cut_on_line = true;
                break;
            }
        }
    }
    if !cut_on_line && !reached_end {
        // Byte cap hit mid-line: prefer the last whole line, else (one huge
        // line) back off to a UTF-8 character boundary.
        if let Some(pos) = buf.iter().rposition(|b| *b == b'\n') {
            cut = pos + 1;
        } else {
            while cut > 0 && (buf[cut - 1] & 0b1100_0000) == 0b1000_0000 {
                cut -= 1;
            }
            if cut > 0 && buf[cut - 1] >= 0b1100_0000 {
                cut -= 1; // drop the lead byte of the split character too
            }
        }
    }
    buf.truncate(cut);
    let next_offset = offset + cut as u64;
    Ok(Chunk {
        text: String::from_utf8_lossy(&buf).into_owned(),
        next_offset,
        eof: next_offset >= file_size,
        file_size,
    })
}

#[derive(serde::Serialize)]
struct FileFacts {
    size: u64,
    lines: u64,
}

/// Count lines in the background (about a second per GB) for the facts bar.
#[tauri::command]
async fn file_facts(path: String) -> Result<FileFacts, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;
        let mut file = std::fs::File::open(&path).map_err(|e| format!("Could not open {path}: {e}"))?;
        let size = file.metadata().map_err(|e| e.to_string())?.len();
        let mut buf = vec![0u8; 1 << 20];
        let mut lines = 0u64;
        let mut last = b'\n';
        loop {
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            lines += buf[..n].iter().filter(|b| **b == b'\n').count() as u64;
            last = buf[n - 1];
        }
        if size > 0 && last != b'\n' {
            lines += 1;
        }
        Ok(FileFacts { size, lines })
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write a UTF-8 text file to any path the OS lets us reach. Returns the
/// content hash of what was written.
#[tauri::command]
fn write_file(path: String, contents: String) -> Result<String, String> {
    std::fs::write(&path, contents.as_bytes()).map_err(|e| format!("Could not save {path}: {e}"))?;
    Ok(content_hash(contents.as_bytes()))
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

/// Locate a Chromium-family browser (Edge/Chrome/Chromium/Brave) for headless
/// PDF export. `--headless ... --print-to-pdf` is identical across them.
fn find_chromium_browser() -> Option<PathBuf> {
    let candidates: &[&str] = &[
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    ];
    candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
        .or_else(|| {
            let names = ["msedge", "chrome", "chromium", "brave"];
            let path_var = std::env::var_os("PATH")?;
            names.iter().find_map(|name| {
                std::env::split_paths(&path_var)
                    .map(|dir| dir.join(format!("{name}.exe")))
                    .find(|candidate| candidate.is_file())
            })
        })
}

/// Render an HTML document to PDF by driving a headless Chromium browser.
/// Paper size (A4) and margins are set via CSS `@page` in the HTML itself,
/// which is the only reliable way to control them through `--print-to-pdf`.
#[tauri::command]
fn export_pdf(target_path: String, html: String) -> Result<(), String> {
    let browser = find_chromium_browser().ok_or_else(|| {
        "PDF export needs Microsoft Edge or Google Chrome installed.".to_string()
    })?;

    let temp_dir = std::env::temp_dir();
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let temp_html = temp_dir.join(format!("quietpad-export-{stamp}.html"));
    std::fs::write(&temp_html, html).map_err(|e| e.to_string())?;
    let profile_dir = temp_dir.join("quietpad-export-profile");
    let _ = std::fs::create_dir_all(&profile_dir);

    let normalized = temp_html.to_string_lossy().replace('\\', "/");
    let url = if normalized.starts_with('/') {
        format!("file://{normalized}")
    } else {
        format!("file:///{normalized}")
    };

    // Overwrite any stale output so we can detect a fresh write below.
    let _ = std::fs::remove_file(&target_path);

    let status = Command::new(&browser)
        .arg("--headless=new")
        .arg("--disable-gpu")
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg(format!("--user-data-dir={}", profile_dir.to_string_lossy()))
        .arg("--no-pdf-header-footer")
        .arg("--print-to-pdf-no-header")
        .arg(format!("--print-to-pdf={target_path}"))
        .arg(&url)
        .status()
        .map_err(|e| e.to_string())?;

    // When another browser instance is already running, the launcher hands off
    // and returns immediately while the child writes the PDF a moment later, so
    // wait (briefly) for the file rather than trusting the exit code alone.
    let mut written = false;
    for _ in 0..50 {
        if std::fs::metadata(&target_path).map(|m| m.len() > 0).unwrap_or(false) {
            written = true;
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let _ = std::fs::remove_file(&temp_html);

    if !status.success() && !written {
        return Err("The browser failed to produce the PDF.".to_string());
    }
    if !written {
        return Err("PDF export timed out.".to_string());
    }
    Ok(())
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
            file_hash,
            file_signature,
            read_chunk,
            file_facts,
            take_launch_file,
            export_pdf
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuietPad");
}
