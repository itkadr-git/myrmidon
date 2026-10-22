// myrmidon(FEATURES): the real ports of the feature definitions — database
// reads and live process state. Every query is bounded by a company or a time
// window that an existing index covers, and the service caches the whole
// report for a short time, so the page and the sweep do not stack queries.

import { and, count, desc, eq, gte, inArray, isNotNull, like, lt, max, ne, sql } from "drizzle-orm";
import {
  activityLog,
  agents,
  budgetIncidents,
  budgetPolicies,
  chatPublications,
  companies,
  costEvents,
  heartbeatRuns,
  litellmCostEvents,
  type Db,
} from "@paperclipai/db";
import { countBotLspModes, resolveBotLsp, type BotLspSettings } from "@paperclipai/shared";
import { HERMES_GATEWAY_ADAPTER_TYPE } from "../bot-containers/agents-query.js";
import { hostDiskRuntime } from "../host-disk/index.js";
import { currentHostMemoryGate } from "../run-admission.js";
import { workspaceHygieneRuntime } from "../workspace-hygiene/index.js";
import type { FeaturePorts } from "./types.js";

/** How far back "last success" is looked up; the counts use the 24-hour window. */
const LATEST_LOOKBACK_MS = 7 * 24 * 60 * 60_000;
const STALE_UNPRICED_AFTER_MS = 60 * 60_000;

