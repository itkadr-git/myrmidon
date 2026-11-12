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
//   complaints with lifecycle statuses, newest first, plus one threshold
//   warning per tool (myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229)).
//   Company-scoped: the company is the actor's own (an optional ?companyId=
//   picks one of the board actor's memberships; anything outside them is
//   refused). An agent may also read its own company's feed.
// - PATCH /api/myrmidon/tool-complaints/:id — the board moves a complaint
//   through its lifecycle (status open/acknowledged/resolved, OPE-12229).
//   Board-only: an agent never closes another actor's complaint.
//
// The "disable tool for agent" triage action (OPE-12229) deliberately does
// NOT live on this router: it travels the agent's existing permissions
// endpoint (PATCH /api/agents/:id/permissions with
// `permissions.toolAccess`, mode "listed" without the tool) so disabling can
// never bypass the agent's tool rights — see toolComplaintsPermissionsPatch.
//
// Auth (AGENTS.md §8): agent access uses bearer agent keys; every mutation
// writes an activity-log entry.

import { desc, eq, and } from "drizzle-orm";
import { Router, type Request } from "express";
import { toolComplaints, type Db } from "@myrmidon/db";
import {
  toolComplaintCreateSchema,
  toolComplaintUpdateSchema,
  TOOL_COMPLAINT_CREATED_ACTION,
  TOOL_COMPLAINT_TOOL_DISABLED_ACTION,
  TOOL_COMPLAINT_UPDATED_ACTION,
  type ToolComplaint,
  type ToolComplaintCreate,
  type ToolComplaintUpdate,
} from "@myrmidon/shared";
import { forbidden, notFound, unauthorized } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { hasCompanyAccess } from "../../routes/authz.js";
import { persistActivity, publishActivity } from "../../services/activity-log.js";
import { readAgentToolPermissions } from "@myrmidon/shared";
import type { agents } from "@myrmidon/db";
import { complaintThresholdWarnings } from "./threshold.js";

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
    // myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the feed travels with its
    // threshold warnings — one per tool, computed by the pure core so the
    // route and the service tests share one behaviour.
    res.json({
      complaints: rows.map(toApiComplaint),
      thresholdWarnings: complaintThresholdWarnings(rows.map(toApiComplaint)),
    });
  });

  // myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the board triages a
  // complaint (acknowledge, resolve). The company scope travels the same
  // path as the feed read: the row must belong to a company the actor may
  // see, and an agent may only act inside its own company.
  router.patch(
    "/myrmidon/tool-complaints/:id",
    validate(toolComplaintUpdateSchema),
    async (req, res) => {
      const { actor } = req;
      if (actor.type === "agent") {
        if (!actor.companyId) throw unauthorized();
      } else if (actor.type !== "board") {
        throw unauthorized();
      }
      const requested = typeof req.query.companyId === "string" ? req.query.companyId.trim() : "";
      const companyId =
        actor.type === "agent" ? actor.companyId : requested || (actor.companyIds?.[0] ?? "");
      if (!companyId || !hasCompanyAccess(req, companyId)) {
        throw forbidden("User does not have access to this company");
      }
      const body = req.body as ToolComplaintUpdate;
      const id = req.params.id as string;
      // Status write and its audit entry commit atomically (same pattern as
      // the create route): no status change lands without its activity log.
      const { row, publication } = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(toolComplaints)
          .set({ status: body.status, updatedAt: new Date() })
          .where(and(eq(toolComplaints.id, id), eq(toolComplaints.companyId, companyId)))
          .returning();
        if (!updated) return {};
        const { publication } = await persistActivity(tx as unknown as Db, {
          companyId,
          actorType: actor.type === "board" ? "board" : "agent",
          actorId: actor.type === "board" ? (actor.userId ?? null) : actor.agentId,
          agentId: actor.type === "agent" ? actor.agentId : null,
          ...(actor.type === "agent" && actor.keyId ? { agentApiKeyId: actor.keyId } : {}),
          action: TOOL_COMPLAINT_UPDATED_ACTION,
          entityType: "tool_complaint",
          entityId: updated.id,
          details: { status: body.status, tool: updated.tool },
        });
        return { row: updated, publication };
      });
      if (!row) {
        throw notFound("Tool complaint not found");
      }
      publishActivity(publication!);
      res.json(toApiComplaint(row));
    },
  );

  return router;
}

/**
 * The disable payload the complaints board sends to the agent's EXISTING
 * permissions endpoint (myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229)).
 *
 * The disable travels the agent's own tool rights
 * (`permissions.toolAccess`, mode "listed" without the tool) — never a
 * side path: the gateway's S6 check then refuses the tool for exactly this
 * agent. Everything else about the agent's rights (the three permission
 * flags, its already-listed tools and connections) echoes back unchanged so
 * the update cannot silently rewrite rights the operator did not touch.
 */
export function toolComplaintDisablePayload(
  storedPermissions: unknown,
  tool: string,
): {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canAssignTasks: boolean;
  toolAccess: { mode: "listed"; tools: string[]; connections: string[] };
} {
  const permissions = (storedPermissions ?? {}) as Record<string, unknown>;
  const toolAccess = readAgentToolPermissions(permissions);
  const tools = toolAccess.tools.filter((name) => name !== tool);
  const connections = toolAccess.connections;
  const canCreateAgents = permissions.canCreateAgents === true;
  const canCreateSkills = permissions.canCreateSkills !== false;
  const canAssignTasks = permissions.canAssignTasks === true;
  return {
    canCreateAgents,
    canCreateSkills,
    canAssignTasks,
    toolAccess: { mode: "listed", tools, connections },
  };
}

export type ToolComplaintDisableResult = typeof agents.$inferSelect;
