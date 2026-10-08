// server/src/myrmidon/prompt-budget/status.ts
//
// myrmidon(1.6.3 PROMPT-BUDGET B): the live per-agent prompt-budget picture.
//
// One read joins every agent of the company with its last run that carries a
// usable prompt size (`usageJson.promptBreakdown`, else the input-token total
// without parts — the same defensive read the advice part's source does) and
// with the input window of the model on the agent card (the latest-seen
// `litellm_models.maxInputTokens`; when the model is unknown the settings'
// `fallbackWindowTokens` stands in — the documented fallback the brief asks
// for). Everything is computed on the fly — no new tables.

import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, heartbeatRuns, litellmModels } from "@paperclipai/db";
import {
  buildPromptBudgetRunStatus,
  type PromptBudgetAgentStatus,
  type PromptBudgetSettings,
} from "@paperclipai/shared";
import { parsePromptBreakdown } from "../prompt-budget-advice/source.js";

/** How many recent runs per agent are scanned for a usable prompt size. */
export const PROMPT_BUDGET_SCAN_LIMIT = 20;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The latest-seen input window per model name (null when never recorded). */
export async function loadModelWindows(db: Db): Promise<Map<string, number | null>> {
  const latest = db
    .select({
      modelName: litellmModels.modelName,
      seenAt: sql<Date>`max(${litellmModels.seenAt})`.as("seenAt"),
    })
    .from(litellmModels)
    .groupBy(litellmModels.modelName)
    .as("latest");
  const rows = await db
    .select({ modelName: litellmModels.modelName, maxInputTokens: litellmModels.maxInputTokens })
    .from(litellmModels)
    .innerJoin(
      latest,
      sql`${litellmModels.modelName} = ${latest.modelName} and ${litellmModels.seenAt} = ${latest.seenAt}`,
    );
  return new Map(rows.map((row) => [row.modelName, row.maxInputTokens] as const));
}

/** One agent's last run with a usable prompt size, or null when there is none. */
export async function loadLastPromptRun(
  db: Db,
  companyId: string,
  agentId: string,
): Promise<{ runId: string; total: number; parts: Record<string, number> } | null> {
  const rows = await db
    .select({ id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson })
    .from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, agentId)))
    .orderBy(desc(sql`coalesce(${heartbeatRuns.finishedAt}, ${heartbeatRuns.startedAt})`))
    .limit(PROMPT_BUDGET_SCAN_LIMIT);
  for (const row of rows) {
    const parsed = parsePromptBreakdown(row.usageJson);
    if (parsed) return { runId: row.id, total: parsed.total, parts: parsed.parts };
  }
  return null;
}

/** The status rows of every agent of the company, in stable id order. */
export async function buildPromptBudgetStatus(
  db: Db,
  companyId: string,
  settings: PromptBudgetSettings,
): Promise<PromptBudgetAgentStatus[]> {
  const [agentRows, windows] = await Promise.all([
    db
      .select({ id: agents.id, adapterConfig: agents.adapterConfig })
      .from(agents)
      .where(eq(agents.companyId, companyId)),
    loadModelWindows(db),
  ]);
  const rows: PromptBudgetAgentStatus[] = [];
  for (const agent of agentRows) {
    const config = asRecord(agent.adapterConfig);
    const model =
      typeof config?.model === "string" && config.model.trim() ? config.model.trim() : null;
    const modelWindow = model !== null ? (windows.get(model) ?? null) : null;
    const windowIsFallback = modelWindow === null || modelWindow <= 0;
    const windowTokens = windowIsFallback ? settings.fallbackWindowTokens : modelWindow;
    const lastRunRaw = await loadLastPromptRun(db, companyId, agent.id);
    rows.push({
      agentId: agent.id,
      model,
      windowTokens,
      windowIsFallback,
      lastRun:
        lastRunRaw === null
          ? null
          : buildPromptBudgetRunStatus({
              runId: lastRunRaw.runId,
              total: lastRunRaw.total,
              parts: lastRunRaw.parts,
              windowTokens,
              settings,
            }),
      settings,
    });
  }
  return rows.sort((left, right) => left.agentId.localeCompare(right.agentId));
}
