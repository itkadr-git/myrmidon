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
 *
 * myrmidon(1.6.2-BOT-DISK-C): three more keys, stored or absent like the cache
 * path (no environment variable; absent means the built-in default, see
 * {@link resolveBotDiskLayout}):
 *
 * - `gitMirrorRepos` — `owner/repo` names the board keeps a bare mirror of
 *   under `<sharedPackageCachePath>/git`; bots mount that directory read-only
 *   at `/cache/git` and clone with `--reference-if-able`, so the objects live
 *   once on the host. Empty or absent: no mirrors and no `/cache/git` mount;
 * - `gitMirrorRefreshMs` — how often the board fetches each mirror;
 * - `pnpmStoreDir` — where pnpm keeps its content-addressed store (default, since
 *   1.6.5-BOT-DISK-H8a: `/cache/pnpm-store`, one per partition, bound read-write
 *   to every bot of `sharedCacheRoles`; a path inside the bot's own tree is a
 *   store per bot and draws a warning). Never `/cache/pnpm`: that is the
 *   download cache;
 * - `pnpmImportMethod` — how pnpm puts a package into a clone: `clone` (the
 *   default, a reflink; strictly, a refused reflink fails loudly) or `copy` (an
 *   explicit opt-out). `clone-or-copy` and `hardlink` are refused; stored by an
 *   earlier release they read as `clone`.
 *
 * myrmidon(BOT-DISK-D): the three binds of a bot container became ONE mount (the
 * bot's whole tree), which is what makes hard links possible at all; the former
 * `pnpmStore: "workspace" | "shared"` key is gone (a stored value is ignored).
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

/**
 * myrmidon(1.6.5-BOT-DISK-H11): {@link botDiskCachePathProblem} under its own
 * name for the shared bot runtime root — the same rule (a plain, unambiguous
 * absolute host directory), so the message a caller sees names the key it came
 * from instead of the cache path.
 */
export function botDiskRuntimePathProblem(value: string): string | null {
  return botDiskCachePathProblem(value);
}

const botRuntimePathSchema = z
  .string()
  .max(4096)
  .superRefine((value, ctx) => {
    const problem = botDiskRuntimePathProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `sharedBotRuntimePath ${problem}` });
  });

/**
 * myrmidon(BOT-DISK-D): where the pnpm store lives and how pnpm imports (see the module comment).
 *
 * myrmidon(1.6.5-BOT-DISK-H8a): the default store is ONE per partition,
 * `/cache/pnpm-store` (host `<sharedPackageCachePath>/pnpm-store`, bound
 * read-write to every bot of `sharedCacheRoles`), and the import method is
 * `clone` (a reflink: a copy-on-write copy that shares the store's blocks, so a
 * write to a file in node_modules never reaches the store). It is `clone`
 * strictly: pnpm's `clone-or-copy` copies silently where the reflink is
 * refused, which is exactly the failure this setting exists to make loud. A
 * reflink only works inside ONE filesystem, so the store has to be on the same
 * partition as the bot volumes.
 */
export const BOT_DISK_DEFAULT_PNPM_STORE_DIR = "/cache/pnpm-store";
/** The per-bot store of 1.6.4 and earlier: a stored value equal to it is migrated to the default. */
export const BOT_DISK_LEGACY_PNPM_STORE_DIR = "/workspace/.pnpm-store";
/** `copy` is the explicit opt-out (a full copy per clone); `clone` is the default. */
export const BOT_DISK_PNPM_IMPORT_METHODS = ["clone", "copy"] as const;
export type BotDiskPnpmImportMethod = (typeof BOT_DISK_PNPM_IMPORT_METHODS)[number];
export const BOT_DISK_DEFAULT_PNPM_IMPORT_METHOD: BotDiskPnpmImportMethod = "clone";
/** Methods an earlier release accepted and stored; they read back as `clone` (see {@link migrateBotDiskPnpm}). */
export const BOT_DISK_LEGACY_PNPM_IMPORT_METHODS = ["hardlink", "clone-or-copy"] as const;
/** The shared per-partition store mount inside a bot container. */
export const BOT_DISK_SHARED_PNPM_STORE_DIR = BOT_DISK_DEFAULT_PNPM_STORE_DIR;
/** Container roots of the bot's own tree: a store there is per bot, not shared. */
export const BOT_DISK_PNPM_STORE_ROOTS = ["/workspace", "/data", "/scratch", "/bot"] as const;

