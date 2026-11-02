// myrmidon(1.6-FORAGE): rate limiting and domain tracking for web sources.
//
// The web is external and untrusted. Sources must not be hammered, failing
// servers must not be retried in a tight loop, and consecutive runs must not
// drift across multiple processes. A host's rate limit is statefully tracked
// here, on module state shared by every pass and every company of the process, so
// two agents of two companies pointing at one host cannot double the rate.
//
// Network access is either delegated to the optional edge gateway (on myr-vm1) or made
// directly to the registered source URL. Responses are bounded before parsing.

import { createHash, randomUUID } from "node:crypto";
import { logger } from "../../middleware/logger.js";
import {
  scanForInjection,
  injectionScoreThreshold,
  type ScannerVerdict,
} from "./quarantine.js";
import type {
  ForagingEdgeFetchRequest,
  ForagingEdgeFetchResponse,
  ForagingReaderResult,
  ForagingSourceRef,
} from "./domain.js";

export const DEFAULT_MIN_HOST_INTERVAL_MS = 5000;
export const MAX_CONSECUTIVE_ERRORS = 5;
export const BREAKER_OPEN_MS = 6 * 60 * 60 * 1000;
export const READ_TIMEOUT_MS = 15_000;
/** The tool name and contact the host sees; a host must know who is knocking. */
export const FORAGING_USER_AGENT = "myrmidon-foraging/1.0 (+https://github.com/itkadr-git/myrmidon)";
/** Maximum source response body accepted from the network, in bytes. */
export const MAX_FORAGING_RESPONSE_BYTES = 2 * 1024 * 1024;

interface HostState {
  lastReadAt: number;
  consecutiveErrors: number;
  breakerOpenUntil: number | null;
}

const hostRegistry = new Map<string, HostState>();

/** For tests: reset in-memory rate-limiter state between test cases. */
export function resetForagingHostState(): void {
  hostRegistry.clear();
}

