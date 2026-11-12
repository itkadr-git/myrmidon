// server/src/myrmidon/billing-webhook/routes.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630): POST /api/billing/webhook.
//
// Contract:
//   - Verifies HMAC-SHA256 signature using the secret referenced by
//     MYRMIDON_BILLING_WEBHOOK_SECRET_REF before ingesting the event.
//   - Unset or unresolvable secret reference -> 503 (nothing stored).
//   - Missing or invalid signature -> 401 (nothing stored).
//   - Valid signature + invoice.paid / invoice.failed -> status "received",
//     signatureStatus "verified", 200;
//   - Valid signature + any other event type -> status "ignored",
//     signatureStatus "verified", 200;
//   - Malformed body with valid signature -> 400;
//   - Ambiguous company count (zero or multiple) -> 503.
//
// The endpoint runs ahead of per-company resolution like the rest of the API:
// the instance is single-company in this deployment, so the event is stored
// against the only company. Zero or several companies → 503 (nothing stored).
// The secret value is compared in memory and never logged or returned.

import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import { z } from "zod";
import { serviceUnavailable, unauthorized } from "../../errors.js";
import { logger } from "../../middleware/logger.js";
import {
  WEBHOOK_INTAKE_SIGNATURE_HEADER,
  WEBHOOK_INTAKE_SIGNATURE_SCHEME,
  verifyHmacSha256,
} from "../monitoring/intake/domain.js";
import { resolveWebhookIntakeTokenRef } from "../monitoring/intake/token.js";
import { billingWebhookService, type BillingWebhookServiceDeps } from "./service.js";

export const BILLING_WEBHOOK_PATH = "/billing/webhook";
export const BILLING_WEBHOOK_SECRET_REF_ENV = "MYRMIDON_BILLING_WEBHOOK_SECRET_REF";

const billingWebhookBodySchema = z
  .object({
    type: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export interface BillingWebhookRoutesDeps extends Partial<BillingWebhookServiceDeps> {
  env?: NodeJS.ProcessEnv;
  secretRef?: string | null;
  expectedSecret?: () => string | null;
}

function rawBody(req: Request): Buffer {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
  if (Buffer.isBuffer(raw)) return raw;
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

export function billingWebhookRoutes(db: Db, deps: BillingWebhookRoutesDeps = {}) {
  const service = billingWebhookService(db, deps);
  const router = Router();
  const env = deps.env ?? process.env;

  router.post(BILLING_WEBHOOK_PATH, async (req, res, next) => {
    try {
      let secret: string | null;
      try {
        if (deps.expectedSecret) {
          secret = deps.expectedSecret();
        } else {
          const ref =
            deps.secretRef !== undefined
              ? deps.secretRef
              : (env[BILLING_WEBHOOK_SECRET_REF_ENV]?.trim() || null);
          secret = resolveWebhookIntakeTokenRef(ref, { env });
        }
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : err },
          "billing webhook: secret reference failed to resolve",
        );
        throw serviceUnavailable("Billing webhook secret is not available");
      }

      if (!secret) {
        logger.warn("billing webhook: secret reference is not configured");
        throw serviceUnavailable("Billing webhook is not configured");
      }

      const headerVal = signatureHeaderValue(req);
      if (!headerVal) {
        throw unauthorized("Missing billing webhook signature");
      }

      const body = rawBody(req);
      const valid = verifyHmacSha256(
        {
          scheme: WEBHOOK_INTAKE_SIGNATURE_SCHEME,
          body,
          signatureHeader: WEBHOOK_INTAKE_SIGNATURE_HEADER,
          signatureHeaderValue: headerVal,
        },
        secret,
      );

      if (!valid) {
        throw unauthorized("Invalid billing webhook signature");
      }

      const parsed = billingWebhookBodySchema.parse(req.body);

      const result = await service.ingest({
        eventType: parsed.type,
        payload: (parsed.payload ?? {}) as Record<string, unknown>,
      });

      // 200 for every well-formed delivery — including the ignored ones — so
      // the provider does not retry events this endpoint does not know.
      res.status(200).json({ received: true, stored: result.stored, type: result.eventType });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        (error as { code?: unknown }).code === "company_unresolved"
      ) {
        next(serviceUnavailable((error as Error).message));
        return;
      }
      next(error);
    }
  });

  return router;
}
