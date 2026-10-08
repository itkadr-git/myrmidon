import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  alertRecoveryEventSchema,
  patchAlertRecoverySettingsSchema,
  type AlertRecoveryEventInput,
  type AlertRecoverySettingsPatch,
} from "@paperclipai/shared";
import { unprocessable } from "../../../errors.js";
import { validate } from "../../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, assertInstanceAdmin, getActorInfo } from "../../../routes/authz.js";
import type { AlertRecoveryService } from "./service.js";

/**
 * GET/PATCH /api/myrmidon/monitoring/alert-recovery and
 * POST /api/myrmidon/monitoring/alert-recovery/events (myrmidon 1.6.6
 * MONITORING, part D).
 *
 * GET reports the knobs in force with where they came from, the runbook
 * registry and the alert journal of one company: the task of every alert, how
 * often it fired, and when the automatic close is due. Any board member of the
 * company may read it.
 *
 * PATCH writes `instance_settings.general.alertRecovery` and is instance-admin
 * only, the same rule the rest of the instance settings follow.
 *
 * POST takes one normalized alert event — what the Zabbix / Alertmanager
 * intake of part B sends once an alert starts firing, fires again or resolves.
 * It is the same call the intake makes in process, exposed so an operator can
 * drive a real alert through the lifecycle by hand.
 */

export function alertRecoveryRoutes(_db: Db, service: AlertRecoveryService) {
  const router = Router();

  function resolveCompanyId(req: Request): string {
    assertBoard(req);
    const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (fromQuery) {
      assertCompanyAccess(req, fromQuery);
      return fromQuery;
    }
    const actor = req.actor as { companyIds?: string[]; isInstanceAdmin?: boolean; source?: string };
    if (actor.source === "local_implicit" || actor.isInstanceAdmin) {
      // Full-control context: exactly one company id when the list is set,
      // otherwise the caller has to say which company it means.
      const ids = actor.companyIds ?? [];
      if (ids.length === 1) return ids[0];
      throw unprocessable("companyId query parameter is required");
    }
    const ids = actor.companyIds ?? [];
    if (ids.length === 1) return ids[0];
    throw unprocessable(
      ids.length === 0
        ? "companyId query parameter is required (no company membership)"
        : "companyId query parameter is required (multiple company memberships)",
    );
  }

  router.get("/myrmidon/monitoring/alert-recovery", async (req, res) => {
    const companyId = resolveCompanyId(req);
    res.json(await service.view(companyId));
  });

  router.patch(
    "/myrmidon/monitoring/alert-recovery",
    validate(patchAlertRecoverySettingsSchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      res.json(await service.updateSettings(req.body as AlertRecoverySettingsPatch, getActorInfo(req)));
    },
  );

  router.post(
    "/myrmidon/monitoring/alert-recovery/events",
    validate(alertRecoveryEventSchema),
    async (req, res) => {
      const event = req.body as AlertRecoveryEventInput;
      assertCompanyAccess(req, event.companyId);
      res.json(await service.ingest(event));
    },
  );

  return router;
}