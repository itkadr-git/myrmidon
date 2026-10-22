// server/src/myrmidon/litellm-budget-sync/service.ts
//
// myrmidon(1.7-BUDGET-CONFIG-C): the projection service — board limits into
// LiteLLM budgets, one point of change, effective within a minute.
//
// Design in one breath:
//  - The board owns the limits (the shared contract document stored per
//    company). Every change flows through `syncBudgetProjection`, which does
//    a THREE-WAY comparison before any write:
//      * board == projected == gateway  → nothing to do;
//      * board != projected             → the BOARD changed the limit: write
//        it to the gateway, then record the new `projected` state (the write
//        half — a changed limit reaches LiteLLM within one sweep interval,
//        ≤ 60 s by default, or seconds after a settings save);
//      * board == projected != gateway  → a MANUAL edit in the gateway: a
//        DIVERGENCE — signalled on the board (a system-notice comment on the
//        company's signal issue), never silently overwritten. The sync skips
//        the drifted target until the board re-saves the limit (new projected
//        value) or an operator runs the explicit re-sync.
//    This is what makes "one point of change" true without the sweep
//    clobbering hand edits every 30 seconds.
//  - The projection targets: per-agent KEY budgets (the M2-B key alias of
//    each agent, written via /key/update) and TAG budgets (the stable
//    `myrm-<level>-<scope>` tag, the gateway-side sum for the scope).
//  - The global signal-only switch (default on) keeps every limit from
//    stopping work: while it is on the projection writes soft budgets (the
//    gateway signals); the hard "block" budget is only written when the
//    owner turned signal-only off AND the row's mode is "block".
//  - Nothing here stores a gateway id: keys are found by alias, tags by the
//    stable name, so a gateway rebuild is self-healing on the next sweep.

import type { Db } from "@paperclipai/db";
import {
  budgetProjectionTag,
  type BudgetProjectionLimit,
  type BudgetProjectionStoredSettings,
} from "@paperclipai/shared";
import type { LitellmBudgetGatewayPort } from "./gateway.js";

/** The effective limit of one (level, scopeId), from the stored rows. */
function limitIndex(limits: readonly BudgetProjectionLimit[]): Map<string, BudgetProjectionLimit> {
  const map = new Map<string, BudgetProjectionLimit>();
  for (const limit of limits) map.set(`${limit.level}:${limit.scopeId}`, limit);
  return map;
}

/** One divergence row the sweep found. */
export interface BudgetProjectionDivergence {
  /** The scope the divergence belongs to. */
  level: BudgetProjectionLimit["level"];
  scopeId: string;
  /** "tag" or "key": which side drifted. */
  target: "tag" | "key";
  /** The target the drift was found on (tag name or key alias). */
  targetName: string;
  /** What the board projects. */
  boardUsd: number | null;
  /** What the board last wrote to the gateway. */
  projectedUsd: number | null;
  /** What the gateway holds now. */
  gatewayUsd: number | null;
}

export interface BudgetProjectionSyncResult {
  /** Key budgets written this pass. */
  keysWritten: number;
  /** Tag budgets written this pass. */
  tagsWritten: number;
  /** Divergences found by the comparison pass (manual gateway edits). */
  divergences: BudgetProjectionDivergence[];
}

/** Ports so tests can stub the gateway, comment writer and settings. */
export interface BudgetProjectionSyncDeps {
  db: Db;
  /** The gateway budget port (fake in tests). */
  gateway: LitellmBudgetGatewayPort;
  /** Reads the stored settings document; the implicit default when absent. */
  readSettings(): Promise<BudgetProjectionStoredSettings>;
  /** Persists the whole document (the sync updates `projected` through it). */
  writeSettings(next: BudgetProjectionStoredSettings): Promise<void>;
  /** The agent key aliases of one company: agentId -> M2-B secret name. */
  listAgentKeyAliases(companyId: string): Promise<Array<{ agentId: string; alias: string; role: string }>>;
  /** System-notice comment writer for divergence signals. */
  addComment(
    issueId: string,
    body: string,
    options: {
      presentation: Record<string, unknown>;
      metadata: Record<string, unknown>;
    },
  ): Promise<unknown>;
  /** The issue the divergence signal of a company lands in. */
  findSignalIssue(companyId: string): Promise<{ id: string } | null>;
  /** Activity-log row for divergences; optional in tests. */
  logActivity?(entry: Record<string, unknown>): Promise<void>;
  now(): Date;
  log?: { info(fields: object, message: string): void; warn(fields: object, message: string): void };
}

