import { describe, expect, it, vi } from "vitest";
import {
  propagateReviewApprovalToPullRequest,
  triggerReviewApprovalPropagation,
  isApprovalOutcome,
  headMatches,
  parseReviewedHead,
  parsePullRequestCoordinates,
  REVIEW_APPROVED_LABEL,
  PR_APPROVAL_ACTIVITY_PROPAGATED,
  PR_APPROVAL_ACTIVITY_SKIPPED,
  PR_APPROVAL_ACTIVITY_FAILED,
  type GitHubApprovalClient,
  type GitHubPullRequestDetails,
  type PropagateReviewApprovalInput,
} from "../services/pull-request-approval-propagation.js";
import {
  buildDevflowSignals,
  staleMarkerSince,
  stalledMergeSince,
  stalledRouterSince,
  redCiSince,
  type DevflowSample,
  type DevflowSignal,
  type PrMarkerState,
  type ReviewVerdict,
} from "../myrmidon/devflow-health/signals.js";
import {
  evaluateDevflowThresholds,
  collectDevflowDurations,
  DEFAULT_DEVFLOW_THRESHOLDS_MS,
  type DevflowThresholds,
} from "../myrmidon/devflow-health/thresholds.js";
import {
  extractPrMarker,
  extractReviewVerdict,
  collectDevflowHealth,
} from "../myrmidon/devflow-health/collector.js";

interface MockDbContext {
  activityEntries: any[];
  workProducts: any[];
  issues: any[];
  decisions: any[];
  comments: any[];
  events: any[];
  agents: any[];
  settings: any[];
}

function createDevflowMockDb(initial: Partial<MockDbContext> = {}) {
  const state: MockDbContext = {
    activityEntries: initial.activityEntries ?? [],
    workProducts: initial.workProducts ?? [],
    issues: initial.issues ?? [],
    decisions: initial.decisions ?? [],
    comments: initial.comments ?? [],
    events: initial.events ?? [],
    agents: initial.agents ?? [],
    settings: initial.settings ?? [{ general: { devflowHealth: { ...DEFAULT_DEVFLOW_THRESHOLDS_MS } } }],
  };

  const db: any = {
    _state: state,
    select: vi.fn((fields?: any) => ({
      from: vi.fn((table: any) => {
        const queryBuilder: any = {
          innerJoin: vi.fn(() => queryBuilder),
          where: vi.fn(() => queryBuilder),
          limit: vi.fn(() => {
            // Check if selecting from instanceSettings
            if (fields && fields.general !== undefined) {
              return Promise.resolve(state.settings);
            }
            return Promise.resolve(state.issues.slice(0, 1));
          }),
          then: (resolve: any) => {
            // Determine result based on query context
            if (fields && fields.general !== undefined) {
              return Promise.resolve(state.settings).then(resolve);
            }
            if (fields && fields.product !== undefined && fields.issue !== undefined) {
              // Join between workProducts and issues
              const joined = state.workProducts.map((wp) => {
                const issue = state.issues.find((i) => i.id === wp.issueId) ?? {
                  id: wp.issueId,
                  companyId: wp.companyId,
                  title: "Test Issue",
                  status: "in_progress",
                  hiddenAt: null,
                };
                return { product: wp, issue };
              });
              return Promise.resolve(joined).then(resolve);
            }
            if (fields && fields.since !== undefined && fields.status !== undefined) {
              // inReviewIssues query
              return Promise.resolve(state.issues.filter((i) => i.status === "in_review")).then(resolve);
            }
            if (fields && fields.event !== undefined) {
              // connectionEventDeliveries query
              return Promise.resolve(state.events).then(resolve);
            }
            if (fields && fields.body !== undefined) {
              // verdictComments query
              return Promise.resolve(state.comments).then(resolve);
            }
            return Promise.resolve([]).then(resolve);
          },
          [Symbol.asyncIterator]: async function* () {},
        };
        return queryBuilder;
      }),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((vals: any) => {
        state.activityEntries.push(vals);
        return Promise.resolve();
      }),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: any) => ({
        where: vi.fn((condition: any) => {
          // If work product metadata updated
          if (patch.metadata && state.workProducts.length > 0) {
            state.workProducts[0].metadata = {
              ...state.workProducts[0].metadata,
              ...patch.metadata,
            };
          }
          return Promise.resolve();
        }),
      })),
    })),
  };

  return db;
}

