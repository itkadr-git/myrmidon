// server/src/myrmidon/telegram-notify/settings.ts
//
// myrmidon(1.6.1-TG-NOTIFY-B): the settings contract of the parent track (part A
// owns the routes; this module holds the shape both the routes and the jobs
// share, so the server and later the UI use one contract). Fixed names — the
// parent's contract note: after the agreed version, changes are additive
// only, field names never change.
//
// All defaults are OFF. With the defaults the owner receives in Telegram
// only replies to his own messages and U2 decision cards (release 1.6.1
// criterion). Until part A merges, the default settings reader returns this
// document unchanged: every job reads it, sees `enabled: false`, and sends
// nothing.

/** channel ∈ "dm" | "topic" | "none". */
export type TelegramNotifyEscalationChannel = "dm" | "topic" | "none";

/** mode ∈ "only_on_owner_request" | "rarely" | "normal". */
export type TelegramNotifyProactivityMode =
  | "only_on_owner_request"
  | "rarely"
  | "normal";

export type TelegramNotifyDigestSection = "done" | "blocked" | "needs_decision" | "spend";

export interface TelegramNotifyDigestSettings {
  enabled: boolean;
  /** Send time "HH:MM" (UTC), the fixed default 09:00. */
  time: string;
  /** Telegram chat id the digest is published to; null = not configured. */
  chatId: string | null;
  /** Forum topic id inside that chat; null = the chat itself. */
  topicId: number | null;
  sections: TelegramNotifyDigestSection[];
}

export interface TelegramNotifyErrorsSettings {
  enabled: boolean;
  chatId: string | null;
  topicId: number | null;
  minSeverity: "error" | "warning";
  maxPerHour: number;
}
// myrmidon(OPE-3789): inbound topic routing settings for the Telegram
// myrmidon(TG-NOTIFY-D): inbound topic routing settings for the Telegram
// group-topics bridge (part D).
// Storage: instance settings `general.telegramNotify` (area key of the
// 1.6.1 TG-NOTIFY contract fixed in part A). Until part A merges its
// routes/validators, this module owns the minimal typed reader for the
// `inbound.{enabled, requireMention}` fields this part consumes, and the
// routes/contract stay with part A. Everything defaults to OFF: with no
// stored document a topic message never creates work.
// The document shape mirrors the part-A contract so both parts read the
// same row without a migration: a JSON object under the `telegramNotify`
// key of instance_settings.general, written by part A's PATCH route; part
// D only reads it.
import { eq, sql } from "drizzle-orm";
import { instanceSettings, type Db } from "@paperclipai/db";
/** An open instance-settings transaction handle (same pattern as the vendor settings service). */
type InstanceSettingsTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
// myrmidon(TG-NOTIFY-D): the shared contract of the settings document.
import {
  defaultTelegramNotifySettings,
  telegramNotifySettingsSchema,
  type TelegramNotifySettings,
} from "@paperclipai/shared";
export const TELEGRAM_NOTIFY_GENERAL_KEY = "telegramNotify";
/** The `inbound` sub-settings of the TG-NOTIFY contract (part D consumers). */
export interface TelegramNotifyInboundSettings {
  enabled: boolean;
  requireMention: boolean;
}

export interface TelegramNotifyEscalationsSettings {
  enabled: boolean;
  /** Re-send an unanswered agent question after this many hours. */
  hours: number;
  /** Where the re-send goes; "none" = do nothing. */
  channel: TelegramNotifyEscalationChannel;
  chatId: string | null;
  topicId: number | null;
}

export interface TelegramNotifyProactivitySettings {
  mode: TelegramNotifyProactivityMode;
  rarelyMaxPerDay: number;
}

export interface TelegramNotifySettings {
  digest: TelegramNotifyDigestSettings;
  errors: TelegramNotifyErrorsSettings;
  inbound: TelegramNotifyInboundSettings;
  escalations: TelegramNotifyEscalationsSettings;
  proactivity: TelegramNotifyProactivitySettings;
}

