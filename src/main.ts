import "./styles.css";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorState, Compartment, Extension, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  findNext,
  findPrevious,
  replaceAll,
  replaceNext,
  search,
  setSearchQuery,
  SearchQuery
} from "@codemirror/search";
import { HighlightStyle, StreamLanguage, syntaxHighlighting } from "@codemirror/language";
import { markdown } from "@codemirror/lang-markdown";
import { tags as t } from "@lezer/highlight";

type LanguageId = "auto" | "text" | "powershell" | "batch" | "markdown";
type UnsavedChoice = "save" | "discard" | "cancel";

const editorHost = document.querySelector<HTMLDivElement>("#editor")!;
const fileName = document.querySelector<HTMLSpanElement>("#file-name")!;
const statusLeft = document.querySelector<HTMLSpanElement>("#status-left")!;
const statusRight = document.querySelector<HTMLSpanElement>("#status-right")!;
const reloadExternal = document.querySelector<HTMLButtonElement>("#reload-external")!;
const ignoreExternal = document.querySelector<HTMLButtonElement>("#ignore-external")!;
const languageSelect = document.querySelector<HTMLSelectElement>("#language-select")!;
const wrapToggle = document.querySelector<HTMLInputElement>("#wrap-toggle")!;
const findPanel = document.querySelector<HTMLElement>("#find-panel")!;
const findInput = document.querySelector<HTMLInputElement>("#find-input")!;
const replaceInput = document.querySelector<HTMLInputElement>("#replace-input")!;
const assistantPanel = document.querySelector<HTMLElement>("#assistant-panel")!;
const assistantToggle = document.querySelector<HTMLButtonElement>("#assistant-toggle")!;
const themeToggle = document.querySelector<HTMLButtonElement>("#theme-toggle")!;
const modalOverlay = document.querySelector<HTMLDivElement>("#modal-overlay")!;
const modalTitle = document.querySelector<HTMLParagraphElement>("#modal-title")!;
const modalSave = document.querySelector<HTMLButtonElement>("#modal-save")!;
const modalDiscard = document.querySelector<HTMLButtonElement>("#modal-discard")!;
const modalCancel = document.querySelector<HTMLButtonElement>("#modal-cancel")!;

const languageCompartment = new Compartment();
const wrapCompartment = new Compartment();
const appWindow = getCurrentWindow();
const setFindText = StateEffect.define<string>();

let currentPath: string | null = null;
let cleanText = "";
let chosenLanguage: LanguageId = "auto";
let theme: "dark" | "light" = "dark";
let closeConfirmed = false;
let lastDiskSignature: string | null = null;
let changedDiskSignature: string | null = null;
let ignoredDiskSignature: string | null = null;
let errorMessage: string | null = null;
let errorTimer: number | null = null;

const quietHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: "var(--syntax-comment)", fontStyle: "italic" },
  { tag: t.keyword, color: "var(--syntax-keyword)" },
  { tag: t.operatorKeyword, color: "var(--syntax-keyword)" },
  { tag: t.string, color: "var(--syntax-string)" },
  { tag: t.number, color: "var(--syntax-number)" },
  { tag: t.bool, color: "var(--syntax-number)" },
  { tag: t.variableName, color: "var(--syntax-variable)" },
  { tag: t.definition(t.variableName), color: "var(--syntax-variable)" },
  { tag: t.function(t.variableName), color: "var(--syntax-function)" },
  { tag: t.definition(t.function(t.variableName)), color: "var(--syntax-function)" },
  { tag: t.labelName, color: "var(--syntax-label)" },
  { tag: t.attributeName, color: "var(--syntax-property)" },
  { tag: t.propertyName, color: "var(--syntax-property)" },
  { tag: t.heading, color: "var(--syntax-heading)", fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.link, color: "var(--syntax-function)", textDecoration: "underline" },
  { tag: t.monospace, color: "var(--syntax-label)" }
]);

const powershellLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/#.*/)) return "comment";
    if (stream.match(/"(?:[^"`]|`.)*"?/) || stream.match(/'(?:[^']|'')*'?/)) return "string";
    if (stream.match(/\$[a-zA-Z_][\w:]*/)) return "variableName";
    if (stream.match(/-[a-zA-Z][\w-]*/)) return "attribute";
    if (stream.match(/\b(function|param|process|begin|end|if|else|elseif|foreach|for|while|switch|try|catch|finally|return|class|using|in|throw|break|continue)\b/i)) return "keyword";
    if (stream.match(/\b(?:[A-Za-z]+)-[A-Za-z][\w-]*/)) return "def";
    if (stream.match(/\b\d+(?:\.\d+)?\b/)) return "number";
    stream.next();
    return null;
  }
});

