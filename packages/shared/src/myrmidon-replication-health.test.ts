import { describe, expect, it } from "vitest";
import {
  replicationHealthQuerySchema,
} from "./myrmidon-replication-health.js";

describe("replicationHealthQuerySchema", () => {
  it("accepts empty query parameters and returns undefined options", () => {
    const result = replicationHealthQuerySchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxLagSeconds).toBeUndefined();
      expect(result.data.warnLagSeconds).toBeUndefined();
      expect(result.data.role).toBeUndefined();
    }
  });

  it("coerces and validates numeric lag thresholds", () => {
    const result = replicationHealthQuerySchema.safeParse({
      maxLagSeconds: "60",
      warnLagSeconds: "10.5",
      role: "primary",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.maxLagSeconds).toBe(60);
      expect(result.data.warnLagSeconds).toBe(10.5);
      expect(result.data.role).toBe("primary");
    }
  });

  it("accepts valid roles: primary, standby, any", () => {
    for (const role of ["primary", "standby", "any"] as const) {
      const result = replicationHealthQuerySchema.safeParse({ role });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.role).toBe(role);
      }
    }
  });

  it("rejects negative lag thresholds", () => {
    const resultNegativeMax = replicationHealthQuerySchema.safeParse({ maxLagSeconds: "-5" });
    expect(resultNegativeMax.success).toBe(false);

    const resultNegativeWarn = replicationHealthQuerySchema.safeParse({ warnLagSeconds: -1 });
    expect(resultNegativeWarn.success).toBe(false);
  });

  it("rejects non-numeric lag thresholds", () => {
    const result = replicationHealthQuerySchema.safeParse({ maxLagSeconds: "not-a-number" });
    expect(result.success).toBe(false);
  });

  it("rejects invalid roles", () => {
    const result = replicationHealthQuerySchema.safeParse({ role: "master" });
    expect(result.success).toBe(false);
  });
});
