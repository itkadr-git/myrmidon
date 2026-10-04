// myrmidon(GITHUB-SHARED-IDENTITY): "authorize once for the whole server" —
// shared GitHub authorizations (managed GitHub connections with the `shared`
// credential policy and one organization grant each), end to end over
// embedded postgres: access rules, the broker, precedence, attribution, audit.
//
// Pins:
//   - an agent allowed by a connection's rule (role or id) gets that shared
//     grant for a repository the rule allows: status available, source
//     "shared", the shared login; the commit identity is the agent's;
//   - identities are chosen per target repository: one agent pushes to the
//     repositories of product A under account A and to product B under
//     account B; a repository matched by neither is absent; a repository
//     matched by both is an error, never a silent pick;
//   - a repository outside the GitHub App installation is refused before the
//     token is read; an agent outside the rules, or a request without a
//     repository, does not see the shared connections at all (absent, legacy
//     fallback intact);
//   - a dedicated per-agent grant wins over a shared grant;
//   - the token never lands in run_identity_contexts, the activity log, the
//     stored rules or the settings API; each issuance is audited with the
//     agent, the run and the repository;
//   - the rules round-trip through GET/PUT and apply without a restart.

import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companyMemberships,
  companySecrets,
  connectionGrants,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  runIdentityContexts,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { runtimeConnectionIntentRoutes } from "../routes/connection-intents.js";
import { createRuntimeToolsToken } from "../runtime-tools-token.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { initializeRunIdentity } from "../services/run-identity.js";
import { resolveGitHubOperationCredentials } from "../services/github-operation-credentials.js";
import { resolveManagedGitHubIdentitySelection } from "../services/git-credentials.js";
import { myrmidonGitHubSharedIdentityRoutes } from "../myrmidon/github-shared-identity/index.js";
import { writeGitHubSharedIdentitySettings } from "../myrmidon/github-shared-identity/store.js";
import {
  agentCommitIdentity,
  defaultGitHubSharedIdentitySettings,
  isRepositoryAllowed,
  normalizeGitHubRepository,
  sharedConnectionIdsFor,
  type GitHubSharedConnectionRule,
  type GitHubSharedIdentitySettings,
} from "../myrmidon/github-shared-identity/settings.js";

const SHARED_TOKEN = "test-shared-token-a-not-a-secret";
const SHARED_TOKEN_B = "test-shared-token-b-not-a-secret";
const DEDICATED_TOKEN = "test-dedicated-token-not-a-secret";

const vaultState = vi.hoisted(() => ({ tokens: new Map<string, string>() }));
const vault = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(async (_companyId: string, secretId: string) =>
    vaultState.tokens.get(secretId) ?? "unknown-secret",
  ),
  resolveUserSecretValue: vi.fn(async () => ({ value: "test-user-token" })),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

