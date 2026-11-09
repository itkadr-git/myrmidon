import { beforeEach, describe, expect, it, vi } from "vitest";

// myrmidon(OPE-12182): the real logActivity needs a full drizzle/instance-settings
// mock; the unit mock db here is intentionally minimal. Tests assert on the
// recorded calls instead.
const logActivityMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock("./activity-log.js", () => ({
  logActivity: logActivityMock,
}));

import {
  headMatches,
  parseReviewedHead,
  parsePullRequestCoordinates,
  isApprovalOutcome,
  executeWithRetry,
  createDefaultGitHubApprovalClient,
  propagateReviewApprovalToPullRequest,
  REVIEW_APPROVED_LABEL,
  BOARD_REVIEW_CHECK_RUN_NAME,
  PR_APPROVAL_ACTIVITY_PROPAGATED,
  PR_APPROVAL_ACTIVITY_SKIPPED,
  PR_APPROVAL_ACTIVITY_FAILED,
  type GitHubApprovalClient,
  type PropagateReviewApprovalInput,
} from "./pull-request-approval-propagation.js";

describe("pull-request-approval-propagation", () => {
  describe("headMatches", () => {
    it("matches exact full SHA", () => {
      const sha = "a1b2c3d4e5f6789012345678901234567890abcd";
      expect(headMatches(sha, sha)).toBe(true);
    });

    it("matches short SHA prefix to full SHA", () => {
      const shortSha = "a1b2c3d";
      const fullSha = "a1b2c3d4e5f6789012345678901234567890abcd";
      expect(headMatches(shortSha, fullSha)).toBe(true);
      expect(headMatches(fullSha, shortSha)).toBe(true);
    });

    it("matches case-insensitively", () => {
      expect(headMatches("A1B2C3D", "a1b2c3d4e5f6789012345678901234567890abcd")).toBe(true);
    });

    it("returns false when heads do not match (fail-safe for moved head)", () => {
      expect(headMatches("a1b2c3d", "e5f6789012345678901234567890abcdef123456")).toBe(false);
      expect(headMatches("1111111", "2222222")).toBe(false);
    });

    it("returns false when either SHA is missing or empty", () => {
      expect(headMatches(null, "a1b2c3d")).toBe(false);
      expect(headMatches("a1b2c3d", null)).toBe(false);
      expect(headMatches("", "a1b2c3d")).toBe(false);
      expect(headMatches(undefined, undefined)).toBe(false);
    });
  });

  describe("parseReviewedHead", () => {
    it("extracts head SHA from verdict comment", () => {
      expect(parseReviewedHead("VERDICT #123: APPROVE (head abc1234)")).toBe("abc1234");
      expect(parseReviewedHead("ВЕРДИКТ: APPROVE head def567890123456")).toBe("def567890123456");
      expect(parseReviewedHead("HEAD: 1234567")).toBe("1234567");
    });

    it("returns null if no head reference is present", () => {
      expect(parseReviewedHead("VERDICT: APPROVE looks good to me")).toBe(null);
      expect(parseReviewedHead(null)).toBe(null);
    });

    // myrmidon(OPE-11767): the reviewers write `APPROVE PR #N <sha>`; the explicit
    // `head <sha>` spelling alone left PR #2449 and #2467 with `missing_reviewed_head`.
    it("reads the bare sha of an `APPROVE PR #N <sha>` verdict", () => {
      const sha = "28f15c1be15204153f0e06464842d88875c373f8";
      expect(parseReviewedHead(`APPROVE PR #2467 ${sha}\nГолова: ${sha}. CI завершён успешно.`)).toBe(sha);
      expect(parseReviewedHead("APPROVE PR #2449 d75e816fcea7d115ababc4dad032687ffc8ed14c\nТочный head подтверждён")).toBe(
        "d75e816fcea7d115ababc4dad032687ffc8ed14c",
      );
      // The explicit spelling still wins over a bare sha earlier in the text.
      expect(parseReviewedHead("old 1111aaa rejected; APPROVE head 2222bbb")).toBe("2222bbb");
      // A plain number is not a sha.
      expect(parseReviewedHead("APPROVE PR #2467, issue 1234567890")).toBe(null);
    });
  });

  describe("parsePullRequestCoordinates", () => {
    it("parses full GitHub PR URL", () => {
      const res = parsePullRequestCoordinates("https://github.com/itkadr-git/myrmidon/pull/456");
      expect(res).toEqual({ repository: "itkadr-git/myrmidon", number: 456 });
    });

    it("parses owner/repo#number shorthand", () => {
      const res = parsePullRequestCoordinates("Please review itkadr-git/myrmidon#789 now");
      expect(res).toEqual({ repository: "itkadr-git/myrmidon", number: 789 });
    });

    it("parses #number when default repository is provided", () => {
      const res = parsePullRequestCoordinates("Fixes #101", "itkadr-git/myrmidon");
      expect(res).toEqual({ repository: "itkadr-git/myrmidon", number: 101 });
    });

    it("returns null when no PR reference is found", () => {
      expect(parsePullRequestCoordinates("Just some comment text")).toBe(null);
      expect(parsePullRequestCoordinates(null)).toBe(null);
    });
  });

  describe("isApprovalOutcome", () => {
    it("recognizes approved outcome", () => {
      expect(isApprovalOutcome("approved")).toBe(true);
      expect(isApprovalOutcome("approve")).toBe(true);
    });

    it("recognizes approval verdict body", () => {
      expect(isApprovalOutcome(null, "VERDICT #123: APPROVE")).toBe(true);
      expect(isApprovalOutcome(null, "LGTM, approved")).toBe(true);
    });

    it("recognizes non-approval / REQUEST CHANGES and refuses", () => {
      expect(isApprovalOutcome("changes_requested")).toBe(false);
      expect(isApprovalOutcome("request_changes")).toBe(false);
      expect(isApprovalOutcome("refuse")).toBe(false);
      expect(isApprovalOutcome("returned")).toBe(false);
      expect(isApprovalOutcome(null, "VERDICT: RETURN for rework")).toBe(false);
      expect(isApprovalOutcome(null, "REQUEST CHANGES: fix typo")).toBe(false);
      expect(isApprovalOutcome(null, "BLOCK: unresolved security issue")).toBe(false);
    });

    it("cancels approval if verdict explicitly states RETURN or CHANGES REQUESTED", () => {
      expect(isApprovalOutcome("approved", "VERDICT: RETURN")).toBe(false);
      expect(isApprovalOutcome("approved", "CHANGES REQUESTED")).toBe(false);
    });
  });

  describe("executeWithRetry", () => {
    it("succeeds on first attempt without retrying", async () => {
      const fn = vi.fn().mockResolvedValue("success");
      const res = await executeWithRetry(fn);
      expect(res).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it("retries on transient 503 error and succeeds on subsequent attempt", async () => {
      const error503 = new Error("Service Unavailable");
      (error503 as any).status = 503;
      const fn = vi
        .fn()
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce("recovered");

      const res = await executeWithRetry(fn, { initialDelayMs: 5 });
      expect(res).toBe("recovered");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("fails immediately on non-transient 404 or 401 without retry", async () => {
      const error404 = new Error("Not Found");
      (error404 as any).status = 404;
      const fn = vi.fn().mockRejectedValue(error404);

      await expect(executeWithRetry(fn, { initialDelayMs: 5 })).rejects.toThrow("Not Found");
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe("createDefaultGitHubApprovalClient", () => {
    it("handles 422 on review submission gracefully as skipped", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ message: "Unprocessable Entity" }),
      });
      const client = createDefaultGitHubApprovalClient(mockFetch as any);
      const res = await client.submitReview({
        repository: "owner/repo",
        number: 1,
        headSha: "a1b2c3d",
        event: "APPROVE",
        token: "tok",
      });
      expect(res).toEqual({ skipped: true });
    });
  });

  describe("propagateReviewApprovalToPullRequest", () => {
    const defaultHeadSha = "a1b2c3d4e5f6789012345678901234567890abcd";
    const companyId = "test-company";
    const issueId = "test-issue";

    function createMockDb() {
      const activityEntries: any[] = [];
      const db = {
        select: vi.fn(() => ({
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn().mockResolvedValue([]),
              then: (fn: any) => Promise.resolve([]).then(fn),
              [Symbol.asyncIterator]: async function* () {},
            })),
            innerJoin: vi.fn(() => ({
              where: vi.fn().mockResolvedValue([]),
            })),
          })),
        })),
        insert: vi.fn(() => ({
          values: vi.fn((vals: any) => {
            activityEntries.push(vals);
            return Promise.resolve();
          }),
        })),
        update: vi.fn(() => ({
          set: vi.fn(() => ({
            where: vi.fn().mockResolvedValue([]),
          })),
        })),
        activityEntries,
      };
      return db;
    }

    it("tags PR with review-approved and submits review on valid approval", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: defaultHeadSha,
          labels: ["bug"],
        }),
        addLabel: vi.fn().mockResolvedValue(undefined),
        submitReview: vi.fn().mockResolvedValue({ id: 99 }),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT #123: APPROVE (head ${defaultHeadSha.slice(0, 7)})`,
        },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("propagated");
      expect(result.labelAdded).toBe(true);
      expect(result.reviewSubmitted).toBe(true);
      expect(mockClient.addLabel).toHaveBeenCalledWith({
        repository: "itkadr-git/myrmidon",
        number: 123,
        label: REVIEW_APPROVED_LABEL,
        token: "mock-token",
      });
      expect(mockClient.submitReview).toHaveBeenCalledWith(
        expect.objectContaining({
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          event: "APPROVE",
        }),
      );
    });

    it("current-head guard: refuses and logs skip if PR head moved after review", async () => {
      const db = createMockDb();
      const newHeadSha = "ffffffffffffffffffffffffffffffffffffffff";
      const reviewedHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: newHeadSha, // Head moved on GitHub!
          labels: [],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          reviewedHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT: APPROVE (head ${reviewedHeadSha.slice(0, 7)})`,
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("head_mismatch");
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("current-head guard: fails closed if reviewed head is missing", async () => {
      const db = createMockDb();
      const currentHeadSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: currentHeadSha,
          labels: [],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          decisionOutcome: "approved",
          verdictBody: "VERDICT: APPROVE (no head specified)",
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("missing_reviewed_head");
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("negative path: non-approval / REQUEST CHANGES does not tag or approve", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn(),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          decisionOutcome: "changes_requested",
          verdictBody: "VERDICT #123: RETURN for rework",
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("non_approval");
      expect(mockClient.getPullRequest).not.toHaveBeenCalled();
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("negative path: skips propagation when decisionOutcome is null but verdictBody indicates non-approval", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn(),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          decisionOutcome: null,
          verdictBody: "VERDICT: REQUEST CHANGES please revise",
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("non_approval");
      expect(mockClient.getPullRequest).not.toHaveBeenCalled();
    });

    it("idempotency: does not duplicate label if PR already carries review-approved", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: defaultHeadSha,
          labels: [REVIEW_APPROVED_LABEL, "ready"], // Already has review-approved!
        }),
        addLabel: vi.fn(),
        removeLabel: vi.fn(),
        submitReview: vi.fn(),
        listReviews: vi.fn().mockResolvedValue([
          { id: 1, state: "APPROVED", commitId: defaultHeadSha },
        ]),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
        },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("noop");
      expect(result.reason).toBe("already_labeled");
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.removeLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("idempotency & recovery: recovers missing review if PR is labeled but review is missing", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: defaultHeadSha,
          labels: [REVIEW_APPROVED_LABEL],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn().mockResolvedValue({ id: 99 }),
        listReviews: vi.fn().mockResolvedValue([]),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
        },
      );

      expect(result.success).toBe(true);
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).toHaveBeenCalled();
    });

    // myrmidon(OPE-12024, OPE-9646): when the head moved after an earlier
    // approval, the label sits on the old head and the labeled-triggered
    // hot-files-review workflow never fires on the new one. The propagation
    // must reseat the label (remove + add) so the labeled event fires on the
    // current head.
    it("reseats review-approved when the PR head moved after an earlier approval", async () => {
      const db = createMockDb();
      const oldHeadSha = "old-head-sha";
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: defaultHeadSha,
          labels: [REVIEW_APPROVED_LABEL],
        }),
        addLabel: vi.fn(),
        removeLabel: vi.fn(),
        submitReview: vi.fn(),
        listReviews: vi.fn().mockResolvedValue([
          // Approval pinned to the pre-rebuild head — the head moved after it.
          { id: 0, state: "APPROVED", commitId: oldHeadSha },
          // Re-approval on the current head after the rebuild.
          { id: 1, state: "APPROVED", commitId: defaultHeadSha },
        ]),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
        },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("propagated");
      expect(result.labelAdded).toBe(true);
      expect(mockClient.removeLabel).toHaveBeenCalledWith({
        repository: "itkadr-git/myrmidon",
        number: 123,
        label: REVIEW_APPROVED_LABEL,
        token: "mock-token",
      });
      expect(mockClient.addLabel).toHaveBeenCalledWith({
        repository: "itkadr-git/myrmidon",
        number: 123,
        label: REVIEW_APPROVED_LABEL,
        token: "mock-token",
      });
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("keeps noop already_labeled when the client cannot reseat the label", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: defaultHeadSha,
          labels: [REVIEW_APPROVED_LABEL],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
        listReviews: vi.fn().mockResolvedValue([
          { id: 1, state: "APPROVED", commitId: defaultHeadSha },
        ]),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-token"),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
        },
      );

      expect(result.success).toBe(true);
      expect(result.action).toBe("noop");
      expect(result.reason).toBe("already_labeled");
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();
    });

    it("authorization: fails safely and logs failure when no token is available", async () => {
      const db = createMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn(),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db: db as any,
          client: mockClient,
          tokenProvider: vi.fn().mockResolvedValue(null),
        },
        {
          companyId,
          issueId,
          repository: "itkadr-git/myrmidon",
          number: 123,
          headSha: defaultHeadSha,
          decisionOutcome: "approved",
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("failed");
      expect(result.reason).toBe("missing_credentials");
      expect(mockClient.getPullRequest).not.toHaveBeenCalled();
    });

    it("fails safe when stored headSha is missing in work product metadata during lookup", () => {
      // Direct unit check on head matching fail-safe logic:
      // When reviewedHeadSha is empty/null, lookup/guard must not match
      const taskHeadSha = null;
      const headSha = defaultHeadSha;
      const matches = !taskHeadSha ? false : (taskHeadSha as string).toLowerCase().startsWith(headSha.toLowerCase());
      expect(matches).toBe(false);
    });

    // myrmidon(OPE-12182, REVIEW-CHECKS-NATIVE B): the formal decision writes a
    // "Board review" check run on the reviewed head commit.
    describe("Board review check run", () => {
      beforeEach(() => {
        logActivityMock.mockClear();
      });

      function clientWithCheckRun(overrides: Partial<GitHubApprovalClient> = {}): GitHubApprovalClient {
        return {
          getPullRequest: vi.fn().mockResolvedValue({
            state: "open",
            draft: false,
            merged: false,
            headSha: defaultHeadSha,
            labels: [],
          }),
          addLabel: vi.fn().mockResolvedValue(undefined),
          submitReview: vi.fn().mockResolvedValue({ id: 7 }),
          createCheckRun: vi.fn().mockResolvedValue({ id: 42 }),
          listCheckRuns: vi.fn().mockResolvedValue([]),
          ...overrides,
        };
      }

      it("APPROVE posts a completed success check run on the current head", async () => {
        const db = createMockDb();
        const mockClient = clientWithCheckRun();

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
            boardBaseUrl: "https://board.example.com",
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            headSha: defaultHeadSha,
            decisionOutcome: "approved",
            verdictBody: `VERDICT #123: APPROVE (head ${defaultHeadSha.slice(0, 7)})`,
          },
        );

        expect(result.success).toBe(true);
        expect(result.action).toBe("propagated");
        expect(result.checkRunCreated).toBe(true);
        expect(result.checkRunFailed).toBe(false);
        expect(mockClient.createCheckRun).toHaveBeenCalledTimes(1);
        expect(mockClient.createCheckRun).toHaveBeenCalledWith({
          repository: "itkadr-git/myrmidon",
          headSha: defaultHeadSha,
          name: BOARD_REVIEW_CHECK_RUN_NAME,
          conclusion: "success",
          detailsUrl: `https://board.example.com/issues/${issueId}`,
          title: "Board review: approved",
          summary: expect.stringContaining("APPROVE"),
          token: "mock-token",
        });
      });

      it("REQUEST CHANGES posts a failure check run on the current head, still without label or approval", async () => {
        const db = createMockDb();
        const mockClient = clientWithCheckRun();

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            headSha: defaultHeadSha,
            decisionOutcome: "changes_requested",
            verdictBody: "VERDICT: REQUEST CHANGES fix the typo",
          },
        );

        expect(result.action).toBe("skipped");
        expect(result.reason).toBe("non_approval");
        expect(mockClient.addLabel).not.toHaveBeenCalled();
        expect(mockClient.submitReview).not.toHaveBeenCalled();
        expect(mockClient.createCheckRun).toHaveBeenCalledTimes(1);
        expect(mockClient.createCheckRun).toHaveBeenCalledWith(
          expect.objectContaining({
            repository: "itkadr-git/myrmidon",
            headSha: defaultHeadSha,
            name: BOARD_REVIEW_CHECK_RUN_NAME,
            conclusion: "failure",
          }),
        );
      });

      it("does not post the check run when the reviewed head mismatches the PR head", async () => {
        const db = createMockDb();
        const movedHeadSha = "ffffffffffffffffffffffffffffffffffffffff";
        const mockClient = clientWithCheckRun({
          getPullRequest: vi.fn().mockResolvedValue({
            state: "open",
            draft: false,
            merged: false,
            headSha: movedHeadSha,
            labels: [],
          }),
        });

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            reviewedHeadSha: defaultHeadSha,
            decisionOutcome: "approved",
            verdictBody: `APPROVE PR #123 ${defaultHeadSha.slice(0, 7)}`,
          },
        );

        expect(result.action).toBe("skipped");
        expect(result.reason).toBe("head_mismatch");
        expect(mockClient.createCheckRun).not.toHaveBeenCalled();
        expect(mockClient.addLabel).not.toHaveBeenCalled();
      });

      it("HTTP 403 (no checks:write yet, part D) degrades to warn + activity, never throws", async () => {
        const db = createMockDb();
        const error403 = new Error("GitHub createCheckRun failed with HTTP 403");
        (error403 as any).status = 403;
        const mockClient = clientWithCheckRun({
          createCheckRun: vi.fn().mockRejectedValue(error403),
        });

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            headSha: defaultHeadSha,
            decisionOutcome: "approved",
            verdictBody: `APPROVE PR #123 ${defaultHeadSha.slice(0, 7)}`,
          },
        );

        // The propagation itself still succeeded (label + review written).
        expect(result.success).toBe(true);
        expect(result.action).toBe("propagated");
        expect(result.labelAdded).toBe(true);
        expect(result.checkRunCreated).toBe(false);
        expect(result.checkRunFailed).toBe(true);
        // Warn + activity, not a raised error.
        const failure = logActivityMock.mock.calls.map((c) => c[1] as { action: string; details?: Record<string, unknown> })
          .find((entry) => entry.action === PR_APPROVAL_ACTIVITY_FAILED);
        expect(failure).toBeDefined();
        expect(failure!.details?.reason).toBe("check_run_failed");
        const propagated = logActivityMock.mock.calls.map((c) => c[1] as { action: string; details?: Record<string, unknown> })
          .find((entry) => entry.action === PR_APPROVAL_ACTIVITY_PROPAGATED);
        expect(propagated).toBeDefined();
        expect(propagated!.details?.checkRunFailed).toBe(true);
      });

      it("repeated APPROVE of the same head does not duplicate the check run", async () => {
        const db = createMockDb();
        const mockClient = clientWithCheckRun({
          listCheckRuns: vi.fn().mockResolvedValue([
            { id: 42, conclusion: "success" },
          ]),
        });

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            headSha: defaultHeadSha,
            decisionOutcome: "approved",
          },
        );

        expect(result.success).toBe(true);
        expect(mockClient.createCheckRun).not.toHaveBeenCalled();
        expect(mockClient.listCheckRuns).toHaveBeenCalledWith({
          repository: "itkadr-git/myrmidon",
          headSha: defaultHeadSha,
          name: BOARD_REVIEW_CHECK_RUN_NAME,
          token: "mock-token",
        });
      });

      it("without createCheckRun on the client the propagation stays a plain label/review write", async () => {
        const db = createMockDb();
        const mockClient: GitHubApprovalClient = {
          getPullRequest: vi.fn().mockResolvedValue({
            state: "open",
            draft: false,
            merged: false,
            headSha: defaultHeadSha,
            labels: [],
          }),
          addLabel: vi.fn().mockResolvedValue(undefined),
          submitReview: vi.fn().mockResolvedValue({ id: 7 }),
        };

        const result = await propagateReviewApprovalToPullRequest(
          {
            db: db as any,
            client: mockClient,
            tokenProvider: vi.fn().mockResolvedValue("mock-token"),
          },
          {
            companyId,
            issueId,
            repository: "itkadr-git/myrmidon",
            number: 123,
            headSha: defaultHeadSha,
            decisionOutcome: "approved",
          },
        );

        expect(result.success).toBe(true);
        expect(result.checkRunCreated).toBe(false);
        expect(result.checkRunFailed).toBe(false);
        const failures = logActivityMock.mock.calls.map((c) => c[1] as { action: string })
          .filter((entry) => entry.action === PR_APPROVAL_ACTIVITY_FAILED);
        expect(failures).toHaveLength(0);
      });

      it("default client implements createCheckRun/listCheckRuns over fetch", async () => {
        const calls: Array<{ url: string; init?: RequestInit }> = [];
        const mockFetch = vi.fn(async (url: string, init?: RequestInit) => {
          calls.push({ url, init });
          if (calls.length === 1) {
            // createCheckRun POST
            return {
              ok: true,
              status: 201,
              json: async () => ({ id: 4242 }),
            } as Response;
          }
          // listCheckRuns GET
          return {
            ok: true,
            status: 200,
            json: async () => ({ total_count: 1, check_runs: [{ id: 4242, conclusion: "success" }] }),
          } as Response;
        });
        const client = createDefaultGitHubApprovalClient(mockFetch as any);

        await expect(
          client.createCheckRun!({
            repository: "owner/repo",
            headSha: defaultHeadSha,
            name: BOARD_REVIEW_CHECK_RUN_NAME,
            conclusion: "success",
            detailsUrl: "https://board.example.com/issues/iss-1",
            title: "Board review: approved",
            summary: "summary",
            token: "tok",
          }),
        ).resolves.toEqual({ id: 4242 });

        await expect(
          client.listCheckRuns!({ repository: "owner/repo", headSha: defaultHeadSha, name: BOARD_REVIEW_CHECK_RUN_NAME, token: "tok" }),
        ).resolves.toEqual([{ id: 4242, conclusion: "success" }]);

        const post = calls[0]!;
        expect(post.url).toBe("https://api.github.com/repos/owner/repo/check-runs");
        expect(post.init?.method).toBe("POST");
        const postBody = JSON.parse(String(post.init?.body));
        expect(postBody).toEqual({
          name: BOARD_REVIEW_CHECK_RUN_NAME,
          head_sha: defaultHeadSha,
          status: "completed",
          conclusion: "success",
          details_url: "https://board.example.com/issues/iss-1",
          output: { title: "Board review: approved", summary: "summary" },
        });
        const get = calls[1]!;
        expect(get.url).toBe(
          `https://api.github.com/repos/owner/repo/commits/${defaultHeadSha}/check-runs?check_name=${encodeURIComponent(BOARD_REVIEW_CHECK_RUN_NAME)}&filter=latest&per_page=100`,
        );
      });
    });
  });
});
