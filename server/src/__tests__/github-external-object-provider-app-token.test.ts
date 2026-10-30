import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secretMocks = vi.hoisted(() => ({
  getByName: vi.fn(),
  resolveSecretValue: vi.fn(),
}));
const settingsMock = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("../services/secrets.js", () => ({
  secretService: () => ({
    getByName: secretMocks.getByName,
    resolveSecretValue: secretMocks.resolveSecretValue,
  }),
}));
vi.mock("../myrmidon/github-shared-identity/store.js", () => ({
  readGitHubSharedIdentitySettings: settingsMock.read,
}));

import { createGitHubExternalObjectProvider } from "../services/github-external-object-provider.js";
import { createPullRequestMergeDetailsResolver } from "../services/github-pull-request-merge.js";
import { resetGitHubAppTokenCacheForTests } from "../myrmidon/github-shared-identity/app-token.js";

const COMPANY = "company-1";
const PRIVATE_REPO = "itkadr-git/myrmidon-deploy";
const APP_TOKEN = "ghs_installation_token_value";
const PAT_TOKEN = "ghp_named_secret_token_value";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

function appEntry(id: string, allowedRepos: string[]) {
  return {
    id,
    name: `app-${id}`,
    appId: "5206456",
    privateKeySecretId: `key-secret-${id}`,
    installationId: null,
    slug: null,
    roles: [],
    agentIds: [],
    allowedRepos,
  };
}

function settings(apps: ReturnType<typeof appEntry>[], enabled = true) {
  return { enabled, apps, pats: [], commitEmailDomain: null };
}

function fakeDb(keyRows: unknown[] = [{ id: "key-secret-a" }]) {
  return { select: vi.fn(() => ({ from: () => ({ where: async () => keyRows }) })) } as never;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const mergedPr = {
  title: "module change",
  state: "closed",
  merged: true,
  merged_at: "2026-10-21T00:00:00Z",
  updated_at: "2026-10-21T00:00:00Z",
  head: { ref: "feature", sha: "abc123" },
  base: { ref: "main" },
};

/** Fake GitHub: private repo needs the App token; everything else is 404 without it. */
function githubFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (path === "/repos/itkadr-git/myrmidon-deploy/installation") return json({ id: 77 });
    if (path === "/app/installations/77/access_tokens") {
      return json({ token: APP_TOKEN, expires_at: new Date(Date.now() + 3600_000).toISOString() }, 201);
    }
    if (path === "/repos/itkadr-git/myrmidon-deploy/pulls/63") {
      return headers.authorization === `Bearer ${APP_TOKEN}` || headers.authorization === `Bearer ${PAT_TOKEN}`
        ? json(mergedPr)
        : json({ message: "Not Found" }, 404);
    }
    return json({ message: "Not Found" }, 404);
  });
}

function prObject(repository = PRIVATE_REPO, number = 63) {
  return {
    externalId: `${repository.toLowerCase()}#pull/${number}`,
    sanitizedCanonicalUrl: `https://github.com/${repository}/pull/${number}`,
  } as never;
}

function prResolver(fetch: ReturnType<typeof githubFetch>) {
  const provider = createGitHubExternalObjectProvider(fakeDb(), { fetch });
  return provider.resolvers.find((entry) => entry.objectType === "pull_request")!;
}

function calls(fetch: ReturnType<typeof githubFetch>, path: string) {
  return fetch.mock.calls.filter(([url]) => new URL(String(url)).pathname === path);
}

