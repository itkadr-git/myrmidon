// server/src/myrmidon/scent/service.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the scent service — classification,
// storage and the hour-budget ledger (design §2.4, §7.1 п.4a).
//
// Every classification goes through `classifyIssue`/`classifyAgent`: the
// settings switch is checked, one gateway call is made, the result is stored
// and journalized (`issue.scent_classified` / `agent.scent_classified` with
// the model and the token count — the "< 1M input tokens/day" budget is read
// off these records). A gateway failure does NOT touch the row: the queue
// retries the record later within its hour budget.
//
// `listMarkupQueue` answers "which records still need a first pass" —
// OPEN todo tasks only (§7.1 п.4a; the whole point of the queue is that a
// task gets its caste before the swarm dispatches it, so done/cancelled
// history is out of the token budget by design) plus agents with empty
// `scent_tags`.

import { and, eq, isNull, sql } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import {
  readScentSettings,
  type IssueScent,
  type ScentSettings,
} from "@paperclipai/shared";
import type { ScentGateway, AgentScentClassificationResult, ScentClassificationResult } from "./gateway.js";

/** The markup queue never looks back further than this many days. */
const MARKUP_QUEUE_LOOKBACK_DAYS = 30;

export interface ScentServiceDeps {
  db: Db;
  companyId: string;
  settings: ScentSettings;
  gateway: ScentGateway;
  /** caste keys of the company directory (the caller loads them). */
  casteKeys: string[];
  logActivity: (entry: {
    actorType: "system";
    action: string;
    entityType: string;
    entityId: string;
    details?: Record<string, unknown>;
  }) => Promise<void>;
}

export interface MarkupQueueSlice {
  issueIds: string[];
  agentIds: string[];
  totalPending: number;
}

interface IssueRow {
  id: string;
  title: string;
  description: string | null;
}

interface AgentRow {
  id: string;
  capabilities: string | null;
}

/**
 * Returns true when the settings allow the classification of this record
 * right now: the switch is on and the record has spent less than
 * `classifierMaxPerRecordPerHour` calls in the last hour — SUCCESSES AND
 * FAILURES ALIKE (the ledger counts every attempt, so a dead gateway cannot
 * make the queue hammer the same 20 records on every tick).
 */
export async function canSpendCall(
  db: Db,
  opts: { entityType: "issue" | "agent"; entityId: string; maxPerHour: number },
): Promise<boolean> {
  const actions =
    opts.entityType === "issue" ? ["issue.scent_classified"] : ["agent.scent_classified"];
  const rows = await db.execute(sql`
    select count(*)::int as n
    from activity_log
    where action = ${actions[0]}
      and entity_type = ${opts.entityType}
      and entity_id = ${opts.entityId}::uuid
      and created_at > now() - interval '1 hour'
  `);
  const n = Number((rows as unknown as Array<{ n: number }>)[0]?.n ?? 0);
  return n < opts.maxPerHour;
}

/** One ledger entry per classification ATTEMPT (success or gateway failure). */
async function logScentClassified(
  deps: ScentServiceDeps,
  opts: {
    entityType: "issue" | "agent";
    entityId: string;
    model: string;
    inputTokens: number | null;
    outputTokens: number | null;
    ok: boolean;
  },
): Promise<void> {
  await deps.logActivity({
    actorType: "system",
    action: `${opts.entityType}.scent_classified`,
    entityType: opts.entityType,
    entityId: opts.entityId,
    details: {
      model: opts.model,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      ok: opts.ok,
    },
  });
}

export interface ClassifyIssueResult {
  scent: IssueScent | null;
  classified: boolean;
  spent: boolean;
}

