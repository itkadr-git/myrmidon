import { z } from "zod";

/**
 * myrmidon(1.6.5-BOT-DISK-H0): the interface contract of the bot-disk project
 * (epic design sections 1–4, 8). Every BOT-DISK-H task codes against these
 * schemas and the fixtures in `docs/myrmidon/bot-disk-contract/*.json` (each
 * fixture passes its schema; the test beside this file proves it). Changing a
 * field here is a contract change and goes through the epic thread, never
 * silently.
 *
 * Sections: C1 directory layout constants, C2 `myr-ws` CLI, C3 desired-state
 * (`GET /api/myrmidon/bots/me/workspaces`), C4 disk report
 * (`POST /api/myrmidon/bots/me/disk-report`), C5 dockergate
 * (`GET /myrmidon/disk`, `PUT /myrmidon/disk/<botKey>/quota`), C6 the
 * `workspace` field of `/v1/runs`, C7 `general.botDisk.*` settings and card
 * keys.
 */

// ---------------------------------------------------------------------------
// C1. Directory layout (container paths; host root is MYRMIDON_BOT_VOLUME_ROOT)
// ---------------------------------------------------------------------------

/** Root of the per-bot myrmidon state inside the container. */
export const MYRMIDON_HOME_DIR = "/data/hermes/.myrmidon";

/** Class D: bare base repositories, one per (bot, owner/repo). */
export const WS_GIT_BASE_DIR = `${MYRMIDON_HOME_DIR}/git-base`;

/** Class F: archives of removed copies with unpushed work. */
export const WS_ARCHIVE_DIR = `${MYRMIDON_HOME_DIR}/archive`;

/** Registry of open copies (who opened what: class E or G). */
export const WS_REGISTRY_PATH = `${MYRMIDON_HOME_DIR}/ws-registry.json`;

/** Pressure file: botd writes it, `myr-ws open` reads it. */
export const WS_DISK_STATE_PATH = `${MYRMIDON_HOME_DIR}/disk-state.json`;

/** Where `myr-ws open` puts a task copy: `/workspace/<ISSUE-KEY>`. */
export const WS_WORKSPACE_ROOT = "/workspace";

/** Scratch copies live under `/scratch/<name>`. */
export const WS_SCRATCH_ROOT = "/scratch";

/** Fetch refspec of a class-D base: heads land under refs/remotes/origin/*. */
export const WS_GIT_BASE_REFSPEC = "+refs/heads/*:refs/remotes/origin/*";

/** Bases per bot above this count make `open` fail with exit code 4. */
export const WS_GIT_BASE_LIMIT = 8;

/** A base is fetched at most this often (seconds). */
export const WS_GIT_BASE_FETCH_MIN_INTERVAL_SEC = 900;

/** Branch prefix of a task worktree: `bot/<ISSUE-KEY>`. */
export const WS_TASK_BRANCH_PREFIX = "bot/";

export const myrWsGitBaseRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\s~^:?*[\]\\]+$/, "not a valid git ref");

/** `owner/repo` as GitHub serves it (no scheme, no userinfo, no .git suffix needed). */
export const myrWsRepoNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "repo must be owner/name");

/** Issue key of a task copy (the board identifier, e.g. ABC-101). */
export const myrWsIssueKeySchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9]*-[0-9]+$/, "issue key must look like PREFIX-123");

/** Registry entry of one open copy (class E task worktree or class G scratch). */
export const wsRegistryEntrySchema = z.object({
  key: z.string().min(1).max(200),
  repo: myrWsRepoNameSchema.optional(),
  path: z.string().min(1),
  class: z.enum(["E", "G"]),
  branch: z.string().min(1).optional(),
  openedAt: z.string().datetime({ offset: false }),
});
export type WsRegistryEntry = z.infer<typeof wsRegistryEntrySchema>;

export const wsRegistrySchema = z.object({
  version: z.literal(1),
  entries: z.array(wsRegistryEntrySchema),
});
export type WsRegistry = z.infer<typeof wsRegistrySchema>;

/** Pressure level of the bot partition, derived from quota and partition use. */
export const wsDiskPressureLevelSchema = z.enum(["none", "soft", "hard"]);
export type WsDiskPressureLevel = z.infer<typeof wsDiskPressureLevelSchema>;

/**
 * `/data/hermes/.myrmidon/disk-state.json` — written by botd on every pass,
 * read by `myr-ws open` before creating a copy. Stale (older than two botd
 * ticks) or absent means `pressure: "none"`.
 */
