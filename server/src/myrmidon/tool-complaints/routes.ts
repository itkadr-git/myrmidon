// server/src/myrmidon/tool-complaints/routes.ts
//
// myrmidon(1.7 TOOL-COMPLAINTS-API, OPE-12228/OPE-12229): the agent tool-complaint
// channel & triage UI endpoints.
//
// - POST /api/myrmidon/tool-complaints — an agent files a complaint {tool, issue, severity, runId?}
// - GET /api/myrmidon/tool-complaints — list company's complaints with threshold warnings
// - PATCH /api/myrmidon/tool-complaints/:id — update status (open -> acknowledged -> resolved)
//   and optionally disable tool for agent via existing tool access rights.

import { desc, eq, and, ne, count } from "drizzle-orm";
import { Router, type Request } from "express";
import { toolComplaints, toolProfiles, toolProfileEntries, type Db } from "@myrmidon/db";
import {
  toolComplaintCreateSchema,
  toolComplaintUpdateSchema,
  TOOL_COMPLAINT_CREATED_ACTION,
  TOOL_COMPLAINT_UPDATED_ACTION,
  TOOL_COMPLAINT_TOOL_DISABLED_ACTION,
  type ToolComplaint,
  type ToolComplaintCreate,
  type ToolComplaintUpdate,
  type ToolComplaintThresholdWarning,
  type ToolComplaintsFeedResponse,
} from "@myrmidon/shared";
import { forbidden, unauthorized, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { hasCompanyAccess } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { toolAccessService } from "../../services/tool-access.js";

const DEFAULT_COMPLAINT_THRESHOLD = 3;

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

/** The company scope of a list/update request: agent's own or board user membership. */
function requireFeedCompanyId(req: Request): string {
  const { actor } = req;
  if (actor.type === "agent" && actor.companyId) {
    return actor.companyId;
  }
  if (actor.type !== "board") {
    throw unauthorized("Board or agent actor required");
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
      const [row] = await db
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
      const runId = body.runId ?? agent.runId;
      await logActivity(db, {
        companyId: agent.companyId,
        actorType: "agent",
        actorId: agent.agentId,
        agentId: agent.agentId,
        ...(agent.keyId ? { agentApiKeyId: agent.keyId } : {}),
        ...(runId ? { runId } : {}),
        action: TOOL_COMPLAINT_CREATED_ACTION,
        entityType: "tool_complaint",
        entityId: row.id,
        details: {
          tool: row.tool,
          severity: row.severity,
        },
      });
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

    const complaints = rows.map(toApiComplaint);

    // Calculate threshold warnings (open/acknowledged complaints per tool, resolved excluded)
    const openCounts = new Map<string, number>();
    for (const c of rows) {
      if (c.status !== "resolved") {
        openCounts.set(c.tool, (openCounts.get(c.tool) ?? 0) + 1);
      }
    }

    const thresholdWarnings: ToolComplaintThresholdWarning[] = [];
    for (const [tool, openCount] of openCounts.entries()) {
      const threshold = DEFAULT_COMPLAINT_THRESHOLD;
      thresholdWarnings.push({
        tool,
        openCount,
        threshold,
        warning: openCount >= threshold,
      });
    }

    const response: ToolComplaintsFeedResponse = {
      complaints,
      thresholdWarnings,
    };
    res.json(response);
  });

  router.patch(
    "/myrmidon/tool-complaints/:id",
    validate(toolComplaintUpdateSchema),
    async (req, res) => {
      const companyId = requireFeedCompanyId(req);
      const complaintId = req.params.id;
      const body = req.body as ToolComplaintUpdate;

      const [existing] = await db
        .select()
        .from(toolComplaints)
        .where(and(eq(toolComplaints.id, complaintId), eq(toolComplaints.companyId, companyId)))
        .limit(1);

      if (!existing) {
        throw notFound("Tool complaint not found");
      }

      const updateValues: Partial<typeof toolComplaints.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (body.status) {
        updateValues.status = body.status;
      }

      const [updated] = await db
        .update(toolComplaints)
        .set(updateValues)
        .where(eq(toolComplaints.id, complaintId))
        .returning();

      await logActivity(db, {
        companyId,
        actorType: req.actor.type,
        actorId: req.actor.type === "agent" ? req.actor.agentId! : (req.actor.userId ?? "board"),
        action: TOOL_COMPLAINT_UPDATED_ACTION,
        entityType: "tool_complaint",
        entityId: complaintId,
        details: { status: updated.status },
      });

      // Optional action: disable tool for agent via existing rights (toolAccessService)
      if (body.disableTool) {
        const access = toolAccessService(db);
        // Find or create an explicit deny profile/entry for this agent/tool using toolAccessService
        const profileKey = `complaint-disable:${existing.agentId}:${existing.tool}`;
        let [profile] = await db
          .select()
          .from(toolProfiles)
          .where(and(eq(toolProfiles.companyId, companyId), eq(toolProfiles.profileKey, profileKey)))
          .limit(1);

        if (!profile) {
          const createdProfile = await access.createProfile(companyId, {
            profileKey,
            name: `Disable ${existing.tool} for agent ${existing.agentId.slice(0, 8)}`,
            description: `Auto-disabled via complaint triage.`,
            status: "active",
            defaultAction: "allow",
            entries: [
              {
                selectorType: "catalog_entry",
                effect: "exclude",
                toolName: existing.tool,
              },
            ],
          });
          profile = {
            id: createdProfile.id,
            companyId,
            profileKey,
            name: createdProfile.name,
            description: createdProfile.description,
            status: createdProfile.status,
            defaultAction: createdProfile.defaultAction,
            newToolsReviewedAt: null,
            metadata: null,
            createdAt: new Date(),
            updatedAt: new Date(),
          };
        }

        // Bind profile to the agent with high priority
        await access.bindProfileToTarget(companyId, profile.id, {
          targetType: "agent",
          targetId: existing.agentId,
          priority: 100,
        });

        await logActivity(db, {
          companyId,
          actorType: req.actor.type,
          actorId: req.actor.type === "agent" ? req.actor.agentId! : (req.actor.userId ?? "board"),
          action: TOOL_COMPLAINT_TOOL_DISABLED_ACTION,
          entityType: "agent",
          entityId: existing.agentId,
          details: { tool: existing.tool, complaintId },
        });
      }

      res.json(toApiComplaint(updated));
    },
  );

  return router;
}
