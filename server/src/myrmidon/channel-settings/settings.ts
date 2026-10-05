// server/src/myrmidon/channel-settings/settings.ts
//
// myrmidon(1.7-SETTINGS-TO-UI): the channel settings document — the Telegram
// bridge switches, the chat limits and the cross-channel numbers an operator
// changes from the interface instead of the deployment environment.
//
// One key, one resolved value. Per key the precedence is:
//   1. the environment — a set MYRMIDON_* variable is a forced override;
//   2. the stored document — `instance_settings.general.channelSettings`,
//      written from the settings screen;
//   3. the built-in default.
// Every key answers with { value, source, default, envName, overridden }, so
// the screen can say where a value came from and whether the deployment
// environment pins it. The source names are the ones the SETTINGS-TO-UI track
// agreed on: "ui" | "env" | "default".
//
// This resolver is deliberately self-contained: the shared behaviour-settings
// registry of the track (part A) is not in main yet. When that core lands this
// module becomes a thin adapter over it; the document below does not change.

/** Where a resolved value came from. */
export type SettingSource = "ui" | "env" | "default";

/** One resolved channel setting: the value in force, its source and its default. */
export interface ChannelSettingValue<T> {
  value: T;
  source: SettingSource;
  /** The built-in default: what the key falls back to when nothing is set. */
  default: T;
  /** The environment variable this key maps to. */
  envName: string;
  /** True when the environment pins the value; the screen shows it read-only. */
  overridden: boolean;
}

/** The effective channel settings the API (and later the screen) reads. */
export interface ChannelSettings {
  telegramDmConversations: ChannelSettingValue<string>;
  telegramDmStatus: ChannelSettingValue<boolean>;
  telegramSplitMaxParts: ChannelSettingValue<number>;
  telegramFileLimitBytes: ChannelSettingValue<number>;
  paperclipAttachmentMaxBytes: ChannelSettingValue<number>;
  chatCrossChannelMessages: ChannelSettingValue<number>;
  chatCrossChannelMessageChars: ChannelSettingValue<number>;
  chatCrossChannelTotalChars: ChannelSettingValue<number>;
  chatCrossChannelLookbackHours: ChannelSettingValue<number>;
  chatReconcileIntervalMs: ChannelSettingValue<number | null>;
  telegramApiBaseUrl: ChannelSettingValue<string | null>;
}

/** The keys the interface may change. `telegramApiBaseUrl` is deployment-only. */
export type ChannelSettingKey = Exclude<keyof ChannelSettings, "telegramApiBaseUrl">;

/** The keys the interface may change, in the order the screen lists them. */
export const CHANNEL_SETTING_KEYS: readonly ChannelSettingKey[] = [
  "telegramDmConversations",
  "telegramDmStatus",
  "telegramSplitMaxParts",
  "telegramFileLimitBytes",
  "paperclipAttachmentMaxBytes",
  "chatCrossChannelMessages",
  "chatCrossChannelMessageChars",
  "chatCrossChannelTotalChars",
  "chatCrossChannelLookbackHours",
  "chatReconcileIntervalMs",
];

/** A PATCH body: only the keys present are changed. */
export interface ChannelSettingsPatch {
  telegramDmConversations?: string;
  telegramDmStatus?: boolean;
  telegramSplitMaxParts?: number;
  telegramFileLimitBytes?: number;
  paperclipAttachmentMaxBytes?: number;
  chatCrossChannelMessages?: number;
  chatCrossChannelMessageChars?: number;
  chatCrossChannelTotalChars?: number;
  chatCrossChannelLookbackHours?: number;
  chatReconcileIntervalMs?: number | null;
}

/** The stored document, exactly as it sits under `instance_settings.general`. */
export interface ChannelSettingsDocument {
  channel?: Partial<Record<ChannelSettingKey, unknown>>;
}

// Environment names. The MYRMIDON_* spelling is fixed: the settings screen
// shows these names, and a deployment that keeps using the environment keeps
// working unchanged.
export const TELEGRAM_DM_CONVERSATIONS_ENV = "MYRMIDON_TELEGRAM_DM_CONVERSATIONS";
export const TELEGRAM_DM_STATUS_ENV = "MYRMIDON_TELEGRAM_DM_STATUS";
export const TELEGRAM_SPLIT_MAX_PARTS_ENV = "MYRMIDON_TELEGRAM_SPLIT_MAX_PARTS";
export const TELEGRAM_FILE_LIMIT_BYTES_ENV = "MYRMIDON_TELEGRAM_FILE_LIMIT_BYTES";
export const PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV = "PAPERCLIP_ATTACHMENT_MAX_BYTES";
export const CHAT_CROSS_CHANNEL_MESSAGES_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGES";
export const CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_MESSAGE_CHARS";
export const CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_TOTAL_CHARS";
export const CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV = "MYRMIDON_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS";
export const CHAT_RECONCILE_INTERVAL_MS_ENV = "MYRMIDON_CHAT_RECONCILE_INTERVAL_MS";
export const TELEGRAM_API_BASE_URL_ENV = "TELEGRAM_API_BASE_URL";

