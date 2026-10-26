#!/usr/bin/env node
import { createDb } from "@myrmidon/db";
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

export async function loadReport(databaseUrl: string): Promise<ReaddressResult[]> {
  const db = createDb(databaseUrl);
  try {
    return await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION READ ONLY`);
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
      const rows = Array.isArray(result) ? result : (result as { rows?: PendingCard[] }).rows ?? [];
      return rows.map((row) => resolveAddresslessCard(row as PendingCard));
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

async function main(argv: string[]): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    return 2;
  }
  const formatArg = argv.find((arg) => arg.startsWith("--format="))?.slice("--format=".length) ?? "json";
  if (formatArg !== "json" && formatArg !== "csv") {
    console.error("--format must be json or csv");
    return 2;
  }
  try {
    process.stdout.write(formatReport(await loadReport(url), formatArg));
    return 0;
  } catch (error) {
    console.error(`readdress-report failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