export function createDbFeaturePorts(db: Db): FeaturePorts {
  async function companyIds(): Promise<string[]> {
    const rows = await db.select({ id: companies.id }).from(companies).where(isNotNull(companies.id));
    return rows.map((row) => row.id);
  }

  function activityWhere(ids: string[], actions: string[], from: Date, detail?: { key: string; value: string }) {
    return and(
      inArray(activityLog.companyId, ids),
      inArray(activityLog.action, actions),
      gte(activityLog.createdAt, from),
      detail ? sql`${activityLog.details} ->> ${detail.key} = ${detail.value}` : undefined,
    );
  }

  return {
    activity: {
      async count(actions, since, detail) {
        const ids = await companyIds();
        if (ids.length === 0 || actions.length === 0) return 0;
        const [row] = await db
          .select({ n: count() })
          .from(activityLog)
          .where(activityWhere(ids, actions, since, detail));
        return Number(row?.n ?? 0);
      },
      async latest(actions, detail) {
        const ids = await companyIds();
        if (ids.length === 0 || actions.length === 0) return null;
        const from = new Date(Date.now() - LATEST_LOOKBACK_MS);
        const [row] = await db
          .select({ at: max(activityLog.createdAt) })
          .from(activityLog)
          .where(activityWhere(ids, actions, from, detail));
        return row?.at ? new Date(row.at) : null;
      },
    },

    companies: { ids: companyIds },

    agents: {
      async roles() {
        const rows = await db
          .selectDistinct({ role: agents.role })
          .from(agents)
          .where(ne(agents.status, "terminated"));
        return rows.map((row) => row.role).filter((role): role is string => typeof role === "string" && role.length > 0);
      },
    },

    runs: {
      async queuedCount() {
        const ids = await companyIds();
        if (ids.length === 0) return 0;
        const [row] = await db
          .select({ n: count() })
          .from(heartbeatRuns)
          .where(and(inArray(heartbeatRuns.companyId, ids), eq(heartbeatRuns.status, "queued")));
        return Number(row?.n ?? 0);
      },
      async lastStartedAt() {
        const ids = await companyIds();
        if (ids.length === 0) return null;
        const from = new Date(Date.now() - LATEST_LOOKBACK_MS);
        const [row] = await db
          .select({ at: max(heartbeatRuns.startedAt) })
          .from(heartbeatRuns)
          .where(and(inArray(heartbeatRuns.companyId, ids), gte(heartbeatRuns.createdAt, from)));
        return row?.at ? new Date(row.at) : null;
      },
    },

    chatStatus: {
      async stats(since) {
        const statusRows = and(gte(chatPublications.createdAt, since), like(chatPublications.idempotencyKey, "run:%:dmstatus:%"));
        const grouped = await db
          .select({ state: chatPublications.state, n: count(), lastPublishedAt: max(chatPublications.publishedAt) })
          .from(chatPublications)
          .where(statusRows)
          .groupBy(chatPublications.state);
        let delivered = 0;
        let failed = 0;
        let lastDeliveredAt: Date | null = null;
        for (const row of grouped) {
          if (row.state === "published") delivered += Number(row.n);
          if (row.state === "failed") failed += Number(row.n);
          if (row.lastPublishedAt) {
            const at = new Date(row.lastPublishedAt);
            if (!lastDeliveredAt || at > lastDeliveredAt) lastDeliveredAt = at;
          }
        }
        let lastError: { at: Date | null; message: string } | null = null;
        if (failed > 0) {
          const [row] = await db
            .select({ at: chatPublications.updatedAt, message: chatPublications.redactedError })
            .from(chatPublications)
            .where(and(statusRows, eq(chatPublications.state, "failed")))
            .orderBy(desc(chatPublications.updatedAt))
            .limit(1);
          if (row) lastError = { at: row.at ? new Date(row.at) : null, message: row.message ?? "delivery failed (no error text)" };
        }
        return { delivered, failed, lastDeliveredAt, lastError };
      },
    },

    costs: {
      async stats(since) {
        const ids = await companyIds();
        if (ids.length === 0) return { collected: 0, lastCollectedAt: null, unpricedStale: 0 };
        const lookback = new Date(Date.now() - LATEST_LOOKBACK_MS);
        const [collected] = await db
          .select({ n: count() })
          .from(litellmCostEvents)
          .where(and(inArray(litellmCostEvents.companyId, ids), gte(litellmCostEvents.occurredAt, since)));
        const [last] = await db
          .select({ at: max(litellmCostEvents.collectedAt) })
          .from(litellmCostEvents)
          .where(and(inArray(litellmCostEvents.companyId, ids), gte(litellmCostEvents.occurredAt, lookback)));
        const [stale] = await db
          .select({ n: count() })
          .from(costEvents)
          .where(
            and(
              inArray(costEvents.companyId, ids),
              eq(costEvents.provider, "hermes_gateway"),
              eq(costEvents.costStatus, "unpriced"),
              gte(costEvents.occurredAt, since),
              lt(costEvents.occurredAt, new Date(Date.now() - STALE_UNPRICED_AFTER_MS)),
            ),
          );
        return {
          collected: Number(collected?.n ?? 0),
          lastCollectedAt: last?.at ? new Date(last.at) : null,
          unpricedStale: Number(stale?.n ?? 0),
        };
      },
    },

    budget: {
      async stats(since) {
        const [policies] = await db
          .select({ n: count() })
          .from(budgetPolicies)
          .where(and(eq(budgetPolicies.isActive, true), sql`${budgetPolicies.amount} > 0`));
        const [open] = await db
          .select({ n: count() })
          .from(budgetIncidents)
          .where(eq(budgetIncidents.status, "open"));
        const [recent] = await db
          .select({ n: count() })
          .from(budgetIncidents)
          .where(gte(budgetIncidents.createdAt, since));
        return {
          activePolicies: Number(policies?.n ?? 0),
          openIncidents: Number(open?.n ?? 0),
          incidentsSince: Number(recent?.n ?? 0),
        };
      },
    },

    lsp: {
      async modeCounts(general) {
        const settings = (typeof general.botLsp === "object" && general.botLsp !== null ? general.botLsp : {}) as BotLspSettings;
        const rows = await db
          .select({
            role: agents.role,
            lsp: sql<unknown>`${agents.adapterConfig} -> 'lsp'`.mapWith(agents.adapterConfig),
          })
          .from(agents)
          .where(and(eq(agents.adapterType, HERMES_GATEWAY_ADAPTER_TYPE), ne(agents.status, "terminated")));
        const modes = rows.map((row) => ({
          mode: resolveBotLsp(row.role, row.lsp === null || row.lsp === undefined ? {} : { lsp: row.lsp }, settings).mode,
        }));
        const counts = countBotLspModes(modes);
        return { total: modes.length, ...counts };
      },
    },

    runtime: {
      runAdmission() {
        const gate = currentHostMemoryGate();
        return {
          gate: {
            state: gate.state,
            availableMb: gate.availableMb,
            thresholdMb: gate.thresholdMb,
            reason: gate.reason,
            heldSince: gate.heldSince,
          },
        };
      },
      hostDisk() {
        const result = hostDiskRuntime(db).sweep.lastResult();
        return result
          ? {
              at: result.at,
              usedPercent: result.usedPercent,
              thresholdPercent: result.thresholdPercent,
              overThreshold: result.overThreshold,
              error: result.error,
            }
          : null;
      },
      workspaceHygiene() {
        const result = workspaceHygieneRuntime(db).sweep.lastResult();
        return result
          ? {
              at: result.at,
              scanned: result.scanned,
              measured: result.measured,
              failed: result.failed,
              overQuota: result.overQuota,
            }
          : null;
      },
    },
  };
}