/** Environment variable of every key, the read-only deployment key included. */
export const CHANNEL_SETTING_ENV_NAMES: Readonly<
  Record<ChannelSettingKey | "telegramApiBaseUrl", string>
> = {
  telegramDmConversations: TELEGRAM_DM_CONVERSATIONS_ENV,
  telegramDmStatus: TELEGRAM_DM_STATUS_ENV,
  telegramSplitMaxParts: TELEGRAM_SPLIT_MAX_PARTS_ENV,
  telegramFileLimitBytes: TELEGRAM_FILE_LIMIT_BYTES_ENV,
  paperclipAttachmentMaxBytes: PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV,
  chatCrossChannelMessages: CHAT_CROSS_CHANNEL_MESSAGES_ENV,
  chatCrossChannelMessageChars: CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV,
  chatCrossChannelTotalChars: CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV,
  chatCrossChannelLookbackHours: CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV,
  chatReconcileIntervalMs: CHAT_RECONCILE_INTERVAL_MS_ENV,
  telegramApiBaseUrl: TELEGRAM_API_BASE_URL_ENV,
};

// Built-in defaults. The cross-channel numbers repeat the documented defaults
// of `readCrossChannelSettings`; the attachment ceiling repeats the single
// deployment ceiling of `attachment-types.ts`.
export const DEFAULT_TELEGRAM_DM_CONVERSATIONS = "";
export const DEFAULT_TELEGRAM_DM_STATUS = false;
export const DEFAULT_TELEGRAM_SPLIT_MAX_PARTS = 0;
export const DEFAULT_TELEGRAM_FILE_LIMIT_BYTES = 10 * 1024 * 1024;
export const DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES = 12;
export const DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS = 600;
export const DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS = 4000;
export const DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS = 168;
export const DEFAULT_CHAT_RECONCILE_INTERVAL_MS: number | null = null;
/** A stored value that counts as "set": present, and not an empty string. */
function isSet(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

/** "1"/"true"/"yes"/"on" (any case) is on; "0"/"false"/"no"/"off" is off. */
function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase();
    if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
    if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  }
  return fallback;
}

/** Integer >= 0; blank, malformed or negative falls back. */
function readNonNegativeInt(value: unknown, fallback: number): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 0) return fallback;
  return parsed;
}

/** Integer > 0; 0 means "not configured" and falls back. */
function readPositiveInt(value: unknown, fallback: number): number {
  const parsed = readNonNegativeInt(value, Number.NaN);
  return Number.isNaN(parsed) || parsed <= 0 ? fallback : parsed;
}

