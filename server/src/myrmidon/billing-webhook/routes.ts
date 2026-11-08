// server/src/myrmidon/billing-webhook/routes.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093): POST /api/billing/webhook.
//
// Skeleton contract (ticket OPE-12093):
//   - invoice.paid / invoice.failed → stored with status "received", 200;
//   - any other event type → stored with status "ignored", answered 200
//     (providers retry on non-2xx; an unknown type must not cause a retry storm);
//   - the signature check is a stub (TODO before this endpoint acts on money).
//
// The endpoint runs ahead of per-company resolution like the rest of the API:
// the instance is single-company in this deployment, so the event is stored
// against the only company. Zero or several companies → 503 (nothing stored).

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { z } from "zod";
import { serviceUnavailable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { billingWebhookService, type BillingWebhookServiceDeps } from "./service.js";

export const BILLING_WEBHOOK_PATH = "/billing/webhook";

const billingWebhookBodySchema = z
  .object({
    type: z.string().min(1).max(200),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function billingWebhookRoutes(db: Db, deps: Partial<BillingWebhookServiceDeps> = {}) {
  const service = billingWebhookService(db, deps);
  const router = Router();

  router.post(BILLING_WEBHOOK_PATH, validate(billingWebhookBodySchema), async (req, res, next) => {
    try {
      const result = await service.ingest({
        eventType: req.body.type,
        payload: (req.body.payload ?? {}) as Record<string, unknown>,
      });
      // 200 for every well-formed delivery — including the ignored ones — so
      // the provider does not retry events this skeleton does not know.
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