const batchLanguage = StreamLanguage.define({
  token(stream, state: { lineStart?: boolean }) {
    if (stream.sol()) state.lineStart = true;
    if (stream.eatSpace()) return null;
    if (state.lineStart && stream.match(/(?:::|rem\b).*/i)) return "comment";
    state.lineStart = false;
    if (stream.match(/"(?:[^"]|"")*"?/)) return "string";
    if (stream.match(/%[A-Za-z_][\w]*%|![A-Za-z_][\w]*!/)) return "variableName";
    if (stream.match(/\b(echo|set|setlocal|endlocal|if|else|for|in|do|goto|call|exit|shift|pause|pushd|popd|cd|dir|copy|xcopy|robocopy|move|del|rmdir|mkdir|start)\b/i)) return "keyword";
    if (stream.match(/:[A-Za-z_][\w.-]*/)) return "labelName";
    if (stream.match(/\b\d+\b/)) return "number";
    stream.next();
    return null;
  },
  startState: () => ({ lineStart: true })
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// CodeMirror's native .cm-searchMatch highlighting only renders while its own
// search panel is open, but QuietPad hides that panel and uses a custom find bar.
// So we decorate every match of the query ourselves to keep matches visible.
const matchMark = Decoration.mark({ class: "quiet-search-match" });
const currentMatchMark = Decoration.mark({ class: "quiet-search-match quiet-search-match-current" });

function buildFindDecorations(state: EditorState, query: string): DecorationSet {
  const trimmed = query.trim();
  if (!trimmed) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const text = state.doc.toString();
  // findNext/findPrevious move the selection onto the active match, so the match
  // whose range equals the current selection is the one the user is sitting on.
  const sel = state.selection.main;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    const from = match.index;
    const to = from + match[0].length;
    const isCurrent = from === sel.from && to === sel.to;
    builder.add(from, to, isCurrent ? currentMatchMark : matchMark);
  }
  return builder.finish();
}

const findHighlightField = StateField.define<{ query: string; decorations: DecorationSet }>({
  create: (state) => ({ query: "", decorations: buildFindDecorations(state, "") }),
  update(value, transaction) {
    let query = value.query;
    for (const effect of transaction.effects) {
      if (effect.is(setFindText)) query = effect.value;
    }
    if (transaction.docChanged || transaction.selection || query !== value.query) {
      return { query, decorations: buildFindDecorations(transaction.state, query) };
    }
    return value;
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations)
});

function baseExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    highlightActiveLine(),
    syntaxHighlighting(quietHighlightStyle, { fallback: true }),
    findHighlightField,
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) updateDirtyState();
      if (update.selectionSet || update.docChanged) updateCursorStatus();
    }),
    languageCompartment.of(languageExtension()),
    wrapCompartment.of(EditorView.lineWrapping)
  ];
}

const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: "",
    extensions: baseExtensions()
  })
});

function languageExtension(): Extension {
  const language = chosenLanguage === "auto" ? detectLanguage(currentPath) : chosenLanguage;
  if (language === "markdown") return markdown();
  if (language === "powershell") return powershellLanguage;
  if (language === "batch") return batchLanguage;
  return [];
}

function detectLanguage(path: string | null): Exclude<LanguageId, "auto"> {
  const lower = path?.toLowerCase() ?? "";
  if (lower.endsWith(".ps1") || lower.endsWith(".psm1") || lower.endsWith(".psd1")) return "powershell";
  if (lower.endsWith(".bat") || lower.endsWith(".cmd")) return "batch";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  return "text";
}

function replaceDocument(text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 }
  });
  cleanText = currentText();
  updateDirtyState();
  updateCursorStatus();
}

function clearExternalChangeWarning() {
  changedDiskSignature = null;
  ignoredDiskSignature = null;
  renderStatus();
}

function showError(message: string) {
  errorMessage = message;
  if (errorTimer !== null) window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(() => {
    errorMessage = null;
    errorTimer = null;
    renderStatus();
  }, 6000);
  renderStatus();
}

function clearError() {
  if (errorMessage === null) return;
  errorMessage = null;
  if (errorTimer !== null) {
    window.clearTimeout(errorTimer);
    errorTimer = null;
  }
}

