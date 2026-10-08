// server/src/myrmidon/evals/judge.ts
//
// myrmidon(1.6-EVALS): the LLM judge.
//
// The judge is one chat-completions call per task behind the company's LLM
// gateway (the same contour the OCR path uses: an address, the *name* of the
// company secret holding the key, and a model). The rule of the 1.6 wave
// applies: the default model is a free DashScope model, and the judge never
// executes code — for `code` tasks the CI pass rate arrives as a parameter
// and is folded into the score, not measured here.
//
// The judge prompt is deterministic given (task, answer): no temperature, no
// history, one JSON answer. The response is parsed strictly; an unusable
// response yields zero points for the task and a parse error flag, so a
// flaky judge degrades the run visibly instead of inventing scores.

import type { EvalRubric, EvalTaskKind } from "./domain.js";
// myrmidon(1.6.5 EVALS-JUDGE-FAMILY): family detection and candidate ordering
// live in one module now — the old inline QWEN_FAMILY_MODELS list only knew
// two families and the bare-substring table matched ids like `dolphin`
// (`phi`) or any id containing `yi`. `model-family.ts` is token-anchored.
import {
  DEFAULT_JUDGE_PRIORITY_MODELS,
  isSameJudgeFamily,
  judgeCandidateOrder,
} from "./model-family.js";

/** Env vars the evals contour reads; mirrors the OCR settings shape. */
export const EVALS_BASE_URL_ENV = "MYRMIDON_EVALS_BASE_URL";
export const EVALS_KEY_SECRET_ENV = "MYRMIDON_EVALS_KEY_SECRET";
export const EVALS_MODEL_ENV = "MYRMIDON_EVALS_MODEL";
export const EVALS_TIMEOUT_SEC_ENV = "MYRMIDON_EVALS_TIMEOUT_SEC";
export const EVALS_LANGFUSE_FLAG_ENV = "MYRMIDON_EVALS_LANGFUSE";
// myrmidon(1.6.3 EVALS-JUDGE-FAMILY): ordered judge fallback list.
export const EVALS_JUDGE_PRIORITY_MODELS_ENV = "MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS";

/**
 * Default model: a free DashScope model behind the gateway. The instance can
 * override it with MYRMIDON_EVALS_MODEL; paid models stay a deploy-repo
 * concern, per the wave rule.
 */
export const DEFAULT_EVALS_MODEL = "qwen-plus-free";

/**
 * myrmidon(1.6.3 EVALS-JUDGE-FAMILY): default judge priority list — every
 * entry is a model this deployment's gateway is contracted to serve
 * (`SERVED_FREE_GATEWAY_MODELS` in `model-family.ts`: the free qwen trio
 * main already ships; the old list mixed paid ids and branch #611 added
 * unverified ones like `glm-4-flash-free` that no gateway evidence backs).
 * Read on every run, so a change takes effect on the next evaluation
 * without a restart. When the operator lists nothing the candidates are
 * these served models; with no agent family to differ from the judge falls
 * back to `deps.model`.
 */
export const DEFAULT_EVALS_JUDGE_PRIORITY_MODELS: string[] = [...DEFAULT_JUDGE_PRIORITY_MODELS];

/**
 * myrmidon(1.6.3 EVALS-JUDGE-FAMILY): parse the comma-separated
 * MYRMIDON_EVALS_JUDGE_PRIORITY_MODELS value. Invalid input (empty after
 * trimming, no entries) falls back to the default list. Pure.
 */
export function parseJudgePriorityModels(raw: string | undefined): string[] {
  const models = (raw ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);
  return models.length > 0 ? models : DEFAULT_EVALS_JUDGE_PRIORITY_MODELS;
}

export interface EvalsSettings {
  /** Off unless a base URL and a key secret name are both configured. */
  enabled: boolean;
  baseUrl: string | null;
  /** Company secret name holding the gateway key; never the value. */
  keySecret: string | null;
  model: string;
  timeoutMs: number;
  /** Langfuse score export flag; scoring is written locally regardless. */
  langfuseExport: boolean;
  /** myrmidon(1.6.3 EVALS-JUDGE-FAMILY): ordered judge model fallback list. */
  judgeModels: string[];
}

