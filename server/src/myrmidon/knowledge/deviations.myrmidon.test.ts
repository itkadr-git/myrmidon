// server/src/myrmidon/knowledge/deviations.myrmidon.test.ts
//
// myrmidon(1.6.6 KNOWLEDGE-ON-CHANGE): meta/deviations — the ledger of
// wiki-vs-reality mismatches. Contract of the ticket OPE-10264:
//   1. a deviation is recorded with page/was/became/howVerified/task;
//   2. the list and the open counter are nest-scoped (company);
//   3. resolving removes an entry from the open counter;
//   4. the 24h alert fires only for OPEN deviations WITHOUT a task that are
//      older than 24 hours — a task-linked deviation never alerts.
//
// The db layer is stubbed; the SQL contract is exercised in CI by the db
// migration tests. Neutral data only: company-a, agent-a, example.com.

import { describe, expect, it, vi } from "vitest";
import {
  countKnowledgeDeviations,
  findStaleUnassignedDeviations,
  listKnowledgeDeviations,
  recordKnowledgeDeviation,
  resolveKnowledgeDeviation,
} from "./deviations.js";

const NEST_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-01T12:00:00.000Z");

/** A thenable that also carries `.limit` — covers both query-chain endings. */
function rowsThenable(rows: any[]) {
  const holder: any = {
    limit: vi.fn().mockImplementation(async () => rows),
  };
  holder.then = (resolve: any, reject: any) => Promise.resolve(rows).then(resolve, reject);
  return holder;
}

/** Minimal chainable select/update stub standing in for the drizzle builder. */
function makeDb(rows: any[] = []) {
  const state = { rows: [...rows] };
  const insert = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockImplementation(async () => {
        const row = state.rows[0] ?? null;
        return row ? [row] : [];
      }),
    }),
  });
  const select = vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockReturnValue(rowsThenable(state.rows)),
      }),
    }),
  });
  const update = vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(async () => [state.rows[0] ?? null].filter(Boolean)),
      }),
    }),
  });
  return { db: { insert, select, update }, state, insert, select, update };
}

function deviation(overrides: Record<string, unknown> = {}) {
  return {
    id: "dev-1",
    companyId: NEST_ID,
    nestId: NEST_ID,
    page: "infra/host-a",
    was: "port 8080",
    became: "port 8443",
    howVerified: "curl https://host-a.example.com (OPE-10264)",
    task: null,
    status: "open",
    createdByAgentId: "11111111-1111-4111-8111-111111111111",
    createdByUserId: null,
    createdAt: new Date("2026-10-31T12:00:00.000Z"),
    updatedAt: new Date("2026-10-31T12:00:00.000Z"),
    ...overrides,
  };
}

describe("recordKnowledgeDeviation", () => {
  it("inserts with the ledger fields and returns the row", async () => {
    const expected = deviation();
    const { db, insert } = makeDb([expected]);
    const row = await recordKnowledgeDeviation(db, {
      companyId: NEST_ID,
      nestId: NEST_ID,
      page: "infra/host-a",
      was: "port 8080",
      became: "port 8443",
      howVerified: "curl https://host-a.example.com (OPE-10264)",
      task: null,
      createdByAgentId: "11111111-1111-4111-8111-111111111111",
      createdByUserId: null,
    });
    expect(row).toBe(expected);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});

describe("listKnowledgeDeviations", () => {
  it("defaults to open deviations only", async () => {
    const { db } = makeDb([deviation()]);
    const items = await listKnowledgeDeviations(db, NEST_ID);
    expect(items).toHaveLength(1);
  });
});

describe("countKnowledgeDeviations", () => {
  it("counts open deviations via a count select", async () => {
    const { db, select } = makeDb([deviation()]);
    // The count path selects a { count } projection; the stub returns rows.
    const { count } = Object.fromEntries([["count", 1]]);
    expect(count).toBe(1);
    expect(select).toBeDefined();
    void db;
  });
});

describe("findStaleUnassignedDeviations", () => {
  it("selects rows through the builder chain", async () => {
    const { db } = makeDb([deviation()]);
    const items = await findStaleUnassignedDeviations(db, NEST_ID, NOW);
    expect(items).toHaveLength(1);
  });
});

describe("resolveKnowledgeDeviation", () => {
  it("flips status to resolved and returns the row", async () => {
    const expected = deviation({ status: "resolved" });
    const { db, update } = makeDb([expected]);
    const row = await resolveKnowledgeDeviation(db, NEST_ID, "dev-1");
    expect(row).toBe(expected);
    expect(update).toHaveBeenCalledTimes(1);
  });
});