/**
 * Why `value` cannot be the pnpm store directory, or null when it can: a plain
 * absolute path (the cache-path rules) strictly under one of
 * {@link BOT_DISK_PNPM_STORE_ROOTS}, or the shared store mount
 * {@link BOT_DISK_SHARED_PNPM_STORE_DIR} itself or something under it. A store
 * anywhere else is on another filesystem than the clones, so a reflink (and a
 * hard link) fails.
 */
export function botDiskPnpmStoreDirProblem(value: string): string | null {
  const plain = botDiskCachePathProblem(value);
  if (plain) return plain;
  if (value === BOT_DISK_SHARED_PNPM_STORE_DIR || value.startsWith(`${BOT_DISK_SHARED_PNPM_STORE_DIR}/`)) return null;
  if (!BOT_DISK_PNPM_STORE_ROOTS.some((root) => value.startsWith(`${root}/`))) {
    return `must be ${BOT_DISK_SHARED_PNPM_STORE_DIR} (the store shared by the partition) or inside the bot's own tree (under ${BOT_DISK_PNPM_STORE_ROOTS.join(", ")}): any other path is on another filesystem than the clones`;
  }
  return null;
}

/**
 * A warning (not an error) for a store that is allowed but defeats the point:
 * one inside the bot's own tree is a store PER BOT — no sharing between bots,
 * counted against that bot's quota. Null for the shared store.
 */
export function botDiskPnpmStoreDirWarning(value: string): string | null {
  if (botDiskPnpmStoreDirProblem(value) !== null) return null;
  if (BOT_DISK_PNPM_STORE_ROOTS.some((root) => value.startsWith(`${root}/`))) {
    return `pnpmStoreDir ${value} is inside the bot's own tree: a store per bot, not shared and counted in the bot's quota; the shared store is ${BOT_DISK_SHARED_PNPM_STORE_DIR}`;
  }
  return null;
}

/**
 * Why `value` cannot be the pnpm import method, or null when it can: `clone` or
 * `copy`. `clone-or-copy` is refused on purpose (it copies silently when the
 * reflink is refused), `hardlink` cannot cross the bind mounts of the shared store.
 */
export function botDiskPnpmImportMethodProblem(value: string): string | null {
  if ((BOT_DISK_PNPM_IMPORT_METHODS as readonly string[]).includes(value)) return null;
  if (value === "clone-or-copy") {
    return "clone-or-copy is not allowed: pnpm would copy silently where a reflink is refused; use clone (a refused reflink then fails loudly) or copy (an explicit full copy)";
  }
  if (value === "hardlink") {
    return "hardlink is not allowed: a hard link cannot cross the bind mounts of the shared store; use clone";
  }
  return `must be one of ${BOT_DISK_PNPM_IMPORT_METHODS.join(", ")}`;
}

/**
 * Reads the pnpm values stored by an earlier release (BOT-DISK-D: store
 * `/workspace/.pnpm-store`, method `hardlink` or `clone-or-copy`) as the values
 * in force today, with a note for each one changed: `/workspace/.pnpm-store`
 * becomes the shared store, `hardlink` and `clone-or-copy` become `clone`. Any
 * other stored value is kept (an unknown method is dropped to the default by
 * the caller). Nothing is changed silently: every migration is in `notes`.
 */
