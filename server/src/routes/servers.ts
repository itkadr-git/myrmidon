// myrmidon(SERVER-ONBOARD): server onboarding routes.
//
//   POST /api/companies/:companyId/servers/onboarding/dry-run
//
// Runs the read-only pre-registration probes (DNS → SSH → permissions)
// against a candidate server and returns the typed result contract from
// @myrmidon/shared. The endpoint never persists anything: no DB writes, no
// journal entries, no activity-log rows. The credentials in the request
// body are used for the probes and never appear in the response or the
// logs — the route logs only the safe metadata subset from the shared
// contract.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  serverOnboardingDryRunInputSchema,
  metaFromOnboardingDryRunInput,
} from "@myrmidon/shared";
import { validate } from "../middleware/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import {
  runOnboardingDryRun,
  type OnboardingDryRunExecutor,
} from "../services/onboarding/dry-run.js";
import { createRealOnboardingDryRunExecutor } from "../services/onboarding/dry-run-executor.js";

export function serverOnboardingRoutes(
  db: Db,
  deps: { onboardingDryRunExecutor?: OnboardingDryRunExecutor } = {},
) {
  const router = Router();
  const executor =
    deps.onboardingDryRunExecutor ?? createRealOnboardingDryRunExecutor();

  router.post(
    "/companies/:companyId/servers/onboarding/dry-run",
    validate(serverOnboardingDryRunInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const input = serverOnboardingDryRunInputSchema.parse(req.body);

      // Log only the credential-free metadata subset. The password and the
      // private key are deliberately omitted from every log line.
      logger.info(
        {
          companyId,
          actor: getActorInfo(req),
          ...metaFromOnboardingDryRunInput(input),
        },
        "server onboarding dry-run requested",
      );

      const result = await runOnboardingDryRun(input, executor);

      // The result contract has no field for credentials, so serialization
      // is safe by construction.
      res.status(200).json(result);
    },
  );

  return router;
}
