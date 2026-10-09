// server/src/myrmidon/scent/routes.ts
//
// myrmidon(1.6.5 F-26 T10 SCENT): the board-facing scent API.
//
// - POST /myrmidon/companies/:companyId/issues/:issueId/scent/refresh —
//   re-classify one issue now and write the scent; the auto caste follows
//   the fresh top caste via the same pure derivation as the create hook (an
//   explicit/manual caste is never overwritten).
// - POST /myrmidon/companies/:companyId/agents/:agentId/scent/refresh —
//   re-classify one agent's capabilities into scent_tags.
// - GET  /myrmidon/companies/:companyId/swarm/scent/status — whether the
//   classifier is on, the settings in force, and the backlog counters.
//
// Access follows the swarm-claim routes: any company member. The per-record
// hourly budget (classifierMaxPerRecordPerHour) applies to refreshes too —
// the ledger counts every classification attempt, success or failure.

import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { agents, issues, type Db } from "@paperclipai/db";
import { readScentSettings } from "@paperclipai/shared";
import { assertCompanyAccess } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { logActivity } from "../../services/activity-log.js";
import { secretService } from "../../services/index.js";
import { createCasteStore } from "../castes/store.js";
import { classifyAgentScent, classifyIssueScent, type ScentGatewayDeps } from "./gateway.js";
import { createScentService } from "./service.js";
import { deriveScentAuto } from "./create-hook.js";
import {
  SCENT_BASE_URL_ENV,
  SCENT_KEY_SECRET_ENV,
  type ScentQueuePorts,
} from "./queue.js";

async function buildService(
  db: Db,
  companyId: string,
  ports: ScentQueuePorts,
) {
  const settingsSvc = instanceSettingsService(db);
  const general = await settingsSvc.getGeneral();
  const settings = readScentSettings(
    (general as Record<string, unknown> | null)?.swarm,
    process.env,
  );
  const env = process.env;
  const baseUrl = env[SCENT_BASE_URL_ENV]?.trim() || env.MYRMIDON_EVALS_BASE_URL?.trim() || "";
  const secretName = env[SCENT_KEY_SECRET_ENV]?.trim() || "MYRMIDON_EVALS_API_KEY";
  const resolve =
    ports.resolveSecret ??
    (async (d: Db, cid: string, secret: string) => {
      // Company secret first (operator-managed), env fallback for dev — the
      // evals-judge pattern.
      const secrets = secretService(d);
      const row = await secrets.getByName(cid, secret);
      if (row) return secrets.resolveSecretValue(cid, row.id, "latest");
      return process.env[secret] ?? null;
    });
  const apiKey = (await resolve(db, companyId, secretName)) ?? "";
  const castes = await createCasteStore({ db }).listCastes(companyId);
  const casteKeys = castes.map((c: { key: string }) => c.key);
  const gatewayDeps: ScentGatewayDeps = {
    fetch: ports.fetch ?? globalThis.fetch.bind(globalThis),
    apiKey,
    baseUrl: baseUrl || "http://127.0.0.1:9",
  };
  const gateway = {
    classifyIssueScent: (input: Parameters<typeof classifyIssueScent>[1]) =>
      classifyIssueScent(gatewayDeps, input),
    classifyAgentScent: (input: Parameters<typeof classifyAgentScent>[1]) =>
      classifyAgentScent(gatewayDeps, input),
  };
  const service = createScentService({
    db,
    companyId,
    settings,
    gateway,
    casteKeys,
    logActivity: (entry) =>
      logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "system",
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        details: entry.details ?? {},
      }),
  });
  return { service, settings, casteKeys };
}

export function myrmidonScentRoutes(db: Db, ports: ScentQueuePorts = {}) {
  const router = Router();

  router.post(
    "/myrmidon/companies/:companyId/issues/:issueId/scent/refresh",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const issueId = String(req.params.issueId);
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .select()
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
      if (!row) {
        res.status(404).json({ error: "Issue not found" });
        return;
      }

      const { service, settings, casteKeys } = await buildService(db, companyId, ports);
      if (!settings.enabled) {
        res.status(409).json({ error: "scent_disabled" });
        return;
      }

      const result = await service.classifyIssue(issueId);
      if (!result.spent) {
        // Budget exhausted this hour or nothing to classify.
        res.status(429).json({ error: "scent_refresh_rate_limited_or_unclassifiable" });
        return;
      }
      if (!result.scent) {
        res.status(502).json({ error: "scent_classifier_unavailable" });
        return;
      }

      // The auto caste follows the fresh scent through the SAME pure
      // derivation as the create hook — one rule, one place.
      const applied = deriveScentAuto(
        {
          title: row.title,
          priority: row.priority ?? "medium",
          casteKey: row.casteKey,
          casteSource: row.casteSource,
          pheromoneStrength: row.pheromoneStrength,
          scent: result.scent,
        },
        casteKeys,
        settings,
      );
      const patch: Record<string, unknown> = {};
      if (applied.casteKey && applied.casteSource === "auto") {
        patch.casteKey = applied.casteKey;
        patch.casteSource = "auto";
      }
      await db.update(issues).set(patch).where(eq(issues.id, issueId));

      const [fresh] = await db.select().from(issues).where(eq(issues.id, issueId));
      res.json({ issue: fresh });
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/agents/:agentId/scent/refresh",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const agentId = String(req.params.agentId);
      assertCompanyAccess(req, companyId);

      const [row] = await db
        .select()
        .from(agents)
        .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
      if (!row) {
        res.status(404).json({ error: "Agent not found" });
        return;
      }

      const { service, settings } = await buildService(db, companyId, ports);
      if (!settings.enabled) {
        res.status(409).json({ error: "scent_disabled" });
        return;
      }

      const result = await service.classifyAgent(agentId);
      if (!result.classified) {
        res.status(502).json({ error: "scent_classifier_unavailable_or_no_capabilities" });
        return;
      }
      const [fresh] = await db.select().from(agents).where(eq(agents.id, agentId));
      res.json({ agent: fresh });
    },
  );

  router.get(
    "/myrmidon/companies/:companyId/swarm/scent/status",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);
      const { service, settings } = await buildService(db, companyId, ports);
      const slice = await service.listMarkupQueue(settings.classifierBatchSize);
      res.json({
        enabled: settings.enabled,
        model: settings.model,
        pendingIssues: slice.issueIds.length,
        pendingAgents: slice.agentIds.length,
        totalPending: slice.totalPending,
      });
    },
  );

  return router;
}