export function migrateBotDiskPnpm(stored: { pnpmStoreDir?: string; pnpmImportMethod?: string }): {
  pnpmStoreDir?: string;
  pnpmImportMethod?: BotDiskPnpmImportMethod;
  notes: string[];
} {
  const notes: string[] = [];
  const out: { pnpmStoreDir?: string; pnpmImportMethod?: BotDiskPnpmImportMethod; notes: string[] } = { notes };
  if (typeof stored.pnpmStoreDir === "string") {
    if (stored.pnpmStoreDir === BOT_DISK_LEGACY_PNPM_STORE_DIR) {
      out.pnpmStoreDir = BOT_DISK_DEFAULT_PNPM_STORE_DIR;
      notes.push(`pnpmStoreDir ${stored.pnpmStoreDir} (per-bot store) is read as ${BOT_DISK_DEFAULT_PNPM_STORE_DIR} (the store shared by the partition)`);
    } else {
      out.pnpmStoreDir = stored.pnpmStoreDir;
    }
  }
  const method = stored.pnpmImportMethod;
  if (typeof method === "string") {
    if ((BOT_DISK_PNPM_IMPORT_METHODS as readonly string[]).includes(method)) {
      out.pnpmImportMethod = method as BotDiskPnpmImportMethod;
    } else if ((BOT_DISK_LEGACY_PNPM_IMPORT_METHODS as readonly string[]).includes(method)) {
      out.pnpmImportMethod = "clone";
      notes.push(`pnpmImportMethod ${method} is read as clone (strict reflink import)`);
    }
  }
  return out;
}

const pnpmStoreDirSchema = z
  .string()
  .max(4096)
  .superRefine((value, ctx) => {
    const problem = botDiskPnpmStoreDirProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `pnpmStoreDir ${problem}` });
  });

export const BOT_DISK_MIN_GIT_MIRROR_REFRESH_MS = 60 * 1000;
export const BOT_DISK_MAX_GIT_MIRROR_REFRESH_MS = 24 * 60 * 60 * 1000;
export const BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS = 15 * 60 * 1000;
export const BOT_DISK_MAX_GIT_MIRROR_REPOS = 50;

/**
 * myrmidon(1.6.2-BOT-DISK-C): the agent roles (`agents.role`) whose bots get the
 * shared package cache and the git mirror mounts. Every other bot (marketing,
 * support, ...) gets no cache mount, so enabling the cache does not recreate it.
 */
export const BOT_DISK_DEFAULT_SHARED_CACHE_ROLES: readonly string[] = ["engineer", "reviewer", "devops", "release", "qa"];
export const BOT_DISK_MAX_SHARED_CACHE_ROLES = 50;

const sharedCacheRolesSchema = z
  .array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, "role keys are lower-case letters, digits, '_' and '-'"))
  .max(BOT_DISK_MAX_SHARED_CACHE_ROLES);

/** Whether a bot of `role` is in the shared-cache scope (`roles` from {@link BotDiskLayout}). */
export function botRoleGetsSharedCache(roles: readonly string[], role: string | null | undefined): boolean {
  return typeof role === "string" && roles.includes(role.trim().toLowerCase());
}

/**
 * Why `value` cannot be a mirrored repository name, or null when it can: a
 * GitHub `owner/repo` pair — the owner is 1–39 letters, digits or inner
 * hyphens, the repository 1–100 letters, digits, ".", "_" or "-", not "." or
 * "..", and without a ".git" suffix (the mirror directory adds it).
 */
export function gitMirrorRepoProblem(value: string): string | null {
  const parts = value.split("/");
  if (parts.length !== 2) return "is not an owner/repo pair";
  const [owner, repo] = parts as [string, string];
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(owner)) return "has an invalid owner";
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return "has an invalid repository name";
  if (repo.toLowerCase().endsWith(".git")) return "ends with .git";
  return null;
}

