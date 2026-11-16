import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { signReleaseVerificationVerdict } from "./release-verification.js";

const key = "synthetic-interop-key";
const input = {
  verdict: "confirmed",
  deployedVersion: "abc123",
  checkedAt: "2026-11-15T12:34:56.123+03:00",
  issueId: "issue-\u0442\u0435\u0441\u0442-\u00e9",
};

function publisherOracle(value: typeof input, secret: string): string {
  const canonical = `${value.verdict}|${value.deployedVersion}|${value.checkedAt}|${value.issueId}`;
  return createHmac("sha256", secret).update(canonical, "utf8").digest("hex");
}

describe("release verification signature interoperability", () => {
  it("matches the publisher's canonical UTF-8 bytes and full HMAC", () => {
    const signature = signReleaseVerificationVerdict(input, key);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
    expect(signature).toBe(publisherOracle(input, key));
  });

  it("rejects changes to each signed field and to the key", () => {
    const signature = publisherOracle(input, key);
    const changes = [
      { verdict: "failed" },
      { deployedVersion: "def456" },
      { checkedAt: "2026-11-15T09:34:56.123Z" },
      { issueId: "issue-test" },
    ];
    for (const change of changes) {
      expect(signReleaseVerificationVerdict({ ...input, ...change }, key)).not.toBe(signature);
    }
    expect(signReleaseVerificationVerdict(input, "another-synthetic-key")).not.toBe(signature);
  });

  it("normalizes null and empty versions to the same empty canonical field", () => {
    const empty = { ...input, deployedVersion: "" };
    const expected = publisherOracle(empty, key);
    expect(signReleaseVerificationVerdict(empty, key)).toBe(expected);
    expect(signReleaseVerificationVerdict({ ...input, deployedVersion: null }, key)).toBe(expected);
  });
});
