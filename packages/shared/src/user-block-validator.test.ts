import { describe, expect, it } from "vitest";
import { blockUserSchema, unblockUserSchema, patchUserBlockSchema, auditQuerySchema } from "./index.js";

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

  it("parses auditQuerySchema filters with defaults", () => {
    const res = auditQuerySchema.safeParse({});
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.limit).toBe(50);
    }
  });

  describe("patchUserBlockSchema (OPE-12116)", () => {
    it("defaults blocked to true when omitted", () => {
      const res = patchUserBlockSchema.safeParse({});
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.blocked).toBe(true);
      }
    });

    it("accepts blocked: true with reason", () => {
      const res = patchUserBlockSchema.safeParse({ blocked: true, reason: "Spam account" });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.blocked).toBe(true);
        expect(res.data.reason).toBe("Spam account");
      }
    });

    it("accepts blocked: false without reason", () => {
      const res = patchUserBlockSchema.safeParse({ blocked: false });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.blocked).toBe(false);
      }
    });

    it("accepts unblockUserSchema with optional reason", () => {
      const res = unblockUserSchema.safeParse({ reason: "Account reinstated" });
      expect(res.success).toBe(true);
      if (res.success) {
        expect(res.data.reason).toBe("Account reinstated");
      }
    });
  });
});