beforeEach(() => {
  resetGitHubAppTokenCacheForTests();
  secretMocks.getByName.mockReset().mockResolvedValue(null);
  secretMocks.resolveSecretValue.mockReset().mockResolvedValue(PEM);
  settingsMock.read.mockReset().mockResolvedValue(settings([appEntry("a", [PRIVATE_REPO])]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("GitHub external object resolver: shared-identity App token", () => {
  it("reads a private repository PR with a read-only installation token of the company App", async () => {
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(result).toEqual({
      ok: true,
      snapshot: expect.objectContaining({
        statusKey: "merged",
        data: expect.objectContaining({ merged: true, headSha: "abc123" }),
      }),
    });
    const [mintCall] = calls(fetch, "/app/installations/77/access_tokens");
    expect(JSON.parse(String((mintCall![1] as RequestInit).body))).toEqual({
      repositories: ["myrmidon-deploy"],
      permissions: { metadata: "read", contents: "read", pull_requests: "read" },
    });
    const [prCall] = calls(fetch, "/repos/itkadr-git/myrmidon-deploy/pulls/63");
    expect((prCall![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${APP_TOKEN}` });
  });

  it("reads the App key and the named secret as the system consumer", async () => {
    await prResolver(githubFetch()).resolve({ companyId: COMPANY, object: prObject() });

    expect(secretMocks.resolveSecretValue).toHaveBeenCalledWith(
      COMPANY,
      "key-secret-a",
      "latest",
      { accessContext: expect.objectContaining({ consumerType: "system", consumerId: "github-external-object-resolver" }) },
    );
  });

  it("caches the installation token between resolutions", async () => {
    const fetch = githubFetch();
    const resolver = prResolver(fetch);
    await resolver.resolve({ companyId: COMPANY, object: prObject() });
    await resolver.resolve({ companyId: COMPANY, object: prObject() });

    expect(calls(fetch, "/app/installations/77/access_tokens")).toHaveLength(1);
    expect(calls(fetch, "/repos/itkadr-git/myrmidon-deploy/pulls/63")).toHaveLength(2);
  });

  it("prefers the named company secret over the App", async () => {
    secretMocks.getByName.mockImplementation(async (_company: string, name: string) => (name === "GITHUB_TOKEN" ? { id: "pat" } : null));
    secretMocks.resolveSecretValue.mockResolvedValue(PAT_TOKEN);
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(result.ok).toBe(true);
    expect(calls(fetch, "/app/installations/77/access_tokens")).toHaveLength(0);
    const [prCall] = calls(fetch, "/repos/itkadr-git/myrmidon-deploy/pulls/63");
    expect((prCall![1] as RequestInit).headers).toMatchObject({ authorization: `Bearer ${PAT_TOKEN}` });
  });

  it.each([
    ["no App allows the repository", settings([appEntry("a", ["itkadr-git/other"])])],
    ["the shared identity is disabled", settings([appEntry("a", [PRIVATE_REPO])], false)],
  ])("stays anonymous when %s", async (_name, stored) => {
    settingsMock.read.mockResolvedValue(stored);
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(calls(fetch, "/app/installations/77/access_tokens")).toHaveLength(0);
    const [prCall] = calls(fetch, "/repos/itkadr-git/myrmidon-deploy/pulls/63");
    expect((prCall![1] as RequestInit).headers).not.toHaveProperty("authorization");
    expect(result).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "not_found" }) });
  });

  it("fails closed when two Apps allow the repository: no token minted, no request sent", async () => {
    settingsMock.read.mockResolvedValue(settings([appEntry("a", [PRIVATE_REPO]), appEntry("b", ["itkadr-git/*"])]));
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(result).toMatchObject({ ok: false, errorCode: "github_token_unavailable" });
    expect(fetch).not.toHaveBeenCalled();
    expect(secretMocks.resolveSecretValue).not.toHaveBeenCalled();
  });

  it("falls back to anonymous when the App key cannot be read", async () => {
    secretMocks.resolveSecretValue.mockRejectedValue(new Error(`boom ${PEM}`));
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    expect(result).toEqual({ ok: true, snapshot: expect.objectContaining({ statusKey: "not_found" }) });
    expect(JSON.stringify(result)).not.toContain("BEGIN");
  });

  it("never puts the token or the key into logs or results", async () => {
    const sinks = (["log", "info", "warn", "error", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => undefined));
    const fetch = githubFetch();
    const result = await prResolver(fetch).resolve({ companyId: COMPANY, object: prObject() });

    const output = JSON.stringify([result, ...sinks.map((sink) => sink.mock.calls)]);
    expect(output).not.toContain(APP_TOKEN);
    expect(output).not.toContain("BEGIN");
  });
});

describe("pull request merge details for a private repository", () => {
  const reference = { host: "github.com", owner: "itkadr-git", repo: "myrmidon-deploy", number: 63 } as const;

  it("reports merged when the company App can read the repository", async () => {
    vi.stubGlobal("fetch", githubFetch());
    const details = await createPullRequestMergeDetailsResolver(fakeDb())(COMPANY, reference);

    expect(details).toMatchObject({ state: "merged", workProductState: "merged", headSha: "abc123", baseRef: "main" });
    expect(details.access).toBeUndefined();
  });

  it("reports access denied (not an open PR) when nothing grants access", async () => {
    settingsMock.read.mockResolvedValue(settings([]));
    vi.stubGlobal("fetch", githubFetch());
    const details = await createPullRequestMergeDetailsResolver(fakeDb())(COMPANY, reference);

    expect(details).toMatchObject({ state: "unknown", access: "denied" });
    expect(details.workProductState).toBeUndefined();
  });

  it("reports access denied when GitHub rejects the credentials", async () => {
    settingsMock.read.mockResolvedValue(settings([]));
    vi.stubGlobal("fetch", vi.fn(async () => json({ message: "Forbidden" }, 403)));
    const details = await createPullRequestMergeDetailsResolver(fakeDb())(COMPANY, reference);

    expect(details).toMatchObject({ state: "unknown", access: "denied" });
  });
});
