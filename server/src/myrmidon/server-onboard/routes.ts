// myrmidon(SERVER-ONBOARD A): routes.
//
//   POST /api/myrmidon/fleet/servers                     — add a server (registry + secrets + pending job)
//   POST /api/myrmidon/fleet/servers/:id/onboard         — (re)start an onboard/recheck job
//   GET  /api/myrmidon/fleet/servers/:id/onboard-jobs    — job history for one server
//   POST /api/myrmidon/fleet/onboard-jobs/claim          — executor: claim the next pending job (token)
//   POST /api/myrmidon/fleet/onboard-jobs/:id/report     — executor: report a step / finish (token)
//
// Owner writes (add/onboard): company owner, local implicit access or instance
// admin — the same rule the fleet-console uses (assertFleetConsoleOwner).
// Executor claim/report require MYRMIDON_FLEET_ONBOARD_EXECUTOR_TOKEN. Writes
// answer 503 while the feature is off (the service enforces it).

import { Router, type Request } from "express";
import { z } from "zod";
import { HttpError, conflict, forbidden, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertCompanyAccess } from "../../routes/authz.js";
import { OnboardServiceError, type OnboardService } from "./service.js";

const UUID = z.string().uuid();

/** Same owner rule as the console: board identity + company membership. */
function assertFleetOnboardOwner(req: Request, companyId: string): void {
  assertCompanyAccess(req, companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  if (membership?.status === "active" && membership.membershipRole === "owner") return;
  throw forbidden("Company owner access required");
}

function executorToken(req: Request): string | null {
  const header = req.header("x-onboard-token")?.trim();
  return header || null;
}

function toHttpError(err: unknown): unknown {
  if (!(err instanceof OnboardServiceError)) return err;
  if (err.status === 404) return notFound(err.message);
  if (err.status === 409) return conflict(err.message);
  return new HttpError(err.status, err.message);
}

export const fleetServerAddSchema = z
  .object({
    companyId: z.string().uuid(),
    slug: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,62}$/),
    name: z.string().trim().min(1).max(120),
    hostname: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/\s/.test(value), "hostname must not contain whitespace"),
    port: z.number().int().min(1).max(65535).optional(),
    username: z.string().trim().min(1).max(64).optional(),
    role: z.enum(["generic", "build-runner", "sandbox", "bot-host"]).optional(),
    keepPassword: z.boolean().optional(),
    auth: z.discriminatedUnion("type", [
      z.object({ type: z.literal("password"), password: z.string().min(1).max(1024) }),
      z.object({ type: z.literal("generate-key") }),
    ]),
  })
  .strict();

export const onboardStartSchema = z
  .object({
    companyId: z.string().uuid(),
    kind: z.enum(["onboard", "recheck"]).optional(),
  })
  .strict();

export const claimSchema = z.object({ companyId: UUID }).strict();

export const reportSchema = z
  .object({
    companyId: UUID,
    step: z.string().trim().min(1).max(64).optional(),
    result: z.enum(["ok", "skipped", "failed"]).optional(),
    detail: z.string().max(2000).nullable().optional(),
    status: z.enum(["running", "succeeded", "failed"]).optional(),
    error: z.string().max(2000).nullable().optional(),
    hostKeyFingerprint: z.string().max(256).nullable().optional(),
  })
  .strict();

export function onboardRoutes(deps: { service: OnboardService }) {
  const router = Router();

  router.post("/myrmidon/fleet/servers", validate(fleetServerAddSchema), async (req, res) => {
    const body = req.body as z.infer<typeof fleetServerAddSchema>;
    assertFleetOnboardOwner(req, body.companyId);
    try {
      const result = await deps.service.addServer({
        ...body,
        port: body.port ?? 22,
        username: body.username ?? "root",
        role: body.role ?? "generic",
        keepPassword: body.keepPassword ?? false,
        createdBy: (req.actor.type === "board" ? req.actor.userId : req.actor.agentId) ?? null,
      });
      res.status(201).json(result);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.post("/myrmidon/fleet/servers/:id/onboard", validate(onboardStartSchema), async (req, res) => {
    const body = req.body as z.infer<typeof onboardStartSchema>;
    assertFleetOnboardOwner(req, body.companyId);
    const serverIdParam = req.params.id;
    const serverId = Array.isArray(serverIdParam) ? serverIdParam[0] : serverIdParam;
    if (!UUID.safeParse(serverId).success) throw new HttpError(400, "server id must be a uuid");
    try {
      res.status(201).json(await deps.service.startJob({
        companyId: body.companyId,
        serverId,
        kind: body.kind ?? "onboard",
        createdBy: (req.actor.type === "board" ? req.actor.userId : req.actor.agentId) ?? null,
      }));
    } catch (err) {
      throw toHttpError(err);
    }
  });

  router.get("/myrmidon/fleet/servers/:id/onboard-jobs", async (req, res) => {
    const companyId = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (!companyId) throw new HttpError(400, "companyId is required");
    assertFleetOnboardOwner(req, companyId);
    const serverIdParam = req.params.id;
    const serverId = Array.isArray(serverIdParam) ? serverIdParam[0] : serverIdParam;
    if (!UUID.safeParse(serverId).success) throw new HttpError(400, "server id must be a uuid");
    res.json({ jobs: await deps.service.listJobs(companyId, serverId) });
  });

  router.post("/myrmidon/fleet/onboard-jobs/claim", validate(claimSchema), async (req, res) => {
    const claim = await deps.service.claim((req.body as { companyId: string }).companyId, executorToken(req));
    if (!claim) res.status(204).end();
    else res.json(claim);
  });

  router.post("/myrmidon/fleet/onboard-jobs/:id/report", validate(reportSchema), async (req, res) => {
    const jobIdParam = req.params.id;
    const jobId = Array.isArray(jobIdParam) ? jobIdParam[0] : jobIdParam;
    if (!UUID.safeParse(jobId).success) throw new HttpError(400, "job id must be a uuid");
    const body = req.body as z.infer<typeof reportSchema>;
    try {
      const job = await deps.service.report(executorToken(req), {
        companyId: body.companyId,
        jobId,
        step: body.step,
        entry:
          body.step && body.result
            ? {
                step: body.step,
                startedAt: new Date().toISOString(),
                finishedAt: new Date().toISOString(),
                result: body.result,
                detail: body.detail ?? null,
              }
            : undefined,
        status: body.status,
        error: body.error ?? null,
        hostKeyFingerprint: body.hostKeyFingerprint ?? null,
      });
      if (!job) throw notFound("Job not found");
      res.json(job);
    } catch (err) {
      throw toHttpError(err);
    }
  });

  return router;
}
