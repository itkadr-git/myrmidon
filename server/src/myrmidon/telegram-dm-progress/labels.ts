// server/src/myrmidon/telegram-dm-progress/labels.ts
//
// myrmidon(DM-PROGRESS): turn a tool call into a short phrase in the owner's
// language for the live Telegram DM status message — "читаю deck.pptx" /
// "reading deck.pptx", "правлю слайды 4, 9" / "editing slides 4, 9".
//
// myrmidon(1.7-TG-LOCALE): the wording lives in the texts.ts catalog (ru and
// en); every label function takes the locale and renders the owner language
// at call time. A recorded step carries its kind and structured target, so
// the display language is chosen when the status message is composed, not
// when the step was recorded. Callers that omit the locale keep the fork's
// historical ru wording byte-for-byte.
//
// Pure functions, no I/O. The only parts of a tool's arguments that may reach
// the provider are a file basename and slide numbers taken from the short
// preview the adapter already redacted; the preview is redacted again here
// and everything else in it is dropped. Unknown tools fall back to
// "инструмент: <name>" with the name sanitized and truncated.

import { redactSensitiveText } from "../../redaction.js";
import {
  dmProgressTexts,
  type DmProgressStepKind,
  type DmProgressStepLabel,
  type DmProgressTarget,
  type DmProgressTextLocale,
} from "./texts.js";

export type {
  DmProgressStepKind,
  DmProgressStepLabel,
  DmProgressTarget,
  DmProgressTextLocale,
};
export { dmProgressTexts } from "./texts.js";

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
  // A bare version string ("1.2", "10.11.3") is not a file.
  if (/^\d+(?:\.\d+)+$/.test(basename)) return null;
  return truncate(basename, MAX_TARGET_CHARS);
}

/**
 * The provider-safe structured target of a read/edit step: slide numbers when
 * the preview names slides, else a document noun extension plus the file
 * basename. Nothing else from the preview is kept; the preview is re-redacted
 * before anything is parsed out of it. Null when the preview names neither.
 */
export function extractDmProgressTarget(
  preview: string | null | undefined,
): DmProgressTarget | null {
  if (!preview) return null;
  const safe = collapse(redactSensitiveText(collapse(preview).slice(0, MAX_PREVIEW_SCAN_CHARS)));
  if (!safe) return null;
  const slides = slideNumbers(safe);
  if (slides) return { type: "slides", text: slides };
  const basename = fileBasename(safe);
  if (!basename) return null;
  const extension = basename.split(".").pop()?.toLowerCase() ?? "";
  return { type: "document", noun: extension, basename };
}

/**
 * The owner-language target phrase of a preview: "слайды 4, 9",
 * "презентацию deck.pptx", "deck.pdf". Everything but a basename or slide
 * numbers is dropped; the preview is re-redacted here. Locale defaults to
 * "ru" (the fork's historical wording); null when the preview names no
 * target at all.
 */
export function describeDmProgressTarget(
  preview: string | null | undefined,
  locale: DmProgressTextLocale | null | undefined = "ru",
): string | null {
  return formatDmProgressTarget(extractDmProgressTarget(preview), locale);
}

/** Render a structured target in the owner's language; null for no target. */
export function formatDmProgressTarget(
  target: DmProgressTarget | null | undefined,
  locale: DmProgressTextLocale | null | undefined,
): string | null {
  if (!target) return null;
  const texts = dmProgressTexts(locale);
  if (target.type === "slides") {
    return target.text.includes(",")
      ? `${texts.slides.plural} ${target.text}`
      : `${texts.slides.singular} ${target.text}`;
  }
  if (target.type === "file") return target.basename;
  const noun = texts.documentNouns[target.noun ?? ""];
  return noun ? `${noun} ${target.basename}` : target.basename ?? null;
}

/**
 * The owner-language label of one tool call. `preview` is the adapter's short
 * argument preview (a command line, a path, a query); it only ever
 * contributes a basename or slide numbers to the label, redacted again here.
 * Locale defaults to "ru" (the fork's historical wording).
 */
