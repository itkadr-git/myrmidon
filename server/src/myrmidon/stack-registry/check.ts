// Stack registry (SUA, part B): the release check.
//
// For every component with a GitHub release source the checker reads the
// release/tag list — authenticated when possible: the operator's
// stack.github_token instance secret first, then a strictly read-only token
// minted from the board's own GitHub App (see github-app.ts) — and records
// the latest upstream release, how many releases we are behind (when our
// version appears in that feed), the notable release-note lines and — for
// components with carried deltas — whether the upstream range already
// contains the fix commits (GitHub compare API). The result is written back
// into the stack cache (document schema version 2).
//
// The same function backs both triggers: the daily/manual `POST
// /api/myrmidon/stack/check` and the interval sweep mounted from the server
// entry point. A transport failure is thrown and surfaces as 503 with the
// previous cache intact; an HTTP status is recorded per component.

import { companies, issues, type Db } from "@myrmidon/db";
import { and, eq, isNotNull, notInArray } from "drizzle-orm";
import { logger } from "../../middleware/logger.js";
import {
  STACK_CHECKABLE_RELEASE_SOURCES,
  STACK_DOCUMENT_VERSION,
  STACK_SEED,
  patchEntryFromDelta,
  seedDeltasFor,
  seedStackDocument,
  type StackDocument,
  type StackPatchClosed,
  type StackPatchEntry,
  type StackSnapshot,
  type StackUpstreamState,
} from "./domain.js";
import {
  STACK_GITHUB_API_BASE,
  compareContainsFix,
  countBehind,
  extractReleaseNotes,
  githubCompareUrl,
  githubJsonPort,
  githubListUrl,
  isPrereleaseTag,
  normaliseVersion,
  readReleaseList,
  type StackFetchJson,
} from "./releases.js";
import { readStackBacklogLagReleases, readStackCheckIntervalSec, readStackOsvApiBase } from "./settings.js";
import { osvJsonPort, queryOsvAdvisories, type StackAdvisoryQuery } from "./advisory.js";
import { decideStackBacklogDrafts, type StackBacklogDraft } from "./backlog-draft.js";
import { resolveOptionalInstanceSecret } from "../secret-settings/runtime.js"; // myrmidon(SETTINGS-UI E2.6)
import { readStackDocument, writeStackDocument } from "./store.js";
import { resolveStackCheckGitHubAppToken } from "./github-app.js";
import { collectStackLocal, type CollectStackLocalOptions } from "./collector.js";
import { backgroundInterval } from "../monitoring/board-load/lanes.js"; // myrmidon(1.6.6 OPE-9058)

export const STACK_CHECK_PER_PAGE = 30;
/** One retry on 403/429/5xx, after a short delay. */
export const STACK_CHECK_RETRY_DELAY_MS = 30_000;

export interface StackCheckOptions {
  now?: () => Date;
  /** Injected JSON port; defaults to the anonymous GitHub REST client. */
  fetchJson?: StackFetchJson;
  perPage?: number;
  noteLimit?: number;
  /**
   * Delay before one retry on 403/429/5xx; 0 disables the retry. Defaults to
   * STACK_CHECK_RETRY_DELAY_MS; tests pass 0 to keep retrying synchronous.
   */
  retryDelayMs?: number;
  /**
   * Local-state collection options for the pre-check refresh. Pass `false` to
   * keep the stored local state untouched (tests that only exercise part B).
   */
  collect?: CollectStackLocalOptions | false;
  /** Injected base URL for OSV.dev advisory API; defaults to STACK_OSV_API_BASE_ENV or DEFAULT_OSV_API_BASE. */
  osvApiBase?: string | null;
  lagThreshold?: number;
  createDraft?: (companyId: string, draft: StackBacklogDraft) => Promise<void>;
  findOpenComponents?: (companyId: string) => Promise<string[]>;
  /**
   * Test seam: the fetch implementation the GitHub App token mint uses.
   * Production defaults to globalThis.fetch (the board calls GitHub itself).
   */
  githubAppFetchImpl?: typeof fetch;
}

function readOnlyUpstream(previous: StackUpstreamState | null, checkedAt: string, error: string): StackUpstreamState {
  return {
    checkedAt,
    latest: previous?.latest ?? null,
    latestPublishedAt: previous?.latestPublishedAt ?? null,
    firstSeenAt: previous?.firstSeenAt ?? null,
    previousLatest: previous?.latest ?? null,
    behindBy: previous?.behindBy ?? null,
    notes: previous?.notes ?? null,
    error,
    staleSince: previous?.staleSince ?? checkedAt,
  };
}

