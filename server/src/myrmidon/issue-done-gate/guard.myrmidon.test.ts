import { describe, expect, it, vi } from "vitest";
import type { PullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import {
  assertIssueDonePullRequestsSettled,
  assertStoredIssueDonePullRequestsSettled,
  inspectIssueDonePullRequests,
  ISSUE_DONE_PULL_REQUEST_GATE,
} from "./guard.js";
import { findApprovalPendingMergePullRequest, type LiveOpenPullRequestLookup } from "../review-stage-recovery/pre-merge-approval.js";

const issueId = "issue-1";
const companyId = "company-1";

function product(input: {
  id: string;
  number: number;
  status?: string;
  replacement?: string;
  metadata?: Record<string, unknown>;
}) {
  return {
    id: input.id,
    companyId,
    issueId,
    type: "pull_request",
    status: input.status ?? "open",
    url: `https://github.com/acme/project/pull/${input.number}`,
    metadata: {
      repo: "acme/project",
      number: input.number,
      ...(input.replacement ? { replacementPullRequestUrl: input.replacement } : {}),
      ...(input.metadata ?? {}),
    },
  };
}

function fakeDb(products: ReturnType<typeof product>[]) {
  const where = vi.fn(async () => products);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as never;
}

function resolver(
  states: Record<number, "open" | "draft" | "merged" | "closed" | "unknown" | {
    state: "open" | "draft" | "merged" | "closed" | "unknown";
    baseRef?: string | null;
    defaultBranch?: string | null;
    mergeCommitSha?: string | null;
    mergeCommitReachable?: boolean;
  }>,
): PullRequestMergeDetailsResolver {
  return vi.fn<PullRequestMergeDetailsResolver>(async (_companyId, reference) => {
    const raw = states[reference.number] ?? "unknown";
    const conf = typeof raw === "string" ? { state: raw } : raw;
    const state = conf.state;
    return {
      state: state === "merged" ? "merged" : state === "unknown" ? "unknown" : "open",
      workProductState: state === "unknown" ? undefined : state,
      headRef: null,
      headSha: null,
      baseRef: conf.baseRef ?? null,
      defaultBranch: conf.defaultBranch ?? "main",
      mergeCommitSha: conf.mergeCommitSha ?? null,
      mergeCommitReachable: conf.mergeCommitReachable,
    };
  });
}

describe("issue done pull-request gate", () => {
  it("allows PATCH done to use live merged facts when the stored work product is stale", async () => {
    const db = fakeDb([product({ id: "wp-live", number: 91, status: "open" })]);
    const resolve = resolver({ 91: "merged" });
    const snapshot = await inspectIssueDonePullRequests(db, companyId, issueId, resolve);

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
    expect(() => assertStoredIssueDonePullRequestsSettled([product({ id: "wp-live", number: 91, status: "open" })])).toThrowError(/Cannot mark this task done until/);
  });

  it("does not accept a mixed stored set until every non-closed PR is settled", () => {
    const merged = product({ id: "wp-merged", number: 92, status: "merged" });
    const closed = product({ id: "wp-closed", number: 93, status: "closed" });
    const open = product({ id: "wp-open", number: 94, status: "open" });
    expect(() => assertStoredIssueDonePullRequestsSettled([merged, closed])).not.toThrow();
    expect(() => assertStoredIssueDonePullRequestsSettled([merged, closed, open])).toThrowError(/Cannot mark this task done until/);
    expect(() => assertStoredIssueDonePullRequestsSettled([closed])).toThrowError(/Cannot mark this task done until/);
  });

  it("does not treat non-PR work products as blocking a done issue", () => {
    expect(() => assertStoredIssueDonePullRequestsSettled([
      { ...product({ id: "wp-doc", number: 94, status: "open" }), type: "document" },
    ])).not.toThrow();
  });

  it("uses live merged facts through transaction validation when stored status is stale", async () => {
    const { assertIssueDoneSnapshotUnchanged } = await import("./guard.js");
    const staleProduct = product({ id: "wp-merged-now", number: 95, status: "open" });
    const snapshot = await inspectIssueDonePullRequests(fakeDb([staleProduct]), companyId, issueId, resolver({ 95: "open" }));
    const liveSnapshot = await inspectIssueDonePullRequests(fakeDb([staleProduct]), companyId, issueId, resolver({
      95: { state: "merged", baseRef: "main", defaultBranch: "main", mergeCommitSha: "abc123", mergeCommitReachable: true },
    }));
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(async () => [{ companyId }]) })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(async () => [{
          ...product({ id: "wp-merged-now", number: 95, status: "merged" }),
          metadata: {
            repo: "acme/project",
            number: 95,
            state: "merged",
            draft: false,
            baseRef: "main",
            defaultBranch: "main",
            mergeCommitSha: "abc123",
            mergeCommitReachable: true,
          },
        }]) })) }),
    } as never;
    await expect(assertIssueDoneSnapshotUnchanged(tx, companyId, issueId, snapshot, liveSnapshot)).resolves.toBeUndefined();
  });

  it.each(["open", "draft", "unknown"] as const)("blocks a %s PR with a stable retryable error", async (state) => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 })]),
      companyId,
      issueId,
      resolver({ 12: state }),
    );
    try {
      assertIssueDonePullRequestsSettled(snapshot);
      throw new Error("Expected the completion gate to block");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        details: {
          code: ISSUE_DONE_PULL_REQUEST_GATE,
          pullRequestUrl: "https://github.com/acme/project/pull/12",
          retryable: true,
        },
      });
    }
  });

  it("says the board has no repository access when the PR cannot be read for lack of rights", async () => {
    const denied = vi.fn<PullRequestMergeDetailsResolver>(async () => ({
      state: "unknown",
      access: "denied",
      headRef: null,
      headSha: null,
    }));
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 })]),
      companyId,
      issueId,
      denied,
    );
    try {
      assertIssueDonePullRequestsSettled(snapshot);
      throw new Error("Expected the completion gate to block");
    } catch (error) {
      expect(error).toMatchObject({
        status: 409,
        message: "Не удаётся прочитать PR https://github.com/acme/project/pull/12: у доски нет доступа к репозиторию acme/project (настройте GitHub App/PAT)",
        details: {
          code: ISSUE_DONE_PULL_REQUEST_GATE,
          reason: "repository_access_unavailable",
          repository: "acme/project",
          pullRequestUrl: "https://github.com/acme/project/pull/12",
          retryable: true,
        },
      });
    }
  });

  it("keeps the generic message for an unknown PR state without an access problem", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 })]),
      companyId,
      issueId,
      resolver({ 12: "unknown" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).toThrow(/Cannot mark this task done until/);
  });

  it("returns a retryable gate conflict if the issue company changed during validation", async () => {
    const { assertIssueDoneSnapshotUnchanged } = await import("./guard.js");
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 })]), companyId, issueId,
      resolver({ 12: "merged" }),
    );
    const currentWhere = vi.fn(async () => [{ companyId: "other-company" }]);
    const currentQuery = vi.fn(() => ({ from: vi.fn(() => ({ where: currentWhere })) }));
    const productQuery = vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(async () => []) })) }));
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn()
        .mockReturnValueOnce(currentQuery())
        .mockReturnValueOnce(productQuery()),
    } as never;
    await expect(assertIssueDoneSnapshotUnchanged(tx, companyId, issueId, snapshot)).rejects.toMatchObject({
      status: 409,
      details: { code: ISSUE_DONE_PULL_REQUEST_GATE, retryable: true },
    });
  });

  it("allows only verified merged PRs", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 })]),
      companyId,
      issueId,
      resolver({ 12: "merged" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("allows a closed PR only when its explicit replacement is verified merged", async () => {
    const oldPr = "https://github.com/acme/project/pull/12";
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12, replacement: "https://github.com/acme/project/pull/13" })]),
      companyId,
      issueId,
      resolver({ 12: "closed", 13: "merged" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();

    const invalid = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12, replacement: "https://github.com/acme/project/pull/13" })]),
      companyId,
      issueId,
      resolver({ 12: "closed", 13: "open" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(invalid)).toThrow(oldPr);
  });

  it("evaluates every linked PR", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-1", number: 12 }), product({ id: "wp-2", number: 14 })]),
      companyId,
      issueId,
      resolver({ 12: "merged", 14: "open" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).toThrow("/pull/14");
  });

  it("allows done when a mixed set contains a closed PR and another linked PR is merged", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([
        product({ id: "wp-1", number: 12 }),
        product({ id: "wp-2", number: 14 }),
      ]),
      companyId,
      issueId,
      resolver({ 12: "merged", 14: "closed" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("blocks done when all linked PRs in a set are closed without any merged PR", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([
        product({ id: "wp-1", number: 12 }),
        product({ id: "wp-2", number: 14 }),
      ]),
      companyId,
      issueId,
      resolver({ 12: "closed", 14: "closed" }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).toThrow("/pull/12");
  });

  // OPE-10815: PR merged into dead base branch where merge commit is not reachable from main or rel/*
  it("blocks done when a PR is merged into a dead base branch and merge commit is unreachable (OPE-10815)", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-stacked", number: 1962 })]),
      companyId,
      issueId,
      resolver({
        1962: {
          state: "merged",
          baseRef: "bot/OPE-9262",
          defaultBranch: "main",
          mergeCommitSha: "28d9fbb69424c2ca4adbe3122bca5e16cc81209e",
          mergeCommitReachable: false,
        },
      }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).toThrowError(
      /Cannot mark this task done: PR .* was merged into bot\/OPE-9262, but its merge commit is not reachable from main or rel\/\*/,
    );
  });

  it("allows done when a PR is merged into a non-main base but its merge commit is reachable from main (OPE-10815)", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-stacked-ok", number: 1963 })]),
      companyId,
      issueId,
      resolver({
        1963: {
          state: "merged",
          baseRef: "bot/OPE-9262",
          defaultBranch: "main",
          mergeCommitSha: "571c9a7941",
          mergeCommitReachable: true,
        },
      }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("allows done when a PR is merged into a rel/* branch (OPE-10815)", async () => {
    const snapshot = await inspectIssueDonePullRequests(
      fakeDb([product({ id: "wp-rel", number: 1964 })]),
      companyId,
      issueId,
      resolver({
        1964: {
          state: "merged",
          baseRef: "rel/1.6.6",
          defaultBranch: "main",
          mergeCommitSha: "abc1234",
        },
      }),
    );
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("blocks done in assertStoredIssueDonePullRequestsSettled when stored metadata indicates mergeCommitReachable is false (OPE-10815)", () => {
    const unreachablePr = product({
      id: "wp-stored-unreachable",
      number: 1962,
      status: "merged",
      metadata: {
        baseRef: "bot/OPE-9262",
        defaultBranch: "main",
        mergeCommitReachable: false,
      },
    });
    expect(() => assertStoredIssueDonePullRequestsSettled([unreachablePr])).toThrowError(
      /Cannot mark this task done: PR .* was merged into bot\/OPE-9262, but its merge commit is not reachable from main or rel\/\*/,
    );
  });

  // myrmidon(OPE-12879): the six 12.11 closings had NO stored facts at all —
  // no work product, no external object, no matching verdict comment. The
  // gate must ask GitHub live (branch bot/<KEY> or the identifier in the PR
  // title) and refuse done with the live PR link.
  function queueDb(answers: unknown[][]) {
    let call = 0;
    const where = vi.fn(async () => answers[Math.min(call++, answers.length - 1)] ?? []);
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    return { select } as never;
  }

  it("blocks done when the open PR was never linked but GitHub shows it on bot/<KEY> (OPE-12879)", async () => {
    // Query order: guard products; findApproval (issue products, identifier,
    // company products, external objects, comments, repo external, repo products).
    const db = queueDb([
      [],
      [],
      [{ identifier: "OPE-12879" }],
      [],
      [],
      [],
      [{ data: { owner: "itkadr-git", repo: "myrmidon" } }],
      [],
    ]);
    const liveLookup: LiveOpenPullRequestLookup = async (_companyId, repository) =>
      repository === "itkadr-git/myrmidon"
        ? [{
            number: 2992,
            headSha: "cafe1234",
            draft: false,
            title: "OPE-12859 fix",
            url: "https://github.com/itkadr-git/myrmidon/pull/2992",
            authorLogin: "bot",
            baseRef: "main",
            headRef: "bot/OPE-12879",
          }]
        : [];
    const snapshot = await inspectIssueDonePullRequests(db, companyId, issueId, resolver({}), liveLookup);
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).toThrowError(
      /Cannot mark this task done until .*pull\/2992.* is merged/,
    );
  });

  it("allows done when the live GitHub lane answers nothing (OPE-12879)", async () => {
    const db = queueDb([
      [],
      [],
      [{ identifier: "OPE-12879" }],
      [],
      [],
      [],
      [],
      [],
    ]);
    const liveLookup: LiveOpenPullRequestLookup = async () => [];
    const snapshot = await inspectIssueDonePullRequests(db, companyId, issueId, resolver({}), liveLookup);
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("allows done when the live GitHub lane fails: no invented blockers (OPE-12879)", async () => {
    const db = queueDb([
      [],
      [],
      [{ identifier: "OPE-12879" }],
      [],
      [],
      [],
      [],
      [],
    ]);
    const liveLookup: LiveOpenPullRequestLookup = async () => {
      throw new Error("github down");
    };
    const snapshot = await inspectIssueDonePullRequests(db, companyId, issueId, resolver({}), liveLookup);
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  it("does not duplicate a stored hit found again by the live lane; live merged state wins (OPE-12879)", async () => {
    const stored = product({ id: "wp-linked", number: 3001, status: "open" });
    // q1: guard products (open) -> findApproval must NOT run? some(merged)=false so it runs;
    // q2 returns the same open product -> findApproval returns it -> dedupe keeps one entry.
    const db = queueDb([[stored]]);
    const liveLookup: LiveOpenPullRequestLookup = async () => [
      {
        number: 3001,
        headSha: "beef1234",
        draft: false,
        title: "linked pr",
        url: "https://github.com/acme/project/pull/3001",
        authorLogin: "bot",
        baseRef: "main",
        headRef: "bot/OPE-12879",
      },
    ];
    const snapshot = await inspectIssueDonePullRequests(db, companyId, issueId, resolver({ 3001: "merged" }), liveLookup);
    expect(snapshot).toHaveLength(1);
    expect(() => assertIssueDonePullRequestsSettled(snapshot)).not.toThrow();
  });

  // Recovery / external-transaction done path (services/issues.ts): the caller
  // cannot resolve live provider facts inside a foreign transaction, so it
  // validates stored products with assertStoredIssueDonePullRequestsSettled and
  // extends the set with whatever findApprovalPendingMergePullRequest returns.
  it("recovery path refuses done when stored facts are empty but an unlinked open PR exists (OPE-12879)", async () => {
    // findApprovalPendingMergePullRequest query order: issue products, issue
    // row (identifier), company products, external objects, comments, then the
    // company-repository list (external objects, products) for the live lane.
    const db = queueDb([
      [],                                                    // issue products
      [{ identifier: "OPE-12879" }],                         // issue row
      [],                                                    // company products
      [],                                                    // external objects
      [],                                                    // comments
      [{ data: { owner: "itkadr-git", repo: "myrmidon" } }], // repo list: external objects
      [],                                                    // repo list: products
    ]);
    const liveLookup: LiveOpenPullRequestLookup = async (_companyId, repository) =>
      repository === "itkadr-git/myrmidon"
        ? [{
            number: 2936,
            headSha: "feed1234",
            draft: false,
            title: "OPE-12720 fix",
            url: "https://github.com/itkadr-git/myrmidon/pull/2936",
            authorLogin: "bot",
            baseRef: "main",
            headRef: "bot/OPE-12879",
          }]
        : [];
    const unlinkedOpen = await findApprovalPendingMergePullRequest(db, companyId, issueId, liveLookup);
    expect(unlinkedOpen?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/2936");
    // Exactly the composition services/issues.ts validates on the recovery path:
    expect(() => assertStoredIssueDonePullRequestsSettled([
      {
        id: unlinkedOpen!.id,
        companyId,
        type: "pull_request" as const,
        status: "open" as const,
        url: unlinkedOpen!.url,
        metadata: null,
      },
    ])).toThrowError(/Cannot mark this task done until .*pull\/2936.* is merged/);
  });

  it("recovery path allows done when the live lane proves no open PR (OPE-12879)", async () => {
    const db = queueDb([
      [], [], [{ identifier: "OPE-12879" }], [], [], [], [],
    ]);
    const liveLookup: LiveOpenPullRequestLookup = async () => [];
    const unlinkedOpen = await findApprovalPendingMergePullRequest(db, companyId, issueId, liveLookup);
    expect(unlinkedOpen).toBeNull();
    expect(() => assertStoredIssueDonePullRequestsSettled([])).not.toThrow();
  });
});