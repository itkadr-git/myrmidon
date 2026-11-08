// myrmidon(OPE-11767): the GitHub half of the board-side merge — the pull
// request facts, the verdict of the required check (latest run per name), the
// conditional GETs, the merge call pinned to the approved head, and the
// identity the write token comes from.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetGitHubRateLimitForTests, setGitHubRateLimitForTests } from "../../services/github-rate-limit.js";

const mocks = vi.hoisted(() => ({
  mint: vi.fn(),
  readSettings: vi.fn(),
  getByName: vi.fn(),
  resolveSecretValue: vi.fn(),
}));

vi.mock("../../services/secrets.js", () => ({
  secretService: () => ({ getByName: mocks.getByName, resolveSecretValue: mocks.resolveSecretValue }),
}));
vi.mock("../../services/git-credentials.js", () => ({
  DEFAULT_GITHUB_TOKEN_SECRET_NAMES: ["GITHUB_TOKEN", "GH_TOKEN", "PAPERCLIP_GITHUB_TOKEN"],
}));
vi.mock("../github-shared-identity/store.js", () => ({
  readGitHubSharedIdentitySettings: mocks.readSettings,
}));
vi.mock("../github-shared-identity/app-token.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../github-shared-identity/app-token.js")>()),
  mintGitHubAppInstallationToken: mocks.mint,
}));

import {
  boardMergeFactsFromPullPayload,
  createGitHubBoardMergeClient,
  requiredCheckVerdict,
  resolveBoardMergeToken,
} from "./github-board-merge.js";

const REPO = "acme/widgets";
const HEAD = "28f15c1be15204153f0e06464842d88875c373f8";
const TOKEN = "ghs_secret_token_value";

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });
}

function pullBody(overrides: Record<string, unknown> = {}) {
  return {
    state: "open",
    merged: false,
    draft: false,
    head: { sha: HEAD },
    base: { ref: "main" },
    mergeable: true,
    mergeable_state: "clean",
    labels: [{ name: "review-approved" }, "plain"],
    ...overrides,
  };
}

function run(id: number, status: string, conclusion: string | null, name = "CI result") {
  return { id, name, status, conclusion };
}

afterEach(() => {
  resetGitHubRateLimitForTests();
  vi.clearAllMocks();
});

describe("pull request facts", () => {
  it("reads the state, head, base, mergeability and labels off the REST payload", () => {
    expect(boardMergeFactsFromPullPayload(pullBody())).toEqual({
      open: true,
      draft: false,
      headSha: HEAD,
      baseRef: "main",
      mergeable: true,
      mergeableState: "clean",
      labels: ["review-approved", "plain"],
    });
    expect(boardMergeFactsFromPullPayload(pullBody({ state: "closed", merged: true })).open).toBe(false);
    expect(boardMergeFactsFromPullPayload(pullBody({ state: "open", merged: true })).open).toBe(false);
    // GitHub still computing mergeability: neither true nor false.
    expect(boardMergeFactsFromPullPayload(pullBody({ mergeable: null, mergeable_state: "unknown" }))).toMatchObject({
      mergeable: null,
      mergeableState: "unknown",
    });
    expect(boardMergeFactsFromPullPayload({})).toMatchObject({ open: false, headSha: null, baseRef: null, labels: [] });
  });
});