/** Integer > 0, or null — the "off" state of the reconcile interval. */
function readPositiveIntOrNull(value: unknown, _fallback: number | null): number | null {
  const parsed = readNonNegativeInt(value, Number.NaN);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

type Coerce<T> = (value: unknown, fallback: T) => T;

/** One key: environment first, then the stored value, then the default. */
function resolve<T>(
  stored: unknown,
  envRaw: string | undefined,
  envName: string,
  fallback: T,
  coerce: Coerce<T>,
): ChannelSettingValue<T> {
  if (envRaw !== undefined && envRaw.trim().length > 0) {
    return { value: coerce(envRaw, fallback), source: "env", default: fallback, envName, overridden: true };
  }
  if (isSet(stored)) {
    return { value: coerce(stored, fallback), source: "ui", default: fallback, envName, overridden: false };
  }
  return { value: fallback, source: "default", default: fallback, envName, overridden: false };
}

/**
 * The effective channel settings: environment, then the stored document, then
 * the built-in default, key by key. `env` is injectable so callers and tests
 * resolve against the same explicit environment.
 *
 * `telegramApiBaseUrl` is deployment-only (it points the bridge at a local Bot
 * API server): the environment answers for it, the screen never changes it.
 */
export function getEffectiveChannelSettings(
  stored: ChannelSettingsDocument | null = null,
  env: Record<string, string | undefined> = process.env,
): ChannelSettings {
  const block: Partial<Record<ChannelSettingKey, unknown>> = stored?.channel ?? {};
  const envRaw = (key: ChannelSettingKey | "telegramApiBaseUrl"): string | undefined =>
    env[CHANNEL_SETTING_ENV_NAMES[key]];
  const base = envRaw("telegramApiBaseUrl")?.trim() ?? "";

  return {
    telegramDmConversations: resolve(
      block.telegramDmConversations,
      envRaw("telegramDmConversations"),
      TELEGRAM_DM_CONVERSATIONS_ENV,
      DEFAULT_TELEGRAM_DM_CONVERSATIONS,
      readString,
    ),
    telegramDmStatus: resolve(
      block.telegramDmStatus,
      envRaw("telegramDmStatus"),
      TELEGRAM_DM_STATUS_ENV,
      DEFAULT_TELEGRAM_DM_STATUS,
      readBoolean,
    ),
    telegramSplitMaxParts: resolve(
      block.telegramSplitMaxParts,
      envRaw("telegramSplitMaxParts"),
      TELEGRAM_SPLIT_MAX_PARTS_ENV,
      DEFAULT_TELEGRAM_SPLIT_MAX_PARTS,
      readNonNegativeInt,
    ),
    telegramFileLimitBytes: resolve(
      block.telegramFileLimitBytes,
      envRaw("telegramFileLimitBytes"),
      TELEGRAM_FILE_LIMIT_BYTES_ENV,
      DEFAULT_TELEGRAM_FILE_LIMIT_BYTES,
      readPositiveInt,
    ),
    paperclipAttachmentMaxBytes: resolve(
      block.paperclipAttachmentMaxBytes,
      envRaw("paperclipAttachmentMaxBytes"),
      PAPERCLIP_ATTACHMENT_MAX_BYTES_ENV,
      DEFAULT_PAPERCLIP_ATTACHMENT_MAX_BYTES,
      readPositiveInt,
    ),
    chatCrossChannelMessages: resolve(
      block.chatCrossChannelMessages,
      envRaw("chatCrossChannelMessages"),
      CHAT_CROSS_CHANNEL_MESSAGES_ENV,
      DEFAULT_CHAT_CROSS_CHANNEL_MESSAGES,
      readNonNegativeInt,
    ),
    chatCrossChannelMessageChars: resolve(
      block.chatCrossChannelMessageChars,
      envRaw("chatCrossChannelMessageChars"),
      CHAT_CROSS_CHANNEL_MESSAGE_CHARS_ENV,
      DEFAULT_CHAT_CROSS_CHANNEL_MESSAGE_CHARS,
      readNonNegativeInt,
    ),
    chatCrossChannelTotalChars: resolve(
      block.chatCrossChannelTotalChars,
      envRaw("chatCrossChannelTotalChars"),
      CHAT_CROSS_CHANNEL_TOTAL_CHARS_ENV,
      DEFAULT_CHAT_CROSS_CHANNEL_TOTAL_CHARS,
      readNonNegativeInt,
    ),
    chatCrossChannelLookbackHours: resolve(
      block.chatCrossChannelLookbackHours,
      envRaw("chatCrossChannelLookbackHours"),
      CHAT_CROSS_CHANNEL_LOOKBACK_HOURS_ENV,
      DEFAULT_CHAT_CROSS_CHANNEL_LOOKBACK_HOURS,
      readNonNegativeInt,
    ),
    chatReconcileIntervalMs: resolve(
      block.chatReconcileIntervalMs,
      envRaw("chatReconcileIntervalMs"),
      CHAT_RECONCILE_INTERVAL_MS_ENV,
      DEFAULT_CHAT_RECONCILE_INTERVAL_MS,
      readPositiveIntOrNull,
    ),
    telegramApiBaseUrl: {
      value: base.length > 0 ? base : null,
      source: base.length > 0 ? "env" : "default",
      default: null,
      envName: TELEGRAM_API_BASE_URL_ENV,
      overridden: false,
    },
  };
}

/** Read the stored document out of an `instance_settings.general` block. */
export function readStoredChannelSettings(general: unknown): ChannelSettingsDocument {
  if (!isRecord(general)) return {};
  const raw = general.channelSettings;
  if (!isRecord(raw)) return {};
  const channel = raw.channel;
  if (!isRecord(channel)) return {};
  return { channel: channel as Partial<Record<ChannelSettingKey, unknown>> };
}

/** Apply a patch to the stored document and return the document to write. */
export function mergeChannelSettingsDocument(
  stored: ChannelSettingsDocument | null,
  patch: ChannelSettingsPatch,
): ChannelSettingsDocument {
  const block: Record<string, unknown> = { ...(stored?.channel ?? {}) };
  for (const [key, value] of Object.entries(patch)) block[key] = value;
  return { channel: block as Partial<Record<ChannelSettingKey, unknown>> };
}

/**
 * Validate a PATCH body. An unknown key or a value of the wrong type is
 * rejected with a message the route turns into a 400; a valid body comes back
 * as the patch to store.
 */
export function parseChannelSettingsPatch(input: unknown): ChannelSettingsPatch {
  if (!isRecord(input)) throw new Error("channel settings patch must be a JSON object");
  const patch = {} as ChannelSettingsPatch;
  const writable = patch as Record<string, unknown>;
  for (const [key, value] of Object.entries(input)) {
    if (!(CHANNEL_SETTING_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown channel setting: ${key}`);
    }
    const typed = key as ChannelSettingKey;
    if (typed === "telegramDmConversations") {
      if (typeof value !== "string") throw new Error("telegramDmConversations must be a string");
    } else if (typed === "telegramDmStatus") {
      if (typeof value !== "boolean") throw new Error("telegramDmStatus must be a boolean");
    } else if (typed === "chatReconcileIntervalMs") {
      if (value !== null && (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)) {
        throw new Error("chatReconcileIntervalMs must be a positive integer or null");
      }
    } else if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${typed} must be a non-negative integer`);
    }
    writable[typed] = value;
  }
  return patch;
}