function renderStatus() {
  statusLeft.classList.toggle("status-error", errorMessage !== null);
  if (errorMessage) {
    statusLeft.textContent = errorMessage;
    reloadExternal.hidden = true;
    ignoreExternal.hidden = true;
    return;
  }
  if (changedDiskSignature) {
    statusLeft.textContent = "File changed on disk";
    reloadExternal.hidden = false;
    ignoreExternal.hidden = false;
    return;
  }
  const dirty = currentText() !== cleanText;
  statusLeft.textContent = dirty ? "Unsaved changes" : currentPath ? "Saved" : "Ready";
  reloadExternal.hidden = true;
  ignoreExternal.hidden = true;
}

function currentText() {
  return view.state.doc.toString();
}

function displayName(path: string | null) {
  if (!path) return "Untitled";
  return path.split(/[\\/]/).pop() || path;
}

function updateDirtyState() {
  const dirty = currentText() !== cleanText;
  fileName.textContent = `${dirty ? "*" : ""}${displayName(currentPath)}`;
  renderStatus();
  document.title = `${dirty ? "*" : ""}${displayName(currentPath)} - QuietPad`;
}

function updateCursorStatus() {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  statusRight.textContent = `Ln ${line.number}, Col ${head - line.from + 1}`;
}

function reconfigureLanguage() {
  view.dispatch({ effects: languageCompartment.reconfigure(languageExtension()) });
}

function setSearch() {
  view.dispatch({
    effects: [
      setSearchQuery.of(new SearchQuery({
        search: findInput.value,
        replace: replaceInput.value,
        caseSensitive: false,
        regexp: false
      })),
      setFindText.of(findInput.value)
    ]
  });
}

// Thin wrappers over the Rust commands. These bypass the fs-plugin scope so
// scripts living outside the user profile (other drives, C:\Scripts, ...) open.
function readFile(path: string) {
  return invoke<string>("read_file", { path });
}

function writeFile(path: string, contents: string) {
  return invoke<void>("write_file", { path, contents });
}

function fileSignature(path: string) {
  return invoke<string>("file_signature", { path });
}

let modalResolver: ((choice: UnsavedChoice) => void) | null = null;

function closeModal(choice: UnsavedChoice) {
  if (!modalResolver) return;
  const resolve = modalResolver;
  modalResolver = null;
  modalOverlay.hidden = true;
  view.focus();
  resolve(choice);
}

function askUnsaved(message: string): Promise<UnsavedChoice> {
  modalTitle.textContent = message;
  modalOverlay.hidden = false;
  modalSave.focus();
  return new Promise((resolve) => {
    modalResolver = resolve;
  });
}

modalSave.addEventListener("click", () => closeModal("save"));
modalDiscard.addEventListener("click", () => closeModal("discard"));
modalCancel.addEventListener("click", () => closeModal("cancel"));
modalOverlay.addEventListener("mousedown", (event) => {
  if (event.target === modalOverlay) closeModal("cancel");
});
modalOverlay.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closeModal("cancel");
  }
});

// Returns true when it is safe to proceed (no changes, saved, or discarded).
async function ensureSaved(message = "You have unsaved changes."): Promise<boolean> {
  if (currentText() === cleanText) return true;
  const choice = await askUnsaved(message);
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  return saveFile(false);
}

async function rememberDiskState(path: string) {
  try {
    lastDiskSignature = await fileSignature(path);
  } catch {
    lastDiskSignature = null;
  }
  changedDiskSignature = null;
  ignoredDiskSignature = null;
  renderStatus();
}

async function checkExternalFileChange() {
  if (!currentPath) return;
  try {
    const signature = await fileSignature(currentPath);
    if (!lastDiskSignature) {
      lastDiskSignature = signature;
      return;
    }
    if (signature !== lastDiskSignature && signature !== ignoredDiskSignature) {
      changedDiskSignature = signature;
      renderStatus();
    }
  } catch {
    return;
  }
}

async function reloadFromDisk() {
  if (!currentPath) return;
  if (currentText() !== cleanText) {
    const choice = await askUnsaved("Reload from disk and discard unsaved changes?");
    if (choice === "cancel") return;
    if (choice === "save") {
      // Saving the buffer is what the user has; there is nothing to reload onto.
      await saveFile(false);
      return;
    }
  }
  try {
    const text = await readFile(currentPath);
    replaceDocument(text);
    await rememberDiskState(currentPath);
    reconfigureLanguage();
  } catch (error) {
    showError(String(error));
  }
}

async function newFile() {
  if (!(await ensureSaved())) return;
  clearError();
  currentPath = null;
  lastDiskSignature = null;
  clearExternalChangeWarning();
  replaceDocument("");
  reconfigureLanguage();
}

