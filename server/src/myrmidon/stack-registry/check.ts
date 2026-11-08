// Stack registry (SUA, part B): the release check.
//
// For every component with a GitHub release source the checker reads the
// anonymous release/tag list, records the latest upstream release, how many
// releases we are behind (when our version appears in that feed), the notable
// release-note lines and — for components with carried deltas — whether the
// upstream range already contains the fix commits (GitHub compare API). The
// result is written back into the stack cache (document schema version 2).
//
// The same function backs both triggers: the daily/manual `POST
// /api/myrmidon/stack/check` and the interval sweep mounted from the server
// entry point. A transport failure is thrown and surfaces as 503 with the
// previous cache intact; an HTTP status is recorded per component.

import type { Db } from "@myrmidon/db";
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
import { readStackCheckIntervalSec } from "./settings.js";
import { resolveOptionalInstanceSecret } from "../secret-settings/runtime.js"; // myrmidon(SETTINGS-UI E2.6)
import { readStackDocument, writeStackDocument } from "./store.js";
import { collectStackLocal, type CollectStackLocalOptions } from "./collector.js";
import { fileStackLagTasks } from "./escalation.js";
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
  /** Delay before one retry on 403/429/5xx; 0 disables the retry. */
  retryDelayMs?: number;
  /**
   * Local-state collection options for the pre-check refresh. Pass `false` to
   * keep the stored local state untouched (tests that only exercise part B).
   */
  collect?: CollectStackLocalOptions | false;
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
  opts: Required<Pick<StackCheckOptions, "perPage">> & { noteLimit?: number },
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
 * Run one release check over the cached document and write the result back.
 * Throws a probe error when the network is unreachable; the caller keeps the
 * previous cache.
 */
export async function checkStackReleases(db: Db, options: StackCheckOptions = {}): Promise<StackDocument> {
  const checkedAt = (options.now ?? (() => new Date()))().toISOString();
  const port =
    options.fetchJson ??
    githubJsonPort({
      token: (await resolveOptionalInstanceSecret("stack.github_token", "stack-registry")) ?? undefined,
    });
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
  const next: StackDocument = {
    version: STACK_DOCUMENT_VERSION,
    refreshedAt: base.refreshedAt,
    checkedAt,
    components,
  };
  await writeStackDocument(db, next);
  // STACK-WATCH-LIVE: file one backlog task per lagging component (dedup by
  // component) in every company. Best-effort — a failure here must never fail
  // the check.
  try {
    const { companies } = await import("@myrmidon/db");
    const rows = await db.select({ id: companies.id }).from(companies);
    for (const row of rows) {
      await fileStackLagTasks(db, row.id, next, new Date(checkedAt), logger);
    }
  } catch (err) {
    logger.warn({ err }, "stack lag task filing failed");
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