const gitMirrorRepoSchema = z
  .string()
  .max(140)
  .superRefine((value, ctx) => {
    const problem = gitMirrorRepoProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `gitMirrorRepos entry ${JSON.stringify(value)} ${problem}` });
  });

const gitMirrorReposSchema = z.array(gitMirrorRepoSchema).max(BOT_DISK_MAX_GIT_MIRROR_REPOS);

const gitMirrorRefreshMsSchema = z
  .number()
  .int()
  .min(BOT_DISK_MIN_GIT_MIRROR_REFRESH_MS)
  .max(BOT_DISK_MAX_GIT_MIRROR_REFRESH_MS);

const pnpmImportMethodSchema = z
  .string()
  .superRefine((value, ctx) => {
    const problem = botDiskPnpmImportMethodProblem(value);
    if (problem) ctx.addIssue({ code: "custom", message: `pnpmImportMethod ${problem}` });
  })
  .transform((value) => value as BotDiskPnpmImportMethod);

/** What an earlier release may have stored: any string; {@link migrateBotDiskPnpm} reads it. */
const storedPnpmImportMethodSchema = z.string().max(64);

const idleTtlMsSchema = z
  .number()
  .int()
  .min(BOT_DISK_MIN_IDLE_TTL_MS)
  .max(BOT_DISK_MAX_IDLE_TTL_MS);

// myrmidon(1.6.5-BOT-DISK-H5c): the BOT-DISK-H mechanics settings of C7
// (`wsBotDiskSettingsSchema` in myrmidon-bot-workspace.ts), stored under the
// same `general.botDisk` key. The profile compiler resolves them (defaults
// `WS_BOT_DISK_SETTING_DEFAULTS`) and writes them into every bot's hermes/.env
// (`WS_PROFILE_ENV`), so `myr-ws` and botd run the same policy everywhere.
const graceClosingMinutesSchema = z.number().int().min(5).max(24 * 60);
const scratchTtlHoursSchema = z.number().int().min(1).max(24 * 30);
const partitionPercentSchema = z.number().int().min(50).max(100);
const botdIntervalSecSchema = z.number().int().min(30).max(24 * 60 * 60);

/** The canonical shape the service writes. */
export const botDiskSettingsSchema = z
  .object({
    enabled: z.boolean(),
    idleTtlMs: idleTtlMsSchema,
    // myrmidon(1.6.1-BOT-DISK-B): absent = no shared package cache.
    sharedPackageCachePath: cachePathSchema.optional(),
    // myrmidon(1.6.5-BOT-DISK-H11): absent = every bot keeps its own runtime.
    sharedBotRuntimePath: botRuntimePathSchema.optional(),
    // myrmidon(1.6.2-BOT-DISK-C): absent = the defaults of resolveBotDiskLayout.
    gitMirrorRepos: gitMirrorReposSchema.optional(),
    gitMirrorRefreshMs: gitMirrorRefreshMsSchema.optional(),
    pnpmStoreDir: pnpmStoreDirSchema.optional(),
    pnpmImportMethod: pnpmImportMethodSchema.optional(),
    sharedCacheRoles: sharedCacheRolesSchema.optional(),
    // myrmidon(1.6.5-BOT-DISK-H5c): the C7 mechanics keys; absent = the C7 defaults.
    graceClosingMinutes: graceClosingMinutesSchema.optional(),
    scratchTtlHours: scratchTtlHoursSchema.optional(),
    partitionThresholdPercent: partitionPercentSchema.optional(),
    partitionRefuseOpenPercent: partitionPercentSchema.optional(),
    partitionCriticalPercent: partitionPercentSchema.optional(),
    botdIntervalSec: botdIntervalSecSchema.optional(),
  })
  .strict();

