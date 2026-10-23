// server/src/myrmidon/bot-containers/fleet-move-store.ts
//
// myrmidon(1.6.6 REMOTE-SITES-T5): Drizzle store for myrmidon_fleet_moves.

import { and, desc, eq } from "drizzle-orm";
import {
  myrmidonFleetMoves,
  type Db,
  type FleetMovePhaseLogEntry,
} from "@myrmidon/db";
import type { FleetMoveRecord, MovePhase, MovePhaseLogEntry } from "./fleet-move-service.js";

type FleetMoveRow = typeof myrmidonFleetMoves.$inferSelect;

function toRecord(row: FleetMoveRow): FleetMoveRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    botKey: row.botKey,
    srcSite: row.srcSite,
    dstSite: row.dstSite,
    phase: row.phase as MovePhase,
    phaseLog: (row.phaseLog as MovePhaseLogEntry[]) ?? [],
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    leaseExpires: row.leaseExpires,
    error: row.error,
  };
}

export interface FleetMoveStore {
  getMove(moveId: string): Promise<FleetMoveRecord | null>;
  getLatestMoveForBot(companyId: string, botKey: string): Promise<FleetMoveRecord | null>;
  createMove(params: {
    companyId: string;
    botKey: string;
    srcSite: string;
    dstSite: string;
  }): Promise<FleetMoveRecord>;
  updateMove(
    moveId: string,
    update: {
      phase: MovePhase;
      details?: string;
      error?: string | null;
      completedAt?: Date | null;
      leaseExpires?: Date | null;
    },
  ): Promise<FleetMoveRecord>;
}

export function fleetMoveStore(db: Db): FleetMoveStore {
  return {
    async getMove(moveId: string) {
      const rows = await db
        .select()
        .from(myrmidonFleetMoves)
        .where(eq(myrmidonFleetMoves.id, moveId))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async getLatestMoveForBot(companyId: string, botKey: string) {
      const rows = await db
        .select()
        .from(myrmidonFleetMoves)
        .where(
          and(
            eq(myrmidonFleetMoves.companyId, companyId),
            eq(myrmidonFleetMoves.botKey, botKey),
          ),
        )
        .orderBy(desc(myrmidonFleetMoves.startedAt))
        .limit(1);
      return rows[0] ? toRecord(rows[0]) : null;
    },

    async createMove(params) {
      const initialLog: FleetMovePhaseLogEntry[] = [
        {
          phase: "init",
          at: new Date().toISOString(),
          details: `Migration from ${params.srcSite} to ${params.dstSite} initiated`,
        },
      ];

      const inserted = await db
        .insert(myrmidonFleetMoves)
        .values({
          companyId: params.companyId,
          botKey: params.botKey,
          srcSite: params.srcSite,
          dstSite: params.dstSite,
          phase: "init",
          phaseLog: initialLog,
        })
        .returning();

      return toRecord(inserted[0]);
    },

    async updateMove(moveId, update) {
      const existing = await db
        .select()
        .from(myrmidonFleetMoves)
        .where(eq(myrmidonFleetMoves.id, moveId))
        .limit(1);
      if (!existing[0]) throw new Error(`Move "${moveId}" not found`);

      const current = existing[0];
      const logEntries = Array.isArray(current.phaseLog) ? [...current.phaseLog] : [];
      logEntries.push({
        phase: update.phase,
        at: new Date().toISOString(),
        details: update.details,
        error: update.error ?? undefined,
      });

      const updated = await db
        .update(myrmidonFleetMoves)
        .set({
          phase: update.phase,
          phaseLog: logEntries,
          error: update.error !== undefined ? update.error : current.error,
          completedAt: update.completedAt !== undefined ? update.completedAt : current.completedAt,
          leaseExpires: update.leaseExpires !== undefined ? update.leaseExpires : current.leaseExpires,
          updatedAt: new Date(),
        })
        .where(eq(myrmidonFleetMoves.id, moveId))
        .returning();

      return toRecord(updated[0]);
    },
  };
}
