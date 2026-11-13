import { and, desc, eq, gte, lt } from "drizzle-orm";
import { agentRecoveryJournal, agents, type Db } from "@myrmidon/db";
import {
  AGENT_RECOVERY_JOURNAL_DEDUP_WINDOW_MS,
  AGENT_RECOVERY_JOURNAL_RETENTION_DAYS,
  isWithinAgentRecoveryExclusionWindow,
  type AgentRecoveryJournalExclusionWindow,
  type AppendAgentRecoveryJournalInput,
} from "@myrmidon/shared";
import { blockingWindows, windowCoversAgent } from "../myrmidon/maintenance/domain.js";
import { readMaintenanceDocument } from "../myrmidon/maintenance/store.js";

export type AppendAgentRecoveryJournalResult = {
  row: typeof agentRecoveryJournal.$inferSelect | null;
  disposition: "committed" | "duplicate";
  suppressed: boolean;
};

async function agentPlacement(db: Db, agentId: string, companyId: string) {
  const rows = await db
    .select({ id: agents.id, reportsTo: agents.reportsTo })
    .from(agents)
    .where(eq(agents.companyId, companyId));
  const reports = new Map(rows.map((row) => [row.id, row.reportsTo]));
  const chain: string[] = [];
  const seen = new Set<string>();
  let current: string | null | undefined = agentId;
  while (current && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = reports.get(current) ?? null;
  }
  return { agentId, companyId, chain };
}

export async function appendAgentRecoveryJournal(
  db: Db,
  input: AppendAgentRecoveryJournalInput,
  opts: { dedupWindowMs?: number; now?: Date } = {},
): Promise<AppendAgentRecoveryJournalResult> {
  const now = input.at ?? opts.now ?? new Date();
  const dedupWindowMs = opts.dedupWindowMs ?? AGENT_RECOVERY_JOURNAL_DEDUP_WINDOW_MS;
  return db.transaction(async (tx) => {
    const since = new Date(now.getTime() - dedupWindowMs);
    const duplicate = await tx.select().from(agentRecoveryJournal).where(and(
      eq(agentRecoveryJournal.companyId, input.companyId),
      eq(agentRecoveryJournal.agentId, input.agentId),
      eq(agentRecoveryJournal.dedupKey, input.dedupKey),
      gte(agentRecoveryJournal.createdAt, since),
    )).orderBy(desc(agentRecoveryJournal.createdAt)).limit(1).then((rows) => rows[0] ?? null);
    if (duplicate) return { row: duplicate, disposition: "duplicate" as const, suppressed: duplicate.suppressedReason !== null };

    const placement = await agentPlacement(tx as unknown as Db, input.agentId, input.companyId);
    const maintenance = await readMaintenanceDocument(tx as unknown as Db);
    const maintenanceSuppressed = blockingWindows(maintenance).some((window) => windowCoversAgent(window, placement));
    const excluded = maintenanceSuppressed || isWithinAgentRecoveryExclusionWindow(now, input.exclusionWindows ?? []);
    const [row] = await tx.insert(agentRecoveryJournal).values({
      companyId: input.companyId, agentId: input.agentId, step: input.step, cause: input.cause,
      dedupKey: input.dedupKey, payload: input.payload ?? {}, createdAt: now,
      suppressedReason: excluded ? "exclusion_window" : null,
    }).returning();
    return { row: row ?? null, disposition: "committed" as const, suppressed: excluded };
  });
}

export async function listAgentRecoveryJournal(db: Db, input: { companyId: string; agentId: string; limit: number; before?: Date }) {
  const rows = await db.select().from(agentRecoveryJournal).where(and(
    eq(agentRecoveryJournal.companyId, input.companyId), eq(agentRecoveryJournal.agentId, input.agentId),
    input.before ? lt(agentRecoveryJournal.createdAt, input.before) : undefined,
  )).orderBy(desc(agentRecoveryJournal.createdAt), desc(agentRecoveryJournal.id)).limit(input.limit + 1);
  return { entries: rows.slice(0, input.limit), nextBefore: rows.length > input.limit ? rows[input.limit - 1]?.createdAt ?? null : null };
}

export async function purgeExpiredAgentRecoveryJournal(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - AGENT_RECOVERY_JOURNAL_RETENTION_DAYS * 86_400_000);
  return db.delete(agentRecoveryJournal).where(lt(agentRecoveryJournal.createdAt, cutoff));
}
