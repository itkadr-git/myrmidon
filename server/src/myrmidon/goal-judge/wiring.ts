// server/src/myrmidon/goal-judge/wiring.ts
//
// myrmidon(1.7-GOAL-JUDGE): binds the goal judge to company model providers,
// secret store, and instance settings.
//
// Patterned after agent-exchange (server/src/myrmidon/agent-exchange/wiring.ts):
// OpenAI-compatible chat-completions on company modelProviders + secret store
// (apiKey resolved per call, never reaches a log line or response), temperature 0.

import { eq } from "drizzle-orm";
import { modelProviders, type Db } from "@myrmidon/db";
import { MODEL_PROVIDER_DEFAULT_BASE_URLS } from "@myrmidon/shared";
import { secretService } from "../../services/index.js";
import {
  MAX_ROUNDS,
  GoalJudgeSession,
  type GoalJudgeInput,
  type GoalJudgeRoundResult,
  type GoalJudgeVerdict,
} from "./domain.js";
import {
  GOAL_JUDGE_SYSTEM_PROMPT,
  buildGoalJudgeUserPrompt,
  buildGoalJudgeRetryPrompt,
} from "./prompts.js";
import type { GoalJudgeSettingsService } from "./settings.js";

/** The chat-completions URL of a provider (/v1 aware). */
export function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return /\/v1$/.test(trimmed) ? `${trimmed}/chat/completions` : `${trimmed}/v1/chat/completions`;
}

/** The text of an OpenAI-style message content (a string, or text parts). */
export function readChatText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
      )
      .filter((part) => part.length > 0)
      .join("\n");
  }
  return "";
}

export interface GoalJudgeModelCallInput {
  providerId: string;
  model: string;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  temperature?: number;
  timeoutMs?: number;
}

export interface GoalJudgeModelCallResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface GoalJudgeModelPort {
  call(input: GoalJudgeModelCallInput): Promise<GoalJudgeModelCallResult>;
}

export interface GoalJudgeSecretsPort {
  getByName(companyId: string, name: string): Promise<{ id: string } | null>;
  resolveSecretValue(companyId: string, secretId: string, version: string): Promise<string | null>;
}

/**
 * Creates the model port backed by company model providers and secret store.
 * The secret key is resolved on demand per call and is never included in
 * return values, logs, or error text.
 */
export function createGoalJudgeModelPort(
  db: Db,
  companyId: string,
  fetchFn: typeof fetch = fetch,
  secretsSvc?: GoalJudgeSecretsPort,
): GoalJudgeModelPort {
  const secrets = secretsSvc ?? secretService(db);

  return {
    async call(input: GoalJudgeModelCallInput): Promise<GoalJudgeModelCallResult> {
      const provider = await db
        .select({
          id: modelProviders.id,
          type: modelProviders.type,
          baseUrl: modelProviders.baseUrl,
          credentialSecretName: modelProviders.credentialSecretName,
        })
        .from(modelProviders)
        .where(eq(modelProviders.id, input.providerId))
        .then((rows) => rows[0] ?? null);

      if (!provider) throw new Error(`provider_not_found:${input.providerId}`);

      const baseUrl =
        provider.baseUrl ??
        MODEL_PROVIDER_DEFAULT_BASE_URLS[provider.type as keyof typeof MODEL_PROVIDER_DEFAULT_BASE_URLS] ??
        null;
      if (!baseUrl) throw new Error(`provider_no_base_url:${provider.type}`);
      if (!provider.credentialSecretName) throw new Error(`provider_no_key:${provider.id}`);

      const secretRow = await secrets.getByName(companyId, provider.credentialSecretName);
      const apiKey = secretRow
        ? await secrets.resolveSecretValue(companyId, secretRow.id, "latest")
        : null;
      if (!apiKey) throw new Error(`provider_key_unreadable:${provider.id}`);

      const response = await fetchFn(chatCompletionsUrl(baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: input.model,
          temperature: input.temperature ?? 0,
          messages: input.messages,
        }),
        signal: input.timeoutMs ? AbortSignal.timeout(input.timeoutMs) : undefined,
      });

      if (!response.ok) {
        throw new Error(`provider_http_${response.status}`);
      }

      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      const content = readChatText(payload.choices?.[0]?.message?.content);
      if (content.trim().length === 0) {
        throw new Error("provider_empty_answer");
      }

      return {
        content,
        promptTokens: payload.usage?.prompt_tokens ?? 0,
        completionTokens: payload.usage?.completion_tokens ?? 0,
      };
    },
  };
}

