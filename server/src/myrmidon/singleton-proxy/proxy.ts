// server/src/myrmidon/singleton-proxy/proxy.ts
//
// myrmidon(1.6.6 PROCS-1.5 / OPE-5412, design OPE-5394 §7.1): the single-route
// proxy of an api process. A request for a route of the allowlist is forwarded
// to the worker's loopback listener (the full board app, PROCS-1.1) and the
// worker's answer is streamed back unchanged.
//
// Authorization is transparent: the request goes through byte for byte —
// method, URL, headers (Authorization, Cookie, Host, Origin) and body — and
// the worker resolves the actor from the same credentials with its own actor
// middleware, so the proxy neither authenticates nor adds privileges. The
// proxy is mounted before the actor middleware on purpose: the api process
// does not authenticate a request it will not answer.
//
// Only active in the `api` role AND while the saved setting
// `processes.singletonProxy` is on (default on). With the setting off, or in
// the single-process board (role `all`), the middleware is not mounted /
// passes through and the request is served locally, as before.
// An unreadable setting with no cached value counts as on (fail-closed).
//
// The worker being down is a 503 with Retry-After, never a local fallback: the
// api process has none of the state these routes need (no plugin workers, no
// docker driver), and a local 404/empty answer would be a silent lie.

import http from "node:http";
import type { Request, RequestHandler, Response } from "express";
import { logger } from "../../middleware/logger.js";
import { singletonRouteGroup } from "./allowlist.js";
import { recordSingletonProxy } from "./counters.js";

export interface SingletonProxyTarget {
  host: string;
  port: number;
}

export interface SingletonProxyOptions {
  /** The worker's loopback listener. */
  target: SingletonProxyTarget;
  /** Whether forwarding is on right now (the saved `singletonProxy` setting). */
  enabled: () => boolean | Promise<boolean>;
  /** Timeout of the worker connection / silence, ms. */
  timeoutMs?: number;
}

/** Hop-by-hop headers (RFC 9110 section 7.6.1): never forwarded either way. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export const SINGLETON_PROXY_DEFAULT_TIMEOUT_MS = 120_000;

/** Names listed in the `Connection` header are hop-by-hop too (RFC 9110
 * section 7.6.1): `Connection: close, x-foo` removes `x-foo` as well. */
function connectionTokens(value: string | string[] | undefined): Set<string> {
  const tokens = new Set<string>();
  if (value === undefined) return tokens;
  for (const part of Array.isArray(value) ? value : [value]) {
    for (const token of part.split(",")) {
      const name = token.trim().toLowerCase();
      if (name) tokens.add(name);
    }
  }
  return tokens;
}

/** Copies headers minus the hop-by-hop set and anything `Connection` names. */
export function stripHopByHop(
  source: http.IncomingHttpHeaders,
): http.OutgoingHttpHeaders {
  const listed = connectionTokens(source.connection);
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(source)) {
    if (HOP_BY_HOP.has(name) || listed.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
}

function forwardedHeaders(req: Request): http.OutgoingHttpHeaders {
  const headers = stripHopByHop(req.headers);
  // The client address as this api process resolves it under its own trust
  // proxy policy (TRUST_PROXY), not a chain extended by this hop: the worker
  // sees the api process as its immediate peer, so with the same TRUST_PROXY
  // its `req.ip` is the client too, and an untrusted caller cannot plant
  // addresses through its own X-Forwarded-For (OPE-9107).
  if (req.ip) headers["x-forwarded-for"] = req.ip;
  else delete headers["x-forwarded-for"];
  return headers;
}

function unavailable(res: Response, reason: string): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.status(503).set("Retry-After", "2").json({
    error: "worker_unavailable",
    message: `The board worker process did not answer this request (${reason}). Try again shortly.`,
  });
}

export function singletonProxyMiddleware(options: SingletonProxyOptions): RequestHandler {
  const timeoutMs = options.timeoutMs ?? SINGLETON_PROXY_DEFAULT_TIMEOUT_MS;
  return async (req, res, next) => {
    // Mounted at the app root, before the body parsers: `/api/...` paths only,
    // and the body stream is still unread when it is piped to the worker.
    if (!req.path.startsWith("/api/")) return next();
    const group = singletonRouteGroup(req.method, req.path.slice("/api".length));
    if (!group) return next();

    // Fail closed (OPE-9107): when the setting cannot be read and nothing is
    // cached, the answer is unknown — forward to the worker (the default is
    // on), never serve a singleton route locally on an api process.
    let on = true;
    try {
      on = await options.enabled();
    } catch (err) {
      logger.warn({ err }, "singleton proxy: setting unknown, forwarding to the worker");
    }
    if (!on) return next();

    const upstream = http.request(
      {
        host: options.target.host,
        port: options.target.port,
        method: req.method,
        path: req.originalUrl,
        headers: forwardedHeaders(req),
        timeout: timeoutMs,
      },
      (upstreamRes) => {
        recordSingletonProxy(group, "proxied");
        const headers = stripHopByHop(upstreamRes.headers);
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, headers);
        upstreamRes.pipe(res);
        upstreamRes.on("error", () => res.destroy());
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", (err) => {
      logger.warn({ err, route: group }, "singleton proxy: worker unreachable");
      recordSingletonProxy(group, "unavailable");
      unavailable(res, (err as NodeJS.ErrnoException).code ?? err.message);
    });
    res.on("close", () => {
      if (!upstream.destroyed && !res.writableEnded) upstream.destroy();
    });
    req.pipe(upstream);
  };
}
