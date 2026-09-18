import "./styles.css";
import "katex/dist/katex.min.css";
import katexCss from "katex/dist/katex.min.css?inline";
import { open, save } from "@tauri-apps/plugin-dialog";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import markdownit from "markdown-it";
import hljs from "highlight.js";
import katex from "katex";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
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
type ViewMode = "edit" | "split" | "preview";
type PreviewKind = "markdown" | "csv" | "tsv" | "json" | "svg" | "code";

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
const previewPane = document.querySelector<HTMLElement>("#preview-pane")!;
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]"));
const exportSelect = document.querySelector<HTMLSelectElement>("#export-select")!;
const exportBg = document.querySelector<HTMLSelectElement>("#export-bg")!;

const languageCompartment = new Compartment();
const wrapCompartment = new Compartment();
const appWindow = getCurrentWindow();
const setFindText = StateEffect.define<string>();

let currentPath: string | null = null;
let cleanText = "";
let chosenLanguage: LanguageId = "auto";
let viewMode: ViewMode = "edit";
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

// ---------------------------------------------------------------------------
// Preview + export
//
// The preview pane renders the current buffer read-only. What "render" means
// depends on the file: Markdown -> formatted HTML, CSV/TSV -> a table, JSON ->
// a collapsible tree, SVG -> the image, anything else -> a highlighted code
// listing. Export prints whatever the preview shows to PDF (A4) or HTML.
// ---------------------------------------------------------------------------

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

let imageRenderTarget: "preview" | "export" = "preview";

function isRemoteOrEmbeddedSource(src: string): boolean {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(src);
}

function isAbsolutePath(src: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(src) || /^\\\\/.test(src) || src.startsWith("/");
}

function documentDirectory(): string | null {
  if (!currentPath) return null;
  const cut = Math.max(currentPath.lastIndexOf("\\"), currentPath.lastIndexOf("/"));
  return cut >= 0 ? currentPath.slice(0, cut) : null;
}

function resolveImagePath(src: string): string {
  let normalized = src;
  try {
    normalized = decodeURI(src);
  } catch {
    normalized = src;
  }
  if (isAbsolutePath(normalized)) return normalized;
  const dir = documentDirectory();
  if (!dir) return src;
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir}${separator}${normalized.replace(/[\\/]/g, separator)}`;
}

function fileUrlFromPath(filePath: string): string {
  const normalized = filePath.replaceAll("\\", "/").replaceAll("#", "%23");
  return normalized.startsWith("/") ? `file://${normalized}` : `file:///${normalized}`;
}

function resolveImageSource(src: string, target: "preview" | "export"): string {
  if (isRemoteOrEmbeddedSource(src)) return src;
  const resolved = resolveImagePath(src);
  return target === "export" ? fileUrlFromPath(resolved) : convertFileSrc(resolved);
}

function renderLatex(source: string, displayMode: boolean): string {
  try {
    return katex.renderToString(source, { displayMode, throwOnError: false, errorColor: "#c0563d" });
  } catch {
    return escapeHtml(source);
  }
}

const md = markdownit({
  html: false,
  linkify: true,
  typographer: true,
  breaks: false,
  highlight(code, language) {
    if (language && hljs.getLanguage(language)) {
      try {
        return `<pre class="hljs"><code>${hljs.highlight(code, { language }).value}</code></pre>`;
      } catch {
        /* fall through */
      }
    }
    return `<pre class="hljs"><code>${escapeHtml(code)}</code></pre>`;
  }
});

// $inline$ and $$block$$ math via KaTeX.
md.inline.ruler.after("escape", "math_inline", (state, silent) => {
  if (state.src[state.pos] !== "$" || state.src[state.pos + 1] === "$") return false;
  const start = state.pos + 1;
  const end = state.src.indexOf("$", start);
  if (end === -1 || end === start) return false;
  if (!silent) {
    const token = state.push("math_inline", "math", 0);
    token.content = state.src.slice(start, end);
  }
  state.pos = end + 1;
  return true;
});
md.renderer.rules.math_inline = (tokens, index) => renderLatex(tokens[index].content, false);
md.renderer.rules.math_block = (tokens, index) => `<p class="math-block">${renderLatex(tokens[index].content, true)}</p>\n`;

