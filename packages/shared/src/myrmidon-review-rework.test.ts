// @vitest-environment node
//
// myrmidon(REVIEW-REWORK): the shared contract tests — the verdict-marker
// parser (the board-convention half of the loop) and the settings round-trip
// (defaults, malformed rows, patch merge, journal limit).

import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_REWORK_ENABLED,
  REVIEW_REWORK_JOURNAL_LIMIT,
  mergeReviewReworkSettings,
  normalizeReviewReworkSettings,
  parseReviewReworkVerdictMarkers,
  patchReviewReworkSettingsSchema,
} from "@paperclipai/shared";

function comment(body: string, id = "comment-1", createdAt = "2026-10-04T16:57:00.000Z") {
  return { id, body, createdAt };
}

describe("review rework verdict markers", () => {
  it("parses the board-convention RETURN marker with an optional head pin", () => {
    const markers = parseReviewReworkVerdictMarkers(
      comment("VERDICT #484: RETURN (head da3364a2973ee31f0db15e9f5d6492f91880786c)\n\nДетали ниже."),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      prNumber: 484,
      outcome: "return",
      headSha: "da3364a2973ee31f0db15e9f5d6492f91880786c",
      commentId: "comment-1",
      at: "2026-10-04T16:57:00.000Z",
    });
  });

  it("accepts the full repo form and prose around the marker", () => {
    const markers = parseReviewReworkVerdictMarkers(
      comment("Итог: VERDICT itkadr-git/myrmidon#513: RETURN — см. блокеры."),
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]!.prNumber).toBe(513);
    expect(markers[0]!.outcome).toBe("return");
    expect(markers[0]!.headSha).toBeNull();
  });

  it("reads CHANGES_REQUESTED and REWORK spellings as a return", () => {
    expect(parseReviewReworkVerdictMarkers(comment("VERDICT #7: CHANGES REQUESTED"))[0]!.outcome).toBe("return");
    expect(parseReviewReworkVerdictMarkers(comment("VERDICT #7: REWORK"))[0]!.outcome).toBe("return");
  });

  it("reads APPROVE and LGTM as the approval side of the marker", () => {
    expect(parseReviewReworkVerdictMarkers(comment("VERDICT #7: APPROVE"))[0]!.outcome).toBe("approve");
    expect(parseReviewReworkVerdictMarkers(comment("VERDICT #7: LGTM"))[0]!.outcome).toBe("approve");
  });

  it("finds several markers in one body and skips malformed ones", () => {
    const markers = parseReviewReworkVerdictMarkers(
      comment("VERDICT #1: RETURN\nVERDICT #2: APPROVE\nverdict #0: RETURN\nVERDICT: RETURN #3"),
    );
    // #0 is not a valid PR number; the trailing form still names #3 on its own
    // line because the marker grammar allows the number after the colon only
    // through the same single-line shape.
    expect(markers.map((marker) => marker.prNumber)).toEqual([1, 2]);
  });

  it("scans each comment independently (no shared lastIndex)", () => {
    const first = parseReviewReworkVerdictMarkers(comment("VERDICT #10: RETURN"));
    const second = parseReviewReworkVerdictMarkers(comment("VERDICT #11: APPROVE"));
    expect(first[0]!.prNumber).toBe(10);
    expect(second[0]!.prNumber).toBe(11);
  });

  it("returns nothing for prose without the marker", () => {
    expect(parseReviewReworkVerdictMarkers(comment("Just reviewing the diff; no verdict yet."))).toEqual([]);
  });
});

describe("review rework settings contract", () => {
  it("defaults are on with no fallback assignee", () => {
    const settings = normalizeReviewReworkSettings(undefined);
    expect(settings.enabled).toBe(DEFAULT_REVIEW_REWORK_ENABLED);
    expect(settings.fallbackAssigneeAgentId).toBeNull();
  });

  it("a malformed stored row falls back to the defaults, never half-applies", () => {
    expect(normalizeReviewReworkSettings({ enabled: "yes please" })).toEqual(
      normalizeReviewReworkSettings(undefined),
    );
  });

  it("merges a patch per key and keeps the untouched one", () => {
    const base = { enabled: true, fallbackAssigneeAgentId: null };
    expect(mergeReviewReworkSettings(base, { enabled: false })).toEqual({
      enabled: false,
      fallbackAssigneeAgentId: null,
    });
    expect(
      mergeReviewReworkSettings(base, { fallbackAssigneeAgentId: "887ed69b-5982-4572-a151-f8c809543f29" }),
    ).toEqual({
      enabled: true,
      fallbackAssigneeAgentId: "887ed69b-5982-4572-a151-f8c809543f29",
    });
  });

  it("the patch schema refuses an empty patch and a non-uuid fallback", () => {
    expect(patchReviewReworkSettingsSchema.safeParse({}).success).toBe(false);
    expect(patchReviewReworkSettingsSchema.safeParse({ fallbackAssigneeAgentId: "not-a-uuid" }).success).toBe(false);
    expect(patchReviewReworkSettingsSchema.safeParse({ fallbackAssigneeAgentId: null }).success).toBe(true);
  });

  it("keeps the journal bounded", () => {
    expect(REVIEW_REWORK_JOURNAL_LIMIT).toBe(50);
  });
});
