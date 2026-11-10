// server/src/myrmidon/tool-complaints/routes.ts
//
// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228): the agent tool-complaint
// channel.
//
// - POST /api/myrmidon/tool-complaints — an agent (bearer agent API key)
//   files a complaint {tool, issue, severity, runId?}; 201 on success. The
//   complaint is stamped with the agent's company and id, an activity-log
//   entry is written, and the company scope is enforced: an agent key of
//   company A can never create (or later read) a complaint of company B —
//   the actor middleware already binds the key to its company.
// - GET /api/myrmidon/tool-complaints — the board lists one company's
//   complaints with lifecycle statuses, newest first. Company-scoped: the
//   company is the actor's own (an optional ?companyId= picks one of the
//   board actor's memberships; anything outside them is refused). An agent
//   may also read its own company's feed.
//
// Auth (AGENTS.md §8): agent access uses bearer agent keys; every mutation
// writes an activity-log entry.

import { desc, eq } from "drizzle-orm";
import { Router, type Request } from "express";
import { toolComplaints, type Db } from "@myrmidon/db";
import {
  toolComplaintCreateSchema,
  TOOL_COMPLAINT_CREATED_ACTION,
  type ToolComplaint,
  type ToolComplaintCreate,
} from "@myrmidon/shared";
import { forbidden, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { hasCompanyAccess } from "../../routes/authz.js";
import { persistActivity, publishActivity } from "../../services/activity-log.js";

/** The calling agent of a complaint request; anything else is refused. */
function requireAgentActor(req: Request) {
  const { actor } = req;
  if (actor.type !== "agent" || !actor.agentId || !actor.companyId) {
    throw unauthorized("Only an agent can file a tool complaint");
  }
  return {
    agentId: actor.agentId,
    companyId: actor.companyId,
    keyId: actor.keyId ?? null,
    runId: actor.runId?.trim() || null,
  };
}

/** The company scope of a list request: the agent's own, or a board membership. */
function requireFeedCompanyId(req: Request) {
  const { actor } = req;
  if (actor.type === "agent" && actor.companyId) {
    return actor.companyId;
  }
  if (actor.type !== "board") {
    throw unauthorized();
  }
  const requested = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
  const companyId = requested || (actor.companyIds?.[0] ?? "");
  if (!companyId || !hasCompanyAccess(req, companyId)) {
    throw forbidden("User does not have access to this company");
  }
  return companyId;
}

function toApiComplaint(row: typeof toolComplaints.$inferSelect): ToolComplaint {
  return {
    id: row.id,
    companyId: row.companyId,
    agentId: row.agentId,
    tool: row.tool,
    issue: row.issue,
    severity: row.severity as ToolComplaint["severity"],
    runId: row.runId ?? null,
    status: row.status as ToolComplaint["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function toolComplaintRoutes(db: Db) {
  const router = Router();

  router.post(
    "/myrmidon/tool-complaints",
    validate(toolComplaintCreateSchema),
    async (req, res) => {
      const agent = requireAgentActor(req);
      const body = req.body as ToolComplaintCreate;
      const runId = body.runId ?? agent.runId;
      // The complaint row and its mandatory activity-log audit entry commit
      // atomically: if the audit insert fails, the complaint is rolled back
      // with it — a mutation can never land without its activity log.
      const { row, publication } = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(toolComplaints)
          .values({
            companyId: agent.companyId,
            agentId: agent.agentId,
            tool: body.tool,
            issue: body.issue,
            severity: body.severity,
            runId: body.runId ?? null,
          })
          .returning();
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId: agent.companyId,
          actorType: "agent",
          actorId: agent.agentId,
          agentId: agent.agentId,
          ...(agent.keyId ? { agentApiKeyId: agent.keyId } : {}),
          ...(runId ? { runId } : {}),
          action: TOOL_COMPLAINT_CREATED_ACTION,
          entityType: "tool_complaint",
          entityId: inserted.id,
          details: {
            tool: inserted.tool,
            severity: inserted.severity,
          },
        });
        return { row: inserted, publication };
      });
      publishActivity(publication);
      res.status(201).json(toApiComplaint(row));
    },
  );

  router.get("/myrmidon/tool-complaints", async (req, res) => {
    const companyId = requireFeedCompanyId(req);
    const rows = await db
      .select()
      .from(toolComplaints)
      .where(eq(toolComplaints.companyId, companyId))
      .orderBy(desc(toolComplaints.createdAt));
    res.json({ complaints: rows.map(toApiComplaint) });
  });

  return router;
}
