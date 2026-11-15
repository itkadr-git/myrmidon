// server/src/myrmidon/monitoring/intake/routes.ts
// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): the intake API.
//
//   POST /api/myrmidon/monitoring/intake/webhook   (HMAC-signed; any source)
//   GET  /api/myrmidon/monitoring/intake/drafts    (board; draft listing, no raw bodies)
//   GET  /api/myrmidon/monitoring/intake/settings  (board; secret NAME only)
//
// The webhook is machine-reachable like the alerts webhook: the actor
// middleware keeps the path out of board/agent auth (see auth.ts) and this
// route authorizes by verifying the HMAC-SHA256 signature of the raw request
// bytes against the configured secret. The verified body is stored verbatim as
// a draft candidate — no routing into execution happens here (next slice).

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { HttpError, badRequest, unauthorized } from "../../../errors.js";
import { assertBoard, assertCompanyAccess } from "../../../routes/authz.js";
import { logActivity } from "../../../services/activity-log.js";
import { logger } from "../../../middleware/logger.js";
import {
  WEBHOOK_INTAKE_SIGNATURE_HEADER,
  WEBHOOK_INTAKE_SIGNATURE_SCHEME,
  extractDelivery,
  normalizeSource,
  verifyHmacSha256,
} from "./domain.js";
import { createDbWebhookIntakeStore, type WebhookIntakeStore } from "./store.js";
import {
  WEBHOOK_INTAKE_COMPANY_ID_ENV,
  readWebhookIntakeSettings,
  resolveWebhookIntakeTokenRef,
} from "./token.js";

export interface WebhookIntakeRoutesDeps {
  db: Db;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests: the draft store. */
  intakeStore?: WebhookIntakeStore;
  /** Injectable for tests: returns the expected shared secret. */
  expectedSecret?: () => string | null;
  /** Injectable for tests: the audit-log writer. */
  auditLog?: typeof logActivity;
}

function rawBody(req: Request): Buffer {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (raw instanceof Buffer && raw.length > 0) return raw;
  // Fallback for test transports that skip the global json parser: serialize
  // the parsed body back to bytes. Production requests always carry rawBody
  // (captured by app.ts verify handlers).
  return Buffer.from(JSON.stringify(req.body ?? null), "utf8");
}

function signatureHeaderValue(req: Request): string | null {
  const dedicated = req.header(WEBHOOK_INTAKE_SIGNATURE_HEADER);
  if (typeof dedicated === "string" && dedicated.length > 0) return dedicated;
  const github = req.header("x-hub-signature-256");
  if (typeof github === "string" && github.length > 0) return github;
  return null;
}

