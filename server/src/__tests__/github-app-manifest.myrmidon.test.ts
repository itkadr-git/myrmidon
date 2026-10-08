// myrmidon(GITHUB-APP-MANIFEST): the GitHub App Manifest flow, end to end
// over embedded postgres — one-click registration of a self-hosted GitHub App
// from the company settings, the browser callback that vaults the key, and
// the one-click install URL.
//
// Pins:
//   - begin: the user/org form URLs and the manifest fields (public=false,
//     webhooks off, exactly contents/pull_requests write + metadata read, the
//     callback URL on the instance's public base URL with the company id) and
//     an unguessable anti-CSRF `state`;
//   - callback: a successful conversion vaults the private key as a company
//     secret (the key is in NEITHER the redirect, the activity log nor the
//     stored rules), adds the App entry with appId/slug/privateKeySecretId
//     and answers 302 with `github_app_created=1`;
//   - callback: GitHub's 422 (name conflict) answers 302 with
//     `github_app_error`, creates NO secret and leaves the rules untouched;
//   - callback: a code without the live `state` `begin` issued for this
//     company and actor — missing, unknown, already used, or issued for
//     another actor — is refused with `github_app_error` and GitHub is never
//     called;
//   - callback without a code, and every route for a foreign company or a
//     caller without the permission, is refused;
//   - install: the slug of the entry yields its installations/new URL; an
//     entry without a slug (manual path) answers 4xx with a clear message.

import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { activityLog, companies, companySecrets, createDb, instanceSettings } from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { myrmidonGitHubSharedIdentityRoutes } from "../myrmidon/github-shared-identity/index.js";
import { defaultGitHubSharedIdentitySettings } from "../myrmidon/github-shared-identity/settings.js";
import { readGitHubSharedIdentitySettings, writeGitHubSharedIdentitySettings } from "../myrmidon/github-shared-identity/store.js";
import { GITHUB_APP_MANIFEST_DEFAULT_DESCRIPTION } from "../myrmidon/github-shared-identity/app-manifest.js";

const PUBLIC_BASE = "https://board.example.com";
const PEM = "-----BEGIN PRIVATE KEY-----\nmanifest-flow-test-key-material\n-----END PRIVATE KEY-----\n";

type ConversionOutcome =
  | { status: 201; body: Record<string, unknown> }
  | { status: number; body: string };

const github = {
  conversions: [] as string[],
  outcome: {
    status: 201,
    body: { id: 424242, slug: "my-app-x", name: "App X", pem: PEM, html_url: "https://github.com/apps/my-app-x" },
  } as ConversionOutcome,
};

