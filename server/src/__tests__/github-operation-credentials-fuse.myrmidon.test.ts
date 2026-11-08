import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { generateKeyPairSync } from "node:crypto";

// myrmidon(OPE-12446): the credentials broker must not spend the GitHub App
// installation budget (5000 requests/hour) on repeated requests from one run.
// Three layers pin that budget:
//   1. the single-flight resolution — 100 concurrent and sequential requests
//      for the same (run, repository) resolve the credential once;
//   2. the single-flight mint inside app-token.ts — concurrent cache misses for
//      the same (App, repository, permission set) join one POST to GitHub
//      (`access_tokens`), so the `broker` counter grows once;
//   3. the per-run fuse — a client that ignores the token it already holds and
//      keeps polling gets HTTP 429 instead of draining the installation budget.

vi.mock("../services/run-identity.js", () => ({
  captureRunIdentity: vi.fn(),
}));

vi.mock("../services/github-credential-policy.js", () => ({
  allowsGitHubCredentialExport: vi.fn(),
}));

vi.mock("../services/git-credentials.js", () => ({
  resolveManagedGitHubCredential: vi.fn(),
  buildGitAuthInvocation: vi.fn((cred) => ({
    configArgs: [],
    env: { GH_TOKEN: cred.token },
    source: cred.source ?? "personal",
    secretName: null,
  })),
}));

const applyGitHubAppIdentity = vi.fn();
vi.mock("../myrmidon/github-shared-identity/broker.js", () => ({
  applyGitHubAppIdentity: (...args: unknown[]) => applyGitHubAppIdentity(...args),
}));

// The app-token module records `broker` GitHub-budget traffic at the real mint
// (recordGitHubRequest on POST /app/installations/.../access_tokens); a stubbed
// rate-limit module keeps the assertion on mint counts, not on real buckets.
const recordGitHubRequest = vi.hoisted(() => vi.fn());
vi.mock("../services/github-rate-limit.js", () => ({
  recordGitHubRequest,
}));

import { captureRunIdentity } from "../services/run-identity.js";
import { allowsGitHubCredentialExport } from "../services/github-credential-policy.js";
import { resolveManagedGitHubCredential } from "../services/git-credentials.js";
import {
  connectionGrants,
  agents,
  companySecrets,
  instanceSettings,
  toolConnections,
} from "@myrmidon/db";
import {
  clearGitHubOperationCredentialCache,
  resolveGitHubOperationCredentials,
} from "../services/github-operation-credentials.js";
import {
  mintGitHubAppInstallationToken,
  resetGitHubAppTokenCacheForTests,
} from "../myrmidon/github-shared-identity/app-token.js";

// A real RSA private key: the mint signs the installation JWT with it, so a
// fake string would fail inside `createPrivateKey` before the (stubbed) GitHub
// fetch is ever reached.
const { privateKey: appPrivateKeyPem } = (() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString() };
})();

