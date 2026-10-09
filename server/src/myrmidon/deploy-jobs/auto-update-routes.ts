// myrmidon(1.7 AUTO-UPDATE-SETTINGS B): routes of the update policy screen.
//
//   GET    /api/myrmidon/auto-update                — the policy, its sources, the window
//   PATCH  /api/myrmidon/auto-update                — change mode / window / canary
//   POST   /api/myrmidon/auto-update/approvals      — approve a release (tag + verified digest)
//   DELETE /api/myrmidon/auto-update/approvals/:tag — withdraw an approval that has not started
//
// Reads are board-wide (the window and the mode decide when everybody's agents
// pause for an update); writes are instance-admin only, the same rule as the
// deploy jobs themselves. Every value travels with where it came from
// (AutoUpdateValueSource): an env override is shown as such and cannot be
// edited from the screen — the screen's value is kept, it simply is not the one
// being executed.
//
// The stored value and the executed value are both returned: the screen edits
// the first and displays the second, so a forced override never hides what the
// instance has in its own settings row.

import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { badRequest, conflict, notFound } from "../../errors.js";
import { validate } from "../../middleware/validate.js";
import { assertBoardOrgAccess, assertInstanceAdmin, getActorInfo } from "../../routes/authz.js";
import { instanceSettingsService, logActivity } from "../../services/index.js";
import {
  AUTO_UPDATE_APPROVAL_LIMIT,
  AUTO_UPDATE_MODES,
  autoUpdateStart,
  defaultAutoUpdateSettings,
  resolveAutoUpdateSettings,
  windowState,
  type AutoUpdateApproval,
  type AutoUpdateSettings,
} from "./auto-update.js";
import { mutateAutoUpdateDocument, readAutoUpdateDocument } from "./auto-update-store.js";
import { digestProblem, isDeployJobActive, type DeployJobDocument } from "./domain.js";
import { readDeployJobDocument } from "./store.js";

export const AUTO_UPDATE_UPDATED_ACTION = "myrmidon.auto_update.updated";
export const AUTO_UPDATE_APPROVED_ACTION = "myrmidon.auto_update.approved";
export const AUTO_UPDATE_APPROVAL_WITHDRAWN_ACTION = "myrmidon.auto_update.approval_withdrawn";

const minuteSchema = z.number().int().min(0).max(1439);
const weekdaySchema = z.number().int().min(0).max(6);

export const autoUpdatePatchSchema = z
  .object({
    mode: z.enum([...AUTO_UPDATE_MODES] as [string, ...string[]]).optional(),
    // `days: []` is a meaningful value, not a missing one: an instance with no
    // days has no window and deploys whenever the operator clicks.
    window: z
      .object({
        days: z.array(weekdaySchema).max(7),
        fromMinute: minuteSchema,
        toMinute: minuteSchema,
      })
      .strict()
      .optional(),
    canary: z
      .object({
        enabled: z.boolean(),
        sharePercent: z.number().int().min(1).max(100),
        minBots: z.number().int().min(1).max(100),
        maxBots: z.number().int().min(1).max(100),
        healthSettleSec: z.number().int().min(0).max(86_400),
      })
      .strict()
      .optional(),
  })
  .strict();

export const autoUpdateApprovalSchema = z
  .object({
    tag: z.string().trim().min(1).max(120),
    digest: z.string().trim().min(1).max(200),
    version: z.string().trim().max(120).optional(),
  })
  .strict();

export type AutoUpdatePatch = z.infer<typeof autoUpdatePatchSchema>;
export type AutoUpdateApprovalInput = z.infer<typeof autoUpdateApprovalSchema>;

/**
 * What the screen renders: the stored policy, the policy as it will be
 * executed, the source of each value, the window right now and what the
 * scheduler would do with the approvals it has.
 */
export function autoUpdateView(stored: AutoUpdateSettings, now: Date) {
  const resolved = resolveAutoUpdateSettings(stored);
  return {
    stored,
    settings: resolved.settings,
    sources: resolved.sources,
    overridden: resolved.overridden,
    window: windowState(resolved.settings.window, now),
    start: autoUpdateStart({ settings: resolved.settings, now }),
    defaults: defaultAutoUpdateSettings(),
  };
}

/** One audit row per company, like the other instance settings writes. */
async function auditEverywhere(
  db: Db,
  action: string,
  actor: ReturnType<typeof getActorInfo>,
  details: Record<string, unknown>,
) {
  const companyIds = await instanceSettingsService(db).listCompanyIds();
  await Promise.all(
    companyIds.map((companyId) =>
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        agentApiKeyId: actor.agentApiKeyId,
        action,
        entityType: "instance_settings",
        entityId: "auto-update",
        details,
      }),
    ),
  );
}