export function createScentService(deps: ScentServiceDeps) {
  const db = deps.db;
  async function loadIssue(issueId: string): Promise<IssueRow | null> {
    const rows = await db
      .select({ id: issues.id, title: issues.title, description: issues.description })
      .from(issues)
      .where(and(eq(issues.id, issueId), eq(issues.companyId, deps.companyId)))
      .limit(1);
    return (rows[0] as IssueRow | undefined) ?? null;
  }

  async function classifyIssue(issueId: string): Promise<ClassifyIssueResult> {
    const db = deps.db;
    if (!deps.settings.enabled) return { scent: null, classified: false, spent: false };
    const issue = await loadIssue(issueId);
    if (!issue) return { scent: null, classified: false, spent: false };
    // §2.4: a task without a description is not sent to the classifier at
    // all — it stays unscented and takes the §2.1 caste fallback chain.
    if (!issue.description || !issue.description.trim()) {
      return { scent: null, classified: false, spent: false };
    }
    if (
      !(await canSpendCall(db, {
        entityType: "issue",
        entityId: issueId,
        maxPerHour: deps.settings.classifierMaxPerRecordPerHour,
      }))
    ) {
      return { scent: null, classified: false, spent: false };
    }
    let result: ScentClassificationResult;
    try {
      result = await deps.gateway.classifyIssueScent({
        model: deps.settings.model,
        casteKeys: deps.casteKeys,
        title: issue.title,
        description: issue.description,
        timeoutSec: deps.settings.classifierTimeoutSec,
      });
    } catch {
      result = { scent: null, model: deps.settings.model, inputTokens: null, outputTokens: null };
    }
    await logScentClassified(deps, {
      entityType: "issue",
      entityId: issueId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ok: result.scent !== null,
    });
    if (result.scent) {
      await db
        .update(issues)
        .set({ scent: result.scent })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, deps.companyId)));
    }
    return { scent: result.scent, classified: result.scent !== null, spent: true };
  }

  async function classifyAgent(agentId: string): Promise<{ tags: string[]; classified: boolean }> {
    const db = deps.db;
    if (!deps.settings.enabled) return { tags: [], classified: false };
    const rows = await db
      .select({ id: agents.id, capabilities: agents.capabilities })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, deps.companyId)))
      .limit(1);
    const agent = (rows[0] as AgentRow | undefined) ?? null;
    // An agent without capabilities has no text to distill — there is nothing
    // to classify and nothing to retry, so the record must not occupy the
    // queue batch forever.
    if (!agent || !agent.capabilities || !agent.capabilities.trim()) {
      return { tags: [], classified: false };
    }
    if (
      !(await canSpendCall(db, {
        entityType: "agent",
        entityId: agentId,
        maxPerHour: deps.settings.classifierMaxPerRecordPerHour,
      }))
    ) {
      return { tags: [], classified: false };
    }
    let result: AgentScentClassificationResult;
    try {
      result = await deps.gateway.classifyAgentScent({
        model: deps.settings.model,
        capabilities: agent.capabilities,
        timeoutSec: deps.settings.classifierTimeoutSec,
      });
    } catch {
      result = { tags: [], model: deps.settings.model, inputTokens: null, outputTokens: null };
    }
    await logScentClassified(deps, {
      entityType: "agent",
      entityId: agentId,
      model: result.model,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      ok: result.tags.length > 0,
    });
    if (result.tags.length > 0) {
      await db
        .update(agents)
        .set({ scentTags: result.tags, scentClassifiedAt: new Date() })
        .where(and(eq(agents.id, agentId), eq(agents.companyId, deps.companyId)));
    }
    return { tags: result.tags, classified: result.tags.length > 0 };
  }

  /**
   * §7.1 п.4a: OPEN todo tasks without a scent (no done/cancelled history —
   * the "< 1M input tokens/day" budget is spent where it changes routing)
   * plus agents whose tags were never distilled, capped at `limit` per kind.
   */
  async function listMarkupQueue(limit: number): Promise<MarkupQueueSlice> {
    const db = deps.db;
    const lookback = new Date(Date.now() - MARKUP_QUEUE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const openIssues = await db
      .select({ id: issues.id })
      .from(issues)
      .where(
        and(
          eq(issues.companyId, deps.companyId),
          isNull(issues.scent),
          // §7.1 п.4a: OPEN todo only — done/cancelled history is out of the
          // token budget (a task needs its caste BEFORE the swarm picks it).
          eq(issues.status, "todo"),
          sql`${issues.createdAt} > ${lookback}`,
        ),
      )
      .orderBy(issues.createdAt)
      .limit(limit);
    const unscentedAgents = await db
      .select({ id: agents.id })
      .from(agents)
      .where(
        and(
          eq(agents.companyId, deps.companyId),
          sql`coalesce(array_length(${agents.scentTags}, 1), 0) = 0`,
          sql`${agents.capabilities} is not null and length(trim(${agents.capabilities})) > 0`,
        ),
      )
      .orderBy(agents.createdAt)
      .limit(limit);
    const issueIds = openIssues.map((r) => r.id);
    const agentIds = unscentedAgents.map((r) => r.id);
    return { issueIds, agentIds, totalPending: issueIds.length + agentIds.length };
  }

  return {
    classifyIssue,
    classifyAgent,
    listMarkupQueue,
    settings: deps.settings,
  };
}

export type ScentService = ReturnType<typeof createScentService>;

/** Convenience: read the effective scent settings from a general settings row. */
export function scentSettingsFromGeneral(
  general: unknown,
  env?: Record<string, string | undefined>,
): ScentSettings {
  const swarm =
    general && typeof general === "object" && !Array.isArray(general)
      ? (general as Record<string, unknown>).swarm
      : undefined;
  return readScentSettings(swarm, env);
}