async function openFile() {
  if (!(await ensureSaved())) return;
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Text files", extensions: ["txt", "md", "markdown", "ps1", "psm1", "psd1", "bat", "cmd", "json", "log"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (typeof selected !== "string") return;
  try {
    const text = await readFile(selected);
    currentPath = selected;
    clearError();
    replaceDocument(text);
    await rememberDiskState(selected);
    reconfigureLanguage();
  } catch (error) {
    showError(String(error));
  }
}

// Returns true when the file was written, false on cancel or error.
async function saveFile(forcePicker = false): Promise<boolean> {
  let target = currentPath;
  if (!target || forcePicker) {
    const selected = await save({
      defaultPath: currentPath ?? "Untitled.txt",
      filters: [
        { name: "Text files", extensions: ["txt", "md", "ps1", "bat", "cmd"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (!selected) return false;
    target = selected;
  }
  try {
    await writeFile(target, currentText());
  } catch (error) {
    showError(String(error));
    return false;
  }
  currentPath = target;
  cleanText = currentText();
  clearError();
  await rememberDiskState(target);
  reconfigureLanguage();
  updateDirtyState();
  return true;
}

document.querySelector("#new-file")?.addEventListener("click", () => void newFile());
document.querySelector("#open-file")?.addEventListener("click", () => void openFile());
document.querySelector("#save-file")?.addEventListener("click", () => void saveFile(false));
document.querySelector("#save-as-file")?.addEventListener("click", () => void saveFile(true));
reloadExternal.addEventListener("click", () => {
  void reloadFromDisk();
});
ignoreExternal.addEventListener("click", () => {
  if (changedDiskSignature) ignoredDiskSignature = changedDiskSignature;
  changedDiskSignature = null;
  renderStatus();
});

document.querySelector("#find-toggle")?.addEventListener("click", () => {
  findPanel.hidden = !findPanel.hidden;
  if (!findPanel.hidden) {
    findInput.focus();
    findInput.select();
  }
});

document.querySelector("#find-close")?.addEventListener("click", () => {
  findPanel.hidden = true;
  view.focus();
});

findInput.addEventListener("input", () => {
  setSearch();
  findNext(view);
});
findInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") return;
  event.preventDefault();
  setSearch();
  if (event.shiftKey) {
    findPrevious(view);
  } else {
    findNext(view);
  }
});
replaceInput.addEventListener("input", setSearch);
document.querySelector("#find-next")?.addEventListener("click", () => {
  setSearch();
  findNext(view);
});
document.querySelector("#find-previous")?.addEventListener("click", () => {
  setSearch();
  findPrevious(view);
});
document.querySelector("#replace-next")?.addEventListener("click", () => {
  setSearch();
  replaceNext(view);
});
document.querySelector("#replace-all")?.addEventListener("click", () => {
  setSearch();
  replaceAll(view);
});

languageSelect.addEventListener("change", () => {
  chosenLanguage = languageSelect.value as LanguageId;
  reconfigureLanguage();
});

wrapToggle.addEventListener("change", () => {
  view.dispatch({
    effects: wrapCompartment.reconfigure(wrapToggle.checked ? EditorView.lineWrapping : [])
  });
});

assistantToggle.addEventListener("click", () => {
  const next = assistantPanel.hidden;
  assistantPanel.hidden = !next;
  assistantToggle.setAttribute("aria-pressed", String(next));
});

themeToggle.addEventListener("click", () => {
  theme = theme === "dark" ? "light" : "dark";
  document.body.dataset.theme = theme;
  themeToggle.textContent = theme === "dark" ? "Light" : "Dark";
  themeToggle.setAttribute("aria-pressed", String(theme === "light"));
});

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    void saveFile(event.shiftKey);
  }
  if (event.ctrlKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    void openFile();
  }
  if (event.ctrlKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    void newFile();
  }
  if (event.ctrlKey && event.key.toLowerCase() === "f") {
    event.preventDefault();
    findPanel.hidden = false;
    findInput.focus();
    findInput.select();
  }
});

void appWindow.onCloseRequested(async (event) => {
  if (closeConfirmed) return;
  event.preventDefault();
  if (!(await ensureSaved("Save changes before closing?"))) return;
  closeConfirmed = true;
  setTimeout(() => {
    void appWindow.destroy();
  }, 0);
});

document.body.dataset.theme = theme;
updateDirtyState();
updateCursorStatus();
window.setInterval(() => {
  void checkExternalFileChange();
}, 3000);
