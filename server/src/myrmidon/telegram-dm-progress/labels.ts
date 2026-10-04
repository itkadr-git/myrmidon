// server/src/myrmidon/telegram-dm-progress/labels.ts
//
// myrmidon(DM-PROGRESS): turn a tool call into a short phrase in the owner's
// language for the live Telegram DM status message — "читаю deck.pptx",
// "правлю слайды 4, 9", "выполняю команду", "проверяю результат".
//
// Pure functions, no I/O. The only parts of a tool's arguments that may reach
// the provider are a file basename and slide numbers taken from the short
// preview the adapter already redacted; the preview is redacted again here
// and everything else in it is dropped. Unknown tools fall back to
// "инструмент: <name>" with the name sanitized and truncated.

import { redactSensitiveText } from "../../redaction.js";

/** The step families the throttle compares ("did the work change kind?"). */
export type DmProgressStepKind =
  | "read"
  | "edit"
  | "shell"
  | "check"
  | "search_files"
  | "web_search"
  | "web_page"
  | "image"
  | "delegate"
  | "think"
  | "plan"
  | "memory"
  | "answer"
  | "tool";

export interface DmProgressStepLabel {
  kind: DmProgressStepKind;
  label: string;
}

const MAX_TOOL_NAME_CHARS = 40;
const MAX_TARGET_CHARS = 60;
const MAX_PREVIEW_SCAN_CHARS = 400;

const READ_TOOLS = new Set([
  "read",
  "read_file",
  "readfile",
  "view",
  "view_file",
  "cat",
  "open_file",
  "file_read",
  "get_file",
  "notebookread",
]);
const EDIT_TOOLS = new Set([
  "write",
  "write_file",
  "writefile",
  "edit",
  "edit_file",
  "multiedit",
  "patch",
  "patch_file",
  "apply_patch",
  "str_replace",
  "str_replace_editor",
  "create_file",
  "file_write",
  "notebookedit",
]);
const SHELL_TOOLS = new Set([
  "$",
  "terminal",
  "shell",
  "bash",
  "exec",
  "execute",
  "execute_code",
  "code",
  "run",
  "run_command",
  "command",
  "process",
  "proc",
]);
const SEARCH_FILE_TOOLS = new Set(["grep", "find", "glob", "search_files", "ls", "list_files", "list_directory"]);
const WEB_SEARCH_TOOLS = new Set(["web_search", "websearch", "search", "research"]);
const WEB_PAGE_TOOLS = new Set([
  "fetch",
  "web_fetch",
  "webfetch",
  "web_extract",
  "crawl",
  "browser",
  "navigate",
  "snapshot",
  "click",
  "scroll",
  "press",
  "back",
]);
const IMAGE_TOOLS = new Set(["vision", "vision_analyze", "images", "browser_vision", "browser_get_images", "image", "view_image"]);
const DELEGATE_TOOLS = new Set(["delegate", "delegate_task", "task", "agent", "subagent", "spawn_agent"]);
const THINK_TOOLS = new Set(["reasoning", "think", "thinking"]);
const PLAN_TOOLS = new Set(["plan", "todo", "todowrite", "update_plan"]);
const MEMORY_TOOLS = new Set(["memory", "recall", "session_search"]);

const CHECK_NAME_PATTERN = /(^|[_\-.])(test|tests|check|verify|validate|lint|typecheck)([_\-.]|$)/;
const CHECK_COMMAND_PATTERN = /\b(test|tests|vitest|jest|pytest|tsc|typecheck|lint|eslint|verify|check)\b/i;

const DOCUMENT_NOUNS: Record<string, string> = {
  pptx: "презентацию",
  ppt: "презентацию",
  odp: "презентацию",
  key: "презентацию",
  docx: "документ",
  doc: "документ",
  odt: "документ",
  rtf: "документ",
  xlsx: "таблицу",
  xls: "таблицу",
  ods: "таблицу",
  csv: "таблицу",
  pdf: "PDF",
  png: "изображение",
  jpg: "изображение",
  jpeg: "изображение",
  webp: "изображение",
  gif: "изображение",
  svg: "изображение",
};

