import { createDb } from "../../../packages/db/src/client.js";
import { sql } from "drizzle-orm";

export type PendingCard = {
  id: string;
  issueIdentifier: string | null;
  kind: string;
  createdByAgentId: string | null;
  addresseeAgentId: string | null;
  addresseeUserId: string | null;
  requestedResolverPolicy: string;
  effectiveResolverPolicy: string;
  payload: Record<string, unknown>;
};

export type ReaddressResult = PendingCard & {
  proposedRecipient: string | "unresolved";
  reason?: string;
};

/** Never invent a person: audience policies are not deterministic recipients. */
export function resolveAddresslessCard(card: PendingCard): ReaddressResult {
  const policy = card.effectiveResolverPolicy;
  if (card.addresseeAgentId || card.addresseeUserId) {
    return { ...card, proposedRecipient: card.addresseeAgentId ?? `user:${card.addresseeUserId}` };
  }
  if (policy === "human_only") {
    return { ...card, proposedRecipient: "unresolved", reason: "human_only requires a human/board recipient" };
  }
  if (policy === "not_creator") {
    return { ...card, proposedRecipient: "unresolved", reason: "not_creator excludes the creator, but no independent recipient is specified" };
  }
  if (policy === "anyone") {
    return { ...card, proposedRecipient: "unresolved", reason: "anyone defines an audience, not a deterministic recipient" };
  }
  return { ...card, proposedRecipient: "unresolved", reason: `unsupported effective resolver policy: ${policy}` };
}

/** Read-only snapshot; never mutates interaction rows. */
export async function loadReport(databaseUrl: string): Promise<ReaddressResult[]> {
  const db = createDb(databaseUrl);
  try {
    return await db.transaction(async (tx) => {
      const result = await tx.execute(sql`
        SELECT i.id,
               issues.identifier AS "issueIdentifier",
               i.kind,
               i.created_by_agent_id AS "createdByAgentId",
               i.addressee_agent_id AS "addresseeAgentId",
               i.addressee_user_id AS "addresseeUserId",
               i.requested_resolver_policy AS "requestedResolverPolicy",
               i.effective_resolver_policy AS "effectiveResolverPolicy",
               i.payload
        FROM issue_thread_interactions i
        LEFT JOIN issues ON issues.id = i.issue_id AND issues.company_id = i.company_id
        WHERE i.status = 'pending'
          AND i.addressee_agent_id IS NULL
          AND i.addressee_user_id IS NULL
        ORDER BY i.created_at, i.id
      `);
      return result.map((row) => resolveAddresslessCard(row as PendingCard));
    }, { accessMode: "read only" });
  } finally {
    await db.$client.end();
  }
}

function csvValue(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

export function formatReport(rows: ReaddressResult[], format: "json" | "csv"): string {
  if (format === "json") return `${JSON.stringify(rows, null, 2)}\n`;
  const fields = ["id", "issueIdentifier", "kind", "createdByAgentId", "requestedResolverPolicy", "effectiveResolverPolicy", "proposedRecipient", "reason"] as const;
  return `${fields.join(",")}\n${rows.map((row) => fields.map((field) => csvValue(row[field])).join(",")).join("\n")}\n`;
}