export function readEvalsSettings(env: NodeJS.ProcessEnv = process.env): EvalsSettings {
  const baseUrl = env[EVALS_BASE_URL_ENV]?.trim() || null;
  const keySecret = env[EVALS_KEY_SECRET_ENV]?.trim() || null;
  const timeoutRaw = Number(env[EVALS_TIMEOUT_SEC_ENV]?.trim() ?? "");
  const timeoutSec =
    Number.isInteger(timeoutRaw) && timeoutRaw >= 5 && timeoutRaw <= 600 ? timeoutRaw : 120;
  const judgeModels = parseJudgePriorityModels(env[EVALS_JUDGE_PRIORITY_MODELS_ENV]);
  return {
    enabled: Boolean(baseUrl && keySecret),
    baseUrl,
    keySecret,
    model: env[EVALS_MODEL_ENV]?.trim() || DEFAULT_EVALS_MODEL,
    timeoutMs: timeoutSec * 1000,
    langfuseExport: (env[EVALS_LANGFUSE_FLAG_ENV]?.trim() || "").toLowerCase() === "true",
    judgeModels,
  };
}

/** Why the judge cannot run; names settings, never values. */
export function evalsSettingsProblem(settings: EvalsSettings): string | null {
  if (settings.baseUrl && settings.keySecret) return null;
  const missing = [
    settings.baseUrl ? null : EVALS_BASE_URL_ENV,
    settings.keySecret ? null : EVALS_KEY_SECRET_ENV,
  ].filter((name): name is string => name !== null);
  return `Evals are not configured on this instance: set ${missing.join(" and ")}`;
}

export class EvalJudgeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "EvalJudgeError";
    this.code = code;
  }
}

/** What the judge awards for one task. */
export interface JudgeTaskResult {
  taskSlug: string;
  /** criterion name -> points awarded. */
  awarded: Record<string, number>;
  /** True when the model response could not be parsed as a verdict. */
  parseError: boolean;
  /** The raw model text, kept for audit in `eval_runs.scores`. */
  raw: string | null;
  /** True when the judge and the agent being evaluated are from the same model family */
  sameFamily: boolean;
}

export interface JudgePort {
  /** Score one answer against one rubric. */
  judgeTask(input: {
    taskSlug: string;
    prompt: string;
    answer: string;
    rubric: EvalRubric;
    kind: EvalTaskKind;
    /** The model used by the agent being evaluated (to determine sameFamily) */
    agentModel?: string;
  }): Promise<JudgeTaskResult>;
}

export interface JudgeDeps {
  fetch: typeof fetch;
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /**
   * myrmidon(1.6.5 EVALS-JUDGE-FAMILY): ordered judge candidate list (the
   * priority list). When absent or empty the judge uses `model` only — the
   * pre-1.6.5 shape, which tests and the offline contour still pass.
   */
  judgeModels?: readonly string[];
}

/** `/v1/chat/completions` unless the address already ends with `/v1`. */
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1")
    ? `${trimmed}/chat/completions`
    : `${trimmed}/v1/chat/completions`;
}

function buildJudgePrompt(input: {
  prompt: string;
  answer: string;
  rubric: EvalRubric;
  kind: EvalTaskKind;
}): string {
  const criteria = input.rubric.criteria
    .map((c) => `- ${c.name}: ${c.description} (${c.points} points)`)
    .join("\n");
  return [
    "You are a strict but fair evaluation judge for engineering work.",
    "Score the ANSWER to the TASK against each rubric criterion.",
    "Award 0 to the criterion's full points per criterion. Use the full range: 0 for not addressed, half for partially addressed, full points for fully addressed.",
    input.kind === "code"
      ? "The task is a code task: judge the answer text only. Do not assume the code was executed."
      : "Judge the answer text only.",
    "",
    "TASK:",
    input.prompt,
    "",
    "ANSWER:",
    input.answer,
    "",
    "RUBRIC:",
    criteria,
    "",
    'Reply with ONLY a JSON object: {"criteria": {"<name>": <points awarded>}}',
    "Use every rubric criterion name exactly as written. No other text.",
  ].join("\n");
}

/**
 * Parse the judge response. Strict: the whole message must be one JSON
 * object (a leading code fence is tolerated), every rubric criterion must be
 * present, and every awarded value must be a number within [0, points].
 */
