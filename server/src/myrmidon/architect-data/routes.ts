// server/src/myrmidon/architect-data/routes.ts
//
// myrmidon(1.6.6 ARCH-DATA): REST API routes for architect operational metrics.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  architectDataQuerySchema,
  ARCHITECT_DATA_API_BASE,
} from "@myrmidon/shared";
import { assertCompanyAccess } from "../../routes/authz.js";
import {
  assertArchitectRoleOrGrant,
  getArchitectDataBundle,
  getChatgptPoolData,
  getHeartbeatRuns,
  getHermesCompressionEvents,
  getLlmCalls,
  type ArchitectDataServiceOptions,
} from "./service.js";

export function myrmidonArchitectDataRoutes(
  db: Db,
  options: ArchitectDataServiceOptions = {},
) {
  const router = Router();

  // GET /myrmidon/companies/:companyId/architect-data/bundle
  router.get(`${ARCHITECT_DATA_API_BASE}/bundle`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const query = architectDataQuerySchema.parse(req.query);
    const bundle = await getArchitectDataBundle(db, companyId, query, options);
    res.json(bundle);
  });

  // GET /myrmidon/companies/:companyId/architect-data/compression-events
  router.get(`${ARCHITECT_DATA_API_BASE}/compression-events`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const query = architectDataQuerySchema.parse(req.query);
    const events = await getHermesCompressionEvents(db, companyId, {
      agentId: query.agentId,
      limit: query.limit,
      botVolumeRoot: options.botVolumeRoot,
    });
    res.json(events);
  });

  // GET /myrmidon/companies/:companyId/architect-data/chatgpt-limits
  router.get(`${ARCHITECT_DATA_API_BASE}/chatgpt-limits`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const query = architectDataQuerySchema.parse(req.query);
    const data = await getChatgptPoolData({
      hours: query.hours,
      limit: query.limit,
      dbPath: options.chatgptUsageDbPath,
    });
    res.json(data);
  });

  // GET /myrmidon/companies/:companyId/architect-data/llm-calls
  router.get(`${ARCHITECT_DATA_API_BASE}/llm-calls`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const query = architectDataQuerySchema.parse(req.query);
    const calls = await getLlmCalls(db, companyId, {
      hours: query.hours,
      limit: query.limit,
      agentId: query.agentId,
    });
    res.json(calls);
  });

  // GET /myrmidon/companies/:companyId/architect-data/heartbeat-runs
  router.get(`${ARCHITECT_DATA_API_BASE}/heartbeat-runs`, async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertArchitectRoleOrGrant(req, db, companyId, options.allowedRoles);

    const query = architectDataQuerySchema.parse(req.query);
    const runs = await getHeartbeatRuns(db, companyId, {
      hours: query.hours,
      limit: query.limit,
      agentId: query.agentId,
    });
    res.json(runs);
  });

  return router;
}
