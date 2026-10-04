import { z } from "zod";

/**
 * Bot draft-directory lifecycle settings (myrmidon BOT-DISK, part A).
 *
 * The maintenance-tick sweep reaps abandoned bot draft directories (the bot
 * `scratch` volume and clones in `workspace`; the `hermes` memory volume is
 * never touched) once they have been idle longer than `idleTtlMs`.
 *
 * Two values are stored in `instance_settings.general.botDisk`:
 *
 * - `enabled` — whether the sweep reaps at all;
 * - `idleTtlMs` — idle time after which a draft directory is reaped.
 *
 * The stored shape is lenient: every key is optional, unknown keys are kept,
 * and a value that does not validate is dropped (it then resolves from the
 * environment or the default) instead of failing the whole general block — a
 * strict miss there would make the next general write drop every setting.
 * Precedence, per key:
 *
 * - the stored settings value, when it validates;
 * - otherwise the environment variable (first-start default);
 * - otherwise the built-in default.
 *
 * The values apply live: the sweep re-reads them on every maintenance tick, so
 * a PATCH needs no restart.
 *
 * myrmidon(1.6.1-BOT-DISK-B): the same key also holds
 * `sharedPackageCachePath`, the host directory of the shared package cache of
 * development bots. It has no environment variable: absent means "no shared
 * cache". The local bot driver and the profile compiler re-read it on every
 * reconcile pass. It is not listed in `sources` (stored or absent, nothing
 * else).
 */

/** Environment variables — first-start defaults only. */
export const BOT_DISK_ENV_KEYS = {
  enabled: "MYRMIDON_BOT_DISK_LIFECYCLE_ENABLED",
  idleTtlMs: "MYRMIDON_BOT_DISK_IDLE_TTL_MS",
} as const;

export const BOT_DISK_SETTING_KEYS = ["enabled", "idleTtlMs"] as const;

export type BotDiskSettingKey = (typeof BOT_DISK_SETTING_KEYS)[number];

/** Where an effective value came from: stored settings, the environment, or the default. */
export type BotDiskSettingSource = "settings" | "env" | "default";

export const BOT_DISK_MIN_IDLE_TTL_MS = 5 * 60 * 1000;
export const BOT_DISK_MAX_IDLE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const BOT_DISK_DEFAULT_IDLE_TTL_MS = 6 * 60 * 60 * 1000;
export const BOT_DISK_DEFAULT_ENABLED = true;

/** Action of a settings change, written for every company like every instance settings write. */
export const BOT_DISK_UPDATED_ACTION = "instance.bot_disk.updated";

/**
 * Why `value` cannot be the shared package cache path, or null when it can: a
 * plain absolute directory — no relative form, no "." or ".." segment, no
 * empty segment, no trailing slash, no backslash or control character, not the
 * filesystem root. The bot driver applies the same rule to every bind source.
 */
export function botDiskCachePathProblem(value: string): string | null {
  if (!value.startsWith("/")) return "is not an absolute path";
  if (value.length === 1) return "is the filesystem root";
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return "contains a control character";
  }
  if (value.includes("\\")) return "contains a backslash";
  if (value.includes("//")) return "has an empty path segment";
  if (value.endsWith("/")) return "has a trailing slash";
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") return `has a "${segment}" path segment`;
  }
  return null;
}

const cachePathSchema = z
  .string()
  .max(4096)
  .superRefine((value, ctx) => {
    const problem = botDiskCachePathProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `sharedPackageCachePath ${problem}` });
  });

const idleTtlMsSchema = z
  .number()
  .int()
  .min(BOT_DISK_MIN_IDLE_TTL_MS)
  .max(BOT_DISK_MAX_IDLE_TTL_MS);

/** The canonical shape the service writes. */
export const botDiskSettingsSchema = z
  .object({
    enabled: z.boolean(),
    idleTtlMs: idleTtlMsSchema,
    // myrmidon(1.6.1-BOT-DISK-B): absent = no shared package cache.
    sharedPackageCachePath: cachePathSchema.optional(),
  })
  .strict();

const storedBotDiskObjectSchema = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    idleTtlMs: idleTtlMsSchema.optional().catch(undefined),
    sharedPackageCachePath: cachePathSchema.optional().catch(undefined),
  })
  .passthrough();

/**
 * What `general.botDisk` may hold: any object (missing or invalid keys resolve
 * from the environment or the default); a non-object value reads as absent.
 */
