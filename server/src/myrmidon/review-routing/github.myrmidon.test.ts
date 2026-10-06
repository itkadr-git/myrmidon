// myrmidon(REVIEW-ROUTING): the GitHub head resolver — CI verdict parsing,
// review-decision folding, the head-keyed TTL cache, and the rule that every
// read trouble surfaces as "unknown" instead of a guess (a GitHub outage must
// never create or close board tasks).

import { describe, expect, it, vi } from "vitest";
import {
  createGitHubPrHeadResolver,
  pullRequestCiStateFromStatusPayload,
  pullRequestReviewDecisionFromValue,
} from "./github.js";

const COMPANY = "company-1";
const REPO = "acme/widgets";

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as unknown as Response;
}

function prBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    state: "open",
    draft: false,
    number: 7,
    title: "Add routing",
    html_url: "https://github.com/acme/widgets/pull/7",
    head: { sha: "aaaaaaaa" },
    user: { login: "author-a" },
    base: { ref: "main" },
    review_decision: "REVIEW_REQUIRED",
    ...overrides,
  };
}

function resolverFor(
  handler: (url: string) => Response | null,
  options: { now?: () => Date } = {},
) {
  const calls: string[] = [];
  const fetchImpl = vi.fn(async (url: string) => {
    calls.push(url);
    const response = handler(url);
    if (!response) throw new Error("network exploded");
    return response;
  });
  const resolver = createGitHubPrHeadResolver({
    fetch: fetchImpl,
    tokenProvider: async () => "token",
    ...options,
  });
  return { resolver, calls, fetchImpl };
}

describe("CI state parsing", () => {
  it("counts success and a status-less repo as green", () => {
    expect(pullRequestCiStateFromStatusPayload({ state: "success" })).toBe("green");
    expect(pullRequestCiStateFromStatusPayload({ state: "pending", statuses: [] })).toBe("not_green");
    expect(pullRequestCiStateFromStatusPayload({ statuses: [] })).toBe("green");
    expect(pullRequestCiStateFromStatusPayload({ state: "failure" })).toBe("not_green");
    expect(pullRequestCiStateFromStatusPayload({ state: "error" })).toBe("not_green");
    expect(pullRequestCiStateFromStatusPayload({})).toBe("not_green");
  });

  it("folds absent and REVIEW_REQUIRED into no verdict", () => {
    expect(pullRequestReviewDecisionFromValue(undefined)).toBeNull();
    expect(pullRequestReviewDecisionFromValue("REVIEW_REQUIRED")).toBeNull();
    expect(pullRequestReviewDecisionFromValue("approved")).toBe("APPROVED");
    expect(pullRequestReviewDecisionFromValue("CHANGES_REQUESTED")).toBe("CHANGES_REQUESTED");
    expect(pullRequestReviewDecisionFromValue("BLOCKED")).toBe("BLOCKED");
  });
});