describe("shared GitHub identity: pure policy", () => {
  it("normalizes repository references and refuses other hosts", () => {
    expect(normalizeGitHubRepository("owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("https://github.com/owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("git@github.com:owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("owner-a/repo-a.git/info/refs")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("https://example.com/owner-a/repo-a")).toBeNull();
    expect(normalizeGitHubRepository("../../etc/passwd")).toBeNull();
    expect(normalizeGitHubRepository("only-owner")).toBeNull();
    expect(normalizeGitHubRepository(42)).toBeNull();
  });

  it("matches owner/repo patterns with a literal owner", () => {
    expect(isRepositoryAllowed(["owner-a/repo-a"], "owner-a/repo-a")).toBe(true);
    expect(isRepositoryAllowed(["Owner-A/Repo-A"], "owner-a/repo-a")).toBe(true);
    expect(isRepositoryAllowed(["owner-a/*"], "owner-a/anything")).toBe(true);
    expect(isRepositoryAllowed(["owner-a/service-*"], "owner-a/service-x")).toBe(true);
    expect(isRepositoryAllowed(["owner-a/service-*"], "owner-a/other")).toBe(false);
    expect(isRepositoryAllowed(["owner-a/*"], "owner-b/repo-a")).toBe(false);
    expect(isRepositoryAllowed(["*/repo-a"], "owner-a/repo-a")).toBe(false);
    expect(isRepositoryAllowed([], "owner-a/repo-a")).toBe(false);
  });

  it("picks shared connections by the agent's rule and the target repository", () => {
    const agent = { id: "11111111-1111-4111-8111-111111111111", role: "engineer" };
    const settings: GitHubSharedIdentitySettings = {
      ...defaultGitHubSharedIdentitySettings(),
      enabled: true,
      connections: [
        { connectionId: "a", roles: ["engineer"], agentIds: [], allowedRepos: ["owner-a/*"] },
        { connectionId: "b", roles: [], agentIds: [agent.id], allowedRepos: ["owner-b/*", "owner-a/shared"] },
      ],
    };
    expect(sharedConnectionIdsFor(settings, agent, "owner-a/repo-a")).toEqual(["a"]);
    expect(sharedConnectionIdsFor(settings, agent, "owner-b/repo-b")).toEqual(["b"]);
    expect(sharedConnectionIdsFor(settings, agent, "owner-c/repo-c")).toEqual([]);
    expect(sharedConnectionIdsFor(settings, agent, "owner-a/shared")).toEqual(["a", "b"]);
    expect(
      sharedConnectionIdsFor(settings, { id: "22222222-2222-4222-8222-222222222222", role: "designer" }, "owner-a/repo-a"),
    ).toEqual([]);
    expect(sharedConnectionIdsFor({ ...settings, enabled: false }, agent, "owner-a/repo-a")).toEqual([]);
    expect(sharedConnectionIdsFor(settings, agent, null)).toEqual([]);
  });

  it("derives the agent's commit identity", () => {
    expect(agentCommitIdentity({ id: "11111111-1111-4111-8111-111111111111", name: "Agent A" }, { commitEmailDomain: null }))
      .toEqual({ name: "Agent A", email: "agent-a@agents.myrmidon.invalid" });
    expect(agentCommitIdentity({ id: "11111111-1111-4111-8111-111111111111", name: "Агент" }, { commitEmailDomain: "example.com" }))
      .toEqual({ name: "Агент", email: "agent-11111111@example.com" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("shared GitHub identity: broker and settings", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-shared-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-shared-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  beforeEach(() => {
    vault.resolveSecretValue.mockClear();
  });

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function seed(role = "engineer") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent A", role, adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Shared identity test" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", contextSnapshot: { issueId } });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "user-a",
      status: "active",
      membershipRole: "member",
    });
    await initializeRunIdentity(db, { companyId, runId, responsibleUserId: "user-a", cause: "instruction" });
    return { companyId, agentId, runId, issueId };
  }

  /** A managed GitHub connection, shared policy, one organization grant, installed for the company. */
  async function installShared(
    input: Seeded,
    options: { repositories?: string[]; login?: string; userId?: string; token?: string; name?: string } = {},
  ) {
    const repositories = options.repositories ?? ["owner-a/repo-a", "owner-a/service-x", "owner-a/overlap"];
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    const grantId = randomUUID();
    vaultState.tokens.set(secretId, options.token ?? SHARED_TOKEN);
    await db.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId: input.companyId,
      applicationId,
      name: options.name ?? "GitHub (shared)",
      uid: connectionId,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      credentialPolicy: "shared",
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: input.companyId,
      connectionId,
      targetType: "company",
      targetId: input.companyId,
    });
    await db.insert(companySecrets).values({ id: secretId, companyId: input.companyId, key: secretId, name: `Shared ${secretId}`, scope: "company" });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId: input.companyId,
      connectionId,
      kind: "organization",
      status: "active",
      isDefault: true,
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: {
        github: {
          userId: options.userId ?? "2002",
          login: options.login ?? "account-a",
          installationCount: 1,
          repositoryCount: repositories.length,
          repositorySelection: "selected",
          installationIds: ["7"],
          installationOwnerLogins: ["owner-a"],
          repositories: repositories.map((fullName, index) => ({ id: String(index + 1), fullName, installationId: "7" })),
        },
      },
    });
    return { connectionId, grantId, secretId };
  }

  async function installDedicated(input: Seeded) {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    vaultState.tokens.set(secretId, DEDICATED_TOKEN);
    await db.insert(toolApplications).values({ id: applicationId, companyId: input.companyId, name: applicationId, type: "mcp_http" });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId: input.companyId,
      applicationId,
      name: connectionId,
      uid: connectionId,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      credentialPolicy: "per_agent",
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
    });
    await db.insert(toolConnectionInstalls).values({
      companyId: input.companyId,
      connectionId,
      targetType: "agent",
      targetId: input.agentId,
    });
    await db.insert(companySecrets).values({ id: secretId, companyId: input.companyId, key: secretId, name: `Dedicated ${secretId}`, scope: "company" });
    await db.insert(connectionGrants).values({
      companyId: input.companyId,
      connectionId,
      kind: "agent",
      subjectAgentId: input.agentId,
      status: "active",
      credentialSecretRefs: [{ secretId, configPath: "oauth.access_token", versionSelector: "latest" }],
      providerTenant: {
        github: {
          userId: "1001",
          login: "dedicated-a",
          installationCount: 1,
          repositoryCount: 1,
          repositorySelection: "selected",
          installationIds: ["1"],
          installationOwnerLogins: ["owner-a"],
        },
      },
    });
  }

  function rule(connectionId: string, patch: Partial<GitHubSharedConnectionRule> = {}): GitHubSharedConnectionRule {
    return {
      connectionId,
      roles: ["engineer"],
      agentIds: [],
      allowedRepos: ["owner-a/repo-a", "owner-a/service-*", "owner-a/not-installed"],
      ...patch,
    };
  }

  function rules(
    connections: GitHubSharedConnectionRule[],
    patch: Partial<GitHubSharedIdentitySettings> = {},
  ): GitHubSharedIdentitySettings {
    return { ...defaultGitHubSharedIdentitySettings(), enabled: true, connections, ...patch };
  }

  it("issues the shared grant for an allowed agent and repository, with the agent as author, audited without the token", async () => {
    const input = await seed();
    const shared = await installShared(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([rule(shared.connectionId)]));
    const result = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    expect(result).toMatchObject({
      status: "available",
      source: "shared",
      login: "account-a",
      repository: "owner-a/repo-a",
      connectionId: shared.connectionId,
      grantId: shared.grantId,
      authenticationMode: "managed",
    });
    expect(result.env.GH_TOKEN).toBe(SHARED_TOKEN);
    // Only the authentication is shared: the commit identity stays the agent's.
    expect(result.env.GIT_AUTHOR_NAME).toBe("Agent A");
    expect(result.env.GIT_AUTHOR_EMAIL).toBe("agent-a@agents.myrmidon.invalid");
    expect(result.env.GIT_COMMITTER_NAME).toBe("Agent A");
    expect(JSON.stringify(result.env)).not.toContain("account-a@");

    expect(vault.resolveSecretValue).toHaveBeenCalledTimes(1);
    expect(vault.resolveSecretValue).toHaveBeenCalledWith(input.companyId, shared.secretId, "latest", {
      accessContext: expect.objectContaining({
        consumerId: "workspace-git-credential",
        configPath: "github_shared:owner-a/repo-a",
        actorId: input.agentId,
        heartbeatRunId: input.runId,
        issueId: input.issueId,
      }),
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    const issued = activity.filter((row) => row.action === "myrmidon.github_shared.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ agentId: input.agentId, runId: input.runId, entityType: "github_shared_identity" });
    expect(issued[0]!.details).toMatchObject({ repository: "owner-a/repo-a", login: "account-a", grantId: shared.grantId });

    const contexts = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, input.runId));
    expect(contexts.some((row) => row.github?.source === "shared" && row.github.repository === "owner-a/repo-a")).toBe(true);
    expect(JSON.stringify(contexts)).not.toContain(SHARED_TOKEN);
    expect(JSON.stringify(activity)).not.toContain(SHARED_TOKEN);
    expect(JSON.stringify(await db.select().from(instanceSettings))).not.toContain(SHARED_TOKEN);
  });

  it("uses the configured commit email domain and serves glob-matched repositories", async () => {
    const input = await seed();
    const shared = await installShared(input);
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([rule(shared.connectionId)], { commitEmailDomain: "example.com" }),
    );
    const result = await resolveGitHubOperationCredentials(db, {
      ...input,
      repository: "https://github.com/owner-a/service-x.git",
    });
    expect(result).toMatchObject({ status: "available", source: "shared", repository: "owner-a/service-x" });
    expect(result.env.GIT_AUTHOR_EMAIL).toBe("agent-a@example.com");
  });

  it("separates products: one agent, account A for product A, account B for product B, never mixed", async () => {
    const input = await seed();
    const productA = await installShared(input, {
      name: "GitHub (product A)",
      login: "account-a",
      userId: "2002",
      token: SHARED_TOKEN,
      repositories: ["owner-a/repo-a", "owner-a/overlap"],
    });
    const productB = await installShared(input, {
      name: "GitHub (product B)",
      login: "account-b",
      userId: "3003",
      token: SHARED_TOKEN_B,
      repositories: ["owner-b/app-b", "owner-a/overlap"],
    });
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([
        rule(productA.connectionId, { allowedRepos: ["owner-a/*"] }),
        rule(productB.connectionId, { allowedRepos: ["owner-b/*", "owner-a/overlap"] }),
      ]),
    );

    const a = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    expect(a).toMatchObject({ status: "available", source: "shared", login: "account-a", connectionId: productA.connectionId });
    expect(a.env.GH_TOKEN).toBe(SHARED_TOKEN);

    const b = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-b/app-b" });
    expect(b).toMatchObject({ status: "available", source: "shared", login: "account-b", connectionId: productB.connectionId });
    expect(b.env.GH_TOKEN).toBe(SHARED_TOKEN_B);

    // Matched by neither: no shared identity at all.
    const neither = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-c/repo-c" });
    expect(neither).toMatchObject({ status: "absent", env: {} });

    // Matched by both: an error, never a silent pick.
    vault.resolveSecretValue.mockClear();
    const both = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/overlap" });
    expect(both).toMatchObject({ status: "unavailable", source: "shared", env: {} });
    expect(both.reason).toMatch(/More than one shared GitHub identity matches repository owner-a\/overlap/);
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("refuses a repository outside the installation before reading the token, and hides shared grants without a match", async () => {
    const input = await seed();
    const shared = await installShared(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([rule(shared.connectionId)]));
    const notInstalled = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/not-installed" });
    expect(notInstalled).toMatchObject({ status: "unavailable", source: "shared", env: {} });
    expect(notInstalled.reason).toMatch(/GitHub App installation/);
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    expect(activity.map((row) => row.action)).toContain("myrmidon.github_shared.denied");
    expect(activity.map((row) => row.action)).not.toContain("myrmidon.github_shared.issued");

    // Outside the allowed list, or no repository named: the shared connection is absent.
    expect(
      await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-b/repo-b" }),
    ).toMatchObject({ status: "absent", source: "personal", env: {} });
    expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "absent", env: {} });
  });

  it("keeps shared connections invisible to agents outside the rules, and to non-broker paths", async () => {
    const input = await seed("designer");
    const shared = await installShared(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([rule(shared.connectionId)]));
    expect(
      await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }),
    ).toMatchObject({ status: "absent", source: "personal", env: {} });

    // Listed by id regardless of role.
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([rule(shared.connectionId, { roles: [], agentIds: [input.agentId] })]),
    );
    expect(
      await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }),
    ).toMatchObject({ status: "available", source: "shared" });
    // Server-side workspace git and the MCP connection filter do not consider shared grants.
    expect(
      await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId, responsibleUserId: "user-a" }),
    ).toEqual({ configured: false });

    // Switched off: absent again, applied without a restart.
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([rule(shared.connectionId, { agentIds: [input.agentId] })], { enabled: false }),
    );
    expect(
      await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }),
    ).toMatchObject({ status: "absent", env: {} });
  });

  it("lets a dedicated per-agent grant win over the shared grant", async () => {
    const input = await seed();
    const shared = await installShared(input);
    await installDedicated(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([rule(shared.connectionId)]));
    const result = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    expect(result).toMatchObject({ status: "available", source: "dedicated", login: "dedicated-a" });
    expect(result.env.GH_TOKEN).toBe(DEDICATED_TOKEN);
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    expect(activity.map((row) => row.action)).not.toContain("myrmidon.github_shared.issued");
  });

  it("takes the repository from the broker request body", async () => {
    const input = await seed();
    const shared = await installShared(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([rule(shared.connectionId)]));
    const app = express();
    app.use(express.json());
    app.use(runtimeConnectionIntentRoutes(db));
    app.use(errorHandler);
    const token = createRuntimeToolsToken({ ...input, responsibleUserId: "user-a", scope: "github_credentials" })!.token;
    const allowed = await request(app)
      .post("/runtime-tools/github/credentials")
      .set("x-paperclip-github-capability", token)
      .send({ repository: "owner-a/repo-a.git" });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toMatchObject({ status: "available", source: "shared", repository: "owner-a/repo-a" });
    expect(allowed.body.env.GH_TOKEN).toBe(SHARED_TOKEN);
    const other = await request(app)
      .post("/runtime-tools/github/credentials")
      .set("x-paperclip-github-capability", token)
      .send({ repository: "owner-b/repo-b" });
    expect(other.body).toMatchObject({ status: "absent", env: {} });
    expect(JSON.stringify(other.body)).not.toContain(SHARED_TOKEN);
  });

  describe("settings API", () => {
    function app(actor: Record<string, unknown>) {
      const server = express();
      server.use(express.json());
      server.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      server.use("/api", myrmidonGitHubSharedIdentityRoutes(db));
      server.use(errorHandler);
      return server;
    }
    const operator = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };

    it("round-trips the rules through PUT and GET and lists the shared connections without secrets", async () => {
      const input = await seed();
      const shared = await installShared(input);
      const path = `/api/myrmidon/companies/${input.companyId}/github-shared-identity`;
      const initial = await request(app(operator)).get(path);
      expect(initial.status).toBe(200);
      expect(initial.body.settings).toEqual(defaultGitHubSharedIdentitySettings());
      expect(initial.body.connections).toEqual([
        {
          id: shared.connectionId,
          name: "GitHub (shared)",
          enabled: true,
          status: "active",
          installedForCompany: true,
          grant: { status: "active", login: "account-a", repositoryCount: 3, repositorySelection: "selected" },
        },
      ]);

      const body = {
        enabled: true,
        connections: [
          {
            connectionId: shared.connectionId,
            roles: ["engineer", "engineer"],
            agentIds: [input.agentId],
            allowedRepos: ["owner-a/repo-a", "OWNER-A/repo-a", "owner-a/service-*"],
          },
        ],
        commitEmailDomain: "Example.com",
      };
      const saved = await request(app(operator)).put(path).send(body);
      expect(saved.status).toBe(200);
      const expected = {
        version: 1,
        enabled: true,
        connections: [
          {
            connectionId: shared.connectionId,
            roles: ["engineer"],
            agentIds: [input.agentId],
            allowedRepos: ["owner-a/repo-a", "owner-a/service-*"],
          },
        ],
        commitEmailDomain: "example.com",
      };
      expect(saved.body.settings).toEqual(expected);
      const reread = await request(app(operator)).get(path);
      expect(reread.body.settings).toEqual(expected);
      expect(JSON.stringify(reread.body)).not.toContain(SHARED_TOKEN);

      const journal = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
      expect(journal.map((row) => row.action)).toContain("myrmidon.github_shared.settings_saved");

      // The saved rules drive the broker at once.
      expect(
        await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }),
      ).toMatchObject({ status: "available", source: "shared" });
    });

    it("rejects foreign connections and agents, wide patterns, unknown fields and callers without the permission", async () => {
      const input = await seed();
      const shared = await installShared(input);
      const other = await seed();
      const otherShared = await installShared(other);
      const path = `/api/myrmidon/companies/${input.companyId}/github-shared-identity`;
      const base = {
        enabled: true,
        connections: [{ connectionId: shared.connectionId, roles: ["engineer"], agentIds: [], allowedRepos: ["owner-a/repo-a"] }],
        commitEmailDomain: null,
      };
      const withRule = (patch: Record<string, unknown>) => ({ ...base, connections: [{ ...base.connections[0], ...patch }] });
      expect((await request(app(operator)).put(path).send(withRule({ connectionId: otherShared.connectionId }))).status).toBe(422);
      expect((await request(app(operator)).put(path).send(withRule({ agentIds: [other.agentId] }))).status).toBe(422);
      expect((await request(app(operator)).put(path).send(withRule({ allowedRepos: ["*/*"] }))).status).toBe(400);
      expect((await request(app(operator)).put(path).send({ ...base, token: SHARED_TOKEN })).status).toBe(400);
      expect((await request(app(operator)).put(path).send({ ...base, commitEmailDomain: "not a domain" })).status).toBe(400);
      expect(
        (await request(app(operator)).put(path).send({ ...base, connections: [base.connections[0], base.connections[0]] })).status,
      ).toBe(400);

      const member = {
        type: "board",
        source: "session",
        userId: "user-without-permission",
        isInstanceAdmin: false,
        companyIds: [input.companyId],
      };
      expect((await request(app(member)).put(path).send(base)).status).toBe(403);
      const agentActor = { type: "agent", source: "agent_key", agentId: input.agentId, companyId: input.companyId };
      expect((await request(app(agentActor)).get(path)).status).toBe(403);
      expect((await request(app(agentActor)).put(path).send(base)).status).toBe(403);

      expect((await request(app(operator)).get(path)).body.settings).toEqual(defaultGitHubSharedIdentitySettings());
    });
  });
});
