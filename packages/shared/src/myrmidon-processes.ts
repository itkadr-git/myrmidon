// Processes of the board (myrmidon PROCS-1.1, design OPE-5394 §7.2): how many
// board processes exist and what each of them is allowed to do. This file is
// the one place that names the key (`instance_settings.general.processes`),
// its values and its defaults, and it is shared by the server, the
// instance-settings validator and the settings page.
//
// `single` is the board as it runs today: one process serves the HTTP lane and
// does the background work. `split` is what the feature is for: the background
// work goes to one worker process, the HTTP lane to `apiCount` api processes.
// PROCS-1.1 stores and serves the key; the supervisor that acts on `split` is
// the next part of the same feature, so `describeProcessesEffect` reports a
// stored `split` as stored-but-not-in-effect instead of pretending the board
// already runs several processes.
import { z } from "zod";

/** The key inside the general instance settings: `general.processes`. */
export const PROCESSES_SETTINGS_KEY = "processes" as const;

/**
 * Design §7.2, the emergency escape: `PAPERCLIP_PROCESS_MODE=single` starts the
 * build "as before" even when the saved setting says otherwise. The process
 * reads it at startup, before the database, so a saved row that took the board
 * down cannot lock the operator out of the board that would fix it.
 */
export const PROCESSES_MODE_ENV = "PAPERCLIP_PROCESS_MODE" as const;

export const PROCESSES_MODES = ["single", "split"] as const;
export type ProcessesMode = (typeof PROCESSES_MODES)[number];

export const PROCESSES_LIVE_EVENT_BUSES = ["local", "pg"] as const;
export type ProcessesLiveEventsBus = (typeof PROCESSES_LIVE_EVENT_BUSES)[number];

export const PROCESSES_ADMISSION_STORES = ["memory", "db"] as const;
export type ProcessesAdmissionStore = (typeof PROCESSES_ADMISSION_STORES)[number];

/**
 * Design §7.2 gives `apiCount` the range 1..4; §7.3 recommends one worker plus
 * two api processes on the container's four cores and calls three api
 * processes the upper bound worth serving.
 */
export const PROCESSES_API_COUNT_MIN = 1;
export const PROCESSES_API_COUNT_MAX = 4;
export const PROCESSES_LEADER_LEASE_TTL_MIN_SEC = 5;
export const PROCESSES_LEADER_LEASE_TTL_MAX_SEC = 600;

export interface ProcessesSettings {
  /** `single` — one process does everything (today); `split` — worker plus api processes. */
  mode: ProcessesMode;
  /** How many api processes `split` should run. */
  apiCount: number;
  /** How long the leader lease of the background role stays valid. */
  leaderLeaseTtlSec: number;
  /** Where live events travel between the processes. */
  liveEventsBus: ProcessesLiveEventsBus;
  /** Where run admission is decided. */
  admissionStore: ProcessesAdmissionStore;
  /** Whether the process that is not the leader proxies single-process routes to it. */
  singletonProxy: boolean;
}

/**
 * The defaults are today's behaviour: one process, one api lane, in-memory
 * admission, the local event bus. An instance that never opens the settings
 * page keeps behaving exactly as it did before this key existed.
 */
export const DEFAULT_PROCESSES_SETTINGS: ProcessesSettings = {
  mode: "single",
  apiCount: 1,
  leaderLeaseTtlSec: 30,
  liveEventsBus: "local",
  admissionStore: "memory",
  singletonProxy: true,
};

/**
 * The stored shape. The enum values are written out rather than spread from
 * `PROCESSES_MODES` so the schema stays a fixed tuple; the shared test pins the
 * two together, so a new mode cannot be added to one and forgotten in the
 * other.
 */
export const processesSettingsSchema = z
  .object({
    mode: z.enum(["single", "split"]),
    apiCount: z.number().int().min(PROCESSES_API_COUNT_MIN).max(PROCESSES_API_COUNT_MAX),
    leaderLeaseTtlSec: z
      .number()
      .int()
      .min(PROCESSES_LEADER_LEASE_TTL_MIN_SEC)
      .max(PROCESSES_LEADER_LEASE_TTL_MAX_SEC),
    liveEventsBus: z.enum(["local", "pg"]),
    admissionStore: z.enum(["memory", "db"]),
    singletonProxy: z.boolean(),
  })
  .strict();

export type StoredProcessesSettings = z.infer<typeof processesSettingsSchema>;

/** What a PATCH may carry: any subset of the keys, nothing else. */
export const processesSettingsPatchSchema = processesSettingsSchema.partial();

