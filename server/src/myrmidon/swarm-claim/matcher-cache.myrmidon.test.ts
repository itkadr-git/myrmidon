// server/src/myrmidon/swarm-claim/matcher-cache.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-10004 PERF): company-level 60s TTL caches for failed-runs
// and lastRunRows. N matcher passes within 60s perform exactly one SQL calculation.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";
import {
  DEFAULT_FAILED_RUNS_CACHE_TTL_MS,
  failedRunsValuesSql,
  getCachedFailedRunsMap,
  invalidateFailedRunsCache,
} from "./effective-pheromone.js";
import {
  getCachedLastRunRows,
  invalidateLastRunRowsCache,
  LAST_RUN_ROWS_CACHE_TTL_MS,
} from "./matcher.js";

const COMPANY_ID = "2870b911-483a-4091-9f15-183841811143";
const OTHER_COMPANY_ID = "00000000-0000-0000-0000-000000000001";
const ISSUE_1 = "11111111-1111-1111-1111-111111111111";
const ISSUE_2 = "22222222-2222-2222-2222-222222222222";

describe("myrmidon(1.6.6 OPE-10004) swarm matcher cache", () => {
  beforeEach(() => {
    invalidateFailedRunsCache();
    invalidateLastRunRowsCache();
  });

  describe("failed-runs map 60s cache", () => {
    it("executes SQL calculation only once for N calls within 60 seconds", async () => {
      const executeMock = vi.fn().mockResolvedValue([
        { issue_uuid: ISSUE_1, failed_runs: 3 },
        { issue_uuid: ISSUE_2, failed_runs: 1 },
      ]);
      const fakeDb = { execute: executeMock } as unknown as Db;
      const now = new Date("2026-10-30T10:00:00.000Z");

      // 5 calls within the 60s window
      for (let i = 0; i < 5; i++) {
        const map = await getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
        expect(map.get(ISSUE_1)).toBe(3);
        expect(map.get(ISSUE_2)).toBe(1);
      }
      expect(executeMock).toHaveBeenCalledTimes(1);

      // Call at now + 30s is still within TTL: no new SQL execution
      const intermediateNow = new Date(now.getTime() + 30_000);
      const intermediateMap = await getCachedFailedRunsMap(fakeDb, COMPANY_ID, intermediateNow);
      expect(intermediateMap.get(ISSUE_1)).toBe(3);
      expect(executeMock).toHaveBeenCalledTimes(1);

      // Advance time past 60s TTL (61 seconds): triggers second calculation
      const laterNow = new Date(now.getTime() + 61_000);
      executeMock.mockResolvedValueOnce([
        { issue_uuid: ISSUE_1, failed_runs: 4 },
        { issue_uuid: ISSUE_2, failed_runs: 1 },
      ]);
      const updatedMap = await getCachedFailedRunsMap(fakeDb, COMPANY_ID, laterNow);
      expect(updatedMap.get(ISSUE_1)).toBe(4);
      expect(executeMock).toHaveBeenCalledTimes(2);

      // Manual invalidation immediately forces fresh calculation
      invalidateFailedRunsCache(COMPANY_ID);
      await getCachedFailedRunsMap(fakeDb, COMPANY_ID, laterNow);
      expect(executeMock).toHaveBeenCalledTimes(3);
    });

    it("isolates cache between different companies", async () => {
      const executeMock = vi.fn().mockImplementation(async (sqlObj) => {
        return [{ issue_uuid: ISSUE_1, failed_runs: 2 }];
      });
      const fakeDb = { execute: executeMock } as unknown as Db;
      const now = new Date("2026-10-30T10:00:00.000Z");

      await getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      expect(executeMock).toHaveBeenCalledTimes(1);

      await getCachedFailedRunsMap(fakeDb, OTHER_COMPANY_ID, now);
      expect(executeMock).toHaveBeenCalledTimes(2);

      // Subsequent calls for both companies hit the cache
      await getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      await getCachedFailedRunsMap(fakeDb, OTHER_COMPANY_ID, now);
      expect(executeMock).toHaveBeenCalledTimes(2);

      // Invalidating one company does not invalidate the other
      invalidateFailedRunsCache(COMPANY_ID);
      await getCachedFailedRunsMap(fakeDb, OTHER_COMPANY_ID, now);
      expect(executeMock).toHaveBeenCalledTimes(2);

      await getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      expect(executeMock).toHaveBeenCalledTimes(3);
    });

    it("deduplicates concurrent in-flight requests", async () => {
      let resolvePromise!: (rows: unknown) => void;
      const delayedExecution = new Promise((resolve) => {
        resolvePromise = resolve;
      });
      const executeMock = vi.fn().mockReturnValue(delayedExecution);
      const fakeDb = { execute: executeMock } as unknown as Db;
      const now = new Date("2026-10-30T10:00:00.000Z");

      // 5 concurrent calls
      const p1 = getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      const p2 = getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      const p3 = getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      const p4 = getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      const p5 = getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);

      expect(executeMock).toHaveBeenCalledTimes(1);

      resolvePromise([{ issue_uuid: ISSUE_1, failed_runs: 5 }]);
      const results = await Promise.all([p1, p2, p3, p4, p5]);

      for (const map of results) {
        expect(map.get(ISSUE_1)).toBe(5);
      }
      expect(executeMock).toHaveBeenCalledTimes(1);
    });

    it("handles empty failed-runs result cleanly", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const fakeDb = { execute: executeMock } as unknown as Db;
      const now = new Date("2026-10-30T10:00:00.000Z");

      const map = await getCachedFailedRunsMap(fakeDb, COMPANY_ID, now);
      expect(map.size).toBe(0);

      const emptySql = failedRunsValuesSql(map);
      expect(emptySql).toBeDefined();
    });
  });

  describe("lastRunRows 60s cache", () => {
    it("caches agent last-active timestamps for 60s", async () => {
      const selectMock = vi.fn();
      const whereMock = vi.fn();
      const groupByMock = vi.fn().mockResolvedValue([
        { agentId: "agent-1", lastActiveAt: new Date("2026-10-30T09:50:00.000Z") },
      ]);
      whereMock.mockReturnValue({ groupBy: groupByMock });
      selectMock.mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: whereMock,
        }),
      });

      const fakeDb = { select: selectMock } as unknown as Db;
      const now = new Date("2026-10-30T10:00:00.000Z");

      for (let i = 0; i < 5; i++) {
        const rows = await getCachedLastRunRows(fakeDb, COMPANY_ID, now);
        expect(rows.length).toBe(1);
        expect(rows[0]?.agentId).toBe("agent-1");
      }
      expect(groupByMock).toHaveBeenCalledTimes(1);

      // Invalidate cache
      invalidateLastRunRowsCache(COMPANY_ID);
      await getCachedLastRunRows(fakeDb, COMPANY_ID, now);
      expect(groupByMock).toHaveBeenCalledTimes(2);
    });
  });
});
