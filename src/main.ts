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
import { EditorState, Compartment, Extension, RangeSetBuilder, StateEffect, StateField, Text } from "@codemirror/state";
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
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { python } from "@codemirror/lang-python";
import { sql } from "@codemirror/lang-sql";
import { html } from "@codemirror/lang-html";
import { xml } from "@codemirror/lang-xml";
import { r as rMode } from "@codemirror/legacy-modes/mode/r";
import { shell as shellMode } from "@codemirror/legacy-modes/mode/shell";
import { toml as tomlMode } from "@codemirror/legacy-modes/mode/toml";
import { properties as propertiesMode } from "@codemirror/legacy-modes/mode/properties";
import { diff as diffMode } from "@codemirror/legacy-modes/mode/diff";
import { tags as t } from "@lezer/highlight";

type LanguageId =
  | "auto" | "text" | "powershell" | "batch" | "markdown"
  | "json" | "yaml" | "python" | "sql" | "r" | "shell" | "toml" | "ini" | "diff" | "stata"
  | "html" | "xml";
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
const followToggle = document.querySelector<HTMLInputElement>("#follow-toggle")!;
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
const factsBar = document.querySelector<HTMLElement>("#facts-bar")!;
const factsText = document.querySelector<HTMLSpanElement>("#facts-text")!;
const loadWholeButton = document.querySelector<HTMLButtonElement>("#load-whole")!;
const viewButtons = Array.from(document.querySelectorAll<HTMLButtonElement>(".segmented [data-view]"));
const exportSelect = document.querySelector<HTMLSelectElement>("#export-select")!;
const exportBg = document.querySelector<HTMLSelectElement>("#export-bg")!;

const languageCompartment = new Compartment();
const wrapCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const appWindow = getCurrentWindow();
const setFindText = StateEffect.define<string>();

let currentPath: string | null = null;
// The document as last loaded/saved. Compared with Text.eq, which skips the
// subtrees an edit left shared, so the dirty check stays cheap on big files.
let cleanDoc: Text = Text.empty;
let dirty = false;
let chosenLanguage: LanguageId = "auto";
let viewMode: ViewMode = "edit";
let followMode = false;
let theme: "dark" | "light" = "dark";
let closeConfirmed = false;
// Content hashes (computed in Rust) of the file on disk: the baseline, a newer
// version waiting for Reload/Ignore, and one the user chose to ignore.
let lastDiskHash: string | null = null;
let pendingDiskHash: string | null = null;
let ignoredDiskHash: string | null = null;
let errorMessage: string | null = null;

// Large files open as a read-only excerpt: the first EXCERPT_LINES lines, with
// the next batch read when the user scrolls near the bottom. QuietPad is a
// quick look at big data files, not the place to edit them.
const LARGE_FILE_BYTES = 10 * 1024 * 1024;
const EXCERPT_LINES = 1000;
const CHUNK_MAX_BYTES = 2 * 1024 * 1024;
type Excerpt = { nextOffset: number; eof: boolean; size: number; signature: string; loading: boolean };
let excerpt: Excerpt | null = null;
// Facts for the facts bar: byte size and (counted in the background) lines.
let facts: { path: string; size: number; lines: number | null } | null = null;
let factsToken = 0;
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

// Legacy CodeMirror stream modes (same lightweight style as the two above).
const rLanguage = StreamLanguage.define(rMode);
const shellLanguage = StreamLanguage.define(shellMode);
const tomlLanguage = StreamLanguage.define(tomlMode);
const iniLanguage = StreamLanguage.define(propertiesMode);
const diffLanguage = StreamLanguage.define(diffMode);

