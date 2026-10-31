// myrmidon(BOARD-JANITOR): entry point for daily janitor routine
//
// Governs the daily board janitor routine (08:00 Irkutsk, or on-demand).

import type { Db } from "@myrmidon/db";
import { logger } from "../../middleware/logger.js";
import { isDueForDailyRun, readBoardJanitorSettings } from "./settings.js";
import { createBoardJanitorSweep, type BoardJanitorSweepResult } from "./sweep.js";

export {
  createBoardJanitorSweep,
  type BoardJanitorSweepResult,
} from "./sweep.js";
export { boardJanitorRoutes } from "./routes.js";
export {
  generateJanitorReportMarkdown,
  judgeMergedPrClosure,
  judgeOverdueDeadline,
  judgeStaleBlock,
  judgeStaleUntouched,
  judgeUnassignedReleaseTask,
  STALE_LABEL_NAME,
  type CommentCandidate,
  type IssueCandidate,
  type JanitorAction,
  type WorkProductCandidate,
} from "./policy.js";
export {
  BOARD_JANITOR_ENABLED_ENV,
  BOARD_JANITOR_RUN_HOUR_IRKUTSK_ENV,
  BOARD_JANITOR_SERVICE_AGENT_ID_ENV,
  BOARD_JANITOR_SERVICE_TICKET_ID_ENV,
  DEFAULT_BOARD_JANITOR_RUN_HOUR_IRKUTSK,
  DEFAULT_BOARD_JANITOR_SERVICE_AGENT_ID,
  DEFAULT_BOARD_JANITOR_SERVICE_TICKET_ID,
  isDueForDailyRun,
  readBoardJanitorSettings,
  type BoardJanitorSettings,
} from "./settings.js";

/**
 * Creates the daily board janitor scheduler invoked on heartbeat scheduler ticks.
 * Evaluates whether Irkutsk 08:00 has arrived for today's pass.
 */
export function createBoardJanitorScheduler(input: {
  db: Db;
  track: (work: Promise<unknown>) => void;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}): () => void {
  const sweep = createBoardJanitorSweep({
    db: input.db,
    settings: readBoardJanitorSettings(input.env),
    now: input.now,
  });

  let lastRunAt: Date | null = null;
  let running = false;

  return () => {
    if (running) return;
    const settings = readBoardJanitorSettings(input.env);
    if (!settings.enabled) return;

    const now = input.now ? input.now() : new Date();
    if (!isDueForDailyRun(now, lastRunAt, settings.runHourIrkutsk)) {
      return;
    }

    running = true;
    lastRunAt = now;

    const work = (async () => {
      try {
        // Fetch all distinct active companies
        const { companies } = await import("@myrmidon/db");
        const allCompanies = await input.db.select({ id: companies.id }).from(companies);

        for (const c of allCompanies) {
          const result = await sweep({ companyId: c.id, dryRun: false });
          if (result.actionsExecuted > 0) {
            logger.info(
              { companyId: c.id, actions: result.actionsExecuted, docKey: result.reportDocumentKey },
              "BOARD-JANITOR daily sweep completed",
            );
          }
        }
      } catch (err) {
        logger.error({ err }, "BOARD-JANITOR daily sweep failed");
      } finally {
        running = false;
      }
    })();

    input.track(work);
  };
}
