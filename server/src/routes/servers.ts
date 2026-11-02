// myrmidon(SERVER-ONBOARD): server onboarding routes.
//
//   POST /api/companies/:companyId/servers/ssh-dry-run
//
// Validates the SSH parameters the owner typed into the onboarding form by
// opening a real SSH connection — without registering the server and without
// persisting the credentials. The private key travels in the request body,
// is used for the probe, and is never written to the database, the journal,
// the activity log, or any response field. Password auth is not supported.

import { Router } from "express";
import type { Db } from "@myrmidon/db";
import { sshDryRunInputSchema } from "@myrmidon/shared";
import { validate } from "../middleware/index.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { logger } from "../middleware/logger.js";
import {
  createRealSshDryRunExecutor,
  type SshDryRunExecutor,
} from "../onboarding/ssh-dry-run.js";

export function serverOnboardingRoutes(
  db: Db,
  deps: { sshDryRunExecutor?: SshDryRunExecutor } = {},
) {
  const router = Router();
  const sshDryRun = deps.sshDryRunExecutor ?? createRealSshDryRunExecutor();

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

      const result = await sshDryRun.dryRun({
        host: body.host,
        port: body.port,
        username: body.username,
        privateKey: body.auth.privateKey,
        timeoutMs: body.timeoutMs,
      });

      // The result is safe to serialize: the executor contract guarantees
      // no credential material in `reason` or any other field.
      res.status(200).json(result);
    },
  );

  return router;
}
