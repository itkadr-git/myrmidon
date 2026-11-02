import { describe, expect, it, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { estimatedJsonBytes } from "../routes/issues.js";
import { logger } from "../middleware/logger.js";
import {
  clearFailedRunsCache,
  failedRunsValuesSql,
  getCachedFailedRunsMap,
  DEFAULT_FAILED_RUNS_CACHE_TTL_MS,
} from "../myrmidon/swarm-claim/effective-pheromone.js";
import type { Db } from "@myrmidon/db";

describe("OPE-10012 Performance optimizations", () => {
  describe("estimatedJsonBytes", () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it("returns 0 and skips JSON.stringify when logger debug is disabled", () => {
      vi.spyOn(logger, "isLevelEnabled").mockReturnValue(false);
      const jsonSpy = vi.spyOn(JSON, "stringify");

      const largeObject = { items: Array.from({ length: 1000 }, (_, i) => ({ id: i, name: `item-${i}` })) };
      const bytes = estimatedJsonBytes(largeObject);

      expect(bytes).toBe(0);
      expect(jsonSpy).not.toHaveBeenCalled();
    });

    it("computes buffer byte length when logger debug is enabled", () => {
      vi.spyOn(logger, "isLevelEnabled").mockReturnValue(true);
      const jsonSpy = vi.spyOn(JSON, "stringify");

      const obj = { hello: "world", count: 42 };
      const bytes = estimatedJsonBytes(obj);

      expect(jsonSpy).toHaveBeenCalledWith(obj);
      expect(bytes).toBe(Buffer.byteLength(JSON.stringify(obj), "utf8"));
      expect(bytes).toBeGreaterThan(0);
    });
  });

  describe("Swarm failed runs cache and VALUES SQL", () => {
    beforeEach(() => {
      clearFailedRunsCache();
      vi.restoreAllMocks();
    });

    it("failedRunsValuesSql generates empty subquery for empty map", () => {
      const sqlText = new PgDialect().sqlToQuery(failedRunsValuesSql(new Map())).sql;

      expect(sqlText).toContain("where false");
      expect(sqlText).toContain("fr");
    });

    it("failedRunsValuesSql generates VALUES clause for populated map and ignores invalid UUIDs", () => {
      const validUuid1 = "11111111-1111-1111-1111-111111111111";
      const validUuid2 = "22222222-2222-2222-2222-222222222222";
      const map = new Map<string, number>([
        [validUuid1, 3],
        ["not-a-uuid", 5],
        [validUuid2, 1],
      ]);

      const query = new PgDialect().sqlToQuery(failedRunsValuesSql(map));
      const sqlText = query.sql;

      expect(query.params).toEqual([validUuid1, validUuid2]);
      expect(sqlText).not.toContain("heartbeat_runs");
      expect(sqlText).toContain("values");
      expect(sqlText).toContain("fr(issue_uuid, failed_runs)");
    });

    it("getCachedFailedRunsMap caches query result within TTL and re-queries after expiration", async () => {
      let callCount = 0;
      const fakeDb = {
        execute: vi.fn(async () => {
          callCount++;
          return [
            { issue_uuid: "11111111-1111-1111-1111-111111111111", failed_runs: 2 },
          ];
        }),
      } as unknown as Db;

      const companyId = "c1111111-1111-1111-1111-111111111111";
      const t0 = new Date("2026-10-30T10:00:00.000Z");

      // First call queries DB
      const res1 = await getCachedFailedRunsMap(fakeDb, companyId, t0);
      expect(callCount).toBe(1);
      expect(res1.get("11111111-1111-1111-1111-111111111111")).toBe(2);

      // Second call within TTL (30s later) uses cache
      const t1 = new Date(t0.getTime() + 30_000);
      const res2 = await getCachedFailedRunsMap(fakeDb, companyId, t1);
      expect(callCount).toBe(1);
      expect(res2).toBe(res1);

      // Third call after TTL (61s later) re-queries DB
      const t2 = new Date(t0.getTime() + DEFAULT_FAILED_RUNS_CACHE_TTL_MS + 1000);
      const res3 = await getCachedFailedRunsMap(fakeDb, companyId, t2);
      expect(callCount).toBe(2);
      expect(res3.get("11111111-1111-1111-1111-111111111111")).toBe(2);
    });

    it("clearFailedRunsCache invalidates the cache immediately", async () => {
      let callCount = 0;
      const fakeDb = {
        execute: vi.fn(async () => {
          callCount++;
          return [];
        }),
      } as unknown as Db;

      const companyId = "c1111111-1111-1111-1111-111111111111";
      const t0 = new Date("2026-10-30T10:00:00.000Z");

      await getCachedFailedRunsMap(fakeDb, companyId, t0);
      expect(callCount).toBe(1);

      // Clear for company
      clearFailedRunsCache(companyId);

      await getCachedFailedRunsMap(fakeDb, companyId, t0);
      expect(callCount).toBe(2);
    });
  });
});
