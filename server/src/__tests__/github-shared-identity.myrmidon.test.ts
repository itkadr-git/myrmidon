// myrmidon(GITHUB-SHARED-IDENTITY): "authorize once for the whole server"
// through self-hosted GitHub Apps, end to end over embedded postgres: access
// rules, server-side installation tokens, per-repository identities,
// precedence, attribution, audit and the vendor cloud connector switch.
//
// Pins:
//   - an agent allowed by an App entry gets an installation token minted on
//     the board (JWT signed with the App key, verified here) for the ONE
//     target repository with contents/pull_requests write and metadata read;
//     the commit identity is the agent's;
//   - identities are chosen per target repository: product A → App A,
//     product B → App B, matched by neither → absent, matched by both →
//     error (no key read, no token);
//   - a dedicated per-agent grant wins over an App; an agent outside the
//     rules and a request without a repository stay absent;
//   - the token never lands in run_identity_contexts, the activity log, the
//     stored rules or the settings API; each issuance is audited;
//   - the vendor cloud GitHub connector is off by default: its connections
//     are ignored by the resolver;
//   - the rules round-trip through GET/PUT and apply without a restart.

import express from "express";
import request from "supertest";
import { createPublicKey, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
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
import { resetGitHubAppTokenCacheForTests } from "../myrmidon/github-shared-identity/app-token.js";
import {
  assertVendorGitHubConnectorAllowed,
  vendorGitHubConnectorEnabled,
} from "../myrmidon/github-shared-identity/vendor-connector.js";
import {
  agentCommitIdentity,
  defaultGitHubSharedIdentitySettings,
  githubAppsFor,
  isRepositoryAllowed,
  normalizeGitHubRepository,
  type GitHubAppEntry,
  type GitHubSharedIdentitySettings,
} from "../myrmidon/github-shared-identity/settings.js";

const DEDICATED_TOKEN = "test-dedicated-token-not-a-secret";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
const KEY_A = keyPair();
const KEY_B = keyPair();

const vaultState = vi.hoisted(() => ({ values: new Map<string, string>() }));
const vault = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(async (_companyId: string, secretId: string) => vaultState.values.get(secretId) ?? "unknown-secret"),
  resolveUserSecretValue: vi.fn(async () => ({ value: "test-user-token" })),
}));
vi.mock("../services/secrets.js", () => ({ secretService: () => vault }));

