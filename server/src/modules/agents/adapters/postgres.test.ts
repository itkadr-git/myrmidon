// server/src/modules/agents/adapters/postgres.test.ts
//
// myrmidon(1.7 TIER-QUOTA-CHECK OPE-12092): unit tests for the Postgres
// CompanyTierReader. The reviewer's changes-requested on PR #2712 asked to
// distinguish a genuinely absent tier row / not-deployed schema from a
// database READ FAILURE, and to stop letting those failures swallow the
// quota check. These tests pin that contract for the adapter itself:
//
// - isSchemaDeployed: real answer when the probe works; `false` only when the
//   table is genuinely absent (42704 undefined_object), NOT on connection
//   failures (rethrow).
// - getCompanyTier: tier row -> info; empty result -> null; transport failure
//   -> rethrow (null would silently apply the free/5 default).
// - countActiveAgents: real count; transport failure -> rethrow (0 would
//   silently bypass quota enforcement).
//
// The db doubles here are the smallest shape the adapter actually touches
// (`execute` for the raw SQL probe/tier read, `select().from().where()` for
// the agent count), so no embedded database is needed to pin the behaviour.

import { describe, expect, it, vi } from "vitest";
import { createPostgresCompanyTierReader } from "./postgres.js";

type Row = Record<string, unknown>;

function connectionFailure(cause = "connection refused"): { execute: never; select: never } {
  const err = new Error(cause);
  return {
    execute: Object.assign(vi.fn(async () => {
      throw err;
    }), {}) as never,
    select: Object.assign(vi.fn(() => {
      throw err;
    }), {}) as never,
  };
}

function selectCountChain(rows: Row[]): { select: unknown } {
  const where = vi.fn(async () => rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select };
}

function resultOf(rows: Row[]): { rows: Row[] } {
  return { rows };
}

describe("postgres company tier reader (1.7 TIER-QUOTA-CHECK)", () => {
  describe("isSchemaDeployed", () => {
    it("returns true when the to_regclass probe reports the table as deployed", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([{ deployed: true }])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.isSchemaDeployed()).resolves.toBe(true);
    });

    it("returns false when the probe answers null (table genuinely absent)", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([{ deployed: false }])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.isSchemaDeployed()).resolves.toBe(false);
    });

    it("returns false when the probe returns no rows (no answer)", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.isSchemaDeployed()).resolves.toBe(false);
    });

    it("rethrows transport failures instead of treating them as not deployed", async () => {
      const db = connectionFailure("probe failed");
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.isSchemaDeployed()).rejects.toThrow("probe failed");
    });
  });

  describe("getCompanyTier", () => {
    it("returns the tier info for an existing company row", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([{ tier: "pro", agent_quota: 20 }])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.getCompanyTier("comp-1")).resolves.toEqual({
        tier: "pro",
        agentQuota: 20,
      });
    });

    it("returns null when the company genuinely has no tier row", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.getCompanyTier("comp-1")).resolves.toBeNull();
    });

    it("returns null when the tier column is null (row exists without a tier)", async () => {
      const db = {
        execute: vi.fn(async () => resultOf([{ tier: null, agent_quota: null }])),
      };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.getCompanyTier("comp-1")).resolves.toBeNull();
    });

    it("rethrows transport failures instead of treating them as an absent tier", async () => {
      const db = connectionFailure("tier lookup failed");
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.getCompanyTier("comp-1")).rejects.toThrow("tier lookup failed");
    });

    it("rethrows when the tier table is missing entirely (42P01 undefined_table)", async () => {
      // A not-deployed table must surface as an error here: callers are
      // required to probe isSchemaDeployed() first, and swallowing 42P01 as
      // "no tier row" would mask deployment-order bugs.
      const err = new Error('relation "company_tiers" does not exist') as Error & { code?: string };
      err.code = "42P01";
      const db = { execute: vi.fn(async () => Promise.reject(err)) };
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.getCompanyTier("comp-1")).rejects.toThrow("does not exist");
    });
  });

  describe("countActiveAgents", () => {
    it("returns the real count when the query works", async () => {
      const db = selectCountChain([{ value: 7 }]);
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.countActiveAgents("comp-1")).resolves.toBe(7);
    });

    it("returns 0 when the company genuinely has no active agents", async () => {
      const db = selectCountChain([]);
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.countActiveAgents("comp-1")).resolves.toBe(0);
    });

    it("coerces string counts from the driver to a number", async () => {
      const db = selectCountChain([{ value: "12" }]);
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.countActiveAgents("comp-1")).resolves.toBe(12);
    });

    it("rethrows transport failures instead of counting 0 active agents", async () => {
      const db = connectionFailure("count query failed");
      const reader = createPostgresCompanyTierReader(db as never);

      await expect(reader.countActiveAgents("comp-1")).rejects.toThrow("count query failed");
    });
  });

  describe("no-db shape guards", () => {
    it("isSchemaDeployed stays false when db has no execute (test-double guard)", async () => {
      const reader = createPostgresCompanyTierReader(undefined as never);

      await expect(reader.isSchemaDeployed()).resolves.toBe(false);
    });

    it("getCompanyTier stays null when db has no execute (test-double guard)", async () => {
      const reader = createPostgresCompanyTierReader(undefined as never);

      await expect(reader.getCompanyTier("comp-1")).resolves.toBeNull();
    });

    it("countActiveAgents stays 0 when db has no select (test-double guard)", async () => {
      const reader = createPostgresCompanyTierReader(undefined as never);

      await expect(reader.countActiveAgents("comp-1")).resolves.toBe(0);
    });
  });
});
