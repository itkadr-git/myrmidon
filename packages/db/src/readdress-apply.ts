import { sql } from "drizzle-orm";
import { createDb, type Db } from "./index.js";
import { resolveAddresslessCard, type PendingCard } from "./readdress-report.js";

export interface ReaddressApplyOptions {
  /**
   * If true, calculate actions without mutating the database.
   * Defaults to true (dry-run).
   */
  dryRun?: boolean;
  /**
   * Reference timestamp for relative timeouts.
   * Defaults to new Date().
   */
  now?: Date;
}

export interface ReaddressApplyItem {
  id: string;
  issueIdentifier: string | null;
  proposedRecipient: string;
  routeType: string;
  timeoutAt: Date;
  status: "applied" | "dry_run" | "unresolved" | "skipped";
  reason?: string;
}

export interface ReaddressApplyResult {
  dryRun: boolean;
  totalCandidates: number;
  appliedCount: number;
  unresolvedCount: number;
  skippedCount: number;
  items: ReaddressApplyItem[];
}

export function computeRouteType(card: PendingCard): string {
  const rawRouting = (card.payload?.routing ?? card.payload ?? {}) as Record<string, unknown>;
  return rawRouting.routeType === "code_review" ||
    rawRouting.routeType === "approval" ||
    rawRouting.routeType === "operator_action" ||
    rawRouting.routeType === "human_input"
    ? (rawRouting.routeType as string)
    : "decision";
}

