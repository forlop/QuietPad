# QuietPad

QuietPad is a small Tauri + CodeMirror text editor for Windows. It stays a plain, fast editor for text and scripts, with a read-only **preview** pane for the formats where rendering helps (Markdown, CSV/TSV, JSON, SVG) and one-click export to PDF/HTML.

The app is shaped so an optional LLM assistant can be added later without turning the editor into an IDE.

## Editor features

- Open, save, and save as
- Dirty-state indicator in the title and toolbar
- Search and replace
- Keyboard shortcuts: Ctrl+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S, Ctrl+F
- Word wrap toggle
- Auto language detection for `.ps1`, `.psm1`, `.psd1`, `.bat`, `.cmd`, `.md`, and `.markdown`
- Manual language override
- Opens files passed by the OS (file associations / "Open with"); single-instance
- Placeholder assistant panel for future endpoint settings

## Preview, paste, and export

- **View** control: Edit / Split / Preview
- Preview renders by file type:
  - Markdown → formatted (markdown-it, KaTeX math, highlight.js code)
  - CSV / TSV → table
  - JSON → collapsible tree
  - SVG → the image
  - anything else → a syntax-highlighted code listing
- **Paste-as-Markdown**: when editing Markdown, rich HTML on the clipboard
  (an AI answer, a web selection) is converted to Markdown source on paste
  (turndown + GFM)
- **Export** the current view to **PDF (A4)** or **HTML**. PDF is produced via
  a headless Microsoft Edge / Chrome; A4 and margins come from CSS `@page`.

## Run

Install dependencies:

```powershell
npm install
```

Start the desktop app:

```powershell
npm run tauri:dev
```

Build a Windows app and refresh the deliverables:

```powershell
./build.ps1
```

`build.ps1` runs `tauri build` and copies the artifacts back into the repo.

### Build directory

The repo lives on Dropbox for cross-machine access, but Dropbox locks files in
`target/` mid-sync and breaks the linker. So the Rust build output goes to a local
disk instead, configured in [`src-tauri/.cargo/config.toml`](src-tauri/.cargo/config.toml)
(default `D:\work\quietpad-target`). On a machine without `D:\work`, edit that path
or delete the file to fall back to the in-tree `./target`.

Deliverables (copied back into the Dropbox-synced repo by `build.ps1`):

- `installers/QuietPad_<ver>_x64-setup.exe` — NSIS installer
- `installers/QuietPad_<ver>_x64_en-US.msi` — MSI installer
- `portable/QuietPad.exe` — portable executable
- `QuietPad_<ver>_x64_portable.zip` — zipped portable bundle

Plain `npm run tauri:build` also works (and uses the same local build dir); it just
leaves the artifacts under the build directory instead of copying them back.

## Later

- Recent files
- Encoding and line-ending preservation
- Multi-tab editing
- OpenAI-compatible assistant endpoint
- Manual completion command for selected text or current cursor context