export type ProcessesSettingsPatch = z.infer<typeof processesSettingsPatchSchema>;

export type ProcessesSettingKey = keyof ProcessesSettings;

/** Every key of the settings, in one place for iterating and for the view. */
export const PROCESSES_SETTING_KEYS = [
  "mode",
  "apiCount",
  "leaderLeaseTtlSec",
  "liveEventsBus",
  "admissionStore",
  "singletonProxy",
] as const satisfies readonly ProcessesSettingKey[];

/** Where the value in force came from: what is saved, the environment, or the default. */
export type ProcessesSettingSource = "settings" | "env" | "default";

export interface ResolvedProcessesSettings {
  settings: ProcessesSettings;
  sources: Record<ProcessesSettingKey, ProcessesSettingSource>;
}

/**
 * `PAPERCLIP_PROCESS_MODE` as a mode, or null when the variable is unset or
 * carries something that is not a mode (an empty variable, `all`, a typo): an
 * unreadable escape must not decide the mode of the board, so it is ignored
 * the same way an unset one is.
 */
export function parseProcessesModeEnv(raw: string | null | undefined): ProcessesMode | null {
  const value = (raw ?? "").trim().toLowerCase();
  if (!value) return null;
  return (PROCESSES_MODES as readonly string[]).includes(value) ? (value as ProcessesMode) : null;
}

/**
 * The ambient environment without naming `process`: the shared sources are
 * compiled by packages that do not pull in `@types/node` (the plugin-authoring
 * smoke example typechecks this file), so the lookup goes through `globalThis`
 * and answers an empty record where there is no process at all.
 */
function ambientProcessEnv(): Record<string, string | undefined> {
  const ambient = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return ambient?.env ?? {};
}

/**
 * The settings in force and how each one got there: a saved row beats the
 * built-in default, and `PAPERCLIP_PROCESS_MODE` beats both and is reported as
 * `env`, so the settings page can show a mode the operator cannot change from
 * the board while the emergency escape is set.
 */
export function resolveProcessesSettings(
  stored?: unknown,
  env?: Record<string, string | undefined>,
): ResolvedProcessesSettings {
  const parsed = processesSettingsSchema.partial().safeParse(stored ?? {});
  const saved = (parsed.success ? parsed.data : {}) as Record<string, unknown>;
  const settings: ProcessesSettings = { ...DEFAULT_PROCESSES_SETTINGS, ...saved };
  const sources = {} as Record<ProcessesSettingKey, ProcessesSettingSource>;
  for (const key of PROCESSES_SETTING_KEYS) {
    sources[key] = saved[key] === undefined ? "default" : "settings";
  }
  const forced = parseProcessesModeEnv((env ?? ambientProcessEnv())[PROCESSES_MODE_ENV]);
  if (forced) {
    settings.mode = forced;
    sources.mode = "env";
  }
  return { settings, sources };
}

/** `before` with the patch applied — the row that is about to be stored. */
export function mergeProcessesSettings(
  before: ProcessesSettings,
  patch: ProcessesSettingsPatch,
): ProcessesSettings {
  const next = { ...before } as Record<string, unknown>;
  for (const key of PROCESSES_SETTING_KEYS) {
    const value = (patch as Record<string, unknown>)[key];
    if (value !== undefined) next[key] = value;
  }
  return next as unknown as ProcessesSettings;
}

/**
 * PROCS-1.2 carries the process supervisor: the worker forks the api children,
 * they share :3100 with reusePort, and `drain` over IPC moves the board
 * between single and split without a container restart. The constant stays
 * declarative so a rollback build once again reports a stored split as not in
 * effect instead of silently serving it as single.
 */
export const PROCESSES_SUPERVISOR_IMPLEMENTED = true;

export const PROCESSES_SPLIT_UNSUPPORTED_REASON =
  "the saved settings ask for split, but this build has no process supervisor yet (PROCS-1.1): the process keeps serving the HTTP lane and doing the background work, and the board reports the stored mode as not in effect";

/** The mode this build actually honours, and why it differs from the saved one. */
export function describeProcessesEffect(settings: ProcessesSettings): {
  effectiveMode: ProcessesMode;
  notInEffectReason: string | null;
} {
  if (settings.mode === "single" || PROCESSES_SUPERVISOR_IMPLEMENTED) {
    return { effectiveMode: settings.mode, notInEffectReason: null };
  }
  return { effectiveMode: "single", notInEffectReason: PROCESSES_SPLIT_UNSUPPORTED_REASON };
}