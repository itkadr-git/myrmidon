// server/src/myrmidon/bot-containers/fleet-memory-sync-store.ts
//
// myrmidon(1.6.6 C-MEM): Drizzle store for myrmidon_fleet_memory_syncs, the journal of the memory
// sync of execution sites. One row is one attempt; the partial unique index allows one running
// attempt per site, so the claim is the insert, not a read followed by an insert.

import { and, desc, eq, lt } from "drizzle-orm";
import { myrmidonFleetMemorySyncs, type Db } from "@myrmidon/db";

export type MemorySyncKind = "nightly" | "forced" | "manual";
export type MemorySyncStatus = "running" | "ok" | "failed";

export interface FleetMemorySyncRecord {
  id: string;
  companyId: string;
  siteName: string;
  kind: MemorySyncKind;
  status: MemorySyncStatus;
  targetBank: string;
  botKey: string | null;
  moveId: string | null;
  archiveBytes: number | null;
  documentsImported: number | null;
  documentsSkipped: number | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface FleetMemorySyncResult {
  status: "ok" | "failed";
  archiveBytes?: number | null;
  documentsImported?: number | null;
  documentsSkipped?: number | null;
  error?: string | null;
}

export interface FleetMemorySyncStore {
  /**
   * Claims the site's running slot and writes the attempt as `running`. Attempts that stayed
   * `running` longer than `staleAfterMs` (a board process that died mid-sync) are first closed as
   * failed. Returns null when another attempt holds the slot.
   */
  begin(params: {
    companyId: string;
    siteName: string;
    kind: MemorySyncKind;
    targetBank: string;
    botKey?: string | null;
    moveId?: string | null;
    staleAfterMs: number;
    now?: Date;
  }): Promise<FleetMemorySyncRecord | null>;
  finish(id: string, result: FleetMemorySyncResult, now?: Date): Promise<void>;
  /** When the last successful sync of the site finished, or null when there is none. */
  lastOkAt(companyId: string, siteName: string): Promise<Date | null>;
  /** Newest first. */
  list(companyId: string, opts?: { siteName?: string; limit?: number }): Promise<FleetMemorySyncRecord[]>;
}

type Row = typeof myrmidonFleetMemorySyncs.$inferSelect;

function toRecord(row: Row): FleetMemorySyncRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    siteName: row.siteName,
    kind: row.kind as MemorySyncKind,
    status: row.status as MemorySyncStatus,
    targetBank: row.targetBank,
    botKey: row.botKey,
    moveId: row.moveId,
    archiveBytes: row.archiveBytes,
    documentsImported: row.documentsImported,
    documentsSkipped: row.documentsSkipped,
    error: row.error,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
  };
}

function isUniqueViolation(err: unknown): boolean {
  for (let cause: unknown = err, depth = 0; cause && depth < 4; depth += 1) {
    if ((cause as { code?: unknown }).code === "23505") return true;
    cause = (cause as { cause?: unknown }).cause;
  }
  return false;
}

export function fleetMemorySyncStore(db: Db): FleetMemorySyncStore {
  return {
    async begin(params) {
      const now = params.now ?? new Date();
      await db
        .update(myrmidonFleetMemorySyncs)
        .set({ status: "failed", error: "abandoned: the board process stopped before the sync finished", finishedAt: now })
        .where(
          and(
            eq(myrmidonFleetMemorySyncs.companyId, params.companyId),
            eq(myrmidonFleetMemorySyncs.siteName, params.siteName),
            eq(myrmidonFleetMemorySyncs.status, "running"),
            lt(myrmidonFleetMemorySyncs.startedAt, new Date(now.getTime() - params.staleAfterMs)),
          ),
        );
      try {
        const [row] = await db
          .insert(myrmidonFleetMemorySyncs)
          .values({
            companyId: params.companyId,
            siteName: params.siteName,
            kind: params.kind,
            status: "running",
            targetBank: params.targetBank,
            botKey: params.botKey ?? null,
            moveId: params.moveId ?? null,
            startedAt: now,
          })
          .returning();
        return row ? toRecord(row) : null;
      } catch (err) {
        if (isUniqueViolation(err)) return null;
        throw err;
      }
    },

    async finish(id, result, now = new Date()) {
      await db
        .update(myrmidonFleetMemorySyncs)
        .set({
          status: result.status,
          archiveBytes: result.archiveBytes ?? null,
          documentsImported: result.documentsImported ?? null,
          documentsSkipped: result.documentsSkipped ?? null,
          error: result.error ?? null,
          finishedAt: now,
        })
        .where(and(eq(myrmidonFleetMemorySyncs.id, id), eq(myrmidonFleetMemorySyncs.status, "running")));
    },

    async lastOkAt(companyId, siteName) {
      const [row] = await db
        .select({ finishedAt: myrmidonFleetMemorySyncs.finishedAt })
        .from(myrmidonFleetMemorySyncs)
        .where(
          and(
            eq(myrmidonFleetMemorySyncs.companyId, companyId),
            eq(myrmidonFleetMemorySyncs.siteName, siteName),
            eq(myrmidonFleetMemorySyncs.status, "ok"),
          ),
        )
        .orderBy(desc(myrmidonFleetMemorySyncs.finishedAt))
        .limit(1);
      return row?.finishedAt ?? null;
    },

    async list(companyId, opts = {}) {
      const rows = await db
        .select()
        .from(myrmidonFleetMemorySyncs)
        .where(
          opts.siteName
            ? and(eq(myrmidonFleetMemorySyncs.companyId, companyId), eq(myrmidonFleetMemorySyncs.siteName, opts.siteName))
            : eq(myrmidonFleetMemorySyncs.companyId, companyId),
        )
        .orderBy(desc(myrmidonFleetMemorySyncs.startedAt))
        .limit(Math.min(Math.max(opts.limit ?? 50, 1), 500));
      return rows.map(toRecord);
    },
  };
}
