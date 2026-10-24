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

function forwardedHeaders(req: Request): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  const peer = req.socket.remoteAddress;
  if (peer) {
    const prior = req.headers["x-forwarded-for"];
    headers["x-forwarded-for"] = prior ? `${Array.isArray(prior) ? prior.join(", ") : prior}, ${peer}` : peer;
  }
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

    let on = false;
    try {
      on = await options.enabled();
    } catch (err) {
      logger.warn({ err }, "singleton proxy: setting read failed, serving locally");
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
        const headers: http.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamRes.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) continue;
          headers[name] = value;
        }
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