/** The all-off document: the exact defaults of the parent's GET contract. */
export function defaultTelegramNotifySettings(): TelegramNotifySettings {
  return {
    digest: {
      enabled: false,
      time: "09:00",
      chatId: null,
      topicId: null,
      sections: ["done", "blocked", "needs_decision", "spend"],
    },
    errors: {
      enabled: false,
      chatId: null,
      topicId: null,
      minSeverity: "error",
      maxPerHour: 10,
    },
    inbound: { enabled: false, requireMention: true },
    escalations: {
      enabled: false,
      hours: 24,
      channel: "none",
      chatId: null,
      topicId: null,
    },
    proactivity: { mode: "only_on_owner_request", rarelyMaxPerDay: 3 },
  };
}
export const DEFAULT_TELEGRAM_NOTIFY_INBOUND: TelegramNotifyInboundSettings = {
  enabled: false,
  requireMention: true,
};
const SINGLETON_KEY = "default";
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
/**
 * Parse a stored `telegramNotify.inbound` document, filling every absent or
 * invalid field with the safe (OFF) default. Tolerant by design: a partial
 * or hand-edited row must never turn inbound on by accident.
 */
export function parseTelegramNotifyInbound(
  raw: unknown,
): TelegramNotifyInboundSettings {
  if (!isRecord(raw)) return { ...DEFAULT_TELEGRAM_NOTIFY_INBOUND };
  const inbound = isRecord(raw.inbound) ? raw.inbound : {};
    enabled: inbound.enabled === true,
    requireMention:
      typeof inbound.requireMention === "boolean"
        ? inbound.requireMention
        : DEFAULT_TELEGRAM_NOTIFY_INBOUND.requireMention,
/** Read the persisted document key from instance settings (`null` if absent). */
export async function readTelegramNotifyDocument(
  db: Pick<Db, "select">,
): Promise<unknown> {
  const row = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.general?.[TELEGRAM_NOTIFY_GENERAL_KEY] ?? null;
/** Read the effective inbound settings (safe defaults when nothing is stored). */
export async function readTelegramNotifyInbound(
  db: Pick<Db, "select">,
): Promise<TelegramNotifyInboundSettings> {
  return parseTelegramNotifyInbound(await readTelegramNotifyDocument(db));
/** Parse a stored document into the full typed settings (defaults when invalid). */
export function parseTelegramNotifySettings(
  raw: unknown,
): TelegramNotifySettings {
  const parsed = telegramNotifySettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : defaultTelegramNotifySettings();
/**
 * Keep our key across vendor writes of instance_settings.general — the same
 * contract as the autonomy/maintenance/cloud-connector preserves.
 */
export function preserveTelegramNotifyGeneralKey(
  storedGeneral: unknown,
): Record<string, unknown> {
  if (typeof storedGeneral !== "object" || storedGeneral === null) return {};
  const value = (storedGeneral as Record<string, unknown>)[
    TELEGRAM_NOTIFY_GENERAL_KEY
  ];
  return value === undefined ? {} : { [TELEGRAM_NOTIFY_GENERAL_KEY]: value };
/**
 * Read-modify-write of the settings document under a row lock. Until part A's
 * PATCH route merges, this is the only writer (tests and the part-A route will
 * share it); the change callback returns the next document or null to keep the
 * stored value. The stored value is always schema-normalized.
 */
export async function mutateTelegramNotifySettings<T>(
  db: Db,
  change: (current: TelegramNotifySettings) => {
    next: TelegramNotifySettings | null;
    result: T;
  },
): Promise<{ doc: TelegramNotifySettings; result: T; changed: boolean }> {
  return db.transaction(async (tx: InstanceSettingsTransaction) => {
    await tx
      .insert(instanceSettings)
      .values({ singletonKey: SINGLETON_KEY, general: {}, experimental: {} })
      .onConflictDoNothing({ target: [instanceSettings.singletonKey] });
    const row = await tx
      .select({ id: instanceSettings.id, general: instanceSettings.general })
      .from(instanceSettings)
      .where(eq(instanceSettings.singletonKey, SINGLETON_KEY))
      .for("update")
      .then((rows) => rows[0]!);
    const current = parseTelegramNotifySettings(
      row.general?.[TELEGRAM_NOTIFY_GENERAL_KEY],
    );
    const { next, result } = change(current);
    if (!next) return { doc: current, result, changed: false };
    await tx
      .update(instanceSettings)
      .set({
        general: sql`jsonb_set(coalesce(${instanceSettings.general}, '{}'::jsonb), ${`{${TELEGRAM_NOTIFY_GENERAL_KEY}}`}::text[], ${JSON.stringify(next)}::jsonb, true)`,
      })
      .where(eq(instanceSettings.id, row.id));
    return { doc: next, result, changed: true };
  });
