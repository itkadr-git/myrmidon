// server/src/myrmidon/input-limit/input-limit.ts
//
// myrmidon(OPE-6168): check the model input limit BEFORE a run is sent.
//
// A hermes_gateway session keeps every prompt the board sends it, so a task that
// is re-run many times grows one session past the provider's input limit and
// every further attempt is rejected ("Range of input length should be ..."). The
// board already knows each model's limit (`litellm_models.maxInputTokens`, the
// same catalog the prompt-budget report reads), so before it dispatches a run it
//
//   1. resolves the limit of the agent's model (or an explicit per-agent
//      override) and hands it to the adapter as `config.inputLimit`, where the
//      adapter trims a single request that alone exceeds it
//      (packages/adapter-utils/src/input-limit.ts), and
//   2. estimates how much the task's current session already holds (the sum of
//      the prompts the board sent into it, from the stored prompt breakdowns) and,
//      when the next prompt would not fit, starts a fresh session instead of
//      sending into the full one.
//
// The decision is durable: a reset is recorded as a lifecycle run event; the
// session generation the adapter uses for its session key is
// 1 + overflow failures + recorded resets, and only runs after the latest reset
// count towards the new session. Turn it off with MYRMIDON_INPUT_LIMIT_PRECHECK=0.

import { and, desc, eq, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRunEvents, heartbeatRuns, litellmModels } from "@paperclipai/db";
import {
  DEFAULT_CHARS_PER_TOKEN,
  DEFAULT_INPUT_LIMIT_SAFETY,
  INPUT_LIMIT_CONFIG_KEY,
  inputBudgetTokens,
  readInputLimitHint,
  type InputLimitHint,
} from "@paperclipai/adapter-utils/input-limit";

export const INPUT_LIMIT_PRECHECK_ENV = "MYRMIDON_INPUT_LIMIT_PRECHECK";
export const INPUT_LIMIT_CHARS_PER_TOKEN_ENV = "MYRMIDON_INPUT_LIMIT_CHARS_PER_TOKEN";
export const INPUT_LIMIT_SAFETY_ENV = "MYRMIDON_INPUT_LIMIT_SAFETY";
/** Adapter-config keys of an explicit per-agent override (they beat the catalog). */
export const INPUT_LIMIT_TOKENS_CONFIG_KEY = "inputLimitTokens";
export const INPUT_LIMIT_CHARS_CONFIG_KEY = "inputLimitChars";
/** Event payload key the fresh-session decision is recorded under. */
export const INPUT_LIMIT_EVENT_KEY = "inputLimit";
export const INPUT_LIMIT_FRESH_SESSION_ACTION = "fresh_session";

export interface InputLimitSettings {
  enabled: boolean;
  charsPerToken: number;
  safety: number;
}

export function readInputLimitSettings(env: NodeJS.ProcessEnv = process.env): InputLimitSettings {
  const enabled = env[INPUT_LIMIT_PRECHECK_ENV]?.trim() !== "0";
  const cpt = Number(env[INPUT_LIMIT_CHARS_PER_TOKEN_ENV]?.trim());
  const safety = Number(env[INPUT_LIMIT_SAFETY_ENV]?.trim());
  return {
    enabled,
    charsPerToken: Number.isFinite(cpt) && cpt >= 1 && cpt <= 10 ? cpt : DEFAULT_CHARS_PER_TOKEN,
    safety: Number.isFinite(safety) && safety > 0 && safety <= 1 ? safety : DEFAULT_INPUT_LIMIT_SAFETY,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function positiveInt(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/** Latest-seen input window of one model in the gateway model catalog; null when unknown. */
export async function loadCatalogInputTokens(db: Pick<Db, "select">, modelName: string): Promise<number | null> {
  const rows = await db
    .select({ maxInputTokens: litellmModels.maxInputTokens })
    .from(litellmModels)
    .where(eq(litellmModels.modelName, modelName))
    .orderBy(desc(litellmModels.seenAt))
    .limit(1);
  return positiveInt(rows[0]?.maxInputTokens);
}

/**
 * The input limit of the run's model: an explicit override in the adapter
 * config, else the model catalog; null when neither knows a limit (nothing is
 * invented for an unknown model).
 */
export async function resolveInputLimitHint(
  db: Pick<Db, "select">,
  config: Record<string, unknown>,
  settings: InputLimitSettings = readInputLimitSettings(),
): Promise<InputLimitHint | null> {
  if (!settings.enabled) return null;
  const model = typeof config.model === "string" && config.model.trim() ? config.model.trim() : null;
  const overrideTokens = positiveInt(config[INPUT_LIMIT_TOKENS_CONFIG_KEY]);
  const overrideChars = positiveInt(config[INPUT_LIMIT_CHARS_CONFIG_KEY]);
  if (overrideTokens !== null || overrideChars !== null) {
    return readInputLimitHint({
      model,
      source: "config",
      maxInputTokens: overrideTokens,
      maxInputChars: overrideChars,
      charsPerToken: settings.charsPerToken,
      safety: settings.safety,
    });
  }
  if (model === null) return null;
  const catalogTokens = await loadCatalogInputTokens(db, model);
  if (catalogTokens === null) return null;
  return readInputLimitHint({
    model,
    source: "catalog",
    maxInputTokens: catalogTokens,
    maxInputChars: null,
    charsPerToken: settings.charsPerToken,
    safety: settings.safety,
  });
}

/** `promptBreakdown.total` (estimated prompt tokens) of a stored usage/result JSON; 0 when absent. */
export function promptTokensOf(...sources: unknown[]): number {
  for (const source of sources) {
    const breakdown = asRecord(asRecord(source)?.promptBreakdown);
    const total = positiveInt(breakdown?.total);
    if (total !== null) return total;
  }
  return 0;
}

export interface SessionPromptEstimate {
  /** Prompt tokens the board has sent into the current session (sum over its runs). */
  sessionTokens: number;
  /** The newest run's prompt: the best guess of what the next run will add. */
  lastPromptTokens: number;
  runs: number;
}

export interface InputLimitHistory {
  /** Fresh sessions already started for this task because of the input limit. */
  priorResets: number;
  /** When the run that started the newest of them was created (that run is the new session's first); null when there is none. */
  lastResetAt: Date | null;
}

/** Reads the recorded fresh-session decisions of one agent on one issue. */
export async function loadInputLimitHistory(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<InputLimitHistory> {
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      lastAt: sql<Date | string | null>`max(${heartbeatRuns.createdAt})`,
    })
    .from(heartbeatRunEvents)
    .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, heartbeatRunEvents.runId))
    .where(
      and(
        eq(heartbeatRunEvents.companyId, input.companyId),
        eq(heartbeatRunEvents.agentId, input.agentId),
        eq(heartbeatRunEvents.eventType, "lifecycle"),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        sql`${heartbeatRunEvents.payload} -> ${INPUT_LIMIT_EVENT_KEY} ->> 'action' = ${INPUT_LIMIT_FRESH_SESSION_ACTION}`,
      ),
    );
  const lastAt = row?.lastAt ? new Date(row.lastAt) : null;
  return {
    priorResets: row?.count ?? 0,
    lastResetAt: lastAt && Number.isFinite(lastAt.getTime()) ? lastAt : null,
  };
}

