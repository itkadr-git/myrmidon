// Stack registry (SUA, part B) tests: the release check against injected
// sources, the patch-closed rule over the compare API, the attention cards and
// the route permissions. No live network: the JSON port is injected.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceSettings } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { errorHandler } from "../../middleware/index.js";
import { checkStackReleases, startStackCheckSweep } from "./check.js";
import { collectStackLocal, type DockerImagesPort } from "./collector.js";
import {
  buildStackAttentionCards,
  stackComponentNeedsAttention,
  stackUpstreamIsStale,
  type StackAttentionCard,
} from "./attention.js";
import {
  buildStackLagTask,
  buildStackDigestLine,
  cardsForDigest,
  cardsForLagTasks,
  fileStackLagTasks,
} from "./escalation.js";
import {
  compareContainsFix,
  countBehind,
  extractReleaseNotes,
  githubJsonPort,
  normaliseVersion,
  readReleaseList,
  type StackFetchJson,
  type StackHttpResponse,
} from "./releases.js";
import { readStackCheckIntervalSec, readStackGithubToken } from "./settings.js";
import {
  seedStackDocument,
  type StackDocument,
  type StackLocalState,
  type StackReleaseSource,
  type StackSnapshot,
} from "./domain.js";
import {
  DEFAULT_OSV_API_BASE,
  OSV_QUERY_BATCH_PATH,
  buildOsvBatchPayload,
  extractVulnIdAndCve,
  extractVulnSeverity,
  parseOsvBatchResponse,
  parseOsvVulnerabilities,
  queryOsvAdvisories,
} from "./advisory.js";
import { readStackDocument, writeStackDocument } from "./store.js";
import { stackRegistryRoutes } from "./routes.js";
import type { StackBacklogDraft } from "./backlog-draft.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = () => new Date("2026-10-02T03:00:00.000Z");

type RouteValue = StackHttpResponse | ((url: string, options?: unknown) => StackHttpResponse);

/** A JSON port that answers by URL substring; anything else is 404. */
function fakePort(routes: Record<string, RouteValue>): StackFetchJson {
  return async (url, options) => {
    const key = Object.keys(routes).find((candidate) => url.includes(candidate));
    if (!key) return { status: 404, json: null };
    const value = routes[key]!;
    return typeof value === "function" ? value(url, options) : value;
  };
}

function langfuseReleases() {
  return [
    {
      tag_name: "3.2.0",
      published_at: "2026-09-28T00:00:00Z",
      body: "security fix for the session cookie (CVE-2026-12345)\nbreaking: removed the legacy API\n- minor cleanup",
    },
    { tag_name: "3.1.0", published_at: "2026-09-10T00:00:00Z", body: "Routine release." },
    { tag_name: "3.0.0", published_at: "2026-08-01T00:00:00Z", body: "Release." },
  ];
}

function documentWithLocal(overrides: Record<string, Partial<StackLocalState>>): StackDocument {
  const doc = seedStackDocument();
  return {
    ...doc,
    components: doc.components.map((component) =>
      overrides[component.name]
        ? { ...component, local: { ...component.local, ...overrides[component.name] } }
        : component,
    ),
  };
}

/** A check fixture that leaves only `githubCheckable` on the github path, so
 *  a route can count network calls without interference from the other seeded
 *  github components (a 404/403 on their URLs would otherwise trigger the
 *  retry or patch-eval calls too). */
function documentWithOnlyCheckable(
  githubCheckable: string,
  overrides: Record<string, Partial<StackLocalState>>,
): StackDocument {
  const doc = documentWithLocal(overrides);
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
}

function fakeImages(states: Record<string, Awaited<ReturnType<DockerImagesPort>>>): DockerImagesPort {
  return async (ref) => states[ref] ?? null;
}

