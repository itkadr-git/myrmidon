// server/src/myrmidon/litellm-workers/routes.ts
//
// myrmidon(1.6.5 LITELLM-WORKERS A): the API of the LiteLLM worker count.
//
// - GET /api/myrmidon/companies/:companyId/litellm/workers
//     The target, the pool as it is now, the two ceilings the target must stay
//     under, and the live numbers (per-worker CPU, median answer, queue depth).
//     Company members read — this is what the gateway card shows.
// - PUT /api/myrmidon/companies/:companyId/litellm/workers { target }
//     Stores the target and moves the running pool to it with TTIN/TTOU to the
//     gunicorn master, no restart and no dropped request. Board members write.
//     A target above the memory ceiling is a 400 and nothing is delivered.
//
// The route is company-scoped like the rest of the LiteLLM API of this board,
// and the delivery path is the gateway's own master process: the board does not
// restart anything, it asks the pool to grow or shrink by one worker per
// signal. The value behind it is documented in settings.ts.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  litellmWorkersTargetSchema,
  readGatewayKeySettings,
  type LitellmWorkersTargetBody,
} from "@paperclipai/shared";
import { validate } from "../../middleware/validate.js";
import { logger } from "../../middleware/logger.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { createLitellmWorkersGateway } from "./gateway.js";
import { drizzleLitellmWorkersStore } from "./settings.js";
import { applyLitellmWorkersTarget, readLitellmWorkersView, type LitellmWorkersDeps } from "./service.js";

/** Activity action written for every applied resize. */
export const LITELLM_WORKERS_UPDATED_ACTION = "litellm.workers.updated";

/**
 * Builds the wiring of both routes. The gateway read port exists only when the
 * instance points at a gateway (`MYRMIDON_LITELLM_BASE_URL`): without one the
 * endpoint still reports the target, the ceilings and why the live numbers are
 * missing, and the resize is refused with a sentence instead of a signal.
 */
export function myrmidonLitellmWorkersRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  const store = drizzleLitellmWorkersStore(db);
  const gateway = (() => {
    const { baseUrl, adminKeySecret } = readGatewayKeySettings(env);
    if (!baseUrl) return null;
    // A proxied /metrics may sit behind the same authenticated listener as the
    // gateway API, so the read carries the instance's admin key when it has one
    // — never a key from a request.
    return createLitellmWorkersGateway({ baseUrl, adminKey: adminKeySecret ?? undefined });
  })();
  const deps: LitellmWorkersDeps = { store, env, gateway };

  router.get("/myrmidon/companies/:companyId/litellm/workers", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await readLitellmWorkersView(deps, companyId));
  });

  router.put(
    "/myrmidon/companies/:companyId/litellm/workers",
    validate(litellmWorkersTargetSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const { target } = req.body as LitellmWorkersTargetBody;
      const result = await applyLitellmWorkersTarget(deps, { companyId, target });
      try {
        const actor = getActorInfo(req);
        await logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          action: LITELLM_WORKERS_UPDATED_ACTION,
          entityType: "litellm_workers",
          entityId: companyId,
          details: {
            target,
            signals: result.signals,
            delivered: result.deliveries.map((delivery) => delivery.signal),
            applied: result.applied,
            applyError: result.applyError,
          },
        });
      } catch (err) {
        // The audit trail is best-effort: the stored target is already the
        // single truth and the caller has the delivery report in the response,
        // so a failed log row must not turn a delivered resize into an error.
        logger.warn({ err }, "liteLLM worker count change was not logged");
      }
      res.json({ ...result.view, applied: result.applied, signals: result.signals, deliveries: result.deliveries, applyError: result.applyError, changed: result.changed });
    },
  );

  return router;
}