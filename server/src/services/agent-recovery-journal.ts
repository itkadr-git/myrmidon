import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
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

export type AppendAgentRecoveryJournalResult<T = unknown> = {
  row: typeof agentRecoveryJournal.$inferSelect | null;
  disposition: "committed" | "duplicate";
  suppressed: boolean;
  executed: boolean;
  actionResult?: T;
};

export type AppendAgentRecoveryJournalOptions<T = unknown> = {
  dedupWindowMs?: number;
  now?: Date;
  action?: () => Promise<T> | T;
  execute?: () => Promise<T> | T;
};

const inFlightTails = new Map<string, Promise<void>>();

function withAgentRecoveryLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = inFlightTails.get(key) ?? Promise.resolve();
  const current = previous.then(fn, fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  inFlightTails.set(key, tail);
  void tail.then(() => {
    if (inFlightTails.get(key) === tail) inFlightTails.delete(key);
  });
  return current;
}

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

export async function appendAgentRecoveryJournal<T = unknown>(
  db: Db,
  input: AppendAgentRecoveryJournalInput & {
    action?: () => Promise<T> | T;
    execute?: () => Promise<T> | T;
  },
  opts: AppendAgentRecoveryJournalOptions<T> = {},
): Promise<AppendAgentRecoveryJournalResult<T>> {
  const now = input.at ?? opts.now ?? new Date();
  const dedupWindowMs = opts.dedupWindowMs ?? AGENT_RECOVERY_JOURNAL_DEDUP_WINDOW_MS;
  const lockKey = `agent-recovery:${input.companyId}:${input.agentId}:${input.dedupKey}`;

  const appendResult = await withAgentRecoveryLock(lockKey, () =>
    db.transaction(async (tx) => {
      if (typeof (tx as unknown as { execute?: unknown }).execute === "function") {
        await (tx as unknown as { execute: (stmt: unknown) => Promise<unknown> }).execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
        );
      }
      const since = new Date(now.getTime() - dedupWindowMs);
      const duplicate = await tx
        .select()
        .from(agentRecoveryJournal)
        .where(
          and(
            eq(agentRecoveryJournal.companyId, input.companyId),
            eq(agentRecoveryJournal.agentId, input.agentId),
            eq(agentRecoveryJournal.dedupKey, input.dedupKey),
            gte(agentRecoveryJournal.createdAt, since),
          ),
        )
        .orderBy(desc(agentRecoveryJournal.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null);

      if (duplicate) {
        return {
          row: duplicate,
          disposition: "duplicate" as const,
          suppressed: duplicate.suppressedReason !== null,
        };
      }

      const placement = await agentPlacement(tx as unknown as Db, input.agentId, input.companyId);
      const maintenance = await readMaintenanceDocument(tx as unknown as Db);
      const maintenanceSuppressed = blockingWindows(maintenance).some((window) =>
        windowCoversAgent(window, placement),
      );
      const excluded =
        maintenanceSuppressed || isWithinAgentRecoveryExclusionWindow(now, input.exclusionWindows ?? []);

      const [row] = await tx
        .insert(agentRecoveryJournal)
        .values({
          companyId: input.companyId,
          agentId: input.agentId,
          step: input.step,
          cause: input.cause,
          dedupKey: input.dedupKey,
          payload: input.payload ?? {},
          createdAt: now,
          suppressedReason: excluded ? "exclusion_window" : null,
        })
        .returning();

      return {
        row: row ?? null,
        disposition: "committed" as const,
        suppressed: excluded,
      };
    }),
  );

  const actionFn = input.action ?? input.execute ?? opts.action ?? opts.execute;
  if (!actionFn) {
    return {
      ...appendResult,
      executed: !appendResult.suppressed && appendResult.disposition === "committed",
    };
  }

  if (appendResult.disposition === "committed" && !appendResult.suppressed) {
    const actionResult = await actionFn();
    return {
      ...appendResult,
      executed: true,
      actionResult,
    };
  }

  return {
    ...appendResult,
    executed: false,
  };
}

export async function executeAgentRecoveryAction<T>(
  db: Db,
  input: AppendAgentRecoveryJournalInput,
  action: () => Promise<T> | T,
  opts: AppendAgentRecoveryJournalOptions<T> = {},
): Promise<AppendAgentRecoveryJournalResult<T>> {
  return appendAgentRecoveryJournal(db, { ...input, action }, opts);
}

export async function listAgentRecoveryJournal(
  db: Db,
  input: { companyId: string; agentId: string; limit: number; before?: Date },
) {
  const rows = await db
    .select()
    .from(agentRecoveryJournal)
    .where(
      and(
        eq(agentRecoveryJournal.companyId, input.companyId),
        eq(agentRecoveryJournal.agentId, input.agentId),
        input.before ? lt(agentRecoveryJournal.createdAt, input.before) : undefined,
      ),
    )
    .orderBy(desc(agentRecoveryJournal.createdAt), desc(agentRecoveryJournal.id))
    .limit(input.limit + 1);
  return {
    entries: rows.slice(0, input.limit),
    nextBefore: rows.length > input.limit ? rows[input.limit - 1]?.createdAt ?? null : null,
  };
}

export async function purgeExpiredAgentRecoveryJournal(db: Db, now = new Date()) {
  const cutoff = new Date(now.getTime() - AGENT_RECOVERY_JOURNAL_RETENTION_DAYS * 86_400_000);
  return db.delete(agentRecoveryJournal).where(lt(agentRecoveryJournal.createdAt, cutoff));
}
