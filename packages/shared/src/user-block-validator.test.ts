import { describe, expect, it } from "vitest";
import { blockUserSchema, auditQuerySchema } from "./index.js";

describe("user block validator (OPE-10215)", () => {
  it("accepts a valid reason", () => {
    const res = blockUserSchema.safeParse({ reason: "Violation of company policy" });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.reason).toBe("Violation of company policy");
    }
  });

  it("trims whitespace from reason", () => {
    const res = blockUserSchema.safeParse({ reason: "   Suspicious activity detected   " });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.reason).toBe("Suspicious activity detected");
    }
  });

  it("rejects an empty reason", () => {
    const res = blockUserSchema.safeParse({ reason: "" });
    expect(res.success).toBe(false);
  });

  it("rejects a whitespace-only reason", () => {
    const res = blockUserSchema.safeParse({ reason: "     " });
    expect(res.success).toBe(false);
  });

  it("rejects when reason is missing", () => {
    const res = blockUserSchema.safeParse({});
    expect(res.success).toBe(false);
  });

  it("rejects a reason exceeding max length", () => {
    const res = blockUserSchema.safeParse({ reason: "x".repeat(1001) });
    expect(res.success).toBe(false);
  });

  it("parses audit query filters with defaults", () => {
    const res = auditQuerySchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.limit).toBe(50);
    }
  });
});
