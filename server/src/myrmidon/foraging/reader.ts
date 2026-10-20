// server/src/myrmidon/foraging/reader.ts
//
// myrmidon(1.6-FORAGE): the only place the sweep talks to the outside world.
//
// An automatic, repeating call to a third-party host carries rules of its own
// (docs/myrmidon, and the fleet's own external-call discipline): a pause between
// two reads of the same host, an honest User-Agent, and a breaker that stops the
// host after repeated failures instead of hammering it every pass. All three live
// here, on module state shared by every pass and every company of the process, so
// two agents of two companies pointing at one host cannot double the rate.
//
// Network access is delegated to vm-exec. vm-core never calls source URLs or
// the Firecrawl provider directly; the answer remains capped for snapshots.

import { createHash, randomUUID } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import { MAX_SOURCE_BYTES } from "./domain.js";
import type { ForagingReader, ForagingReaderResult } from "./service.js";
import type { ForagingSourceRef } from "./domain.js";
import { injectionScoreThreshold, scanForInjection } from "../guardrails/injection.js";

/** The breaker: after this many consecutive failures a host is left alone. */
export const BREAKER_FAILURE_THRESHOLD = 2;
/** How long the breaker stays open, in milliseconds. */
export const BREAKER_OPEN_MS = 6 * 60 * 60 * 1000;
/** How long one read may take, in milliseconds. */
export const READ_TIMEOUT_MS = 15_000;
/** The tool name and contact the host sees; a host must know who is knocking. */
export const FORAGING_USER_AGENT = "myrmidon-foraging/1.0 (+https://github.com/itkadr-git/myrmidon)";

interface HostState {
  lastReadAt: number;
  failures: number;
  openUntil: number;
}

/** Shared by every pass of this process: the rate limit and the breaker. */
const hostStates = new Map<string, HostState>();

/** Test hook: forget every host's pause and breaker. */
export function resetForagingHostState(): void {
  hostStates.clear();
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return url;
  }
}

function stateOf(host: string): HostState {
  let state = hostStates.get(host);
  if (!state) {
    state = { lastReadAt: 0, failures: 0, openUntil: 0 };
    hostStates.set(host, state);
  }
  return state;
}

/** Thrown when the breaker is open; the pass records it as the source's error. */
export class ForagingHostPausedError extends Error {
  constructor(host: string) {
    super(`foraging: host ${host} is paused after repeated failures`);
    this.name = "ForagingHostPausedError";
  }
}

/** Thrown when two reads of one host would be closer than the pause. */
export class ForagingHostThrottledError extends Error {
  constructor(host: string) {
    super(`foraging: host ${host} was read less than the minimum interval ago`);
    this.name = "ForagingHostThrottledError";
  }
}

export interface ForagingReaderDeps {
  env?: NodeJS.ProcessEnv;
  minHostIntervalMs: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Calls the authenticated vm-exec gateway; injected for tests. */
  edgeFetch?: (request: ForagingEdgeFetchRequest, signal: AbortSignal) => Promise<ForagingEdgeFetchResponse>;
  log?: Pick<typeof logger, "warn" | "error">;
}

export interface ForagingEdgeFetchRequest {
  request_id: string;
  url: string;
  mode: "scrape";
  max_depth: 0;
  timeout_ms: number;
  idempotency_key: string;
}

export interface ForagingEdgeFetchResponse {
  request_id: string;
  status: "succeeded";
  pages: Array<{
    url: string;
    final_url: string;
    title: string | null;
    markdown: string;
    fetched_at: string;
    content_sha256: string;
  }>;
  truncated: boolean;
}

/** The production reader: `fetch` under the host rules above. */
export function createForagingReader(deps: ForagingReaderDeps): ForagingReader {
  const edgeFetch = deps.edgeFetch ?? createHttpEdgeFetchClient(deps);
  const now = deps.now ?? (() => Date.now());
  const log = deps.log ?? logger;

  return {
    async read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult> {
      const host = hostOf(source.url);
      const state = stateOf(host);
      const at = now();
      if (state.openUntil > at) throw new ForagingHostPausedError(host);
      if (at - state.lastReadAt < deps.minHostIntervalMs) {
        throw new ForagingHostThrottledError(host);
      }
      state.lastReadAt = at;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
      if (typeof timer.unref === "function") timer.unref();
      signal.addEventListener("abort", () => controller.abort(), { once: true });

      try {
        const requestId = randomUUID();
        const fetched = await edgeFetch({
          request_id: requestId,
          url: source.url,
          mode: "scrape",
          max_depth: 0,
          timeout_ms: READ_TIMEOUT_MS,
          idempotency_key: requestId,
        }, controller.signal);
        if (fetched.request_id !== requestId || fetched.status !== "succeeded") {
          throw new Error("foraging: edge fetch returned an invalid response");
        }
        const page = fetched.pages[0];
        if (!page || page.url !== source.url || !page.content_sha256 || !page.fetched_at) {
          throw new Error("foraging: edge fetch response is missing source provenance");
        }
        const body = page.markdown;
        const scannerVerdict = scanForInjection(body, injectionScoreThreshold(deps.env));
        if (scannerVerdict.flagged) {
          throw new Error(`foraging: edge fetch content rejected by injection scanner (${scannerVerdict.matched.join(",")})`);
        }
        // A snapshot is compared by content; a body over the cap is cut and the
        // cut is visible in the hash the caller never sees — kept simple here.
        const cut = body.length > MAX_SOURCE_BYTES ? body.slice(0, MAX_SOURCE_BYTES) : body;
        state.failures = 0;
        return { text: cut, bytes: cut.length, page: { ...page, request_id: requestId, scanner_verdict: scannerVerdict } };
      } catch (err) {
        state.failures += 1;
        if (state.failures >= BREAKER_FAILURE_THRESHOLD) {
          state.openUntil = now() + BREAKER_OPEN_MS;
          log.warn(
            { host, failures: state.failures, openUntil: state.openUntil },
            "foraging: host breaker opened after repeated failures",
          );
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** A stable fingerprint of a snapshot; handy for logs and dedup in tests. */
export function snapshotFingerprint(lines: readonly string[]): string {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 16);
}

function createHttpEdgeFetchClient(deps: ForagingReaderDeps): NonNullable<ForagingReaderDeps["edgeFetch"]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const gateway = deps.env?.MYRMIDON_VMEXEC_URL?.trim();
  const token = deps.env?.MYRMIDON_VMEXEC_TOKEN?.trim();
  if (!gateway || !token) {
    return async () => {
      throw new Error("foraging: vm-exec edge fetch is not configured");
    };
  }
  const endpoint = new URL("/internal/v1/firecrawl/fetch", gateway).toString();
  return async (request, signal) => {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(request),
      signal,
    });
    if (!response.ok) throw new Error(`foraging: vm-exec edge fetch answered ${response.status}`);
    return await response.json() as ForagingEdgeFetchResponse;
  };
}