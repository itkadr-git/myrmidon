// server/src/routes/intake.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Public webhook intake route (/api/intake/:source).
// Accepts inbound events, responds 202 with intake id, enqueues to the parse queue,
// and enforces per-source rate limits.

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { badRequest, forbidden, unauthorized } from "../errors.js";
import {
  type IntakeConfig,
  readIntakeConfig,
  resolveIntakeTokenRef,
} from "../services/intake-config.js";
import {
  type IntakeQueue,
  defaultIntakeQueue,
} from "../services/intake-queue.js";
import {
  type IntakeRateLimiter,
  createIntakeRateLimiter,
} from "../services/intake-rate-limit.js";

export interface IntakeRouteOptions {
  queue?: IntakeQueue;
  config?: IntakeConfig;
  env?: NodeJS.ProcessEnv;
  rateLimiter?: IntakeRateLimiter;
  now?: () => number;
}

const SOURCE_NAME_REGEX = /^[a-zA-Z0-9_\-\.]+$/;

function extractEventId(req: Request): string | null {
  const headerId =
    req.headers["x-event-id"] ||
    req.headers["x-github-delivery"] ||
    req.headers["x-delivery-id"] ||
    req.headers["x-request-id"] ||
    req.headers["svix-id"];
  if (typeof headerId === "string" && headerId.trim()) {
    return headerId.trim();
  }
  if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
    const bodyRecord = req.body as Record<string, unknown>;
    const bodyId = bodyRecord.id ?? bodyRecord.event_id ?? bodyRecord.eventId;
    if (typeof bodyId === "string" && bodyId.trim()) return bodyId.trim();
    if (typeof bodyId === "number") return String(bodyId);
  }
  return null;
}

function extractSignature(req: Request, headerName?: string): string | null {
  if (headerName && typeof req.headers[headerName.toLowerCase()] === "string") {
    return req.headers[headerName.toLowerCase()] as string;
  }
  const defaultHeaders = [
    "x-signature",
    "x-hub-signature-256",
    "x-hub-signature",
    "x-webhook-signature",
    "authorization",
  ];
  for (const h of defaultHeaders) {
    const val = req.headers[h];
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

export function intakeRoutes(options: IntakeRouteOptions = {}) {
  const router = Router();
  const env = options.env ?? process.env;
  const config = options.config ?? readIntakeConfig(env);
  const queue = options.queue ?? defaultIntakeQueue;
  const rateLimiter = options.rateLimiter ?? createIntakeRateLimiter({ config, now: options.now });

  const handlePost = async (req: Request, res: Response) => {
    const rawSource = Array.isArray(req.params.source) ? req.params.source[0] : req.params.source;
    const sourceParam = typeof rawSource === "string" ? rawSource.trim() : "";
    if (!sourceParam || !SOURCE_NAME_REGEX.test(sourceParam)) {
      throw badRequest(`Invalid intake source name: '${req.params.source}'`);
    }

    if (!config.enabled) {
      throw forbidden("Webhook intake is disabled");
    }

    const sourceConfig = config.sources[sourceParam];
    if (sourceConfig?.enabled === false) {
      throw forbidden(`Intake source '${sourceParam}' is disabled`);
    }

    // Rate limiting per source
    const clientIp = req.ip || req.socket?.remoteAddress || "unknown";
    const limitResult = rateLimiter.consume(sourceParam, clientIp);
    res.setHeader("X-RateLimit-Limit", String(limitResult.limit));
    res.setHeader("X-RateLimit-Remaining", String(limitResult.remaining));
    if (!limitResult.allowed) {
      // myrmidon(1.7 WEBHOOK-INTAKE): respond 429 directly so the Retry-After
      // header survives (a thrown HttpError is re-rendered by the central
      // error handler, which drops headers already set on the response).
      res.status(429).json({
        error: `Rate limit exceeded for source '${sourceParam}'`,
        code: "rate_limit_exceeded",
        source: sourceParam,
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
      return;
    }

    // Token authentication if tokenRef configured for this source
    if (sourceConfig?.tokenRef) {
      const expectedToken = resolveIntakeTokenRef(sourceConfig.tokenRef, { env });
      if (expectedToken) {
        let providedToken: string | undefined;
        const authHeader = req.headers.authorization;
        if (typeof authHeader === "string" && /^Bearer\s+/i.test(authHeader)) {
          providedToken = authHeader.replace(/^Bearer\s+/i, "").trim();
        } else if (typeof req.headers["x-webhook-secret"] === "string") {
          providedToken = req.headers["x-webhook-secret"].trim();
        } else if (
          sourceConfig.signatureHeader &&
          typeof req.headers[sourceConfig.signatureHeader.toLowerCase()] === "string"
        ) {
          providedToken = (req.headers[sourceConfig.signatureHeader.toLowerCase()] as string).trim();
        }

        if (!providedToken || providedToken !== expectedToken) {
          throw unauthorized(`Invalid token for intake source '${sourceParam}'`);
        }
      }
    }

    const id = randomUUID();
    const eventId = extractEventId(req);
    const signature = extractSignature(req, sourceConfig?.signatureHeader);
    const rawBody = (req as unknown as { rawBody?: Buffer }).rawBody?.toString("utf8");

    const item = await queue.enqueue({
      id,
      source: sourceParam,
      payload: req.body ?? {},
      rawBody,
      headers: req.headers,
      clientIp,
      eventId,
      signature,
      status: "pending",
      receivedAt: new Date().toISOString(),
    });

    res.status(202).json({
      id: item.id,
      status: "accepted",
      source: item.source,
      enqueuedAt: item.enqueuedAt,
    });
  };

  router.post("/api/intake/:source", handlePost);
  router.post("/intake/:source", handlePost);

  // myrmidon(1.7 WEBHOOK-INTAKE): this router is mounted as public webhook
  // ingress next to the provider webhooks and the auth middleware's
  // intake bypass treats any /intake/<name> path as webhook ingress, so the
  // router intentionally exposes POST-only routes. Queue inspection (listing
  // or reading accepted payloads, headers, client IPs) must not live here;
  // it belongs to authenticated, board-facing tooling if it is ever needed.

  return router;
}
