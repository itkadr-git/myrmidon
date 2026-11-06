// myrmidon(OPE-11776): the shared, cached, time-bounded ledger spend read.
// A drizzle-shaped stub stands in for the database; the real query against
// embedded Postgres is covered by the metrics collector suite.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_SPEND_CACHE_TTL_MS,
  readAgentSpendWindows,
  resetAgentSpendWindowsCache,
} from "./key-spend.js";

type LedgerRow = Record<string, unknown>;

/** A db whose transaction runs the callback over a stub; `results` is consumed one per read. */
function stubDb(results: Array<LedgerRow[] | Error>) {
  let statements = 0;
  let reads = 0;
  const db = {
    transaction: async (callback: (tx: unknown) => Promise<unknown>) => {
      const next = results[reads++];
      if (next instanceof Error) throw next;
      const tx = {
        execute: async () => {
          statements += 1;
          return [];
        },
        select: () => ({
          from: () => ({
            where: () => ({ groupBy: async () => next ?? [] }),
          }),
        }),
      };
      return callback(tx);
    },
  };
  return { db: db as never, reads: () => reads, statements: () => statements };
}

const ROW = { companyId: "company-a", agentId: "agent-a", dailyCents: "1299", weeklyCents: "1699", zeroCostEvents: "2" };

describe("myrmidon(OPE-11776) ledger spend read", () => {
  beforeEach(() => {
    resetAgentSpendWindowsCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns numbers (the driver answers sums as strings) and sets the statement timeout first", async () => {
    const { db, statements } = stubDb([[ROW]]);
    const rows = await readAgentSpendWindows(db, new Date("2026-11-05T12:00:00.000Z"));
    expect(rows).toEqual([
      { companyId: "company-a", agentId: "agent-a", dailyCents: 1299, weeklyCents: 1699, zeroCostEvents: 2 },
    ]);
    // One transaction-local set_config before the aggregate.
    expect(statements()).toBe(1);
  });

  it("runs the aggregate directly on a minimal handle without transaction support", async () => {
    const db = {
      select: () => ({ from: () => ({ where: () => ({ groupBy: async () => [ROW] }) }) }),
    } as never;
    await expect(readAgentSpendWindows(db)).resolves.toEqual([
      { companyId: "company-a", agentId: "agent-a", dailyCents: 1299, weeklyCents: 1699, zeroCostEvents: 2 },
    ]);
  });

  it("reuses one read inside the TTL and joins concurrent callers", async () => {
    const { db, reads } = stubDb([[ROW], [ROW]]);
    const [first, second] = await Promise.all([readAgentSpendWindows(db), readAgentSpendWindows(db)]);
    await readAgentSpendWindows(db);
    expect(first).toBe(second);
    expect(reads()).toBe(1);
  });

  it("reads again once the TTL has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = new Date("2026-11-05T12:00:00.000Z");
    vi.setSystemTime(start);
    const { db, reads } = stubDb([[ROW], [ROW]]);
    await readAgentSpendWindows(db);
    vi.setSystemTime(new Date(start.getTime() + AGENT_SPEND_CACHE_TTL_MS + 1));
    await readAgentSpendWindows(db);
    expect(reads()).toBe(2);
  });

  it("does not cache a failed read", async () => {
    const { db, reads } = stubDb([new Error("canceling statement due to statement timeout"), [ROW]]);
    await expect(readAgentSpendWindows(db)).rejects.toThrow("statement timeout");
    await expect(readAgentSpendWindows(db)).resolves.toHaveLength(1);
    expect(reads()).toBe(2);
  });
});
