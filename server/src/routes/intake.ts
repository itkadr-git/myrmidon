// server/src/routes/intake.ts
// myrmidon(1.7 WEBHOOK-INTAKE): Public webhook intake route (/api/intake/:source).
// Accepts inbound events, responds 202 with intake id, enqueues to the parse queue,
// and enforces per-source rate limits.

import { Router, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { badRequest, forbidden, tooManyRequests, unauthorized } from "../errors.js";
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
      res.setHeader("Retry-After", String(limitResult.retryAfterSeconds));
      throw tooManyRequests(`Rate limit exceeded for source '${sourceParam}'`, {
        source: sourceParam,
        retryAfterSeconds: limitResult.retryAfterSeconds,
      });
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

  const handleGetQueueItem = async (req: Request, res: Response) => {
    const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const item = await queue.get(id);
    if (!item) {
      res.status(404).json({ error: "Not found", id: req.params.id });
      return;
    }
    res.json(item);
  };

  router.get("/api/intake/queue/:id", handleGetQueueItem);
  router.get("/intake/queue/:id", handleGetQueueItem);

  const handleListQueue = async (req: Request, res: Response) => {
    const source = typeof req.query.source === "string" ? req.query.source : undefined;
    const limit = typeof req.query.limit === "string" ? Number.parseInt(req.query.limit, 10) : undefined;
    const items = await queue.list({ source, limit });
    res.json({ count: items.length, items });
  };

  router.get("/api/intake/queue", handleListQueue);
  router.get("/intake/queue", handleListQueue);

  return router;
}
