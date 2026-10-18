import { describe, expect, it } from "vitest";
import { canonicalRequestHash, validateIdempotencyKey, validateRequestBody } from "./protocol.js";

describe("pool-chat protocol validation", () => {
  it("accepts opaque ASCII idempotency keys and rejects malformed keys", () => {
    expect(validateIdempotencyKey("abcdefghijklmnop")).toBe(true);
    expect(validateIdempotencyKey("short")).toBe(false);
    expect(validateIdempotencyKey("abcdefghijklmnop\né")).toBe(false);
  });

  it("validates bounded, text-only request bodies and rejects provider/account overrides", () => {
    const valid = {
      conversationId: "conv-1", clientMessageId: "event-1", model: "logical-model",
      messages: [{ role: "user", content: "hello" }], maxOutputTokens: 2048,
    };
    expect(validateRequestBody(valid, new Set(["logical-model"]))).toEqual({ valid: true, value: valid });
    expect(validateRequestBody({ ...valid, accountId: "pool-acc-1" }, new Set(["logical-model"])).valid).toBe(false);
    expect(validateRequestBody({ ...valid, model: "unknown" }, new Set(["logical-model"])).valid).toBe(false);
    expect(validateRequestBody({ ...valid, messages: [{ role: "assistant", content: "hello" }] }, new Set(["logical-model"])).valid).toBe(false);
  });

  it("hashes validated payloads deterministically", () => {
    const a = { conversationId: "c", clientMessageId: "m", model: "x", messages: [{ role: "user", content: "hi" }], maxOutputTokens: 32 };
    expect(canonicalRequestHash(a)).toBe(canonicalRequestHash({ ...a, messages: [...a.messages] }));
    expect(canonicalRequestHash(a)).not.toBe(canonicalRequestHash({ ...a, model: "y" }));
  });
});