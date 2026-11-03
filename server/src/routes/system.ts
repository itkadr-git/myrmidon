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
  async function readProject(projectId: string) {
    return db
      .select({ id: projects.id, companyId: projects.companyId, env: projects.env })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function updateProjectSettings(projectId: string, companyId: string, currentEnv: Record<string, unknown> | null, settings: unknown) {
    const env = { ...(currentEnv ?? {}), autoUpdateSettings: settings };
    await db
      .update(projects)
      .set({ env: env as any, updatedAt: new Date() })
      .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)));
  }

  router.get("/projects/:projectId/system/auto-update-settings", async (req, res) => {
    const projectId = req.params.projectId as string;
    const row = await readProject(projectId);
    if (!row) throw notFound("Project not found");
    assertCompanyAccess(req, row.companyId);
    const raw = (row.env as Record<string, unknown> | null)?.autoUpdateSettings;
    const parsed = autoUpdateSettingsSchema.safeParse(raw);
    res.json({ projectId: row.id, settings: parsed.success ? parsed.data : DEFAULT_SETTINGS });
  });

  router.put("/projects/:projectId/system/auto-update-settings", validate(autoUpdateSettingsSchema), async (req, res) => {
    const projectId = req.params.projectId as string;
    const row = await readProject(projectId);
    if (!row) throw notFound("Project not found");
    assertCompanyAccess(req, row.companyId);
    await updateProjectSettings(projectId, row.companyId, row.env as Record<string, unknown> | null, req.body);
    res.json({ projectId, settings: req.body });
  });
  return router;
}
