// server/src/myrmidon/process-registry/leases.ts
//
// myrmidon(1.6.5 PROCS-0.1): the read side of the leader leases — what the
// lease block of the «Процессы» panel shows (GET /api/myrmidon/processes/leases).
// The wire shape is the contract the UI reader keeps in
// ui/src/components/myrmidon/boardLeasesApi.ts. On a single-process board no
// lease is ever written, so the answer is an empty list.

import { asc } from "drizzle-orm";
import { boardLeases, type Db } from "@paperclipai/db";
import type { BoardProcessRow } from "./store.js";

export type BoardLeaseRow = {
  name: string;
  holderBootId: string | null;
  epoch: number;
  acquiredAt: Date | null;
  expiresAt: Date | null;
};

export interface BoardLeaseStore {
  /** Every lease row, by name (stable for the panel). */
  listLeases(): Promise<BoardLeaseRow[]>;
}

export function createBoardLeaseStore(db: Db): BoardLeaseStore {
  return {
    async listLeases() {
      const rows = await db.select().from(boardLeases).orderBy(asc(boardLeases.name));
      return rows.map((row) => ({
        name: row.name,
        holderBootId: row.holderBootId,
        // bigint column: the driver may hand a numeric string back.
        epoch: Number(row.epoch),
        acquiredAt: row.acquiredAt,
        expiresAt: row.expiresAt,
      }));
    },
  };
}

export type BoardLeaseHolderView = {
  bootId: string;
  role: string;
  pid: number;
  hostname: string;
  container: string | null;
  version: string;
  lastSeenAt: string;
};

export type BoardLeaseView = {
  name: string;
  holderBootId: string | null;
  epoch: number;
  acquiredAt: string | null;
  expiresAt: string | null;
  /** The TTL deadline has passed; a lease without a deadline never expires here. */
  expired: boolean;
  /** The process answering this request holds the lease. */
  isSelf: boolean;
  /** The holder's registry row; null when the process row is gone. */
  holder: BoardLeaseHolderView | null;
};

export type BoardLeasesView = {
  leases: BoardLeaseView[];
  selfBootId: string;
  serverTime: string;
};

export function serializeBoardLeases(input: {
  leases: BoardLeaseRow[];
  processes: BoardProcessRow[];
  bootId: string;
  at: Date;
}): BoardLeasesView {
  const byBootId = new Map(input.processes.map((process) => [process.bootId, process]));
  return {
    leases: input.leases.map((lease) => {
      const holderRow = lease.holderBootId ? byBootId.get(lease.holderBootId) : undefined;
      return {
        name: lease.name,
        holderBootId: lease.holderBootId,
        epoch: lease.epoch,
        acquiredAt: lease.acquiredAt ? lease.acquiredAt.toISOString() : null,
        expiresAt: lease.expiresAt ? lease.expiresAt.toISOString() : null,
        expired: lease.expiresAt !== null && lease.expiresAt.getTime() <= input.at.getTime(),
        isSelf: lease.holderBootId !== null && lease.holderBootId === input.bootId,
        holder: holderRow
          ? {
              bootId: holderRow.bootId,
              role: holderRow.role,
              pid: holderRow.pid,
              hostname: holderRow.hostname,
              container: holderRow.container,
              version: holderRow.version,
              lastSeenAt: holderRow.lastSeenAt.toISOString(),
            }
          : null,
      };
    }),
    selfBootId: input.bootId,
    serverTime: input.at.toISOString(),
  };
}