describe("stack release check helpers", () => {
  it("reads the release list newest-first and normalises versions", () => {
    const records = readReleaseList("github-releases", langfuseReleases());
    expect(records.map((r) => r.tag)).toEqual(["3.2.0", "3.1.0", "3.0.0"]);
    expect(normaliseVersion("langfuse/langfuse:3.0.0")).toBe("3.0.0");
    expect(normaliseVersion("v1.3.1")).toBe("1.3.1");
    expect(countBehind(records, "langfuse/langfuse:3.0.0")).toEqual({ latest: "3.2.0", behindBy: 2 });
    expect(countBehind(records, "langfuse/langfuse:3.2.0")).toEqual({ latest: "3.2.0", behindBy: 0 });
    // Our version is not part of the feed: an honest unknown, not a guess.
    expect(countBehind(records, "langfuse/langfuse:1.0.0").behindBy).toBeNull();
  });

  it("keeps only notable release-note lines, bounded, and flags security", () => {
    const notes = extractReleaseNotes(readReleaseList("github-releases", langfuseReleases()), { limit: 1 });
    expect(notes?.hasSecurity).toBe(true);
    expect(notes?.lines).toHaveLength(1);
    expect(notes?.truncated).toBe(true);
    expect(notes?.lines[0]).toContain("security fix");
    expect(notes?.lines[0]).toContain("3.2.0");
  });

  it("does not flag security when security notes exist only in older releases than current version", () => {
    const releases = [
      {
        tag_name: "3.2.0",
        published_at: "2026-10-01T00:00:00Z",
        body: "### Changes\n* Routine refactoring and perf improvements",
      },
      {
        tag_name: "3.1.0",
        published_at: "2026-09-01T00:00:00Z",
        body: "### Security\n* Fix CVE-2026-9999 remote code execution",
      },
      {
        tag_name: "3.0.0",
        published_at: "2026-08-01T00:00:00Z",
        body: "Initial 3.0 release",
      },
    ];
    const records = readReleaseList("github-releases", releases);

    // If local version is already 3.1.0, the CVE in 3.1.0 was addressed locally; only 3.2.0 is newer.
    const notesForCurrent = extractReleaseNotes(records, { localVersion: "3.1.0" });
    expect(notesForCurrent?.hasSecurity).toBe(false);

    // If local version is 3.0.0, 3.1.0 is in the range between local and latest.
    const notesForOlder = extractReleaseNotes(records, { localVersion: "3.0.0" });
    expect(notesForOlder?.hasSecurity).toBe(true);

    // If local version is unknown, only the latest release is scanned for security to avoid perpetual flags.
    const notesForUnknown = extractReleaseNotes(records);
    expect(notesForUnknown?.hasSecurity).toBe(false);
  });

  it("detects a known fix commit inside the compare range", () => {
    const json = { commits: [{ sha: "24758cf4b8123456789012345678901234567890" }] };
    expect(compareContainsFix(json, ["24758cf4b8"])).toBe(true);
    expect(compareContainsFix({ commits: [{ sha: "deadbeef" }] }, ["24758cf4b8"])).toBe(false);
    expect(compareContainsFix(null, ["24758cf4b8"])).toBe(false);
  });

  it("defaults the release-check interval to off", () => {
    expect(readStackCheckIntervalSec({} as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "0" } as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "abc" } as NodeJS.ProcessEnv)).toBe(0);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "10" } as NodeJS.ProcessEnv)).toBe(60);
    expect(readStackCheckIntervalSec({ MYRMIDON_STACK_CHECK_INTERVAL_SEC: "86400" } as NodeJS.ProcessEnv)).toBe(86400);
  });

  it("reads the stack GitHub token: unset or blank is null, surrounding spaces are trimmed", () => {
    expect(readStackGithubToken({} as NodeJS.ProcessEnv)).toBeNull();
    expect(readStackGithubToken({ MYRMIDON_STACK_GITHUB_TOKEN: "" } as NodeJS.ProcessEnv)).toBeNull();
    expect(readStackGithubToken({ MYRMIDON_STACK_GITHUB_TOKEN: "   " } as NodeJS.ProcessEnv)).toBeNull();
    expect(readStackGithubToken({ MYRMIDON_STACK_GITHUB_TOKEN: "  test-token  " } as NodeJS.ProcessEnv)).toBe("test-token");
  });

  it("sends no authorization header when the JSON port has no token (anonymous mode unchanged)", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("[]", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const port = githubJsonPort();
      const res = await port("https://api.github.com/repos/foo/bar/releases?per_page=30");
      expect(res.status).toBe(200);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.headers.authorization).toBeUndefined();
      expect(seen[0]!.headers.accept).toBe("application/vnd.github+json");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("sends the Bearer token on every request the port makes (releases and compare share one port)", async () => {
    const realFetch = globalThis.fetch;
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    try {
      const port = githubJsonPort({ token: "  test-token  " });
      await port("https://api.github.com/repos/foo/bar/releases?per_page=30");
      await port("https://api.github.com/repos/foo/bar/compare/v1...main");
      expect(seen).toHaveLength(2);
      for (const call of seen) {
        expect(call.headers.authorization).toBe("Bearer test-token");
      }
      // a blank token must not turn into an empty authorization header
      const blank = githubJsonPort({ token: "   " });
      seen.length = 0;
      await blank("https://api.github.com/repos/foo/bar/tags");
      expect(seen[0]!.headers.authorization).toBeUndefined();
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("stack attention cards", () => {
  it("covers a lagging component, keeps severity by security lines and dedupKey by latest", () => {
    const doc = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    doc.components = doc.components.map((component) =>
      component.name === "langfuse"
        ? {
            ...component,
            upstreamState: {
              checkedAt: "2026-10-02T03:00:00.000Z",
              latest: "3.2.0",
              latestPublishedAt: "2026-09-28T00:00:00Z",
              firstSeenAt: "2026-10-01T03:00:00.000Z",
              previousLatest: "3.1.0",
              behindBy: 2,
              notes: { lines: ["3.2.0 — security fix"], truncated: false, hasSecurity: true },
              error: null,
              staleSince: null,
            },
          }
        : component,
    );
    const cards = buildStackAttentionCards(doc);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      component: "langfuse",
      latest: "3.2.0",
      behindBy: 2,
      severity: "high",
      dedupKey: "stack:langfuse:3.2.0",
      activityAt: "2026-09-28T00:00:00Z",
    });
    expect(cards[0]!.summaryExcerpt).toContain("security fix");
    // First check on the same document made no card before the upstream state.
    expect(buildStackAttentionCards(seedStackDocument())).toHaveLength(0);
  });

  it("surfaces a new latest even without a known lag, and stays silent when up to date", () => {
    const base = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.2.0" } });
    const component = base.components.find((c) => c.name === "langfuse")!;
    const upstream = {
      checkedAt: "2026-10-02T03:00:00.000Z",
      latest: "3.2.0",
      latestPublishedAt: null,
      firstSeenAt: "2026-10-02T03:00:00.000Z",
      previousLatest: "3.1.0",
      behindBy: 0,
      notes: null,
      error: null,
      staleSince: null,
    };
    expect(stackComponentNeedsAttention({ ...component, upstreamState: upstream })).toBe(true);
    const cards = buildStackAttentionCards({
      ...base,
      components: base.components.map((c) => (c.name === "langfuse" ? { ...c, upstreamState: upstream } : c)),
    });
    expect(cards).toHaveLength(1);
    expect(cards[0]!.severity).toBe("medium");
    // Same latest as the previous check and we are on it: no card.
    expect(stackComponentNeedsAttention({ ...component, upstreamState: { ...upstream, previousLatest: "3.2.0" } })).toBe(false);
  });

  it("keeps the card alive while the local version is unknown but upstream has a latest", () => {
    const base = documentWithLocal({ langfuse: { version: null } });
    const component = base.components.find((c) => c.name === "langfuse")!;
    const upstream = {
      checkedAt: "2026-10-02T03:00:00.000Z",
      latest: "3.2.0",
      latestPublishedAt: null,
      firstSeenAt: "2026-10-01T03:00:00.000Z",
      previousLatest: "3.2.0",
      behindBy: null,
      notes: null,
      error: null,
      staleSince: null,
    };
    // Even after the same latest has been seen before: without a local version
    // the component cannot prove it is up to date, so the card stays.
    expect(stackComponentNeedsAttention({ ...component, upstreamState: upstream })).toBe(true);
  });

  it("flags the upstream state as stale only after 24 hours of failed checks", () => {
    const upstream = {
      checkedAt: "2026-10-02T03:00:00.000Z",
      latest: "3.2.0",
      latestPublishedAt: null,
      firstSeenAt: "2026-10-01T03:00:00.000Z",
      previousLatest: "3.1.0",
      behindBy: 2,
      notes: null,
      error: "github 403",
      staleSince: "2026-10-01T03:00:00.000Z",
    };
    expect(stackUpstreamIsStale(upstream, new Date("2026-10-01T15:00:00.000Z"))).toBe(false);
    expect(stackUpstreamIsStale(upstream, new Date("2026-10-02T03:00:00.000Z"))).toBe(true);
    expect(stackUpstreamIsStale({ ...upstream, staleSince: null }, new Date("2026-10-02T03:00:00.000Z"))).toBe(false);
  });
});

describe("OSV advisory integration", () => {
  it("builds OSV batch query payload correctly", () => {
    const payload = buildOsvBatchPayload([
      { componentName: "litellm", package: { name: "litellm", ecosystem: "PyPI" }, version: "1.50.0" },
      { componentName: "langfuse", package: { name: "langfuse", ecosystem: "npm" }, version: "3.2.0" },
    ]);
    expect(payload.queries).toEqual([
      { package: { name: "litellm", ecosystem: "PyPI" }, version: "1.50.0" },
      { package: { name: "langfuse", ecosystem: "npm" }, version: "3.2.0" },
    ]);
  });

  it("extracts vulnerability id, cve alias, and severity", () => {
    const vulnGhsa = {
      id: "GHSA-xxxx-yyyy-zzzz",
      aliases: ["CVE-2026-99999", "OSV-2026-123"],
      database_specific: { severity: "HIGH" },
    };
    const { id, cveId } = extractVulnIdAndCve(vulnGhsa);
    expect(id).toBe("CVE-2026-99999");
    expect(cveId).toBe("CVE-2026-99999");
    expect(extractVulnSeverity(vulnGhsa)).toBe("HIGH");

    const vulnCveDirect = {
      id: "CVE-2026-11111",
      severity: "CRITICAL",
    };
    const parsedDirect = extractVulnIdAndCve(vulnCveDirect);
    expect(parsedDirect.id).toBe("CVE-2026-11111");
    expect(parsedDirect.cveId).toBe("CVE-2026-11111");
    expect(extractVulnSeverity(vulnCveDirect)).toBe("CRITICAL");

    const vulnNoCve = {
      id: "GHSA-abcd-1234",
      aliases: ["PYSEC-2026-1"],
      severity: [{ score: "8.5" }],
    };
    const parsedNoCve = extractVulnIdAndCve(vulnNoCve);
    expect(parsedNoCve.id).toBe("GHSA-abcd-1234");
    expect(parsedNoCve.cveId).toBeNull();
    expect(extractVulnSeverity(vulnNoCve)).toBe("HIGH");
  });

  it("parses OSV vulnerabilities list and batch response", () => {
    const queries = [
      { componentName: "litellm", package: { name: "litellm", ecosystem: "PyPI" }, version: "1.50.0" },
      { componentName: "clean-pkg", package: { name: "clean-pkg" }, version: "1.0.0" },
    ];
    const rawBatchJson = {
      results: [
        {
          vulns: [
            {
              id: "GHSA-1234-5678",
              aliases: ["CVE-2026-54321"],
              severity: "CRITICAL",
              summary: "Remote code execution in litellm proxy",
            },
          ],
        },
        {
          vulns: [],
        },
      ],
    };

    const map = parseOsvBatchResponse(queries, rawBatchJson);
    expect(map.size).toBe(1);
    expect(map.has("litellm")).toBe(true);
    expect(map.has("clean-pkg")).toBe(false);

    const litellmVulns = map.get("litellm")!;
    expect(litellmVulns).toHaveLength(1);
    expect(litellmVulns[0]).toEqual({
      id: "CVE-2026-54321",
      cveId: "CVE-2026-54321",
      severity: "CRITICAL",
      summary: "Remote code execution in litellm proxy",
    });
  });

  it("marks component with known CVE and leaves clean component without mark", async () => {
    const queries = [
      { componentName: "litellm", package: { name: "litellm", ecosystem: "PyPI" }, version: "1.50.0" },
      { componentName: "langfuse", package: { name: "langfuse", ecosystem: "npm" }, version: "3.2.0" },
    ];
    const port = fakePort({
      [OSV_QUERY_BATCH_PATH]: {
        status: 200,
        json: {
          results: [
            {
              vulns: [
                {
                  id: "GHSA-litellm-cve",
                  aliases: ["CVE-2026-7777"],
                  severity: "HIGH",
                  summary: "SSRF vulnerability in litellm",
                },
              ],
            },
            {
              // clean package (no vulns)
            },
          ],
        },
      },
    });

    const res = await queryOsvAdvisories(queries, port);
    expect(res.size).toBe(1);
    expect(res.get("litellm")).toEqual([
      {
        id: "CVE-2026-7777",
        cveId: "CVE-2026-7777",
        severity: "HIGH",
        summary: "SSRF vulnerability in litellm",
      },
    ]);
    expect(res.has("langfuse")).toBe(false);
  });

  it("degrades gracefully without failing when OSV source is unavailable (500, network error)", async () => {
    const queries = [
      { componentName: "litellm", package: { name: "litellm", ecosystem: "PyPI" }, version: "1.50.0" },
    ];

    // HTTP 500 error
    const serverErrorPort = fakePort({
      [OSV_QUERY_BATCH_PATH]: { status: 500, json: { error: "internal server error" } },
    });
    const errorMap = await queryOsvAdvisories(queries, serverErrorPort);
    expect(errorMap.size).toBe(0);

    // Network / transport throw
    const throwingPort: StackFetchJson = async () => {
      throw new Error("DNS lookup failed");
    };
    const throwMap = await queryOsvAdvisories(queries, throwingPort);
    expect(throwMap.size).toBe(0);
  });
});

describeEmbeddedPostgres("stack release check", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-stack-check-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  function app(actor: unknown, check?: Parameters<typeof stackRegistryRoutes>[1]) {
    const server = express();
    server.use(express.json());
    server.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    server.use("/api", stackRegistryRoutes(db, check));
    server.use(errorHandler);
    return server;
  }

  const admin = { type: "board", source: "session", userId: "admin-user", isInstanceAdmin: true, companyIds: [] };
  const member = { type: "board", source: "session", userId: "user-a", isInstanceAdmin: false, companyIds: ["company-a"] };
  const agentActor = { type: "agent", source: "agent_key", agentId: "agent-a", companyId: "company-a", keyId: "key-a" };

  it("check updates the cache with latest, lag and the release-note excerpt", async () => {
    await writeStackDocument(db, documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW, collect: false });
    expect(next.version).toBe(2);
    expect(next.checkedAt).toBe("2026-10-02T03:00:00.000Z");
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState).toMatchObject({
      latest: "3.2.0",
      latestPublishedAt: "2026-09-28T00:00:00Z",
      previousLatest: null,
      behindBy: 2,
    });
    expect(langfuse.upstreamState?.notes?.hasSecurity).toBe(true);
    // The written cache is readable back and version 1 documents still parse.
    const stored = await readStackDocument(db);
    expect(stored.checkedAt).toBe("2026-10-02T03:00:00.000Z");
    expect(stored.components.find((c) => c.name === "langfuse")?.upstreamState?.latest).toBe("3.2.0");
    // A component without a source is left untouched.
    expect(next.components.find((c) => c.name === "proxmox-ve")?.upstreamState).toBeUndefined();
  });

  it("records a per-component HTTP error without failing the whole check", async () => {
    await writeStackDocument(db, documentWithOnlyCheckable("langfuse", { langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 403, json: null } });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW, retryDelayMs: 0, collect: false });
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState?.error).toBe("github 403");
    expect(langfuse.upstreamState?.latest).toBeNull();
  });

  it("closes the patch when the upstream range carries the fix commit", async () => {
    await writeStackDocument(db, seedStackDocument());
    const port = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: "Pool limits fixed." }],
      },
      "repos/NousResearch/hermes-agent/compare": {
        status: 200,
        json: { status: "ahead", commits: [{ sha: "24758cf4b8123456789012345678901234567890" }] },
      },
    });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW, collect: false });
    const hermes = next.components.find((c) => c.name === "hermes-agent")!;
    expect(hermes.local.patches).toHaveLength(1);
    expect(hermes.local.patches[0]).toMatchObject({ state: "closed", fixCommits: ["24758cf4b8"] });
    expect(hermes.patchClosed).toMatchObject({ state: "closed" });
  });

  it("keeps the patch open when the fix commit is outside the range, and unknown on a 404", async () => {
    await writeStackDocument(db, seedStackDocument());
    const openPort = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: null }],
      },
      "repos/NousResearch/hermes-agent/compare": { status: 200, json: { status: "ahead", commits: [{ sha: "aaaaaaaaaaaa" }] } },
    });
    const open = await checkStackReleases(db, { fetchJson: openPort, now: NOW, collect: false });
    expect(open.components.find((c) => c.name === "hermes-agent")?.patchClosed?.state).toBe("open");

    const unknownPort = fakePort({
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: null }],
      },
      "repos/NousResearch/hermes-agent/compare": { status: 404, json: null },
    });
    const unknown = await checkStackReleases(db, { fetchJson: unknownPort, now: NOW, collect: false });
    expect(unknown.components.find((c) => c.name === "hermes-agent")?.patchClosed?.state).toBe("unknown");
  });

  it("a transport failure rejects the check and preserves the previous cache", async () => {
    const good = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    good.checkedAt = "2026-10-01T00:00:00.000Z";
    await writeStackDocument(db, good);
    const broken: StackFetchJson = async () => {
      throw new Error("network unreachable");
    };
    await expect(checkStackReleases(db, { fetchJson: broken, now: NOW, collect: false })).rejects.toThrow("network unreachable");
    const stored = await readStackDocument(db);
    expect(stored.checkedAt).toBe("2026-10-01T00:00:00.000Z");
    expect(stored.components.find((c) => c.name === "langfuse")?.upstreamState).toBeUndefined();
  });

  it("agent and non-admin tokens cannot run the check (403); nothing is written", async () => {
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    await request(app(agentActor, { check: { fetchJson: port, now: NOW } })).post("/api/myrmidon/stack/check").expect(403);
    await request(app(member, { check: { fetchJson: port, now: NOW } })).post("/api/myrmidon/stack/check").expect(403);
    expect((await readStackDocument(db)).components).toEqual([]);
  });

  it("admin check answers 200 with fakes and 503 without a network, keeping the cache", async () => {
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() } });
    await request(app(admin, { check: { fetchJson: port, now: NOW } }))
      .post("/api/myrmidon/stack/check")
      .expect(200)
      .expect((res) => {
        expect(res.body.checkedAt).toBe("2026-10-02T03:00:00.000Z");
        expect(res.body.components.find((c: { name: string }) => c.name === "langfuse").upstreamState.latest).toBe("3.2.0");
      });
    const broken: StackFetchJson = async () => {
      throw new Error("network unreachable");
    };
    const res = await request(app(admin, { check: { fetchJson: broken, now: NOW } }))
      .post("/api/myrmidon/stack/check")
      .expect(503);
    expect(res.body.error).toBe("stack check failed");
    expect((await readStackDocument(db)).components.find((c) => c.name === "langfuse")?.upstreamState?.latest).toBe("3.2.0");
  });

  it("the sweep does not touch the network while the interval is off", () => {
    const saved = process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    delete process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    let calls = 0;
    const port: StackFetchJson = async () => {
      calls += 1;
      return { status: 200, json: [] };
    };
    const stop = startStackCheckSweep(db, { fetchJson: port });
    stop();
    if (saved === undefined) delete process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC;
    else process.env.MYRMIDON_STACK_CHECK_INTERVAL_SEC = saved;
    expect(calls).toBe(0);
  });

  it("http-version probe reads the local version from the component's own endpoint", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ version: "1.1.0" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const saved = process.env.MYRMIDON_STACK_HTTP_HINDSIGHT;
    process.env.MYRMIDON_STACK_HTTP_HINDSIGHT = "http://hindsight.local:8080/version";
    try {
      const doc = await collectStackLocal({ now: NOW, serverInfo: { processStartedAt: "", git: { available: false, unavailableReason: "git_unavailable" } }, images: fakeImages({}) });
      const hindsight = doc.components.find((c) => c.name === "hindsight")!;
      expect(hindsight.local.version).toBe("1.1.0");
      expect(hindsight.local.runningOn).toBe("http://hindsight.local:8080");
      expect(hindsight.local.unknownReason).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.MYRMIDON_STACK_HTTP_HINDSIGHT;
      else process.env.MYRMIDON_STACK_HTTP_HINDSIGHT = saved;
    }
  });

  it("http-version probe accepts api_version field in response (e.g. Hindsight FastAPI)", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ api_version: "1.2.0" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const saved = process.env.MYRMIDON_STACK_HTTP_HINDSIGHT;
    process.env.MYRMIDON_STACK_HTTP_HINDSIGHT = "http://hindsight.local:8080/version";
    try {
      const doc = await collectStackLocal({ now: NOW, serverInfo: { processStartedAt: "", git: { available: false, unavailableReason: "git_unavailable" } }, images: fakeImages({}) });
      const hindsight = doc.components.find((c) => c.name === "hindsight")!;
      expect(hindsight.local.version).toBe("1.2.0");
      expect(hindsight.local.runningOn).toBe("http://hindsight.local:8080");
      expect(hindsight.local.unknownReason).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.MYRMIDON_STACK_HTTP_HINDSIGHT;
      else process.env.MYRMIDON_STACK_HTTP_HINDSIGHT = saved;
    }
  });

  it("http-version probe appends the documented endpoint to a bare base URL (Langfuse health path)", async () => {
    const realFetch = globalThis.fetch;
    const seen: string[] = [];
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      seen.push(String(url));
      return new Response(JSON.stringify({ version: "3.2.0" }), { status: 200 });
    }) as typeof globalThis.fetch;
    const saved = process.env.MYRMIDON_STACK_HTTP_LANGFUSE;
    process.env.MYRMIDON_STACK_HTTP_LANGFUSE = "http://langfuse.local:3000";
    try {
      const doc = await collectStackLocal({ now: NOW, serverInfo: { processStartedAt: "", git: { available: false, unavailableReason: "git_unavailable" } }, images: fakeImages({}) });
      const langfuse = doc.components.find((c) => c.name === "langfuse")!;
      expect(seen).toEqual(["http://langfuse.local:3000/api/public/health"]);
      expect(langfuse.local.version).toBe("3.2.0");
      expect(langfuse.local.runningOn).toBe("http://langfuse.local:3000");
      expect(langfuse.local.unknownReason).toBeNull();
    } finally {
      globalThis.fetch = realFetch;
      if (saved === undefined) delete process.env.MYRMIDON_STACK_HTTP_LANGFUSE;
      else process.env.MYRMIDON_STACK_HTTP_LANGFUSE = saved;
    }
  });

  it("http-version probe reports an honest unknown when the env binding is missing", async () => {
    const saved = process.env.MYRMIDON_STACK_HTTP_LANGFUSE;
    delete process.env.MYRMIDON_STACK_HTTP_LANGFUSE;
    try {
      const doc = await collectStackLocal({ now: NOW, serverInfo: { processStartedAt: "", git: { available: false, unavailableReason: "git_unavailable" } }, images: fakeImages({}) });
      const langfuse = doc.components.find((c) => c.name === "langfuse")!;
      expect(langfuse.local.version).toBeNull();
      expect(langfuse.local.unknownReason).toContain("MYRMIDON_STACK_HTTP_LANGFUSE is not set");
    } finally {
      if (saved !== undefined) process.env.MYRMIDON_STACK_HTTP_LANGFUSE = saved;
    }
  });

  it("binds paperclip component to supported migration schema version", async () => {
    const doc = await collectStackLocal({
      now: NOW,
      serverInfo: { processStartedAt: "", git: { available: false, unavailableReason: "git_unavailable" } },
      images: fakeImages({}),
    });
    const paperclip = doc.components.find((c) => c.name === "paperclip")!;
    expect(paperclip.local.version).toBe("v2026.1106.0");
    expect(paperclip.local.runningOn).toBe("supported migration schema");
    expect(paperclip.local.unknownReason).toBeNull();
  });

  it("does not count pre-release or nightly tags as the latest release", () => {
    const releases = readReleaseList("github-releases", [
      { tag_name: "nightly", published_at: "2026-11-01T00:00:00Z", body: null },
      { tag_name: "v1.3.0-rc.1", published_at: "2026-10-30T00:00:00Z", body: null },
      { tag_name: "v1.2.0", published_at: "2026-10-01T00:00:00Z", body: null },
      { tag_name: "v1.1.0", published_at: "2026-09-01T00:00:00Z", body: null },
    ]);
    expect(countBehind(releases, "v1.1.0")).toEqual({ latest: "v1.2.0", behindBy: 1 });
    expect(countBehind(releases, "v1.2.0")).toEqual({ latest: "v1.2.0", behindBy: 0 });
  });

  it("myrmidon release check only counts myr-v* board release tags", async () => {
    await writeStackDocument(db, documentWithLocal({ myrmidon: { commit: "abc1234" } }));
    const port = fakePort({
      "repos/itkadr-git/myrmidon/tags": {
        status: 200,
        json: [
          { name: "v2026.916.1", commit: { committer: { date: "2026-09-16T00:00:00Z" } } },
          { name: "myr-v2026.1106.0", commit: { committer: { date: "2026-11-06T22:31:00Z" } } },
          { name: "myr-v2026.1023.0", commit: { committer: { date: "2026-10-23T00:00:00Z" } } },
        ],
      },
    });
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW, collect: false });
    const myrmidon = next.components.find((c) => c.name === "myrmidon")!;
    expect(myrmidon.upstreamState?.latest).toBe("myr-v2026.1106.0");
    expect(myrmidon.upstreamState?.latestPublishedAt).toBe("2026-11-06T22:31:00Z");
  });

  it("records staleSince on a github 403 and marks the card data as stale", async () => {
    await writeStackDocument(db, documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    const port = fakePort({ "repos/langfuse/langfuse/releases": { status: 403, json: null } });
    const first = await checkStackReleases(db, { fetchJson: port, now: NOW, retryDelayMs: 0, collect: false });
    const langfuseFirst = first.components.find((c) => c.name === "langfuse")!;
    expect(langfuseFirst.upstreamState?.error).toBe("github 403");
    expect(langfuseFirst.upstreamState?.staleSince).toBe("2026-10-02T03:00:00.000Z");
    expect(langfuseFirst.upstreamState?.latest).toBeNull();
    // Second check also fails: staleSince must not move (it marks the first failure).
    const later = await checkStackReleases(db, { fetchJson: port, now: () => new Date("2026-10-03T03:00:00.000Z"), retryDelayMs: 0, collect: false });
    const langfuseLater = later.components.find((c) => c.name === "langfuse")!;
    expect(langfuseLater.upstreamState?.staleSince).toBe("2026-10-02T03:00:00.000Z");
  });

  it("retries once after the configured delay on 403 before declaring stale", async () => {
    await writeStackDocument(db, documentWithOnlyCheckable("langfuse", { langfuse: { version: "langfuse/langfuse:3.0.0" } }));
    let calls = 0;
    const port: StackFetchJson = async (url) => {
      if (!url.includes("repos/langfuse/langfuse/releases")) return { status: 404, json: null };
      calls += 1;
      if (calls === 1) return { status: 403, json: null };
      return { status: 200, json: langfuseReleases() };
    };
    const next = await checkStackReleases(db, { fetchJson: port, now: NOW, retryDelayMs: 1, collect: false });
    expect(calls).toBe(2);
    const langfuse = next.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.upstreamState?.error).toBeNull();
    expect(langfuse.upstreamState?.latest).toBe("3.2.0");
    expect(langfuse.upstreamState?.staleSince).toBeNull();
  });

  it("marks components with known CVEs in checkStackReleases and preserves clean components", async () => {
    await writeStackDocument(
      db,
      documentWithLocal({
        litellm: { version: "ghcr.io/berriai/litellm:v1.50.0" },
        langfuse: { version: "langfuse/langfuse:3.0.0" },
      }),
    );
    const port = fakePort({
      "repos/BerriAI/litellm/releases": {
        status: 200,
        json: [{ tag_name: "v1.52.0", published_at: "2026-10-01T00:00:00Z", body: "release" }],
      },
      "repos/langfuse/langfuse/releases": {
        status: 200,
        json: [{ tag_name: "3.2.0", published_at: "2026-10-01T00:00:00Z", body: "release" }],
      },
      [OSV_QUERY_BATCH_PATH]: {
        status: 200,
        json: {
          results: [
            {
              // litellm query result (index 0)
              vulns: [
                {
                  id: "GHSA-litellm-proxy-cve",
                  aliases: ["CVE-2026-8888"],
                  severity: "CRITICAL",
                  summary: "Privilege escalation in LiteLLM proxy",
                },
              ],
            },
            {
              // langfuse query result (index 1) - clean, no vulns
              vulns: [],
            },
          ],
        },
      },
    });

    const doc = await checkStackReleases(db, { fetchJson: port, now: NOW, collect: false });
    const litellm = doc.components.find((c) => c.name === "litellm")!;
    expect(litellm.vulnerabilities).toBeDefined();
    expect(litellm.vulnerabilities).toHaveLength(1);
    expect(litellm.vulnerabilities![0]).toMatchObject({
      id: "CVE-2026-8888",
      cveId: "CVE-2026-8888",
      severity: "CRITICAL",
    });

    const langfuse = doc.components.find((c) => c.name === "langfuse")!;
    expect(langfuse.vulnerabilities).toBeUndefined();
  });

  it("degrades advisory lookup when OSV is 500 or unreachable without failing the release check", async () => {
    await writeStackDocument(
      db,
      documentWithLocal({
        litellm: { version: "ghcr.io/berriai/litellm:v1.50.0" },
      }),
    );
    const port = fakePort({
      "repos/BerriAI/litellm/releases": {
        status: 200,
        json: [{ tag_name: "v1.52.0", published_at: "2026-10-01T00:00:00Z", body: "release" }],
      },
      [OSV_QUERY_BATCH_PATH]: {
        status: 500,
        json: { error: "OSV down" },
      },
    });

    const doc = await checkStackReleases(db, { fetchJson: port, now: NOW, collect: false });
    const litellm = doc.components.find((c) => c.name === "litellm")!;
    expect(litellm.upstreamState?.latest).toBe("v1.52.0");
    expect(litellm.vulnerabilities).toBeUndefined();
  });

  it("creates backlog draft tasks when releases lag or carry security notes, respecting deduplication", async () => {
    const drafts: Array<{ companyId: string; draft: StackBacklogDraft }> = [];
    const port = fakePort({
      "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() },
      "repos/NousResearch/hermes-agent/releases": {
        status: 200,
        json: [{ tag_name: "v2026.10.1", published_at: "2026-10-01T00:00:00Z", body: null }],
      },
    });
    const baseDoc = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    await writeStackDocument(db, baseDoc);

    const companyId = randomUUID();
    const { companies } = await import("@myrmidon/db");
    await db.insert(companies).values({ id: companyId, name: "Test Co", issuePrefix: "TC" }).onConflictDoNothing();

    await checkStackReleases(db, {
      fetchJson: port,
      now: NOW,
      collect: false,
      createDraft: async (cid, draft) => {
        drafts.push({ companyId: cid, draft });
      },
    });

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.some((d) => d.draft.component === "langfuse")).toBe(true);
  });

  it("does not create a duplicate draft task when a task for the same release already exists (even if done/closed)", async () => {
    const drafts: Array<{ companyId: string; draft: StackBacklogDraft }> = [];
    const port = fakePort({
      "repos/langfuse/langfuse/releases": { status: 200, json: langfuseReleases() },
    });
    const baseDoc = documentWithLocal({ langfuse: { version: "langfuse/langfuse:3.0.0" } });
    await writeStackDocument(db, baseDoc);

    const companyId = randomUUID();
    const { companies, issues } = await import("@myrmidon/db");
    await db.insert(companies).values({ id: companyId, name: "Test Co 2", issuePrefix: "TC2" }).onConflictDoNothing();

    // Simulate existing closed task for langfuse 3.2.0
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "langfuse 3.2.0",
      description: "Previous update task",
      status: "done",
      priority: "medium",
      originKind: "stack_update",
      originId: "langfuse",
    });

    await checkStackReleases(db, {
      fetchJson: port,
      now: NOW,
      collect: false,
      createDraft: async (cid, draft) => {
        drafts.push({ companyId: cid, draft });
      },
    });

    // langfuse 3.2.0 is already closed/done, so no new draft should be created for it
    expect(drafts.some((d) => d.draft.component === "langfuse")).toBe(false);
  });
});

