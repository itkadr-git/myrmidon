import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock dependencies before importing the service
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

vi.mock("../myrmidon/github-shared-identity/broker.js", () => ({
  applyGitHubAppIdentity: vi.fn(),
}));

import { captureRunIdentity } from "../services/run-identity.js";
import { allowsGitHubCredentialExport } from "../services/github-credential-policy.js";
import { resolveManagedGitHubCredential } from "../services/git-credentials.js";
import { resetGitHubAppTokenCacheForTests } from "../myrmidon/github-shared-identity/app-token.js";
import {
  clearGitHubOperationCredentialCache,
  resolveGitHubOperationCredentials,
} from "../services/github-operation-credentials.js";

describe("github operation credentials in-memory cache (OPE-9997)", () => {
  const dummyDb: any = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([{ enabled: true, status: "active" }]),
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    }),
  };

  const baseInput = {
    companyId: "company-1",
    agentId: "agent-1",
    runId: "run-1",
    repository: "owner/repo-a",
  };

  beforeEach(() => {
    clearGitHubOperationCredentialCache();
    vi.clearAllMocks();

    vi.mocked(captureRunIdentity).mockResolvedValue({
      run: {
        id: "run-1",
        companyId: "company-1",
        agentId: "agent-1",
        status: "running",
      } as any,
      context: {
        id: "ctx-1",
        companyId: "company-1",
        runId: "run-1",
        revision: 1,
        responsibleUserId: "user-1",
      } as any,
    });

    vi.mocked(allowsGitHubCredentialExport).mockResolvedValue({
      allowed: true,
    });

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
  });

  it("caches resolved credentials per run, context, and repo, returning immediately on repeat calls", async () => {
    // 1st call: cache miss, resolves via captureRunIdentity and policy/resolvers
    const first = await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(first).toMatchObject({
      status: "available",
      login: "user-1",
      env: { GH_TOKEN: "token-user-1" },
    });
    expect(allowsGitHubCredentialExport).toHaveBeenCalledTimes(1);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);

    // 2nd call with identical parameters: cache hit!
    const second = await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(second).toEqual(first);
    // allowsGitHubCredentialExport and resolveManagedGitHubCredential are NOT called again
    expect(allowsGitHubCredentialExport).toHaveBeenCalledTimes(1);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
  });

  it("re-resolves when identity context responsible user changes (identity steering)", async () => {
    await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);

    // Steer identity to user-2
    vi.mocked(captureRunIdentity).mockResolvedValue({
      run: { id: "run-1", companyId: "company-1", agentId: "agent-1", status: "running" } as any,
      context: { id: "ctx-1", companyId: "company-1", runId: "run-1", revision: 2, responsibleUserId: "user-2" } as any,
    });
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValue({
      credential: {
        identitySource: "personal",
        githubIdentity: { login: "user-2" },
        connectionId: "conn-2",
        grantId: "grant-2",
        token: "token-user-2",
        source: "managed_connection",
        secretName: null,
      } as any,
    } as any);

    const steered = await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(steered).toMatchObject({
      status: "available",
      login: "user-2",
      env: { GH_TOKEN: "token-user-2" },
    });
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
  });

  it("re-resolves when repository target differs", async () => {
    await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);

    const otherRepo = await resolveGitHubOperationCredentials(dummyDb, {
      ...baseInput,
      repository: "owner/repo-b",
    });
    expect(otherRepo).toBeDefined();
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
  });

  it("clears cached credentials on resetGitHubAppTokenCacheForTests", async () => {
    await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);

    resetGitHubAppTokenCacheForTests();

    await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
  });

  it("rejects immediately when run is not running without returning stale cached credentials", async () => {
    await resolveGitHubOperationCredentials(dummyDb, baseInput);
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);

    // Run finished / succeeded
    vi.mocked(captureRunIdentity).mockRejectedValue(new Error("Run is not running"));

    await expect(resolveGitHubOperationCredentials(dummyDb, baseInput)).rejects.toThrow("Run is not running");
  });
});
