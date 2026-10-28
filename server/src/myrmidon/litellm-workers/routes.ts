// server/src/myrmidon/litellm-workers/routes.ts
//
// myrmidon(1.6.6 LITELLM-WORKERS restart): the API of the LiteLLM worker count.
//
// - GET /api/myrmidon/companies/:companyId/litellm/workers
//     The target, the pool as it is now (from the gateway's gauge or the
//     `--num_workers` of its launch line), the two ceilings the target must
//     stay under, and the live numbers (per-worker CPU, median answer, queue
//     depth). Company members read — this is what the gateway card shows.
// - PUT /api/myrmidon/companies/:companyId/litellm/workers { target }
//     Stores the target and applies it with a PLANNED RESTART of the gateway
//     unit (`apply.path` is "restart"): requests are briefly dropped, which the
//     card says before the operator confirms. The board then reads the pool
//     size back and reports `applied` only when it equals the target. Instance
//     admins write (the pool is one per instance). Resizes are serialised by
//     an advisory lock. A target above the memory ceiling is a 400 and nothing
//     is restarted.
//
// The route is company-scoped like the rest of the LiteLLM API of this board.
// The value behind it is documented in settings.ts.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  litellmWorkersTargetSchema,
  readGatewayKeySettings,
  type LitellmWorkersTargetBody,
} from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { logger } from "../../middleware/logger.js";
import { assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/index.js";
import { readLitellmCostSettings } from "../litellm-costs/litellm-costs.js";
import { createLitellmWorkersGateway } from "./gateway.js";
import { advisoryLitellmWorkersLock, drizzleLitellmWorkersStore } from "./settings.js";
import { applyLitellmWorkersTarget, readLitellmWorkersView, type LitellmWorkersDeps } from "./service.js";

/** Activity action written for every applied resize. */
export const LITELLM_WORKERS_UPDATED_ACTION = "litellm.workers.updated";

/**
 * Builds the wiring of both routes. The gateway read port exists only when the
 * instance points at a gateway (`MYRMIDON_LITELLM_BASE_URL`): without one the
 * endpoint still reports the target, the ceilings and why the live numbers are
 * missing, and the resize is refused with a sentence instead of a restart.
 */
export function myrmidonLitellmWorkersRoutes(db: Db, env: NodeJS.ProcessEnv = process.env) {
  const router = Router();
  const store = drizzleLitellmWorkersStore(db);
  const secrets = secretService(db);
  const gateway = (() => {
    const { baseUrl, adminKeySecret } = readGatewayKeySettings(env);
    if (!baseUrl) return null;
    // /metrics sits behind the gateway's own authentication. The environment
    // carries the NAME of a secret, never the key: the key is resolved from the
    // company's secret store on every read, never taken from a request. The
    // cost-reader key (which may read /metrics) is preferred over the admin key
    // so the board reads with the narrower credential when both exist.
    const secretName = readLitellmCostSettings(env).keySecret ?? adminKeySecret;
    const resolveKey = async (companyId: string): Promise<string | null> => {
      if (!secretName) return null;
      const row = await secrets.getByName(companyId, secretName);
      return row ? secrets.resolveSecretValue(companyId, row.id, "latest") : null;
    };
    return createLitellmWorkersGateway({ baseUrl, resolveKey });
  })();
  const deps: LitellmWorkersDeps = { store, env, gateway, lock: advisoryLitellmWorkersLock(db) };

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
      // The pool is one per instance, shared by every company: resizing it is
      // an instance-admin act, not a company-board one.
      assertInstanceAdmin(req);
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
            restarted: result.restarted,
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
      res.json({ ...result.view, applied: result.applied, restarted: result.restarted, deliveries: result.deliveries, applyError: result.applyError, changed: result.changed });
    },
  );

  return router;
}