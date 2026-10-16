/**
 * myrmidon(OPE-6168): the model input limit, checked BEFORE a run is sent.
 *
 * The board knows each model's input limit from the model catalog
 * (`litellm_models.maxInputTokens`) and may be overridden per agent. The server
 * puts the resolved limit into the run's adapter config as `inputLimit`
 * (`InputLimitHint`); the adapter then keeps what it assembles under the
 * budget: a prompt over the budget is trimmed (head and tail kept, the middle
 * replaced by an explicit marker) instead of being sent to a provider that will
 * reject it. The server separately starts a fresh session when the session's
 * accumulated prompts would not fit (see server/src/myrmidon/input-limit).
 *
 * Pure functions only: no I/O, shared by the board and the adapters.
 */

/** Key of the hint inside the run's adapter config. */
export const INPUT_LIMIT_CONFIG_KEY = "inputLimit" as const;

/** Characters per token used to convert a token limit (and back). Conservative: real text is 3-4. */
export const DEFAULT_CHARS_PER_TOKEN = 3;
/** Share of the limit a request may use; the rest absorbs estimation error and the reply framing. */
export const DEFAULT_INPUT_LIMIT_SAFETY = 0.9;
/** A trimmed prompt never shrinks below this many characters, whatever the limit says. */
export const MIN_TRIMMED_INPUT_CHARS = 4_000;

export interface InputLimitHint {
  /** Model the limit belongs to (informational). */
  model: string | null;
  /** Where the limit came from: the model catalog or an explicit agent override. */
  source: "catalog" | "config";
  /** Provider limit in tokens, when known. */
  maxInputTokens: number | null;
  /** Provider limit in characters, when known (an override or a character-counted provider). */
  maxInputChars: number | null;
  charsPerToken: number;
  safety: number;
}

function positiveNumber(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Reads the hint the server wrote into the adapter config; null when absent or without any limit. */
export function readInputLimitHint(value: unknown): InputLimitHint | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const maxInputTokens = positiveNumber(record.maxInputTokens);
  const maxInputChars = positiveNumber(record.maxInputChars);
  if (maxInputTokens === null && maxInputChars === null) return null;
  const safety = positiveNumber(record.safety);
  return {
    model: typeof record.model === "string" && record.model.length > 0 ? record.model : null,
    source: record.source === "config" ? "config" : "catalog",
    maxInputTokens: maxInputTokens === null ? null : Math.floor(maxInputTokens),
    maxInputChars: maxInputChars === null ? null : Math.floor(maxInputChars),
    charsPerToken: positiveNumber(record.charsPerToken) ?? DEFAULT_CHARS_PER_TOKEN,
    safety: safety !== null && safety <= 1 ? safety : DEFAULT_INPUT_LIMIT_SAFETY,
  };
}

/** The tightest limit in characters (the smaller of the explicit one and the token one converted). */
export function inputLimitChars(hint: InputLimitHint): number {
  const fromTokens = hint.maxInputTokens === null ? Number.POSITIVE_INFINITY : hint.maxInputTokens * hint.charsPerToken;
  const explicit = hint.maxInputChars === null ? Number.POSITIVE_INFINITY : hint.maxInputChars;
  return Math.floor(Math.min(fromTokens, explicit));
}

/** The tightest limit in tokens. */
export function inputLimitTokens(hint: InputLimitHint): number {
  const fromChars = hint.maxInputChars === null ? Number.POSITIVE_INFINITY : hint.maxInputChars / hint.charsPerToken;
  const explicit = hint.maxInputTokens === null ? Number.POSITIVE_INFINITY : hint.maxInputTokens;
  return Math.floor(Math.min(fromChars, explicit));
}

/** What one request may carry, in characters. */
export function inputBudgetChars(hint: InputLimitHint): number {
  return Math.max(1, Math.floor(inputLimitChars(hint) * hint.safety));
}

/** What one request may carry, in tokens. */
export function inputBudgetTokens(hint: InputLimitHint): number {
  return Math.max(1, Math.floor(inputLimitTokens(hint) * hint.safety));
}

export function estimateTokensFromChars(chars: number, charsPerToken: number = DEFAULT_CHARS_PER_TOKEN): number {
  return Math.ceil(Math.max(0, chars) / charsPerToken);
}

export type InputLimitDecision =
  | { action: "send"; promptChars: number; budgetChars: number }
  | { action: "trim"; promptChars: number; budgetChars: number; targetInputChars: number };

/**
 * Decides what to do with a request made of `instructionsChars` (kept as is)
 * and `inputChars` (the part that can be trimmed).
 */
export function decideInputLimit(input: {
  hint: InputLimitHint;
  instructionsChars: number;
  inputChars: number;
}): InputLimitDecision {
  const budgetChars = inputBudgetChars(input.hint);
  const promptChars = input.instructionsChars + input.inputChars;
  if (promptChars <= budgetChars) return { action: "send", promptChars, budgetChars };
  const targetInputChars = Math.max(MIN_TRIMMED_INPUT_CHARS, budgetChars - input.instructionsChars);
  return { action: "trim", promptChars, budgetChars, targetInputChars: Math.min(targetInputChars, input.inputChars) };
}

export interface TrimResult {
  text: string;
  removedChars: number;
}

/**
 * Cuts `text` down to at most `maxChars` characters (marker included): keeps the
 * head (identity and contract of a prompt) and the tail (the newest wake
 * context), and says so in the middle.
 */
export function trimTextToChars(text: string, maxChars: number): TrimResult {
  if (text.length <= maxChars) return { text, removedChars: 0 };
  const buildMarker = (removed: number) =>
    `\n\n[... ${removed} characters omitted: the request exceeded the model input limit; ` +
    `open the issue for the full context ...]\n\n`;
  // The marker states the removed count, which depends on how much is kept: iterate to a fixed point.
  let keep = Math.max(0, maxChars - buildMarker(text.length).length);
  for (let i = 0; i < 4; i += 1) {
    const next = Math.max(0, maxChars - buildMarker(text.length - keep).length);
    if (next === keep) break;
    keep = Math.min(keep, next);
  }
  const headChars = Math.ceil(keep * 0.6);
  const tailChars = keep - headChars;
  const trimmed =
    text.slice(0, headChars) + buildMarker(text.length - keep) + (tailChars > 0 ? text.slice(text.length - tailChars) : "");
  return { text: trimmed, removedChars: text.length - keep };
}
