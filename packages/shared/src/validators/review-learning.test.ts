import { describe, expect, it } from "vitest";
import {
  REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS,
  REVIEW_PATTERN_REDACTION_MARKER,
  reviewPatternDigestSchema,
  reviewPatternDigestSourceSchema,
} from "./review-learning.js";

const WINDOW_START = "2026-10-15T00:00:00.000Z";
const WINDOW_END = "2026-11-14T00:00:00.000Z";

function source(overrides: Record<string, unknown> = {}) {
  return {
    sourceRef: "issue:00000000-0000-4000-8000-000000000001:pr:example-org/repo#4421:comment:comm-1",
    issue: {
      id: "00000000-0000-4000-8000-000000000001",
      identifier: "OPE-12928",
    },
    pullRequest: { repository: "example-org/repo", number: 4421 },
    timestamp: "2026-11-01T10:00:00.000Z",
    ...overrides,
  };
}

function digest(overrides: Record<string, unknown> = {}) {
  return {
    schema: "paperclip.review_pattern_digest.v1",
    id: "00000000-0000-4000-8000-000000000010",
    companyId: "00000000-0000-4000-8000-000000000020",
    skillSlug: "rebase-pr-before-in-review",
    lesson: "Rebase the PR branch on origin/main before in_review.",
    approvalState: "approved",
    sources: [source()],
    occurrenceCount: 2,
    windowStart: WINDOW_START,
    windowEnd: WINDOW_END,
    createdAt: "2026-11-14T00:00:00.000Z",
    ...overrides,
  };
}

describe("reviewPatternDigestSchema — persisted digest contract", () => {
  it("accepts a valid minimal approved digest", () => {
    const result = reviewPatternDigestSchema.safeParse(digest());
    expect(result.success).toBe(true);
  });

  it("rejects extra fields (strict contract: no raw review body)", () => {
    for (const extraKey of ["body", "feedback", "raw", "reviewBody", "text"]) {
      const result = reviewPatternDigestSchema.safeParse(
        digest({ [extraKey]: "raw reviewer prose that must never persist" }),
      );
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.code).toBe("unrecognized_keys");
      }
    }
  });

  it("rejects a pending (unapproved) pattern", () => {
    const result = reviewPatternDigestSchema.safeParse(
      digest({ approvalState: "pending" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a rejected pattern", () => {
    const result = reviewPatternDigestSchema.safeParse(
      digest({ approvalState: "rejected" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects a window wider than 30 days", () => {
    const wideStart = new Date(
      Date.parse(WINDOW_END) - REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS - 1,
    ).toISOString();
    const result = reviewPatternDigestSchema.safeParse(
      digest({ windowStart: wideStart }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join("\n");
      expect(messages).toContain("30-day");
    }
  });

  it("accepts a window exactly 30 days", () => {
    const exactStart = new Date(
      Date.parse(WINDOW_END) - REVIEW_PATTERN_DIGEST_MAX_WINDOW_MS,
    ).toISOString();
    expect(
      reviewPatternDigestSchema.safeParse(digest({ windowStart: exactStart })).success,
    ).toBe(true);
  });

  it("rejects windowEnd before windowStart", () => {
    expect(
      reviewPatternDigestSchema.safeParse(
        digest({ windowStart: WINDOW_END, windowEnd: WINDOW_START }),
      ).success,
    ).toBe(false);
  });

  it("rejects a lesson that still carries the redaction marker", () => {
    const result = reviewPatternDigestSchema.safeParse(
      digest({
        lesson: `Set the ${REVIEW_PATTERN_REDACTION_MARKER} before pushing.`,
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message).join("\n");
      expect(messages).toContain("redaction marker");
    }
  });

  it("rejects an empty provenance list", () => {
    expect(
      reviewPatternDigestSchema.safeParse(digest({ sources: [] })).success,
    ).toBe(false);
  });

  it("rejects occurrenceCount below the number of recorded sources", () => {
    expect(
      reviewPatternDigestSchema.safeParse(
        digest({ occurrenceCount: 1, sources: [source(), source({
          sourceRef: "issue:i:pr:r#2:comment:c2",
        })] }),
      ).success,
    ).toBe(false);
  });

  it("rejects private/unapproved-shaped input: author ids, run ids, raw body fields", () => {
    const withAuthor = digest({ sources: [source({ authorId: "agent-1" })] });
    expect(reviewPatternDigestSchema.safeParse(withAuthor).success).toBe(false);

    const withRunId = digest({ runId: "14c98d26-5003-47f8-86e1-9d92c885f572" });
    expect(reviewPatternDigestSchema.safeParse(withRunId).success).toBe(false);
  });
});

describe("reviewPatternDigestSourceSchema — provenance entry contract", () => {
  it("accepts a valid source entry", () => {
    expect(reviewPatternDigestSourceSchema.safeParse(source()).success).toBe(true);
  });

  it("rejects extra provenance fields (no body, no author)", () => {
    expect(
      reviewPatternDigestSourceSchema.safeParse(source({ body: "raw text" })).success,
    ).toBe(false);
    expect(
      reviewPatternDigestSourceSchema.safeParse(source({ authorId: "u-1" })).success,
    ).toBe(false);
  });

  it("rejects empty sourceRef and non-positive PR numbers", () => {
    expect(
      reviewPatternDigestSourceSchema.safeParse(source({ sourceRef: " " })).success,
    ).toBe(false);
    expect(
      reviewPatternDigestSourceSchema.safeParse(
        source({ pullRequest: { repository: "r", number: 0 } }),
      ).success,
    ).toBe(false);
  });

  it("rejects a non-ISO timestamp", () => {
    expect(
      reviewPatternDigestSourceSchema.safeParse(
        source({ timestamp: "not-a-date" }),
      ).success,
    ).toBe(false);
  });
});
