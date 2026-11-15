// Cross-process propagation of the run priority settings. The in-force
// settings are process memory (state.ts), while the board runs as several
// processes: a save lands in one of them, so every process re-reads the stored
// row on `settings_changed` ("runPriority") and puts it in force. The row is
// the only carrier of state, the bus message only says "look again".

import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@myrmidon/db";
import type { RunPrioritySettings } from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { RELEASE_FOCUS_DEFERRAL_CONTEXT_KEY } from "../../modules/run-dispatch/domain/wake-context.js";
import { applyRunPrioritySettings, currentRunPrioritySettings, resolveRunPriority } from "./state.js";

/** The two settings that decide whether strict release focus holds a run. */
export function releaseFocusChanged(before: RunPrioritySettings, after: RunPrioritySettings): boolean {
  const release = (s: RunPrioritySettings) => (s.currentRelease ?? "").trim().toLowerCase();
  return release(before) !== release(after) || Boolean(before.strictReleaseFocus) !== Boolean(after.strictReleaseFocus);
}

/**
 * Runs parked by strict release focus wait on a recheck ladder (up to 30 min).
 * When the focus changes they are due now: the next promote sweep re-runs the
 * gate on them. Idempotent, so every process may call it.
 */
export async function advanceFocusDeferredRuns(db: Db, now: Date = new Date()): Promise<number> {
  const rows = await db
    .update(heartbeatRuns)
    .set({ scheduledRetryAt: now, updatedAt: now })
    .where(
      and(
        eq(heartbeatRuns.status, "scheduled_retry"),
        sql`${heartbeatRuns.contextSnapshot} -> ${RELEASE_FOCUS_DEFERRAL_CONTEXT_KEY}::text is not null`,
      ),
    )
    .returning({ id: heartbeatRuns.id });
  return rows.length;
}

/**
 * Re-read the stored settings, put them in force in this process and, when the
 * release focus changed, make the deferred runs due at once.
 */
export async function syncRunPriorityFromStore(db: Db): Promise<RunPrioritySettings> {
  const general = await instanceSettingsService(db).getGeneral();
  const next = resolveRunPriority(general.runPriority).settings;
  const before = currentRunPrioritySettings();
  applyRunPrioritySettings(next);
  if (releaseFocusChanged(before, next)) {
    const advanced = await advanceFocusDeferredRuns(db);
    if (advanced > 0) logger.info({ advanced }, "release focus changed: deferred runs are due now");
  }
  return next;
}
