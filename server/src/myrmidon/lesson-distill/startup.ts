// server/src/myrmidon/lesson-distill/startup.ts
//
// myrmidon(1.7 KNOWLEDGE-2.0 L-4): the sweep. One interval loop per server
// process, the foraging sweep's shape: started from server/src/index.ts, a
// no-op unless the distiller is enabled; each tick walks the active
// companies and runs one pass per company, never two at once. A failing
// company is logged and skipped — one broken memory service must not stop
// the rest.

import { logger } from "../../middleware/logger.js";
import type { Db } from "@myrmidonai/db";
import { createMemoryHindsightClient } from "../agent-memory/hindsight-client.js";
import { runLessonDistillPass, type LessonDistillPassResult } from "./service.js";
import { resolveLessonDistillSettings, type LessonDistillSettings } from "./settings.js";
import { listCompanyIds } from "./raw.js";

export interface LessonDistillSweepDeps {
  db: Db;
  /** The stored general settings row, read per tick (the memory card may change live). */
  readGeneral?: () => Promise<unknown>;
  env?: Record<string, string | undefined>;
  now?: () => Date;
}

interface SweepState {
  timer: NodeJS.Timeout | null;
  running: boolean;
  settings: LessonDistillSettings | null;
}

const sweep: SweepState = { timer: null, running: false, settings: null };

export function startLessonDistillSweep(deps: LessonDistillSweepDeps): void {
  const settings = resolveLessonDistillSettings(deps.env ?? process.env);
  if (!settings.enabled) return; // off until MYRMIDON_LESSON_DISTILL_ENABLED=1 — the default stays silent.
  if (sweep.timer) return; // one sweep per process.
  sweep.settings = settings;

  const tick = async () => {
    if (sweep.running) return;
    sweep.running = true;
    try {
      const storedGeneral = deps.readGeneral ? await deps.readGeneral() : undefined;
      const current = resolveLessonDistillSettings(deps.env ?? process.env, storedGeneral);
      if (!current.memoryBaseUrl) {
        logger.warn("lesson-distill: enabled but no memory service address (env or stored settings); tick skipped");
        return;
      }
      const companyIds = await listCompanyIds(deps.db);
      for (const companyId of companyIds) {
        try {
          const result = await runLessonDistillPass(
            {
              db: deps.db,
              client: (bankId) =>
                createMemoryHindsightClient(current.memoryBaseUrl, current.memoryApiKey ?? undefined),
              maxLessons: 500,
              repeatThreshold: current.repeatThreshold,
              windowMs: current.windowHours * 60 * 60 * 1000,
            },
            companyId,
          );
          logPass(companyId, result);
        } catch (err) {
          logger.warn({ companyId, err }, "lesson-distill: pass failed; company skipped");
        }
      }
    } catch (err) {
      logger.warn({ err }, "lesson-distill: sweep tick failed");
    } finally {
      sweep.running = false;
    }
  };

  const periodMs = Math.max(5, settings.periodMinutes) * 60 * 1000;
  void tick();
  sweep.timer = setInterval(() => void tick(), periodMs);
  sweep.timer.unref();
  logger.info({ periodMinutes: settings.periodMinutes }, "lesson-distill: sweep started");
}

export function stopLessonDistillSweep(): void {
  if (sweep.timer) {
    clearInterval(sweep.timer);
    sweep.timer = null;
  }
  sweep.running = false;
  sweep.settings = null;
}

function logPass(companyId: string, result: LessonDistillPassResult): void {
  if (result.suggestionsCreated === 0 && result.suggestionsRefreshed === 0 && result.lessonsSeen === 0) return;
  logger.info(
    {
      companyId,
      lessonsSeen: result.lessonsSeen,
      groupsFormed: result.groupsFormed,
      candidates: result.candidatesFound,
      created: result.suggestionsCreated,
      refreshed: result.suggestionsRefreshed,
    },
    "lesson-distill: pass complete",
  );
}
