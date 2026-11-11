import { describe, expect, it } from "vitest";
import {
  DEFAULT_RUN_MEMORY_MB,
  effectiveAgentRunLimit,
  effectiveAgentRunLimitSource,
  savedAgentRunLimits,
} from "./effective-run-limit.js";

describe("effectiveAgentRunLimit", () => {
  it("uses the minimum board, gateway, and memory ceilings", () => {
    expect(effectiveAgentRunLimit({ boardLimit: 10, gatewayLimit: 4, memoryMb: 2048 })).toBe(3);
  });

  it("does not allow a board limit above the gateway", () => {
    expect(effectiveAgentRunLimit({ boardLimit: 3, gatewayLimit: 2 })).toBe(2);
  });

  it("uses the documented conservative memory estimate", () => {
    expect(DEFAULT_RUN_MEMORY_MB).toBe(600);
    expect(effectiveAgentRunLimit({ boardLimit: 10, memoryMb: 1024 })).toBe(1);
  });
});

describe("savedAgentRunLimits", () => {
  it("reads the container block the card saves: gateway limit and memory", () => {
    expect(
      savedAgentRunLimits({
        boardLimit: 10,
        adapterConfig: { container: { enabled: true, memoryMb: 1024, maxConcurrentRuns: 2 } },
      }),
    ).toEqual({ boardLimit: 10, gatewayLimit: 2, memoryMb: 1024 });
  });

  it("accepts the snake_case key the profile compiler writes", () => {
    expect(
      savedAgentRunLimits({
        boardLimit: 4,
        adapterConfig: { container: { memoryMb: 2048, max_concurrent_runs: 3 } },
      }),
    ).toEqual({ boardLimit: 4, gatewayLimit: 3, memoryMb: 2048 });
  });

  it("falls back to the gateway block when the container block carries no limit", () => {
    expect(
      savedAgentRunLimits({
        boardLimit: 4,
        adapterConfig: { gateway: { maxConcurrentRuns: 2 } },
      }).gatewayLimit,
    ).toBe(2);
  });

  it("treats missing, zero, and junk ceilings as unknown so they clamp nothing", () => {
    for (const adapterConfig of [
      {},
      { container: { enabled: true } },
      { container: { memoryMb: 0, maxConcurrentRuns: 0 } },
      { container: { memoryMb: "big", maxConcurrentRuns: "many" } },
      null,
    ]) {
      const limits = savedAgentRunLimits({ boardLimit: 5, adapterConfig: adapterConfig as Record<string, unknown> });
      expect(limits.gatewayLimit).toBeNull();
      expect(limits.memoryMb).toBeNull();
      expect(effectiveAgentRunLimit(limits)).toBe(5);
    }
  });

  it("is the exact saved shape the heartbeat admission and the agent card both consume", () => {
    // The scheduler (services/heartbeat.ts parseHeartbeatPolicy) and the card
    // (bot-containers/routes.ts effectiveConcurrencyFields) must derive from the
    // same call, or the card would show a limit the scheduler does not enforce.
    const adapterConfig = { container: { enabled: true, memoryMb: 1024, maxConcurrentRuns: 2 } };
    const limits = savedAgentRunLimits({ boardLimit: 10, adapterConfig });
    expect(effectiveAgentRunLimit(limits)).toBe(1);
    expect(effectiveAgentRunLimit(limits)).toBeLessThan(limits.boardLimit);
  });
});

describe("effectiveAgentRunLimitSource", () => {
  it("names the gateway when it binds below the board and the memory ceiling", () => {
    expect(effectiveAgentRunLimitSource({ boardLimit: 10, gatewayLimit: 4, memoryMb: 4096 })).toBe("gateway");
  });

  it("names memory when the per-run estimate binds tighter than the gateway", () => {
    expect(effectiveAgentRunLimitSource({ boardLimit: 10, gatewayLimit: 4, memoryMb: 1024 })).toBe("memory");
  });

  it("names the board when nothing binds below it", () => {
    expect(effectiveAgentRunLimitSource({ boardLimit: 10 })).toBe("board");
    expect(effectiveAgentRunLimitSource({ boardLimit: 10, gatewayLimit: 10, memoryMb: 6000 })).toBe("board");
  });

  it("agrees with the computed effective limit across the ceiling combinations", () => {
    // The card renders the source next to the effective value, so a disagreeing
    // source would explain a number the scheduler does not use.
    for (const limits of [
      { boardLimit: 3, gatewayLimit: 2, memoryMb: 1024 },
      { boardLimit: 10, gatewayLimit: null, memoryMb: 1024 },
      { boardLimit: 10, gatewayLimit: 8, memoryMb: null },
      { boardLimit: 2, gatewayLimit: 5, memoryMb: 4096 },
    ]) {
      const source = effectiveAgentRunLimitSource(limits);
      const ceiling = Math.min(
        limits.boardLimit,
        limits.gatewayLimit ?? Number.POSITIVE_INFINITY,
        limits.memoryMb == null ? Number.POSITIVE_INFINITY : Math.floor(limits.memoryMb / DEFAULT_RUN_MEMORY_MB),
      );
      if (source === "gateway") expect(limits.gatewayLimit).toBe(ceiling);
      if (source === "memory") expect(Math.floor((limits.memoryMb ?? 0) / DEFAULT_RUN_MEMORY_MB)).toBe(ceiling);
      if (source === "board") expect(limits.boardLimit).toBe(ceiling);
    }
  });
});