/** True when the two sides disagree beyond a whole-dollar rounding. */
export function budgetAmountsDiverge(aUsd: number | null, bUsd: number | null): boolean {
  return Math.abs((aUsd ?? 0) - (bUsd ?? 0)) >= 1;
}

/** The tag row the board projects for one limit. */
export function tagProjectionOf(limit: BudgetProjectionLimit, signalOnly: boolean) {
  return {
    tag: budgetProjectionTag(limit.level, limit.scopeId),
    maxBudgetUsd: limit.amountUsd > 0 ? limit.amountUsd : null,
    softBudgetUsd: limit.amountUsd > 0 && (signalOnly || limit.mode === "soft") ? limit.amountUsd : null,
    budgetDurationHours: limit.periodHours,
  };
}

/**
 * One full sync pass for one company. Never throws on a single scope: a
 * failed gateway write is logged, reported in the result, and retried by the
 * next sweep — exactly the M2-A sweep's failure posture.
 */
export async function syncBudgetProjection(
  deps: BudgetProjectionSyncDeps,
  companyId: string,
  opts: { force?: boolean } = {},
): Promise<BudgetProjectionSyncResult> {
  const settings = await deps.readSettings();
  const result: BudgetProjectionSyncResult = { keysWritten: 0, tagsWritten: 0, divergences: [] };
  if (!settings.enabled) return result;

  const log = deps.log ?? { info: () => {}, warn: () => {} };
  const index = limitIndex(settings.limits);
  const projected = { ...settings.projected };
  let projectedChanged = false;

  // --- keys: every agent's key gets the ceiling of its caste --------------
  const agents = await deps.listAgentKeyAliases(companyId);
  for (const agent of agents) {
    const key = `key:${agent.alias}`;
    const limit = index.get(`caste:${agent.role}`) ?? null;
    const boardUsd = limit && limit.amountUsd > 0 ? limit.amountUsd : null;
    try {
      const gatewayRow = await deps.gateway.readKeyBudget({ alias: agent.alias });
      const gatewayUsd = gatewayRow?.maxBudgetUsd ?? null;
      const projectedUsd = key in projected ? projected[key] ?? null : null;

      if (budgetAmountsDiverge(boardUsd, projectedUsd) || opts.force) {
        // The board changed this limit since the last write: push it.
        await deps.gateway.writeKeyBudget({
          alias: agent.alias,
          maxBudgetUsd: boardUsd,
          budgetDurationHours: limit ? limit.periodHours : null,
          // myrmidon(1.7-BUDGET-CONFIG-C): signal-only keeps the gateway soft.
          soft: settings.signalOnly || (limit?.mode ?? "soft") === "soft",
        });
        projected[key] = boardUsd;
        projectedChanged = true;
        if (boardUsd !== null) result.keysWritten += 1;
      } else if (budgetAmountsDiverge(projectedUsd, gatewayUsd)) {
        // The board did NOT change anything, but the gateway drifted: a
        // manual edit. Signal, never overwrite.
        result.divergences.push({
          level: "caste",
          scopeId: agent.role,
          target: "key",
          targetName: agent.alias,
          boardUsd,
          projectedUsd,
          gatewayUsd,
        });
      }
    } catch (err) {
      log.warn({ err, companyId, alias: agent.alias }, "litellm budget projection: key pass failed");
    }
  }

  // --- tags: every stored limit row becomes one gateway tag budget -------
  for (const limit of settings.limits) {
    const projection = tagProjectionOf(limit, settings.signalOnly);
    const key = `tag:${projection.tag}`;
    const boardUsd = projection.maxBudgetUsd;
    try {
      const gatewayRow = await deps.gateway.readTagBudget({ tag: projection.tag });
      const gatewayUsd = gatewayRow?.maxBudgetUsd ?? null;
      const projectedUsd = key in projected ? projected[key] ?? null : null;

      if (budgetAmountsDiverge(boardUsd, projectedUsd) || opts.force) {
        // A new/changed/removed board limit: write it.
        await deps.gateway.upsertTagBudget(projection);
        projected[key] = boardUsd;
        projectedChanged = true;
        if (boardUsd !== null) result.tagsWritten += 1;
      } else if (budgetAmountsDiverge(projectedUsd, gatewayUsd)) {
        result.divergences.push({
          level: limit.level,
          scopeId: limit.scopeId,
          target: "tag",
          targetName: projection.tag,
          boardUsd,
          projectedUsd,
          gatewayUsd,
        });
      }
    } catch (err) {
      log.warn({ err, companyId, tag: projection.tag }, "litellm budget projection: tag pass failed");
    }
  }

  // --- divergence signal (best-effort, never into the write path) --------
  if (result.divergences.length > 0) {
    await deliverBudgetDivergenceSignal(deps, companyId, result.divergences);
    log.info(
      { companyId, divergences: result.divergences.length },
      "litellm budget projection divergences found",
    );
  }

  if (projectedChanged) {
    try {
      await deps.writeSettings({ ...settings, projected });
    } catch (err) {
      log.warn({ err, companyId }, "litellm budget projection: recording projected state failed");
    }
  }
  return result;
}