export const wsDiskStateSchema = z.object({
  version: z.literal(1),
  quotaPercent: z.number().min(0).max(100).nullable(),
  partitionPercent: z.number().min(0).max(100),
  pressure: wsDiskPressureLevelSchema,
  updatedAt: z.string().datetime({ offset: false }),
});
export type WsDiskState = z.infer<typeof wsDiskStateSchema>;

// ---------------------------------------------------------------------------
// C2. `myr-ws` CLI
// ---------------------------------------------------------------------------

/**
 * Exit codes of `myr-ws` (stable, parsed by the gateway and the adapter):
 * 0 ok; 2 invalid arguments; 3 quota/disk refusal (message starts with
 * `BOT_DISK_QUOTA_EXCEEDED:`); 4 repository over the base limit; 5 network or
 * fetch failure; 6 no such copy or archive; 7 the copy holds unpushed work and
 * `--force` was not given.
 */
export const MYR_WS_EXIT = {
  ok: 0,
  usage: 2,
  quotaExceeded: 3,
  baseLimit: 4,
  network: 5,
  notFound: 6,
  unpushed: 7,
} as const;
export type MyrWsExitCode = (typeof MYR_WS_EXIT)[keyof typeof MYR_WS_EXIT];

/** Message prefix of a quota/disk refusal on stderr and in JSON `error`. */
export const MYR_WS_QUOTA_ERROR_PREFIX = "BOT_DISK_QUOTA_EXCEEDED:";

/** Environment variables `myr-ws` honours. */
export const MYR_WS_ENV = {
  /** Absolute path of the opened copy, exported to the run. */
  taskWorkspace: "MYRMIDON_TASK_WORKSPACE",
  /** Binary override (tests only). */
  bin: "MYRMIDON_WS_BIN",
  /** State root override instead of /data/hermes/.myrmidon (tests only). */
  home: "MYRMIDON_WS_HOME",
} as const;

/** `myr-ws open <KEY> [owner/repo] [--base <ref>] [--scratch] --json` output. */
export const myrWsOpenResultSchema = z.object({
  ok: z.literal(true),
  key: myrWsIssueKeySchema,
  path: z.string().min(1),
  class: z.enum(["E", "G"]),
  repo: myrWsRepoNameSchema.optional(),
  branch: z.string().min(1).optional(),
  base: z.string().min(1).optional(),
  /** True when the copy already existed (`open` is idempotent). */
  reused: z.boolean(),
});
export type MyrWsOpenResult = z.infer<typeof myrWsOpenResultSchema>;

/** One entry of `myr-ws list --json`. */
export const myrWsListEntrySchema = z.object({
  key: z.string().min(1),
  path: z.string().min(1),
  class: z.enum(["E", "G"]),
  repo: myrWsRepoNameSchema.optional(),
  branch: z.string().min(1).optional(),
  openedAt: z.string().datetime({ offset: false }),
  clean: z.boolean().nullable(),
  pushed: z.boolean().nullable(),
});
export type MyrWsListEntry = z.infer<typeof myrWsListEntrySchema>;

export const myrWsListResultSchema = z.object({
  ok: z.literal(true),
  entries: z.array(myrWsListEntrySchema),
});
export type MyrWsListResult = z.infer<typeof myrWsListResultSchema>;

/** `myr-ws close <KEY> [--force] --json` output. */
export const myrWsCloseResultSchema = z.object({
  ok: z.literal(true),
  key: z.string().min(1),
  removed: z.boolean(),
  archived: z.boolean(),
  archivePath: z.string().min(1).optional(),
});
export type MyrWsCloseResult = z.infer<typeof myrWsCloseResultSchema>;

/** `myr-ws restore <KEY> --json` output. */
export const myrWsRestoreResultSchema = z.object({
  ok: z.literal(true),
  key: myrWsIssueKeySchema,
  path: z.string().min(1),
  branch: z.string().min(1),
  restoredFrom: z.string().min(1),
});
export type MyrWsRestoreResult = z.infer<typeof myrWsRestoreResultSchema>;

/** `myr-ws migrate --json` output (git-objects mirror -> class-D base). */
export const myrWsMigrateResultSchema = z.object({
  ok: z.literal(true),
  repo: myrWsRepoNameSchema,
  basePath: z.string().min(1),
  refs: z.number().int().nonnegative(),
});
export type MyrWsMigrateResult = z.infer<typeof myrWsMigrateResultSchema>;

