// myrmidon(REVIEW-REWORK): entry point — one import and one call site in the
// server entry (CONVENTIONS.md §12) plus one router in app.ts.

import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { isInstanceUnderMaintenance } from "../maintenance/gate.js";
import { reviewReworkSettingsService } from "./settings.js";
import { createReviewReworkSweep } from "./sweep.js";
import { createPullRequestReviewFactsResolver } from "./resolver.js";
import { createPgReviewReworkStore } from "./store.js";

export * from "./domain.js";
export * from "./settings.js";
export { reviewReworkRoutes } from "./routes.js";
export {
  createReviewReworkSweep,
  type ReviewReworkSweep,
  type ReviewReworkSweepResult,
} from "./sweep.js";
export { createPgReviewReworkStore, type ReviewReworkStore } from "./store.js";
export {
  createPullRequestReviewFactsResolver,
  type ReviewReworkPrResolver,
} from "./resolver.js";

type WakeFn = (agentId: string, options: Record<string, unknown>) => Promise<unknown>;

/**
 * Builds the pass the scheduler tick calls. The wake seam is the heartbeat's
 * own `wakeup` (every existing gate applies: pause, maintenance, admission,
 * budget); the GitHub resolver is built lazily so importing this module does
 * not drag the credential path into the entry's static graph.
 */
export function createReviewReworkScheduler(input: {
  db: Db;
  wakeup: WakeFn;
  track: (work: Promise<unknown>) => void;
  /** myrmidon(OPE-12397): the tick is a no-op unless this process leads "scheduler" (as TASK-PR-SYNC). */
  isLeader?: () => boolean;
}): () => void {
  const settings = reviewReworkSettingsService(input.db, {
    settings: instanceSettingsService(input.db),
  });
  const sweep = createReviewReworkSweep({
    store: createPgReviewReworkStore(input.db),
    resolvePr: createPullRequestReviewFactsResolver(input.db, { source: "review-rework" }),
    readSettings: () => settings.read(),
    isUnderMaintenance: () => isInstanceUnderMaintenance(input.db),
    isLeader: input.isLeader,
    enqueueWake: (agentId, wake) => input.wakeup(agentId, wake as Record<string, unknown>),
    logActivity: async (entry) => {
      const { logActivity } = await import("../../services/activity-log.js");
      await logActivity(input.db, {
        companyId: entry.companyId,
        actorType: "system",
        actorId: "review_rework_sweep",
        action: entry.action,
        entityType: "issue",
        entityId: entry.issueId,
        issueId: entry.issueId,
        details: entry.details,
      });
    },
  });
  return () => {
    // myrmidon(OPE-12397): only the "scheduler" leader sweeps; other
    // processes no longer re-read every PR of every candidate on their own.
    if (input.isLeader && !input.isLeader()) return;
    input.track(
      sweep
        .sweep()
        .then((result) => {
          if (
            result.reworkCreated > 0 ||
            result.reworkReopened > 0 ||
            result.blocked > 0 ||
            result.unblocked > 0 ||
            result.closed > 0 ||
            result.failed > 0
          ) {
            logger.info(result, "review rework sweep completed");
          }
        })
        .catch((err) => {
          logger.error({ err }, "review rework sweep failed");
        }),
    );
  };
}