/** A fake GitHub API: verifies the App JWT, records requests, mints tokens per App. */
type GitHubCall = { method: string; url: string; body: Record<string, unknown> | null; appId: string | null };
const github = {
  calls: [] as GitHubCall[],
  apps: new Map<string, { publicPem: string; installationId: string; tokenPrefix: string; repos: string[] }>(),
};
function verifyJwt(jwt: string): string | null {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return null;
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss: string };
  const app = github.apps.get(claims.iss);
  if (!app) return null;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(createPublicKey(app.publicPem), Buffer.from(signature, "base64url")) ? claims.iss : null;
}
const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
  const appId = verifyJwt(auth.replace(/^Bearer /, ""));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  github.calls.push({ method: init?.method ?? "GET", url: href, body, appId });
  if (!appId) return new Response("{}", { status: 401 });
  const app = github.apps.get(appId)!;
  const installation = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(href);
  if (installation) {
    const full = `${installation[1]}/${installation[2]}`;
    return app.repos.includes(full)
      ? Response.json({ id: Number(app.installationId) })
      : new Response("{}", { status: 404 });
  }
  if (/\/app\/installations\/\d+\/access_tokens$/.test(href)) {
    return Response.json(
      { token: `${app.tokenPrefix}-${(body?.repositories as string[])[0]}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
      { status: 201 },
    );
  }
  return new Response("{}", { status: 404 });
});

describe("GitHub App identity: pure policy", () => {
  it("normalizes repository references and refuses other hosts", () => {
    expect(normalizeGitHubRepository("owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("https://github.com/owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("git@github.com:owner-a/repo-a.git")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("owner-a/repo-a.git/info/refs")).toBe("owner-a/repo-a");
    expect(normalizeGitHubRepository("https://example.com/owner-a/repo-a")).toBeNull();
    expect(normalizeGitHubRepository("../../etc/passwd")).toBeNull();
    expect(normalizeGitHubRepository(42)).toBeNull();
  });

  it("matches owner/repo patterns with a literal owner", () => {
    expect(isRepositoryAllowed(["owner-a/repo-a"], "owner-a/repo-a")).toBe(true);
    expect(isRepositoryAllowed(["Owner-A/Repo-A"], "owner-a/repo-a")).toBe(true);
    expect(isRepositoryAllowed(["owner-a/*"], "owner-a/anything")).toBe(true);
    expect(isRepositoryAllowed(["owner-a/service-*"], "owner-a/other")).toBe(false);
    expect(isRepositoryAllowed(["owner-a/*"], "owner-b/repo-a")).toBe(false);
    expect(isRepositoryAllowed(["*/repo-a"], "owner-a/repo-a")).toBe(false);
  });

  it("picks App entries by the agent and the target repository", () => {
    const agent = { id: "11111111-1111-4111-8111-111111111111", role: "engineer" };
    const entry = (id: string, patch: Partial<GitHubAppEntry>): GitHubAppEntry => ({
      id, name: id, appId: "1", privateKeySecretId: id, installationId: null, slug: null, roles: [], agentIds: [], allowedRepos: [], ...patch,
    });
    const settings: GitHubSharedIdentitySettings = {
      ...defaultGitHubSharedIdentitySettings(),
      enabled: true,
      apps: [
        entry("a", { roles: ["engineer"], allowedRepos: ["owner-a/*"] }),
        entry("b", { agentIds: [agent.id], allowedRepos: ["owner-b/*", "owner-a/overlap"] }),
      ],
    };
    const ids = (repository: string | null, who = agent) => githubAppsFor(settings, who, repository).map((app) => app.id);
    expect(ids("owner-a/repo-a")).toEqual(["a"]);
    expect(ids("owner-b/app-b")).toEqual(["b"]);
    expect(ids("owner-c/repo-c")).toEqual([]);
    expect(ids("owner-a/overlap")).toEqual(["a", "b"]);
    expect(ids("owner-a/repo-a", { id: "22222222-2222-4222-8222-222222222222", role: "designer" })).toEqual([]);
    expect(ids(null)).toEqual([]);
  });

  it("derives the agent's commit identity", () => {
    expect(agentCommitIdentity({ id: "11111111-1111-4111-8111-111111111111", name: "Agent A" }, { commitEmailDomain: null }))
      .toEqual({ name: "Agent A", email: "agent-a@agents.myrmidon.invalid" });
    expect(agentCommitIdentity({ id: "11111111-1111-4111-8111-111111111111", name: "Агент" }, { commitEmailDomain: "example.com" }))
      .toEqual({ name: "Агент", email: "agent-11111111@example.com" });
  });

  it("keeps the vendor cloud GitHub connector off unless enabled", () => {
    expect(vendorGitHubConnectorEnabled({})).toBe(false);
    expect(vendorGitHubConnectorEnabled({ MYRMIDON_GITHUB_VENDOR_CONNECTOR: "0" })).toBe(false);
    expect(vendorGitHubConnectorEnabled({ MYRMIDON_GITHUB_VENDOR_CONNECTOR: "1" })).toBe(true);
    expect(() => assertVendorGitHubConnectorAllowed("github.code", {})).toThrow(/vendor cloud GitHub connector is disabled/);
    expect(() => assertVendorGitHubConnectorAllowed("github.code", { MYRMIDON_GITHUB_VENDOR_CONNECTOR: "1" })).not.toThrow();
    expect(() => assertVendorGitHubConnectorAllowed("gmail.draft", {})).not.toThrow();
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub App identity: broker and settings", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "test-github-app-signing-secret");
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-app-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
    vi.unstubAllEnvs();
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal("fetch", fakeFetch);
    vault.resolveSecretValue.mockClear();
    fakeFetch.mockClear();
    github.calls = [];
    github.apps.clear();
    resetGitHubAppTokenCacheForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  type Seeded = Awaited<ReturnType<typeof seed>>;

  async function seed(role = "engineer") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent A", role, adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "GitHub App identity test" });
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

  /** Registers a fake GitHub App and stores its private key as a company secret. */
  async function registerApp(
    input: Seeded,
    options: { appId: string; key: { privatePem: string; publicPem: string }; installationId: string; tokenPrefix: string; repos: string[] },
  ) {
    const secretId = randomUUID();
    await db.insert(companySecrets).values({ id: secretId, companyId: input.companyId, key: secretId, name: `App key ${secretId}`, scope: "company" });
    vaultState.values.set(secretId, options.key.privatePem);
    github.apps.set(options.appId, {
      publicPem: options.key.publicPem,
      installationId: options.installationId,
      tokenPrefix: options.tokenPrefix,
      repos: options.repos,
    });
    return secretId;
  }

  function entry(secretId: string, patch: Partial<GitHubAppEntry> = {}): GitHubAppEntry {
    return {
      id: randomUUID(),
      name: "App A",
      appId: "101",
      privateKeySecretId: secretId,
      installationId: null,
      slug: null,
      roles: ["engineer"],
      agentIds: [],
      allowedRepos: ["owner-a/*"],
      ...patch,
    };
  }

  function rules(apps: GitHubAppEntry[], patch: Partial<GitHubSharedIdentitySettings> = {}): GitHubSharedIdentitySettings {
    return { ...defaultGitHubSharedIdentitySettings(), enabled: true, apps, ...patch };
  }

  async function installDedicated(input: Seeded) {
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const secretId = randomUUID();
    vaultState.values.set(secretId, DEDICATED_TOKEN);
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
      config: { sourceTemplateKey: "github" },
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
    return connectionId;
  }

  it("mints a single-repository installation token on the board, with the agent as author, audited without the token", async () => {
    const input = await seed();
    const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
    const app = entry(secretId);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([app]));
    const result = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    const token = "tok-a-repo-a";
    expect(result).toMatchObject({
      status: "available",
      source: "app",
      login: "App A",
      repository: "owner-a/repo-a",
      authenticationMode: "managed",
    });
    expect(result.env.GH_TOKEN).toBe(token);
    expect(result.env.GIT_AUTHOR_NAME).toBe("Agent A");
    expect(result.env.GIT_AUTHOR_EMAIL).toBe("agent-a@agents.myrmidon.invalid");
    expect(result.env.GIT_COMMITTER_EMAIL).toBe("agent-a@agents.myrmidon.invalid");

    // Discovered the installation, then asked for one repository and the minimal permissions, signed by App A.
    expect(github.calls.map((call) => [call.method, new URL(call.url).pathname, call.appId])).toEqual([
      ["GET", "/repos/owner-a/repo-a/installation", "101"],
      ["POST", "/app/installations/5001/access_tokens", "101"],
    ]);
    expect(github.calls[1]!.body).toEqual({
      repositories: ["repo-a"],
      permissions: { contents: "write", pull_requests: "write", metadata: "read" },
    });

    expect(vault.resolveSecretValue).toHaveBeenCalledWith(input.companyId, secretId, "latest", {
      accessContext: expect.objectContaining({
        consumerId: "workspace-git-credential",
        configPath: "github_app:owner-a/repo-a",
        actorId: input.agentId,
        heartbeatRunId: input.runId,
        issueId: input.issueId,
      }),
    });
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    const issued = activity.filter((row) => row.action === "myrmidon.github_app.issued");
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({ agentId: input.agentId, runId: input.runId, entityType: "github_app_identity" });
    expect(issued[0]!.details).toMatchObject({ repository: "owner-a/repo-a", entryId: app.id, appId: "101", installationId: "5001" });

    const contexts = await db.select().from(runIdentityContexts).where(eq(runIdentityContexts.runId, input.runId));
    expect(contexts.some((row) => row.github?.source === "app" && row.github.repository === "owner-a/repo-a")).toBe(true);
    for (const stored of [contexts, activity, await db.select().from(instanceSettings)]) {
      const text = JSON.stringify(stored);
      expect(text).not.toContain(token);
      expect(text).not.toContain("PRIVATE KEY");
    }

    // A second operation reuses the cached token without another GitHub call.
    github.calls = [];
    expect((await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" })).env.GH_TOKEN).toBe(token);
    expect(github.calls).toEqual([]);
  });

  it("separates products: product A under App A, product B under App B, neither absent, both an error", async () => {
    const input = await seed();
    const keyA = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a", "owner-a/overlap"] });
    const keyB = await registerApp(input, { appId: "202", key: KEY_B, installationId: "6002", tokenPrefix: "tok-b", repos: ["owner-b/app-b", "owner-a/overlap"] });
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([
        entry(keyA, { name: "App A", appId: "101", installationId: "5001", allowedRepos: ["owner-a/*"] }),
        entry(keyB, { name: "App B", appId: "202", installationId: "6002", allowedRepos: ["owner-b/*", "owner-a/overlap"] }),
      ]),
    );

    const a = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    expect(a).toMatchObject({ status: "available", source: "app", login: "App A" });
    expect(a.env.GH_TOKEN).toBe("tok-a-repo-a");

    const b = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-b/app-b" });
    expect(b).toMatchObject({ status: "available", source: "app", login: "App B" });
    expect(b.env.GH_TOKEN).toBe("tok-b-app-b");
    expect(github.calls.filter((call) => call.method === "POST").map((call) => [new URL(call.url).pathname, call.appId])).toEqual([
      ["/app/installations/5001/access_tokens", "101"],
      ["/app/installations/6002/access_tokens", "202"],
    ]);

    const neither = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-c/repo-c" });
    expect(neither).toMatchObject({ status: "absent", env: {} });

    vault.resolveSecretValue.mockClear();
    github.calls = [];
    const both = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/overlap" });
    expect(both).toMatchObject({ status: "unavailable", source: "app", env: {} });
    expect(both.reason).toMatch(/More than one GitHub App identity matches repository owner-a\/overlap/);
    expect(vault.resolveSecretValue).not.toHaveBeenCalled();
    expect(github.calls).toEqual([]);
  });

  it("fails closed when GitHub refuses, and stays absent outside the rules or without a repository", async () => {
    const input = await seed("designer");
    const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([entry(secretId)]));
    // Role not allowed.
    expect(await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }))
      .toMatchObject({ status: "absent", env: {} });

    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([entry(secretId, { roles: [], agentIds: [input.agentId] })]));
    // The App is not installed on this repository: GitHub answers 404, no token.
    const notInstalled = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/not-installed" });
    expect(notInstalled).toMatchObject({ status: "unavailable", source: "app", env: {} });
    expect(notInstalled.reason).toMatch(/HTTP 404/);
    const activity = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
    expect(activity.map((row) => row.action)).toContain("myrmidon.github_app.denied");

    // No repository named: no App identity.
    expect(await resolveGitHubOperationCredentials(db, input)).toMatchObject({ status: "absent", env: {} });

    // Switched off: absent, applied without a restart.
    await writeGitHubSharedIdentitySettings(
      db,
      input.companyId,
      rules([entry(secretId, { roles: [], agentIds: [input.agentId] })], { enabled: false }),
    );
    expect(await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }))
      .toMatchObject({ status: "absent", env: {} });
  });

  it("lets a dedicated per-agent grant win over an App", async () => {
    const input = await seed();
    const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
    await installDedicated(input);
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([entry(secretId)]));
    const result = await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" });
    expect(result).toMatchObject({ status: "available", source: "dedicated", login: "dedicated-a" });
    expect(result.env.GH_TOKEN).toBe(DEDICATED_TOKEN);
    expect(github.calls).toEqual([]);
  });

  it("ignores vendor cloud-connector GitHub connections while the vendor connector is off", async () => {
    const input = await seed();
    const connectionId = await installDedicated(input);
    await db
      .update(toolConnections)
      .set({ config: { sourceTemplateKey: "github", oauth: { strategy: "paperclip_cloud_connector", connectorProfile: "github.code" } } })
      .where(eq(toolConnections.id, connectionId));
    vi.stubEnv("MYRMIDON_GITHUB_VENDOR_CONNECTOR", "0");
    try {
      expect(await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId }))
        .toEqual({ configured: false });
      // Off: the App identity serves the agent instead.
      const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
      await writeGitHubSharedIdentitySettings(db, input.companyId, rules([entry(secretId)]));
      expect(await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }))
        .toMatchObject({ status: "available", source: "app" });
    } finally {
      vi.stubEnv("MYRMIDON_GITHUB_VENDOR_CONNECTOR", "1");
    }
    expect((await resolveManagedGitHubIdentitySelection(db, input.companyId, { agentId: input.agentId })).configured).toBe(true);
  });

  it("takes the repository from the broker request body", async () => {
    const input = await seed();
    const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
    await writeGitHubSharedIdentitySettings(db, input.companyId, rules([entry(secretId, { installationId: "5001" })]));
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
    expect(allowed.body).toMatchObject({ status: "available", source: "app", repository: "owner-a/repo-a" });
    expect(allowed.body.env.GH_TOKEN).toBe("tok-a-repo-a");
    const other = await request(app)
      .post("/runtime-tools/github/credentials")
      .set("x-paperclip-github-capability", token)
      .send({ repository: "owner-b/repo-b" });
    expect(other.body).toMatchObject({ status: "absent", env: {} });
  });

  describe("settings API", () => {
    function server(actor: Record<string, unknown>) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", myrmidonGitHubSharedIdentityRoutes(db));
      app.use(errorHandler);
      return app;
    }
    const operator = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };

    it("round-trips the rules through PUT and GET without secret values", async () => {
      const input = await seed();
      const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: ["owner-a/repo-a"] });
      const path = `/api/myrmidon/companies/${input.companyId}/github-shared-identity`;
      const initial = await request(server(operator)).get(path);
      expect(initial.status).toBe(200);
      expect(initial.body).toEqual({ settings: defaultGitHubSharedIdentitySettings(), vendorConnectorEnabled: true });

      const id = randomUUID();
      const body = {
        enabled: true,
        apps: [{
          id,
          name: "App A",
          appId: "101",
          privateKeySecretId: secretId,
          installationId: "5001",
          roles: ["engineer", "engineer"],
          agentIds: [input.agentId],
          allowedRepos: ["owner-a/repo-a", "OWNER-A/repo-a", "owner-a/service-*"],
        }],
        commitEmailDomain: "Example.com",
      };
      const saved = await request(server(operator)).put(path).send(body);
      expect(saved.status).toBe(200);
      const expected = {
        version: 1,
        enabled: true,
        // myrmidon(GITHUB-APP-MANIFEST): the manifest flow's slug defaults to
        // null on the manual path.
        apps: [{ ...body.apps[0], slug: null, roles: ["engineer"], allowedRepos: ["owner-a/repo-a", "owner-a/service-*"] }],
        commitEmailDomain: "example.com",
      };
      expect(saved.body.settings).toEqual(expected);
      const reread = await request(server(operator)).get(path);
      expect(reread.body.settings).toEqual(expected);
      expect(JSON.stringify(reread.body)).not.toContain("PRIVATE KEY");

      const journal = await db.select().from(activityLog).where(eq(activityLog.companyId, input.companyId));
      expect(journal.map((row) => row.action)).toContain("myrmidon.github_app.settings_saved");
      expect(await resolveGitHubOperationCredentials(db, { ...input, repository: "owner-a/repo-a" }))
        .toMatchObject({ status: "available", source: "app" });
    });

    it("rejects foreign secrets and agents, wide patterns, key material and callers without the permission", async () => {
      const input = await seed();
      const secretId = await registerApp(input, { appId: "101", key: KEY_A, installationId: "5001", tokenPrefix: "tok-a", repos: [] });
      const other = await seed();
      const otherSecret = await registerApp(other, { appId: "202", key: KEY_B, installationId: "6002", tokenPrefix: "tok-b", repos: [] });
      const path = `/api/myrmidon/companies/${input.companyId}/github-shared-identity`;
      const app = { id: randomUUID(), name: "App A", appId: "101", privateKeySecretId: secretId, installationId: null, roles: ["engineer"], agentIds: [], allowedRepos: ["owner-a/repo-a"] };
      const base = { enabled: true, apps: [app], commitEmailDomain: null };
      const withApp = (patch: Record<string, unknown>) => ({ ...base, apps: [{ ...app, ...patch }] });
      expect((await request(server(operator)).put(path).send(withApp({ privateKeySecretId: otherSecret }))).status).toBe(422);
      expect((await request(server(operator)).put(path).send(withApp({ agentIds: [other.agentId] }))).status).toBe(422);
      expect((await request(server(operator)).put(path).send(withApp({ allowedRepos: ["*/*"] }))).status).toBe(400);
      expect((await request(server(operator)).put(path).send(withApp({ appId: "not-a-number" }))).status).toBe(400);
      expect((await request(server(operator)).put(path).send(withApp({ privateKey: KEY_A.privatePem }))).status).toBe(400);
      expect((await request(server(operator)).put(path).send({ ...base, apps: [app, app] })).status).toBe(400);

      const member = { type: "board", source: "session", userId: "user-without-permission", isInstanceAdmin: false, companyIds: [input.companyId] };
      expect((await request(server(member)).put(path).send(base)).status).toBe(403);
      const agentActor = { type: "agent", source: "agent_key", agentId: input.agentId, companyId: input.companyId };
      expect((await request(server(agentActor)).get(path)).status).toBe(403);
      expect((await request(server(agentActor)).put(path).send(base)).status).toBe(403);
      expect((await request(server(operator)).get(path)).body.settings).toEqual(defaultGitHubSharedIdentitySettings());
    });
  });
});