export function autoUpdateRoutes(
  db: Db,
  now: () => Date = () => new Date(),
  // The screen only needs the deploy jobs to tell whether an approval's job is
  // still running; tests pass their own reader.
  readJobs: () => Promise<DeployJobDocument> = () => readDeployJobDocument(db),
) {
  const router = Router();

  router.get("/myrmidon/auto-update", async (req, res) => {
    assertBoardOrgAccess(req);
    res.json(autoUpdateView(await readAutoUpdateDocument(db), now()));
  });

  router.patch("/myrmidon/auto-update", validate(autoUpdatePatchSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const patch = req.body as AutoUpdatePatch;
    const { result } = await mutateAutoUpdateDocument(db, (current) => {
      const next: AutoUpdateSettings = {
        mode: (patch.mode as AutoUpdateSettings["mode"] | undefined) ?? current.mode,
        window: patch.window === undefined ? current.window : { ...patch.window },
        canary: patch.canary === undefined ? current.canary : { ...patch.canary },
        approvals: current.approvals,
      };
      return { next, result: { previous: current, next } };
    });
    await auditEverywhere(db, AUTO_UPDATE_UPDATED_ACTION, actor, {
      previous: result.previous,
      next: result.next,
    });
    res.json(autoUpdateView(await readAutoUpdateDocument(db), now()));
  });

  router.post("/myrmidon/auto-update/approvals", validate(autoUpdateApprovalSchema), async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const input = req.body as AutoUpdateApprovalInput;
    const problem = digestProblem(input.digest);
    if (problem) throw badRequest(problem);
    const approval: AutoUpdateApproval = {
      tag: input.tag,
      digest: input.digest,
      version: input.version ?? null,
      approvedBy: { actorType: actor.actorType, actorId: actor.actorId },
      approvedAt: now().toISOString(),
      jobId: null,
    };
    let result: AutoUpdateApproval;
    try {
      ({ result } = await mutateAutoUpdateDocument(db, (current) => {
        const existing = current.approvals.find((entry) => entry.tag === approval.tag);
        if (existing && existing.jobId !== null) {
          throw new ApprovalConflict(
            `release ${approval.tag} already started a deploy (job ${existing.jobId}) — abort it or approve another tag`,
          );
        }
        // Newest first, one entry per tag, bounded like the store's own limit.
        const approvals = [approval, ...current.approvals.filter((entry) => entry.tag !== approval.tag)].slice(
          0,
          AUTO_UPDATE_APPROVAL_LIMIT,
        );
        return { next: { ...current, approvals }, result: approval };
      }));
    } catch (err) {
      if (err instanceof ApprovalConflict) throw conflict(err.message);
      throw err;
    }
    await auditEverywhere(db, AUTO_UPDATE_APPROVED_ACTION, actor, {
      tag: result.tag,
      digest: result.digest,
      version: result.version,
    });
    res.status(201).json(autoUpdateView(await readAutoUpdateDocument(db), now()));
  });

  router.delete("/myrmidon/auto-update/approvals/:tag", async (req, res) => {
    assertInstanceAdmin(req);
    const actor = getActorInfo(req);
    const tag = String(req.params.tag ?? "").trim();
    // The approval may only be withdrawn while its deploy is not running: a
    // release that is switching the board right now is the job's business (an
    // operator aborts the job). Once the job is terminal — finished or refused
    // — withdrawing is the operator's way to retry with a fixed digest.
    const before = await readAutoUpdateDocument(db);
    const entry = before.approvals.find((candidate) => candidate.tag === tag);
    if (!entry) throw notFound(`no approval for release ${tag}`);
    if (entry.jobId !== null) {
      const job = await readJobs().then((doc) => doc.jobs.find((candidate) => candidate.id === entry.jobId) ?? null);
      if (job && isDeployJobActive(job.status)) {
        throw conflict(
          `release ${tag} already started a deploy (job ${entry.jobId}) — abort the job instead of withdrawing the approval`,
        );
      }
    }
    let result: AutoUpdateApproval | null;
    try {
      ({ result } = await mutateAutoUpdateDocument(db, (current) => {
        const existing = current.approvals.find((candidate) => candidate.tag === tag);
        if (!existing) return { next: null, result: null };
        if (existing.jobId !== entry.jobId) {
          throw new ApprovalConflict(`release ${tag} started a deploy while the approval was being withdrawn`);
        }
        return { next: { ...current, approvals: current.approvals.filter((candidate) => candidate.tag !== tag) }, result: existing };
      }));
    } catch (err) {
      if (err instanceof ApprovalConflict) throw conflict(err.message);
      throw err;
    }
    if (!result) throw notFound(`no approval for release ${tag}`);
    await auditEverywhere(db, AUTO_UPDATE_APPROVAL_WITHDRAWN_ACTION, actor, { tag, digest: result.digest });
    res.json(autoUpdateView(await readAutoUpdateDocument(db), now()));
  });

  return router;
}

/** Raised inside the row lock; mapped to 409 by the handlers above. */
class ApprovalConflict extends Error {}

/** Router for app.ts: the update policy screen. */
export function myrmidonAutoUpdateRoutes(db: Db) {
  return autoUpdateRoutes(db);
}