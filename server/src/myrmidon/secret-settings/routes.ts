// myrmidon(SETTINGS-UI E2.1): instance-admin API for secret-ref settings. Lists status,
// sets or clears the reference, and returns a dry-run migration plan. It never returns,
// accepts or logs a secret value: the body of PUT is a secret id.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { logActivity } from "../../services/index.js";
import { validate } from "../../middleware/validate.js";
import { assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { secretService } from "../../services/secrets.js";
import { createInstanceSecretSettingService } from "./wiring.js";
import type { InstanceSecretSettingRegistry } from "./registry.js";

const migrateBodySchema = z
  .object({ apply: z.boolean().optional(), companyId: z.string().guid().optional() })
  .strict();
const setRefBodySchema = z.object({ secretId: z.string().guid() }).strict();

export function instanceSecretSettingsRoutes(
  db: Db,
  registry?: InstanceSecretSettingRegistry,
  env?: NodeJS.ProcessEnv,
) {
  const router = Router();
  const svc = createInstanceSecretSettingService(db, registry, env);
  const secrets = secretService(db);

  async function audit(
    req: Parameters<typeof getActorInfo>[0],
    action: string,
    name: string,
    secretId: string | null,
  ) {
    if (!secretId) return;
    const secret = await secrets.getById(secretId);
    if (!secret) return;
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId: secret.companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "instance_secret_setting",
      entityId: name,
      details: { settingName: name, secretId },
    });
  }

  router.get("/instance/secret-settings", async (req, res) => {
    assertInstanceAdmin(req);
    res.json({ settings: await svc.list() });
  });

  router.get("/instance/secret-settings/migration-plan", async (req, res) => {
    assertInstanceAdmin(req);
    res.json({ dryRun: true, rows: await svc.migrationPlan() });
  });

  // Dry run unless the body says `"apply": true`. Never returns a value.
  router.post(
    "/instance/secret-settings/migrate",
    validate(migrateBodySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const result = await svc.migrate({
        apply: req.body.apply === true,
        companyId: req.body.companyId,
      });
      if (!result.dryRun) {
        for (const row of result.rows) {
          if (row.outcome === "bound") {
            try {
              await audit(req, "instance.secret_setting.migrated", row.name, row.secretId ?? null);
            } catch {
              // Migration and audit are independent best-effort effects; don't leak values.
            }
          }
        }
      }
      res.json(result);
    },
  );

  router.put(
    "/instance/secret-settings/:name/ref",
    validate(setRefBodySchema),
    async (req, res) => {
      assertInstanceAdmin(req);
      const name = String(req.params.name);
      const status = await svc.setRef(name, req.body.secretId);
      await audit(req, "instance.secret_setting.ref_set", name, req.body.secretId);
      res.json(status);
    },
  );

  router.delete("/instance/secret-settings/:name/ref", async (req, res) => {
    assertInstanceAdmin(req);
    const name = String(req.params.name);
    const before = await svc.status(name);
    const status = await svc.clearRef(name);
    await audit(req, "instance.secret_setting.ref_cleared", name, before.ref?.secretId ?? null);
    res.json(status);
  });

  return router;
}
