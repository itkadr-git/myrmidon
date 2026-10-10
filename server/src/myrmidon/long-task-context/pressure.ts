// server/src/myrmidon/long-task-context/pressure.ts
//
// myrmidon(1.6.6 LONG-TASK-CONTEXT): the live pressure of one task — how much
// of the model's window the task's own last prompt took, and whether that means
// the accumulated session must be dropped before the next launch.
//
// Everything is computed on the fly, no new tables: the task's newest run that
// carries a usable prompt size (`usageJson.promptBreakdown`, else the
// input-token total — the same defensive read the prompt-budget status does)
// against the input window of the model on the agent card (latest-seen
// `litellm_models.maxInputTokens`, else the settings' `fallbackWindowTokens`).
//
// The read is scoped to the task, not to the agent: an agent running several
// tasks has a separate session per task, and only the ever-running one is the
// one that grows without an end.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { heartbeatRuns } from "@paperclipai/db";
import {
  LONG_TASK_CONTEXT_SETTINGS_KEY,
  type LongTaskContextSettings,
} from "@paperclipai/shared";
import { parsePromptBreakdown } from "../prompt-budget-advice/source.js";
import { loadModelWindows, PROMPT_BUDGET_SCAN_LIMIT } from "../prompt-budget/status.js";
import { planLongTaskContextReset, type LongTaskContextPlan } from "./domain.js";
import {
  resolveLongTaskContextSettings,
  type LongTaskContextSettingSource,
  type LongTaskContextSettingsService,
} from "./settings.js";

export interface TaskPromptRun {
  runId: string;
  total: number;
  parts: Record<string, number>;
}

/**
 * The newest run of this agent for this task that carries a usable prompt
 * size, or null when the task has none yet (nothing to be over a window).
 */
export async function loadTaskPromptRun(
  db: Db,
  input: { companyId: string; agentId: string; issueId: string },
): Promise<TaskPromptRun | null> {
  const rows = await db
    .select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(
      and(
        eq(heartbeatRuns.companyId, input.companyId),
        eq(heartbeatRuns.agentId, input.agentId),
        sql`(${heartbeatRuns.contextSnapshot} ->> 'issueId') = ${input.issueId}`,
      ),
    )
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt})`))
    .limit(PROMPT_BUDGET_SCAN_LIMIT);
  for (const row of rows) {
    const parsed = parsePromptBreakdown(row.usageJson);
    if (parsed) return { runId: row.id, total: parsed.total, parts: parsed.parts };
  }
  return null;
}

/** The window the percentages count against for a given model name. */
export async function resolveLongTaskContextWindow(
  db: Db,
  model: string | null,
  settings: LongTaskContextSettings,
): Promise<{ windowTokens: number; isFallback: boolean }> {
  if (model === null) return { windowTokens: settings.fallbackWindowTokens, isFallback: true };
  const windows = await loadModelWindows(db);
  const known = windows.get(model);
  if (known === undefined || known === null || known <= 0) {
    return { windowTokens: settings.fallbackWindowTokens, isFallback: true };
  }
  return { windowTokens: known, isFallback: false };
}

export interface LongTaskContextEvaluation {
  plan: LongTaskContextPlan;
  settings: LongTaskContextSettings;
  sources: Record<keyof LongTaskContextSettings, LongTaskContextSettingSource>;
  envKeys: Partial<Record<keyof LongTaskContextSettings, string>>;
  windowIsFallback: boolean;
}

/**
 * Evaluate the guard for one launch of one task.
 *
 * `issueId` null (a wake that is not scoped to an issue) has no task thread to
 * measure, so nothing resets.
 */
export async function evaluateLongTaskContextReset(input: {
  db: Db;
  settings: LongTaskContextSettingsService;
  companyId: string;
  agentId: string;
  issueId: string | null;
  model: string | null;
  env?: NodeJS.ProcessEnv;
}): Promise<LongTaskContextEvaluation> {
  const general = (await input.settings.getGeneral()) as unknown as Record<string, unknown>;
  const resolved = resolveLongTaskContextSettings({
    stored: general[LONG_TASK_CONTEXT_SETTINGS_KEY],
    env: input.env ?? process.env,
  });
  const { windowTokens, isFallback } = await resolveLongTaskContextWindow(
    input.db,
    input.model,
    resolved.settings,
  );
  const lastRun = input.issueId
    ? await loadTaskPromptRun(input.db, {
        companyId: input.companyId,
        agentId: input.agentId,
        issueId: input.issueId,
      })
    : null;
  const plan = planLongTaskContextReset({
    settings: resolved.settings,
    promptTotal: lastRun?.total ?? null,
    windowTokens,
    lastRunId: lastRun?.runId ?? null,
  });
  return {
    plan,
    settings: resolved.settings,
    sources: resolved.sources,
    envKeys: resolved.envKeys,
    windowIsFallback: isFallback,
  };
}