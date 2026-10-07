import { z } from "zod";

/**
 * Run admission limits that can be changed while the server runs
 * (myrmidon C0, RUNTIME-LIMITS).
 *
 * The values below cap how many agent runs this server process starts: its
 * own concurrency ceiling, the start rate per sliding minute (the start ramp),
 * the free memory it keeps for itself, how much memory one run is budgeted,
 * and the free memory of the HOST below which no new run starts (the bot
 * containers live on the host, outside the server cgroup). myrmidon
 * (1.6.5 RUN-ADMISSION) adds the host CPU ceiling: a new run starts only
 * while the host's 1-minute load average per core stays under
 * `maxHostLoadPercentPerCore` percent of one core — counted above the load the
 * host carries anyway (rc.2), so a host whose own services keep it busy is not
 * held shut. In the
 * deployment they come from the environment (`MYRMIDON_*`); this module also
 * stores them in `instance_settings.general.runLimits` so an operator can
 * change them from the API and the settings page without restarting the
 * server — a restart drops every run in flight.
 *
 * Precedence, per value, is decided here once and read from two places:
 *
 * - the stored settings value, when the key is present in `general.runLimits`;
 * - otherwise the environment variable, which stays the default for the first
 *   start on an instance that has never saved these settings;
 * - otherwise the built-in default: 300 MB for the per-run budget, 5 starts a
 *   minute for the start ramp, 15360 MB (15 GB) of free host memory, "off"
 *   for the concurrency ceiling and the server free-memory floor, 15 % of
 *   start slots for the per-agent start share.
 *
 * myrmidon(1.6.2 RUN-ADMISSION): the two values with an "on" default (the
 * start ramp and the host memory floor) read an unset, empty or unreadable
 * environment value as the default and `0`/`off` as "off", so an operator
 * can still switch them off from the environment. myrmidon(1.6.5
 * RUN-ADMISSION): the host CPU ceiling joins them with the same rule — an
 * unset or unreadable environment value means the default, `0`/`off` means
 * "no CPU ceiling". myrmidon(1.6.5 RUN-FAIRNESS): the per-agent start share
 * (`maxPerAgentStartSharePercent`) follows the same default-on rule.
 *
 * myrmidon(1.6.5 RUN-ADMISSION, rc.3): the decision moves from load average
 * to measured CPU utilisation. `maxHostCpuBusyPercent` caps the non-idle
 * share of all cores over a short /proc/stat sample window (default 90 on a
 * fresh environment), and the optional `maxHostCpuPsiSomeAvg10` caps the PSI
 * cpu pressure (`some avg10` of /proc/pressure/cpu) — the gate closes on
 * pressure only when the operator set it. Both thresholds are ABSOLUTE
 * percents of the whole CPU: CPU utilisation already measures real work, so
 * unlike the load average it needs no background subtraction. Backward
 * compatibility works the other way round than for the older optional keys:
 * a row saved before rc.3 leaves both keys ABSENT, and an absent key means
 * "off" — not the environment, not the default — so the row keeps deciding on
 * the load average exactly as it did (`maxHostLoadPercentPerCore` survives as
 * the fallback, deprecated). Only an instance that never saved limits takes
 * the environment value or the default. See `server/src/myrmidon/run-admission.ts`.
 *
 * `null` means "this cap is off" — the same meaning an unset, empty, zero,
 * negative or non-numeric environment value has today. A value is a positive
 * integer, so nothing here can turn a cap into "start one run anyway".
 *
 * The stored object is canonical: every key, caps null or a positive
 * integer. A row saved before a key existed (1.6.2 added
 * `minFreeHostMemoryMb`, 1.6.5 added `maxHostLoadPercentPerCore` and —
 * RUN-FAIRNESS — `maxPerAgentStartSharePercent`) is still
 * read: the missing key resolves from the environment or the default, and
 * the next save writes it.
 * `resolveRunLimits` accepts anything and falls back to the environment for a
 * value it cannot read, so a hand-edited row cannot make the server read a
 * limit it never validated.
 */

