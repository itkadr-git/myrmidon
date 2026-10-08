// server/src/myrmidon/debates/gateway.ts
//
// myrmidon(1.7-DEBATE-ASYM-A): the gateway-backed model call for the debate
// engine, and the settings contour around it.
//
// The same contour the evals judge uses: a base URL, the *name* of the company
// secret holding the key, and a model per call. The debate contour reads its
// own environment variables first and falls back to the evals contour, so an
// instance that already configured MYRMIDON_EVALS_BASE_URL gets debates
// without a second setting. The key is resolved per company on every run —
// never the value, never cached.
//
// Usage accounting: the gateway's `usage` field when present, otherwise a
// conservative character/4 estimate for input and output, so the token ceiling
// bounds every response shape.

import type { DebateModelCall } from "@paperclipai/shared";

export const DEBATE_BASE_URL_ENV = "MYRMIDON_DEBATE_BASE_URL";
export const DEBATE_KEY_SECRET_ENV = "MYRMIDON_DEBATE_KEY_SECRET";
export const DEBATE_TIMEOUT_SEC_ENV = "MYRMIDON_DEBATE_TIMEOUT_SEC";
// Fallback contour (1.6-EVALS): the same gateway already configured for judge runs.
export const EVALS_BASE_URL_ENV = "MYRMIDON_EVALS_BASE_URL";
export const EVALS_KEY_SECRET_ENV = "MYRMIDON_EVALS_KEY_SECRET";

export interface DebateGatewaySettings {
  /** Off unless a base URL and a key secret name are both resolvable. */
  enabled: boolean;
  baseUrl: string | null;
  /** Company secret name holding the gateway key; never the value. */
  keySecret: string | null;
  timeoutMs: number;
}

export function readDebateGatewaySettings(env: NodeJS.ProcessEnv = process.env): DebateGatewaySettings {
  const baseUrl = env[DEBATE_BASE_URL_ENV]?.trim() || env[EVALS_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[DEBATE_KEY_SECRET_ENV]?.trim() || env[EVALS_KEY_SECRET_ENV]?.trim() || null;
  const timeoutRaw = Number(env[DEBATE_TIMEOUT_SEC_ENV]?.trim() ?? "");
  const timeoutSec =
    Number.isInteger(timeoutRaw) && timeoutRaw >= 5 && timeoutRaw <= 600 ? timeoutRaw : 120;
  return {
    enabled: Boolean(baseUrl && keySecret),
    baseUrl,
    keySecret,
    timeoutMs: timeoutSec * 1000,
  };
}

/** Why the gateway cannot run; names settings, never values. */
export function debateGatewayProblem(settings: DebateGatewaySettings): string | null {
  if (settings.baseUrl && settings.keySecret) return null;
  const missing = [
    settings.baseUrl ? null : `${DEBATE_BASE_URL_ENV} (or ${EVALS_BASE_URL_ENV})`,
    settings.keySecret ? null : `${DEBATE_KEY_SECRET_ENV} (or ${EVALS_KEY_SECRET_ENV})`,
  ].filter((name): name is string => name !== null);
  return `the debate gateway is not configured on this instance: set ${missing.join(" and ")}`;
}

/** `/v1/chat/completions` unless the address already ends with `/v1`. */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** Character/4 fallback for responses without a usage field. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface DebateGatewayDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
}

/**
 * The real DebateModelCall: one OpenAI-compatible chat-completions request per
 * role turn. The role config carries the model id; the temperature stays 0 so
 * a debate replay is deterministic for its inputs.
 */
export function createDebateGatewayCall(deps: DebateGatewayDeps): DebateModelCall {
  const url = chatCompletionsUrl(deps.baseUrl);
  return async (roleConfig, systemPrompt, userPrompt) => {
    let response: Response;
    try {
      response = await deps.fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: roleConfig.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt },
          ],
          temperature: 0,
        }),
        signal: AbortSignal.timeout(deps.timeoutMs),
      });
    } catch (error) {
      throw new Error(`the debate gateway call for model "${roleConfig.model}" failed: ${(error as Error).message}`);
    }
    if (!response.ok) {
      throw new Error(`the debate gateway answered ${response.status} for model "${roleConfig.model}"`);
    }
    const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = body.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`the debate gateway returned no text for model "${roleConfig.model}"`);
    }
    const rawPrompt = body.usage?.prompt_tokens;
    const rawCompletion = body.usage?.completion_tokens;
    const inputTokens =
      typeof rawPrompt === "number" && Number.isFinite(rawPrompt) && rawPrompt >= 0
        ? rawPrompt
        : estimateTokens(systemPrompt) + estimateTokens(userPrompt);
    const outputTokens =
      typeof rawCompletion === "number" && Number.isFinite(rawCompletion) && rawCompletion >= 0
        ? rawCompletion
        : estimateTokens(content);
    return { text: content, usage: { inputTokens, outputTokens } };
  };
}