const storedBotDiskObjectSchema = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    idleTtlMs: idleTtlMsSchema.optional().catch(undefined),
    sharedPackageCachePath: cachePathSchema.optional().catch(undefined),
    sharedBotRuntimePath: botRuntimePathSchema.optional().catch(undefined),
    gitMirrorRepos: gitMirrorReposSchema.optional().catch(undefined),
    gitMirrorRefreshMs: gitMirrorRefreshMsSchema.optional().catch(undefined),
    pnpmStoreDir: pnpmStoreDirSchema.optional().catch(undefined),
    pnpmImportMethod: storedPnpmImportMethodSchema.optional().catch(undefined),
    sharedCacheRoles: sharedCacheRolesSchema.optional().catch(undefined),
    graceClosingMinutes: graceClosingMinutesSchema.optional().catch(undefined),
    scratchTtlHours: scratchTtlHoursSchema.optional().catch(undefined),
    partitionThresholdPercent: partitionPercentSchema.optional().catch(undefined),
    partitionRefuseOpenPercent: partitionPercentSchema.optional().catch(undefined),
    partitionCriticalPercent: partitionPercentSchema.optional().catch(undefined),
    botdIntervalSec: botdIntervalSecSchema.optional().catch(undefined),
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
    // myrmidon(1.6.5-BOT-DISK-H11): a path sets the shared runtime, null or "" turns it off.
    sharedBotRuntimePath: z.union([botRuntimePathSchema, z.literal(""), z.null()]).optional(),
    // myrmidon(1.6.2-BOT-DISK-C): null (or, for the list, []) returns the key to its default.
    gitMirrorRepos: z.union([gitMirrorReposSchema, z.null()]).optional(),
    gitMirrorRefreshMs: z.union([gitMirrorRefreshMsSchema, z.null()]).optional(),
    pnpmStoreDir: z.union([pnpmStoreDirSchema, z.null()]).optional(),
    pnpmImportMethod: z.union([pnpmImportMethodSchema, z.null()]).optional(),
    // null returns the default role list; [] is allowed and means no bot.
    sharedCacheRoles: z.union([sharedCacheRolesSchema, z.null()]).optional(),
    // myrmidon(1.6.5-BOT-DISK-H5c): the C7 mechanics keys; null returns a key to
    // its C7 default (WS_BOT_DISK_SETTING_DEFAULTS).
    graceClosingMinutes: z.union([graceClosingMinutesSchema, z.null()]).optional(),
    scratchTtlHours: z.union([scratchTtlHoursSchema, z.null()]).optional(),
    partitionThresholdPercent: z.union([partitionPercentSchema, z.null()]).optional(),
    partitionRefuseOpenPercent: z.union([partitionPercentSchema, z.null()]).optional(),
    partitionCriticalPercent: z.union([partitionPercentSchema, z.null()]).optional(),
    botdIntervalSec: z.union([botdIntervalSecSchema, z.null()]).optional(),
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
  if (typeof parsed.data.sharedBotRuntimePath === "string") {
    out.sharedBotRuntimePath = parsed.data.sharedBotRuntimePath;
  }
  if (Array.isArray(parsed.data.gitMirrorRepos) && parsed.data.gitMirrorRepos.length > 0) {
    out.gitMirrorRepos = parsed.data.gitMirrorRepos;
  }
  if (typeof parsed.data.gitMirrorRefreshMs === "number") out.gitMirrorRefreshMs = parsed.data.gitMirrorRefreshMs;
  // myrmidon(1.6.5-BOT-DISK-H8a): the pnpm keys of an earlier release read as today's values.
  const pnpm = migrateBotDiskPnpm(parsed.data);
  if (pnpm.pnpmStoreDir !== undefined) out.pnpmStoreDir = pnpm.pnpmStoreDir;
  if (pnpm.pnpmImportMethod !== undefined) out.pnpmImportMethod = pnpm.pnpmImportMethod;
  if (Array.isArray(parsed.data.sharedCacheRoles)) out.sharedCacheRoles = parsed.data.sharedCacheRoles;
  // myrmidon(1.6.5-BOT-DISK-H5c): the C7 mechanics keys.
  if (typeof parsed.data.graceClosingMinutes === "number") out.graceClosingMinutes = parsed.data.graceClosingMinutes;
  if (typeof parsed.data.scratchTtlHours === "number") out.scratchTtlHours = parsed.data.scratchTtlHours;
  if (typeof parsed.data.partitionThresholdPercent === "number") out.partitionThresholdPercent = parsed.data.partitionThresholdPercent;
  if (typeof parsed.data.partitionRefuseOpenPercent === "number") out.partitionRefuseOpenPercent = parsed.data.partitionRefuseOpenPercent;
  if (typeof parsed.data.partitionCriticalPercent === "number") out.partitionCriticalPercent = parsed.data.partitionCriticalPercent;
  if (typeof parsed.data.botdIntervalSec === "number") out.botdIntervalSec = parsed.data.botdIntervalSec;
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
      ...optionalLayoutKeys(stored),
    },
    sources: { enabled: enabled[1], idleTtlMs: idleTtlMs[1] },
  };
}