/** Environment variable per limit — the names the admission module reads. */
export const RUN_LIMITS_ENV_KEYS = {
  maxConcurrentRuns: "MYRMIDON_MAX_CONCURRENT_RUNS",
  maxStartsPerMinute: "MYRMIDON_MAX_RUN_STARTS_PER_MINUTE",
  minFreeMemoryMb: "MYRMIDON_MIN_FREE_MEMORY_MB",
  runMemoryEstimateMb: "MYRMIDON_RUN_MEMORY_ESTIMATE_MB",
  minFreeHostMemoryMb: "MYRMIDON_MIN_FREE_HOST_MEMORY_MB",
  // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling of run admission.
  maxHostLoadPercentPerCore: "MYRMIDON_MAX_HOST_LOAD_PERCENT_PER_CORE",
  // myrmidon(1.6.5 RUN-FAIRNESS): the per-agent share of start slots.
  maxPerAgentStartSharePercent: "MYRMIDON_MAX_PER_AGENT_START_SHARE_PERCENT",
  // myrmidon(1.6.5 RUN-ADMISSION, rc.3): the host CPU busy ceiling (the
  // non-idle share of all cores measured over a short /proc/stat window) and
  // the optional PSI cpu ceiling (some avg10 of /proc/pressure/cpu).
  maxHostCpuBusyPercent: "MYRMIDON_MAX_HOST_CPU_BUSY_PERCENT",
  maxHostCpuPsiSomeAvg10: "MYRMIDON_MAX_HOST_CPU_PSI_SOME_AVG10",
} as const;

/**
 * The keys reported per value in the settings sources and the audit
 * `changedKeys`. myrmidon(1.6.5 RUN-ADMISSION, rc.3): the two CPU-utilisation
 * keys live in every schema below but are deliberately NOT in this list yet:
 * the run-limits panels (ui/**) build exhaustive `Record<RunLimitKey, …>`
 * maps, and their fields are a separate change (part B). Adding a key here
 * without that UI breaks its typecheck; the stored row and the API carry the
 * values regardless.
 */
export const RUN_LIMIT_KEYS = [
  "maxConcurrentRuns",
  "maxStartsPerMinute",
  "minFreeMemoryMb",
  "runMemoryEstimateMb",
  "minFreeHostMemoryMb",
  "maxHostLoadPercentPerCore",
  "maxPerAgentStartSharePercent",
] as const;

export type RunLimitKey = (typeof RUN_LIMIT_KEYS)[number];

/**
 * Every stored key, including the two rc.3 CPU-utilisation keys that are not
 * in `RUN_LIMIT_KEYS` yet. The runtime-limits audit records `changedKeys`
 * over this list, so an operator's busy/PSI change is never silently missing
 * from the log; the settings-page source map stays on `RunLimitKey` until the
 * panels show the fields (myrmidon 1.6.5 rc.3, part B).
 */
export const RUN_LIMITS_PATCH_KEYS = [
  ...RUN_LIMIT_KEYS,
  "maxHostCpuBusyPercent",
  "maxHostCpuPsiSomeAvg10",
] as const;

/** Where an effective value came from: stored settings, the environment, or the default. */
export type RunLimitsSource = "settings" | "env" | "default";

/** Memory budgeted for one run when nothing says otherwise. */
export const DEFAULT_RUN_MEMORY_ESTIMATE_MB = 300;

/** myrmidon(1.6.2 RUN-ADMISSION): new runs started per sliding minute by default (the start ramp). */
export const DEFAULT_MAX_STARTS_PER_MINUTE = 5;

/** myrmidon(1.6.2 RUN-ADMISSION): free host memory below which no new run starts, by default (15 GB). */
export const DEFAULT_MIN_FREE_HOST_MEMORY_MB = 15_360;

