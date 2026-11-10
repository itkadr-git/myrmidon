// server/src/myrmidon/monitoring/intake/index.ts
// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): entry point of the webhook intake.
// Hands app.ts a router (one mount line). The route verifies the HMAC
// signature, dedups by (source, event id) and stores the raw payload as a
// draft candidate; routing into execution is the next slice.

import type { Db } from "@myrmidon/db";
import { webhookIntakeRoutes } from "./routes.js";

export {
  WEBHOOK_INTAKE_SIGNATURE_SCHEME,
  WEBHOOK_INTAKE_SIGNATURE_HEADER,
  verifyHmacSha256,
  extractDelivery,
  normalizeSource,
  decideIntake,
} from "./domain.js";
export { createDbWebhookIntakeStore } from "./store.js";
export {
  readWebhookIntakeSettings,
  resolveWebhookIntakeTokenRef,
  WEBHOOK_INTAKE_TOKEN_REF_ENV,
  WEBHOOK_INTAKE_COMPANY_ID_ENV,
} from "./token.js";
export { webhookIntakeRoutes } from "./routes.js";

/** Router for app.ts: `api.use(myrmidonWebhookIntakeRoutes(db))`. */
export function myrmidonWebhookIntakeRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  return webhookIntakeRoutes({ db, env });
}
