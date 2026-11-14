// server/src/myrmidon/release-stage/routes.ts
//
// myrmidon(1.8 RELEASE-STAGE): the REST API — /api/myrmidon/release-stages/*.
//
//   GET  /api/myrmidon/release-stages?companyId=...           -> { stages }        (company access)
//   GET  /api/myrmidon/release-stages/:releaseId?companyId=.. -> { stage }         (company access)
//   PUT  /api/myrmidon/release-stages/:releaseId/gates        -> { stage }         (board only)
//   POST /api/myrmidon/release-stages/:releaseId/sign         -> { stage }         (board or release authority)
//   POST /api/myrmidon/release-stages/:releaseId/publish      -> { stage }         (board or release authority)
//
// Company resolution mirrors the autonomy routes: the `companyId` query
// parameter first, then the caller's single active company membership.
// Authorization: reads need company access; gate definition is board-only;
// sign/publish require the release-manager caste whose deploy cell the
// autonomy matrix explicitly allows, so the release manager (a company-defined
// caste key) is the only agent caste with release rights, and every other
// caste falls to the matrix default.
// Publication additionally refuses while any release gate is incomplete or
// the artifact is unsigned — the gates cannot be bypassed by any caller.

import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@myrmidon/db";
import { defaultAutonomyMatrix, type AutonomyMatrix } from "@myrmidon/shared";
import { unprocessable } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "../../routes/authz.js";
import { logActivity } from "../../services/activity-log.js";
import { agentRoleFromDb, dbAutonomyStore } from "../autonomy/store.js";
import {
  createInMemoryReleaseStageStore,
  createReleaseStageService,
  type ReleaseActor,
  type ReleaseStageService,
  type ReleaseStageStore,
} from "./service.js";

const gatesSchema = z.object({
  gates: z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        completed: z.boolean(),
      }),
    )
    .min(1)
    .max(100),
});

const signSchema = z.object({
  artifactId: z.string().min(1).max(300),
  tag: z.string().min(1).max(200),
  version: z.string().min(1).max(100),
  composition: z.array(z.string().min(1).max(200)).min(1).max(1000),
  digest: z.string().min(1).max(512),
  verificationUrl: z.string().url().max(2000),
});

const publishSchema = z.object({
  publicationUrl: z.string().url().max(2000),
});

export interface ReleaseStageRoutesDeps {
  service: ReleaseStageService;
  /**
   * The live caste directory: agent id → caste key (`agents.role`).
   * Production wires `agentRoleFromDb(db)`; tests pass a fake directory.
   */
  casteKeyOf: (agentId: string) => Promise<string | null>;
  /** The audit sink. Production wires the activity log; tests record. */
  logActivity: (input: {
    companyId: string;
    actorType: "user" | "agent" | "system";
    actorId: string;
    action: string;
    entityType: string;
    entityId: string;
    details: Record<string, unknown>;
  }) => Promise<void>;
}

/** Production wiring: matrix from instance_settings, stages in-memory per company. */
export function myrmidonReleaseStageRoutes(db: Db): Router {
  const store = createInMemoryReleaseStageStore();
  const matrixOf = async (companyId: string): Promise<AutonomyMatrix> => {
    try {
      const doc = await dbAutonomyStore(db).read();
      return doc.matrix;
    } catch {
      // A fresh instance with no autonomy document yet still gets the safe
      // defaults — the release authority must never read as undefined.
      return defaultAutonomyMatrix();
    }
  };
  return releaseStageRoutes({
    service: createReleaseStageService({ store, matrixOf }),
    casteKeyOf: agentRoleFromDb(db),
    logActivity: async (input) => {
      await logActivity(db, { ...input, entityType: "release_stage" });
    },
  });
}

/**
 * The injected form: production passes the db-backed matrix and audit sink,
 * tests pass in-memory ones. The express router itself is real in both.
 */