export interface GoalJudgeControllerDeps {
  settings: Pick<GoalJudgeSettingsService, "read">;
  models: GoalJudgeModelPort;
}

export interface GoalJudgeEvaluationResult {
  executed: boolean;
  skippedReason?: string;
  verdict: GoalJudgeVerdict | null;
  session: GoalJudgeSession;
  error?: string;
}

/**
 * Controller evaluating task criteria using the goal judge model.
 *
 * Invariant 1: If the instance switch is off (`settings.enabled === false`),
 * the controller does NOT call the model.
 * Invariant 2: When enabled, the model call is directed strictly to the
 * configured judge provider and model.
 * Invariant 3: Non-JSON model outputs do not throw, but are recorded as round errors.
 */
export async function evaluateGoalJudge(
  deps: GoalJudgeControllerDeps,
  input: GoalJudgeInput,
): Promise<GoalJudgeEvaluationResult> {
  const settings = await deps.settings.read();

  // Switch off: do NOT call the model
  if (!settings.enabled) {
    return {
      executed: false,
      skippedReason: "goal_judge_disabled",
      verdict: null,
      session: new GoalJudgeSession({ maxRounds: settings.maxRounds ?? MAX_ROUNDS }),
    };
  }

  if (!settings.providerId || !settings.model) {
    throw new Error("goal_judge_unconfigured: providerId and model required");
  }

  const maxRounds = settings.maxRounds ?? MAX_ROUNDS;
  const session = new GoalJudgeSession({ maxRounds });
  let lastError: string | undefined;

  while (session.canContinue()) {
    const currentRound = session.currentRound + 1;
    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [
      { role: "system", content: GOAL_JUDGE_SYSTEM_PROMPT },
    ];

    if (currentRound === 1) {
      messages.push({
        role: "user",
        content: buildGoalJudgeUserPrompt(input, { round: 1, maxRounds }),
      });
    } else {
      const prevRound = session.rounds[session.rounds.length - 1];
      if (prevRound?.rawResponse) {
        messages.push({
          role: "assistant",
          content: prevRound.rawResponse,
        });
      }
      messages.push({
        role: "user",
        content: buildGoalJudgeRetryPrompt(lastError ?? "Incomplete verdict", currentRound),
      });
    }

    let modelResult: GoalJudgeModelCallResult;
    try {
      modelResult = await deps.models.call({
        providerId: settings.providerId,
        model: settings.model,
        temperature: settings.temperature ?? 0,
        timeoutMs: settings.timeoutMs,
        messages,
      });
    } catch (err) {
      const roundErrorResult: GoalJudgeRoundResult = {
        roundNumber: currentRound,
        success: false,
        error: `Model call failed: ${err instanceof Error ? err.message : String(err)}`,
      };
      session.currentRound++;
      session.rounds.push(roundErrorResult);
      lastError = roundErrorResult.error;
      continue;
    }

    const stepResult = session.step(modelResult.content, input);
    if (stepResult.success && stepResult.verdict?.complete) {
      break;
    }
    lastError =
      stepResult.error ??
      (stepResult.verdict?.missing.length
        ? stepResult.verdict.missing.join("; ")
        : "Incomplete verdict");
  }

  return {
    executed: true,
    verdict: session.finalVerdict,
    session,
  };
}