describe("the verdict of a required check: the latest run per name", () => {
  it("no run, or only a running one, is pending", () => {
    expect(requiredCheckVerdict([], "CI result")).toBe("pending");
    expect(requiredCheckVerdict([run(3, "in_progress", null)], "CI result")).toBe("pending");
    expect(requiredCheckVerdict([run(3, "queued", null)], "CI result")).toBe("pending");
    expect(requiredCheckVerdict([run(3, "completed", "success", "other check")], "CI result")).toBe("pending");
  });

  it("a completed success is green, any other conclusion is failed", () => {
    expect(requiredCheckVerdict([run(3, "completed", "success")], "CI result")).toBe("success");
    for (const conclusion of ["failure", "timed_out", "action_required", "startup_failure", "neutral"]) {
      expect(requiredCheckVerdict([run(3, "completed", conclusion)], "CI result")).toBe("failed");
    }
  });

  it("the newest run decides, whatever order GitHub lists them in", () => {
    expect(requiredCheckVerdict([run(2, "completed", "success"), run(5, "in_progress", null)], "CI result")).toBe("pending");
    expect(requiredCheckVerdict([run(2, "completed", "failure"), run(5, "completed", "success")], "CI result")).toBe("success");
    expect(requiredCheckVerdict([run(5, "completed", "failure"), run(2, "completed", "success")], "CI result")).toBe("failed");
  });

  it("a cancelled / skipped / stale run is a superseded one, not a verdict", () => {
    // A rerun cancelled the earlier run: the running rerun is what matters.
    expect(requiredCheckVerdict([run(4, "completed", "cancelled"), run(6, "queued", null)], "CI result")).toBe("pending");
    // A label-only run skipped the final check: the real verdict is the run before it.
    expect(requiredCheckVerdict([run(4, "completed", "failure"), run(6, "completed", "skipped")], "CI result")).toBe("failed");
    expect(requiredCheckVerdict([run(4, "completed", "success"), run(6, "completed", "stale")], "CI result")).toBe("success");
    // Only superseded runs: the check has not produced a verdict yet.
    expect(requiredCheckVerdict([run(4, "completed", "cancelled")], "CI result")).toBe("pending");
  });

  it("OPE-10461: a skipped label-event run newer than the real result never decides, in any listing order", () => {
    expect(requiredCheckVerdict([run(4, "completed", "success"), run(6, "completed", "skipped")], "CI result")).toBe("success");
    expect(requiredCheckVerdict([run(6, "completed", "skipped"), run(4, "completed", "success")], "CI result")).toBe("success");
    expect(requiredCheckVerdict([run(4, "completed", "failure"), run(6, "completed", "skipped")], "CI result")).toBe("failed");
    expect(requiredCheckVerdict([run(6, "completed", "skipped"), run(4, "completed", "failure")], "CI result")).toBe("failed");
    // Several skipped runs on top of the real one.
    expect(
      requiredCheckVerdict([run(4, "completed", "success"), run(6, "completed", "skipped"), run(8, "completed", "skipped")], "CI result"),
    ).toBe("success");
    // Nothing but skipped runs: no verdict yet, never green.
    expect(requiredCheckVerdict([run(6, "completed", "skipped")], "CI result")).toBe("pending");
    expect(requiredCheckVerdict([run(6, "completed", "skipped"), run(8, "completed", "skipped")], "CI result")).toBe("pending");
    // A running run behind the skipped one is still the answer.
    expect(requiredCheckVerdict([run(4, "completed", "success"), run(6, "in_progress", null), run(8, "completed", "skipped")], "CI result")).toBe("pending");
    // timed_out is a real outcome, not green.
    expect(requiredCheckVerdict([run(4, "completed", "success"), run(6, "completed", "timed_out"), run(8, "completed", "skipped")], "CI result")).toBe("failed");
  });
});