const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  const conversion = /\/app-manifests\/([^/]+)\/conversions$/.exec(href);
  if (conversion && init?.method === "POST") {
    github.conversions.push(decodeURIComponent(conversion[1]!));
    if (github.outcome.status === 201) return Response.json(github.outcome.body, { status: 201 });
    return new Response(github.outcome.body as string, { status: github.outcome.status });
  }
  return new Response("{}", { status: 404 });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("GitHub App manifest flow", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-app-manifest-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  beforeEach(() => {
    vi.stubGlobal("fetch", fakeFetch);
    vi.stubEnv("PAPERCLIP_PUBLIC_URL", PUBLIC_BASE);
    github.conversions = [];
    github.outcome = {
      status: 201,
      body: { id: 424242, slug: "my-app-x", name: "App X", pem: PEM, html_url: "https://github.com/apps/my-app-x" },
    };
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  async function seed() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    return { companyId };
  }

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
  const path = (companyId: string) => `/api/myrmidon/companies/${companyId}/github-shared-identity`;

  describe("begin", () => {
    it("builds the user-owned form URL, the pinned manifest fields and an unguessable state", async () => {
      const { companyId } = await seed();
      const res = await request(server(operator))
        .post(`${path(companyId)}/app-manifest/begin`)
        .send({ ownerKind: "user", name: "My App" });
      expect(res.status).toBe(200);
      expect(res.body.manifestUrl).toBe("https://github.com/settings/apps/new");
      expect(res.body.manifest).toEqual({
        name: "My App",
        description: GITHUB_APP_MANIFEST_DEFAULT_DESCRIPTION,
        url: PUBLIC_BASE,
        public: false,
        hook_attributes: { active: false },
        default_permissions: { contents: "write", pull_requests: "write", metadata: "read" },
        redirect_url: `${PUBLIC_BASE}/api/myrmidon/companies/${companyId}/github-shared-identity/app-manifest/callback`,
      });
      expect(res.body.state).toEqual(expect.any(String));
      expect(res.body.state.length).toBeGreaterThanOrEqual(32);
    });

    it("builds the org-owned form URL and accepts an editable description", async () => {
      const { companyId } = await seed();
      const res = await request(server(operator))
        .post(`${path(companyId)}/app-manifest/begin`)
        .send({ ownerKind: "org", orgLogin: "acme-robotics", name: "My App", description: "Our own words." });
      expect(res.status).toBe(200);
      expect(res.body.manifestUrl).toBe("https://github.com/organizations/acme-robotics/settings/apps/new");
      expect(res.body.manifest.description).toBe("Our own words.");
      expect(res.body.manifest.name).toBe("My App");
    });

    it("rejects an org without a login, a bad login, a long name and extra fields", async () => {
      const { companyId } = await seed();
      const begin = (body: Record<string, unknown>) =>
        request(server(operator)).post(`${path(companyId)}/app-manifest/begin`).send(body);
      expect((await begin({ ownerKind: "org", name: "My App" })).status).toBe(400);
      expect((await begin({ ownerKind: "org", orgLogin: "not a login!", name: "My App" })).status).toBe(400);
      expect((await begin({ ownerKind: "user", name: "x".repeat(101) })).status).toBe(400);
      expect((await begin({ ownerKind: "user", name: "My App", privateKey: "nope" })).status).toBe(400);
    });
  });

  describe("callback", () => {
    // The callback only converts a code carrying the `state` begin issued for
    // this company and actor; every test below begins the flow first.
    async function beginState(companyId: string, actor: Record<string, unknown> = operator): Promise<string> {
      const res = await request(server(actor))
        .post(`${path(companyId)}/app-manifest/begin`)
        .send({ ownerKind: "user", name: "My App" });
      expect(res.status).toBe(200);
      return res.body.state as string;
    }

    it("vaults the key, registers the App and redirects with github_app_created=1", async () => {
      const { companyId } = await seed();
      const state = await beginState(companyId);
      const res = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=one-time-code&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(`${PUBLIC_BASE}/company/settings?github_app_created=1#github-shared-identity`);
      expect(github.conversions).toEqual(["one-time-code"]);

      // The key is a company secret; the entry points at it and holds the slug.
      const settings = await readGitHubSharedIdentitySettings(db, companyId);
      expect(settings.apps).toHaveLength(1);
      const entry = settings.apps[0]!;
      expect(entry).toMatchObject({ name: "App X", appId: "424242", slug: "my-app-x", installationId: null, roles: [], agentIds: [], allowedRepos: [] });
      const [secret] = await db.select().from(companySecrets).where(eq(companySecrets.id, entry.privateKeySecretId));
      expect(secret).toMatchObject({ companyId, scope: "company", provider: "local_encrypted" });

      // The key is nowhere: not the redirect, not the journal, not the rules.
      expect(res.headers.location).not.toContain("PRIVATE KEY");
      expect(res.text ?? "").not.toContain("PRIVATE KEY");
      const journal = await db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
      expect(journal.map((row) => row.action)).toContain("myrmidon.github_app.settings_saved");
      expect(JSON.stringify(journal)).not.toContain("PRIVATE KEY");
      const settingsRows = await db.select().from(instanceSettings);
      expect(JSON.stringify(settingsRows)).not.toContain("PRIVATE KEY");
    });

    it("redirects with github_app_error on GitHub's 422 and stores nothing", async () => {
      const { companyId } = await seed();
      const state = await beginState(companyId);
      github.outcome = { status: 422, body: JSON.stringify({ message: "name already exists", pem: "SHOULD-NOT-LEAK" }) };
      const res = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=taken-name-code&state=${state}`);
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location as string);
      expect(location.searchParams.get("github_app_error")).toMatch(/name is likely taken/);
      expect(res.headers.location).not.toContain("SHOULD-NOT-LEAK");

      expect(await readGitHubSharedIdentitySettings(db, companyId)).toEqual(defaultGitHubSharedIdentitySettings());
      const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(secrets).toEqual([]);
    });

    it("redirects with github_app_error when the code is missing", async () => {
      const { companyId } = await seed();
      const state = await beginState(companyId);
      const res = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("github_app_error=");
      expect(github.conversions).toEqual([]);
    });

    it("refuses a callback without a state, with an unknown state, and with a used state — GitHub is never called", async () => {
      const { companyId } = await seed();
      // No state at all.
      const noState = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=forged-code`);
      expect(noState.status).toBe(302);
      expect(noState.headers.location).toContain("github_app_error=");
      // A state that begin never issued.
      const unknown = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=forged-code&state=${"f".repeat(64)}`);
      expect(unknown.status).toBe(302);
      expect(unknown.headers.location).toContain("github_app_error=");
      // A real state, spent once — a replay of the callback URL must not convert again.
      const state = await beginState(companyId);
      expect((await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=one-time-code&state=${state}`)).status).toBe(302);
      const replay = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=one-time-code&state=${state}`);
      expect(replay.status).toBe(302);
      expect(replay.headers.location).toContain("github_app_error=");
      expect(github.conversions).toEqual(["one-time-code"]);
      const secrets = await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId));
      expect(secrets).toHaveLength(1);
    });

    it("refuses a state issued for another actor of the same company", async () => {
      const { companyId } = await seed();
      const otherOperator = { type: "board", source: "local_implicit", userId: "another-local-board", isInstanceAdmin: true };
      const state = await beginState(companyId, otherOperator);
      const res = await request(server(operator)).get(`${path(companyId)}/app-manifest/callback?code=forged-code&state=${state}`);
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("github_app_error=");
      expect(github.conversions).toEqual([]);
    });
  });

  describe("install", () => {
    async function seedEntry(companyId: string, slug: string | null) {
      const secretId = randomUUID();
      await db.insert(companySecrets).values({ id: secretId, companyId, key: secretId, name: `App key ${secretId}`, scope: "company" });
      const entryId = randomUUID();
      const settings = await readGitHubSharedIdentitySettings(db, companyId);
      const next = {
        ...settings,
        enabled: true,
        apps: [
          ...settings.apps,
          {
            id: entryId,
            name: "App X",
            appId: "424242",
            slug,
            privateKeySecretId: secretId,
            installationId: null,
            roles: [],
            agentIds: [],
            allowedRepos: [],
          },
        ],
      };
      await writeGitHubSharedIdentitySettings(db, companyId, next);
      return entryId;
    }

    it("returns the installations/new URL of the entry's slug", async () => {
      const { companyId } = await seed();
      const entryId = await seedEntry(companyId, "my-app-x");
      const res = await request(server(operator)).get(`${path(companyId)}/apps/${entryId}/install`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ installUrl: "https://github.com/apps/my-app-x/installations/new" });
    });

    it("answers 4xx with a clear message when the entry has no slug (manual path)", async () => {
      const { companyId } = await seed();
      const entryId = await seedEntry(companyId, null);
      const res = await request(server(operator)).get(`${path(companyId)}/apps/${entryId}/install`);
      expect(res.status).toBe(422);
      expect(JSON.stringify(res.body)).toMatch(/no GitHub app slug/);
    });

    it("answers 404 for an unknown entry", async () => {
      const { companyId } = await seed();
      const res = await request(server(operator)).get(`${path(companyId)}/apps/${randomUUID()}/install`);
      expect(res.status).toBe(404);
    });
  });

  describe("access rules", () => {
    it("refuses callers without the permission, agents, and foreign companies", async () => {
      const { companyId } = await seed();
      const other = await seed();
      const member = { type: "board", source: "session", userId: "user-without-permission", isInstanceAdmin: false, companyIds: [companyId] };
      const agentActor = { type: "agent", source: "agent_key", agentId: randomUUID(), companyId };
      const foreign = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: [other.companyId] };

      expect((await request(server(member)).post(`${path(companyId)}/app-manifest/begin`).send({ ownerKind: "user", name: "App" })).status).toBe(403);
      expect((await request(server(agentActor)).get(`${path(companyId)}/app-manifest/callback?code=x`)).status).toBe(403);
      expect((await request(server(agentActor)).get(`${path(companyId)}/apps/${randomUUID()}/install`)).status).toBe(403);
      expect((await request(server(foreign)).post(`${path(companyId)}/app-manifest/begin`).send({ ownerKind: "user", name: "App" })).status).toBe(403);
      expect((await request(server(foreign)).get(`${path(companyId)}/app-manifest/callback?code=x`)).status).toBe(403);
      expect(github.conversions).toEqual([]);
    });
  });
});
