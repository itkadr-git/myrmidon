// server/src/myrmidon/billing-webhook/index.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630): entry point. Router for app.ts;
// the store is the real `billing_events` table, everything else stays
// injectable for tests.

import type { Db } from "@myrmidon/db";
import { billingWebhookRoutes, type BillingWebhookRoutesDeps } from "./routes.js";

export {
  billingWebhookService,
  BILLING_WEBHOOK_KNOWN_TYPES,
  type BillingWebhookInput,
  type BillingWebhookResult,
  type BillingWebhookServiceDeps,
} from "./service.js";
export {
  BILLING_WEBHOOK_PATH,
  BILLING_WEBHOOK_SECRET_REF_ENV,
  billingWebhookRoutes,
  type BillingWebhookRoutesDeps,
} from "./routes.js";

/** Router for app.ts: POST /api/billing/webhook. */
export function myrmidonBillingWebhookRoutes(db: Db, deps: BillingWebhookRoutesDeps = {}) {
  return billingWebhookRoutes(db, deps);
}