/** What the board has sent into the task's current session: the runs after the latest reset. */
export async function estimateSessionPromptTokens(
  db: Pick<Db, "select">,
  input: { companyId: string; agentId: string; issueId: string; since: Date | null; excludeRunId?: string; limit?: number },
): Promise<SessionPromptEstimate> {
  const rows = await db
    .select({
      usageJson: heartbeatRuns.usageJson,
      resultJson: heartbeatRuns.resultJson,
      errorFamily: sql<string | null>`${heartbeatRuns.resultJson} ->> 'errorFamily'`,
    })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`${heartbeatRuns.contextSnapshot} ->> 'issueId' = ${input.issueId}`,
        notInArray(heartbeatRuns.status, ["queued", "cancelled"]),
        ...(input.excludeRunId ? [sql`${heartbeatRuns.id} <> ${input.excludeRunId}`] : []),
        ...(input.since ? [sql`${heartbeatRuns.createdAt} >= ${input.since.toISOString()}`] : []),
      ),
    )
    .orderBy(desc(heartbeatRuns.createdAt), desc(heartbeatRuns.id))
    .limit(input.limit ?? 200);
  let sessionTokens = 0;
  let lastPromptTokens = 0;
  let runs = 0;
  for (const row of rows) {
    // A run the provider rejected as too long ended its session: the next one started fresh.
    if (row.errorFamily === "input_overflow") break;
    const tokens = promptTokensOf(row.usageJson, row.resultJson);
    if (tokens <= 0) continue;
    if (runs === 0) lastPromptTokens = tokens;
    sessionTokens += tokens;
    runs += 1;
  }
  return { sessionTokens, lastPromptTokens, runs };
}

export type SessionResetDecision =
  | { reset: false }
  | { reset: true; sessionTokens: number; expectedTokens: number; budgetTokens: number };

/**
 * A fresh session when what the session already holds plus a prompt like the
 * last one would not fit the budget. A session with no recorded prompts never
 * resets here (nothing is known to be in it).
 */
export function decideSessionReset(hint: InputLimitHint, estimate: SessionPromptEstimate): SessionResetDecision {
  if (estimate.sessionTokens <= 0) return { reset: false };
  const budgetTokens = inputBudgetTokens(hint);
  const expectedTokens = estimate.sessionTokens + estimate.lastPromptTokens;
  if (expectedTokens <= budgetTokens) return { reset: false };
  return { reset: true, sessionTokens: estimate.sessionTokens, expectedTokens, budgetTokens };
}

export interface InputLimitPlan {
  hint: InputLimitHint | null;
  decision: SessionResetDecision;
  /** Resets already recorded for the task, not counting this run's. */
  priorResets: number;
  /** The generation this run's session key needs because of the input limit (1 = none). */
  generation: number;
}

/**
 * The whole pre-dispatch decision for one run. `overflowFailures` is the count
 * #OPE-6168's overflow guard keeps, so both feed one generation number.
 */
export async function planInputLimit(
  db: Pick<Db, "select">,
  input: {
    companyId: string;
    agentId: string;
    issueId: string | null;
    runId: string;
    adapterConfig: Record<string, unknown>;
    overflowFailures: number;
    settings?: InputLimitSettings;
  },
): Promise<InputLimitPlan> {
  const settings = input.settings ?? readInputLimitSettings();
  const hint = await resolveInputLimitHint(db, input.adapterConfig, settings);
  if (!hint || !input.issueId) {
    return { hint, decision: { reset: false }, priorResets: 0, generation: 1 };
  }
  const history = await loadInputLimitHistory(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
  });
  const estimate = await estimateSessionPromptTokens(db, {
    companyId: input.companyId,
    agentId: input.agentId,
    issueId: input.issueId,
    since: history.lastResetAt,
    excludeRunId: input.runId,
  });
  const decision = decideSessionReset(hint, estimate);
  const generation = 1 + input.overflowFailures + history.priorResets + (decision.reset ? 1 : 0);
  return { hint, decision, priorResets: history.priorResets, generation };
}

export { INPUT_LIMIT_CONFIG_KEY };