export function webhookIntakeRoutes(deps: WebhookIntakeRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const db = deps.db;
  const store = deps.intakeStore ?? createDbWebhookIntakeStore(db);
  const writeAudit = deps.auditLog ?? logActivity;
  const intakeSettings = readWebhookIntakeSettings(env);

  const companyId = (): string => {
    const configured =
      intakeSettings.companyId || deps.env?.[WEBHOOK_INTAKE_COMPANY_ID_ENV]?.trim() || env[WEBHOOK_INTAKE_COMPANY_ID_ENV]?.trim();
    if (!configured) {
      throw new HttpError(503, "Webhook intake is not configured: MYRMIDON_WEBHOOK_INTAKE_COMPANY_ID is unset");
    }
    return configured;
  };

  router.post("/myrmidon/monitoring/intake/webhook", async (req, res) => {
    const company = companyId();
    let secret: string | null;
    try {
      secret = deps.expectedSecret
        ? deps.expectedSecret()
        : resolveWebhookIntakeTokenRef(intakeSettings.tokenRef, { env });
    } catch (err) {
      logger.warn({ err: err instanceof Error ? err.message : err }, "webhook intake: secret reference failed to resolve");
      throw new HttpError(503, "Webhook intake secret is not available");
    }
    if (!secret) {
      logger.warn({ companyId: company }, "webhook intake: secret reference is not configured");
      throw new HttpError(503, "Webhook intake is not configured");
    }

    const body = rawBody(req);
    const headerValue = signatureHeaderValue(req);
    if (!verifyHmacSha256({ scheme: WEBHOOK_INTAKE_SIGNATURE_SCHEME, body, signatureHeader: WEBHOOK_INTAKE_SIGNATURE_HEADER, signatureHeaderValue: headerValue }, secret)) {
      throw unauthorized("Invalid webhook intake signature");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString("utf8"));
    } catch {
      parsed = { raw: body.toString("utf8") };
    }

    const querySource = typeof req.query.source === "string" ? req.query.source : "";
    const bodySource = typeof (parsed as Record<string, unknown>)?.source === "string" ? ((parsed as Record<string, unknown>).source as string) : "";
    let source: string;
    try {
      source = normalizeSource(querySource || bodySource || "generic");
    } catch (err) {
      // A bad caller-supplied source is a client error, not a server fault.
      throw badRequest(err instanceof Error ? err.message : "invalid webhook intake source");
    }

    const delivery = extractDelivery(source, parsed, req.headers as Record<string, string | string[] | undefined>, body);
    const result = await store.insertDraft(company, delivery, {
      raw: parsed,
      signatureScheme: WEBHOOK_INTAKE_SIGNATURE_SCHEME,
      signatureHeader: WEBHOOK_INTAKE_SIGNATURE_HEADER,
      signatureValue: headerValue,
    });

    if (result === "created") {
      await writeAudit(db, {
        companyId: company,
        actorType: "system",
        actorId: "webhook-intake",
        action: "myrmidon.intake.stored",
        entityType: "webhook_intake_draft",
        entityId: delivery.externalEventId,
        details: { source: delivery.source, eventType: delivery.eventType },
      });
    }
    res.status(result === "created" ? 201 : 200).json({
      status: result === "created" ? "stored" : "duplicate",
      source: delivery.source,
      eventId: delivery.externalEventId,
      eventType: delivery.eventType,
    });
  });

  const draftsQuerySchema = z.object({
    source: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/).optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
  });

  router.get("/myrmidon/monitoring/intake/drafts", async (req, res) => {
    const company = typeof req.query.companyId === "string" ? req.query.companyId : companyId();
    assertCompanyAccess(req, company);
    assertBoard(req);
    const query = draftsQuerySchema.parse(req.query);
    res.json({ drafts: await listDraftsForView(deps, company, query.source, query.limit ?? 50) });
  });

  router.get("/myrmidon/monitoring/intake/settings", async (req, res) => {
    const company = typeof req.query.companyId === "string" ? req.query.companyId : companyId();
    assertCompanyAccess(req, company);
    assertBoard(req);
    res.json({
      configured: Boolean(intakeSettings.tokenRef),
      tokenRef: intakeSettings.tokenRef,
      companyId: company,
    });
  });

  return router;
}

/** Board listing of drafts (no raw bodies): newest first. */
async function listDraftsForView(
  deps: WebhookIntakeRoutesDeps,
  company: string,
  source: string | undefined,
  limit: number,
): Promise<Array<{ id: string; source: string; eventId: string; eventType: string | null; receivedAt: string; deliveryAttempts: number }>> {
  const { desc, eq, and } = await import("drizzle-orm");
  const { webhookIntakeDrafts } = await import("@myrmidon/db");
  const filters = [eq(webhookIntakeDrafts.companyId, company)];
  if (source) filters.push(eq(webhookIntakeDrafts.source, source));
  const rows = await deps.db
    .select({
      id: webhookIntakeDrafts.id,
      source: webhookIntakeDrafts.source,
      externalEventId: webhookIntakeDrafts.externalEventId,
      eventType: webhookIntakeDrafts.eventType,
      receivedAt: webhookIntakeDrafts.receivedAt,
      deliveryAttempts: webhookIntakeDrafts.deliveryAttempts,
    })
    .from(webhookIntakeDrafts)
    .where(and(...filters))
    .orderBy(desc(webhookIntakeDrafts.receivedAt))
    .limit(limit);
  return rows.map((row) => ({
    id: row.id,
    source: row.source,
    eventId: row.externalEventId,
    eventType: row.eventType,
    receivedAt: row.receivedAt.toISOString(),
    deliveryAttempts: row.deliveryAttempts,
  }));
}

/** Router factory for app.ts/app-plugin: `api.use(webhookIntakeRoutes({ db }))`. */
export function myrmidonWebhookIntakeRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return webhookIntakeRoutes({ db, env });
}