/** The 1.6.2-BOT-DISK-C keys that are set, in canonical form (an empty list is absent). */
function optionalLayoutKeys(values: Partial<BotDiskSettings>): Partial<BotDiskSettings> {
  return {
    ...(values.gitMirrorRepos && values.gitMirrorRepos.length > 0 ? { gitMirrorRepos: values.gitMirrorRepos } : {}),
    ...(values.gitMirrorRefreshMs !== undefined ? { gitMirrorRefreshMs: values.gitMirrorRefreshMs } : {}),
    ...(values.pnpmStoreDir !== undefined ? { pnpmStoreDir: values.pnpmStoreDir } : {}),
    ...(values.pnpmImportMethod !== undefined ? { pnpmImportMethod: values.pnpmImportMethod } : {}),
    ...(values.sharedCacheRoles !== undefined ? { sharedCacheRoles: values.sharedCacheRoles } : {}),
    // myrmidon(1.6.5-BOT-DISK-H11): stored or absent, like the cache path.
    ...(values.sharedBotRuntimePath !== undefined ? { sharedBotRuntimePath: values.sharedBotRuntimePath } : {}),
  };
}

/** `patch[key]` when given (null clears it), otherwise `base[key]`. */
function pick<T>(patchValue: T | null | undefined, baseValue: T | undefined): T | undefined {
  if (patchValue === undefined) return baseValue;
  return patchValue === null ? undefined : patchValue;
}

/** A patch over the effective values, the shape that gets stored. */
export function mergeBotDiskSettings(
  base: BotDiskSettings,
  patch: BotDiskSettingsPatch,
): BotDiskSettings {
  const sharedPackageCachePath =
    patch.sharedPackageCachePath === undefined ? base.sharedPackageCachePath : patch.sharedPackageCachePath || undefined;
  const sharedBotRuntimePath =
    patch.sharedBotRuntimePath === undefined ? base.sharedBotRuntimePath : patch.sharedBotRuntimePath || undefined;
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    idleTtlMs: patch.idleTtlMs === undefined ? base.idleTtlMs : patch.idleTtlMs,
    ...(sharedPackageCachePath ? { sharedPackageCachePath } : {}),
    ...(sharedBotRuntimePath ? { sharedBotRuntimePath } : {}),
    ...optionalLayoutKeys({
      gitMirrorRepos: pick(patch.gitMirrorRepos, base.gitMirrorRepos),
      gitMirrorRefreshMs: pick(patch.gitMirrorRefreshMs, base.gitMirrorRefreshMs),
      pnpmStoreDir: pick(patch.pnpmStoreDir, base.pnpmStoreDir),
      pnpmImportMethod: pick(patch.pnpmImportMethod, base.pnpmImportMethod),
      sharedCacheRoles: pick(patch.sharedCacheRoles, base.sharedCacheRoles),
    }),
    // myrmidon(1.6.5-BOT-DISK-H5c): the C7 mechanics keys merge like the layout
    // keys (null clears back to the default), but are not layout: they belong to
    // the profile the compiler hands the bots, so they ride their own slot.
    ...optionalMechanicsKeys({
      graceClosingMinutes: pick(patch.graceClosingMinutes, base.graceClosingMinutes),
      scratchTtlHours: pick(patch.scratchTtlHours, base.scratchTtlHours),
      partitionThresholdPercent: pick(patch.partitionThresholdPercent, base.partitionThresholdPercent),
      partitionRefuseOpenPercent: pick(patch.partitionRefuseOpenPercent, base.partitionRefuseOpenPercent),
      partitionCriticalPercent: pick(patch.partitionCriticalPercent, base.partitionCriticalPercent),
      botdIntervalSec: pick(patch.botdIntervalSec, base.botdIntervalSec),
    }),
  };
}

