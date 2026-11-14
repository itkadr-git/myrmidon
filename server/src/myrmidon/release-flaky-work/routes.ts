// server/src/myrmidon/release-flaky-work/routes.ts
//
// myrmidon(1.8 RELEASE-STAGE): REST routes for flaky CI work (OPE-13066).
// Allows releasing operator to:
//  - view flaky work and gate status
//  - report failed CI jobs
//  - retry jobs through the product
//  - waive flaky failures with verifiable evidence {headSha, job, attempt}
//  - resume release gate when all blockers are resolved

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { releaseFlakyEvidenceSchema } from "@myrmidon/shared";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, getActorInfo } from "../../routes/authz.js";
import { ReleaseFlakyWorkService } from "./service.js";

const reportJobSchema = z
  .object({
    jobName: z.string().trim().min(1).max(256),
    headSha: z.string().trim().min(1).max(128),
    attempt: z.number().int().min(1),
    failureDetail: z.string().max(2000).optional(),
  })
  .strict();

const retryJobSchema = z
  .object({
    jobId: z.string().trim().min(1),
    outcome: z.enum(["success", "failed"]).optional(),
  })
  .strict();

const waiverSchema = z
  .object({
    job: z.string().trim().min(1).max(256),
    reason: z.string().trim().min(1).max(1000),
    evidence: releaseFlakyEvidenceSchema,
  })
  .strict();

export function myrmidonReleaseFlakyWorkRoutes(
  db?: Db,
  service = new ReleaseFlakyWorkService(db),
): Router {
  const router = Router();

  // GET /api/myrmidon/release-stages/:releaseId/flaky-work
  router.get("/myrmidon/release-stages/:releaseId/flaky-work", (req, res) => {
    assertBoardOrgAccess(req);
    const releaseId = String(req.params.releaseId ?? "");
    res.json(service.getOrCreateState(releaseId));
  });

  // POST /api/myrmidon/release-stages/:releaseId/flaky-work/jobs
  router.post(
    "/myrmidon/release-stages/:releaseId/flaky-work/jobs",
    validate(reportJobSchema),
    (req, res) => {
      assertBoardOrgAccess(req);
      const releaseId = String(req.params.releaseId ?? "");
      const body = req.body as z.infer<typeof reportJobSchema>;
      const state = service.reportFailedJob(releaseId, body);
      res.status(201).json(state);
    },
  );

  // POST /api/myrmidon/release-stages/:releaseId/flaky-work/retry
  router.post(
    "/myrmidon/release-stages/:releaseId/flaky-work/retry",
    validate(retryJobSchema),
    async (req, res) => {
      assertBoardOrgAccess(req);
      const releaseId = String(req.params.releaseId ?? "");
      const body = req.body as z.infer<typeof retryJobSchema>;
      const state = await service.retryJob(releaseId, body.jobId, body.outcome ?? "success");
      res.json(state);
    },
  );

  // POST /api/myrmidon/release-stages/:releaseId/flaky-work/waiver
  router.post(
    "/myrmidon/release-stages/:releaseId/flaky-work/waiver",
    validate(waiverSchema),
    (req, res) => {
      assertBoardOrgAccess(req);
      const releaseId = String(req.params.releaseId ?? "");
      const body = req.body as z.infer<typeof waiverSchema>;
      const actor = getActorInfo(req);
      const state = service.recordWaiver(
        releaseId,
        body,
        {
          type: actor.actorType === "user" ? "user" : actor.actorType === "agent" ? "agent" : "board",
          id: actor.actorId ?? "unknown",
          casteKey: undefined,
        },
      );
      res.status(201).json(state);
    },
  );

  // POST /api/myrmidon/release-stages/:releaseId/flaky-work/resume
  router.post("/myrmidon/release-stages/:releaseId/flaky-work/resume", (req, res) => {
    assertBoardOrgAccess(req);
    const releaseId = String(req.params.releaseId ?? "");
    const actor = getActorInfo(req);
    const state = service.resumeGate(releaseId, {
      type: actor.actorType === "user" ? "user" : actor.actorType === "agent" ? "agent" : "board",
      id: actor.actorId ?? "unknown",
      casteKey: undefined,
    });
    res.json(state);
  });

  return router;
}
