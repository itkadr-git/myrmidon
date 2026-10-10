import { z } from "zod";

/**
 * Alert recovery: the runbook-driven owner task and the sustained-resolution
 * auto-close (myrmidon 1.6.6 MONITORING, part D).
 *
 * An alert (Zabbix / Alertmanager) that goes off becomes a task of the role
 * that owns the recovery, and the task carries the numbered recovery steps of
 * that trigger's runbook plus the link to the runbook document. The role walks
 * the steps and checks the metric. Two rules decide whether the alert is still
 * an open problem:
 *
 * - the alert must stay resolved for `holdMinutes` before the task closes by
 *   itself (a single flapping resolve does not close anything);
 * - a repeat of the same alert within `recurrenceWindowMinutes` lands in the
 *   same task — a new task only starts once the window has passed since the
 *   automatic close.
 *
 * Two values are stored in `instance_settings.general.alertRecovery`:
 *
 * - `holdMinutes` — how long the alert must stay resolved before the task
 *   closes by itself (default 10, 1..1440);
 * - `recurrenceWindowMinutes` — how long a repeat of the same alert still
 *   belongs to the same task (default 60, 1..10080);
 * - `owners` — optional per-trigger override of the role that owns the
 *   recovery (trigger key → role key).
 *
 * The runtime journal of alert → task records lives next to the settings row in
 * `instance_settings.general.alertRecoveryJournal` (a passthrough array, the
 * same shape `swarmClaimJournal` uses), so part D needs no migration. One
 * journal entry per alert identity, read and written by the alert-recovery
 * service; records whose task already closed are dropped once the recurrence
 * window has passed.
 *
 * Precedence per key is the three-level shape the other myrmidon settings use:
 * the stored value, otherwise the environment variable (first-start default),
 * otherwise the built-in default. The auto-close reads the row on every pass,
 * so a PATCH needs no restart.
 */

/** Environment variables — first-start defaults of the two knobs. */
export const ALERT_RECOVERY_ENV_KEYS = {
  holdMinutes: "MYRMIDON_ALERT_RECOVERY_HOLD_MINUTES",
  recurrenceWindowMinutes: "MYRMIDON_ALERT_RECOVERY_WINDOW_MINUTES",
} as const;

export const ALERT_RECOVERY_LIMIT_KEYS = ["holdMinutes", "recurrenceWindowMinutes"] as const;

export type AlertRecoveryLimitKey = (typeof ALERT_RECOVERY_LIMIT_KEYS)[number];

/** Where the effective value came from: stored settings, the environment, or the default. */
export type AlertRecoveryLimitSource = "settings" | "env" | "default";

/** Stored settings row: `instance_settings.general.alertRecovery`. */
export const ALERT_RECOVERY_SETTINGS_KEY = "alertRecovery";

/** Runtime journal row: `instance_settings.general.alertRecoveryJournal`. */
export const ALERT_RECOVERY_JOURNAL_KEY = "alertRecoveryJournal";

/** Action of a settings change, written for every company like every instance settings write. */
export const ALERT_RECOVERY_UPDATED_ACTION = "instance.alert_recovery.updated";

/**
 * Origin kind of a task opened by an alert. The module only ever writes back to
 * tasks carrying it, so a task a person has taken over is never overruled by
 * the sweep.
 */
export const ALERT_RECOVERY_ORIGIN_KIND = "alert_recovery";

/** Built-in hold: the alert must stay resolved for 10 minutes before the task closes. */
export const ALERT_RECOVERY_HOLD_MINUTES_DEFAULT = 10;

/** A hold shorter than a minute would close a task on one flapping poll. */
export const ALERT_RECOVERY_HOLD_MINUTES_MIN = 1;

/** A hold longer than a day turns the automatic close into a manual chore. */
export const ALERT_RECOVERY_HOLD_MINUTES_MAX = 1440;

/** Built-in recurrence window: a repeat within an hour reopens the same task. */
export const ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT = 60;

export const ALERT_RECOVERY_WINDOW_MINUTES_MIN = 1;

/** A window longer than a week belongs to the alert source's own grouping, not here. */
export const ALERT_RECOVERY_WINDOW_MINUTES_MAX = 10080;

/** States of a record: the alert fires, the alert resolved and waits out the hold, the task is closed. */
export const ALERT_RECOVERY_STATES = ["open", "awaiting-close", "closed"] as const;

export type AlertRecoveryState = (typeof ALERT_RECOVERY_STATES)[number];

const holdMinutesSchema = z
  .number()
  .int()
  .min(ALERT_RECOVERY_HOLD_MINUTES_MIN)
  .max(ALERT_RECOVERY_HOLD_MINUTES_MAX);

const recurrenceWindowMinutesSchema = z
  .number()
  .int()
  .min(ALERT_RECOVERY_WINDOW_MINUTES_MIN)
  .max(ALERT_RECOVERY_WINDOW_MINUTES_MAX);

/** Trigger key (lowercase) → role key that owns the recovery instead of the runbook's own role. */
const ownersSchema = z.record(z.string(), z.string().min(1));