function collapse(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(1, maxChars - 1))}…`;
}

/**
 * A tool name as the comparison key: MCP-style prefixes (`mcp__server__tool`)
 * and namespaces (`server.tool`, `server/tool`) reduce to the last segment.
 */
export function normalizeDmProgressToolName(toolName: string): string {
  const lowered = collapse(toolName).toLowerCase();
  const segments = lowered.split(/__|[./]/).filter((segment) => segment.length > 0);
  return segments.length > 0 ? segments[segments.length - 1]! : lowered;
}

function safeToolName(toolName: string): string {
  const redacted = redactSensitiveText(collapse(toolName));
  return truncate(redacted.replace(/[^\p{L}\p{N}_\-.:$]/gu, ""), MAX_TOOL_NAME_CHARS) || "?";
}

/** Slide numbers named in a preview: "slides 4, 9" / "слайды 4 и 9" → "4, 9". */
function slideNumbers(preview: string): string | null {
  const match = preview.match(/(?:slides?|слайд(?:ы|ов|а)?)\s*(?:#|№)?\s*(\d{1,3}(?:\s*(?:,|и|and|-|–)\s*\d{1,3}){0,7})/i);
  if (!match?.[1]) return null;
  const numbers = match[1].match(/\d{1,3}/g) ?? [];
  if (numbers.length === 0) return null;
  return numbers.slice(0, 8).join(", ");
}

/** The basename of the first file-looking token of a preview. */
function fileBasename(preview: string): string | null {
  const match = preview.match(/[\p{L}\p{N}_\-.~/\\]*[\p{L}\p{N}_\-]\.[A-Za-z0-9]{1,6}(?![\p{L}\p{N}])/u);
  if (!match) return null;
  const token = match[0];
  const basename = token.split(/[/\\]/).filter((part) => part.length > 0).pop() ?? "";
  if (!basename || /^\.+$/.test(basename)) return null;
  // A bare domain or version string ("example.com", "1.2") is not a file.
  if (/^\d+(?:\.\d+)+$/.test(basename)) return null;
  return truncate(basename, MAX_TARGET_CHARS);
}

/**
 * The provider-safe target of a read/edit step: slide numbers when the
 * preview names slides, else a document noun plus the file basename, else
 * null (the caller uses a generic noun). Nothing else from the preview is kept.
 */
export function describeDmProgressTarget(preview: string | null | undefined): string | null {
  if (!preview) return null;
  const safe = collapse(redactSensitiveText(collapse(preview).slice(0, MAX_PREVIEW_SCAN_CHARS)));
  if (!safe) return null;
  const slides = slideNumbers(safe);
  if (slides) return slides.includes(",") ? `слайды ${slides}` : `слайд ${slides}`;
  const basename = fileBasename(safe);
  if (!basename) return null;
  const extension = basename.split(".").pop()?.toLowerCase() ?? "";
  const noun = DOCUMENT_NOUNS[extension];
  return noun ? `${noun} ${basename}` : basename;
}

/**
 * The owner-language label of one tool call. `preview` is the adapter's short
 * argument preview (a command line, a path, a query); it only ever
 * contributes a basename or slide numbers to the label.
 */
export function dmProgressToolLabel(input: {
  toolName: string;
  preview?: string | null;
}): DmProgressStepLabel {
  const name = normalizeDmProgressToolName(input.toolName);
  const preview = input.preview ?? null;

  if (READ_TOOLS.has(name)) {
    return { kind: "read", label: `читаю ${describeDmProgressTarget(preview) ?? "файл"}` };
  }
  if (EDIT_TOOLS.has(name)) {
    return { kind: "edit", label: `правлю ${describeDmProgressTarget(preview) ?? "файл"}` };
  }
  if (SHELL_TOOLS.has(name)) {
    if (preview && CHECK_COMMAND_PATTERN.test(preview.slice(0, MAX_PREVIEW_SCAN_CHARS))) {
      return { kind: "check", label: "проверяю результат" };
    }
    return { kind: "shell", label: "выполняю команду" };
  }
  if (CHECK_NAME_PATTERN.test(name)) return { kind: "check", label: "проверяю результат" };
  if (SEARCH_FILE_TOOLS.has(name)) return { kind: "search_files", label: "ищу в файлах" };
  if (IMAGE_TOOLS.has(name)) return { kind: "image", label: "смотрю изображение" };
  if (WEB_SEARCH_TOOLS.has(name)) return { kind: "web_search", label: "ищу в интернете" };
  if (WEB_PAGE_TOOLS.has(name) || name.startsWith("browser_") || name.startsWith("browser")) {
    return { kind: "web_page", label: "открываю страницу" };
  }
  if (DELEGATE_TOOLS.has(name)) return { kind: "delegate", label: "запускаю помощника" };
  if (THINK_TOOLS.has(name)) return { kind: "think", label: "думаю" };
  if (PLAN_TOOLS.has(name)) return { kind: "plan", label: "составляю план" };
  if (MEMORY_TOOLS.has(name)) return { kind: "memory", label: "вспоминаю контекст" };
  if (name === "clarify") return { kind: "tool", label: "уточняю задачу" };
  return { kind: "tool", label: `инструмент: ${safeToolName(input.toolName)}` };
}

/** The label of the reasoning phase ("Reasoning" runtime status, 💭 lines). */
export const DM_PROGRESS_THINK_LABEL: DmProgressStepLabel = { kind: "think", label: "думаю" };

/** The label of the agent streaming its answer text. */
export const DM_PROGRESS_ANSWER_LABEL: DmProgressStepLabel = { kind: "answer", label: "пишу ответ" };
