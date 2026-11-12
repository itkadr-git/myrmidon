// Stack registry (SUA, part B): the read-only GitHub App fallback for the
// release check (STACK-WATCH-LIVE, OPE-12141). Tests for the token resolution
// and the fallback port. No live network: fetch is injected through the check
// options, the secret vault is mocked.
import { createPublicKey, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDb, companies, companySecrets, instanceSettings } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  findStackCheckAppEntries,
  resolveStackCheckGitHubAppToken,
  STACK_CHECK_SYSTEM_ROLE,
} from "./github-app.js";
import { checkStackReleases, extractGithubApiRepo } from "./check.js";
import {
  seedStackDocument,
  type StackDocument,
  type StackReleaseSource,
  type StackSnapshot,
} from "./domain.js";
import { writeStackDocument } from "./store.js";
import {
  DEFAULT_GITHUB_APP_PERMISSIONS,
  resetGitHubAppTokenCacheForTests,
} from "../github-shared-identity/app-token.js";
import { writeGitHubSharedIdentitySettings } from "../github-shared-identity/store.js";
import {
  defaultGitHubSharedIdentitySettings,
  type GitHubAppEntry,
  type GitHubSharedIdentitySettings,
} from "../github-shared-identity/settings.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const vaultState = vi.hoisted(() => ({ values: new Map<string, string>() }));
const vault = vi.hoisted(() => ({
  resolveSecretValue: vi.fn(
    async (_companyId: string, secretId: string) => vaultState.values.get(secretId) ?? "unknown-secret",
  ),
  resolveUserSecretValue: vi.fn(async () => ({ value: "test-user-token" })),
}));
vi.mock("../../services/secrets.js", () => ({ secretService: () => vault }));

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
  };
}
const KEY_A = keyPair();

type GitHubCall = { method: string; url: string; auth: string; body: unknown };
const githubCalls: GitHubCall[] = [];
const githubApps = new Map<string, { publicPem: string; installationId: string; tokenPrefix: string; repos: string[] }>();

/** Verify a GitHub App JWT and return the App id, null when invalid. */
function verifyJwt(jwt: string): string | null {
  const [header, payload, signature] = jwt.split(".");
  if (!header || !payload || !signature) return null;
  let iss: string | undefined;
  try {
    iss = (JSON.parse(Buffer.from(payload, "base64url").toString()) as { iss?: string }).iss;
  } catch {
    return null;
  }
  const app = iss ? githubApps.get(iss) : undefined;
  if (!app || !iss) return null;
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  return verifier.verify(createPublicKey(app.publicPem), Buffer.from(signature, "base64url")) ? iss : null;
}

interface FakeReleaseRoute {
  status: number;
  json: unknown;
}

/**
 * A fake GitHub API over the injected fetch. App JWT-signed calls serve the
 * installation/token endpoints for registered Apps; a minted App token or a
 * known PAT reading a release route is served from `releaseRoutes`; an
 * anonymous request without a route hits the exhausted shared-IP budget (403).
 */
function fakeGithubFetch(
  releaseRoutes: Record<string, FakeReleaseRoute> = {},
  options: { patToken?: string } = {},
): typeof fetch {
  return async (url: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const href = String(url);
    const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
    let body: unknown = null;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = null;
      }
    }
    githubCalls.push({ method: init?.method ?? "GET", url: href, auth, body });
    const serveRoute = (): Response => {
      const key = Object.keys(releaseRoutes).find((candidate) => href.includes(candidate));
      return key
        ? Response.json(releaseRoutes[key]!.json satisfies unknown, { status: releaseRoutes[key]!.status })
        : new Response("", { status: options.patToken && auth === `Bearer ${options.patToken}` ? 404 : 403 });
    };
    if (!auth.startsWith("Bearer ")) return serveRoute();
    if (options.patToken && auth === `Bearer ${options.patToken}`) return serveRoute();
    const appId = verifyJwt(auth.replace(/^Bearer /, ""));
    if (!appId) return new Response("", { status: 401 });
    const app = githubApps.get(appId)!;
    const installation = /\/repos\/([^/]+)\/([^/]+)\/installation$/.exec(href);
    if (installation) {
      const full = `${installation[1]}/${installation[2]}`;
      return app.repos.includes(full) ? Response.json({ id: Number(app.installationId) }) : new Response("", { status: 404 });
    }
    if (/\/app\/installations\/\d+\/access_tokens$/.test(href)) {
      const repo = ((body as { repositories?: string[] } | null)?.repositories ?? ["repo"])[0] ?? "repo";
      return Response.json(
        { token: `${app.tokenPrefix}-${repo}`, expires_at: new Date(Date.now() + 3600_000).toISOString() },
        { status: 201 },
      );
    }
    return serveRoute();
  };
}

