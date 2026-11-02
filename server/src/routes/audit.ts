import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { activityLog } from "@myrmidon/db";
import { auditQuerySchema } from "@myrmidon/shared";
import { assertCompanyAccess } from "./authz.js";
import { forbidden, unauthorized } from "../errors.js";
import { accessService } from "../services/access.js";

function assertAdmin(req: import("express").Request) {
  if (!req.actor || req.actor.type === "none") {
    throw unauthorized();
  }
  const a = req.actor as unknown as { type?: string; isInstanceAdmin?: boolean; source?: string };
  if (
    (a.type === "board" || a.type === "user") &&
    (a.isInstanceAdmin === true || a.source === "local_implicit")
  ) {
    return;
  }
  throw forbidden("Instance admin access required");
}

export interface AuditRecordItem {
  id: string;
  action: string;
  actor: string;
  target: string;
  actorId: string;
  actorType: string;
  targetUserId: string;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export async function fetchUserAuditRecords(
  db: Db,
  options: {
    companyId?: string;
    userId?: string;
    targetUserId?: string;
    actorId?: string;
    action?: string;
    limit?: number;
  } = {},
): Promise<AuditRecordItem[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);

  const conditions = [
    eq(activityLog.entityType, "user"),
  ];

  if (options.companyId) {
    conditions.push(eq(activityLog.companyId, options.companyId));
  }
  const targetId = options.targetUserId ?? options.userId;
  if (targetId) {
    conditions.push(eq(activityLog.entityId, targetId));
  }
  if (options.actorId) {
    conditions.push(eq(activityLog.actorId, options.actorId));
  }
  if (options.action) {
    conditions.push(eq(activityLog.action, options.action));
  }

  const rawRows = await db
    .select({
      id: activityLog.id,
      actorType: activityLog.actorType,
      actorId: activityLog.actorId,
      action: activityLog.action,
      entityId: activityLog.entityId,
      details: activityLog.details,
      createdAt: activityLog.createdAt,
    })
    .from(activityLog)
    .where(and(...conditions))
    .orderBy(desc(activityLog.createdAt))
    .limit(limit * 5);

  const seen = new Set<string>();
  const deduplicated: typeof rawRows = [];
  for (const row of rawRows) {
    const key = `${row.createdAt.getTime()}:${row.action}:${row.actorId}:${row.entityId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(row);
    if (deduplicated.length >= limit) break;
  }

  return deduplicated.map((row) => {
    const details = (row.details as Record<string, unknown>) ?? {};
    const reason = typeof details.reason === "string" ? details.reason : null;
    return {
      id: row.id,
      action: row.action,
      actor: row.actorId,
      target: row.entityId,
      actorId: row.actorId,
      actorType: row.actorType,
      targetUserId: row.entityId,
      reason,
      details,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

/**
 * myrmidon(OPE-10215): Audit query routes for user management actions.
 */
export function auditRoutes(db: Db): Router {
  const router = Router();
  const access = accessService(db);

  /**
   * GET /api/audit and GET /api/audit/users
   * Instance administrator route to read audit log items.
   */
  async function handleAuditQuery(req: import("express").Request, res: import("express").Response) {
    assertAdmin(req);
    const parsed = auditQuerySchema.safeParse(req.query);
    const query = parsed.success ? parsed.data : {};
    const items = await fetchUserAuditRecords(db, query);
    res.json(items);
  }

  router.get("/audit", handleAuditQuery);
  router.get("/audit/users", handleAuditQuery);

  /**
   * GET /api/users/:userId/audit
   * Instance administrator route to read audit records for a specific target user.
   */
  router.get("/users/:userId/audit", async (req, res) => {
    assertAdmin(req);
    const userId = req.params.userId as string;
    const parsed = auditQuerySchema.safeParse(req.query);
    const query = parsed.success ? parsed.data : {};
    const items = await fetchUserAuditRecords(db, { ...query, targetUserId: userId });
    res.json(items);
  });

  /**
   * GET /api/companies/:companyId/audit
   * Company/instance administrator route to read audit records within a company.
   */
  router.get("/companies/:companyId/audit", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") throw unauthorized();
    const allowed =
      req.actor.isInstanceAdmin ||
      (await access.canUser(companyId, req.actor.userId, "audit:view_agent_actions") ||
       await access.canUser(companyId, req.actor.userId, "users:manage_permissions"));
    if (!allowed) throw forbidden("Administrator access required");

    const parsed = auditQuerySchema.safeParse(req.query);
    const query = parsed.success ? parsed.data : {};
    const items = await fetchUserAuditRecords(db, { ...query, companyId });
    res.json(items);
  });

  return router;
}