/** The canonical stored shape of `instance_settings.general.alertRecovery`. */
export const alertRecoverySettingsSchema = z
  .object({
    holdMinutes: holdMinutesSchema,
    recurrenceWindowMinutes: recurrenceWindowMinutesSchema,
    owners: ownersSchema.default({}),
  })
  .strict();

/** Lenient read of the same row: a broken or hand-edited value reads as absent. */
export const storedAlertRecoverySettingsSchema = z
  .object({
    holdMinutes: holdMinutesSchema.optional(),
    recurrenceWindowMinutes: recurrenceWindowMinutesSchema.optional(),
    owners: ownersSchema.optional(),
  })
  .loose();

/** Body of `PATCH /api/myrmidon/monitoring/alert-recovery`. */
export const patchAlertRecoverySettingsSchema = z
  .object({
    holdMinutes: holdMinutesSchema.optional(),
    recurrenceWindowMinutes: recurrenceWindowMinutesSchema.optional(),
    owners: ownersSchema.optional(),
  })
  .strict();

export type AlertRecoverySettings = z.infer<typeof alertRecoverySettingsSchema>;
export type StoredAlertRecoverySettings = z.infer<typeof storedAlertRecoverySettingsSchema>;
export type AlertRecoverySettingsPatch = z.infer<typeof patchAlertRecoverySettingsSchema>;

export interface ResolvedAlertRecoverySettings {
  settings: AlertRecoverySettings;
  sources: Record<AlertRecoveryLimitKey, AlertRecoveryLimitSource>;
}

/** A stored value as a knob; a non-integer or out-of-range value is ignored. */
export function alertRecoverySettingValue(raw: unknown, key: AlertRecoveryLimitKey): number | null {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return null;
  const parsed = (key === "holdMinutes" ? holdMinutesSchema : recurrenceWindowMinutesSchema).safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** An environment value as a knob; a non-integer, empty or out-of-range value is ignored. */
export function alertRecoveryEnvValue(
  raw: string | undefined,
  key: AlertRecoveryLimitKey,
): number | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^-?\d+$/.test(trimmed)) return null;
  return alertRecoverySettingValue(Number.parseInt(trimmed, 10), key);
}

/**
 * The knobs in force: the stored row wins per key, then the environment, then
 * the built-in default — with the winning layer named per key.
 */
export function resolveAlertRecoverySettings(input: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
}): ResolvedAlertRecoverySettings {
  const env = input.env ?? {};
  const parsedStored = storedAlertRecoverySettingsSchema.safeParse(input.stored ?? {});
  const stored: StoredAlertRecoverySettings = parsedStored.success ? parsedStored.data : {};
  const defaults: Record<AlertRecoveryLimitKey, number> = {
    holdMinutes: ALERT_RECOVERY_HOLD_MINUTES_DEFAULT,
    recurrenceWindowMinutes: ALERT_RECOVERY_WINDOW_MINUTES_DEFAULT,
  };
  const sources = {} as Record<AlertRecoveryLimitKey, AlertRecoveryLimitSource>;
  const values = {} as Record<AlertRecoveryLimitKey, number>;
  for (const key of ALERT_RECOVERY_LIMIT_KEYS) {
    const fromSettings = alertRecoverySettingValue(stored[key], key);
    if (fromSettings !== null) {
      values[key] = fromSettings;
      sources[key] = "settings";
      continue;
    }
    const fromEnv = alertRecoveryEnvValue(env[ALERT_RECOVERY_ENV_KEYS[key]], key);
    if (fromEnv !== null) {
      values[key] = fromEnv;
      sources[key] = "env";
      continue;
    }
    values[key] = defaults[key];
    sources[key] = "default";
  }
  return {
    settings: {
      holdMinutes: values.holdMinutes,
      recurrenceWindowMinutes: values.recurrenceWindowMinutes,
      owners: stored.owners ?? {},
    },
    sources,
  };
}

/** Apply a patch over the resolved settings: only the keys the operator sent change. */
export function mergeAlertRecoverySettings(
  current: AlertRecoverySettings,
  patch: AlertRecoverySettingsPatch,
): AlertRecoverySettings {
  return {
    holdMinutes: patch.holdMinutes ?? current.holdMinutes,
    recurrenceWindowMinutes: patch.recurrenceWindowMinutes ?? current.recurrenceWindowMinutes,
    owners: { ...current.owners, ...(patch.owners ?? {}) },
  };
}

/**
 * One journal entry per alert identity: the task the alert opened, the runbook
 * it used, and how long the alert has been resolved. Written by the service,
 * read back leniently — a hand-edited row is dropped, never trusted.
 */
export interface AlertRecoveryRecord {
  companyId: string;
  /** Alert identity: source + trigger + the hosts the alert covers. */
  identity: string;
  source: string;
  trigger: string;
  runbookKey: string;
  ownerRole: string;
  issueId: string;
  issueIdentifier: string | null;
  state: AlertRecoveryState;
  /** How many firing events this task has seen, the first one included. */
  firedCount: number;
  firstFiredAt: string;
  lastFiredAt: string;
  resolvedAt: string | null;
  closedAt: string | null;
}