function extractHost(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

export interface ForagingReaderOptions {
  minHostIntervalMs?: number;
  maxConsecutiveErrors?: number;
  breakerOpenMs?: number;
}

export interface ForagingReader {
  read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult>;
}

export interface ForagingReaderDeps {
  env?: Record<string, string | undefined>;
  minHostIntervalMs?: number;
  maxConsecutiveErrors?: number;
  breakerOpenMs?: number;
  readKey?: (companyId: string, secretName: string | null) => Promise<string | null>;
  now?: () => number;
  fetchImpl?: typeof fetch;
  /** Calls the authenticated optional edge gateway; injected for tests. */
  edgeFetch?: (request: ForagingEdgeFetchRequest, signal: AbortSignal) => Promise<ForagingEdgeFetchResponse>;
  log?: Pick<typeof logger, "warn" | "error">;
}

export interface ForagingFetcher {
  fetch(source: ForagingSourceRef, signal?: AbortSignal): Promise<ForagingReaderResult>;
}

/** The production reader: uses the optional gateway or reads the source directly. */
export function createForagingReader(deps: ForagingReaderDeps): ForagingReader & ForagingFetcher {
  const edgeFetch = deps.edgeFetch ?? createHttpEdgeFetchClient(deps);
  const now = deps.now ?? (() => Date.now());
  const minInterval = deps.minHostIntervalMs ?? DEFAULT_MIN_HOST_INTERVAL_MS;
  const maxErrors = deps.maxConsecutiveErrors ?? MAX_CONSECUTIVE_ERRORS;
  const breakerMs = deps.breakerOpenMs ?? BREAKER_OPEN_MS;
  const log = deps.log ?? logger;

  async function fetchInternal(source: ForagingSourceRef, signal?: AbortSignal): Promise<ForagingReaderResult> {
    const host = extractHost(source.url);
    if (!host) {
      throw new Error(`foraging: cannot extract host from source URL "${source.url}"`);
    }

    const state = hostRegistry.get(host) ?? {
      lastReadAt: 0,
      consecutiveErrors: 0,
      breakerOpenUntil: null,
    };

    const currentTime = now();
    if (state.breakerOpenUntil && currentTime < state.breakerOpenUntil) {
      throw new Error(
        `foraging: circuit breaker open for host "${host}" until ${new Date(state.breakerOpenUntil).toISOString()}`,
      );
    }

    const elapsed = currentTime - state.lastReadAt;
    if (elapsed < minInterval) {
      throw new Error(
        `foraging: rate limit hit for host "${host}". Minimum interval is ${minInterval}ms, elapsed ${elapsed}ms`,
      );
    }

    try {
      const edgeRequest: ForagingEdgeFetchRequest = {
        request_id: randomUUID(),
        url: source.url,
        mode: "scrape",
        max_depth: 0,
        timeout_ms: READ_TIMEOUT_MS,
        idempotency_key: `${source.sourceId}:${source.url}`,
      };
      const effectiveSignal = signal ?? new AbortController().signal;
      const fetched = await edgeFetch(edgeRequest, effectiveSignal);
      if (fetched.status !== "succeeded" || !Array.isArray(fetched.pages)) {
        throw new Error("foraging: edge fetch returned an invalid response");
      }
      const page = fetched.pages[0];
      if (!page || page.url !== source.url || page.final_url !== source.url || !page.content_sha256 || !page.fetched_at) {
        throw new Error("foraging: edge fetch response is missing source provenance or redirected");
      }
      const body = page.markdown;
      const scannerVerdict = scanForInjection(body, injectionScoreThreshold(deps.env));
      if (scannerVerdict.blocked) {
        throw new Error(
          `foraging: injection blocked for "${source.url}": reason=${scannerVerdict.reason ?? "unknown"}, score=${scannerVerdict.score}`,
        );
      }

      state.lastReadAt = now();
      state.consecutiveErrors = 0;
      state.breakerOpenUntil = null;
      hostRegistry.set(host, state);

      return {
        text: body,
        bytesRead: Buffer.byteLength(body, "utf8"),
        scannerVerdict,
        page,
      };
    } catch (err) {
      state.consecutiveErrors += 1;
      state.lastReadAt = now();
      if (state.consecutiveErrors >= maxErrors) {
        state.breakerOpenUntil = now() + breakerMs;
        log.warn(
          { host, errors: state.consecutiveErrors, openUntil: state.breakerOpenUntil },
          `foraging: opening circuit breaker for host "${host}"`,
        );
      }
      hostRegistry.set(host, state);
      throw err;
    }
  }

  return {
    read(source: ForagingSourceRef, signal: AbortSignal): Promise<ForagingReaderResult> {
      return fetchInternal(source, signal);
    },
    fetch(source: ForagingSourceRef, signal?: AbortSignal): Promise<ForagingReaderResult> {
      return fetchInternal(source, signal);
    },
  };
}

export function snapshotFingerprint(lines: string[]): string {
  const norm = lines.map((l) => l.trim()).filter((l) => l.length > 0).join("\n");
  return createHash("sha256").update(norm).digest("hex");
}

function createHttpEdgeFetchClient(deps: ForagingReaderDeps): NonNullable<ForagingReaderDeps["edgeFetch"]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const gateway = (deps.env?.MYRMIDON_FORAGING_FETCHER_URL || deps.env?.MYRMIDON_VMEXEC_URL)?.trim();
  const token = (deps.env?.MYRMIDON_FORAGING_FETCHER_TOKEN || deps.env?.MYRMIDON_VMEXEC_TOKEN)?.trim();
  if (gateway && token) {
    const endpoint = new URL("/internal/v1/firecrawl/fetch", gateway).toString();
    return async (request, signal) => {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) throw new Error(`foraging: edge fetch answered ${response.status}`);
      return await response.json() as ForagingEdgeFetchResponse;
    };
  }
  return async (request, signal) => {
    const target = new URL(request.url);
    if (target.protocol !== "http:" && target.protocol !== "https:") {
      throw new Error("foraging: source URL must use http or https");
    }
    const response = await fetchImpl(target, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": FORAGING_USER_AGENT, accept: "text/html,text/plain,application/xhtml+xml" },
      signal,
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      throw new Error("foraging: source redirects are not allowed");
    }
    if (!response.ok) throw new Error(`foraging: source answered ${response.status}`);
    const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
    if (!contentType.startsWith("text/") && contentType !== "application/xhtml+xml") {
      await response.body?.cancel();
      throw new Error("foraging: source content type is not text");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_FORAGING_RESPONSE_BYTES) {
      await response.body?.cancel();
      throw new Error("foraging: source response exceeds the 2 MB limit");
    }
    const bytes = await readBoundedBody(response, signal);
    const raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const text = contentType === "text/html" || contentType === "application/xhtml+xml" ? htmlToMarkdown(raw) : raw;
    return {
      request_id: request.request_id,
      status: "succeeded",
      truncated: false,
      pages: [{
        url: request.url,
        final_url: request.url,
        title: null,
        markdown: text,
        fetched_at: new Date().toISOString(),
        content_sha256: createHash("sha256").update(bytes).digest("hex"),
      }],
    };
  };
}

async function readBoundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw new Error("foraging: source read timed out");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FORAGING_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("foraging: source response exceeds the 2 MB limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function htmlToMarkdown(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\s+/g, " ")
    .trim();
}
