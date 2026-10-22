/**
 * myrmidon(OPE-6168): provider "input too long / context overflow" errors.
 *
 * These are deterministic: re-sending the same (or a larger) session to the
 * provider fails the same way, so they are neither transient nor a quota wall.
 * The adapter marks them with errorFamily "input_overflow" and the server uses
 * the same table on historical/other-adapter failures that arrive without the
 * field. Add new provider wordings here, with a row in input-overflow.test.ts.
 */

export const INPUT_OVERFLOW_ERROR_FAMILY = "input_overflow" as const;

export interface InputOverflowMatch {
  provider: string;
  pattern: string;
}

const INPUT_OVERFLOW_PATTERNS: ReadonlyArray<{
  provider: string;
  pattern: string;
  re: RegExp;
}> = [
  {
    provider: "dashscope",
    pattern: "Range of input length should be",
    re: /range of input length should be/i,
  },
  {
    provider: "openai",
    pattern: "context_length_exceeded",
    re: /context_length_exceeded/i,
  },
  {
    provider: "openai",
    pattern: "maximum context length is N tokens",
    re: /maximum context length is \d+/i,
  },
  {
    provider: "anthropic",
    pattern: "prompt is too long",
    re: /prompt is too long/i,
  },
  {
    provider: "gemini",
    pattern: "input token count exceeds the maximum",
    re: /input token count[^\n]{0,80}exceeds the maximum/i,
  },
  {
    provider: "generic",
    pattern: "maximum context length",
    re: /maximum context (?:length|window)/i,
  },
  {
    provider: "generic",
    pattern: "context window exceeded",
    re: /context (?:length|window) (?:exceeded|limit)|exceeds? the (?:model'?s )?context (?:length|window)/i,
  },
  {
    provider: "generic",
    pattern: "input is too long",
    re: /(?:input|request|message|messages) (?:is |are )?too (?:long|large)/i,
  },
];

export function classifyInputOverflow(
  ...texts: Array<string | null | undefined>
): InputOverflowMatch | null {
  const text = texts.filter((value): value is string => typeof value === "string").join("\n");
  if (!text) return null;
  for (const entry of INPUT_OVERFLOW_PATTERNS) {
    if (entry.re.test(text)) return { provider: entry.provider, pattern: entry.pattern };
  }
  return null;
}