const defaultImageRenderer =
  md.renderer.rules.image ??
  ((tokens, index, options, _env, self) => self.renderToken(tokens, index, options));
md.renderer.rules.image = (tokens, index, options, env, self) => {
  const src = tokens[index].attrGet("src");
  if (typeof src === "string") tokens[index].attrSet("src", resolveImageSource(src, imageRenderTarget));
  return defaultImageRenderer(tokens, index, options, env, self);
};

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  bulletListMarker: "-"
});
turndown.use(gfm);

function previewKind(): PreviewKind {
  const lower = currentPath?.toLowerCase() ?? "";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "markdown";
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".tsv")) return "tsv";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".svg")) return "svg";
  if (chosenLanguage === "markdown") return "markdown";
  return "code";
}

function hljsLanguage(): string | null {
  const language = chosenLanguage === "auto" ? detectLanguage(currentPath) : chosenLanguage;
  if (language === "powershell") return "powershell";
  if (language === "batch") return "dos";
  return null;
}

function renderMarkdownHtml(text: string, target: "preview" | "export"): string {
  imageRenderTarget = target;
  try {
    return md.render(text);
  } finally {
    imageRenderTarget = "preview";
  }
}

// Minimal RFC-4180-ish parser: honors quoted fields and "" escapes.
function parseDelimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(field); field = "";
    } else if (ch === "\n") {
      row.push(field); field = ""; rows.push(row); row = [];
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

function renderTableHtml(text: string, delimiter: string): string {
  const rows = parseDelimited(text, delimiter);
  if (!rows.length) return `<p class="preview-empty">No rows.</p>`;
  const [head, ...body] = rows;
  const ths = head.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  return `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
}

function renderJsonNode(value: unknown): string {
  if (value === null) return `<span class="json-null">null</span>`;
  if (typeof value === "string") return `<span class="json-string">${escapeHtml(JSON.stringify(value))}</span>`;
  if (typeof value === "number") return `<span class="json-number">${value}</span>`;
  if (typeof value === "boolean") return `<span class="json-bool">${value}</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return `<span class="json-punct">[]</span>`;
    const items = value
      .map((item) => `<li>${renderJsonNode(item)}</li>`)
      .join("");
    return `<details open class="json-branch"><summary><span class="json-punct">[</span> <span class="json-count">${value.length}</span> <span class="json-punct">]</span></summary><ul>${items}</ul></details>`;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return `<span class="json-punct">{}</span>`;
  const items = entries
    .map(([k, v]) => `<li><span class="json-key">${escapeHtml(JSON.stringify(k))}</span><span class="json-punct">: </span>${renderJsonNode(v)}</li>`)
    .join("");
  return `<details open class="json-branch"><summary><span class="json-punct">{</span> <span class="json-count">${entries.length}</span> <span class="json-punct">}</span></summary><ul>${items}</ul></details>`;
}

function renderJsonHtml(text: string): string {
  if (!text.trim()) return `<p class="preview-empty">Empty.</p>`;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return `<p class="preview-error">Invalid JSON: ${escapeHtml(String(error))}</p>`;
  }
  return `<div class="json-view">${renderJsonNode(value)}</div>`;
}

function renderSvgHtml(text: string): string {
  // Drop scripts / on* handlers before injecting the user's SVG markup.
  const safe = text
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  return `<div class="svg-view">${safe}</div>`;
}

function renderCodeHtml(text: string): string {
  const language = hljsLanguage();
  let inner: string;
  if (language && hljs.getLanguage(language)) {
    try {
      inner = hljs.highlight(text, { language }).value;
    } catch {
      inner = escapeHtml(text);
    }
  } else {
    inner = escapeHtml(text);
  }
  return `<pre class="hljs code-listing"><code>${inner}</code></pre>`;
}

function renderPreviewHtml(text: string, kind: PreviewKind, target: "preview" | "export"): string {
  switch (kind) {
    case "markdown": return renderMarkdownHtml(text, target);
    case "csv": return renderTableHtml(text, ",");
    case "tsv": return renderTableHtml(text, "\t");
    case "json": return renderJsonHtml(text);
    case "svg": return renderSvgHtml(text);
    default: return renderCodeHtml(text);
  }
}

