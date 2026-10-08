// server/src/myrmidon/monitoring/links/store.ts
//
// myrmidon(1.6.6 MONITORING E): the DB reads of the monitoring-link watchdog.
//
// Links need no table of their own: a link *is* its board key with a
// `monitoring_link` scope, so the registry, the key material and the liveness
// policy live in one row, and the board key auth path already stamps
// `last_used_at` on every authenticated request — that timestamp is the pulse.
// Reusing it is the point: a link has exactly one credential, and a dead
// credential is visible in the very place the alarm must look.

import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, boardApiKeys, issueCreateIdempotencyKeys, issues } from "@paperclipai/db";
import { monitoringLinkScopeSchema } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";
import type { MonitoringLinkKeyRow } from "./health.js";

/** The scope is read from JSONB, so it is untrusted input and re-validated. */
function parseMonitoringLinkScope(value: unknown): MonitoringLinkKeyRow["scope"] | null {
  const parsed = monitoringLinkScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export async function listMonitoringLinkKeyRows(
  db: Db,
  options: { companyId?: string } = {},
): Promise<MonitoringLinkKeyRow[]> {
  const rows = await db
    .select({
      keyId: boardApiKeys.id,
      keyName: boardApiKeys.name,
      scope: boardApiKeys.scopeConfig,
      createdAt: boardApiKeys.createdAt,
      lastUsedAt: boardApiKeys.lastUsedAt,
      expiresAt: boardApiKeys.expiresAt,
      revokedAt: boardApiKeys.revokedAt,
    })
    .from(boardApiKeys)
    .where(sql`${boardApiKeys.scopeConfig} ->> 'kind' = 'monitoring_link'`);

  const result: MonitoringLinkKeyRow[] = [];
  for (const row of rows) {
    const scope = parseMonitoringLinkScope(row.scope);
    if (!scope) {
      // A row whose scope cannot be read is not a link we can reason about.
      // The auth layer already degraded such a key to read_only, so it cannot
      // act as an operator key; we log it instead of guessing whose it is.
      logger.warn(
        { keyId: row.keyId, keyName: row.keyName },
        "monitoring link key has an unreadable scope; skipped by the watchdog",
      );
      continue;
    }
    if (options.companyId && scope.companyId !== options.companyId) continue;
    result.push({
      keyId: row.keyId,
      keyName: row.keyName,
      scope,
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      revokedAt: row.revokedAt,
    });
  }
  return result;
}

/**
 * The issue an alarm with this idempotency key created, if it is still open.
 * `issue_create_idempotency_keys` is the board's own dedup ledger, so this
 * lookup cannot disagree with the create path that wrote it.
 */
export async function findMonitoringLinkAlertIssue(
  db: Db,
  companyId: string,
  idempotencyKey: string,
): Promise<{ issueId: string; identifier: string | null; status: string } | null> {
  const row = await db
    .select({
      issueId: issueCreateIdempotencyKeys.issueId,
      identifier: issues.identifier,
      status: issues.status,
    })
    .from(issueCreateIdempotencyKeys)
    .innerJoin(issues, eq(issues.id, issueCreateIdempotencyKeys.issueId))
    .where(
      and(
        eq(issueCreateIdempotencyKeys.companyId, companyId),
        eq(issueCreateIdempotencyKeys.idempotencyKey, idempotencyKey),
      ),
    )
    .then((rows) => rows[0] ?? null);
  return row;
}

/**
 * The role the alarm belongs to. The issue asks for the observability role, so
 * the link's own `alertAssigneeAgentId` wins when an operator set one, and the
 * company's observability agent (the `observ*` name) is the default. No match
 * means the alarm still opens — unassigned but High — and the log says so,
 * because a silent drop is the failure this whole change exists to prevent.
 */
export async function resolveMonitoringLinkAlertAssignee(
  db: Db,
  companyId: string,
): Promise<string | null> {
  const row = await db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), sql`lower(${agents.name}) like '%observ%'`))
    .orderBy(agents.name)
    .then((rows) => rows[0] ?? null);
  if (row) return row.id;
  logger.warn(
    { companyId },
    "no observability agent in company; monitoring link alarm opens unassigned",
  );
  return null;
}