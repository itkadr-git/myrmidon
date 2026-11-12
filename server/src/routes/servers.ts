// myrmidon(SERVER-ONBOARD): server onboarding routes.
//
//   POST /api/companies/:companyId/servers/onboarding/dry-run     (current)
//   POST /api/companies/:companyId/servers/ssh-dry-run            (legacy alias)
//
// The current endpoint runs the read-only pre-registration probes
// (DNS → SSH → permissions) against a candidate server and returns the
// typed result contract from @myrmidon/shared. The legacy alias keeps the
// original single SSH-credential probe (private key only, real ssh binary)
// for existing clients; see docs/myrmidon/servers-onboarding-dry-run.md.
//
// Neither endpoint persists anything: no DB writes, no journal entries, no
// activity-log rows. Credentials in the request bodies are used for the
// probes and never appear in the responses or the logs — both routes log
// only credential-free metadata, and both are marked secret-sensitive in
// the HTTP log policy so error/crash metadata stays generic.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import {
  metaFromOnboardingDryRunInput,
  serverOnboardingDryRunInputSchema,
  sshDryRunInputSchema,
} from "@myrmidon/shared";
import { validate } from "../middleware/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import {
  runOnboardingDryRun,
  type OnboardingDryRunExecutor,
} from "../services/onboarding/dry-run.js";
import { createRealOnboardingDryRunExecutor } from "../services/onboarding/dry-run-executor.js";
import {
  createRealSshDryRunExecutor,
  type SshDryRunExecutor,
} from "../onboarding/ssh-dry-run.js";

export function serverOnboardingRoutes(
  db: Db,
  deps: {
    onboardingDryRunExecutor?: OnboardingDryRunExecutor;
    sshDryRunExecutor?: SshDryRunExecutor;
  } = {},
) {
  const router = Router();
  const executor =
    deps.onboardingDryRunExecutor ?? createRealOnboardingDryRunExecutor();
  const legacyExecutor =
    deps.sshDryRunExecutor ?? createRealSshDryRunExecutor();

  // Current contract: typed DNS/SSH/permissions probes.
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

  // Legacy alias (pre-1.7 clients): single SSH-credential probe with the
  // original response shape. Kept for compatibility; new clients should use
  // /servers/onboarding/dry-run above.
  router.post(
    "/companies/:companyId/servers/ssh-dry-run",
    validate(sshDryRunInputSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const body = req.body as {
        host: string;
        port: number;
        username: string;
        auth: { privateKey: string };
        timeoutMs?: number;
      };

      // Log the probe request without the credential material. The private
      // key is deliberately omitted from every log line.
      logger.info(
        {
          companyId,
          actor: getActorInfo(req),
          host: body.host,
          port: body.port,
          username: body.username,
          authMethod: "privateKey",
        },
        "ssh dry-run probe requested",
      );

      const result = await legacyExecutor.dryRun({
        host: body.host,
        port: body.port,
        username: body.username,
        privateKey: body.auth.privateKey,
        timeoutMs: body.timeoutMs,
      });

      // The legacy result contains only outcome/reason/uname/duration — no
      // credential fields — so serialization is safe by construction.
      res.status(200).json(result);
    },
  );

  return router;
}
