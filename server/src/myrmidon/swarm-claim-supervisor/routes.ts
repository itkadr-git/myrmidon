// myrmidon(1.6-SWARM-CLAIM-B): the supervisor surface routes.
//
//   GET  /api/myrmidon/companies/:companyId/swarm-claim/supervisor/overview
//   POST /api/myrmidon/companies/:companyId/swarm-claim/supervisor/release-lease
//
// Reads need company access (the same check the vendor costs routes use);
// the rebalance action additionally needs a board actor — it moves live work.
// While part A's claim machinery is absent or off, the overview
// answers 503 with { enabled: false } so the UI can say why instead of
// showing a bare error.

import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "../../routes/authz.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { createCasteDirectoryReader } from "../castes/directory.js";
import { buildSwarmMatcher } from "../swarm-claim/matcher-factory.js";
import type { SwarmClaimEnqueueWakeup } from "../swarm-claim/service.js";
import { swarmSupervisorView, createSwarmSupervisorDbPort, type SwarmSupervisorOverview } from "./view.js";
import {
  createSwarmSupervisorReleasePort,
  releaseLeaseForRebalance,
  ClaimNotLiveError,
  ClaimNotFoundError,
  type SwarmRebalanceDeps,
} from "./rebalance.js";

export interface SwarmSupervisorRoutesDeps {
  db: Db;
  /** Board wake admission path; every limit and gate is enforced inside it. */
  enqueueWakeup: SwarmClaimEnqueueWakeup;
  /** Activity log for the rebalance action; absent in unit tests. */
  logActivity?: SwarmRebalanceDeps["logActivity"];
  env?: NodeJS.ProcessEnv;
  now(): Date;
}

export function swarmSupervisorRoutes(db: Db, deps: SwarmSupervisorRoutesDeps) {
  const router = Router();
  const env = deps.env ?? process.env;
  const now = deps.now ?? (() => new Date());
  const port = createSwarmSupervisorReleasePort(db, env);
  const view = swarmSupervisorView(port, env, now);
  // The matcher is built per release: the switch is read each time, so a swarm
  // turned off since the last call matches nothing (design §5.1).
  const matchIssue: NonNullable<SwarmRebalanceDeps["matchIssue"]> = async (issueId) => {
    const matcher = await buildSwarmMatcher({
      db,
      settings: instanceSettingsService(db),
      enqueueWakeup: deps.enqueueWakeup,
      // myrmidon(1.6.5 OPE-6608): the rebalance pass honours swarmEligible=false and the per-caste ceiling, like the sweep and the claim API.
      castes: createCasteDirectoryReader(db),
      env,
    });
    return matcher ? matcher.forIssue(issueId) : null;
  };

  router.get(
    "/myrmidon/companies/:companyId/swarm-claim/supervisor/overview",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const overview: SwarmSupervisorOverview = await view.overview(companyId);
      if (!overview.enabled) {
        res.status(503).json({ error: "swarm claim is not enabled", enabled: false });
        return;
      }
      res.json(overview);
    },
  );

  router.post(
    "/myrmidon/companies/:companyId/swarm-claim/supervisor/release-lease",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoard(req);
      const body = (req.body ?? {}) as { claimId?: unknown; reason?: unknown };
      if (typeof body.claimId !== "string" || !body.claimId.trim()) {
        res.status(400).json({ error: "claimId is required" });
        return;
      }
      try {
        const result = await releaseLeaseForRebalance(
          {
            port,
            matchIssue,
            logActivity: deps.logActivity,
            env,
            now,
          },
          companyId,
          body.claimId.trim(),
          typeof body.reason === "string" ? body.reason : undefined,
          {
            actorType: req.actor?.type === "agent" ? "agent" : "user",
            actorId: req.actor?.type === "board" ? (req.actor.userId ?? "board") : (req.actor?.agentId ?? "board"),
          },
        );
        res.json(result);
      } catch (err) {
        if (err instanceof ClaimNotFoundError) {
          res.status(404).json({ error: err.message });
          return;
        }
        if (err instanceof ClaimNotLiveError) {
          res.status(409).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    },
  );

  return router;
}