export function parseJudgeResponse(
  raw: string,
  rubric: EvalRubric,
): { awarded: Record<string, number>; parseError: boolean } {
  let text = raw.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/;
  const fenced = fence.exec(text);
  if (fenced) text = fenced[1]!.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { awarded: {}, parseError: true };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { awarded: {}, parseError: true };
  }
  const criteria = (parsed as { criteria?: unknown }).criteria;
  if (typeof criteria !== "object" || criteria === null) {
    return { awarded: {}, parseError: true };
  }
  const awarded: Record<string, number> = {};
  for (const c of rubric.criteria) {
    const value = (criteria as Record<string, unknown>)[c.name];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > c.points) {
      return { awarded: {}, parseError: true };
    }
    awarded[c.name] = value;
  }
  return { awarded, parseError: false };
}

export function createJudge(deps: JudgeDeps): JudgePort {
  const url = chatCompletionsUrl(deps.baseUrl);
  // myrmidon(1.6.5 EVALS-JUDGE-FAMILY): the judge candidate list. When
  // routes pass the settings priority list the judge falls through it on a
  // gateway error instead of aborting the run; without a list the judge
  // runs on the configured model only (the pre-1.6.5 shape the offline
  // contour and tests still use).
  const candidates =
    deps.judgeModels && deps.judgeModels.length > 0 ? [...deps.judgeModels] : [deps.model];

  const judgeTask = async (input: {
    taskSlug: string;
    prompt: string;
    answer: string;
    rubric: EvalRubric;
    kind: EvalTaskKind;
    agentModel?: string;
  }): Promise<JudgeTaskResult> => {
    // Cross-family candidates first, then same-family, then the configured
    // model as the last candidate (deduped). With no agent model there is
    // nothing to differ from: the configured model only.
    const order = judgeCandidateOrder(input.agentModel, candidates, deps.model);
    let lastError: EvalJudgeError | null = null;
    for (const judgeModel of order) {
      const sameFamily = isSameJudgeFamily(judgeModel, input.agentModel);
      let response: Response;
      try {
        response = await deps.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${deps.apiKey}`,
          },
          body: JSON.stringify({
            model: judgeModel,
            messages: [
              { role: "system", content: "You are an evaluation judge. Reply with JSON only." },
              { role: "user", content: buildJudgePrompt(input) },
            ],
            temperature: 0,
          }),
          signal: AbortSignal.timeout(deps.timeoutMs),
        });
      } catch (error) {
        // A transport failure for this candidate is not the run's failure:
        // remember it and try the next judge model.
        lastError = new EvalJudgeError(
          "judge_unreachable",
          `the judge gateway call for task "${input.taskSlug}" on model "${judgeModel}" failed: ${(error as Error).message}`,
        );
        continue;
      }
      if (!response.ok) {
        // Same for an HTTP error (rate limit, upstream down, unknown model
        // id): fall through to the next candidate.
        lastError = new EvalJudgeError(
          "judge_http_error",
          `the judge gateway answered ${response.status} for task "${input.taskSlug}" on model "${judgeModel}"`,
        );
        continue;
      }
      const body = (await response.json()) as {
      choices?: { message?: { content?: unknown } }[];
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== "string") {
        return { taskSlug: input.taskSlug, awarded: {}, parseError: true, raw: null, sameFamily };
      }
      const { awarded, parseError } = parseJudgeResponse(content, input.rubric);
      return { taskSlug: input.taskSlug, awarded, parseError, raw: content, sameFamily };
    }
    // Every candidate failed — only then does the task error out (before
    // 1.6.5 the first gateway error aborted the whole run).
    throw (
      lastError ??
      new EvalJudgeError("judge_unreachable", `no judge model configured for task "${input.taskSlug}"`)
    );
  };
  return { judgeTask };
}

/**
 * Build a deterministic offline judge for tests and dev: it awards points by
 * a simple keyword heuristic per criterion. It is deliberately NOT a model —
 * it exists so the run/scoring/threshold code paths are testable without a
 * gateway, and so a "deliberately worse" answer scores measurably lower.
 */
export function createHeuristicJudge(
  scoreOf: (input: { taskSlug: string; criterion: string; answer: string }) => number,
): JudgePort {
  return {
    judgeTask: async (input) => {
      const awarded: Record<string, number> = {};
      let parseError = false;
      for (const c of input.rubric.criteria) {
        const v = scoreOf({ taskSlug: input.taskSlug, criterion: c.name, answer: input.answer });
        const clamped = Math.max(0, Math.min(c.points, v));
        if (!Number.isFinite(clamped)) parseError = true;
        awarded[c.name] = Number.isFinite(clamped) ? clamped : 0;
      }
      return { taskSlug: input.taskSlug, awarded, parseError, raw: null, sameFamily: false };
    },
  };
}