describe("stack check: github api repo extraction", () => {
  it("extracts owner/repo from GitHub REST urls and refuses everything else", () => {
    expect(extractGithubApiRepo("https://api.github.com/repos/owner-a/repo-a/releases?per_page=30")).toBe("owner-a/repo-a");
    expect(extractGithubApiRepo("https://api.github.com/repos/owner-a/repo-a/compare/v1...v2")).toBe("owner-a/repo-a");
    expect(extractGithubApiRepo("https://api.github.com/repos/owner-a/repo-a")).toBe("owner-a/repo-a");
    expect(extractGithubApiRepo("https://api.github.com/rate_limit")).toBeNull();
    expect(extractGithubApiRepo("https://api.osv.dev/v1/querybatch")).toBeNull();
    expect(extractGithubApiRepo("https://api.github.com/repos/only-owner")).toBeNull();
  });
});

describeEmbeddedPostgres("stack check github app fallback", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const companyId = randomUUID();
  const secretId = randomUUID();

  const seedEntry = (patch: Partial<GitHubAppEntry> = {}): GitHubAppEntry => ({
    id: randomUUID(),
    name: "Stack App",
    appId: "901",
    privateKeySecretId: secretId,
    installationId: null,
    slug: null,
    roles: [STACK_CHECK_SYSTEM_ROLE],
    agentIds: [],
    allowedRepos: ["langfuse/*"],
    permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS },
    ...patch,
  });

  const rules = (apps: GitHubAppEntry[], patch: Partial<GitHubSharedIdentitySettings> = {}): GitHubSharedIdentitySettings => ({
    ...defaultGitHubSharedIdentitySettings(),
    enabled: true,
    apps,
    ...patch,
  });

  const langfuseReleases = () => [
    { tag_name: "3.2.0", published_at: "2026-09-28T00:00:00Z", body: "Routine release." },
  ];

  const documentWithOnlyCheckable = (githubCheckable: string): StackDocument => {
    const doc = seedStackDocument();
    return {
      ...doc,
      components: doc.components.map((component): StackSnapshot =>
        component.name === githubCheckable
          ? component
          : {
              ...component,
              releaseSource: "manual" as StackReleaseSource,
              upstream: { kind: "manual" },
            },
      ),
    };
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stack-check-app-");
    db = createDb(tempDb.connectionString);
    await db.insert(companies).values({ id: companyId, name: "Stack Check Co", issuePrefix: "SC" });
    await db.insert(companySecrets).values({ id: secretId, companyId, key: secretId, name: `App key ${secretId}`, scope: "company" });
    vaultState.values.set(secretId, KEY_A.privatePem);
    githubApps.set("901", {
      publicPem: KEY_A.publicPem,
      installationId: "7001",
      tokenPrefix: "ghs-stack",
      repos: ["langfuse/langfuse"],
    });
  }, 60_000);

  afterEach(async () => {
    resetGitHubAppTokenCacheForTests();
    githubCalls.length = 0;
    vi.unstubAllEnvs();
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("finds the system-role App entry for the component repository, none outside allowedRepos", async () => {
    const entry = seedEntry();
    await writeGitHubSharedIdentitySettings(db, companyId, rules([entry]));
    const matches = await findStackCheckAppEntries(db, "langfuse/langfuse");
    expect(matches).toHaveLength(1);
    expect(matches[0]!.companyId).toBe(companyId);
    expect(matches[0]!.entry.id).toBe(entry.id);
    expect(await findStackCheckAppEntries(db, "weird/repo")).toHaveLength(0);
  });

  it("mints a strictly read-only installation token signed by the App", async () => {
    await writeGitHubSharedIdentitySettings(db, companyId, rules([seedEntry()]));
    const fetchImpl = fakeGithubFetch();
    const resolution = await resolveStackCheckGitHubAppToken(db, "langfuse/langfuse", { fetchImpl });
    expect(resolution).toMatchObject({ kind: "issued", repository: "langfuse/langfuse", appId: "901", installationId: "7001" });
    const mint = githubCalls.find((call) => call.url.endsWith("/access_tokens"));
    expect(mint).toBeTruthy();
    expect(mint!.auth.startsWith("Bearer ")).toBe(true);
    expect(verifyJwt(mint!.auth.replace(/^Bearer /, ""))).toBe("901");
    const mintBody = mint!.body as { repositories: string[]; permissions: Record<string, string> };
    expect(mintBody.repositories).toEqual(["langfuse"]);
    expect(mintBody.permissions.metadata).toBe("read");
    expect(mintBody.permissions.contents).toBe("read");
    expect(mintBody.permissions.pull_requests).toBeUndefined();
    expect(mintBody.permissions.issues).toBeUndefined();
  });

  it("answers an ambiguous or absent App configuration with anonymous reads", async () => {
    const ambiguousSettings = rules([
      seedEntry({ id: randomUUID(), name: "App A", appId: "901" }),
      seedEntry({ id: randomUUID(), name: "App B", appId: "902" }),
    ]);
    await writeGitHubSharedIdentitySettings(db, companyId, ambiguousSettings);
    const ambiguous = await resolveStackCheckGitHubAppToken(db, "langfuse/langfuse", { fetchImpl: fakeGithubFetch() });
    expect(ambiguous.kind).toBe("ambiguous");

    await db.delete(instanceSettings);
    const absent = await resolveStackCheckGitHubAppToken(db, "langfuse/langfuse", { fetchImpl: fakeGithubFetch() });
    expect(absent.kind).toBe("not_applicable");
    expect(githubCalls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
  });

  it("the check authenticates GitHub reads with the App token when no instance token is set", async () => {
    await writeGitHubSharedIdentitySettings(db, companyId, rules([seedEntry()]));
    await writeStackDocument(db, documentWithOnlyCheckable("langfuse"));
    const fetchImpl = fakeGithubFetch({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    const next = await checkStackReleases(db, { now: () => new Date("2026-10-02T03:00:00.000Z"), retryDelayMs: 0, collect: false, githubAppFetchImpl: fetchImpl });
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState).toMatchObject({ latest: "3.2.0", error: null });
    const mint = githubCalls.find((call) => call.url.endsWith("/access_tokens"));
    expect(mint).toBeTruthy();
    const releaseCall = githubCalls.find((call) => call.url.includes("repos/langfuse/langfuse/releases"));
    expect(releaseCall!.auth).toBe("Bearer ghs-stack-langfuse");
  });

  it("the explicit instance token wins: no App mint, the PAT rides the release call", async () => {
    vi.stubEnv("MYRMIDON_STACK_GITHUB_TOKEN", "pat-stack-check");
    await writeGitHubSharedIdentitySettings(db, companyId, rules([seedEntry()]));
    await writeStackDocument(db, documentWithOnlyCheckable("langfuse"));
    const fetchImpl = fakeGithubFetch({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } }, { patToken: "pat-stack-check" });
    const next = await checkStackReleases(db, { now: () => new Date("2026-10-02T03:00:00.000Z"), retryDelayMs: 0, collect: false, githubAppFetchImpl: fetchImpl });
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState).toMatchObject({ latest: "3.2.0", error: null });
    expect(githubCalls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
    const releaseCall = githubCalls.find((call) => call.url.includes("repos/langfuse/langfuse/releases"));
    expect(releaseCall!.auth).toBe("Bearer pat-stack-check");
  });

  it("without any App entry the check reads anonymously: a 403 marks the component stale, no mint", async () => {
    await writeGitHubSharedIdentitySettings(db, companyId, rules([]));
    await writeStackDocument(db, documentWithOnlyCheckable("langfuse"));
    const fetchImpl = fakeGithubFetch();
    const next = await checkStackReleases(db, { now: () => new Date("2026-10-02T03:00:00.000Z"), retryDelayMs: 0, collect: false, githubAppFetchImpl: fetchImpl });
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState?.error).toBe("github 403");
    expect(langfuse.upstreamState?.latest).toBeNull();
    expect(githubCalls.some((call) => call.url.endsWith("/access_tokens"))).toBe(false);
  });
});
