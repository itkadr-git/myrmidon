import { describe, expect, it } from "vitest";
import { buildInteractionDedupeKey } from "./dedupe-key.js";

describe("buildInteractionDedupeKey", () => {
  const input = {
    source: "github",
    sourceEventId: "delivery-1",
    issueId: "issue-1",
    routeType: "approval",
  };

  it("is stable and distinguishes source events, issues, and route types", () => {
    expect(buildInteractionDedupeKey(input)).toBe(buildInteractionDedupeKey({ ...input }));
    expect(buildInteractionDedupeKey({ ...input, sourceEventId: "delivery-2" })).not.toBe(buildInteractionDedupeKey(input));
    expect(buildInteractionDedupeKey({ ...input, issueId: "issue-2" })).not.toBe(buildInteractionDedupeKey(input));
    expect(buildInteractionDedupeKey({ ...input, routeType: "decision" })).not.toBe(buildInteractionDedupeKey(input));
  });

  it("rejects missing key components", () => {
    expect(() => buildInteractionDedupeKey({ ...input, sourceEventId: " " })).toThrow();
  });
});