/** Any failing command prints this shape on stdout with `--json`. */
export const myrWsErrorResultSchema = z.object({
  ok: z.literal(false),
  error: z.string().min(1),
  exitCode: z.number().int(),
});
export type MyrWsErrorResult = z.infer<typeof myrWsErrorResultSchema>;

// ---------------------------------------------------------------------------
// C3. Desired state: GET /api/myrmidon/bots/me/workspaces
// ---------------------------------------------------------------------------

export const wsDesiredWorkspaceStateSchema = z.enum(["active", "closing"]);
export type WsDesiredWorkspaceState = z.infer<typeof wsDesiredWorkspaceStateSchema>;

export const wsDesiredPrStateSchema = z.enum(["none", "open", "merged", "closed"]);
export type WsDesiredPrState = z.infer<typeof wsDesiredPrStateSchema>;

export const wsDesiredWorkspaceSchema = z.object({
  key: z.string().min(1),
  repo: myrWsRepoNameSchema.optional(),
  state: wsDesiredWorkspaceStateSchema,
  since: z.string().datetime({ offset: false }),
  prState: wsDesiredPrStateSchema,
  branch: z.string().min(1).optional(),
});
export type WsDesiredWorkspace = z.infer<typeof wsDesiredWorkspaceSchema>;

/**
 * Response of `GET /api/myrmidon/bots/me/workspaces` (auth: the bot's
 * PAPERCLIP_API_KEY). 401/403: the key is invalid — botd keeps all local state
 * (fail-safe, nothing is deleted). 503: board down — same fail-safe.
 */
export const wsDesiredStateSchema = z.object({
  generatedAt: z.string().datetime({ offset: false }),
  grace: z.object({
    closingMinutes: z.number().int().positive(),
    scratchTtlHours: z.number().int().positive(),
    orphanHours: z.number().int().positive(),
  }),
  pressure: z.object({
    quotaPercent: z.number().min(0).max(100).nullable(),
    partitionPercent: z.number().min(0).max(100),
    level: wsDiskPressureLevelSchema,
  }),
  workspaces: z.array(wsDesiredWorkspaceSchema),
});
export type WsDesiredState = z.infer<typeof wsDesiredStateSchema>;

// ---------------------------------------------------------------------------
// C4. Disk report: POST /api/myrmidon/bots/me/disk-report
// ---------------------------------------------------------------------------

/** Result of one container self-check (`true`/`false`; `null` = not run). */
export const wsSelfCheckValueSchema = z.boolean().nullable();

export const wsSelfChecksSchema = z.object({
  /** reflink from the pnpm store into /workspace, /scratch and /data/hermes. */
  reflink: wsSelfCheckValueSchema,
  /** task copy is a worktree of the class-D base, not a full clone. */
  gitref: wsSelfCheckValueSchema,
  /** `myr-ws` binary present and `list --json` parses. */
  wsCli: wsSelfCheckValueSchema,
});
export type WsSelfChecks = z.infer<typeof wsSelfChecksSchema>;

export const wsReportCopyClassSchema = z.enum(["E", "G", "X"]);
export type WsReportCopyClass = z.infer<typeof wsReportCopyClassSchema>;

export const wsReportCopySchema = z.object({
  path: z.string().min(1),
  class: wsReportCopyClassSchema,
  key: z.string().min(1).optional(),
  repo: myrWsRepoNameSchema.optional(),
  branch: z.string().min(1).optional(),
  clean: z.boolean().nullable(),
  pushed: z.boolean().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  ageSec: z.number().int().nonnegative(),
  /** Why a class-X copy exists or a removal was skipped. */
  reason: z.string().max(500).optional(),
});
export type WsReportCopy = z.infer<typeof wsReportCopySchema>;

export const wsReportBaseSchema = z.object({
  repo: myrWsRepoNameSchema,
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative().nullable(),
  lastFetchAt: z.string().datetime({ offset: false }).nullable(),
});
export type WsReportBase = z.infer<typeof wsReportBaseSchema>;

export const wsReportArchiveSchema = z.object({
  key: z.string().min(1),
  path: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.string().datetime({ offset: false }),
});
export type WsReportArchive = z.infer<typeof wsReportArchiveSchema>;

