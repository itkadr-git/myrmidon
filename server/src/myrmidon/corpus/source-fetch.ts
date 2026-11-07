// server/src/myrmidon/corpus/source-fetch.ts
//
// myrmidon(1.6.6 OPE-12000): the one place the corpus module reaches out to the
// network. A document added "by address" is downloaded here, and so is every
// scheduled refresh of it.
//
// The fetch is the SSRF surface of the module, so it goes through the board's
// existing guarded transport (`guardedRemoteHttpFetch`, PAP-17098) instead of a
// bare `fetch`: the hostname is resolved once, every resolved address must be
// public, the socket is dialled at an approved address (no second lookup for a
// rebinding name server to answer differently), and the peer address is checked
// again before a request byte is written. The transport never follows
// redirects, so this file follows them itself — each hop through the whole guard
// again — up to CORPUS_SOURCE_MAX_REDIRECTS.
//
// Bounded on every side: http/https only, no credentials in the address, a
// deadline for the whole download, and the same byte ceiling as an upload
// (`maxDocumentBytes`), enforced on the decoded stream so a compression bomb
// cannot get past a small Content-Length.

import { createHash } from "node:crypto";
import {
  guardedRemoteHttpFetch,
  type GuardedRemoteHttpFetchOptions,
} from "../../services/remote-http-fetch.js";
import type { RemoteHttpEndpointLookup } from "../../services/remote-http-endpoint-guard.js";

/** Deadline for one whole download (all redirect hops included). */
export const CORPUS_SOURCE_FETCH_TIMEOUT_MS = 30_000;
export const CORPUS_SOURCE_MAX_REDIRECTS = 5;

/** A refusal with a machine token; the service turns it into the HTTP answer. */
export class CorpusSourceError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "CorpusSourceError";
  }
}

export interface FetchedSource {
  bytes: Uint8Array;
  /** `Content-Type` without parameters, lower-cased; null when the server sent none. */
  contentType: string | null;
  /** Where the bytes came from after the redirects. */
  finalUrl: string;
  /** SHA-256 of `bytes`, hex. */
  contentHash: string;
}

export interface CorpusSourceFetchLimits {
  maxBytes: number;
  timeoutMs?: number;
}

export type CorpusUrlFetcher = (url: string, limits: CorpusSourceFetchLimits) => Promise<FetchedSource>;

type GuardedFetch = (url: URL, init: RequestInit, options: GuardedRemoteHttpFetchOptions) => Promise<Response>;

export interface CorpusUrlFetcherOptions {
  /** Test seam: the DNS answer the guard sees. Production leaves it unset. */
  lookup?: RemoteHttpEndpointLookup;
  /** Test seam: the transport behind the guard. Production leaves it unset. */
  transport?: GuardedFetch;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The address as it will be fetched and stored: http or https, a host, no
 * user:password, no fragment. Anything else is a 422 `source_url_invalid`.
 */
export function parseCorpusSourceUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new CorpusSourceError(422, "source_url_invalid", "the address is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CorpusSourceError(422, "source_url_invalid", "only http and https addresses can be fetched");
  }
  if (parsed.username || parsed.password) {
    throw new CorpusSourceError(422, "source_url_invalid", "an address with a user name or password is not accepted");
  }
  if (!parsed.hostname) {
    throw new CorpusSourceError(422, "source_url_invalid", "the address has no host");
  }
  parsed.hash = "";
  return parsed;
}

function guardError(_message: string, code: string): Error {
  if (code === "remote_http_private_endpoint") {
    return new CorpusSourceError(
      422,
      "source_url_blocked",
      "the address points to a private, loopback or otherwise reserved network location",
      { reason: code },
    );
  }
  if (code === "remote_http_dns_failed") {
    return new CorpusSourceError(502, "source_fetch_failed", "the host of the address could not be resolved", {
      reason: code,
    });
  }
  if (code === "remote_http_response_timeout") {
    return new CorpusSourceError(504, "source_fetch_timeout", "the server did not answer in time", { reason: code });
  }
  return new CorpusSourceError(502, "source_fetch_failed", "the address could not be reached", { reason: code });
}

