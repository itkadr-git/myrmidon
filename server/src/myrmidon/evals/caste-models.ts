import { and, asc, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { modelProviderModels, modelProviders } from "@myrmidon/db";
import { chatCompletionsUrl, EvalJudgeError } from "./judge.js";

export interface EvalCandidateModel {
  modelName: string;
  litellmModelName: string;
}

export interface CandidateAnswerInput {
  model: EvalCandidateModel;
  prompt: string;
  timeoutMs: number;
}

export type GenerateCandidateAnswer = (
  input: CandidateAnswerInput,
) => Promise<string>;

export const DEFAULT_CANDIDATE_TIMEOUT_MS = 120_000;

export interface CasteModelChatDeps {
  baseUrl: string;
  apiKey: string;
  fetch?: typeof fetch;
}

export function createCandidateAnswerGenerator(
  deps: CasteModelChatDeps,
): GenerateCandidateAnswer {
  const doFetch = deps.fetch ?? fetch;
  const url = chatCompletionsUrl(deps.baseUrl);
  return async ({ model, prompt, timeoutMs }) => {
    let response: Response;
    try {
      response = await doFetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deps.apiKey}`,
        },
        body: JSON.stringify({
          model: model.litellmModelName,
          temperature: 0,
          messages: [
            {
              role: "system",
              content: "You are an engineering agent. Answer the TASK with the finished artifact only.",
            },
            { role: "user", content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new EvalJudgeError(
        "judge_unreachable",
        `caste model candidate call failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    if (!response.ok) {
      throw new EvalJudgeError(
        "judge_http_error",
        `caste model candidate call returned HTTP ${response.status}`,
      );
    }
    const payload: unknown = await response.json();
    if (typeof payload !== "object" || payload === null || !("choices" in payload)) {
      throw new EvalJudgeError("judge_http_error", "caste model candidate call returned an invalid completion");
    }
    const choices = payload.choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      throw new EvalJudgeError("judge_http_error", "caste model candidate call returned no choices");
    }
    const first = choices[0];
    if (typeof first !== "object" || first === null || !("message" in first)) {
      throw new EvalJudgeError("judge_http_error", "caste model candidate call returned an invalid choice");
    }
    const message = first.message;
    if (typeof message !== "object" || message === null || !("content" in message)) {
      throw new EvalJudgeError("judge_http_error", "caste model candidate call returned no message");
    }
    const content = message.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new EvalJudgeError("judge_http_error", "caste model candidate call returned empty content");
    }
    return content;
  };
}

export async function freeEnabledModels(db: Db, companyId: string): Promise<EvalCandidateModel[]> {
  const rows = await db
    .select({
      modelName: modelProviderModels.modelName,
      litellmModelName: modelProviderModels.litellmModelName,
    })
    .from(modelProviderModels)
    .innerJoin(modelProviders, eq(modelProviderModels.providerId, modelProviders.id))
    .where(
      and(
        eq(modelProviders.companyId, companyId),
        eq(modelProviderModels.enabled, true),
        eq(modelProviderModels.free, true),
      ),
    )
    .orderBy(asc(modelProviderModels.modelName));
  const seen: Record<string, true> = {};
  const models: EvalCandidateModel[] = [];
  for (const row of rows) {
    if (seen[row.modelName]) continue;
    seen[row.modelName] = true;
    models.push({
      modelName: row.modelName,
      litellmModelName: row.litellmModelName ?? row.modelName,
    });
  }
  return models;
}