describe("the client", () => {
  function client(fetchMock: ReturnType<typeof vi.fn>) {
    return createGitHubBoardMergeClient({ fetch: fetchMock as never, tokenProvider: async () => TOKEN });
  }

  it("reads the pull request with the token and replays the cached body on a 304 (no rate limit spent)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pullBody(), { headers: { etag: '"abc"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const board = client(fetchMock);

    const first = await board.readPull({ companyId: "c", repository: REPO, number: 7 });
    expect(first).toMatchObject({ ok: true, facts: { headSha: HEAD, mergeableState: "clean" } });
    const second = await board.readPull({ companyId: "c", repository: REPO, number: 7 });
    expect(second).toEqual(first);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/${REPO}/pulls/7`);
    expect((init as RequestInit).headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect((fetchMock.mock.calls[1]![1] as RequestInit).headers).toMatchObject({ "if-none-match": '"abc"' });
    // The token is never part of what the client returns.
    expect(JSON.stringify(second)).not.toContain(TOKEN);
  });

  it("never guesses: no token, an HTTP error, a rate limit and an unreadable payload are all ok:false", async () => {
    const noToken = createGitHubBoardMergeClient({ fetch: vi.fn() as never, tokenProvider: async () => null });
    expect(await noToken.readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({ ok: false, reason: "no_token" });
    expect(await noToken.merge({ companyId: "c", repository: REPO, number: 7, headSha: HEAD, method: "squash" })).toEqual({
      status: "failed",
      reason: "no_token",
    });

    const missing = vi.fn().mockResolvedValue(json({ message: "Not Found" }, { status: 404 }));
    expect(await client(missing).readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({ ok: false, reason: "http_404" });

    const garbled = vi.fn().mockResolvedValue(new Response("not json", { status: 200 }));
    expect(await client(garbled).readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({
      ok: false,
      reason: "unreadable_payload",
    });

    const offline = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await client(offline).readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({
      ok: false,
      reason: "network_error",
    });

    // The board's global GitHub budget is gone: nothing is requested at all.
    setGitHubRateLimitForTests(Math.floor(Date.now() / 1000) + 600, 0);
    const untouched = vi.fn();
    const limited = client(untouched);
    expect(await limited.readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({ ok: false, reason: "rate_limited" });
    expect(await limited.merge({ companyId: "c", repository: REPO, number: 7, headSha: HEAD, method: "squash" })).toEqual({
      status: "failed",
      reason: "rate_limited",
    });
    expect(untouched).not.toHaveBeenCalled();
  });

  it("reuses the token it resolved and drops it the moment GitHub answers 401", async () => {
    const tokenProvider = vi.fn(async () => TOKEN);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(pullBody()))
      .mockResolvedValueOnce(json({ message: "Bad credentials" }, { status: 401 }))
      .mockResolvedValueOnce(json(pullBody()));
    const board = createGitHubBoardMergeClient({ fetch: fetchMock as never, tokenProvider });
    expect((await board.readPull({ companyId: "c", repository: REPO, number: 7 })).ok).toBe(true);
    expect(await board.readPull({ companyId: "c", repository: REPO, number: 7 })).toEqual({ ok: false, reason: "http_401" });
    expect(tokenProvider).toHaveBeenCalledTimes(1);
    expect((await board.readPull({ companyId: "c", repository: REPO, number: 7 })).ok).toBe(true);
    expect(tokenProvider).toHaveBeenCalledTimes(2);
  });

  it("reads the required check by name with every run of the head, and folds it per name", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json({ check_runs: [run(4, "completed", "cancelled"), run(6, "in_progress", null)] }))
      .mockResolvedValueOnce(json({ check_runs: [run(2, "completed", "success", "hot files review")] }));
    const result = await client(fetchMock).readChecks({
      companyId: "c",
      repository: REPO,
      headSha: HEAD,
      names: ["CI result", "hot files review"],
    });
    expect(result).toEqual({ ok: true, checks: { "CI result": "pending", "hot files review": "success" } });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      `https://api.github.com/repos/${REPO}/commits/${HEAD}/check-runs?check_name=CI%20result&filter=all&per_page=100`,
    );
    expect(fetchMock.mock.calls[1]![0]).toContain("check_name=hot%20files%20review");

    const broken = vi.fn().mockResolvedValue(json({ message: "boom" }, { status: 500 }));
    expect(await client(broken).readChecks({ companyId: "c", repository: REPO, headSha: HEAD, names: ["CI result"] })).toEqual({
      ok: false,
      reason: "http_500",
    });
    const noList = vi.fn().mockResolvedValue(json({ total_count: 0 }));
    expect(await client(noList).readChecks({ companyId: "c", repository: REPO, headSha: HEAD, names: ["CI result"] })).toEqual({
      ok: false,
      reason: "unreadable_payload",
    });
  });

  it("merges pinned to the approved head with the configured method and maps GitHub's answers", async () => {
    const merged = vi.fn().mockResolvedValue(json({ merged: true, sha: "f".repeat(40) }));
    expect(await client(merged).merge({ companyId: "c", repository: REPO, number: 7, headSha: HEAD, method: "squash" })).toEqual({
      status: "merged",
      sha: "f".repeat(40),
    });
    const [url, init] = merged.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/${REPO}/pulls/7/merge`);
    expect((init as RequestInit).method).toBe("PUT");
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ sha: HEAD, merge_method: "squash" });

    const answer = async (status: number, body: unknown = { message: "x" }) =>
      client(vi.fn().mockResolvedValue(json(body, { status }))).merge({
        companyId: "c",
        repository: REPO,
        number: 7,
        headSha: HEAD,
        method: "squash",
      });
    expect(await answer(409)).toEqual({ status: "head_moved" });
    expect(await answer(405)).toEqual({ status: "refused", httpStatus: 405 });
    expect(await answer(422)).toEqual({ status: "refused", httpStatus: 422 });
    expect(await answer(403)).toEqual({ status: "failed", reason: "http_403" });
    expect(await answer(500)).toEqual({ status: "failed", reason: "http_500" });
    // A 200 that says it did not merge is not a merge.
    expect(await answer(200, { merged: false, message: "no" })).toEqual({ status: "refused", httpStatus: 200 });
    const offline = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    expect(await client(offline).merge({ companyId: "c", repository: REPO, number: 7, headSha: HEAD, method: "squash" })).toEqual({
      status: "failed",
      reason: "network_error",
    });
  });

  it("puts the review marker through the issues labels endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json([{ name: "review-approved" }]));
    expect(await client(fetchMock).addApprovedLabel({ companyId: "c", repository: REPO, number: 7, label: "review-approved" })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe(`https://api.github.com/repos/${REPO}/issues/7/labels`);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ labels: ["review-approved"] });

    const refused = vi.fn().mockResolvedValue(json({ message: "no" }, { status: 403 }));
    expect(await client(refused).addApprovedLabel({ companyId: "c", repository: REPO, number: 7, label: "review-approved" })).toBe(false);
  });
});

