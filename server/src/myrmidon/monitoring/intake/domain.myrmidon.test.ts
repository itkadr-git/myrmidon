// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): the pure rules — HMAC verification,
// event-identity extraction, source normalization. No database, no network.
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { extractDelivery, normalizeSource, sha256Hex, verifyHmacSha256 } from "./domain.js";

const secret = "unit-secret";

function signed(body: string, withSecret = secret): string {
  return "sha256=" + createHmac("sha256", withSecret).update(Buffer.from(body, "utf8")).digest("hex");
}

describe("myrmidon(1.7 WEBHOOK-INTAKE) signature verification", () => {
  const body = Buffer.from('{"eventId":"e1"}', "utf8");

  it("accepts a correct sha256=<hex> signature", () => {
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: signed(body.toString()) }, secret)).toBe(true);
  });

  it("rejects a wrong secret, a wrong body, and a missing header", () => {
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: signed(body.toString(), "other") }, secret)).toBe(false);
    const otherBody = Buffer.from('{"eventId":"e2"}', "utf8");
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: signed(otherBody.toString()) }, secret)).toBe(false);
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: null }, secret)).toBe(false);
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: signed(body.toString()) }, "")).toBe(false);
  });

  it("is not fooled by a same-length different hex", () => {
    const wrong = "sha256=" + "f".repeat(64);
    expect(verifyHmacSha256({ scheme: "hmac_sha256", body, signatureHeader: "x", signatureHeaderValue: wrong }, secret)).toBe(false);
  });
});

describe("myrmidon(1.7 WEBHOOK-INTAKE) delivery identity", () => {
  it("prefers explicit body fields over headers", () => {
    const delivery = extractDelivery("gh", { eventId: "body-1" }, { "x-github-delivery": "hdr-1" });
    expect(delivery.externalEventId).toBe("body-1");
    expect(delivery.source).toBe("gh");
  });

  it("falls back to provider headers, then to a content hash", () => {
    const headerOnly = extractDelivery("s", { a: 1 }, { "x-github-delivery": "d-9" });
    expect(headerOnly.externalEventId).toBe("d-9");
    const none = extractDelivery("s", { a: 1 }, {});
    const expectedHash = "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862";
    expect(none.externalEventId).toBe(expectedHash);
    expect(sha256Hex('{"a":1}')).toBe(expectedHash);
    expect(sha256Hex(Buffer.from('{"a":1}', "utf8"))).toBe(expectedHash);

    const exactRaw = Buffer.from('{ "a": 1 }\n', "utf8");
    const withRaw = extractDelivery("s", { a: 1 }, {}, exactRaw);
    expect(withRaw.externalEventId).toBe("13bcacc8d47bd26aff811a06be81b73c1f20e30576e437509e8690adefad6241");
  });

  it("normalizes the source and rejects bad ones", () => {
    expect(normalizeSource(" GitHub ")).toBe("github");
    expect(() => normalizeSource("")).toThrow();
    expect(() => normalizeSource("bad source!")).toThrow();
  });
});
