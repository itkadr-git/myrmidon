import { describe, expect, it, vi } from "vitest";
import type { PullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import {
  assertIssueDonePullRequestsSettled,
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