/**
 * myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling by default — the 1-minute
 * load average per core must stay under 90 % of one core for a new run to
 * start. On the 05.10 incident the host ran load 95 on 16 cores (load per core
 * ~594 %) while its memory floor stayed open: 43 concurrent runs starved the
 * board's own API. A load-per-core reading has no meaningful zero ("load may
 * never be zero"), so the default is a percentage, and the cap is switched off
 * with `0`/`off` exactly like the other default-on caps.
 *
 * myrmidon(1.6.5 RUN-ADMISSION, rc.2): that 90 % is measured ABOVE the host's
 * own background load, not against a fixed reading. rc.1 compared the absolute
 * number, and a bot host whose background services (RAGFlow, hindsight,
 * Langfuse) hold 100–145 % of a core per core was held shut from the first
 * second: on 05.10 at 17:34 the fleet stood still with 4 runs going and 34
 * waiting, and the threshold had to be raised by hand to 200. The host is busy
 * for reasons the admission did not start and cannot stop, so the ceiling
 * counts the load the runs themselves add on top of the background the host
 * shows; see `server/src/myrmidon/run-admission.ts` for how that background is
 * learned. An instance that saved 200 while the ceiling was absolute keeps it,
 * and under the new rule it means two cores' worth of added load.
 */
export const DEFAULT_MAX_HOST_LOAD_PERCENT_PER_CORE = 90;

/**
 * myrmidon(1.6.5 RUN-FAIRNESS): the share of start slots of the global
 * ceiling one agent may take by default — 15 %. While the global concurrency
 * ceiling is busy, the queue pass admits the agent that asked earliest, not
 * the one that called `reserve` first, and no agent may hold more than this
 * share of the slots. A percentage has a meaningful zero ("no share at
 * all"), so unlike the other caps this value is bounded: 1..100, and `null`
 * switches the limit off ("any agent may take every free slot") — the same
 * default-on rule the start ramp and the host ceilings follow.
 */
export const DEFAULT_MAX_PER_AGENT_START_SHARE_PERCENT = 15;

/**
 * myrmidon(1.6.5 RUN-ADMISSION, rc.3): the host CPU busy ceiling by default —
 * the non-idle share of all cores (from the /proc/stat counters over a short
 * sample window) must stay under 90 % of the whole CPU for a new run to
 * start. It is an ABSOLUTE reading: CPU utilisation already measures real
 * work, so the background-floor arithmetic of the load average is not needed.
 * The default applies to an instance that never saved run limits; a row
 * saved before rc.3 keeps the load-average rule (its absent key means "off").
 * `0`/`off` switches the ceiling off like the other default-on caps.
 */
export const DEFAULT_MAX_HOST_CPU_BUSY_PERCENT = 90;

/** A cap: a positive integer, or null for "off". */
const runLimitCapSchema = z.number().int().positive().nullable();

/**
 * myrmidon(1.6.5 RUN-FAIRNESS): a share of the global ceiling, 1..100 %, or
 * null for "off". A separate schema, not runLimitCapSchema: a share over
 * 100 % is a nonsense value the other caps do not have to refuse.
 */
const runLimitSharePercentSchema = z.number().int().min(1).max(100).nullable();

/** The canonical stored shape of `instance_settings.general.runLimits`. */
export const runLimitsSchema = z
  .object({
    maxConcurrentRuns: runLimitCapSchema,
    maxStartsPerMinute: runLimitCapSchema,
    minFreeMemoryMb: runLimitCapSchema,
    runMemoryEstimateMb: z.number().int().positive(),
    minFreeHostMemoryMb: runLimitCapSchema,
    maxHostLoadPercentPerCore: runLimitCapSchema,
    maxPerAgentStartSharePercent: runLimitSharePercentSchema,
    // myrmidon(1.6.5 RUN-ADMISSION, rc.3): the CPU busy ceiling and the PSI
    // cpu ceiling. Optional on the canonical shape: a row saved before rc.3
    // carries neither, and an absent key is "off" — the old load-average rule
    // decides (see normalizeRunLimits). `null` means the operator switched
    // that cap off; a number means it decides on the measurement.
    maxHostCpuBusyPercent: runLimitCapSchema.optional(),
    maxHostCpuPsiSomeAvg10: runLimitCapSchema.optional(),
  })
  .strict();