export const storedBotDiskSettingsSchema = storedBotDiskObjectSchema.optional().catch(undefined);

/** Body of `PATCH /api/myrmidon/bot-disk`. */
export const patchBotDiskSettingsSchema = z
  .object({
    enabled: z.boolean().optional(),
    idleTtlMs: idleTtlMsSchema.optional(),
    // myrmidon(1.6.1-BOT-DISK-B): a path sets the cache, null or "" turns it off.
    sharedPackageCachePath: z.union([cachePathSchema, z.literal(""), z.null()]).optional(),
  })
  .strict();

export type BotDiskSettings = z.infer<typeof botDiskSettingsSchema>;
export type StoredBotDiskSettings = z.infer<typeof storedBotDiskObjectSchema>;
export type BotDiskSettingsPatch = z.infer<typeof patchBotDiskSettingsSchema>;

export interface ResolvedBotDiskSettings {
  settings: BotDiskSettings;
  sources: Record<BotDiskSettingKey, BotDiskSettingSource>;
}

function parseEnabledEnv(raw: string | undefined): boolean | null {
  const value = raw?.trim().toLowerCase();
  if (!value) return null;
  if (["1", "true", "yes", "on"].includes(value)) return true;
  if (["0", "false", "no", "off"].includes(value)) return false;
  return null;
}

function parseIdleTtlEnv(raw: string | undefined): number | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const parsed = idleTtlMsSchema.safeParse(Number(trimmed));
  return parsed.success ? parsed.data : null;
}

/** The stored values that validate; absent or invalid keys are left out. */
export function normalizeStoredBotDiskSettings(raw: unknown): Partial<BotDiskSettings> {
  const parsed = storedBotDiskSettingsSchema.safeParse(raw);
  if (!parsed.success || !parsed.data) return {};
  const out: Partial<BotDiskSettings> = {};
  if (typeof parsed.data.enabled === "boolean") out.enabled = parsed.data.enabled;
  if (typeof parsed.data.idleTtlMs === "number") out.idleTtlMs = parsed.data.idleTtlMs;
  if (typeof parsed.data.sharedPackageCachePath === "string") {
    out.sharedPackageCachePath = parsed.data.sharedPackageCachePath;
  }
  return out;
}

/** Effective settings and where each value came from (see the module comment). */
export function resolveBotDiskSettings(options: {
  stored?: unknown;
  env?: Record<string, string | undefined>;
} = {}): ResolvedBotDiskSettings {
  const env = options.env ?? {};
  const stored = normalizeStoredBotDiskSettings(options.stored);

  const envEnabled = parseEnabledEnv(env[BOT_DISK_ENV_KEYS.enabled]);
  const envIdleTtl = parseIdleTtlEnv(env[BOT_DISK_ENV_KEYS.idleTtlMs]);

  const enabled: [boolean, BotDiskSettingSource] =
    stored.enabled !== undefined
      ? [stored.enabled, "settings"]
      : envEnabled !== null
        ? [envEnabled, "env"]
        : [BOT_DISK_DEFAULT_ENABLED, "default"];
  const idleTtlMs: [number, BotDiskSettingSource] =
    stored.idleTtlMs !== undefined
      ? [stored.idleTtlMs, "settings"]
      : envIdleTtl !== null
        ? [envIdleTtl, "env"]
        : [BOT_DISK_DEFAULT_IDLE_TTL_MS, "default"];

  return {
    settings: {
      enabled: enabled[0],
      idleTtlMs: idleTtlMs[0],
      ...(stored.sharedPackageCachePath ? { sharedPackageCachePath: stored.sharedPackageCachePath } : {}),
    },
    sources: { enabled: enabled[1], idleTtlMs: idleTtlMs[1] },
  };
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeBotDiskSettings(
  base: BotDiskSettings,
  patch: BotDiskSettingsPatch,
): BotDiskSettings {
  const sharedPackageCachePath =
    patch.sharedPackageCachePath === undefined ? base.sharedPackageCachePath : patch.sharedPackageCachePath || undefined;
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    idleTtlMs: patch.idleTtlMs === undefined ? base.idleTtlMs : patch.idleTtlMs,
    ...(sharedPackageCachePath ? { sharedPackageCachePath } : {}),
  };
}

/** The shared package cache path in force, from the stored `general.botDisk` (undefined: none). */
export function resolveSharedPackageCachePath(stored: unknown): string | undefined {
  return normalizeStoredBotDiskSettings(stored).sharedPackageCachePath;
}
