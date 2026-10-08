// server/src/myrmidon/monitoring/links/routes.ts
//
// myrmidon(1.6.6 MONITORING E): the two endpoints a monitoring link and its
// operator need.
//
// - GET  /api/myrmidon/companies/:companyId/monitoring/links
//   The live rows `[{ linkKey, keyState, lastPulseAt, pulseAgeSec, staleAfterSec,
//   verdict, unhealthy }]`. This is what the Zabbix item and the dashboard read,
//   and what an operator reads while investigating.
// - POST /api/myrmidon/companies/:companyId/monitoring/links/pulse
//   The link's own self-check: "I am alive". Only a `monitoring_link` key of
//   that same company may call it, and a 200 is the board answering "I heard
//   you". A revoked or expired key never reaches this handler — the board key
//   auth layer answers 401 first, which is the alarm signal the link reports
//   upstream as well.
//
// The pulse is recorded by the auth layer, not by this handler: the board key
// middleware already stamps `last_used_at` on every authenticated request, and
// that timestamp is the pulse the watchdog measures. Adding a second store
// would let the two disagree about whether a link is alive.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { isMonitoringLinkScope } from "@paperclipai/shared";
import { forbidden } from "../../../errors.js";
import { assertCompanyAccess } from "../../../routes/authz.js";
import { evaluateMonitoringLinks, type MonitoringLinkKeyRow } from "./health.js";
import { listMonitoringLinkKeyRows } from "./store.js";

export interface MonitoringLinkRoutesOptions {
  /** Test seam: the clock and the key lookup the routes read. */
  now?(): Date;
  listLinkKeys?(db: Db, options: { companyId?: string }): Promise<MonitoringLinkKeyRow[]>;
}

export function monitoringLinkRoutes(db: Db, options: MonitoringLinkRoutesOptions = {}) {
  const router = Router();
  const clock = options.now ?? (() => new Date());
  const listKeys = options.listLinkKeys ?? listMonitoringLinkKeyRows;

  router.get("/myrmidon/companies/:companyId/monitoring/links", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const now = clock();
    const rows = await listKeys(db, { companyId });
    res.json({
      generatedAt: now.toISOString(),
      links: evaluateMonitoringLinks(rows, now),
    });
  });

  router.post("/myrmidon/companies/:companyId/monitoring/links/pulse", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const actor = req.actor;
    const scope =
      actor.type === "board" && actor.source === "board_key" ? actor.boardKeyScope : null;
    if (!isMonitoringLinkScope(scope)) {
      throw forbidden(
        "The link pulse endpoint accepts only a board key with a monitoring_link scope",
        { scope: scope?.kind ?? actor.type },
      );
    }
    if (scope.companyId !== companyId) {
      throw forbidden("This monitoring link key belongs to another company", {
        keyCompanyId: scope.companyId,
        pathCompanyId: companyId,
      });
    }
    const now = clock();
    res.json({
      ok: true,
      pulseAt: now.toISOString(),
      link: {
        linkKey: scope.linkKey,
        companyId: scope.companyId,
        staleAfterSec: scope.staleAfterSec,
      },
    });
  });

  return router;
}