export function dmProgressToolLabel(input: {
  toolName: string;
  preview?: string | null;
  locale?: DmProgressTextLocale | null;
}): DmProgressStepLabel {
  const name = normalizeDmProgressToolName(input.toolName);
  const preview = input.preview ?? null;
  const texts = dmProgressTexts(input.locale);
  const target = formatDmProgressTarget(extractDmProgressTarget(preview), input.locale);

  if (READ_TOOLS.has(name)) {
    return { kind: "read", label: `${texts.verbs.read} ${target ?? texts.fileNoun}` };
  }
  if (EDIT_TOOLS.has(name)) {
    return { kind: "edit", label: `${texts.verbs.edit} ${target ?? texts.fileNoun}` };
  }
  if (SHELL_TOOLS.has(name)) {
    if (preview && CHECK_COMMAND_PATTERN.test(preview.slice(0, MAX_PREVIEW_SCAN_CHARS))) {
      return { kind: "check", label: texts.verbs.check };
    }
    return { kind: "shell", label: texts.verbs.shell };
  }
  if (CHECK_NAME_PATTERN.test(name)) return { kind: "check", label: texts.verbs.check };
  if (SEARCH_FILE_TOOLS.has(name)) return { kind: "search_files", label: texts.verbs.search_files };
  if (IMAGE_TOOLS.has(name)) return { kind: "image", label: texts.verbs.image };
  if (WEB_SEARCH_TOOLS.has(name)) return { kind: "web_search", label: texts.verbs.web_search };
  if (WEB_PAGE_TOOLS.has(name) || name.startsWith("browser")) {
    return { kind: "web_page", label: texts.verbs.web_page };
  }
  if (DELEGATE_TOOLS.has(name)) return { kind: "delegate", label: texts.verbs.delegate };
  if (THINK_TOOLS.has(name)) return { kind: "think", label: texts.verbs.think };
  if (PLAN_TOOLS.has(name)) return { kind: "plan", label: texts.verbs.plan };
  if (MEMORY_TOOLS.has(name)) return { kind: "memory", label: texts.verbs.memory };
  if (name === "clarify") return { kind: "tool", label: texts.clarify };
  return { kind: "tool", label: texts.toolPrefix(safeToolName(input.toolName)) };
}

/**
 * The label of the reasoning phase ("Reasoning" runtime status, 💭 lines).
 * Locale defaults to "ru" so the legacy callers keep their wording.
 */
export function dmProgressThinkLabel(locale: DmProgressTextLocale | null | undefined = "ru"): DmProgressStepLabel {
  return { kind: "think", label: dmProgressTexts(locale).verbs.think };
}

/** The label of the agent streaming its answer text; "ru" by default. */
export function dmProgressAnswerLabel(locale: DmProgressTextLocale | null | undefined = "ru"): DmProgressStepLabel {
  return { kind: "answer", label: dmProgressTexts(locale).verbs.answer };
}

/** The legacy exported labels (kind + ru text), kept for external imports. */
export const DM_PROGRESS_THINK_LABEL: DmProgressStepLabel = dmProgressThinkLabel();
export const DM_PROGRESS_ANSWER_LABEL: DmProgressStepLabel = dmProgressAnswerLabel();

/**
 * The language-independent facts of a recorded step: the kind and the tool
 * name, without any label text. The composer renders them per locale.
 */
export interface DmProgressStepFacts {
  kind: DmProgressStepKind;
  toolName: string | null;
}

/**
 * Render a recorded step's facts into the owner-language label. Read/edit
 * steps add the structured target ("правлю слайды 4, 9"); the unknown-tool
 * fallback renders the tool name ("инструмент: weirdtool").
 */
export function labelForStepFacts(
  facts: Pick<DmProgressStepFacts, "kind"> & {
    target?: DmProgressTarget | null;
    toolName?: string | null;
  },
  locale: DmProgressTextLocale | null | undefined,
): string {
  const texts = dmProgressTexts(locale);
  const target = formatDmProgressTarget(facts.target ?? null, locale);
  switch (facts.kind) {
    case "read":
      return `${texts.verbs.read} ${target ?? texts.fileNoun}`;
    case "edit":
      return `${texts.verbs.edit} ${target ?? texts.fileNoun}`;
    case "tool":
      return texts.toolPrefix(safeToolName(facts.toolName ?? "?"));
    default:
      return texts.verbs[facts.kind];
  }
}
