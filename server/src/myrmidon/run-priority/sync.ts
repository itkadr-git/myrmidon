// Cross-process propagation of the run priority settings. The in-force
// settings are process memory (state.ts), while the board runs as several
// processes: a save lands in one of them, so every process re-reads the stored
// row on `settings_changed` ("runPriority") and puts it in force. The row is
// the only carrier of state, the bus message only says "look again".

import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, instanceSettings, type Db } from "@myrmidon/db";
import type { RunPrioritySettings } from "@myrmidon/shared";
import { logger } from "../../middleware/logger.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import { RELEASE_FOCUS_DEFERRAL_CONTEXT_KEY } from "../../modules/run-dispatch/domain/wake-context.js";
import { applyCompanyReleaseFocus, applyRunPrioritySettings, companyReleaseFocusSnapshot, currentRunPrioritySettings, resolveRunPriority, type CompanyReleaseFocus } from "./state.js";

/** Load the company snapshots from the preserved behavior-settings area. */
export async function readCompanyReleaseFocus(db: Db): Promise<Map<string, CompanyReleaseFocus>> {
  const [row] = await db.select({ general: instanceSettings.general }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const area = row?.general?.behaviorSettingsByCompany;
  const result = new Map<string, CompanyReleaseFocus>();
  if (!area || typeof area !== "object" || Array.isArray(area)) return result;
  for (const [companyId, value] of Object.entries(area)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const focus = (value as Record<string, unknown>).releaseFocus;
    if (!focus || typeof focus !== "object" || Array.isArray(focus)) continue;
    const record = focus as Record<string, unknown>;
    if ((record.currentRelease === null || typeof record.currentRelease === "string") && typeof record.strictReleaseFocus === "boolean") {
      result.set(companyId, { currentRelease: record.currentRelease, strictReleaseFocus: record.strictReleaseFocus });
    }
  }
  return result;
}

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
        // Only a run parked BY the focus: its deferral key names the very due
        // time the gate wrote into scheduled_retry_at. A failed run's retry
        // copies the context (key included) but has its own due time, and a
        // real backoff must stay a backoff.
        sql`(${heartbeatRuns.contextSnapshot} -> ${RELEASE_FOCUS_DEFERRAL_CONTEXT_KEY}::text ->> 'dueAt') is not null
          and date_trunc('milliseconds', ((${heartbeatRuns.contextSnapshot} -> ${RELEASE_FOCUS_DEFERRAL_CONTEXT_KEY}::text ->> 'dueAt')::timestamptz))
            = date_trunc('milliseconds', ${heartbeatRuns.scheduledRetryAt})`,
      ),
    )
    .returning({ id: heartbeatRuns.id });
  return rows.length;
}

// Serialize refreshes so a slow earlier read cannot overwrite a newer snapshot.
let applyQueue: Promise<void> = Promise.resolve();

/** Re-read the stored row and put it in force in this process (the row, not a patch, is the truth). */
export function applyStoredRunPriority(db: Db): Promise<RunPrioritySettings> {
  const turn = applyQueue.then(async () => {
    const general = await instanceSettingsService(db).getGeneral();
    const next = resolveRunPriority(general.runPriority).settings;
    if (next.strictReleaseFocus && next.currentRelease?.trim()) {
      // Preserve legacy focus only when its owner is unambiguous. The atomic
      // update never replaces an explicit company setting, including opt-out.
      const legacyFocus = JSON.stringify({ currentRelease: next.currentRelease, strictReleaseFocus: true });
      await db.execute(sql`
        update instance_settings settings
        set general = jsonb_set(
          coalesce(settings.general, '{}'::jsonb), '{behaviorSettingsByCompany}',
          coalesce(settings.general -> 'behaviorSettingsByCompany', '{}'::jsonb) ||
            jsonb_build_object(owner.id::text,
              coalesce(settings.general -> 'behaviorSettingsByCompany' -> owner.id::text, '{}'::jsonb) ||
                jsonb_build_object('releaseFocus', ${legacyFocus}::jsonb)), true)
        from (select min(id::text)::uuid as id from companies having count(*) = 1) owner
        where settings.singleton_key = 'default'
          and not (coalesce(settings.general -> 'behaviorSettingsByCompany' -> owner.id::text, '{}'::jsonb) ? 'releaseFocus')
      `);
    }
    const focus = await readCompanyReleaseFocus(db);
    applyRunPrioritySettings(next);
    applyCompanyReleaseFocus(focus);
    return next;
  });
  applyQueue = turn.then(() => undefined, () => undefined);
  return turn;
}

/**
 * Re-read the stored settings, put them in force in this process and, when the
 * release focus changed, make the deferred runs due at once.
 */
export async function syncRunPriorityFromStore(db: Db): Promise<RunPrioritySettings> {
  const before = currentRunPrioritySettings();
  const beforeCompanies = companyReleaseFocusSnapshot();
  const next = await applyStoredRunPriority(db);
  const afterCompanies = companyReleaseFocusSnapshot();
  const companyFocusChanged = [...new Set([...beforeCompanies.keys(), ...afterCompanies.keys()])].some((id) => {
    const previous = beforeCompanies.get(id);
    const current = afterCompanies.get(id);
    return previous?.currentRelease !== current?.currentRelease || previous?.strictReleaseFocus !== current?.strictReleaseFocus;
  });
  if (releaseFocusChanged(before, next) || companyFocusChanged) {
    const advanced = await advanceFocusDeferredRuns(db);
    if (advanced > 0) logger.info({ advanced }, "release focus changed: deferred runs are due now");
  }
  return next;
}

export const RUN_PRIORITY_REFRESH_INTERVAL_MS = 3 * 60_000;

/**
 * A lost NOTIFY heals itself: every few minutes the process re-reads the stored
 * settings. The timer is unref'ed, it never keeps the process alive.
 */
export function startRunPriorityRefresh(
  db: Db,
  intervalMs: number = RUN_PRIORITY_REFRESH_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    syncRunPriorityFromStore(db).catch((err: unknown) => {
      logger.warn({ err }, "periodic run priority refresh failed");
    });
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
