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
 * - `pnpmStoreDir` — where pnpm keeps its content-addressed store, a path inside
 *   the bot's single mount (default `/workspace/.pnpm-store`). Never under
 *   `/cache`: that is another mount, and hard links cannot cross mounts;
 * - `pnpmImportMethod` — how pnpm puts a package into a clone: `hardlink` (the
 *   default; only hard links are tried), `clone-or-copy` or `copy` (an explicit
 *   opt-out of hard links). pnpm 9 copies silently where the kernel refuses a
 *   link; the container's start-time self-check reports that.
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

/** myrmidon(BOT-DISK-D): where the pnpm store lives and how pnpm imports (see the module comment). */
export const BOT_DISK_DEFAULT_PNPM_STORE_DIR = "/workspace/.pnpm-store";
export const BOT_DISK_PNPM_IMPORT_METHODS = ["hardlink", "clone-or-copy", "copy"] as const;
export type BotDiskPnpmImportMethod = (typeof BOT_DISK_PNPM_IMPORT_METHODS)[number];
export const BOT_DISK_DEFAULT_PNPM_IMPORT_METHOD: BotDiskPnpmImportMethod = "hardlink";
/** Container roots a store may live under: all inside the bot's single mount. */
export const BOT_DISK_PNPM_STORE_ROOTS = ["/workspace", "/data", "/scratch", "/bot"] as const;

/**
 * Why `value` cannot be the pnpm store directory, or null when it can: a plain
 * absolute path (the cache-path rules) strictly under one of
 * {@link BOT_DISK_PNPM_STORE_ROOTS}. A store anywhere else is outside the bot's
 * single mount and pnpm would copy instead of hard-linking.
 */
export function botDiskPnpmStoreDirProblem(value: string): string | null {
  const plain = botDiskCachePathProblem(value);
  if (plain) return plain;
  if (!BOT_DISK_PNPM_STORE_ROOTS.some((root) => value.startsWith(`${root}/`))) {
    return `is not inside the bot's single mount (under ${BOT_DISK_PNPM_STORE_ROOTS.join(", ")})`;
  }
  return null;
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

const pnpmImportMethodSchema = z.enum(BOT_DISK_PNPM_IMPORT_METHODS);

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
    // myrmidon(1.6.2-BOT-DISK-C): absent = the defaults of resolveBotDiskLayout.
    gitMirrorRepos: gitMirrorReposSchema.optional(),
    gitMirrorRefreshMs: gitMirrorRefreshMsSchema.optional(),
    pnpmStoreDir: pnpmStoreDirSchema.optional(),
    pnpmImportMethod: pnpmImportMethodSchema.optional(),
    sharedCacheRoles: sharedCacheRolesSchema.optional(),
  })
  .strict();

const storedBotDiskObjectSchema = z
  .object({
    enabled: z.boolean().optional().catch(undefined),
    idleTtlMs: idleTtlMsSchema.optional().catch(undefined),
    sharedPackageCachePath: cachePathSchema.optional().catch(undefined),
    gitMirrorRepos: gitMirrorReposSchema.optional().catch(undefined),
    gitMirrorRefreshMs: gitMirrorRefreshMsSchema.optional().catch(undefined),
    pnpmStoreDir: pnpmStoreDirSchema.optional().catch(undefined),
    pnpmImportMethod: pnpmImportMethodSchema.optional().catch(undefined),
    sharedCacheRoles: sharedCacheRolesSchema.optional().catch(undefined),
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
    // myrmidon(1.6.2-BOT-DISK-C): null (or, for the list, []) returns the key to its default.
    gitMirrorRepos: z.union([gitMirrorReposSchema, z.null()]).optional(),
    gitMirrorRefreshMs: z.union([gitMirrorRefreshMsSchema, z.null()]).optional(),
    pnpmStoreDir: z.union([pnpmStoreDirSchema, z.null()]).optional(),
    pnpmImportMethod: z.union([pnpmImportMethodSchema, z.null()]).optional(),
    // null returns the default role list; [] is allowed and means no bot.
    sharedCacheRoles: z.union([sharedCacheRolesSchema, z.null()]).optional(),
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
  if (Array.isArray(parsed.data.gitMirrorRepos) && parsed.data.gitMirrorRepos.length > 0) {
    out.gitMirrorRepos = parsed.data.gitMirrorRepos;
  }
  if (typeof parsed.data.gitMirrorRefreshMs === "number") out.gitMirrorRefreshMs = parsed.data.gitMirrorRefreshMs;
  if (typeof parsed.data.pnpmStoreDir === "string") out.pnpmStoreDir = parsed.data.pnpmStoreDir;
  if (typeof parsed.data.pnpmImportMethod === "string") out.pnpmImportMethod = parsed.data.pnpmImportMethod;
  if (Array.isArray(parsed.data.sharedCacheRoles)) out.sharedCacheRoles = parsed.data.sharedCacheRoles;
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
  return {
    enabled: patch.enabled === undefined ? base.enabled : patch.enabled,
    idleTtlMs: patch.idleTtlMs === undefined ? base.idleTtlMs : patch.idleTtlMs,
    ...(sharedPackageCachePath ? { sharedPackageCachePath } : {}),
    ...optionalLayoutKeys({
      gitMirrorRepos: pick(patch.gitMirrorRepos, base.gitMirrorRepos),
      gitMirrorRefreshMs: pick(patch.gitMirrorRefreshMs, base.gitMirrorRefreshMs),
      pnpmStoreDir: pick(patch.pnpmStoreDir, base.pnpmStoreDir),
      pnpmImportMethod: pick(patch.pnpmImportMethod, base.pnpmImportMethod),
      sharedCacheRoles: pick(patch.sharedCacheRoles, base.sharedCacheRoles),
    }),
  };
}

/** The 1.6.2-BOT-DISK-C keys a settings change compares besides the env-backed ones. */
export const BOT_DISK_LAYOUT_KEYS = ["sharedPackageCachePath", "gitMirrorRepos", "gitMirrorRefreshMs", "pnpmStoreDir", "pnpmImportMethod", "sharedCacheRoles"] as const;

/**
 * myrmidon(1.6.2-BOT-DISK-C): the shared-cache layout in force, with the
 * defaults filled in. `gitMirrorRepos` is lower-cased and de-duplicated (GitHub
 * names are case-insensitive, and the mirror directory is the lower-case name),
 * and is empty without a shared package cache path: the mirrors live under it.
 */
export interface BotDiskLayout {
  sharedPackageCachePath?: string;
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
    gitMirrorRepos: repos,
    gitMirrorRefreshMs: values.gitMirrorRefreshMs ?? BOT_DISK_DEFAULT_GIT_MIRROR_REFRESH_MS,
    pnpmStoreDir: values.pnpmStoreDir ?? BOT_DISK_DEFAULT_PNPM_STORE_DIR,
    pnpmImportMethod: values.pnpmImportMethod ?? BOT_DISK_DEFAULT_PNPM_IMPORT_METHOD,
    sharedCacheRoles: [...new Set((values.sharedCacheRoles ?? BOT_DISK_DEFAULT_SHARED_CACHE_ROLES).map((r) => r.toLowerCase()))],
  };
}

/** The shared package cache path in force, from the stored `general.botDisk` (undefined: none). */
export function resolveSharedPackageCachePath(stored: unknown): string | undefined {
  return normalizeStoredBotDiskSettings(stored).sharedPackageCachePath;
}