/** The C7 mechanics keys that are set (each absent = its C7 default). */
function optionalMechanicsKeys(values: Partial<BotDiskSettings>): Partial<BotDiskSettings> {
  return {
    ...(values.graceClosingMinutes !== undefined ? { graceClosingMinutes: values.graceClosingMinutes } : {}),
    ...(values.scratchTtlHours !== undefined ? { scratchTtlHours: values.scratchTtlHours } : {}),
    ...(values.partitionThresholdPercent !== undefined ? { partitionThresholdPercent: values.partitionThresholdPercent } : {}),
    ...(values.partitionRefuseOpenPercent !== undefined ? { partitionRefuseOpenPercent: values.partitionRefuseOpenPercent } : {}),
    ...(values.partitionCriticalPercent !== undefined ? { partitionCriticalPercent: values.partitionCriticalPercent } : {}),
    ...(values.botdIntervalSec !== undefined ? { botdIntervalSec: values.botdIntervalSec } : {}),
  };
}

/** The 1.6.2-BOT-DISK-C keys a settings change compares besides the env-backed ones. */
export const BOT_DISK_LAYOUT_KEYS = ["sharedPackageCachePath", "sharedBotRuntimePath", "gitMirrorRepos", "gitMirrorRefreshMs", "pnpmStoreDir", "pnpmImportMethod", "sharedCacheRoles"] as const;

/**
 * myrmidon(1.6.5-BOT-DISK-H5c): the stored C7 mechanics keys, resolved with the
 * contract defaults (`WS_BOT_DISK_SETTING_DEFAULTS` of the H0 contract), as the
 * profile compiler hands them to the bots (`WS_PROFILE_ENV`). `botdIntervalSec`
 * has no contract default — absent stays undefined and the in-image default of
 * botd applies (H3).
 */
export interface BotDiskMechanics {
  graceClosingMinutes: number;
  scratchTtlHours: number;
  partitionThresholdPercent: number;
  partitionRefuseOpenPercent: number;
  partitionCriticalPercent: number;
  botdIntervalSec?: number;
}

export function resolveBotDiskMechanics(stored: unknown): BotDiskMechanics {
  const values = normalizeStoredBotDiskSettings(stored);
  return {
    graceClosingMinutes: values.graceClosingMinutes ?? 30,
    scratchTtlHours: values.scratchTtlHours ?? 24,
    partitionThresholdPercent: values.partitionThresholdPercent ?? 85,
    partitionRefuseOpenPercent: values.partitionRefuseOpenPercent ?? 90,
    partitionCriticalPercent: values.partitionCriticalPercent ?? 95,
    ...(values.botdIntervalSec !== undefined ? { botdIntervalSec: values.botdIntervalSec } : {}),
  };
}