describe("the write identity", () => {
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ id: "key-secret" }] }) }),
  } as never;

  function appEntry(overrides: Record<string, unknown> = {}) {
    return {
      id: "app-1",
      name: "Myrmidon — vm-core",
      appId: "5206456",
      privateKeySecretId: "key-secret",
      installationId: null,
      slug: null,
      roles: [],
      agentIds: [],
      allowedRepos: ["acme/widgets"],
      permissions: {
        actions: "read",
        checks: "read",
        contents: "write",
        deployments: "none",
        environments: "none",
        issues: "none",
        pull_requests: "write",
        workflows: "write",
      },
      ...overrides,
    };
  }

  function sharedIdentity(apps: unknown[], enabled = true) {
    mocks.readSettings.mockResolvedValue({ version: 1, enabled, apps, pats: [], commitEmailDomain: null });
  }

  beforeEach(() => {
    mocks.resolveSecretValue.mockResolvedValue("PEM-KEY");
    mocks.mint.mockResolvedValue({ token: TOKEN, expiresAt: "2026-11-06T09:00:00Z", installationId: "1", reused: false });
    mocks.getByName.mockResolvedValue(null);
  });

  it("mints a token from the App that serves exactly this repository, narrowed to contents + pull requests write", async () => {
    sharedIdentity([appEntry()]);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBe(TOKEN);
    expect(mocks.mint).toHaveBeenCalledWith(
      expect.objectContaining({
        appId: "5206456",
        privateKeyPem: "PEM-KEY",
        repository: REPO,
        // The entry also allows workflows write and actions read: the board asks for none of that.
        permissions: { contents: "write", pull_requests: "write", checks: "read" },
      }),
    );
  });

  it("an App entry that does not grant write on contents and pull requests cannot merge", async () => {
    sharedIdentity([appEntry({ permissions: { ...appEntry().permissions, contents: "read" } })]);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBeNull();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("two Apps for one repository are ambiguous: nothing is minted, never a silent pick", async () => {
    sharedIdentity([appEntry(), appEntry({ id: "app-2" })]);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBeNull();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("a failed mint is no token", async () => {
    sharedIdentity([appEntry()]);
    mocks.mint.mockRejectedValue(new Error("GitHub answered HTTP 422"));
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBeNull();
  });

  it("falls back to a company secret by name when no App serves the repository, and to nothing otherwise", async () => {
    sharedIdentity([appEntry({ allowedRepos: ["acme/other"] })]);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBeNull();

    mocks.getByName.mockImplementation(async (_company: string, name: string) => (name === "GH_TOKEN" ? { id: "gh-secret" } : null));
    mocks.resolveSecretValue.mockResolvedValue(`  ${TOKEN}  `);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBe(TOKEN);
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("a switched-off shared identity serves nobody", async () => {
    sharedIdentity([appEntry()], false);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: REPO })).toBeNull();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("an unreadable repository name has no identity", async () => {
    sharedIdentity([appEntry()]);
    expect(await resolveBoardMergeToken({ db, companyId: "c", repository: "not a repo" })).toBeNull();
  });
});
