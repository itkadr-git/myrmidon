// myrmidon(OPE-13026): external MCP connector per-agent action policy and
// invocation audit API routes (/api/myrmidon/external-connectors/*).
//
// Contract:
//   - GET  /myrmidon/external-connectors/grants              (list grants for agent/connector)
//   - PUT  /myrmidon/external-connectors/grants              (replace grants for agent x connector)
//   - POST /myrmidon/external-connectors/invoke              (authorized dispatch with journal audit)
//   - GET  /myrmidon/external-connectors/journal             (query append-only audit trail)
//   - GET  /myrmidon/external-connectors/pending-approvals   (list approvals pending human review)
//   - POST /myrmidon/external-connectors/pending-approvals/:id/resolve (approve or reject)

import { Router, type Request } from "express";
import type { Db } from "@myrmidon/db";
import {
  invokeConnectorActionRequestSchema,
  listConnectorPolicyGrantsQuerySchema,
  putConnectorPolicyGrantsRequestSchema,
  resolveConnectorPendingApprovalRequestSchema,
} from "@myrmidon/shared";
import {
  externalConnectorService,
  type ConnectorDispatcher,
} from "./service.js";
import { unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import {
  assertAuthenticated,
  assertBoardOrgAccess,
  assertCompanyAccess,
  getActorInfo,
} from "../../routes/authz.js";

export interface ExternalConnectorsRoutesDeps {
  service?: ReturnType<typeof externalConnectorService>;
  dispatcher?: ConnectorDispatcher;
}

/** Default dispatcher: the real MCP providers are the parent slice's scope;
 * this server-level default answers ok so the enforcement contract is
 * exercisable end to end before a provider lands. */
export const defaultConnectorDispatcher: ConnectorDispatcher = async (req) => {
  return {
    ok: true,
    result: {
      dispatched: true,
      connectorId: req.connectorId,
      actionId: req.actionId,
      timestamp: new Date().toISOString(),
    },
  };
};

export function externalConnectorsRoutes(db: Db, deps: ExternalConnectorsRoutesDeps = {}) {
  const router = Router();
  const svc = deps.service ?? externalConnectorService(db);
  const dispatcher = deps.dispatcher ?? defaultConnectorDispatcher;

  /** Company resolution for pathless routes: query parameter first (scripted
   * callers), then the actor's own company context. Agents are bound to one
   * company by their key; board users fall back to a single membership. */
  function resolveCompanyId(req: Request): string {
    const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (fromQuery) {
      assertCompanyAccess(req, fromQuery);
      return fromQuery;
    }
    const actor = req.actor as {
      companyIds?: string[];
      companyId?: string;
      isInstanceAdmin?: boolean;
      source?: string;
    };
    if (actor.companyId) {
      assertCompanyAccess(req, actor.companyId);
      return actor.companyId;
    }
    const ids = actor.companyIds ?? [];
    if (ids.length === 1) return ids[0];
    throw unprocessable(
      ids.length === 0
        ? "companyId query parameter is required (no company membership)"
        : "companyId query parameter is required (multiple company memberships)",
    );
  }

  // -------------------------------------------------------------------------
  // Policy Grants (Operator / Board)
  // -------------------------------------------------------------------------

  router.get("/myrmidon/external-connectors/grants", async (req, res) => {
    assertBoardOrgAccess(req);
    const companyId = resolveCompanyId(req);
    const query = listConnectorPolicyGrantsQuerySchema.parse(req.query);
    const grants = await svc.listGrants(companyId, query);
    res.json({ grants });
  });

  router.put(
    "/myrmidon/external-connectors/grants",
    validate(putConnectorPolicyGrantsRequestSchema),
    async (req, res) => {
      assertBoardOrgAccess(req);
      const companyId = resolveCompanyId(req);
      const actor = getActorInfo(req);
      const grants = await svc.putGrants(companyId, req.body, {
        actorId: actor.actorId,
        actorType: actor.actorType,
      });
      res.json({ grants });
    },
  );

  // -------------------------------------------------------------------------
  // Invocation Enforcement (Agents & Board users)
  // -------------------------------------------------------------------------

  router.post(
    "/myrmidon/external-connectors/invoke",
    validate(invokeConnectorActionRequestSchema),
    async (req, res) => {
      assertAuthenticated(req);
      const companyId = resolveCompanyId(req);
      const actor = getActorInfo(req);

      const enforcement = await svc.invoke(
        companyId,
        req.body,
        dispatcher,
        { actorType: actor.actorType, actorId: actor.actorId },
      );

      // Status by decision: allowed 200, pending 202, denied 403. The journal
      // entry rides the body in every case so callers can correlate.
      if (enforcement.decision === "allowed") {
        res.status(200).json(enforcement);
      } else if (enforcement.decision === "pending") {
        res.status(202).json(enforcement);
      } else {
        res.status(403).json(enforcement);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Invocation Journal Audit (Board / Rights screen)
  // -------------------------------------------------------------------------

  router.get("/myrmidon/external-connectors/journal", async (req, res) => {
    assertBoardOrgAccess(req);
    const companyId = resolveCompanyId(req);
    const page = await svc.queryJournal(companyId, {
      agentId: typeof req.query.agentId === "string" ? req.query.agentId : undefined,
      connectorId: typeof req.query.connectorId === "string" ? req.query.connectorId : undefined,
      actionId: typeof req.query.actionId === "string" ? req.query.actionId : undefined,
      outcome: typeof req.query.outcome === "string" ? req.query.outcome as never : undefined,
      from: typeof req.query.from === "string" ? req.query.from : undefined,
      to: typeof req.query.to === "string" ? req.query.to : undefined,
      limit: typeof req.query.limit === "string" ? Number(req.query.limit) : undefined,
      offset: typeof req.query.offset === "string" ? Number(req.query.offset) : undefined,
    });
    res.json(page);
  });

  // -------------------------------------------------------------------------
  // Pending Approvals (Human confirmation workflow)
  // -------------------------------------------------------------------------

  router.get("/myrmidon/external-connectors/pending-approvals", async (req, res) => {
    assertBoardOrgAccess(req);
    const companyId = resolveCompanyId(req);
    const status = typeof req.query.status === "string" ? req.query.status as never : undefined;
    const approvals = await svc.listPendingApprovals(companyId, status);
    res.json({ approvals });
  });

  router.post(
    "/myrmidon/external-connectors/pending-approvals/:id/resolve",
    validate(resolveConnectorPendingApprovalRequestSchema),
    async (req, res) => {
      assertBoardOrgAccess(req);
      const companyId = resolveCompanyId(req);
      const result = await svc.resolvePendingApproval(
        companyId,
        req.params.id as string,
        req.body.decision,
        req.body.resolvedBy,
        dispatcher,
      );
      res.json(result);
    },
  );

  return router;
}
