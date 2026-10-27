import { describe, expect, it, vi } from "vitest";
import type { PullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import {
  assertIssueDonePullRequestsSettled,
  assertStoredIssueDonePullRequestsSettled,
  inspectIssueDonePullRequests,
  ISSUE_DONE_PULL_REQUEST_GATE,
} from "./guard.js";

const issueId = "issue-1";
const companyId = "company-1";

function product(input: { id: string; number: number; status?: string; replacement?: string }) {
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
    },
  };
}

function fakeDb(products: ReturnType<typeof product>[]) {
  const where = vi.fn(async () => products);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { select } as never;
}

function resolver(states: Record<number, "open" | "draft" | "merged" | "closed" | "unknown">): PullRequestMergeDetailsResolver {
  return vi.fn<PullRequestMergeDetailsResolver>(async (_companyId, reference) => {
    const state = states[reference.number] ?? "unknown";
    return {
      state: state === "merged" ? "merged" : state === "unknown" ? "unknown" : "open",
      workProductState: state === "unknown" ? undefined : state,
      headRef: null,
      headSha: null,
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
    const liveSnapshot = await inspectIssueDonePullRequests(fakeDb([staleProduct]), companyId, issueId, resolver({ 95: "merged" }));
    const tx = {
      execute: vi.fn(async () => undefined),
      select: vi.fn()
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(async () => [{ companyId }]) })) })
        .mockReturnValueOnce({ from: vi.fn(() => ({ where: vi.fn(async () => [product({ id: "wp-merged-now", number: 95, status: "merged" })]) })) }),
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
});