/** The dedup key of one divergence signal (comment metadata, the M3 seam). */
export function budgetDivergenceSignalKey(
  companyId: string,
  level: string,
  scopeId: string,
  target: string,
  targetName: string,
  windowStart: Date,
): string {
  const day = windowStart.toISOString().slice(0, 10);
  return `budget-projection:${companyId}:${level}:${scopeId}:${target}:${targetName}:${day}`;
}

/** The signal body of a divergence: what drifted, both numbers, how to fix. */
export function buildBudgetDivergenceBody(rows: BudgetProjectionDivergence[]): string {
  const lines = [
    "The LiteLLM gateway budget no longer matches the board's limit.",
    "",
  ];
  for (const row of rows) {
    lines.push(
      `- ${row.target === "tag" ? "tag" : "key"} ${row.targetName} (${row.level}/${row.scopeId}): board $${row.boardUsd ?? 0}, gateway $${row.gatewayUsd ?? 0}`,
    );
  }
  lines.push("");
  lines.push(
    "The projection does not overwrite the gateway silently. Re-save the limit on the board (or call POST /api/myrmidon/companies/:companyId/litellm-budget-sync/re-sync) to project the board's value again.",
  );
  return lines.join("\n");
}

/**
 * Deliver one divergence signal: a system-notice comment on the signal issue
 * of the company, deduped per (scope, target, UTC day) via the metadata key.
 * Best-effort — never throws into the sweep.
 */
export async function deliverBudgetDivergenceSignal(
  deps: BudgetProjectionSyncDeps,
  companyId: string,
  rows: BudgetProjectionDivergence[],
): Promise<{ written: boolean; issueId: string | null }> {
  const log = deps.log ?? { info: () => {}, warn: () => {} };
  try {
    const issue = await deps.findSignalIssue(companyId);
    if (!issue) return { written: false, issueId: null };
    const now = deps.now();
    const windowStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const key = budgetDivergenceSignalKey(
      companyId,
      rows[0]?.level ?? "nest",
      rows[0]?.scopeId ?? "-",
      rows[0]?.target ?? "-",
      rows[0]?.targetName ?? "-",
      windowStart,
    );
    await deps.addComment(issue.id, buildBudgetDivergenceBody(rows), {
      presentation: {
        kind: "system_notice",
        tone: "warning",
        title: "LiteLLM budget divergence",
        detailsDefaultOpen: true,
      },
      metadata: {
        version: 1,
        sections: [
          {
            title: "Budget projection divergence",
            rows: [{ type: "key_value", label: "Signal key", value: key }],
          },
        ],
      },
    });
    return { written: true, issueId: issue.id };
  } catch (err) {
    log.warn({ err, companyId }, "litellm budget projection: divergence signal failed");
    return { written: false, issueId: null };
  }
}