/** Evaluate the carried deltas of one component against the upstream range. */
async function evaluatePatches(
  component: StackSnapshot,
  latest: string | null,
  port: StackFetchJson,
  checkedAt: string,
): Promise<StackPatchEntry[]> {
  const deltas = component.local.patches.length > 0
    ? component.local.patches
    : seedDeltasFor(component.name).map(patchEntryFromDelta);
  const repo = component.upstream.kind === "github" ? component.upstream.repo : null;
  const evaluated: StackPatchEntry[] = [];
  for (const delta of deltas) {
    const base = delta.ourVersion ?? component.local.version ?? null;
    if (!repo || !latest) {
      evaluated.push({ ...delta, state: "unknown", reason: "no upstream release known yet" });
      continue;
    }
    if (!base) {
      evaluated.push({ ...delta, state: "unknown", reason: "our version is unknown" });
      continue;
    }
    if (delta.fixCommits.length === 0) {
      evaluated.push({ ...delta, state: "unknown", reason: "no upstream fix commit recorded" });
      continue;
    }
    if (normaliseVersion(base) === normaliseVersion(latest)) {
      // The range is empty: the delta was applied to the very release we carry it on.
      evaluated.push({ ...delta, state: "open", reason: "upstream latest is the version we carry the patch on" });
      continue;
    }
    const res = await port(githubCompareUrl(repo, base, latest));
    if (res.status === 404) {
      evaluated.push({ ...delta, state: "unknown", reason: "compare range unavailable for the recorded version" });
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      evaluated.push({ ...delta, state: "unknown", reason: `github compare ${res.status}` });
      continue;
    }
    if (compareContainsFix(res.json, delta.fixCommits)) {
      evaluated.push({ ...delta, state: "closed", reason: "the upstream range already contains the fix commit" });
    } else {
      evaluated.push({ ...delta, state: "open", reason: "the fix commit is not in the upstream range yet" });
    }
  }
  return evaluated;
}

function aggregatePatchClosed(patches: readonly StackPatchEntry[]): StackPatchClosed {
  if (patches.length === 0) return { state: "unknown", reason: "no carried patches recorded" };
  if (patches.some((patch) => patch.state === "unknown")) {
    return { state: "unknown", reason: "upstream range could not be fully evaluated" };
  }
  if (patches.every((patch) => patch.state === "closed")) {
    return { state: "closed", reason: `${patches.length} carried patch(es) already fixed upstream` };
  }
  return { state: "open", reason: `${patches.filter((p) => p.state === "open").length} of ${patches.length} carried patch(es) not fixed upstream yet` };
}

async function checkComponent(
  component: StackSnapshot,
  port: StackFetchJson,
  opts: Required<Pick<StackCheckOptions, "perPage">> & Pick<StackCheckOptions, "noteLimit" | "retryDelayMs">,
  checkedAt: string,
): Promise<StackSnapshot> {
  if (component.upstream.kind !== "github" || !STACK_CHECKABLE_RELEASE_SOURCES.includes(component.releaseSource)) {
    return component;
  }
  const repo = component.upstream.repo;
  const source = component.releaseSource === "github-tags" ? "github-tags" : "github-releases";
  const previous = component.upstreamState ?? null;
  // A transport failure here propagates: the whole check fails and the cache
  // stays untouched (the route answers 503).
  const listUrl = githubListUrl(repo, source, opts.perPage);
  let res = await port(listUrl);
  // STACK-WATCH-LIVE: on a rate-limit (403/429) or a server error, retry once
  // after a short delay before declaring the component stale.
  if ((res.status === 403 || res.status === 429 || res.status >= 500) && opts.retryDelayMs != null && opts.retryDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, opts.retryDelayMs));
    res = await port(listUrl);
  }
  if (res.status < 200 || res.status >= 300) {
    return { ...component, upstreamState: readOnlyUpstream(previous, checkedAt, `github ${res.status}`) };
  }
  const releases = readReleaseList(source, res.json);
  const seedEntry = STACK_SEED.find((seed) => seed.name === component.name);
  const tagPrefix = seedEntry?.tagPrefix ?? null;
  const filtered = tagPrefix ? releases.filter((release) => release.tag.startsWith(tagPrefix)) : releases;
  const stableReleases = filtered.filter((release) => !isPrereleaseTag(release.tag));
  const { latest, behindBy } = countBehind(filtered, component.local.version ?? component.local.commit);
  const notes = source === "github-releases"
    ? extractReleaseNotes(stableReleases, { limit: opts.noteLimit })
    : null;
  const firstSeenAt = latest && latest === previous?.latest
    ? previous?.firstSeenAt ?? checkedAt
    : latest ? checkedAt : null;
  const upstream: StackUpstreamState = {
    checkedAt,
    latest,
    latestPublishedAt: stableReleases[0]?.publishedAt ?? null,
    firstSeenAt,
    previousLatest: previous?.latest ?? null,
    behindBy,
    notes: notes ?? (latest != null && latest === previous?.latest ? previous?.notes ?? null : null),
    error: null,
    staleSince: null,
  };
  const patches = await evaluatePatches(component, latest, port, checkedAt);
  return {
    ...component,
    local: { ...component.local, patches },
    upstreamState: upstream,
    patchClosed: aggregatePatchClosed(patches),
  };
}