export const alertRecoveryRecordSchema = z
  .object({
    companyId: z.string().min(1),
    identity: z.string().min(1),
    source: z.string().min(1),
    trigger: z.string().min(1),
    runbookKey: z.string().min(1),
    ownerRole: z.string().min(1),
    issueId: z.string().min(1),
    issueIdentifier: z.string().nullable().default(null),
    state: z.enum(ALERT_RECOVERY_STATES),
    firedCount: z.number().int().min(1),
    firstFiredAt: z.string().min(1),
    lastFiredAt: z.string().min(1),
    resolvedAt: z.string().nullable().default(null),
    closedAt: z.string().nullable().default(null),
  })
  .loose();

/** The journal as the service reads it: valid entries only, broken rows dropped. */
export function coerceAlertRecoveryRecords(raw: unknown): AlertRecoveryRecord[] {
  if (!Array.isArray(raw)) return [];
  const records: AlertRecoveryRecord[] = [];
  for (const entry of raw) {
    const parsed = alertRecoveryRecordSchema.safeParse(entry);
    if (parsed.success) records.push(parsed.data);
  }
  return records;
}

/**
 * One normalized alert event: the body of
 * `POST /api/myrmidon/monitoring/alert-recovery/events`, and the shape the
 * Zabbix / Alertmanager intake normalizes an alert into before it reaches the
 * service.
 */
export const alertRecoveryEventSchema = z
  .object({
    companyId: z.string().min(1),
    source: z.string().trim().min(1).max(64),
    trigger: z.string().trim().min(1).max(200),
    status: z.enum(["firing", "resolved"]),
    severity: z.string().trim().max(64).nullish(),
    summary: z.string().trim().max(2000).nullish(),
    hosts: z.array(z.string().trim().min(1).max(200)).max(50).nullish(),
    happenedAt: z.string().datetime({ offset: false }),
    url: z.string().trim().max(2000).nullish(),
  })
  .strict();

export type AlertRecoveryEventInput = z.infer<typeof alertRecoveryEventSchema>;

/** Trigger keys are compared case-insensitively and without runs of whitespace. */
export function normalizeAlertTrigger(trigger: string): string {
  return trigger.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Host names of an alert, normalized and ordered, so the identity is stable. */
export function normalizeAlertHosts(hosts: readonly string[] | null | undefined): string[] {
  if (!hosts?.length) return [];
  const seen = new Set<string>();
  for (const host of hosts) {
    const normalized = host.trim().toLowerCase();
    if (normalized) seen.add(normalized);
  }
  return [...seen].sort();
}

/**
 * Identity of an alert: the source, the trigger and the hosts it covers. Two
 * hosts firing the same trigger are two problems with two tasks; the same
 * trigger on the same host repeatedly is one problem with one task.
 */
export function alertRecoveryIdentity(input: {
  source: string;
  trigger: string;
  hosts?: readonly string[] | null;
}): string {
  const source = input.source.trim().toLowerCase() || "unknown";
  const trigger = normalizeAlertTrigger(input.trigger) || "unknown";
  const hosts = normalizeAlertHosts(input.hosts);
  return hosts.length ? `${source}:${trigger}:${hosts.join(",")}` : `${source}:${trigger}`;
}

/** The task of a resolved alert closes once the alert has stayed resolved that long. */
export function isAlertRecoveryCloseDue(
  record: Pick<AlertRecoveryRecord, "state" | "resolvedAt">,
  now: Date,
  holdMinutes: number,
): boolean {
  if (record.state !== "awaiting-close" || !record.resolvedAt) return false;
  const resolvedAt = Date.parse(record.resolvedAt);
  if (Number.isNaN(resolvedAt)) return false;
  return now.getTime() - resolvedAt >= holdMinutes * 60 * 1000;
}

/**
 * The journal after a pass: records whose task closed and whose recurrence
 * window has passed are dropped — a repeat after that starts a new task, so
 * nothing is lost by forgetting them.
 */
export function pruneAlertRecoveryRecords(
  records: readonly AlertRecoveryRecord[],
  now: Date,
  recurrenceWindowMinutes: number,
): AlertRecoveryRecord[] {
  const windowMs = recurrenceWindowMinutes * 60 * 1000;
  return records.filter((record) => {
    if (record.state !== "closed" || !record.closedAt) return true;
    const closedAt = Date.parse(record.closedAt);
    if (Number.isNaN(closedAt)) return true;
    return now.getTime() - closedAt < windowMs;
  });
}

/** A repeat still belongs to the closed task while the window has not passed. */
export function isAlertRecoveryRecurrence(
  record: Pick<AlertRecoveryRecord, "state" | "closedAt">,
  now: Date,
  recurrenceWindowMinutes: number,
): boolean {
  if (record.state !== "closed" || !record.closedAt) return false;
  const closedAt = Date.parse(record.closedAt);
  if (Number.isNaN(closedAt)) return false;
  return now.getTime() - closedAt < recurrenceWindowMinutes * 60 * 1000;
}