function renderPreview() {
  if (viewMode === "edit") return;
  previewPane.innerHTML = renderPreviewHtml(currentText(), previewKind(), "preview");
}

function applyViewMode(mode: ViewMode) {
  viewMode = mode;
  document.body.dataset.view = mode;
  for (const button of viewButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.view === mode));
  }
  renderPreview();
}

function exportName(extension: string): string {
  const base = currentPath ? displayName(currentPath).replace(/\.[^.]+$/, "") : "document";
  return `${base}.${extension}`;
}

interface ExportPalette {
  bg: string; text: string; panel: string; border: string;
  accent: string; heading: string; muted: string;
  comment: string; keyword: string; string: string; number: string;
  variable: string; func: string; property: string; label: string;
}

// "paper" = a fixed light document palette (best for print/share). "theme" =
// the app's current colours, so a dark preview exports as a dark PDF.
function exportPalette(): ExportPalette {
  if (exportBg.value === "theme") {
    const s = getComputedStyle(document.body);
    const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
    return {
      bg: v("--code-bg", "#272722"), text: v("--text", "#e8e0d2"),
      panel: v("--panel", "#2d2c27"), border: v("--panel-border", "#5f564b"),
      accent: v("--accent", "#b97a56"), heading: v("--syntax-heading", "#f0dfc9"),
      muted: v("--muted", "#b8a892"), comment: v("--syntax-comment", "#a07858"),
      keyword: v("--syntax-keyword", "#c59ac9"), string: v("--syntax-string", "#d08b82"),
      number: v("--syntax-number", "#80a993"), variable: v("--syntax-variable", "#e8e0d2"),
      func: v("--syntax-function", "#9bb5c8"), property: v("--syntax-property", "#c4b58e"),
      label: v("--syntax-label", "#d3b27e")
    };
  }
  return {
    bg: "#ffffff", text: "#1c1a16", panel: "#f4efe8", border: "#cfc7b8",
    accent: "#a14f2a", heading: "#2b241b", muted: "#6d6149",
    comment: "#9a6b45", keyword: "#7f4f8f", string: "#9d3f3a", number: "#27745f",
    variable: "#2b241b", func: "#2f6281", property: "#6d6149", label: "#8b6128"
  };
}

function buildExportDocument(): string {
  const bodyHtml = renderPreviewHtml(currentText(), previewKind(), "export");
  const title = escapeHtml(currentPath ? displayName(currentPath) : "QuietPad document");
  const p = exportPalette();
  return `<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>${katexCss}</style>
<style>
  @page { size: A4; margin: 16mm; }
  body { margin: 0; color: ${p.text}; background: ${p.bg};
    font-family: Georgia, "Times New Roman", serif; line-height: 1.7; }
  main { max-width: 100%; }
  h1, h2, h3, h4 { line-height: 1.25; color: ${p.heading}; }
  a { color: ${p.func}; }
  pre { overflow: auto; padding: 12px 14px; border-radius: 8px; background: ${p.panel};
    border: 1px solid ${p.border}; font-family: Consolas, "Courier New", monospace;
    font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  code { font-family: Consolas, "Courier New", monospace; }
  pre code { background: transparent; }
  :not(pre) > code { padding: 0.12em 0.35em; border-radius: 4px; background: ${p.panel}; }
  blockquote { margin: 1rem 0; padding: 0.2rem 1rem; border-left: 3px solid ${p.accent};
    color: ${p.muted}; }
  table { width: 100%; border-collapse: collapse; margin: 1rem 0; font-size: 13px; }
  th, td { padding: 7px 10px; border: 1px solid ${p.border}; text-align: left; vertical-align: top; }
  th { background: ${p.panel}; }
  img { max-width: 100%; height: auto; }
  .svg-view svg { max-width: 100%; height: auto; }
  .json-view { font-family: Consolas, "Courier New", monospace; font-size: 12.5px; }
  .json-view ul { list-style: none; margin: 0; padding-left: 1.2em; }
  .json-key { color: ${p.keyword}; } .json-string { color: ${p.string}; }
  .json-number, .json-bool { color: ${p.number}; } .json-null { color: ${p.label}; }
  .json-punct, .json-count { color: ${p.muted}; }
  .hljs-comment, .hljs-quote { color: ${p.comment}; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-built_in, .hljs-literal { color: ${p.keyword}; }
  .hljs-string, .hljs-meta-string { color: ${p.string}; }
  .hljs-number, .hljs-symbol { color: ${p.number}; }
  .hljs-variable, .hljs-template-variable, .hljs-attr { color: ${p.variable}; }
  .hljs-title, .hljs-section { color: ${p.func}; }
  .hljs-attribute, .hljs-name, .hljs-tag { color: ${p.property}; }
  .hljs-type, .hljs-class .hljs-title { color: ${p.label}; }
  .katex-display { overflow-x: auto; }
</style></head>
<body><main>${bodyHtml}</main></body></html>`;
}