/**
 * Build the JSON port of one release check:
 *
 *   1. an injected port wins (tests, the route's fake mode);
 *   2. the `stack.github_token` instance secret / MYRMIDON_STACK_GITHUB_TOKEN
 *      when the operator set one;
 *   3. a strictly read-only token minted from the board's own GitHub App
 *      (the STACK-WATCH-LIVE fallback): an App entry serves the check when it
 *      grants the `system` role for the component repository. The first
 *      component that mints one reuses the port — the token is cached by the
 *      mint itself until five minutes before expiry. No matching entry, an
 *      ambiguity, or a failed mint all answer anonymous: the check's own
 *      403/429/5xx retry and stale marking remain the signal.
 */
async function buildStackGithubPort(db: Db, options: StackCheckOptions): Promise<StackFetchJson> {
  if (options.fetchJson) return options.fetchJson;
  const githubFetchImpl = options.githubAppFetchImpl;
  const instanceToken = (await resolveOptionalInstanceSecret("stack.github_token", "stack-registry")) ?? undefined;
  if (instanceToken) return githubJsonPort({ token: instanceToken, fetchImpl: githubFetchImpl });
  let shared: StackFetchJson | null = null;
  return async (url, fetchOptions) => {
    const repo = extractGithubApiRepo(url);
    if (!repo) return githubJsonPort({ fetchImpl: githubFetchImpl })(url, fetchOptions);
    const resolveRepoToken = async (): Promise<string | undefined> => {
      const resolution = await resolveStackCheckGitHubAppToken(db, repo, {
        fetchImpl: githubFetchImpl,
      });
      if (resolution.kind !== "issued") return undefined;
      shared = githubJsonPort({ token: resolution.token, fetchImpl: githubFetchImpl });
      return resolution.token;
    };
    const bearer = shared ? undefined : await resolveRepoToken();
    const port = shared ?? githubJsonPort({ fetchImpl: githubFetchImpl });
    const res = await port(url, fetchOptions);
    // A minted token the API rejects: do not ride it for the rest of the
    // check — finish the request anonymously. A 403 stays as-is: anonymous is
    // strictly worse there (the shared-IP budget is spent), and the check's
    // own retry-then-stale marking is the signal.
    if (bearer !== undefined && res.status === 401) {
      shared = null;
      return githubJsonPort({ fetchImpl: githubFetchImpl })(url, fetchOptions);
    }
    return res;
  };
}