export function releaseStageRoutes(deps: ReleaseStageRoutesDeps): Router {
  const router = Router();

  /** Company resolution: query parameter first, then single membership. */
  function resolveCompanyId(req: Request): string {
    const fromQuery = typeof req.query.companyId === "string" ? req.query.companyId : "";
    if (fromQuery) return fromQuery;
    const actor = req.actor as { companyIds?: string[] } | undefined;
    const ids = actor?.companyIds ?? [];
    if (ids.length === 1) return ids[0]!;
    throw unprocessable(
      ids.length === 0
        ? "companyId query parameter is required (no company membership)"
        : "companyId query parameter is required (multiple company memberships)",
    );
  }

  function companyOf(req: Request): string {
    const companyId = resolveCompanyId(req);
    assertCompanyAccess(req, companyId);
    return companyId;
  }

  /** Actor for authority checks and audit: board user or agent. */
  function actorOf(req: Request): ReleaseActor {
    const info = getActorInfo(req);
    if (info.actorType === "agent" && info.agentId) {
      return { type: "agent", id: info.agentId, casteKey: null };
    }
    return { type: "board", id: info.actorId || "board" };
  }

  /** Enrich an agent actor with its live caste key (`agents.role`). */
  function withCaste(actor: ReleaseActor, casteKey: string | null): ReleaseActor {
    return actor.type === "agent" ? { ...actor, casteKey } : actor;
  }

  router.get("/myrmidon/release-stages", async (req, res) => {
    const companyId = companyOf(req);
    res.json({ stages: await deps.service.listStages(companyId) });
  });

  router.get("/myrmidon/release-stages/:releaseId", async (req, res) => {
    const companyId = companyOf(req);
    const releaseId = String(req.params.releaseId ?? "");
    res.json({ stage: await deps.service.getStage(companyId, releaseId) });
  });

  router.put(
    "/myrmidon/release-stages/:releaseId/gates",
    validate(gatesSchema),
    async (req, res) => {
      const companyId = companyOf(req);
      assertBoard(req);
      const actor = actorOf(req);
      const stage = await deps.service.defineStage({
        companyId,
        releaseId: String(req.params.releaseId ?? ""),
        gates: (req.body as { gates: { key: string; completed: boolean }[] }).gates,
        actor,
      });
      await deps.logActivity({
        companyId,
        actorType: "user",
        actorId: actor.id,
        action: "release_stage_gates_defined",
        entityType: "release_stage",
        entityId: stage.releaseId,
        details: { gates: stage.gates.map((gate) => ({ key: gate.key, completed: gate.completed })) },
      });
      res.json({ stage });
    },
  );

  router.post(
    "/myrmidon/release-stages/:releaseId/sign",
    validate(signSchema),
    async (req, res) => {
      const companyId = companyOf(req);
      const baseActor = actorOf(req);
      const casteKey = baseActor.type === "agent" ? await deps.casteKeyOf(baseActor.id) : null;
      const actor = withCaste(baseActor, casteKey);
      const body = req.body as z.infer<typeof signSchema>;
      const stage = await deps.service.signArtifact({
        companyId,
        releaseId: String(req.params.releaseId ?? ""),
        artifactId: body.artifactId,
        tag: body.tag,
        version: body.version,
        composition: body.composition,
        digest: body.digest,
        verificationUrl: body.verificationUrl,
        actor,
      });
      await deps.logActivity({
        companyId,
        actorType: actor.type === "agent" ? "agent" : "user",
        actorId: actor.id,
        action: "release_artifact_signed",
        entityType: "release_stage",
        entityId: stage.releaseId,
        details: {
          artifactId: stage.artifact?.artifactId ?? null,
          digest: stage.artifact?.digest ?? null,
          signedBy: stage.artifact?.signedBy ?? null,
          verificationUrl: stage.artifact?.verificationUrl ?? null,
        },
      });
      res.json({ stage });
    },
  );

  router.post(
    "/myrmidon/release-stages/:releaseId/publish",
    validate(publishSchema),
    async (req, res) => {
      const companyId = companyOf(req);
      const baseActor = actorOf(req);
      const casteKey = baseActor.type === "agent" ? await deps.casteKeyOf(baseActor.id) : null;
      const actor = withCaste(baseActor, casteKey);
      const body = req.body as z.infer<typeof publishSchema>;
      const stage = await deps.service.publishRelease({
        companyId,
        releaseId: String(req.params.releaseId ?? ""),
        publicationUrl: body.publicationUrl,
        actor,
      });
      await deps.logActivity({
        companyId,
        actorType: actor.type === "agent" ? "agent" : "user",
        actorId: actor.id,
        action: "release_published",
        entityType: "release_stage",
        entityId: stage.releaseId,
        details: {
          publicationUrl: stage.publicationUrl,
          publishedBy: stage.publishedBy,
          signedBy: stage.artifact?.signedBy ?? null,
          verificationUrl: stage.artifact?.verificationUrl ?? null,
        },
      });
      res.json({ stage });
    },
  );

  return router;
}