describe("resolve", () => {
  it("reads the head: green ci plus the folded review decision", async () => {
    const { resolver } = resolverFor((url) => {
      if (url.includes("/status")) return jsonResponse({ state: "success" });
      return jsonResponse(prBody({ review_decision: "APPROVED" }));
    });
    const head = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(head).toEqual({
      repository: REPO,
      number: 7,
      open: true,
      draft: false,
      headSha: "aaaaaaaa",
      ci: "green",
      reviewDecision: "APPROVED",
      fetchFailed: false,
      title: "Add routing",
      url: "https://github.com/acme/widgets/pull/7",
      authorLogin: "author-a",
      baseRef: "main",
    });
  });

  it("a non-2xx PR read surfaces as fetchFailed, not as a guess", async () => {
    const { resolver } = resolverFor(() => jsonResponse({ message: "rate limited" }, false));
    const head = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(head.fetchFailed).toBe(true);
    expect(head.ci).toBe("unknown");
    expect(head.open).toBe(false);
  });

  it("a thrown fetch surfaces as fetchFailed", async () => {
    const { resolver } = resolverFor(() => null);
    const head = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(head.fetchFailed).toBe(true);
  });

  it("no token: fetchFailed without touching GitHub", async () => {
    const noToken = resolverFor(() => jsonResponse(prBody()));
    const resolver = createGitHubPrHeadResolver({ fetch: noToken.fetchImpl, tokenProvider: async () => null });
    const head = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(head.fetchFailed).toBe(true);
    expect(noToken.fetchImpl).not.toHaveBeenCalled();
  });

  it("a closed PR reads as closed without a status call (TASK-PR-SYNC settles it)", async () => {
    const { resolver, calls } = resolverFor((url) => {
      if (url.includes("/status")) return jsonResponse({ state: "success" });
      return jsonResponse(prBody({ state: "closed" }));
    });
    const head = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(head).toMatchObject({ open: false, fetchFailed: false, ci: "unknown" });
    expect(calls.some((url) => url.includes("/status"))).toBe(false);
  });

  it("caches the status read per head sha inside the TTL and retries after it", async () => {
    let nowMs = 0;
    const { resolver, calls } = resolverFor(
      (url) => (url.includes("/status") ? jsonResponse({ state: "pending" }) : jsonResponse(prBody())),
      { now: () => new Date(1_700_000_000_000 + nowMs) },
    );
    await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(calls.filter((url) => url.includes("/status"))).toHaveLength(1);
    // A pushed head is a different key: the fresh sha gets a fresh read.
    nowMs = 10_000;
    const moved = resolverFor((url) =>
      url.includes("/status") ? jsonResponse({ state: "success" }) : jsonResponse(prBody({ head: { sha: "bbbbbbbb" } })),
    );
    await moved.resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(moved.calls.filter((url) => url.includes("/status"))).toHaveLength(1);
    // The same head re-read after the TTL.
    nowMs = 301_000;
    await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(calls.filter((url) => url.includes("/status"))).toHaveLength(2);
  });

  it("a failed status read is never cached — the next pass retries", async () => {
    let fail = true;
    const { resolver, calls } = resolverFor((url) => {
      if (url.includes("/status")) return fail ? jsonResponse({}, false) : jsonResponse({ state: "success" });
      return jsonResponse(prBody());
    });
    const first = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(first).toMatchObject({ ci: "unknown", fetchFailed: true });
    fail = false;
    const second = await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(second).toMatchObject({ ci: "green", fetchFailed: false });
    expect(calls.filter((url) => url.includes("/status"))).toHaveLength(2);
  });

  it("resetCache forgets the head reads", async () => {
    const { resolver, calls } = resolverFor((url) =>
      url.includes("/status") ? jsonResponse({ state: "success" }) : jsonResponse(prBody()),
    );
    await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    resolver.resetCache();
    await resolver.resolve({ companyId: COMPANY, repository: REPO, number: 7 });
    expect(calls.filter((url) => url.includes("/status"))).toHaveLength(2);
  });
});

describe("listOpenPullRequests", () => {
  it("maps the list and skips entries without a usable number or head", async () => {
    const { resolver } = resolverFor((url) =>
      url.includes("/pulls?state=open")
        ? jsonResponse([
            prBody({ number: 7 }),
            prBody({ number: 8, head: { sha: "bbbbbbbb" } }),
            { number: 9, head: { sha: "" } },
            { head: { sha: "cccccccc" } },
          ])
        : jsonResponse(prBody()),
    );
    const listed = await resolver.listOpenPullRequests({ companyId: COMPANY, repository: REPO });
    expect(listed).toEqual([
      expect.objectContaining({ number: 7, headSha: "aaaaaaaa" }),
      expect.objectContaining({ number: 8, headSha: "bbbbbbbb" }),
    ]);
  });

  it("an outage or a missing token answers with no candidates", async () => {
    const failing = resolverFor(() => jsonResponse([], false));
    expect(await failing.resolver.listOpenPullRequests({ companyId: COMPANY, repository: REPO })).toEqual([]);

    const noToken = resolverFor(() => jsonResponse(prBody()));
    const resolver = createGitHubPrHeadResolver({ fetch: noToken.fetchImpl, tokenProvider: async () => null });
    expect(await resolver.listOpenPullRequests({ companyId: COMPANY, repository: REPO })).toEqual([]);
    expect(noToken.fetchImpl).not.toHaveBeenCalled();
  });
});