/**
 * What a stored row may hold: the canonical shape, with the keys added after
 * the first release optional, so a row saved by an older server still counts
 * as stored (its missing keys resolve from the environment or the default).
 */
export const storedRunLimitsSchema = runLimitsSchema.extend({
  minFreeHostMemoryMb: runLimitCapSchema.optional(),
  // myrmidon(1.6.5 RUN-ADMISSION): a row saved before the CPU ceiling existed.
  maxHostLoadPercentPerCore: runLimitCapSchema.optional(),
  // myrmidon(1.6.5 RUN-FAIRNESS): a row saved before the start share existed.
  maxPerAgentStartSharePercent: runLimitSharePercentSchema.optional(),
  // myrmidon(1.6.5 RUN-ADMISSION, rc.3): both CPU-utilisation keys are
  // optional in the canonical shape already — a row saved before rc.3
  // carries neither and keeps the load-average rule.
});

/**
 * Body of `PATCH /api/myrmidon/runtime-limits`: any subset of the values.
 * Absent keys keep their effective value; `null` switches a cap off. The
 * per-run budget cannot be switched off — it is what the memory floor is
 * counted with.
 */
export const patchRunLimitsSchema = z
  .object({
    maxConcurrentRuns: runLimitCapSchema.optional(),
    maxStartsPerMinute: runLimitCapSchema.optional(),
    minFreeMemoryMb: runLimitCapSchema.optional(),
    runMemoryEstimateMb: z.number().int().positive().optional(),
    minFreeHostMemoryMb: runLimitCapSchema.optional(),
    // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling.
    maxHostLoadPercentPerCore: runLimitCapSchema.optional(),
    // myrmidon(1.6.5 RUN-FAIRNESS): the per-agent share of start slots.
    maxPerAgentStartSharePercent: runLimitSharePercentSchema.optional(),
    // myrmidon(1.6.5 RUN-ADMISSION, rc.3): the CPU busy ceiling and the PSI
    // cpu ceiling; `null` switches a cap off, absent keeps the effective value.
    maxHostCpuBusyPercent: runLimitCapSchema.optional(),
    maxHostCpuPsiSomeAvg10: runLimitCapSchema.optional(),
  })
  .strict();

export type RunLimits = z.infer<typeof runLimitsSchema>;
/** A stored `general.runLimits` row, possibly saved before a key existed. */
export type StoredRunLimits = z.infer<typeof storedRunLimitsSchema>;
export type RunLimitsPatch = z.infer<typeof patchRunLimitsSchema>;

export interface ResolvedRunLimits {
  limits: RunLimits;
  sources: Record<RunLimitKey, RunLimitsSource>;
}

