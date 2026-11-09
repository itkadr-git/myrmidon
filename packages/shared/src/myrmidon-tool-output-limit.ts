import { z } from "zod";

/**
 * myrmidon(1.6.7-TOKENS-TOOL-OUTPUT): configurable tool output length limit
 * for model-facing results, with full text preserved in traces / workspace files.
 *
 * DreamTeam docs/SPEC.md §12 pattern:
 * MCPForge.call truncates model-facing result to max_chars (agents.tool_output_chars),
 * full output preserved in span/trace.
 */
export const TOOL_OUTPUT_LIMIT_SETTINGS_KEY = "toolOutputLimit";

export const toolOutputLimitSettingsSchema = z
  .object({
    maxChars: z.number().int().min(0).max(1_000_000).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export type ToolOutputLimitSettings = z.infer<typeof toolOutputLimitSettingsSchema>;

export interface TruncateToolOutputResult {
  truncated: boolean;
  text: string;
  shownChars: number;
  totalChars: number;
  fullTextPath?: string;
}

/**
 * Required notice format (frozen by OPE-10730 acceptance criteria):
 * «показано N из M символов, полный текст — <путь>»
 */
export function formatToolOutputTruncationNotice(
  shownChars: number,
  totalChars: number,
  fullTextPath: string,
): string {
  return `показано ${shownChars} из ${totalChars} символов, полный текст — ${fullTextPath}`;
}

/**
 * Truncate a tool result text if it exceeds maxChars.
 * Returns the original text if below or at the limit.
 */
export function truncateToolOutputText(params: {
  text: string;
  maxChars?: number | null;
  fullTextPath?: string;
}): TruncateToolOutputResult {
  const { text, maxChars, fullTextPath = "trace" } = params;
  if (!maxChars || maxChars <= 0 || text.length <= maxChars) {
    return {
      truncated: false,
      text,
      shownChars: text.length,
      totalChars: text.length,
    };
  }

  const shownChars = maxChars;
  const totalChars = text.length;
  const notice = formatToolOutputTruncationNotice(shownChars, totalChars, fullTextPath);
  const truncatedText = `${text.slice(0, maxChars)}\n\n... [${notice}]`;

  return {
    truncated: true,
    text: truncatedText,
    shownChars,
    totalChars,
    fullTextPath,
  };
}

/**
 * Resolves the effective tool output character limit.
 * Priority:
 * 1. Agent card override (`runtimeConfig` or `adapterConfig`: `toolOutputChars`, `tool_output_chars`, `toolOutputMaxChars`)
 * 2. Instance settings (`toolOutputChars` or `toolOutputLimit.maxChars`)
 * 3. Environment variable fallback (`MYRMIDON_TOOL_OUTPUT_MAX_CHARS` / `TOOL_OUTPUT_MAX_CHARS`)
 */
export function resolveToolOutputLimit(input: {
  instanceSettings?: { toolOutputLimit?: { maxChars?: number; enabled?: boolean }; toolOutputChars?: number } | null;
  agentCardConfig?: Record<string, unknown> | null;
  env?: Record<string, string | undefined>;
}): number | null {
  const env =
    input.env ??
    ((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {});

  // 1. Agent card override wins
  if (input.agentCardConfig && typeof input.agentCardConfig === "object") {
    const cardLimit =
      input.agentCardConfig.toolOutputChars ??
      input.agentCardConfig.tool_output_chars ??
      input.agentCardConfig.toolOutputMaxChars;
    if (typeof cardLimit === "number" && Number.isFinite(cardLimit)) {
      return cardLimit > 0 ? Math.floor(cardLimit) : null;
    }
  }

  // 2. Instance settings
  if (input.instanceSettings) {
    if (typeof input.instanceSettings.toolOutputChars === "number") {
      const v = input.instanceSettings.toolOutputChars;
      return v > 0 ? Math.floor(v) : null;
    }
    const limitObj = input.instanceSettings.toolOutputLimit;
    if (limitObj && limitObj.enabled !== false && typeof limitObj.maxChars === "number") {
      return limitObj.maxChars > 0 ? Math.floor(limitObj.maxChars) : null;
    }
  }

  // 3. Environment variable fallback
  const envVal = env.MYRMIDON_TOOL_OUTPUT_MAX_CHARS || env.TOOL_OUTPUT_MAX_CHARS;
  if (envVal) {
    const parsed = parseInt(envVal, 10);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  return null;
}
