// server/src/myrmidon/review-history/query.myrmidon.test.ts
//
// myrmidon(1.8 LEARN, OPE-12928): focused tests for the safe 30-day extraction
// contract. No database, no I/O, no skill files.

import { describe, expect, it } from "vitest";
import {
  REVIEW_HISTORY_WINDOW_MS,
  extractReviewFeedback,
  type ReviewHistorySource,
} from "./query.js";

const NOW = new Date("2026-11-13T02:00:00.000Z");
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function validSource(overrides: Partial<ReviewHistorySource> = {}): ReviewHistorySource {
  return {
    id: "comm-1",
    kind: "review_comment",
    createdAt: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString(),
    issueId: "8e2edecc-b88f-4d97-b3ad-458768adb4fd",
    issueIdentifier: "OPE-12928",
    pullRequest: {
      repository: "itkadr-git/myrmidon",
      number: 4421,
    },
    body: "Please rebase the PR branch on origin/main before in_review.",
    ...overrides,
  };
}

describe("extractReviewFeedback — safe 30-day extraction contract", () => {
  it("returns eligible review comments with timestamps, PR/issue references, and deterministic sourceRef", () => {
    const input: ReviewHistorySource[] = [
      validSource({
        id: "comm-1",
        kind: "review_comment",
        createdAt: "2026-11-01T10:00:00.000Z",
        body: "Check the exact-head SHA before merging.",
      }),
      validSource({
        id: "dec-1",
        kind: "review_decision",
        createdAt: "2026-11-05T12:00:00.000Z",
        body: "APPROVE PR #4421",
      }),
    ];

    const result = extractReviewFeedback(input, NOW);
    expect(result).not.toBe(false);
    if (result === false) throw new Error("unreachable");

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      feedback: "Check the exact-head SHA before merging.",
      timestamp: "2026-11-01T10:00:00.000Z",
      issue: {
        id: "8e2edecc-b88f-4d97-b3ad-458768adb4fd",
        identifier: "OPE-12928",
      },
      pullRequest: {
        repository: "itkadr-git/myrmidon",
        number: 4421,
      },
      sourceRef:
        "issue:8e2edecc-b88f-4d97-b3ad-458768adb4fd:pr:itkadr-git/myrmidon#4421:comment:comm-1",
    });
    expect(result[1]).toEqual({
      feedback: "APPROVE PR #4421",
      timestamp: "2026-11-05T12:00:00.000Z",
      issue: {
        id: "8e2edecc-b88f-4d97-b3ad-458768adb4fd",
        identifier: "OPE-12928",
      },
      pullRequest: {
        repository: "itkadr-git/myrmidon",
        number: 4421,
      },
      sourceRef:
        "issue:8e2edecc-b88f-4d97-b3ad-458768adb4fd:pr:itkadr-git/myrmidon#4421:comment:dec-1",
    });
  });

  describe("30-day window boundary", () => {
    it("accepts records at the exact start boundary (since = now - 30d)", () => {
      const exactSince = new Date(NOW.getTime() - THIRTY_DAYS_MS).toISOString();
      const result = extractReviewFeedback([validSource({ createdAt: exactSince })], NOW);
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");
      expect(result).toHaveLength(1);
    });

    it("accepts records at the exact end boundary (until = now)", () => {
      const exactUntil = NOW.toISOString();
      const result = extractReviewFeedback([validSource({ createdAt: exactUntil })], NOW);
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");
      expect(result).toHaveLength(1);
    });

    it("returns false if any comment is older than 30 days (1 ms before window)", () => {
      const tooOld = new Date(NOW.getTime() - THIRTY_DAYS_MS - 1).toISOString();
      const result = extractReviewFeedback(
        [
          validSource({ id: "comm-fresh", createdAt: NOW.toISOString() }),
          validSource({ id: "comm-old", createdAt: tooOld }),
        ],
        NOW,
      );
      expect(result).toBe(false);
    });

    it("returns false if any comment is in the future (1 ms after now)", () => {
      const inFuture = new Date(NOW.getTime() + 1).toISOString();
      const result = extractReviewFeedback([validSource({ createdAt: inFuture })], NOW);
      expect(result).toBe(false);
    });

    it("returns false if timestamp is invalid / unparseable", () => {
      const result = extractReviewFeedback([validSource({ createdAt: "not-a-date" })], NOW);
      expect(result).toBe(false);
    });
  });

  describe("non-review comments rejection", () => {
    it("returns false if an ordinary issue_comment appears", () => {
      const result = extractReviewFeedback(
        [
          validSource({ kind: "review_comment" }),
          validSource({ id: "comm-2", kind: "issue_comment" }),
        ],
        NOW,
      );
      expect(result).toBe(false);
    });

    it("returns false if a system comment appears", () => {
      const result = extractReviewFeedback(
        [validSource({ kind: "system" })],
        NOW,
      );
      expect(result).toBe(false);
    });

    it("returns false for unrecognized kinds", () => {
      const result = extractReviewFeedback(
        // @ts-expect-error testing untyped runtime inputs
        [validSource({ kind: "random_chat" })],
        NOW,
      );
      expect(result).toBe(false);
    });
  });

  describe("sensitive fields and PII exclusion", () => {
    it("does not leak author, run id, user id, or extra metadata onto the output object", () => {
      const source = {
        ...validSource(),
        // Raw properties that a caller might pass from the DB / API row
        authorAgentId: "3ac4cfe9-60b7-4cc6-9fe9-cdf629e49f76",
        authorUserId: "user-123",
        createdByRunId: "run-abc-xyz",
        metadata: { token: "pcp_live_secret", ip: "203.0.113.9" },
        sourceTrust: { score: 1 },
      };

      const result = extractReviewFeedback([source], NOW);
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");
      const record = result[0]!;

      // Verify the returned object only has the allowed keys
      expect(Object.keys(record).sort()).toEqual([
        "feedback",
        "issue",
        "pullRequest",
        "sourceRef",
        "timestamp",
      ]);
      const rawRecord = record as unknown as Record<string, unknown>;
      expect(rawRecord.authorAgentId).toBeUndefined();
      expect(rawRecord.authorUserId).toBeUndefined();
      expect(rawRecord.createdByRunId).toBeUndefined();
      expect(rawRecord.metadata).toBeUndefined();
      expect(rawRecord.sourceTrust).toBeUndefined();
    });

    it("redacts API keys, tokens, passwords, secrets, and emails in the review prose", () => {
      // Assembled from parts so no single source literal matches the gitleaks
      // generic-key rule (same convention as agent-auth-middleware.test.ts):
      // the values are fake fixtures, not credentials.
      const liveToken = ["pcp_live_", "1234567890abcdef"].join("");
      const testToken = ["pcp_test_", "9876543210"].join("");
      const bodyWithSecrets = [
        `Failed auth: token: ${liveToken}`,
        `Also check api_key=${testToken}.`,
        "Password=supersecretpass and secret: secret1234",
        "Contact author at dev-eng-25@itkadr.internal for details.",
      ].join("\n");

      const result = extractReviewFeedback(
        [validSource({ body: bodyWithSecrets })],
        NOW,
      );
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");

      const feedback = result[0]!.feedback;
      expect(feedback).not.toContain(liveToken);
      expect(feedback).not.toContain(testToken);
      expect(feedback).not.toContain("supersecretpass");
      expect(feedback).not.toContain("secret1234");
      expect(feedback).not.toContain("dev-eng-25@itkadr.internal");
      expect(feedback).toContain("[REDACTED]");
    });

    it("redacts key blobs, cloud/OpenAI key shapes, and authorization headers (OPE-12928 review)", () => {
      // PEM private key and certificate blocks are assembled from parts so no
      // single source literal trips the gitleaks PEM rules; same convention as
      // above — the fixtures are fake, not credentials.
      const pemKey = ["-----BEGIN " + "RSA PRIVATE KEY-----", "MIIEpAIBAAKCAQEA7fake", "-----END " + "RSA PRIVATE KEY-----"].join("\n");
      const pemCert = ["-----BEGIN CERTIFICATE-----", "MIIDdzCCAl+gAwIBAgIEfake", "-----END CERTIFICATE-----"].join("\n");
      const awsKey = ["AKIA", "TEST1234567890EXAMPLE"].join("").slice(0, 20); // AKIA + 16 chars
      const openAiKey = ["sk-", "test_", "0123456789abcdef0123456789abcdef"].join("");
      const sshPub = "ssh-ed25519 " + "AAAAC3NzaC1lZDI1NTE5".repeat(6);
      const headerPart = ["ey", "JhbGciOi", "JIUzI1", "NiJ9"].join("");
      const payloadPart = ["ey", "JzdWIiOi", "IxMjM0", "NTY3", "ODkw", "In0"].join("");
      const sigPart = ["sig", "value", "1234", "56"].join("");
      const jwtVal = `${headerPart}.${payloadPart}.${sigPart}`;
      const bearerVal = ["sample_bearer_", "auth_token_9876543210"].join("");
      const body = [
        `Paste: ${pemKey}`,
        `Cert chain: ${pemCert}`,
        `aws id ${awsKey} leaked`,
        `client key ${openAiKey} in the log`,
        `deploy key: ${sshPub}`,
        `Authorization: Bearer ${jwtVal}`,
        `pass Bearer ${bearerVal} inline`,
        "the deploy must keep working after these redactions",
      ].join("\n");

      const result = extractReviewFeedback([validSource({ body })], NOW);
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");

      const feedback = result[0]!.feedback;
      expect(feedback).not.toContain("BEGIN " + "RSA PRIVATE KEY");
      expect(feedback).not.toContain("BEGIN CERTIFICATE");
      expect(feedback).not.toContain("MIIEpAIBAAKCAQEA7fake");
      expect(feedback).not.toContain(awsKey);
      expect(feedback).not.toContain(openAiKey);
      expect(feedback).not.toContain(sshPub);
      expect(feedback).not.toContain(jwtVal);
      expect(feedback).not.toContain(bearerVal);
      // The non-sensitive tail of the prose survives so the lesson is intact.
      expect(feedback).toContain("the deploy must keep working after these redactions");
      expect(feedback).toContain("[REDACTED]");
    });
  });

  describe("structural validation and deterministic output", () => {
    it("returns false if essential fields for deterministic references are missing", () => {
      expect(extractReviewFeedback([validSource({ id: "" })], NOW)).toBe(false);
      expect(extractReviewFeedback([validSource({ issueId: "" })], NOW)).toBe(false);
      expect(extractReviewFeedback([validSource({ issueIdentifier: "" })], NOW)).toBe(false);
      expect(extractReviewFeedback([validSource({ body: "   " })], NOW)).toBe(false);
      expect(
        extractReviewFeedback(
          [validSource({ pullRequest: { repository: "", number: 123 } })],
          NOW,
        ),
      ).toBe(false);
      expect(
        extractReviewFeedback(
          [validSource({ pullRequest: { repository: "itkadr-git/myrmidon", number: 0 } })],
          NOW,
        ),
      ).toBe(false);
    });

    it("returns an empty array when given an empty input array", () => {
      expect(extractReviewFeedback([], NOW)).toEqual([]);
    });

    it("sorts deterministically by timestamp, then sourceRef", () => {
      const input = [
        validSource({
          id: "c-2",
          createdAt: "2026-11-05T10:00:00.000Z",
        }),
        validSource({
          id: "c-1",
          createdAt: "2026-11-01T10:00:00.000Z",
        }),
        validSource({
          id: "c-3",
          createdAt: "2026-11-05T10:00:00.000Z",
          pullRequest: { repository: "itkadr-git/myrmidon", number: 9999 },
        }),
      ];

      const result = extractReviewFeedback(input, NOW);
      expect(result).not.toBe(false);
      if (result === false) throw new Error("unreachable");
      expect(result.map((r) => r.sourceRef)).toEqual([
        "issue:8e2edecc-b88f-4d97-b3ad-458768adb4fd:pr:itkadr-git/myrmidon#4421:comment:c-1",
        "issue:8e2edecc-b88f-4d97-b3ad-458768adb4fd:pr:itkadr-git/myrmidon#4421:comment:c-2",
        "issue:8e2edecc-b88f-4d97-b3ad-458768adb4fd:pr:itkadr-git/myrmidon#9999:comment:c-3",
      ]);
    });
  });
});