async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge(maxBytes);
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge(maxBytes);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function tooLarge(maxBytes: number): CorpusSourceError {
  return new CorpusSourceError(
    413,
    "document_too_large",
    `the document at the address exceeds maxDocumentBytes (${maxBytes})`,
    { maxDocumentBytes: maxBytes },
  );
}

export function createCorpusUrlFetcher(options: CorpusUrlFetcherOptions = {}): CorpusUrlFetcher {
  const transport: GuardedFetch = options.transport ?? guardedRemoteHttpFetch;

  return async (rawUrl, limits) => {
    const timeoutMs = limits.timeoutMs ?? CORPUS_SOURCE_FETCH_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    let current = parseCorpusSourceUrl(rawUrl);

    try {
      for (let hop = 0; hop <= CORPUS_SOURCE_MAX_REDIRECTS; hop += 1) {
        const response = await transport(
          current,
          {
            method: "GET",
            headers: { accept: "text/html,application/xhtml+xml,application/pdf,text/*;q=0.9,*/*;q=0.5" },
            signal,
          },
          {
            error: guardError,
            lookup: options.lookup,
            // Never the board's own network: the corpus has no business with it.
            allowPrivateNetwork: false,
            dnsTimeoutMs: 5_000,
            connectTimeoutMs: 10_000,
            responseTimeoutMs: timeoutMs,
          },
        );

        if (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
          await response.body?.cancel().catch(() => undefined);
          let next: URL;
          try {
            next = new URL(response.headers.get("location")!, current);
          } catch {
            throw new CorpusSourceError(502, "source_fetch_failed", "the server sent an invalid redirect");
          }
          // The next hop re-enters the whole guard, scheme and credentials checks included.
          current = parseCorpusSourceUrl(next.toString());
          continue;
        }

        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel().catch(() => undefined);
          throw new CorpusSourceError(
            502,
            "source_fetch_failed",
            `the server answered ${response.status}`,
            { upstreamStatus: response.status },
          );
        }

        const bytes = await readBounded(response, limits.maxBytes);
        if (bytes.byteLength === 0) {
          throw new CorpusSourceError(422, "empty_document", "the address returned an empty document");
        }
        const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || null;
        return { bytes, contentType, finalUrl: current.toString(), contentHash: sha256Hex(bytes) };
      }
      throw new CorpusSourceError(
        422,
        "too_many_redirects",
        `the address redirects more than ${CORPUS_SOURCE_MAX_REDIRECTS} times`,
      );
    } catch (err) {
      if (err instanceof CorpusSourceError) throw err;
      if (signal.aborted) {
        throw new CorpusSourceError(504, "source_fetch_timeout", `the download took longer than ${timeoutMs} ms`);
      }
      const reason = err instanceof Error ? err.message : String(err);
      throw new CorpusSourceError(502, "source_fetch_failed", "the address could not be fetched", {
        reason: reason.slice(0, 300),
      });
    }
  };
}

/**
 * A readable name for a document added by address when the caller gave none:
 * `host/path`, with the path separators flattened so the multipart filename the
 * parse service receives stays a plain name. A page without an extension gets
 * `.html` when the server said it is HTML, because the parse service picks its
 * reader by the extension as well as by the content type.
 */
export function defaultSourceName(url: URL, contentType: string | null): string {
  const path = url.pathname.replace(/\/+$/, "");
  const base = `${url.hostname}${path}`.replace(/[\\/]+/g, "_").slice(0, 200) || url.hostname;
  const isHtml = contentType === "text/html" || contentType === "application/xhtml+xml";
  if (isHtml && !/\.(html?|xhtml)$/i.test(base)) return `${base}.html`;
  return base;
}
