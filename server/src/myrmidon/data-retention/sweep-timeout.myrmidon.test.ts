// server/src/myrmidon/data-retention/sweep-timeout.myrmidon.test.ts
//
// OPE-8354: the runs batch of 5000 overran the statement timeout on the live
// board, so the sweep deleted nothing. The sweep now starts small, halves the
// batch when a batch still times out, and recognises the SQLSTATE on the
// wrapped driver error (err.cause.code).

import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createDataRetentionSweep,
  DATA_RETENTION_DELETE_BATCH_SIZE,
  DATA_RETENTION_MIN_BATCH_SIZE,
} from "./sweep.js";

const dialect = new PgDialect();

function timeoutError() {
  const cause = Object.assign(new Error("canceling statement due to statement timeout"), {
    code: "57014",
  });
  return Object.assign(new Error("Failed query"), { cause });
}

function makeSweep(opts: { maxBatchThatFits: number; totalRows: number; onlyWakeups?: boolean }) {
  let remaining = opts.totalRows;
  const limits: number[] = [];
  const wakeLimits: number[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const tx = {
    execute: async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const { sql: text, params } = dialect.sqlToQuery(query);
      if (/statement_timeout/.test(text)) return [];
      const limit = Number(params[params.length - 1]);
      limits.push(limit);
      if (/agent_wakeup_requests/.test(text)) wakeLimits.push(limit);
      if (limit > opts.maxBatchThatFits) throw timeoutError();
      const n = Math.min(limit, remaining);
      remaining -= n;
      return Array.from({ length: n }, (_, i) => ({ id: String(i), size: 16 }));
    },
  };
  const db = { transaction: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx) };
  let lastRun: Record<string, unknown> = {};
  const sweep = createDataRetentionSweep({
    db: db as never,
    resolveSettings: async () =>
      ({
        heartbeatRunsDays: opts.onlyWakeups ? 0 : 30,
        activityLogDays: opts.onlyWakeups ? 0 : 90,
        accessAuditDays: 0,
        secretAccessDays: 0,
        litellmCostEventsDays: 0,
        documentRevisionDays: opts.onlyWakeups ? 0 : 90,
        documentRevisionKeepPerDocument: opts.onlyWakeups ? 0 : 20,
        agentWakeupRequestsDays: 30,
        environmentLeasesDays: opts.onlyWakeups ? 0 : 30,
      }) as never,

    readLastRun: async () => {
      const empty = { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 };
      return {
        waitingForBackup: false,
        perTable: {
          runs: empty,
          activity: empty,
          access: empty,
          litellmCostEvents: empty,
          documentRevisions: empty,
          agentWakeupRequests: empty,
          environmentLeases: empty,
          executionWorkspaces: empty,
        },
        ...lastRun,
      } as never;
    },
    writeLastRun: async (value) => {
      lastRun = value as never;
    },
    checkBackup: async () => ({ fresh: true, checkedAt: new Date() }),
    logWaitingForBackup: async () => undefined,
    logThrottled: async (details) => {
      logs.push(details);
    },
    minPassIntervalMs: 0,
  });
  return { sweep, limits, wakeLimits, logs, remaining: () => remaining };
}

describe("OPE-8354 retention sweep under a statement timeout", () => {
  it("halves the batch after a timeout wrapped in err.cause and still deletes everything", async () => {
    const { sweep, limits, logs, remaining } = makeSweep({ maxBatchThatFits: 150, totalRows: 1_000 });
    const result = await sweep.sweep();
    expect(result.perTable.runs.deleted).toBe(1_000);
    expect(remaining()).toBe(0);
    // 500 -> timeout -> 250 -> timeout -> 125 fits
    expect(limits.slice(0, 3)).toEqual([DATA_RETENTION_DELETE_BATCH_SIZE, 250, 125]);
    // 6 groups x 2 halvings (500 -> 250 -> 125 fits): timed-out batches no longer use up
    // a group's per-pass batch limit, so every group, including the one-batch groups, still halves twice
    expect(logs).toHaveLength(12);
  });

  it("a one-batch-per-pass group retries a timed-out batch smaller and still deletes in the same pass", async () => {
    const { sweep, wakeLimits, logs } = makeSweep({ maxBatchThatFits: 250, totalRows: 1_000, onlyWakeups: true });
    const result = await sweep.sweep();
    // 500 times out (does not use up the single-batch limit), 250 completes it.
    expect(wakeLimits).toEqual([DATA_RETENTION_DELETE_BATCH_SIZE, 250]);
    expect(result.perTable.agentWakeupRequests.deleted).toBe(250);
    expect(logs.filter((log) => log.group === "agentWakeupRequests")).toHaveLength(1);
  });

  it("gives up for the pass at the floor when even the smallest batch times out", async () => {
    const { sweep, limits } = makeSweep({ maxBatchThatFits: 10, totalRows: 1_000 });
    const result = await sweep.sweep();
    expect(result.perTable.runs.deleted).toBe(0);
    expect(limits[limits.length - 1]).toBe(DATA_RETENTION_MIN_BATCH_SIZE);
  });
});
