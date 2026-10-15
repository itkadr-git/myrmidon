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

import { eq, sql } from "drizzle-orm";
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

/** One agent's last run with a usable prompt size. */
export interface PromptBudgetLastRun {
  runId: string;
  total: number;
  parts: Record<string, number>;
}

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

/**
 * The last run with a usable prompt size for EVERY listed agent, in ONE
 * statement.
 *
 * myrmidon(1.6.5 F-15 D): the per-agent loop this replaces made the cold
 * attention-feed build issue one `heartbeat_runs ... order by
 * coalesce(finished_at, started_at) desc limit 20` query per agent (~84
 * round trips on the audited board). The lateral join keeps the per-agent
 * scan semantics identical — for each agent its own top-
 * `PROMPT_BUDGET_SCAN_LIMIT` rows ordered by `coalesce(finished_at,
 * started_at) desc nulls first` (Postgres defaults a DESC sort to NULLS
 * FIRST, which is the effective order of the old query) — but pays a single
 * round trip for the whole set. The deterministic `id desc` tie-break only
 * fixes what the old query left to the planner (two runs with both
 * finished_at and started_at null used to tie).
 */
export async function loadLastPromptRuns(
  db: Db,
  companyId: string,
  agentIds: readonly string[],
): Promise<Map<string, PromptBudgetLastRun>> {
  const lastRunByAgent = new Map<string, PromptBudgetLastRun>();
  if (agentIds.length === 0) return lastRunByAgent;
  // Lateral (not a global window sort): each agent's sub-scan keeps the exact
  // plan shape of the old per-agent query — walk its runs, top-K heap-sort 20
  // rows — so cost grows only with the fetched rows, never with a whole-
  // history sort. `nulls first` mirrors Postgres's default effective order of
  // the old `order by coalesce(finished_at, started_at) desc`.
  // Same `ARRAY[...]::uuid[]` construction the attention hot paths use — no
  // driver-side array binding to guess at.
  const agentIdArray = sql`ARRAY[${sql.join(agentIds.map((agentId) => sql`${agentId}::uuid`), sql`, `)}]::uuid[]`;
  const rows = (await db.execute(
    sql`
      select r.agent_id, r.id, r.usage_json
      from unnest(${agentIdArray}) as a(agent_id)
      cross join lateral (
        select
          hr.agent_id,
          hr.id,
          hr.usage_json,
          coalesce(hr.finished_at, hr.started_at) as activity_at
        from ${heartbeatRuns} hr
        where hr.company_id = ${companyId}::uuid
          and hr.agent_id = a.agent_id
        order by coalesce(hr.finished_at, hr.started_at) desc nulls first, hr.id desc
        limit ${PROMPT_BUDGET_SCAN_LIMIT}
      ) r
      -- The nested loop does not guarantee the outer order; sorting on the
      -- keys r already carries makes each agent's batch contiguous and newest
      -- first, so the JS walk below takes the same "latest usable row" the old
      -- per-agent loop returned.
      order by r.agent_id asc, r.activity_at desc nulls first, r.id desc
    `,
  ) as unknown as Array<{ agent_id: string; id: string; usage_json: unknown }>);
  // Per agent, the first row whose usageJson carries a usable prompt size —
  // the same defensive scan the old per-agent read did (parsePromptBreakdown
  // is pure, so it stays in JS and keeps the SQL portable across the rows).
  let cursor = 0;
  while (cursor < rows.length) {
    const agentId = rows[cursor]!.agent_id;
    let picked: PromptBudgetLastRun | null = null;
    while (cursor < rows.length && rows[cursor]!.agent_id === agentId) {
      if (picked === null) {
        const parsed = parsePromptBreakdown(rows[cursor]!.usage_json);
        if (parsed) picked = { runId: rows[cursor]!.id, total: parsed.total, parts: parsed.parts };
      }
      cursor += 1;
    }
    if (picked) lastRunByAgent.set(agentId, picked);
  }
  return lastRunByAgent;
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
  // myrmidon(1.6.5 F-15 D): one batched read replaces the per-agent
  // loadLastPromptRun loop (~84 round trips in a cold feed build).
  const lastRuns = await loadLastPromptRuns(
    db,
    companyId,
    agentRows.map((agent) => agent.id),
  );
  const rows: PromptBudgetAgentStatus[] = [];
  for (const agent of agentRows) {
    const config = asRecord(agent.adapterConfig);
    const model =
      typeof config?.model === "string" && config.model.trim() ? config.model.trim() : null;
    const modelWindow = model !== null ? (windows.get(model) ?? null) : null;
    const windowIsFallback = modelWindow === null || modelWindow <= 0;
    const windowTokens = windowIsFallback ? settings.fallbackWindowTokens : modelWindow;
    const lastRunRaw = lastRuns.get(agent.id) ?? null;
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