describe("stack lag escalation (STACK-WATCH-LIVE)", () => {
  it("builds a backlog task with dedup key per component", () => {
    const card: StackAttentionCard = {
      component: "hindsight",
      title: "hindsight v1.2.0",
      latest: "v1.2.0",
      ourVersion: "1.1.0",
      behindBy: 1,
      severity: "medium",
      whyNow: "Upstream release v1.2.0 is 1 release(s) ahead of the running version (1.1.0).",
      summaryExcerpt: null,
      dedupKey: "stack:hindsight:v1.2.0",
      activityAt: "2026-11-03T18:59:00.000Z",
      patchState: null,
      staleSince: null,
      metadata: {},
    };
    const task = buildStackLagTask(card, new Date("2026-11-08T12:00:00.000Z"));
    expect(task.idempotencyKey).toBe("stack-lag:hindsight");
    expect(task.priority).toBe("medium");
    expect(task.status).toBe("backlog");
    expect(task.title).toContain("hindsight");
    expect(task.description).toContain("1.1.0");
    expect(task.description).toContain("v1.2.0");
  });

  it("задача отставания создаётся в backlog и без исполнителя", async () => {
    const card: StackAttentionCard = {
      component: "hindsight",
      title: "hindsight v1.2.0",
      latest: "v1.2.0",
      ourVersion: "1.1.0",
      behindBy: 1,
      severity: "medium",
      whyNow: "Upstream release v1.2.0 is 1 release(s) ahead.",
      summaryExcerpt: null,
      dedupKey: "stack:hindsight:v1.2.0",
      activityAt: "2026-11-03T18:59:00.000Z",
      patchState: null,
      staleSince: null,
      metadata: {},
    };
    const task = buildStackLagTask(card, new Date("2026-11-08T12:00:00.000Z"));
    expect(task.status).toBe("backlog");
    expect((task as unknown as Record<string, unknown>).assigneeAgentId).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).assigneeId).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).assigneeUserId).toBeUndefined();
    expect((task as unknown as Record<string, unknown>).projectId).toBeUndefined();

    let createdPayload: Record<string, unknown> | null = null;
    const doc = documentWithLocal({
      hindsight: { version: "1.1.0" },
    });
    const components = doc.components.map((c) =>
      c.name === "hindsight"
        ? {
            ...c,
            upstreamState: {
              checkedAt: "2026-10-02T03:00:00.000Z",
              latest: "v1.2.0",
              latestPublishedAt: null,
              firstSeenAt: "2026-10-01T03:00:00.000Z",
              previousLatest: "1.1.0",
              behindBy: 1,
              notes: null,
              error: null,
              staleSince: null,
            },
          }
        : c,
    );
    const mockIssueSvc = {
      create: async (_companyId: string, data: unknown) => {
        createdPayload = data as Record<string, unknown>;
        return { id: "issue-created-1" };
      },
    };
    await fileStackLagTasks(
      {} as any,
      "company-1",
      { ...doc, components },
      new Date("2026-10-02T03:00:00.000Z"),
      undefined,
      mockIssueSvc,
    );
    expect(createdPayload).not.toBeNull();
    expect(createdPayload!.status).toBe("backlog");
    expect(createdPayload!.assigneeAgentId).toBeUndefined();
    expect(createdPayload!.assigneeUserId).toBeUndefined();
    expect(createdPayload!.assigneeId).toBeUndefined();
    expect(createdPayload!.projectId).toBeUndefined();
  });

  it("marks a security-flagged card as high priority", () => {
    const card: StackAttentionCard = {
      component: "paperclip",
      title: "paperclip v2026.1106.0",
      latest: "v2026.1106.0",
      ourVersion: "v2026.1023.0",
      behindBy: 1,
      severity: "high",
      whyNow: "Upstream release v2026.1106.0 is 1 release(s) ahead.",
      summaryExcerpt: "security fix",
      dedupKey: "stack:paperclip:v2026.1106.0",
      activityAt: "2026-11-06T22:31:00.000Z",
      patchState: null,
      staleSince: "2026-11-07T02:26:00.000Z",
      metadata: {},
    };
    const task = buildStackLagTask(card, new Date("2026-11-08T12:00:00.000Z"));
    expect(task.priority).toBe("high");
    expect(task.description).toContain("2026-11-07T02:26:00.000Z");
  });

  it("builds a digest line with lag or unknown version plus stale marker", () => {
    const card: StackAttentionCard = {
      component: "hindsight",
      title: "hindsight v1.2.0",
      latest: "v1.2.0",
      ourVersion: null,
      behindBy: null,
      severity: "medium",
      whyNow: "A new upstream release v1.2.0 appeared.",
      summaryExcerpt: null,
      dedupKey: "stack:hindsight:v1.2.0",
      activityAt: "2026-11-03T18:59:00.000Z",
      patchState: null,
      staleSince: "2026-11-07T02:26:00.000Z",
      metadata: {},
    };
    const line = buildStackDigestLine(card);
    expect(line).toContain("hindsight");
    expect(line).toContain("версия неизвестна");
    expect(line).toContain("v1.2.0");
    expect(line).toContain("сверка не удалась");
  });

  it("selects only behind or stale cards for lag tasks, not up-to-date ones", () => {
    const doc = documentWithLocal({
      langfuse: { version: "langfuse/langfuse:3.2.0" },
      hindsight: { version: null },
    });
    const now = new Date("2026-10-02T03:00:00.000Z");
    const components = doc.components.map((c) => {
      if (c.name === "langfuse") {
        return {
          ...c,
          upstreamState: {
            checkedAt: "2026-10-02T03:00:00.000Z",
            latest: "3.2.0",
            latestPublishedAt: null,
            firstSeenAt: "2026-10-01T03:00:00.000Z",
            previousLatest: "3.2.0",
            behindBy: 0,
            notes: null,
            error: null,
            staleSince: null,
          },
        };
      }
      if (c.name === "hindsight") {
        return {
          ...c,
          upstreamState: {
            checkedAt: "2026-10-02T03:00:00.000Z",
            latest: "v1.2.0",
            latestPublishedAt: null,
            firstSeenAt: "2026-10-01T03:00:00.000Z",
            previousLatest: "v1.2.0",
            behindBy: null,
            notes: null,
            error: null,
            staleSince: "2026-10-01T03:00:00.000Z",
          },
        };
      }
      return c;
    });
    const withStates: StackDocument = { ...doc, components };
    const taskCards = cardsForLagTasks(withStates, now);
    expect(taskCards.map((c) => c.component)).toEqual(["hindsight"]);
    const digestLines = cardsForDigest(withStates, now);
    expect(digestLines).toHaveLength(1);
    expect(digestLines[0]).toContain("hindsight");
  });

  it("includes components with security notes in cardsForLagTasks and cardsForDigest even without lag", () => {
    const doc = documentWithLocal({
      langfuse: { version: "langfuse/langfuse:3.2.0" },
    });
    const now = new Date("2026-10-02T03:00:00.000Z");
    const components = doc.components.map((c) => {
      if (c.name === "langfuse") {
        return {
          ...c,
          upstreamState: {
            checkedAt: "2026-10-02T03:00:00.000Z",
            latest: "3.2.0",
            latestPublishedAt: null,
            firstSeenAt: "2026-10-01T03:00:00.000Z",
            previousLatest: "3.2.0",
            behindBy: 0,
            notes: { lines: ["3.2.0 — security fix: CVE-2026-1234"], truncated: false, hasSecurity: true },
            error: null,
            staleSince: null,
          },
        };
      }
      return c;
    });
    const withSecurity: StackDocument = { ...doc, components };
    const taskCards = cardsForLagTasks(withSecurity, now);
    expect(taskCards.map((c) => c.component)).toEqual(["langfuse"]);
    const digestLines = cardsForDigest(withSecurity, now);
    expect(digestLines).toHaveLength(1);
    expect(digestLines[0]).toContain("langfuse");
  });

  it("fileStackLagTasks creates tasks and handles deduplication via onDeduplicated", async () => {
    const doc = documentWithLocal({
      hindsight: { version: "1.1.0" },
    });
    const now = new Date("2026-10-02T03:00:00.000Z");
    const components = doc.components.map((c) => {
      if (c.name === "hindsight") {
        return {
          ...c,
          upstreamState: {
            checkedAt: "2026-10-02T03:00:00.000Z",
            latest: "v1.2.0",
            latestPublishedAt: null,
            firstSeenAt: "2026-10-01T03:00:00.000Z",
            previousLatest: "1.1.0",
            behindBy: 1,
            notes: null,
            error: null,
            staleSince: null,
          },
        };
      }
      return c;
    });
    const withStates: StackDocument = { ...doc, components };

    // 1. Initial creation
    let createdCalls = 0;
    const mockIssueSvc1 = {
      create: async (_companyId: string, _data: unknown) => {
        createdCalls += 1;
        return { id: "issue-1" };
      },
    };
    const res1 = await fileStackLagTasks(
      {} as any,
      "company-1",
      withStates,
      now,
      undefined,
      mockIssueSvc1,
    );
    expect(res1).toEqual({ filed: 1, skipped: 0 });
    expect(createdCalls).toBe(1);

    // 2. Deduplicated creation (onDeduplicated called)
    const mockIssueSvc2 = {
      create: async (_companyId: string, data: any) => {
        data.onDeduplicated?.();
        return { id: "issue-existing" };
      },
    };
    const res2 = await fileStackLagTasks(
      {} as any,
      "company-1",
      withStates,
      now,
      undefined,
      mockIssueSvc2,
    );
    expect(res2).toEqual({ filed: 0, skipped: 1 });
  });
});