export const wsReportActionSchema = z.object({
  at: z.string().datetime({ offset: false }),
  action: z.enum(["remove", "archive", "restore", "open", "skip"]),
  path: z.string().min(1),
  result: z.enum(["ok", "error", "skipped"]),
  detail: z.string().max(500).optional(),
});
export type WsReportAction = z.infer<typeof wsReportActionSchema>;

/** Why a copy does not match the registry/desired state. */
export const wsForeignSignSchema = z.enum([
  "promisor",
  "token",
  "no-remote",
  "trash",
  "full-clone",
]);
export type WsForeignSign = z.infer<typeof wsForeignSignSchema>;

export const wsReportForeignSchema = z.object({
  path: z.string().min(1),
  sign: wsForeignSignSchema,
});
export type WsReportForeign = z.infer<typeof wsReportForeignSchema>;

/**
 * Body of `POST /api/myrmidon/bots/me/disk-report`. The body is capped at 1 MiB
 * (413 above); the report is a snapshot, not a log — `actions` holds at most
 * the last 200 actions of the pass.
 */
export const wsDiskReportSchema = z.object({
  schema: z.literal(1),
  botKey: z.string().min(1).max(200),
  imageGeneration: z.string().min(1).max(100),
  at: z.string().datetime({ offset: false }),
  selfChecks: wsSelfChecksSchema,
  bases: z.array(wsReportBaseSchema),
  copies: z.array(wsReportCopySchema),
  archives: z.array(wsReportArchiveSchema),
  actions: z.array(wsReportActionSchema),
  foreign: z.array(wsReportForeignSchema),
});
export type WsDiskReport = z.infer<typeof wsDiskReportSchema>;

/** Answer of the report route; `nextReportSec` paces the next botd pass. */
export const wsDiskReportResponseSchema = z.object({
  ok: z.literal(true),
  nextReportSec: z.number().int().positive(),
});
export type WsDiskReportResponse = z.infer<typeof wsDiskReportResponseSchema>;

/** Body cap of the report route (bytes). */
export const WS_DISK_REPORT_MAX_BODY_BYTES = 1024 * 1024;

/** At most this many actions per report. */
export const WS_DISK_REPORT_MAX_ACTIONS = 200;

// ---------------------------------------------------------------------------
// C5. dockergate: GET /myrmidon/disk, PUT /myrmidon/disk/<botKey>/quota
// ---------------------------------------------------------------------------

export const wsDiskPartitionSchema = z.object({
  mount: z.string().min(1),
  totalBytes: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  freeBytes: z.number().int().nonnegative(),
  usedPercent: z.number().min(0).max(100),
});
export type WsDiskPartition = z.infer<typeof wsDiskPartitionSchema>;

export const wsDiskProjectSchema = z.object({
  botKey: z.string().min(1).max(200),
  projectId: z.number().int().nonnegative(),
  usedBytes: z.number().int().nonnegative(),
  softBytes: z.number().int().nonnegative(),
  hardBytes: z.number().int().nonnegative(),
});
export type WsDiskProject = z.infer<typeof wsDiskProjectSchema>;

/**
 * Answer of dockergate `GET /myrmidon/disk` (route id A14). `projects` is empty
 * and `quotaEnabled` false when the bot partition is mounted without prjquota.
 */
export const wsDiskApiResponseSchema = z.object({
  partition: wsDiskPartitionSchema,
  projects: z.array(wsDiskProjectSchema),
  /** Used bytes not attributable to any project. */
  other: z.object({ usedBytes: z.number().int().nonnegative() }),
  quotaEnabled: z.boolean(),
  at: z.string().datetime({ offset: false }),
});
export type WsDiskApiResponse = z.infer<typeof wsDiskApiResponseSchema>;

/** dockergate quota bounds: [64 MiB; 1 TiB]. */
export const WS_QUOTA_MIN_BYTES = 64 * 1024 * 1024;
export const WS_QUOTA_MAX_BYTES = 1024 * 1024 * 1024 * 1024;

/** Body of dockergate `PUT /myrmidon/disk/<botKey>/quota` (route id A15). */
export const wsDiskQuotaPutRequestSchema = z.object({
  bytes: z.number().int().min(WS_QUOTA_MIN_BYTES).max(WS_QUOTA_MAX_BYTES),
});
export type WsDiskQuotaPutRequest = z.infer<typeof wsDiskQuotaPutRequestSchema>;