describe("github credentials broker budget (OPE-12446)", () => {
  // The freshness re-check of a cached credential walks four tables by the
  // first selected column; a dummy without a `select` made every check throw,
  // the cache looked dead and every request re-resolved the credential.
  const dummyDb: any = {
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      }),
    }),
    select: vi.fn().mockImplementation((...selections: any[]) => {
      const first = Object.values(Object.assign({}, ...selections))[0];
      let rows: any[] = [];
      if (first === toolConnections.enabled) rows = [{ enabled: true, status: "active" }];
      else if (first === connectionGrants.status) rows = [{ status: "active" }];
      else if (first === agents.role) rows = [{ role: "agent", status: "active" }];
      else if (first === companySecrets.id) rows = [{ id: "secret-1" }];
      else if (first === instanceSettings.general) rows = []; // no settings row → shared identity off
      return {
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(rows),
        }),
      };
    }),
  };

  const baseInput = {
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-1",
    repository: "owner/repo-a",
  };

  function stubHappyPath() {
    vi.mocked(captureRunIdentity).mockResolvedValue({
      run: { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running" } as any,
      context: {
        id: "ctx-1",
        companyId: "company-1",
        runId: "run-1",
        revision: 1,
        responsibleUserId: "user-1",
      } as any,
    });
    vi.mocked(allowsGitHubCredentialExport).mockResolvedValue({ allowed: true });
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({
      credential: {
        identitySource: "personal",
        githubIdentity: { login: "user-1" },
        connectionId: "conn-1",
        grantId: "grant-1",
        token: "token-user-1",
        source: "managed_connection",
        secretName: null,
      } as any,
    } as any);
  }

  beforeEach(() => {
    clearGitHubOperationCredentialCache();
    resetGitHubAppTokenCacheForTests();
    vi.clearAllMocks();
    stubHappyPath();
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("100 sequential requests of one run to one repository resolve the credential once", async () => {
    // The fuse counts every request before the cache short-circuit by design,
    // so a 100-request probe must raise its own limit — the assertion here is
    // the single resolution, not the fuse (the fuse has its own tests below).
    vi.stubEnv("MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE", "1000");
    for (let index = 0; index < 100; index += 1) {
      const result = await resolveGitHubOperationCredentials(dummyDb, baseInput);
      expect(result).toMatchObject({ status: "available", env: { GH_TOKEN: "token-user-1" } });
    }
    // The expensive resolution (credential store + GitHub App mint) ran once;
    // the export policy is re-checked on every call by design (deny must take
    // effect immediately), the resolution is not.
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
    expect(applyGitHubAppIdentity).toHaveBeenCalledTimes(0);
    expect(recordGitHubRequest).toHaveBeenCalledTimes(0);
  });

  it("100 concurrent requests of one run to one repository join one resolution", async () => {
    vi.stubEnv("MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE", "1000");
    // Hold the first resolution open so every concurrent request lands inside
    // the same in-flight window instead of after its completion.
    let releaseResolution: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    vi.mocked(resolveManagedGitHubCredential).mockImplementationOnce(async () => {
      await gate;
      return {
        credential: {
          identitySource: "personal",
          githubIdentity: { login: "user-1" },
          connectionId: "conn-1",
          grantId: "grant-1",
          token: "token-user-1",
          source: "managed_connection",
          secretName: null,
        } as any,
      } as any;
    });

    const requests = Array.from({ length: 100 }, () => resolveGitHubOperationCredentials(dummyDb, baseInput));
    releaseResolution!();
    const results = await Promise.all(requests);
    for (const result of results) {
      expect(result).toMatchObject({ status: "available", env: { GH_TOKEN: "token-user-1" } });
    }
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
    expect(applyGitHubAppIdentity).toHaveBeenCalledTimes(0);
    expect(recordGitHubRequest).toHaveBeenCalledTimes(0);
  });

  it("concurrent first misses for the same (App, repository, permissions) mint one installation token", async () => {
    // The personal credential path is absent, so the broker walks the GitHub
    // App identity; every caller faces the same empty token cache, exactly the
    // storm shape that drained the installation budget.
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({
      configured: true,
      credential: null,
      error: "No GitHub identity connected",
    } as any);
    const mintInput = {
      appId: "101",
      privateKeyPem: appPrivateKeyPem,
      installationId: "5001",
      repository: "owner/repo-a",
      fetchImpl: (async () => {
        // No recordGitHubRequest here: the real githubRequest() inside
        // app-token.ts records the `broker` traffic itself, at the actual
        // mint — the assertion below counts that one call.
        return new Response(
          JSON.stringify({ token: "ghs_app-installation-token", expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }),
          { status: 201 },
        );
      }) as typeof fetch,
    };

    // All callers start before any token cache entry exists; the in-flight
    // mint must coalesce them into one GitHub call.
    const mints = Array.from({ length: 100 }, () => mintGitHubAppInstallationToken(mintInput));
    const results = await Promise.all(mints);
    expect(recordGitHubRequest).toHaveBeenCalledTimes(1);
    for (const result of results) {
      expect(result).toMatchObject({ token: "ghs_app-installation-token" });
    }
    // The caller whose flight actually minted reports `reused: false`; the 99
    // that joined the in-flight mint rode its token without spending budget.
    expect(results.filter((result) => !result.reused)).toHaveLength(1);
  });

  it("a run polling above the per-minute fuse gets HTTP 429 with an actionable reason", async () => {
    vi.stubEnv("MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE", "5");
    // Cache hit or miss does not matter: the fuse counts every request before
    // the cache short-circuit, so even a fully cached client cannot poll.
    for (let index = 0; index < 5; index += 1) {
      await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).resolves.toMatchObject({ status: "available" });
    }
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).rejects.toThrow(
      /Too many GitHub credential requests from this run/,
    );
    // The fuse trips regardless of the cache having been populated: the
    // request never reaches the cache short-circuit.
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
  });

  it("the fuse window rolls: blocked requests recover after the minute passes", async () => {
    vi.useFakeTimers();
    vi.stubEnv("MYRMIDON_GITHUB_CREDENTIALS_FUSE_PER_MINUTE", "2");
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).resolves.toMatchObject({ status: "available" });
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).resolves.toMatchObject({ status: "available" });
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).rejects.toThrow(/Too many GitHub credential requests/);
    vi.advanceTimersByTime(61_000);
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).resolves.toMatchObject({ status: "available" });
  });

  it("the fuse accepts the legacy Paperclip spelling of its limit variable as an alias", async () => {
    vi.stubEnv("PAPERCLIP_GITHUB_CREDENTIALS_FUSE_PER_MINUTE", "1");
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).resolves.toMatchObject({ status: "available" });
    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).rejects.toThrow(/Too many GitHub credential requests/);
  });
});
