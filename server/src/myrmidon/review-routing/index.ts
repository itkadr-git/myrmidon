// myrmidon(REVIEW-ROUTING): entry point — one import and one call site in the
// server entry (CONVENTIONS.md §12) plus one router in app.ts.

import type { Db } from "@paperclipai/db";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { isInstanceUnderMaintenance } from "../maintenance/gate.js";
import { readReviewRoutingSettings } from "./settings.js";
import { createReviewRoutingSweep } from "./sweep.js";
import { createPgReviewRoutingStore } from "./store.js";

export * from "./attention.js";
export * from "./policy.js";
export * from "./settings.js";
export { reviewRoutingRoutes } from "./routes.js";
export { createReviewRoutingSweep, type ReviewRoutingSweep, type ReviewRoutingSweepResult } from "./sweep.js";
export { createPgReviewRoutingStore, type ReviewRoutingStore } from "./store.js";

type WakeFn = (agentId: string, options: Record<string, unknown>) => Promise<unknown>;

/**
 * Builds the pass the scheduler tick calls. The service layer is loaded lazily:
 * this module sits in the server entry point's static import graph, and some
 * vendor startup suites replace the service barrel with partial mocks.
 */
export function createReviewRoutingScheduler(input: {
  db: Db;
  wakeup: WakeFn;
  track: (work: Promise<unknown>) => void;
}): () => void {
  const settings = instanceSettingsService(input.db);
  const sweep = createReviewRoutingSweep({
    store: createPgReviewRoutingStore(input.db),
    readSettings: () => readReviewRoutingSettings(settings),
    isUnderMaintenance: () => isInstanceUnderMaintenance(input.db),
    addComment: async (issueId, body, options) => {
      const { issueService } = await import("../../services/issues.js");
      return issueService(input.db).addComment(issueId, body, {}, {
        authorType: "system",
        presentation: options.presentation,
        metadata: options.metadata,
      });
    },
    wakeReviewer: (agentId, wake) =>
      input.wakeup(agentId, {
        source: "assignment",
        triggerDetail: "system",
        reason: wake.reason,
        payload: { issueId: wake.issueId, mutation: wake.mutation, executionStage: wake.executionStage },
        requestedByActorType: "system",
        requestedByActorId: null,
        contextSnapshot: {
          issueId: wake.issueId,
          taskId: wake.issueId,
          wakeReason: wake.reason,
          source: "myrmidon.review_routing",
          executionStage: wake.executionStage,
        },
      }),
    logActivity: async (entry) => {
      const { logActivity } = await import("../../services/activity-log.js");
      await logActivity(input.db, {
        companyId: entry.companyId,
        actorType: "system",
        actorId: "review_routing_sweep",
        action: entry.action,
        entityType: "issue",
        entityId: entry.issueId,
        issueId: entry.issueId,
        details: entry.details,
      });
    },
  });
  return () => {
    input.track(
      sweep
        .sweep()
        .then((result) => {
          if (result.assigned > 0 || result.reassigned > 0 || result.failed > 0) {
            logger.info(result, "review routing sweep completed");
          }
        })
        .catch((err) => {
          logger.error({ err }, "review routing sweep failed");
        }),
    );
  };
}