export const wsDiskQuotaPutResponseSchema = z.object({
  ok: z.literal(true),
  projectId: z.number().int().nonnegative(),
  hardBytes: z.number().int().nonnegative(),
});
export type WsDiskQuotaPutResponse = z.infer<typeof wsDiskQuotaPutResponseSchema>;

/** Stable deny codes of the dockergate disk routes. */
export const WS_DOCKERGATE_DENY = {
  routeNotAllowed: "route_not_allowed",
  quotaUnavailable: "quota_unavailable",
  badQuota: "bad_quota",
} as const;
export type WsDockergateDenyCode = (typeof WS_DOCKERGATE_DENY)[keyof typeof WS_DOCKERGATE_DENY];

// ---------------------------------------------------------------------------
// C6. /v1/runs: the `workspace` field
// ---------------------------------------------------------------------------

/**
 * The `workspace` field of a `/v1/runs` request. Absent for a task without a
 * repository. `repo` is `owner/name`; `baseRef` is optional (default: the
 * repository's default branch).
 */
export const runWorkspaceFieldSchema = z.object({
  key: myrWsIssueKeySchema,
  repo: myrWsRepoNameSchema,
  baseRef: myrWsGitBaseRefSchema.optional(),
});
export type RunWorkspaceField = z.infer<typeof runWorkspaceFieldSchema>;

/**
 * What the gateway does with the field before starting the model:
 * `myr-ws open <key> <repo> [--base <baseRef>] --json`, then the run starts
 * with `MYRMIDON_TASK_WORKSPACE=/workspace/<key>` and that directory as cwd.
 * Exit codes 3/4/5 never fail the run silently: it starts in `/scratch` with a
 * warning event instead.
 */
export const RUN_WORKSPACE_FALLBACK_DIR = "/scratch";

// ---------------------------------------------------------------------------
// C7. Settings and card keys
// ---------------------------------------------------------------------------

/** `instance_settings.general.botDisk.*` keys this project adds (defaults). */
export const WS_BOT_DISK_SETTING_DEFAULTS = {
  graceClosingMinutes: 30,
  scratchTtlHours: 24,
  partitionThresholdPercent: 85,
  partitionRefuseOpenPercent: 90,
  partitionCriticalPercent: 95,
} as const;

// myrmidon(1.6.6-SETTINGS-UI-B): the five workspace-lifecycle fields exported
// individually, so `myrmidon-bot-disk.ts` validates the same stored object with
// the same ranges instead of duplicating them (one source of truth).
export const wsGraceClosingMinutesSchema = z.number().int().min(5).max(24 * 60);
export const wsScratchTtlHoursSchema = z.number().int().min(1).max(24 * 30);
export const wsPartitionPercentSchema = z.number().int().min(50).max(100);

export const wsBotDiskSettingsSchema = z
  .object({
    graceClosingMinutes: wsGraceClosingMinutesSchema.optional(),
    scratchTtlHours: wsScratchTtlHoursSchema.optional(),
    partitionThresholdPercent: wsPartitionPercentSchema.optional(),
    partitionRefuseOpenPercent: wsPartitionPercentSchema.optional(),
    partitionCriticalPercent: wsPartitionPercentSchema.optional(),
    /** Where pnpm keeps its store; must sit on the bot partition (C1/H8). */
    pnpmStoreDir: z.string().min(1).optional(),
    /** How pnpm imports a package into a clone; `clone` = reflink-only. */
    pnpmImportMethod: z.enum(["hardlink", "clone", "clone-or-copy", "copy"]).optional(),
  })
  .passthrough();
export type WsBotDiskSettings = z.infer<typeof wsBotDiskSettingsSchema>;

/**
 * Card keys (dedup) of `bot_disk_lifecycle/*` plus the standalone cards this
 * project raises. The payload always carries `botKey` and `at`; the rest of the
 * payload is per card.
 */
export const WS_CARD_KEYS = {
  agentSilent: "bot_disk_lifecycle/agent-silent",
  drift: "bot_disk_lifecycle/drift",
  foreign: "bot_disk_lifecycle/foreign",
  wsCli: "bot_disk_lifecycle/ws-cli",
  reflink: "bot_disk_lifecycle/reflink",
  imageStale: "bot_image_stale",
  archive: "bot_disk_archive",
} as const;
export type WsCardKey = (typeof WS_CARD_KEYS)[keyof typeof WS_CARD_KEYS];
