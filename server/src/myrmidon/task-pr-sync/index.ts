// Task PR sync entry point.
//
// The scheduler imports `createTaskPrSyncScheduler` and calls the returned
// function on its tick (one import, one call — see CONVENTIONS.md §12). The wake
// guard in part E imports only `shouldSuppressRunForIssue` from `./guard.js`.

import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import type { PullRequestMergeDetailsResolver } from "../../services/github-pull-request-merge.js";
import { createTaskPrSyncSweep } from "./sweep.js";
import { readTaskPrSyncSettings } from "./settings.js";

export { shouldSuppressRunForIssue } from "./guard.js";
export { createTaskPrSyncSweep, reconcileClosedIssuePullRequests } from "./sweep.js";
export { decideTaskPrSync, effectivePullRequestState, settlePendingForProducts } from "./policy.js";
export { readTaskPrSyncSettings } from "./settings.js";

/**
 * Starts the scheduler-owned interval for task PR synchronization. The caller is
 * responsible for leadership checks before calling `start()` and stopping it at
 * shutdown; no heartbeat callback is scheduled here.
 */
export function createTaskPrSyncScheduler(input: {
  db: Db;
  track: (work: Promise<unknown>) => void;
  env?: NodeJS.ProcessEnv;
}): (() => void) & { stop: () => void } {
  // The resolver is built on first use, so importing this module does not drag
  // the GitHub credential path into the entry point's static import graph (a
  // vendor startup suite replaces the service layer with partial mocks).
  let resolverPromise: Promise<PullRequestMergeDetailsResolver> | null = null;
  const resolvePullRequestDetails: PullRequestMergeDetailsResolver = async (companyId, reference) => {
    resolverPromise ??= import("../../services/github-pull-request-merge.js").then((module) =>
      module.createPullRequestMergeDetailsResolver(input.db),
    );
    const resolve = await resolverPromise;
    return resolve(companyId, reference);
  };
  const sweep = createTaskPrSyncSweep({
    db: input.db,
    resolvePullRequestDetails,
    env: input.env,
  });
  const run = () => {
    input.track(
      sweep
        .sweep()
        .then((result) => {
          if (result.settled > 0 || result.returned > 0) {
            logger.info(result, "task PR sync settled delivered tasks");
          }
        })
        .catch((err) => {
          logger.error({ err }, "task PR sync sweep failed");
        }),
    );
  };
  const intervalMs = readTaskPrSyncSettings(input.env).pollMs;
  const interval = setInterval(run, intervalMs);
  interval.unref?.();
  const stop = () => clearInterval(interval);
  return Object.assign(run, { stop });
}