describe("DEVFLOW Lifecycle: Behavior-Level Integration Tests", () => {
  const companyId = "2870b911-483a-4091-9f15-183841811143";
  const issueId = "5b85e2bd-e6a1-4d0a-893d-4f2ebee2e435";
  const repository = "itkadr-git/myrmidon";
  const pullRequestNumber = 1234;
  const initialHeadSha = "a1b2c3d4e5f6789012345678901234567890abcd";

  // =========================================================================
  // Requirement 1: Formal board review decision APPROVE results in GitHub PR
  // approval / review-approved marker and enters auto-merge without host scripts.
  // =========================================================================
  describe("Requirement 1: Formal board review decision APPROVE propagation and auto-merge entry", () => {
    it("propagates APPROVE verdict: adds review-approved label, submits GitHub review, and updates work product metadata", async () => {
      const db = createDevflowMockDb({
        workProducts: [
          {
            id: "wp-1",
            companyId,
            issueId,
            type: "pull_request",
            status: "open",
            url: `https://github.com/${repository}/pull/${pullRequestNumber}`,
            metadata: {
              repository,
              number: pullRequestNumber,
              headSha: initialHeadSha,
            },
          },
        ],
      });

      const gitHubState: {
        pr: GitHubPullRequestDetails;
        labelsAdded: string[];
        reviewsSubmitted: Array<{ headSha: string; event: string; body?: string }>;
      } = {
        pr: {
          state: "open",
          draft: false,
          merged: false,
          headSha: initialHeadSha,
          labels: ["devflow"],
        },
        labelsAdded: [],
        reviewsSubmitted: [],
      };

      const mockGitHubClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockImplementation(async () => ({ ...gitHubState.pr })),
        addLabel: vi.fn().mockImplementation(async ({ label }) => {
          gitHubState.labelsAdded.push(label);
          gitHubState.pr.labels.push(label);
        }),
        submitReview: vi.fn().mockImplementation(async ({ headSha, event, body }) => {
          gitHubState.reviewsSubmitted.push({ headSha, event, body });
          return { id: 98765 };
        }),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db,
          client: mockGitHubClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-gh-token"),
        },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          headSha: initialHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT #${pullRequestNumber}: APPROVE (head ${initialHeadSha.slice(0, 7)}) - looks great!`,
          actor: {
            actorType: "agent",
            actorId: "de161d66-313f-43ba-ab86-bbaf0a617f1c",
            agentId: "de161d66-313f-43ba-ab86-bbaf0a617f1c",
          },
        },
      );

      // Verify propagation result
      expect(result.success).toBe(true);
      expect(result.action).toBe("propagated");
      expect(result.labelAdded).toBe(true);
      expect(result.reviewSubmitted).toBe(true);
      expect(result.currentHeadSha).toBe(initialHeadSha);

      // Verify GitHub client operations (no external python scripts required)
      expect(mockGitHubClient.addLabel).toHaveBeenCalledWith({
        repository,
        number: pullRequestNumber,
        label: REVIEW_APPROVED_LABEL,
        token: "mock-gh-token",
      });
      expect(mockGitHubClient.submitReview).toHaveBeenCalledWith({
        repository,
        number: pullRequestNumber,
        headSha: initialHeadSha,
        event: "APPROVE",
        body: expect.stringContaining("APPROVE"),
        token: "mock-gh-token",
      });

      // Verify work product metadata updated with reviewApprovedAt and lastApprovedHeadSha
      expect(db._state.workProducts[0].metadata.lastApprovedHeadSha).toBe(initialHeadSha);
      expect(db._state.workProducts[0].metadata.reviewApprovedAt).toBeDefined();

      // Verify activity log recorded
      const activity = db._state.activityEntries.find((e: any) => e.action === PR_APPROVAL_ACTIVITY_PROPAGATED);
      expect(activity).toBeDefined();
      expect(activity.companyId).toBe(companyId);
      expect(activity.entityId).toBe(issueId);
      expect(activity.details.labelAdded).toBe(true);
      expect(activity.details.reviewSubmitted).toBe(true);

      // Verify PR marker state now satisfies auto-merge entry without host scripts
      const markerState = extractPrMarker(
        {
          reviewApproved: true,
          reviewApprovedAt: db._state.workProducts[0].metadata.reviewApprovedAt,
          labels: gitHubState.pr.labels,
        },
        [],
      );
      expect(markerState.hasMarker).toBe(true);
    });

    it("enforces current-head guard: rejects stale APPROVE when PR head moved after review", async () => {
      const db = createDevflowMockDb();
      const movedHeadSha = "9999999999999999999999999999999999999999";
      const reviewedHeadSha = "1111111111111111111111111111111111111111";

      const mockGitHubClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: movedHeadSha, // Head has advanced on remote!
          labels: [],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db,
          client: mockGitHubClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-gh-token"),
        },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          reviewedHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT: APPROVE head ${reviewedHeadSha.slice(0, 7)}`,
        },
      );

      // Must refuse to mark approved on moved head
      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("head_mismatch");
      expect(mockGitHubClient.addLabel).not.toHaveBeenCalled();
      expect(mockGitHubClient.submitReview).not.toHaveBeenCalled();

      // Skipped audit log emitted
      const activity = db._state.activityEntries.find((e: any) => e.action === PR_APPROVAL_ACTIVITY_SKIPPED);
      expect(activity).toBeDefined();
      expect(activity.details.reason).toBe("head_mismatch");
    });
  });

  // =========================================================================
  // Requirement 2: Non-approval / REQUEST CHANGES does not mark approved.
  // =========================================================================
  describe("Requirement 2: Non-approval / REQUEST CHANGES does not mark approved", () => {
    it.each([
      { outcome: "changes_requested", body: "Need more test coverage" },
      { outcome: "request_changes", body: "Please fix lint errors" },
      { outcome: "refuse", body: "Architecture violation" },
      { outcome: "return", body: "VERDICT #1234: RETURN (head a1b2c3d)" },
      { outcome: "rejected", body: "Rejected by security policy" },
      { outcome: null, body: "VERDICT: REQUEST CHANGES please revise" },
      { outcome: null, body: "ВЕРДИКТ: REWORK head a1b2c3d" },
    ])("skips propagation for non-approval outcome: %j", async ({ outcome, body }) => {
      const db = createDevflowMockDb();
      const mockGitHubClient: GitHubApprovalClient = {
        getPullRequest: vi.fn(),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const result = await propagateReviewApprovalToPullRequest(
        {
          db,
          client: mockGitHubClient,
          tokenProvider: vi.fn().mockResolvedValue("mock-gh-token"),
        },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          decisionOutcome: outcome,
          verdictBody: body,
        },
      );

      expect(result.success).toBe(false);
      expect(result.action).toBe("skipped");
      expect(result.reason).toBe("non_approval");

      // Verify no GitHub API actions occurred
      expect(mockGitHubClient.getPullRequest).not.toHaveBeenCalled();
      expect(mockGitHubClient.addLabel).not.toHaveBeenCalled();
      expect(mockGitHubClient.submitReview).not.toHaveBeenCalled();

      // Verify activity audit logged the skip
      const activity = db._state.activityEntries.find((e: any) => e.action === PR_APPROVAL_ACTIVITY_SKIPPED);
      expect(activity).toBeDefined();
      expect(activity.details.reason).toBe("non_approval");
    });

    it("ensures isApprovalOutcome returns false for ambiguous or conflicting bodies", () => {
      // Body says changes requested even if outcome field was set to approved
      expect(isApprovalOutcome("approved", "VERDICT: REQUEST CHANGES on database index")).toBe(false);
      expect(isApprovalOutcome("approved", "RETURNED: must fix security flaw")).toBe(false);
      expect(isApprovalOutcome(null, "No clear verdict here")).toBe(false);
    });

    it("verifies staleMarkerSince does not emit alert for non-approval review verdicts", () => {
      const returnVerdict: ReviewVerdict = {
        outcome: "return",
        at: new Date(Date.now() - 7200_000).toISOString(),
        headSha: initialHeadSha,
      };

      const markerSince = staleMarkerSince({
        verdict: returnVerdict,
        marker: { hasMarker: false },
        prStatus: "open",
        currentHeadSha: initialHeadSha,
      });

      expect(markerSince).toBeNull();
    });
  });

  // =========================================================================
  // Requirement 3: Duplicate decisions / events are safe and idempotent.
  // =========================================================================
  describe("Requirement 3: Duplicate decisions / events are safe and idempotent", () => {
    it("handles duplicate APPROVE decisions safely: first propagates, second no-ops without redundant calls", async () => {
      const db = createDevflowMockDb();
      const prState: GitHubPullRequestDetails = {
        state: "open",
        draft: false,
        merged: false,
        headSha: initialHeadSha,
        labels: [],
      };

      const mockGitHubClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockImplementation(async () => ({ ...prState })),
        addLabel: vi.fn().mockImplementation(async ({ label }) => {
          prState.labels.push(label);
        }),
        submitReview: vi.fn().mockResolvedValue({ id: 101 }),
      };

      const deps = {
        db,
        client: mockGitHubClient,
        tokenProvider: vi.fn().mockResolvedValue("mock-gh-token"),
      };

      const input: PropagateReviewApprovalInput = {
        companyId,
        issueId,
        repository,
        number: pullRequestNumber,
        headSha: initialHeadSha,
        decisionOutcome: "approved",
        verdictBody: `VERDICT #${pullRequestNumber}: APPROVE (head ${initialHeadSha.slice(0, 7)})`,
      };

      // 1st invocation: initial propagation
      const firstResult = await propagateReviewApprovalToPullRequest(deps, input);
      expect(firstResult.success).toBe(true);
      expect(firstResult.action).toBe("propagated");
      expect(firstResult.labelAdded).toBe(true);
      expect(mockGitHubClient.addLabel).toHaveBeenCalledTimes(1);
      expect(mockGitHubClient.submitReview).toHaveBeenCalledTimes(1);

      // 2nd invocation: duplicate decision event arrives
      const secondResult = await propagateReviewApprovalToPullRequest(deps, input);
      expect(secondResult.success).toBe(true);
      expect(secondResult.action).toBe("noop");
      expect(secondResult.reason).toBe("already_labeled");

      // Verify no duplicate GitHub mutations were issued
      expect(mockGitHubClient.addLabel).toHaveBeenCalledTimes(1);
      expect(mockGitHubClient.submitReview).toHaveBeenCalledTimes(1);
    });

    it("treats webhook deliveries with duplicate review-approved label events idempotently", () => {
      const t1 = new Date("2026-10-30T10:00:00.000Z");
      const t2 = new Date("2026-10-30T10:01:00.000Z");

      const duplicateEvents = [
        {
          event: "pull_request",
          payload: { action: "labeled", label: { name: "review-approved" } },
          at: t1,
          receivedAt: t1,
        },
        {
          event: "pull_request",
          payload: { action: "labeled", label: { name: "review-approved" } },
          at: t2,
          receivedAt: t2,
        },
      ];

      const markerState = extractPrMarker({}, duplicateEvents);
      expect(markerState.hasMarker).toBe(true);
      expect(markerState.markedAt).toBe(t1.toISOString());
    });
  });

  // =========================================================================
  // Requirement 4: Stale/missing marker, stalled merge, and stalled router each
  // emit a liveness alert.
  // =========================================================================
  describe("Requirement 4: Liveness alert emissions for stale marker, stalled merge, and stalled router", () => {
    const testNow = new Date("2026-10-30T16:00:00.000Z");
    const twoHoursAgo = new Date("2026-10-30T14:00:00.000Z").toISOString();
    const thresholds: DevflowThresholds = {
      ...DEFAULT_DEVFLOW_THRESHOLDS_MS,
      staleMarkerMs: 3600_000,   // 60 minutes
      stalledMergeMs: 3600_000,  // 60 minutes
      stalledRouterMs: 3600_000, // 60 minutes
    };

    it("emits liveness alert when APPROVE review verdict lacks review-approved marker (stale/missing marker)", () => {
      const approveVerdict: ReviewVerdict = {
        outcome: "approve",
        at: twoHoursAgo,
        headSha: initialHeadSha,
      };

      // Missing marker
      const missingMarkerSince = staleMarkerSince({
        verdict: approveVerdict,
        marker: { hasMarker: false },
        prStatus: "open",
        currentHeadSha: initialHeadSha,
      });
      expect(missingMarkerSince).toBe(twoHoursAgo);

      // Emits alert signal via buildDevflowSignals
      const samples: DevflowSample[] = [
        {
          companyId,
          subjectId: issueId,
          subjectKind: "issue",
          title: "PR Approval Integration Issue",
          metric: "staleMarkerMs",
          since: missingMarkerSince!,
        },
      ];

      const signals = buildDevflowSignals(samples, thresholds, testNow);
      expect(signals).toHaveLength(1);
      expect(signals[0].metric).toBe("staleMarkerMs");
      expect(signals[0].durationMs).toBe(7200_000); // 2 hours > 1 hour threshold
      expect(signals[0].dedupKey).toBe(`devflow:${companyId}:staleMarkerMs:${issueId}`);
    });

    it("emits liveness alert when review-approved marker is stale relative to latest APPROVE verdict", () => {
      const threeHoursAgo = new Date("2026-10-30T13:00:00.000Z").toISOString();
      const approveVerdict: ReviewVerdict = {
        outcome: "approve",
        at: twoHoursAgo,
        headSha: initialHeadSha,
      };

      // Marker was applied 3 hours ago (before verdict 2 hours ago)
      const staleMarkerState: PrMarkerState = {
        hasMarker: true,
        markedAt: threeHoursAgo,
        markerHeadSha: initialHeadSha,
      };

      const markerSince = staleMarkerSince({
        verdict: approveVerdict,
        marker: staleMarkerState,
        prStatus: "open",
        currentHeadSha: initialHeadSha,
      });

      expect(markerSince).toBe(twoHoursAgo);
      const signals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Issue", metric: "staleMarkerMs", since: markerSince! }],
        thresholds,
        testNow,
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].metric).toBe("staleMarkerMs");
    });

    it("emits liveness alert when approved PR remains unmerged past threshold (stalled merge)", () => {
      const approvedAt = twoHoursAgo;

      const mergeSince = stalledMergeSince({
        approvedAt,
        prStatus: "open",
        isMerged: false,
      });
      expect(mergeSince).toBe(twoHoursAgo);

      const signals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Issue", metric: "stalledMergeMs", since: mergeSince! }],
        thresholds,
        testNow,
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].metric).toBe("stalledMergeMs");
      expect(signals[0].durationMs).toBe(7200_000);
      expect(signals[0].dedupKey).toBe(`devflow:${companyId}:stalledMergeMs:${issueId}`);
    });

    it("emits liveness alert when issue in in_review lacks reviewer past threshold (stalled router)", () => {
      const inReviewSince = twoHoursAgo;

      const routerSince = stalledRouterSince({
        status: "in_review",
        needsReviewer: true,
        inReviewSince,
      });
      expect(routerSince).toBe(twoHoursAgo);

      const signals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Issue", metric: "stalledRouterMs", since: routerSince! }],
        thresholds,
        testNow,
      );
      expect(signals).toHaveLength(1);
      expect(signals[0].metric).toBe("stalledRouterMs");
      expect(signals[0].durationMs).toBe(7200_000);
      expect(signals[0].dedupKey).toBe(`devflow:${companyId}:stalledRouterMs:${issueId}`);
    });
  });

  // =========================================================================
  // Requirement 5: Recovery clears each alert.
  // =========================================================================
  describe("Requirement 5: Recovery clears each liveness alert", () => {
    const testNow = new Date("2026-10-30T16:00:00.000Z");
    const twoHoursAgo = new Date("2026-10-30T14:00:00.000Z").toISOString();
    const oneHourAgo = new Date("2026-10-30T15:00:00.000Z").toISOString();
    const thresholds: DevflowThresholds = {
      ...DEFAULT_DEVFLOW_THRESHOLDS_MS,
      staleMarkerMs: 3600_000,
      stalledMergeMs: 3600_000,
      stalledRouterMs: 3600_000,
    };

    it("clears stale marker alert once review-approved marker is applied matching current head", () => {
      const approveVerdict: ReviewVerdict = {
        outcome: "approve",
        at: twoHoursAgo,
        headSha: initialHeadSha,
      };

      // Before recovery: marker is missing -> alert triggers
      const beforeRecovery = staleMarkerSince({
        verdict: approveVerdict,
        marker: { hasMarker: false },
        prStatus: "open",
        currentHeadSha: initialHeadSha,
      });
      expect(beforeRecovery).not.toBeNull();
      expect(
        buildDevflowSignals(
          [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Issue", metric: "staleMarkerMs", since: beforeRecovery! }],
          thresholds,
          testNow,
        ),
      ).toHaveLength(1);

      // Recovery: marker applied after verdict with matching head
      const afterRecovery = staleMarkerSince({
        verdict: approveVerdict,
        marker: {
          hasMarker: true,
          markedAt: oneHourAgo,
          markerHeadSha: initialHeadSha,
        },
        prStatus: "open",
        currentHeadSha: initialHeadSha,
      });
      expect(afterRecovery).toBeNull(); // Alert cleared!
    });

    it("clears stale marker alert when PR is merged or closed", () => {
      const approveVerdict: ReviewVerdict = {
        outcome: "approve",
        at: twoHoursAgo,
        headSha: initialHeadSha,
      };

      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: false },
          prStatus: "merged",
          currentHeadSha: initialHeadSha,
        }),
      ).toBeNull();

      expect(
        staleMarkerSince({
          verdict: approveVerdict,
          marker: { hasMarker: false },
          prStatus: "closed",
          currentHeadSha: initialHeadSha,
        }),
      ).toBeNull();
    });

    it("clears stalled merge alert when PR merges or closes", () => {
      // Before recovery: open and approved -> alert triggers
      const beforeMerge = stalledMergeSince({
        approvedAt: twoHoursAgo,
        prStatus: "open",
        isMerged: false,
      });
      expect(beforeMerge).not.toBeNull();

      // Recovery: PR is merged
      const afterMerge = stalledMergeSince({
        approvedAt: twoHoursAgo,
        prStatus: "merged",
        isMerged: true,
      });
      expect(afterMerge).toBeNull(); // Alert cleared!

      // Recovery: PR is closed
      const afterClose = stalledMergeSince({
        approvedAt: twoHoursAgo,
        prStatus: "closed",
        isMerged: false,
      });
      expect(afterClose).toBeNull(); // Alert cleared!
    });

    it("clears stalled router alert when reviewer is assigned or issue leaves in_review", () => {
      // Before recovery: needsReviewer is true -> alert triggers
      const beforeAssignment = stalledRouterSince({
        status: "in_review",
        needsReviewer: true,
        inReviewSince: twoHoursAgo,
      });
      expect(beforeAssignment).not.toBeNull();

      // Recovery 1: Reviewer assigned (needsReviewer becomes false)
      const afterAssignment = stalledRouterSince({
        status: "in_review",
        needsReviewer: false,
        inReviewSince: twoHoursAgo,
      });
      expect(afterAssignment).toBeNull(); // Alert cleared!

      // Recovery 2: Issue transitions out of in_review (e.g. to in_progress or done)
      const afterTransition = stalledRouterSince({
        status: "in_progress",
        needsReviewer: true,
        inReviewSince: twoHoursAgo,
      });
      expect(afterTransition).toBeNull(); // Alert cleared!
    });
  });

  // =========================================================================
  // Comprehensive End-to-End Simulation: DEVFLOW Lifecycle
  // =========================================================================
  describe("End-to-End DEVFLOW Lifecycle Integration", () => {
    it("simulates complete DEVFLOW progression: review routing -> request changes -> rework -> approve -> native propagation -> auto-merge -> recovery", async () => {
      const now = new Date("2026-10-30T18:00:00.000Z");
      const thresholds: DevflowThresholds = {
        ...DEFAULT_DEVFLOW_THRESHOLDS_MS,
        staleMarkerMs: 1800_000,   // 30 min
        stalledMergeMs: 1800_000,  // 30 min
        stalledRouterMs: 1800_000, // 30 min
      };

      // --- PHASE 1: Issue entered in_review without a reviewer assigned ---
      const enteredReviewAt = new Date("2026-10-30T14:00:00.000Z").toISOString();
      let routerAlert = stalledRouterSince({
        status: "in_review",
        needsReviewer: true,
        inReviewSince: enteredReviewAt,
      });
      expect(routerAlert).toBe(enteredReviewAt);
      let activeSignals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Task", metric: "stalledRouterMs", since: routerAlert! }],
        thresholds,
        now,
      );
      expect(activeSignals).toHaveLength(1);
      expect(activeSignals[0].metric).toBe("stalledRouterMs");

      // --- PHASE 2: Reviewer assigned -> stalledRouter alert clears ---
      routerAlert = stalledRouterSince({
        status: "in_review",
        needsReviewer: false,
        inReviewSince: enteredReviewAt,
      });
      expect(routerAlert).toBeNull(); // Cleared!

      // --- PHASE 3: Reviewer inspects code, submits REQUEST CHANGES ---
      const db = createDevflowMockDb();
      const mockClient: GitHubApprovalClient = {
        getPullRequest: vi.fn().mockResolvedValue({
          state: "open",
          draft: false,
          merged: false,
          headSha: initialHeadSha,
          labels: [],
        }),
        addLabel: vi.fn(),
        submitReview: vi.fn(),
      };

      const requestChangesResult = await propagateReviewApprovalToPullRequest(
        { db, client: mockClient, tokenProvider: vi.fn().mockResolvedValue("gh-token") },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          decisionOutcome: "changes_requested",
          verdictBody: "VERDICT: REQUEST CHANGES please fix edge cases",
        },
      );
      expect(requestChangesResult.success).toBe(false);
      expect(requestChangesResult.action).toBe("skipped");
      expect(mockClient.addLabel).not.toHaveBeenCalled();
      expect(mockClient.submitReview).not.toHaveBeenCalled();

      // Ensure no false stale marker alert during rework
      expect(
        staleMarkerSince({
          verdict: { outcome: "return", at: new Date("2026-10-30T15:00:00.000Z").toISOString() },
          marker: { hasMarker: false },
          prStatus: "open",
        }),
      ).toBeNull();

      // --- PHASE 4: Developer fixes code, pushes new head SHA ---
      const reworkedHeadSha = "b2c3d4e5f6789012345678901234567890abcdef";
      const prDetails: GitHubPullRequestDetails = {
        state: "open",
        draft: false,
        merged: false,
        headSha: reworkedHeadSha,
        labels: [],
      };
      mockClient.getPullRequest = vi.fn().mockImplementation(async () => ({ ...prDetails }));
      mockClient.addLabel = vi.fn().mockImplementation(async ({ label }) => {
        prDetails.labels.push(label);
      });
      mockClient.submitReview = vi.fn().mockResolvedValue({ id: 202 });

      // --- PHASE 5: Reviewer submits formal APPROVE decision on reworked head ---
      const approvedAt = new Date("2026-10-30T16:00:00.000Z").toISOString();
      const approveVerdict: ReviewVerdict = {
        outcome: "approve",
        at: approvedAt,
        headSha: reworkedHeadSha,
      };

      // Before propagation runs: marker is missing -> staleMarker alert triggers
      let markerAlert = staleMarkerSince({
        verdict: approveVerdict,
        marker: { hasMarker: false },
        prStatus: "open",
        currentHeadSha: reworkedHeadSha,
      });
      expect(markerAlert).toBe(approvedAt);
      activeSignals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Task", metric: "staleMarkerMs", since: markerAlert! }],
        thresholds,
        now,
      );
      expect(activeSignals).toHaveLength(1);
      expect(activeSignals[0].metric).toBe("staleMarkerMs");

      // --- PHASE 6: Native PR approval propagation runs ---
      const approvalResult = await propagateReviewApprovalToPullRequest(
        { db, client: mockClient, tokenProvider: vi.fn().mockResolvedValue("gh-token") },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          headSha: reworkedHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT #${pullRequestNumber}: APPROVE (head ${reworkedHeadSha.slice(0, 7)})`,
        },
      );
      expect(approvalResult.success).toBe(true);
      expect(approvalResult.action).toBe("propagated");
      expect(approvalResult.labelAdded).toBe(true);
      expect(approvalResult.reviewSubmitted).toBe(true);
      expect(mockClient.addLabel).toHaveBeenCalledWith({
        repository,
        number: pullRequestNumber,
        label: REVIEW_APPROVED_LABEL,
        token: "gh-token",
      });

      // --- PHASE 7: staleMarker alert recovers and clears ---
      markerAlert = staleMarkerSince({
        verdict: approveVerdict,
        marker: {
          hasMarker: true,
          markedAt: new Date("2026-10-30T16:01:00.000Z").toISOString(),
          markerHeadSha: reworkedHeadSha,
        },
        prStatus: "open",
        currentHeadSha: reworkedHeadSha,
      });
      expect(markerAlert).toBeNull(); // Cleared!

      // --- PHASE 8: Duplicate sweep / decision occurs -> idempotent no-op ---
      const duplicateResult = await propagateReviewApprovalToPullRequest(
        { db, client: mockClient, tokenProvider: vi.fn().mockResolvedValue("gh-token") },
        {
          companyId,
          issueId,
          repository,
          number: pullRequestNumber,
          headSha: reworkedHeadSha,
          decisionOutcome: "approved",
          verdictBody: `VERDICT #${pullRequestNumber}: APPROVE (head ${reworkedHeadSha.slice(0, 7)})`,
        },
      );
      expect(duplicateResult.success).toBe(true);
      expect(duplicateResult.action).toBe("noop");
      expect(duplicateResult.reason).toBe("already_labeled");

      // --- PHASE 9: Auto-merge is pending -> if merge stalls, stalledMerge alert triggers ---
      let mergeAlert = stalledMergeSince({
        approvedAt,
        prStatus: "open",
        isMerged: false,
      });
      expect(mergeAlert).toBe(approvedAt);
      activeSignals = buildDevflowSignals(
        [{ companyId, subjectId: issueId, subjectKind: "issue", title: "Task", metric: "stalledMergeMs", since: mergeAlert! }],
        thresholds,
        now,
      );
      expect(activeSignals).toHaveLength(1);
      expect(activeSignals[0].metric).toBe("stalledMergeMs");

      // --- PHASE 10: PR merges via native GitHub auto-merge -> stalledMerge alert clears ---
      mergeAlert = stalledMergeSince({
        approvedAt,
        prStatus: "merged",
        isMerged: true,
      });
      expect(mergeAlert).toBeNull(); // Cleared!

      // All alerts clear: DEVFLOW pipeline healthy
      const finalSignals = buildDevflowSignals([], thresholds, now);
      expect(finalSignals).toHaveLength(0);
    });
  });
});