/** An environment value as a limit: a positive integer, or null for "off". */
export function parseRunLimitValue(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

const RUN_LIMIT_OFF_WORDS = ["0", "off", "false", "no", "none"];

function isRunLimitOffWord(raw: string | undefined): boolean {
  const trimmed = raw?.trim().toLowerCase();
  return Boolean(trimmed) && RUN_LIMIT_OFF_WORDS.includes(trimmed!);
}

/**
 * myrmidon(1.6.2 RUN-ADMISSION): an environment value of a cap that is on by
 * default. `0`, `off`, `false`, `no` or `none` switch it off; a positive
 * integer is the value; unset, empty or anything else is the default, so a
 * typo never silently removes the protection.
 */
export function parseDefaultOnRunLimitValue(raw: string | undefined, fallback: number): number | null {
  if (isRunLimitOffWord(raw)) return null;
  return parseRunLimitValue(raw) ?? fallback;
}

/** True when the environment value is what the effective value comes from. */
function envDeclares(env: Record<string, string | undefined>, key: RunLimitKey): boolean {
  const raw = env[RUN_LIMITS_ENV_KEYS[key]];
  if (parseRunLimitValue(raw) !== null) return true;
  // A default-on cap switched off from the environment.
  return (
    (key === "maxStartsPerMinute" ||
      key === "minFreeHostMemoryMb" ||
      key === "maxHostLoadPercentPerCore" ||
      key === "maxPerAgentStartSharePercent") &&
    isRunLimitOffWord(raw)
  );
}

/** The limits as the environment declares them, with the built-in defaults. */
export function readRunLimitsFromEnv(env: Record<string, string | undefined> = {}): RunLimits {
  return {
    maxConcurrentRuns: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.maxConcurrentRuns]),
    maxStartsPerMinute: parseDefaultOnRunLimitValue(
      env[RUN_LIMITS_ENV_KEYS.maxStartsPerMinute],
      DEFAULT_MAX_STARTS_PER_MINUTE,
    ),
    minFreeMemoryMb: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.minFreeMemoryMb]),
    runMemoryEstimateMb:
      parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.runMemoryEstimateMb]) ?? DEFAULT_RUN_MEMORY_ESTIMATE_MB,
    minFreeHostMemoryMb: parseDefaultOnRunLimitValue(
      env[RUN_LIMITS_ENV_KEYS.minFreeHostMemoryMb],
      DEFAULT_MIN_FREE_HOST_MEMORY_MB,
    ),
    // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling, default-on.
    maxHostLoadPercentPerCore: parseDefaultOnRunLimitValue(
      env[RUN_LIMITS_ENV_KEYS.maxHostLoadPercentPerCore],
      DEFAULT_MAX_HOST_LOAD_PERCENT_PER_CORE,
    ),
    // myrmidon(1.6.5 RUN-FAIRNESS): the per-agent start share, default-on.
    maxPerAgentStartSharePercent: parseDefaultOnRunLimitValue(
      env[RUN_LIMITS_ENV_KEYS.maxPerAgentStartSharePercent],
      DEFAULT_MAX_PER_AGENT_START_SHARE_PERCENT,
    ),
    // myrmidon(1.6.5 RUN-ADMISSION, rc.3): the CPU busy ceiling — an
    // instance that never saved run limits decides on real CPU utilisation,
    // not load average. Default-on like the other caps: `0`/`off` switches it
    // off, a typo keeps the protection.
    maxHostCpuBusyPercent: parseDefaultOnRunLimitValue(
      env[RUN_LIMITS_ENV_KEYS.maxHostCpuBusyPercent],
      DEFAULT_MAX_HOST_CPU_BUSY_PERCENT,
    ),
    // The PSI cpu ceiling is default-off: the gate closes on pressure only
    // when the operator set a value; unset, empty or non-numeric means off.
    // `0`/`off` is "off" as well — it is the same result, so the ordinary
    // parse covers it.
    maxHostCpuPsiSomeAvg10: parseRunLimitValue(env[RUN_LIMITS_ENV_KEYS.maxHostCpuPsiSomeAvg10]),
  };
}

/**
 * The stored settings value, or null when the row holds nothing usable. Keys
 * an older row lacks come from `fallback` (the environment or the defaults).
 *
 * myrmidon(1.6.5 RUN-ADMISSION, rc.3): the two CPU-utilisation keys are the
 * exception — a row saved before rc.3 keeps them ABSENT, which the admission
 * reads as "the old load-average rule decides". Falling them back to the
 * environment or the default would change the rule under an operator who
 * already saved their limits, and a saved row must be the whole truth.
 */
