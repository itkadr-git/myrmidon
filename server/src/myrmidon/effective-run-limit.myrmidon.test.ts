import { describe, expect, it } from "vitest";
import { DEFAULT_RUN_MEMORY_MB, effectiveAgentRunLimit } from "./effective-run-limit.js";

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
