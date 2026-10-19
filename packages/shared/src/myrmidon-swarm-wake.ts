// myrmidon(1.6.5 F-26): SWARM wake guard — the settings block and wake-reason
// vocabulary shared by the "run only with a task" gate and the cooling window.
//
// Design 1.6.5 §3.7: an automatic wake whose context names no existing task
// must close `skipped` before the adapter (0 tokens), and a task that has not
// moved since its last failed run cools down exponentially (§4.3) instead of
// being woken every sweep. Both halves read one settings block,
// `general.swarm`, so the board can retune them in one place.
import { z } from "zod";

/** Settings key of the F-26 wake guard inside `general`. */
export const SWARM_SETTINGS_KEY = "swarm";

/**
 * Automatic wake reasons that must always name a task. `swarm_claim_queue` is
 * the queue-pending wake (`SWARM_CLAIM_WAKE_REASON` in myrmidon-swarm-claim.ts)
 * and `idle_pickup` the no-work wake (idle-pickup.ts); both are listed by the
 * objective alongside the F-26 additions. Other automatic reasons (comments,
 * monitors, retries, …) already carry their issue through different flows and
 * are intentionally untouched.
 */
export const TASKLESS_BLOCKED_WAKE_REASONS: ReadonlySet<string> = new Set([
  "swarm_matched",
  "swarm_claim_queue",
  "idle_pickup",
  "issue_assigned",
]);

export const SWARM_COOLDOWN_BASE_MIN_DEFAULT = 30;
export const SWARM_COOLDOWN_BASE_MIN_MIN = 1;
export const SWARM_COOLDOWN_BASE_MIN_MAX = 24 * 60;
export const SWARM_COOLDOWN_CEILING_HOURS_DEFAULT = 24;
export const SWARM_COOLDOWN_CEILING_HOURS_MIN = 1;
export const SWARM_COOLDOWN_CEILING_HOURS_MAX = 24 * 7;
export const SWARM_RUN_WITHOUT_TASK_GATE_DEFAULT = true;

export const swarmSettingsSchema = z
  .object({
    /** Gate automatic wakes that carry no task. Default true (design §3.7). */
    runWithoutTaskGate: z.boolean().optional(),
    /**
     * Base of the exponential cooling of a stale wake candidate, minutes
     * (design §4.3). Default 30.
     */
    cooldownBaseMin: z
      .number()
      .int()
      .min(SWARM_COOLDOWN_BASE_MIN_MIN)
      .max(SWARM_COOLDOWN_BASE_MIN_MAX)
      .optional(),
    /** Ceiling of one cooling period, hours. Default 24. */
    cooldownCeilingHours: z
      .number()
      .int()
      .min(SWARM_COOLDOWN_CEILING_HOURS_MIN)
      .max(SWARM_COOLDOWN_CEILING_HOURS_MAX)
      .optional(),
  })
  .strict();

export type SwarmSettings = z.infer<typeof swarmSettingsSchema>;

export const SWARM_SETTINGS_DEFAULTS: Required<SwarmSettings> = {
  runWithoutTaskGate: SWARM_RUN_WITHOUT_TASK_GATE_DEFAULT,
  cooldownBaseMin: SWARM_COOLDOWN_BASE_MIN_DEFAULT,
  cooldownCeilingHours: SWARM_COOLDOWN_CEILING_HOURS_DEFAULT,
};

/**
 * Layer a patch over the stored block over the defaults. Accepts `unknown` so
 * every caller can pass the raw jsonb column: anything unparseable degrades to
 * defaults rather than taking the wake path down (design §3.7 "прогон не должен
 * умирать из-за настроек").
 */
export function resolveSwarmSettings(
  stored?: unknown,
  patch?: Partial<SwarmSettings> | null,
): Required<SwarmSettings> {
  // `general.swarm` is shared with sibling blocks (T10 owns `scent`); the wake
  // schema is strict, so drop them before parsing instead of degrading to defaults.
  const own: Record<string, unknown> =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? { ...(stored as Record<string, unknown>) }
      : {};
  delete own.scent;
  const parsed = swarmSettingsSchema.safeParse(own);
  const base = parsed.success ? parsed.data : {};
  return swarmSettingsSchema.parse({
    ...SWARM_SETTINGS_DEFAULTS,
    ...base,
    ...(patch ?? {}),
  }) as Required<SwarmSettings>;
}

/**
 * Exponential cooling period after the `staleCount`-th stale automatic run of
 * a task, in milliseconds: base * 2^(n-1), clamped to the ceiling
 * (design §4.3). `staleCount` must be >= 1.
 */
export function swarmCoolingPeriodMs(
  staleCount: number,
  settings: Pick<SwarmSettings, "cooldownBaseMin" | "cooldownCeilingHours">,
): number {
  const baseMin = settings.cooldownBaseMin ?? SWARM_COOLDOWN_BASE_MIN_DEFAULT;
  const ceilingHours =
    settings.cooldownCeilingHours ?? SWARM_COOLDOWN_CEILING_HOURS_DEFAULT;
  const exponent = Math.max(0, Math.floor(staleCount) - 1);
  const minutes = baseMin * Math.pow(2, Math.min(exponent, 32));
  return Math.min(minutes, ceilingHours * 60) * 60_000;
}