/**
 * myrmidon(1.6.2-BOT-DISK-C): the shared-cache layout in force, with the
 * defaults filled in. `gitMirrorRepos` is lower-cased and de-duplicated (GitHub
 * names are case-insensitive, and the mirror directory is the lower-case name),
 * and is empty without a shared package cache path: the mirrors live under it.
 */
export interface BotDiskLayout {
  sharedPackageCachePath?: string;
  /**
   * myrmidon(1.6.5-BOT-DISK-H11): the host directory whose `bin`,
   * `lazy-packages` and `lsp` subdirectories every bot mounts READ-ONLY over
   * its own (absent: every bot keeps its own, the 1.6.4 behaviour). Populated
   * by the operator once; see docs/myrmidon/bot-shared-runtime.md.
   */
  sharedBotRuntimePath?: string;
  gitMirrorRepos: string[];
  gitMirrorRefreshMs: number;
  pnpmStoreDir: string;
  pnpmImportMethod: BotDiskPnpmImportMethod;
  /** Roles whose bots get the cache and mirror mounts (lower case); default {@link BOT_DISK_DEFAULT_SHARED_CACHE_ROLES}. */
  sharedCacheRoles: string[];
}

export function resolveBotDiskLayout(stored: unknown): BotDiskLayout {
  const values = normalizeStoredBotDiskSettings(stored);
  const repos = values.sharedPackageCachePath
    ? [...new Set((values.gitMirrorRepos ?? []).map((repo) => repo.toLowerCase()))]
    : [];
  return {
    ...(values.sharedPackageCachePath ? { sharedPackageCachePath: values.sharedPackageCachePath } : {}),
    ...(values.sharedBotRuntimePath ? { sharedBotRuntimePath: values.sharedBotRuntimePath } : {}),
    gitMirrorRepos: repos,
    gitMirrorRefreshMs: values.gitMirrorRefreshMs ?? BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS,
    pnpmStoreDir: values.pnpmStoreDir ?? BOT_DISK_DEFAULT_PNPM_STORE_DIR,
    pnpmImportMethod: values.pnpmImportMethod ?? BOT_DISK_DEFAULT_PNPM_IMPORT_METHOD,
    sharedCacheRoles: [...new Set((values.sharedCacheRoles ?? BOT_DISK_DEFAULT_SHARED_CACHE_ROLES).map((r) => r.toLowerCase()))],
  };
}

/**
 * myrmidon(1.6.5-BOT-DISK-H8a): what to tell the operator about the pnpm
 * settings in the stored `general.botDisk`: each migration of an earlier
 * release's value, and a store inside the bot's own tree. Empty when the
 * settings are the defaults. A warning, never a silent fall back.
 */
export function botDiskPnpmWarnings(stored: unknown): string[] {
  const parsed = storedBotDiskSettingsSchema.safeParse(stored);
  if (!parsed.success || !parsed.data) return [];
  const migrated = migrateBotDiskPnpm(parsed.data);
  const warning = migrated.pnpmStoreDir ? botDiskPnpmStoreDirWarning(migrated.pnpmStoreDir) : null;
  return warning ? [...migrated.notes, warning] : migrated.notes;
}

/** The shared package cache path in force, from the stored `general.botDisk` (undefined: none). */
export function resolveSharedPackageCachePath(stored: unknown): string | undefined {
  return normalizeStoredBotDiskSettings(stored).sharedPackageCachePath;
}

/**
 * myrmidon(1.6.5-BOT-DISK-H11): the shared bot runtime root in force, from the
 * stored `general.botDisk` (undefined: no shared runtime — every bot keeps its
 * own `bin`, `lazy-packages` and `lsp`). Not role-gated, unlike the package
 * cache: the runtime is the same for every bot of the instance, so one setting
 * applies to all of them (BOT-DISK-H11 in the epic design).
 */
export function resolveSharedBotRuntimePath(stored: unknown): string | undefined {
  return normalizeStoredBotDiskSettings(stored).sharedBotRuntimePath;
}