export function normalizeRunLimits(raw: unknown, fallback: RunLimits = readRunLimitsFromEnv({})): RunLimits | null {
  const parsed = storedRunLimitsSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    ...parsed.data,
    // myrmidon(1.6.5 RUN-ADMISSION): a row saved before the host memory floor
    // or the load ceiling existed keeps the key absent, so the environment or
    // the built-in default still applies — those protections were never the
    // operator's choice to remove. The two rc.3 CPU-utilisation keys are the
    // opposite: absent must stay absent, because only the presence of one of
    // them switches the decision away from the load-average rule.
    minFreeHostMemoryMb:
      parsed.data.minFreeHostMemoryMb === undefined ? fallback.minFreeHostMemoryMb : parsed.data.minFreeHostMemoryMb,
    maxHostLoadPercentPerCore:
      parsed.data.maxHostLoadPercentPerCore === undefined
        ? fallback.maxHostLoadPercentPerCore
        : parsed.data.maxHostLoadPercentPerCore,
    // myrmidon(1.6.5 RUN-FAIRNESS): a row saved before the start share existed.
    maxPerAgentStartSharePercent:
      parsed.data.maxPerAgentStartSharePercent === undefined
        ? fallback.maxPerAgentStartSharePercent
        : parsed.data.maxPerAgentStartSharePercent,
  };
}

/**
 * Effective limits and where each one came from. `stored` is the raw
 * `general.runLimits` value; an unreadable one counts as absent, so the
 * environment (or the default) applies instead.
 */
export function resolveRunLimits(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedRunLimits {
  const env = options.env ?? {};
  const fromEnv = readRunLimitsFromEnv(env);
  const envSource = (key: RunLimitKey): RunLimitsSource => (envDeclares(env, key) ? "env" : "default");
  const stored = normalizeRunLimits(options.stored, fromEnv);
  if (stored) {
    const storedKeys =
      options.stored && typeof options.stored === "object" ? (options.stored as Record<string, unknown>) : {};
    const sources = {} as Record<RunLimitKey, RunLimitsSource>;
    for (const key of RUN_LIMIT_KEYS) {
      sources[key] = key in storedKeys ? "settings" : envSource(key);
    }
    return { limits: stored, sources };
  }
  const sources = {} as Record<RunLimitKey, RunLimitsSource>;
  for (const key of RUN_LIMIT_KEYS) sources[key] = envSource(key);
  return { limits: fromEnv, sources };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeRunLimits(base: RunLimits, patch: RunLimitsPatch): RunLimits {
  return {
    maxConcurrentRuns: patch.maxConcurrentRuns === undefined ? base.maxConcurrentRuns : patch.maxConcurrentRuns,
    maxStartsPerMinute:
      patch.maxStartsPerMinute === undefined ? base.maxStartsPerMinute : patch.maxStartsPerMinute,
    minFreeMemoryMb: patch.minFreeMemoryMb === undefined ? base.minFreeMemoryMb : patch.minFreeMemoryMb,
    runMemoryEstimateMb: patch.runMemoryEstimateMb ?? base.runMemoryEstimateMb,
    minFreeHostMemoryMb:
      patch.minFreeHostMemoryMb === undefined ? base.minFreeHostMemoryMb : patch.minFreeHostMemoryMb,
    // myrmidon(1.6.5 RUN-ADMISSION): the host CPU ceiling.
    maxHostLoadPercentPerCore:
      patch.maxHostLoadPercentPerCore === undefined
        ? base.maxHostLoadPercentPerCore
        : patch.maxHostLoadPercentPerCore,
    // myrmidon(1.6.5 RUN-FAIRNESS): the per-agent start share.
    maxPerAgentStartSharePercent:
      patch.maxPerAgentStartSharePercent === undefined
        ? base.maxPerAgentStartSharePercent
        : patch.maxPerAgentStartSharePercent,
    // myrmidon(1.6.5 RUN-ADMISSION, rc.3): the CPU busy ceiling and the PSI
    // cpu ceiling. An absent patch key keeps the effective value — including
    // "absent" for a row saved before rc.3, which keeps deciding on load
    // average until the operator sets a busy value explicitly.
    maxHostCpuBusyPercent:
      patch.maxHostCpuBusyPercent === undefined ? base.maxHostCpuBusyPercent : patch.maxHostCpuBusyPercent,
    maxHostCpuPsiSomeAvg10:
      patch.maxHostCpuPsiSomeAvg10 === undefined ? base.maxHostCpuPsiSomeAvg10 : patch.maxHostCpuPsiSomeAvg10,
  };
}