async function exportPdf() {
  const target = await save({
    defaultPath: exportName("pdf"),
    filters: [{ name: "PDF", extensions: ["pdf"] }]
  });
  if (!target) return;
  try {
    await invoke("export_pdf", { targetPath: target, html: buildExportDocument() });
    clearError();
  } catch (error) {
    showError(String(error));
  }
}

async function exportHtml() {
  const target = await save({
    defaultPath: exportName("html"),
    filters: [{ name: "HTML", extensions: ["html"] }]
  });
  if (!target) return;
  try {
    await writeFile(target, buildExportDocument());
    clearError();
  } catch (error) {
    showError(String(error));
  }
}

// Paste-as-Markdown: when editing Markdown, rich HTML on the clipboard (an AI
// answer, a web selection) is converted to Markdown source instead of pasted raw.
const markdownPaste = EditorView.domEventHandlers({
  paste(event, editorView) {
    if (previewKind() !== "markdown") return false;
    const html = event.clipboardData?.getData("text/html");
    if (!html) return false;
    event.preventDefault();
    const markdownText = turndown.turndown(html).trim();
    editorView.dispatch(editorView.state.replaceSelection(markdownText));
    return true;
  }
});

function baseExtensions(): Extension[] {
  return [
    markdownPaste,
    lineNumbers(),
    highlightActiveLineGutter(),
    history(),
    highlightActiveLine(),
    syntaxHighlighting(quietHighlightStyle, { fallback: true }),
    findHighlightField,
    search({ top: true }),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        updateDirtyState();
        if (viewMode !== "edit") renderPreview();
      }
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
  const title = `${dirty ? "*" : ""}${displayName(currentPath)} - QuietPad`;
  document.title = title;
  void appWindow.setTitle(title);
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

// Load a known path into the editor (from the dialog, launch args, or a file
// opened while QuietPad is already running). Guards unsaved changes first.
async function openPath(path: string) {
  if (!(await ensureSaved())) return;
  try {
    const text = await readFile(path);
    currentPath = path;
    clearError();
    replaceDocument(text);
    await rememberDiskState(path);
    reconfigureLanguage();
    void appWindow.setFocus();
  } catch (error) {
    showError(String(error));
  }
}

async function openFile() {
  if (!(await ensureSaved())) return;
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Text files", extensions: ["txt", "md", "markdown", "ps1", "psm1", "psd1", "bat", "cmd", "json", "csv", "tsv", "svg", "log"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (typeof selected !== "string") return;
  // Buffer already reconciled above; load without re-prompting.
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
  renderPreview();
});

for (const button of viewButtons) {
  button.addEventListener("click", () => applyViewMode(button.dataset.view as ViewMode));
}

exportSelect.addEventListener("change", () => {
  const choice = exportSelect.value;
  exportSelect.value = "";
  if (choice === "pdf") void exportPdf();
  if (choice === "html") void exportHtml();
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
applyViewMode(viewMode);
updateDirtyState();
updateCursorStatus();
window.setInterval(() => {
  void checkExternalFileChange();
}, 3000);

// A file opened while QuietPad is already running (e.g. double-clicking another
// .txt) is forwarded by the single-instance plugin as an "open-file" event.
void listen<string>("open-file", (event) => {
  if (event.payload) void openPath(event.payload);
});

// A file QuietPad was launched with (file association / "Open with").
void invoke<string | null>("take_launch_file")
  .then((path) => {
    if (path) void openPath(path);
  })
  .catch(() => undefined);