export function computeTimeoutAt(card: PendingCard, now = new Date()): Date {
  const rawRouting = (card.payload?.routing ?? card.payload ?? {}) as Record<string, unknown>;
  if (typeof rawRouting.timeoutAt === "string") {
    const parsed = new Date(rawRouting.timeoutAt);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  const effectivePolicy = (
    rawRouting.escalationPolicy ??
    rawRouting.policy ??
    (card.executionPolicy as Record<string, unknown> | null)?.reviewEscalationPolicy
  ) as Record<string, unknown> | undefined;

  const stepDelayMinutes =
    typeof effectivePolicy?.stepDelayMinutes === "number" &&
    Number.isFinite(effectivePolicy.stepDelayMinutes)
      ? effectivePolicy.stepDelayMinutes
      : null;

  if (stepDelayMinutes !== null && stepDelayMinutes > 0) {
    return new Date(now.getTime() + stepDelayMinutes * 60_000);
  }

  return new Date("9999-12-31T23:59:59.000Z");
}

function recipientFromLabel(label: string): Record<string, string> {
  const separator = label.indexOf(":");
  if (separator <= 0 || separator === label.length - 1) {
    throw new Error(`Invalid escalation recipient label: ${label}`);
  }
  const kind = label.slice(0, separator);
  const value = label.slice(separator + 1);
  if (kind === "agent") return { agentId: value };
  if (kind === "user") return { userId: value };
  if (kind === "queue") return { serviceQueue: value };
  throw new Error(`Unknown escalation recipient label: ${label}`);
}

function buildStoredEscalationChain(
  escalationChain: Array<{ recipient: string; afterMinutes: number | null }> | undefined,
): Array<{ recipient: Record<string, string>; afterMinutes: number }> | null {
  if (!escalationChain?.length || escalationChain.some((step) => step.afterMinutes === null)) {
    return null;
  }
  return escalationChain.map((step) => ({
    recipient: recipientFromLabel(step.recipient),
    afterMinutes: step.afterMinutes as number,
  }));
}

export async function applyReaddress(
  databaseUrlOrDb: string | Db,
  options: ReaddressApplyOptions = {},
): Promise<ReaddressApplyResult> {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();

  const isExternalDb = typeof databaseUrlOrDb !== "string";
  const db = isExternalDb ? databaseUrlOrDb : createDb(databaseUrlOrDb);

  try {
    const candidateRows = await db.execute(sql`
      SELECT i.id,
             i.company_id AS "companyId",
             issues.identifier AS "issueIdentifier",
             i.kind,
             i.created_by_agent_id AS "createdByAgentId",
             i.created_by_user_id AS "createdByUserId",
             i.addressee_agent_id AS "addresseeAgentId",
             i.addressee_user_id AS "addresseeUserId",
             i.addressee_queue AS "addresseeQueue",
             i.route_type AS "routeType",
             i.timeout_at AS "timeoutAt",
             i.escalation_level AS "escalationLevel",
             i.requested_resolver_policy AS "requestedResolverPolicy",
             i.effective_resolver_policy AS "effectiveResolverPolicy",
             i.payload,
             issues.project_id AS "projectId",
             issues.caste_key AS "casteKey",
             issues.execution_policy AS "executionPolicy",
             projects.lead_agent_id AS "projectLeadAgentId",
             COALESCE((
               SELECT jsonb_object_agg(member_id, true)
               FROM (
                 SELECT projects.lead_agent_id::text AS member_id
                 WHERE projects.lead_agent_id IS NOT NULL
                 UNION
                 SELECT pm.user_id::text AS member_id
                 FROM project_memberships pm
                 JOIN agents a ON a.id::text = pm.user_id AND a.company_id = pm.company_id
                 WHERE pm.company_id = issues.company_id
                   AND pm.project_id = issues.project_id
                   AND pm.state = 'joined'
                 UNION
                 SELECT an.agent_id::text AS member_id
                 FROM agent_nests an
                 WHERE an.company_id = issues.company_id
                   AND an.project_id = issues.project_id
               ) m
             ), '{}'::jsonb) AS "projectMemberships"
      FROM issue_thread_interactions i
      LEFT JOIN issues ON issues.id = i.issue_id AND issues.company_id = i.company_id
      LEFT JOIN projects ON projects.id = issues.project_id AND projects.company_id = issues.company_id
      WHERE i.status = 'pending'
        AND i.addressee_agent_id IS NULL
        AND i.addressee_user_id IS NULL
        AND i.addressee_queue IS NULL
      ORDER BY i.created_at, i.id
    `);

    const rows = candidateRows as unknown as PendingCard[];
    const items: ReaddressApplyItem[] = [];
    let appliedCount = 0;
    let unresolvedCount = 0;
    let skippedCount = 0;

    for (const card of rows) {
      const resolution = resolveAddresslessCard(card);
      if (resolution.proposedRecipient === "unresolved") {
        unresolvedCount++;
        items.push({
          id: card.id,
          issueIdentifier: card.issueIdentifier,
          proposedRecipient: "unresolved",
          routeType: "",
          timeoutAt: new Date(0),
          status: "unresolved",
          reason: resolution.reason,
        });
        continue;
      }

      let addresseeAgentId: string | null = null;
      let addresseeUserId: string | null = null;
      let addresseeQueue: string | null = null;
      let toRecipientJson: Record<string, unknown> = {};

      if (resolution.proposedRecipient.startsWith("agent:")) {
        addresseeAgentId = resolution.proposedRecipient.slice(6);
        toRecipientJson = { agentId: addresseeAgentId };
      } else if (resolution.proposedRecipient.startsWith("user:")) {
        addresseeUserId = resolution.proposedRecipient.slice(5);
        toRecipientJson = { userId: addresseeUserId };
      } else if (resolution.proposedRecipient.startsWith("queue:")) {
        addresseeQueue = resolution.proposedRecipient.slice(6);
        toRecipientJson = { serviceQueue: addresseeQueue };
      } else {
        skippedCount++;
        items.push({
          id: card.id,
          issueIdentifier: card.issueIdentifier,
          proposedRecipient: resolution.proposedRecipient,
          routeType: "",
          timeoutAt: new Date(0),
          status: "skipped",
          reason: `Unknown recipient scheme: ${resolution.proposedRecipient}`,
        });
        continue;
      }

      const routeType = computeRouteType(card);
      const timeoutAt = computeTimeoutAt(card, now);
      const escalationChain = buildStoredEscalationChain(resolution.escalationChain);

      if (dryRun) {
        appliedCount++;
        items.push({
          id: card.id,
          issueIdentifier: card.issueIdentifier,
          proposedRecipient: resolution.proposedRecipient,
          routeType,
          timeoutAt,
          status: "dry_run",
        });
      } else {
        await db.transaction(async (tx) => {
          const updateResult = await tx.execute(sql`
            UPDATE issue_thread_interactions
            SET addressee_agent_id = ${addresseeAgentId}::uuid,
                addressee_user_id = ${addresseeUserId}::text,
                addressee_queue = ${addresseeQueue}::text,
                route_type = ${routeType}::text,
                timeout_at = ${timeoutAt.toISOString()}::timestamptz,
                escalation_chain = ${escalationChain ? JSON.stringify(escalationChain) : null}::jsonb,
                updated_at = ${now.toISOString()}::timestamptz
            WHERE id = ${card.id}::uuid
              AND status = 'pending'
              AND addressee_agent_id IS NULL
              AND addressee_user_id IS NULL
              AND addressee_queue IS NULL
          `);

          const rowCount = (updateResult as { rowCount?: number })?.rowCount ?? 1;
          if (rowCount > 0 && card.companyId) {
            const level = card.escalationLevel ?? 0;
            await tx.execute(sql`
              INSERT INTO interaction_escalations (
                company_id,
                interaction_id,
                level,
                from_recipient,
                to_recipient,
                reason,
                created_at
              ) VALUES (
                ${card.companyId}::uuid,
                ${card.id}::uuid,
                ${level}::integer,
                '{}'::jsonb,
                ${JSON.stringify(toRecipientJson)}::jsonb,
                'readdress',
                ${now.toISOString()}::timestamptz
              )
              ON CONFLICT ("interaction_id", "level") DO NOTHING
            `);
          }
        });

        appliedCount++;
        items.push({
          id: card.id,
          issueIdentifier: card.issueIdentifier,
          proposedRecipient: resolution.proposedRecipient,
          routeType,
          timeoutAt,
          status: "applied",
        });
      }
    }

    return {
      dryRun,
      totalCandidates: rows.length,
      appliedCount,
      unresolvedCount,
      skippedCount,
      items,
    };
  } finally {
    if (!isExternalDb && "end" in db && typeof (db as { end?: unknown }).end === "function") {
      await (db as unknown as { end: () => Promise<void> }).end();
    }
  }
}

export function formatApplySummary(result: ReaddressApplyResult, format: "text" | "json" | "csv" = "text"): string {
  if (format === "json") {
    return JSON.stringify(result, null, 2);
  }

  if (format === "csv") {
    const headers = ["id", "issueIdentifier", "status", "proposedRecipient", "routeType", "timeoutAt", "reason"];
    const rows = result.items.map((item) => [
      item.id,
      item.issueIdentifier ?? "",
      item.status,
      item.proposedRecipient,
      item.routeType,
      item.timeoutAt && item.timeoutAt.getTime() > 0 ? item.timeoutAt.toISOString() : "",
      item.reason ? `"${item.reason.replace(/"/g, '""')}"` : "",
    ]);
    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }

  const mode = result.dryRun ? "DRY-RUN (no changes made)" : "APPLY (database updated)";
  const lines = [
    `=== Interaction Readdress: ${mode} ===`,
    `Total candidates: ${result.totalCandidates}`,
    result.dryRun ? `Proposed to apply: ${result.appliedCount}` : `Applied: ${result.appliedCount}`,
    `Unresolved: ${result.unresolvedCount}`,
    ...(result.skippedCount > 0 ? [`Skipped: ${result.skippedCount}`] : []),
    "",
  ];

  if (result.items.length > 0) {
    lines.push("Details:");
    for (const item of result.items) {
      const issue = item.issueIdentifier ? `[${item.issueIdentifier}]` : "";
      if (item.status === "applied" || item.status === "dry_run") {
        lines.push(`  - ${item.id} ${issue} -> ${item.proposedRecipient} (route: ${item.routeType}, timeout: ${item.timeoutAt.toISOString()}) [${item.status}]`);
      } else {
        lines.push(`  - ${item.id} ${issue} -> ${item.status}${item.reason ? `: ${item.reason}` : ""}`);
      }
    }
  }

  return lines.join("\n");
}