// Stata has no CodeMirror mode, so this is a hand-written one for .do/.ado:
// * and //-comments, /* */ blocks, `local' and $global macros, strings, and
// the common command/keyword set.
const stataKeywords =
  /\b(?:if|else|in|of|by|bysort|foreach|forvalues|forv|while|continue|break|program|end|return|exit|version|capture|cap|quietly|qui|noisily|preserve|restore|use|save|clear|generate|gen|egen|replace|drop|keep|rename|ren|recode|encode|decode|destring|tostring|label|merge|append|collapse|reshape|sort|gsort|order|format|compress|import|export|insheet|outsheet|infile|regress|reg|summarize|sum|summ|tabulate|tab|tabstat|table|correlate|corr|pwcorr|ttest|anova|logit|logistic|probit|poisson|ivregress|xtreg|areg|margins|predict|estimates|est|test|lincom|display|di|list|count|describe|desc|codebook|assert|scalar|matrix|mat|local|global|macro|tempvar|tempname|tempfile|set|char|mata|python)\b/;

interface StataState { block: boolean; sol: boolean; }
const stataLanguage = StreamLanguage.define<StataState>({
  startState: () => ({ block: false, sol: true }),
  token(stream, state) {
    if (state.block) {
      if (stream.match(/.*?\*\//)) state.block = false;
      else stream.skipToEnd();
      return "comment";
    }
    if (stream.sol()) state.sol = true;
    if (stream.eatSpace()) return null;
    const atLineStart = state.sol;
    state.sol = false;
    if (stream.match(/\/\*/)) {
      if (!stream.match(/.*?\*\//)) { state.block = true; stream.skipToEnd(); }
      return "comment";
    }
    if (stream.match(/\/\/.*/)) return "comment";
    if (atLineStart && stream.match(/\*.*/)) return "comment";
    if (stream.match(/`"(?:[^"]|"(?!'))*"'/)) return "string";
    if (stream.match(/"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/`[^'`]*'/)) return "variableName";
    if (stream.match(/\$\{[^}]*\}/) || stream.match(/\$[A-Za-z_]\w*/)) return "variableName";
    if (stream.match(stataKeywords)) return "keyword";
    if (stream.match(/\b\d+(?:\.\d+)?\b/)) return "number";
    stream.next();
    return null;
  }
});

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// CodeMirror's native .cm-searchMatch highlighting only renders while its own
// search panel is open, but QuietPad hides that panel and uses a custom find bar.
// So we decorate every match of the query ourselves to keep matches visible.
const matchMark = Decoration.mark({ class: "quiet-search-match" });
const currentMatchMark = Decoration.mark({ class: "quiet-search-match quiet-search-match-current" });

// Highlighting stops after this many matches; a one-letter query in a 30 MB
// file would otherwise build millions of decorations.
const MAX_FIND_MARKS = 20000;

function scanFindMatches(state: EditorState, query: string): number[] {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const pattern = new RegExp(escapeRegExp(trimmed), "gi");
  const text = state.doc.toString();
  const ranges: number[] = [];
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    ranges.push(match.index, match.index + match[0].length);
    if (ranges.length >= MAX_FIND_MARKS * 2) break;
  }
  return ranges;
}

function buildFindDecorations(state: EditorState, ranges: number[]): DecorationSet {
  if (!ranges.length) return Decoration.none;
  const builder = new RangeSetBuilder<Decoration>();
  // findNext/findPrevious move the selection onto the active match, so the match
  // whose range equals the current selection is the one the user is sitting on.
  const sel = state.selection.main;
  for (let i = 0; i < ranges.length; i += 2) {
    const from = ranges[i];
    const to = ranges[i + 1];
    builder.add(from, to, from === sel.from && to === sel.to ? currentMatchMark : matchMark);
  }
  return builder.finish();
}

type FindState = { query: string; ranges: number[]; decorations: DecorationSet };

const findHighlightField = StateField.define<FindState>({
  create: () => ({ query: "", ranges: [], decorations: Decoration.none }),
  update(value, transaction) {
    let query = value.query;
    for (const effect of transaction.effects) {
      if (effect.is(setFindText)) query = effect.value;
    }
    if (transaction.docChanged || query !== value.query) {
      const ranges = scanFindMatches(transaction.state, query);
      return { query, ranges, decorations: buildFindDecorations(transaction.state, ranges) };
    }
    // Selection moved only: re-mark the current match, no rescan of the text.
    if (transaction.selection && value.ranges.length) {
      return { ...value, decorations: buildFindDecorations(transaction.state, value.ranges) };
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
  return effectiveLanguage() === "markdown" ? "markdown" : "code";
}

function hljsLanguage(): string | null {
  const language = effectiveLanguage();
  const map: Partial<Record<LanguageId, string>> = {
    powershell: "powershell", batch: "dos", python: "python", sql: "sql",
    yaml: "yaml", r: "r", shell: "bash", toml: "ini", ini: "ini", diff: "diff",
    html: "xml", xml: "xml"
  };
  return map[language] ?? null;
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
function parseDelimited(text: string, delimiter: string, maxRows = Infinity): string[][] {
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
      if (rows.length >= maxRows) return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
    } else if (ch !== "\r") {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

// The live preview shows at most this many table rows / characters; the full
// content is still in the editor (and in exports).
const PREVIEW_MAX_ROWS = 2000;
const PREVIEW_MAX_CHARS = 2_000_000;

function previewTruncatedNote(shown: string): string {
  return `<p class="preview-empty">Preview shows ${shown}.</p>`;
}

function firstLine(text: string): string {
  const end = text.indexOf("\n");
  return (end === -1 ? text : text.slice(0, end)).replace(/\r$/, "");
}

// Pick the delimiter from the header line: Norwegian exports often use ";".
function detectDelimiter(header: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0, "|": 0 };
  let quoted = false;
  for (const ch of header) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of Object.keys(counts)) if (counts[d] > counts[best]) best = d;
  return best;
}

function renderTableHtml(text: string, delimiter: string, maxRows = Infinity): string {
  const rows = parseDelimited(text, delimiter, maxRows === Infinity ? Infinity : maxRows + 1);
  if (!rows.length) return `<p class="preview-empty">No rows.</p>`;
  const truncated = rows.length > maxRows;
  if (truncated) rows.length = maxRows;
  const [head, ...body] = rows;
  const ths = head.map((c) => `<th>${escapeHtml(c)}</th>`).join("");
  const trs = body
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join("")}</tr>`)
    .join("");
  const table = `<table class="data-table"><thead><tr>${ths}</tr></thead><tbody>${trs}</tbody></table>`;
  return truncated ? previewTruncatedNote(`the first ${maxRows.toLocaleString()} rows`) + table : table;
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
  const live = target === "preview";
  const maxRows = live ? PREVIEW_MAX_ROWS : Infinity;
  if (live && kind !== "csv" && kind !== "tsv" && text.length > PREVIEW_MAX_CHARS) {
    // Highlighting / parsing megabytes on every keystroke freezes the window.
    const head = text.slice(0, PREVIEW_MAX_CHARS);
    return previewTruncatedNote(`the first ${PREVIEW_MAX_CHARS.toLocaleString()} characters as plain text`)
      + `<pre class="hljs code-listing"><code>${escapeHtml(head)}</code></pre>`;
  }
  switch (kind) {
    case "markdown": return renderMarkdownHtml(text, target);
    case "csv": return renderTableHtml(text, detectDelimiter(firstLine(text)), maxRows);
    case "tsv": return renderTableHtml(text, "\t", maxRows);
    case "json": return renderJsonHtml(text);
    case "svg": return renderSvgHtml(text);
    default: return renderCodeHtml(text);
  }
}

function renderPreview() {
  if (previewTimer !== null) {
    window.clearTimeout(previewTimer);
    previewTimer = null;
  }
  if (viewMode === "edit") return;
  previewPane.innerHTML = renderPreviewHtml(currentText(), previewKind(), "preview");
}

// While typing, re-render the preview once the user pauses, not per keystroke.
let previewTimer: number | null = null;
function schedulePreview() {
  if (viewMode === "edit") return;
  if (previewTimer !== null) window.clearTimeout(previewTimer);
  const delay = view.state.doc.length > 200_000 ? 600 : 150;
  previewTimer = window.setTimeout(() => {
    previewTimer = null;
    renderPreview();
  }, delay);
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
  html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; color: ${p.text}; background: ${p.bg};
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
    font-family: Georgia, "Times New Roman", serif; line-height: 1.7; }
  main { max-width: 100%; }
  h1, h2, h3, h4 { line-height: 1.25; color: ${p.heading}; }
  a { color: ${p.func}; }
  pre { overflow: auto; padding: 12px 14px; border-radius: 8px; background: ${p.panel};
    border: 1px solid ${p.border}; font-family: Consolas, "Courier New", monospace;
    font-size: 12.5px; white-space: pre-wrap; word-break: break-word; }
  /* A whole-file code listing is the document, not a boxed snippet. */
  pre.code-listing { background: transparent; border: none; border-radius: 0; padding: 0; }
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
    if (previewKind() !== "markdown" || editorView.state.readOnly) return false;
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
        dirty = !update.state.doc.eq(cleanDoc);
        updateDirtyState();
        schedulePreview();
      }
      if (update.selectionSet || update.docChanged) updateCursorStatus();
      if (update.viewportChanged && excerpt) void maybeLoadNextBatch();
    }),
    languageCompartment.of(languageExtension()),
    wrapCompartment.of(EditorView.lineWrapping),
    readOnlyCompartment.of([])
  ];
}

const view = new EditorView({
  parent: editorHost,
  state: EditorState.create({
    doc: "",
    extensions: baseExtensions()
  })
});

// The language actually in effect: the manual override, or auto-detection. A
// fresh unsaved buffer has no extension to detect from, so in Auto mode it is
// treated as Markdown — you're almost always writing prose in a new QuietPad.
function effectiveLanguage(): Exclude<LanguageId, "auto"> {
  if (chosenLanguage !== "auto") return chosenLanguage;
  const detected = detectLanguage(currentPath);
  if (detected === "text" && !currentPath) return "markdown";
  return detected;
}

function languageExtension(): Extension {
  const language = effectiveLanguage();
  switch (language) {
    case "markdown": return markdown();
    case "powershell": return powershellLanguage;
    case "batch": return batchLanguage;
    case "json": return json();
    case "yaml": return yaml();
    case "python": return python();
    case "sql": return sql();
    case "html": return html();
    case "xml": return xml();
    case "r": return rLanguage;
    case "shell": return shellLanguage;
    case "toml": return tomlLanguage;
    case "ini": return iniLanguage;
    case "diff": return diffLanguage;
    case "stata": return stataLanguage;
    default: return [];
  }
}

function detectLanguage(path: string | null): Exclude<LanguageId, "auto"> {
  const lower = path?.toLowerCase() ?? "";
  const ext = lower.includes(".") ? lower.slice(lower.lastIndexOf(".") + 1) : "";
  switch (ext) {
    case "ps1": case "psm1": case "psd1": return "powershell";
    case "bat": case "cmd": return "batch";
    case "md": case "markdown": return "markdown";
    case "json": return "json";
    case "yaml": case "yml": return "yaml";
    case "py": case "pyw": return "python";
    case "sql": return "sql";
    case "r": return "r";
    case "sh": case "bash": return "shell";
    case "toml": return "toml";
    case "ini": case "cfg": case "conf": return "ini";
    case "diff": case "patch": return "diff";
    case "do": case "ado": return "stata";
    case "html": case "htm": return "html";
    case "xml": return "xml";
    default: return "text";
  }
}

function replaceDocument(text: string) {
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
    selection: { anchor: 0 }
  });
  markClean();
  updateDirtyState();
  updateCursorStatus();
}

function markClean() {
  cleanDoc = view.state.doc;
  dirty = false;
}

function clearExternalChangeWarning() {
  pendingDiskHash = null;
  ignoredDiskHash = null;
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
  statusLeft.classList.toggle("status-notice", errorMessage === null && pendingDiskHash !== null);
  if (errorMessage) {
    statusLeft.textContent = errorMessage;
    reloadExternal.hidden = true;
    ignoreExternal.hidden = true;
    return;
  }
  if (pendingDiskHash !== null) {
    statusLeft.textContent = "File changed on disk";
    reloadExternal.hidden = false;
    ignoreExternal.hidden = false;
    return;
  }
  statusLeft.textContent = excerpt ? "Read-only excerpt" : dirty ? "Unsaved changes" : currentPath ? "Saved" : "Ready";
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
type OpenedFile = { text: string; hash: string };

function readFile(path: string) {
  return invoke<OpenedFile>("read_file", { path });
}

// Resolves to the content hash of what was written.
function writeFile(path: string, contents: string) {
  return invoke<string>("write_file", { path, contents });
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
  if (!dirty) return true;
  const choice = await askUnsaved(message);
  if (choice === "cancel") return false;
  if (choice === "discard") return true;
  return saveFile(false);
}

// Record the on-disk content as the baseline for change detection. Called right
// after a read or write, so the buffer already matches disk.
function rememberDiskState(hash: string) {
  lastDiskHash = hash;
  pendingDiskHash = null;
  ignoredDiskHash = null;
  renderStatus();
}

// Reload the file and jump to the end — the tail-a-log behaviour of Follow mode.
async function followReload() {
  if (!currentPath) return;
  try {
    const { text, hash } = await readFile(currentPath);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: text },
      selection: { anchor: text.length },
      scrollIntoView: true
    });
    markClean();
    rememberDiskState(hash);
    updateDirtyState();
    updateCursorStatus();
    renderPreview();
  } catch (error) {
    showError(String(error));
  }
}

async function checkExternalFileChange() {
  if (!currentPath) return;
  if (excerpt) {
    // Hashing a multi-GB file every few seconds is too heavy; mtime+size is
    // good enough for a read-only excerpt.
    let sig: string;
    try {
      sig = await invoke<string>("file_signature", { path: currentPath });
    } catch {
      return;
    }
    if (sig !== excerpt.signature && sig !== ignoredDiskHash) {
      pendingDiskHash = sig;
      renderStatus();
    }
    return;
  }
  let disk: string;
  try {
    // Compare a hash of the actual bytes rather than mtime/size — the latter can
    // lag on Windows for a file another process is still appending to (a live
    // log). Hashing happens in Rust, so only a short string crosses the bridge.
    disk = await invoke<string>("file_hash", { path: currentPath });
  } catch {
    return;
  }
  if (lastDiskHash === null) {
    lastDiskHash = disk;
    return;
  }
  if (disk !== lastDiskHash && disk !== ignoredDiskHash) {
    // Follow mode auto-reloads and tails, but never clobbers unsaved edits —
    // if the buffer is dirty it falls back to the reload prompt.
    if (followMode && !dirty) {
      await followReload();
    } else {
      pendingDiskHash = disk;
      renderStatus();
    }
  }
}

async function reloadFromDisk() {
  if (!currentPath) return;
  if (dirty) {
    const choice = await askUnsaved("Reload from disk and discard unsaved changes?");
    if (choice === "cancel") return;
    if (choice === "save") {
      // Saving the buffer is what the user has; there is nothing to reload onto.
      await saveFile(false);
      return;
    }
  }
  await loadPath(currentPath);
}

async function newFile() {
  if (!(await ensureSaved())) return;
  clearError();
  currentPath = null;
  lastDiskHash = null;
  setExcerpt(null);
  clearExternalChangeWarning();
  replaceDocument("");
  reconfigureLanguage();
  void refreshFacts();
}

// --- loading -----------------------------------------------------------------

function setExcerpt(next: Excerpt | null) {
  excerpt = next;
  view.dispatch({ effects: readOnlyCompartment.reconfigure(next ? EditorState.readOnly.of(true) : []) });
  followToggle.disabled = next !== null;
  if (next && followMode) {
    followMode = false;
    followToggle.checked = false;
  }
  renderFacts();
}

function readChunk(path: string, offset: number) {
  return invoke<{ text: string; nextOffset: number; eof: boolean; fileSize: number }>("read_chunk", {
    path, offset, maxLines: EXCERPT_LINES, maxBytes: CHUNK_MAX_BYTES
  });
}

// Open a path: small files whole and editable, large ones as an excerpt.
// Callers have already dealt with unsaved changes.
async function loadPath(path: string, forceWhole = false) {
  try {
    const signature = await invoke<string>("file_signature", { path });
    const size = Number(signature.split(":")[1] ?? 0);
    if (size > LARGE_FILE_BYTES && !forceWhole) {
      const chunk = await readChunk(path, 0);
      currentPath = path;
      clearError();
      clearExternalChangeWarning();
      setExcerpt({ nextOffset: chunk.nextOffset, eof: chunk.eof, size: chunk.fileSize, signature, loading: false });
      replaceDocument(chunk.text);
      lastDiskHash = null;
    } else {
      const { text, hash } = await readFile(path);
      currentPath = path;
      clearError();
      setExcerpt(null);
      replaceDocument(text);
      rememberDiskState(hash);
    }
    reconfigureLanguage();
    renderPreview();
    void refreshFacts();
    void appWindow.setFocus();
    // A short first batch may not fill the window; top it up.
    void maybeLoadNextBatch();
  } catch (error) {
    showError(String(error));
  }
}

// Append the next batch when the user nears the end of what is loaded.
async function maybeLoadNextBatch() {
  const ex = excerpt;
  if (!ex || ex.eof || ex.loading || !currentPath) return;
  // The line at the bottom of the screen, from the scroll position. (Not
  // view.viewport: right after an append it is mapped onto the new end of the
  // doc until the next measure, which would chain-load batch after batch.)
  // Load only when the screen reaches the last few hundred loaded lines.
  const doc = view.state.doc;
  const dom = view.scrollDOM;
  const bottom = view.lineBlockAtHeight(dom.scrollTop + dom.clientHeight);
  const lastShown = doc.lineAt(Math.min(bottom.from, doc.length)).number;
  if (lastShown < doc.lines - 300) return;
  ex.loading = true;
  const path = currentPath;
  try {
    const chunk = await readChunk(path, ex.nextOffset);
    if (excerpt !== ex || currentPath !== path) return; // another file opened meanwhile
    // Keep the selection where it was: a cursor at the end (Ctrl+End) would
    // otherwise ride along with each batch and keep pulling in the next one.
    // Likewise restore the scroll position: CodeMirror keeps a view that sits at
    // the bottom pinned to the bottom, which would also chain-load.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: chunk.text },
      selection: view.state.selection,
      effects: view.scrollSnapshot()
    });
    markClean();
    updateDirtyState();
    ex.nextOffset = chunk.nextOffset;
    ex.eof = chunk.eof;
    renderFacts();
  } catch (error) {
    showError(String(error));
  } finally {
    ex.loading = false;
  }
  // Still near the bottom (fast scroll, short lines): keep going.
  window.requestAnimationFrame(() => void maybeLoadNextBatch());
}

// --- facts bar -----------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

async function refreshFacts() {
  const token = ++factsToken;
  const path = currentPath;
  const isData = previewKind() === "csv" || previewKind() === "tsv";
  if (!path || (!excerpt && !isData)) {
    facts = null;
    renderFacts();
    return;
  }
  const size = excerpt?.size ?? 0;
  facts = { path, size, lines: null };
  renderFacts();
  try {
    const result = await invoke<{ size: number; lines: number }>("file_facts", { path });
    if (token !== factsToken) return;
    facts = { path, size: result.size, lines: result.lines };
  } catch {
    if (token !== factsToken) return;
  }
  renderFacts();
}

function renderFacts() {
  const kind = previewKind();
  const isData = kind === "csv" || kind === "tsv";
  if (!currentPath || (!excerpt && !isData)) {
    factsBar.hidden = true;
    return;
  }
  const parts: string[] = [];
  const size = facts?.size || excerpt?.size;
  if (size) parts.push(formatBytes(size));
  const lines = facts?.lines;
  if (isData) {
    const header = firstLine(view.state.doc.line(1).text);
    const delimiter = kind === "tsv" ? "\t" : detectDelimiter(header);
    const columns = parseDelimited(header, delimiter, 1)[0]?.length ?? 0;
    const name = delimiter === "\t" ? "tab" : delimiter;
    parts.push(lines == null ? "counting rows…" : `${Math.max(lines - 1, 0).toLocaleString()} rows + header`);
    parts.push(`${columns.toLocaleString()} columns (delimiter ${name})`);
  } else {
    parts.push(lines == null ? "counting lines…" : `${lines.toLocaleString()} lines`);
  }
  if (excerpt) {
    const doc = view.state.doc;
    // A trailing newline leaves an empty last line that is not a data line.
    const loaded = doc.lines - (doc.line(doc.lines).length === 0 ? 1 : 0);
    parts.push(excerpt.eof ? `all ${loaded.toLocaleString()} lines loaded` : `lines 1–${loaded.toLocaleString()} loaded, more on scroll`);
    parts.push("read-only");
  }
  factsText.textContent = parts.join(" · ");
  loadWholeButton.hidden = !excerpt;
  factsBar.hidden = false;
}

// Load a known path into the editor (from the dialog, launch args, or a file
// opened while QuietPad is already running). Guards unsaved changes first.
async function openPath(path: string) {
  if (!(await ensureSaved())) return;
  await loadPath(path);
}

async function openFile() {
  if (!(await ensureSaved())) return;
  const selected = await open({
    multiple: false,
    filters: [
      { name: "Text files", extensions: ["txt", "md", "markdown", "ps1", "psm1", "psd1", "bat", "cmd", "do", "ado", "py", "pyw", "r", "sql", "sh", "bash", "html", "htm", "xml", "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "csv", "tsv", "svg", "diff", "patch", "log"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (typeof selected !== "string") return;
  // Buffer already reconciled above; load without re-prompting.
  await loadPath(selected);
}

// Returns true when the file was written, false on cancel or error.
async function saveFile(forcePicker = false): Promise<boolean> {
  let target = currentPath;
  // An excerpt is only part of the file: never write it over the original.
  if (excerpt) forcePicker = true;
  if (!target || forcePicker) {
    const selected = await save({
      defaultPath: excerpt && currentPath ? currentPath.replace(/(\.[^.\\/]+)?$/, "_excerpt$1") : currentPath ?? "Untitled.txt",
      filters: [
        { name: "Text files", extensions: ["txt", "md", "ps1", "bat", "cmd"] },
        { name: "All files", extensions: ["*"] }
      ]
    });
    if (!selected) return false;
    if (excerpt && currentPath && selected.toLowerCase() === currentPath.toLowerCase()) {
      showError("This is an excerpt of the file. Save it under a new name.");
      return false;
    }
    target = selected;
  }
  let hash: string;
  try {
    hash = await writeFile(target, currentText());
  } catch (error) {
    showError(String(error));
    return false;
  }
  currentPath = target;
  setExcerpt(null);
  markClean();
  clearError();
  rememberDiskState(hash);
  void refreshFacts();
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
  if (pendingDiskHash !== null) ignoredDiskHash = pendingDiskHash;
  pendingDiskHash = null;
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

loadWholeButton.addEventListener("click", () => {
  if (currentPath) void loadPath(currentPath, true);
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

// The preview mirrors the export background, so the control is visible (and the
// preview is a true preview of the exported page): Paper = white, else theme.
function applyPreviewBackground() {
  previewPane.dataset.bg = exportBg.value;
}
exportBg.addEventListener("change", applyPreviewBackground);

wrapToggle.addEventListener("change", () => {
  view.dispatch({
    effects: wrapCompartment.reconfigure(wrapToggle.checked ? EditorView.lineWrapping : [])
  });
});

followToggle.addEventListener("change", () => {
  followMode = followToggle.checked;
  if (followMode && currentPath && !dirty) {
    // Clear any pending prompt and jump to the end right away.
    pendingDiskHash = null;
    void followReload();
  }
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
applyPreviewBackground();
applyViewMode(viewMode);
updateDirtyState();
updateCursorStatus();
// Poll for external changes — quicker while following a log, relaxed otherwise.
async function pollExternalChange() {
  await checkExternalFileChange();
  window.setTimeout(() => void pollExternalChange(), followMode ? 1000 : 3000);
}
window.setTimeout(() => void pollExternalChange(), 3000);

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
