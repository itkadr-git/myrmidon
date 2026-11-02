// myrmidon(1.7 AUTO-UPDATE-SETTINGS): project-scoped maintenance window API.
import { and, eq } from "drizzle-orm";
import { Router } from "express";
import { projects } from "@myrmidon/db";
import type { Db } from "@myrmidon/db";
import { autoUpdateSettingsSchema } from "@myrmidon/shared";
import { notFound } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";

const DEFAULT_SETTINGS = { enabled: false, cron: "0 2 * * 0", durationMinutes: 120, timezone: "UTC" };

export function systemRoutes(db: Db) {
  const router = Router();
  async function readProjectSettings(projectId: string, companyId: string) {
    const row = await db.select({ id: projects.id, companyId: projects.companyId, env: projects.env })
      .from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
    const raw = (row.env as Record<string, unknown> | null)?.autoUpdateSettings;
    const parsed = autoUpdateSettingsSchema.safeParse(raw);
    return { projectId: row.id, settings: parsed.success ? parsed.data : DEFAULT_SETTINGS };
  }

  router.get("/projects/:projectId/system/auto-update-settings", async (req, res) => {
    const projectId = req.params.projectId!;
    const row = await db.select({ companyId: projects.companyId }).from(projects)
      .where(eq(projects.id, projectId)).limit(1).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
    assertCompanyAccess(req, row.companyId);
    res.json(await readProjectSettings(projectId, row.companyId));
  });

  router.put("/projects/:projectId/system/auto-update-settings", validate(autoUpdateSettingsSchema), async (req, res) => {
    const projectId = req.params.projectId!;
    const row = await db.select({ companyId: projects.companyId }).from(projects)
      .where(eq(projects.id, projectId)).limit(1).then((rows) => rows[0] ?? null);
    if (!row) throw notFound("Project not found");
    assertCompanyAccess(req, row.companyId);
    const current = await db.select({ env: projects.env }).from(projects)
      .where(and(eq(projects.id, projectId), eq(projects.companyId, row.companyId))).limit(1).then((rows) => rows[0] ?? null);
    if (!current) throw notFound("Project not found");
    const env = { ...(current.env as Record<string, unknown> | null ?? {}), autoUpdateSettings: req.body };
    await db.update(projects).set({ env, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.companyId, row.companyId)));
    res.json({ projectId, settings: req.body });
  });
  return router;
}
