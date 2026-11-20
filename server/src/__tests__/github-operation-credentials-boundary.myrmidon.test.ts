import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@myrmidon/db";

vi.mock("../services/run-identity.js", () => ({ captureRunIdentity: vi.fn() }));
vi.mock("../services/github-credential-policy.js", () => ({ allowsGitHubCredentialExport: vi.fn() }));
vi.mock("../services/git-credentials.js", () => ({
  resolveManagedGitHubCredential: vi.fn(),
  buildGitAuthInvocation: vi.fn((credential: { token: string }) => ({ env: { GH_TOKEN: credential.token } })),
}));
vi.mock("../myrmidon/github-shared-identity/broker.js", () => ({ applyGitHubAppIdentity: vi.fn() }));
vi.mock("../myrmidon/github-shared-identity/store.js", () => ({ readGitHubSharedIdentitySettings: vi.fn().mockResolvedValue({ enabled: false }) }));

import { captureRunIdentity } from "../services/run-identity.js";
import { allowsGitHubCredentialExport } from "../services/github-credential-policy.js";
import { resolveManagedGitHubCredential } from "../services/git-credentials.js";
import { clearGitHubOperationCredentialCache, resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";

type Input = Parameters<typeof resolveGitHubOperationCredentials>[1];
type Identity = Awaited<ReturnType<typeof captureRunIdentity>>;
type Resolution = Awaited<ReturnType<typeof resolveManagedGitHubCredential>>;

type RunRow = Identity["run"];
type ContextRow = NonNullable<Identity["context"]>;

const base: Input = { companyId: "company-a", agentId: "agent-a", runId: "run-a", repository: "owner/repo-a" };
const at = new Date("2026-01-01T00:00:00.000Z");
const identity: ContextRow = {
  id: "context-a",
  companyId: "company-a",
  runId: "run-a",
  revision: 1,
  responsibleUserId: "user-a",
  cause: "operator",
  correlationId: "correlation-a",
  status: "accepted",
  createdAt: at,
};
const writes = vi.fn();
const db = {
  select: () => ({ from: () => ({ where: async () => [{ enabled: true, status: "active", role: "agent" }] }) }),
  update: () => ({ set: (value: unknown) => { writes(value); return { where: async () => [] }; } }),
} as unknown as Db;

function credential(token: string): Resolution {
  return {
    configured: true,
    credential: {
      token,
      source: "managed_connection",
      secretName: null,
      identitySource: "personal",
      githubIdentity: { userId: "user-fixture", login: "fixture" },
      connectionId: "connection",
      grantId: "grant",
    },
  };
}
function runRow(input: Input): RunRow {
  return {
    id: input.runId,
    companyId: input.companyId,
    agentId: input.agentId,
    status: "running",
    invocationSource: "on_demand",
    runtimeMode: "legacy",
    nextEventSeq: 1,
    logCompressed: false,
    lastOutputSeq: 0,
    processLossRetryCount: 0,
    scheduledRetryAttempt: 0,
    issueCommentStatus: "not_applicable",
    continuationAttempt: 0,
    createdAt: at,
    updatedAt: at,
  };
}
function setIdentity(input: Input, context: ContextRow = identity): Identity {
  return {
    run: runRow(input),
    context: { ...context, companyId: input.companyId, runId: input.runId },
  };
}

describe("runtime GitHub credential identity boundaries", () => {
  beforeEach(() => {
    clearGitHubOperationCredentialCache();
    vi.clearAllMocks();
    vi.mocked(captureRunIdentity).mockImplementation(async (_db, input) => setIdentity(input));
    vi.mocked(allowsGitHubCredentialExport).mockResolvedValue({ allowed: true });
    vi.mocked(resolveManagedGitHubCredential).mockResolvedValueOnce(credential("sentinel-a")).mockResolvedValue(credential("sentinel-b"));
  });

  it.each([
    ["company", { companyId: "company-b" }, identity],
    ["agent", { agentId: "agent-b" }, identity],
    ["run", { runId: "run-b" }, identity],
    ["context", {}, { ...identity, id: "context-b" }],
    ["revision", {}, { ...identity, revision: 2 }],
    ["responsible user", {}, { ...identity, responsibleUserId: "user-b" }],
    ["repository", { repository: "owner/repo-b" }, identity],
  ])("isolates %s independently while retaining the original cached result", async (_name, change, context) => {
    const first = await resolveGitHubOperationCredentials(db, base);
    expect(first.env).toEqual({ GH_TOKEN: "sentinel-a" });
    expect((await resolveGitHubOperationCredentials(db, base)).env).toEqual({ GH_TOKEN: "sentinel-a" });
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
    const other = { ...base, ...change };
    vi.mocked(captureRunIdentity).mockResolvedValueOnce(setIdentity(other, context));
    expect((await resolveGitHubOperationCredentials(db, other)).env).toEqual({ GH_TOKEN: "sentinel-b" });
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
    expect((await resolveGitHubOperationCredentials(db, base)).env).toEqual({ GH_TOKEN: "sentinel-a" });
  });

  it.each(["company", "run"])("does not coalesce concurrent distinct %s requests", async (boundary) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(resolveManagedGitHubCredential).mockReset().mockImplementation(async (_db, _secrets, company, options) => {
      await gate;
      return credential(company === "company-b" || options.heartbeatRunId === "run-b" ? "sentinel-b" : "sentinel-a");
    });
    const other = boundary === "company" ? { ...base, companyId: "company-b" } : { ...base, runId: "run-b" };
    const requests = [resolveGitHubOperationCredentials(db, base), resolveGitHubOperationCredentials(db, base), resolveGitHubOperationCredentials(db, other)];
    await vi.waitFor(() => expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2));
    release();
    const results = await Promise.all(requests);
    expect(results.map((result) => result.env)).toEqual([{ GH_TOKEN: "sentinel-a" }, { GH_TOKEN: "sentinel-a" }, { GH_TOKEN: "sentinel-b" }]);
  });

  it("never returns a cached environment after denial or an invalid run", async () => {
    expect((await resolveGitHubOperationCredentials(db, base)).env).toEqual({ GH_TOKEN: "sentinel-a" });
    vi.mocked(allowsGitHubCredentialExport).mockResolvedValueOnce({ allowed: false, reason: "denied" });
    expect(await resolveGitHubOperationCredentials(db, base)).toMatchObject({ status: "unavailable", env: {} });
    vi.mocked(captureRunIdentity).mockRejectedValueOnce(new Error("invalid run"));
    await expect(resolveGitHubOperationCredentials(db, base)).rejects.toThrow("invalid run");
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(1);
  });

  it("redacts provider errors from persisted and returned summaries and retries successfully", async () => {
    vi.mocked(resolveManagedGitHubCredential).mockReset().mockRejectedValueOnce(new Error("synthetic-private-marker")).mockResolvedValueOnce(credential("sentinel-recovered"));
    const failed = await resolveGitHubOperationCredentials(db, base);
    expect(failed).toMatchObject({ status: "unavailable", env: {}, reason: "GitHub credentials are temporarily unavailable" });
    expect(JSON.stringify([failed, writes.mock.calls])).not.toContain("synthetic-private-marker");
    expect((await resolveGitHubOperationCredentials(db, base)).env).toEqual({ GH_TOKEN: "sentinel-recovered" });
    expect(resolveManagedGitHubCredential).toHaveBeenCalledTimes(2);
  });
});
