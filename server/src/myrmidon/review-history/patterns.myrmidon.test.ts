// server/src/myrmidon/review-history/patterns.myrmidon.test.ts
//
// myrmidon(1.8 LEARN, OPE-12939): tests for the pattern-grouping stage.
// No database, no I/O, no skill files. Acceptance probes:
// - repeated pattern  -> draft with source citations + pending approval state;
// - one-off / noisy / sensitive finding -> no draft;
// - auto-enabled draft or lost provenance -> contract violation (always false).

import { describe, expect, it } from "vitest";
import {
  REVIEW_PATTERN_MIN_OCCURRENCES,
  REDACTION_MARKER,
  groupReviewPatterns,
  proposeDraftSkills,
  type PatternFinding,
} from "./patterns.js";

const NOW = new Date("2026-11-13T03:00:00.000Z");

function finding(overrides: Partial<PatternFinding> = {}): PatternFinding {
  return {
    feedback: "Rebase the PR branch on origin/main before in_review.",
    timestamp: "2026-11-01T10:00:00.000Z",
    issue: { id: "00000000-0000-4000-8000-000000000001", identifier: "OPE-12928" },
    pullRequest: { repository: "example-org/repo", number: 4421 },
    sourceRef: "issue:00000000-0000-4000-8000-000000000001:pr:example-org/repo#4421:comment:comm-1",
    ...overrides,
  };
}

describe("groupReviewPatterns — grouping contract", () => {
  it("groups findings that share a normalized key and keeps every sourceRef", () => {
    const result = groupReviewPatterns([
      finding({ sourceRef: "issue:i:pr:r#1:comment:c1" }),
      finding({
        feedback: "rebase the PR branch on origin/main before in_review.",
        sourceRef: "issue:i:pr:r#2:comment:c2",
      }),
      finding({
        feedback: "totally different prose about ports",
        sourceRef: "issue:i:pr:r#3:comment:c3",
      }),
    ]);

    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");

    expect(result).toHaveLength(2);
    const rebases = result.find((group) => group.findings.length === 2);
    expect(rebases?.findings.map((entry) => entry.sourceRef).sort()).toEqual([
      "issue:i:pr:r#1:comment:c1",
      "issue:i:pr:r#2:comment:c2",
    ]);
  });

  it("fails closed on a finding with missing provenance fields", () => {
    expect(groupReviewPatterns([finding({ sourceRef: "" })])).toBe(false);
    expect(groupReviewPatterns([finding({ issue: { id: "", identifier: "OPE-1" } })])).toBe(false);
    expect(groupReviewPatterns([finding({ pullRequest: { repository: "r", number: 0 } })])).toBe(false);
    expect(groupReviewPatterns([finding({ timestamp: "not-a-date" })])).toBe(false);
  });

  it("fails closed on non-array input and drops pure-noise prose", () => {
    expect(groupReviewPatterns("nope" as unknown as PatternFinding[])).toBe(false);
    const noise = groupReviewPatterns([finding({ feedback: "the a an and or" })]);
    expect(noise).not.toBe(false);
    if (noise === false) throw new Error("unreachable");
    expect(noise).toHaveLength(0);
  });
});

describe("proposeDraftSkills — draft + human gate contract", () => {
  it("repeated pattern yields a pending draft with source citations and approval state", () => {
    const result = proposeDraftSkills(
      [
        finding({ sourceRef: "issue:i:pr:r#1:comment:c1", timestamp: "2026-11-01T10:00:00.000Z" }),
        finding({
          feedback: "Rebase the PR branch on origin/main before in_review.",
          sourceRef: "issue:i:pr:r#2:comment:c2",
          timestamp: "2026-11-02T10:00:00.000Z",
        }),
      ],
      { now: NOW },
    );

    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");

    expect(result).toHaveLength(1);
    const draft = result[0];
    expect(draft.approvalState).toBe("pending");
    expect(draft.occurrenceCount).toBe(REVIEW_PATTERN_MIN_OCCURRENCES);
    expect(draft.sources).toHaveLength(2);
    expect(draft.sources.map((source) => source.sourceRef).sort()).toEqual([
      "issue:i:pr:r#1:comment:c1",
      "issue:i:pr:r#2:comment:c2",
    ]);
    expect(draft.sources[0].issue.identifier).toBe("OPE-12928");
    expect(draft.sources[0].pullRequest).toEqual({ repository: "example-org/repo", number: 4421 });
    expect(draft.body).toContain("origin/main");
    expect(draft.createdAt).toBe(NOW.toISOString());
  });

  it("one-off finding yields no draft", () => {
    const result = proposeDraftSkills([finding()], { now: NOW });
    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");
    expect(result).toHaveLength(0);
  });

  it("noisy/low-signal finding yields no draft even when repeated", () => {
    const result = proposeDraftSkills(
      [
        finding({ feedback: "the a an and or but", sourceRef: "issue:i:pr:r#1:comment:c1" }),
        finding({ feedback: "the a an and or but", sourceRef: "issue:i:pr:r#2:comment:c2" }),
      ],
      { now: NOW },
    );
    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");
    expect(result).toHaveLength(0);
  });

  it("sensitive finding (redaction marker survived) fails closed with false", () => {
    const result = proposeDraftSkills(
      [
        finding({ feedback: `set the ${REDACTION_MARKER} in config`, sourceRef: "issue:i:pr:r#1:comment:c1" }),
        finding({ feedback: `set the ${REDACTION_MARKER} in config`, sourceRef: "issue:i:pr:r#2:comment:c2" }),
      ],
      { now: NOW },
    );
    expect(result).toBe(false);
  });

  it("never auto-approves: approval state is literal pending, no enabled flag exists", () => {
    const result = proposeDraftSkills(
      [
        finding({ sourceRef: "issue:i:pr:r#1:comment:c1" }),
        finding({ sourceRef: "issue:i:pr:r#2:comment:c2" }),
      ],
      { now: NOW },
    );
    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");
    const draft = result[0] as unknown as Record<string, unknown>;
    expect(draft["approvalState"]).toBe("pending");
    expect(Object.keys(draft)).not.toContain("enabled");
    expect(Object.keys(draft)).not.toContain("published");
  });

  it("provenance is never lost: empty sources cannot happen, unknown minOccurrences fails closed", () => {
    expect(proposeDraftSkills([finding({ sourceRef: " " })], { now: NOW })).toBe(false);
    expect(proposeDraftSkills([], { now: NOW })).toEqual([]);
    expect(proposeDraftSkills([finding(), finding()], { now: NOW, minOccurrences: 0 })).toBe(false);
  });
});