/** The `owner/repo` of a github.com REST URL, null for anything else. */
export function extractGithubApiRepo(url: string): string | null {
  if (!url.startsWith(STACK_GITHUB_API_BASE)) return null;
  const m = /^\/repos\/([^/?#]+)\/([^/?#]+)(?:\/|$)/.exec(url.slice(STACK_GITHUB_API_BASE.length));
  return m ? `${decodeURIComponent(m[1]!)}/${decodeURIComponent(m[2]!)}` : null;
}

/**
 * Run one release check over the cached document and write the result back.
 * Throws a probe error when the network is unreachable; the caller keeps the
 * previous cache.
 */
export async function checkStackReleases(db: Db, options: StackCheckOptions = {}): Promise<StackDocument> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const port = await buildStackGithubPort(db, options);
  // STACK-WATCH-LIVE: the check itself refreshes the local side first, so the
  // sweep needs no manual "refresh" and lag is measured against live versions.
  const stored = await readStackDocument(db);
  const localBase = options.collect === false
    ? (stored.components.length > 0 ? stored : seedStackDocument())
    : await collectStackLocal({
      ...(options.collect ?? {}),
      now: options.now,
      previous: stored.components.length > 0 ? stored : undefined,
    });
  const base = localBase.components.length > 0 ? localBase : seedStackDocument();
  const opts = {
    perPage: options.perPage ?? STACK_CHECK_PER_PAGE,
    noteLimit: options.noteLimit,
    retryDelayMs: options.retryDelayMs ?? STACK_CHECK_RETRY_DELAY_MS,
  };
  const components: StackSnapshot[] = [];
  for (const component of base.components) {
    components.push(await checkComponent(component, port, opts, checkedAt));
  }

  // Query OSV.dev advisories for components with advisory packages and known versions.
  // Auxiliary step: gracefully degrades without failing release check if OSV is down.
  const advisoryQueries: StackAdvisoryQuery[] = [];
  for (const c of components) {
    const pkg = c.advisoryPackage;
    const version = c.local.version ? normaliseVersion(c.local.version) : null;
    if (pkg && version) {
      advisoryQueries.push({
        componentName: c.name,
        package: pkg,
        version,
      });
    }
  }

  if (advisoryQueries.length > 0) {
    try {
      const osvBase = options.osvApiBase ?? readStackOsvApiBase() ?? undefined;
      const advisoryPort = options.fetchJson ?? osvJsonPort();
      const vulnsByComponent = await queryOsvAdvisories(advisoryQueries, advisoryPort, osvBase);
      for (let i = 0; i < components.length; i++) {
        const c = components[i]!;
        const vulns = vulnsByComponent.get(c.name);
        if (vulns && vulns.length > 0) {
          components[i] = {
            ...c,
            vulnerabilities: vulns,
          };
        } else if (c.vulnerabilities && !vulnsByComponent.has(c.name) && advisoryQueries.some((q) => q.componentName === c.name)) {
          // If queried and no vulns returned, clear any stale vulnerabilities
          components[i] = {
            ...c,
            vulnerabilities: [],
          };
        }
      }
    } catch {
      // Degrade gracefully: network/transport failure for advisory never fails release check
    }
  }
  const next: StackDocument = {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: base.refreshedAt,
    checkedAt,
    components,
  };
  await writeStackDocument(db, next);
  const lagThreshold = options.lagThreshold ?? readStackBacklogLagReleases();
  const companiesList = await db.select({ id: companies.id }).from(companies);
  for (const company of companiesList) {
    try {
      const openComponents = options.findOpenComponents
        ? await options.findOpenComponents(company.id)
        : await db
            .select({ originId: issues.originId })
            .from(issues)
            .where(
              and(
                eq(issues.companyId, company.id),
                eq(issues.originKind, "stack_update"),
                notInArray(issues.status, ["done", "cancelled"]),
                isNotNull(issues.originId),
              ),
            )
            .then((rows) => rows.map((r) => r.originId!).filter(Boolean));

      const drafts = decideStackBacklogDrafts(next, { lagThreshold, openComponents });
      for (const draft of drafts) {
        if (options.createDraft) {
          await options.createDraft(company.id, draft);
        } else {
          const { issueService } = await import("../../services/issues.js");
          await issueService(db).create(company.id, {
            title: draft.title,
            description: draft.summary,
            status: "todo",
            priority: "medium",
            originKind: "stack_update",
            originId: draft.component,
            allowDuplicate: true,
          } as never);
        }
      }
    } catch (err) {
      logger.warn({ err, companyId: company.id }, "stack backlog draft creation failed");
    }
  }
  return next;
}

/**
 * Mount the periodic release check. Off by default (no interval configured):
 * the board touches the network only when an operator sets the interval.
 */
let currentSweepStop: (() => void) | null = null;

export function stopStackCheckSweep(): void {
  currentSweepStop?.();
  currentSweepStop = null;
}

export function startStackCheckSweep(db: Db, options: StackCheckOptions = {}): () => void {
  stopStackCheckSweep();
  const intervalSec = readStackCheckIntervalSec();
  if (intervalSec <= 0) return () => {};
  let running = false;
  const run = () => {
    if (running) return;
    running = true;
    void checkStackReleases(db, options)
      .catch((err) => logger.error({ err }, "stack release check sweep failed"))
      .finally(() => {
        running = false;
      });
  };
  const timer = backgroundInterval(run, intervalSec * 1000);
  timer.unref?.();
  const stopCurrentSweep = () => clearInterval(timer);
  currentSweepStop = stopCurrentSweep;
  run();
  return () => {
    stopCurrentSweep();
    if (currentSweepStop === stopCurrentSweep) currentSweepStop = null;
  };
}
