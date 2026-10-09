import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";
import { shapeWithoutDefaults } from "./partial.js";
// myrmidon(WORKSPACE-HYGIENE): workspace disk quotas that can be changed while the server runs
import { workspaceHygieneLimitsSchema } from "../myrmidon-workspace-hygiene.js";
import { hostDiskSettingsSchema } from "../myrmidon-host-disk.js";
// myrmidon(BOT-DISK-A): bot draft-directory lifecycle settings, lenient stored shape
import { storedBotDiskSettingsSchema } from "../myrmidon-bot-disk.js";
// myrmidon(1.6.1-BOT-DISK-C): the per-bot disk quota stored in the same general settings row.
import { storedBotDiskQuotaSettingsSchema } from "../myrmidon-bot-disk-quota.js";
// myrmidon(BOT-ROLLOUT): the release bot-image rollout settings stored in the same row.
import { storedBotImageRolloutSettingsSchema } from "../myrmidon-bot-image-rollout.js";
// myrmidon(PERF-DIET-K): issue-scoped session-generation thresholds, lenient stored shape
import { storedSessionGenerationsSettingsSchema } from "../myrmidon-session-generations.js";
// myrmidon(C0): run admission limits that can be changed while the server runs
import { storedRunLimitsSchema } from "../myrmidon-runtime-limits.js";
// myrmidon(1.6.5 RUN-PRIORITY A): the stored run queue priority shape (role/issue/release/aging).
import { storedRunPrioritySchema } from "../myrmidon-run-priority.js";
// myrmidon(RUN-STALL-SETTINGS): the run stall detection settings stored in instance settings
import { runStallSettingsSchema } from "../myrmidon-run-stall.js";
// myrmidon(PARALLEL-HELPERS): company ceiling/default for parallel helper
// subagents, changed from the instance settings page and /api/myrmidon/parallel-helpers.
import { parallelHelpersSettingsSchema, patchParallelHelpersSettingsSchema } from "../myrmidon-parallel-helpers.js";
// myrmidon(BOT-LSP-DEFAULTS): the language-server mode per role, changed from the instance
// settings page and /api/myrmidon/bot-lsp.
import { botLspSettingsSchema } from "../myrmidon-bot-lsp.js";
// myrmidon(EXTCASE-B): the browser-bridge allowlist stored in the same general settings row
import { browserBridgeSettingsSchema } from "../myrmidon-browser-bridge.js";
import { swarmClaimSettingsSchema } from "../myrmidon-swarm-claim.js";
// myrmidon(1.6.5 F-26 T10 SCENT): the general.swarm.scent settings block
import { scentSettingsSchema } from "../myrmidon-scent.js";
// myrmidon(1.6.5 F-26 T5): the SWARM wake guard (taskless gate + cooling) stored
// in the same general settings row under `general.swarm`.
import { swarmSettingsSchema } from "../myrmidon-swarm-wake.js";
import { datastoreCareSettingsSchema } from "../myrmidon-datastore-care.js"; // myrmidon(1.6.5-DBC1)
// myrmidon(1.6.1-WIP-LIMIT-A): the per-agent WIP limit settings stored in the
// same general settings row.
import { wipLimitSettingsSchema } from "../myrmidon-wip-limit.js";
// myrmidon(1.6.5-OWNER-DM-FILTER)
import { ownerDeliverySettingsSchema } from "../myrmidon-owner-delivery.js";
// myrmidon(F16): the issue-list agent defaults stored in the same general
// settings row (absent = the fix on; `{enabled: false}` = the pre-fix agent
// behaviour).
import { issueListAgentDefaultsSchema } from "../myrmidon-issue-list-agent-defaults.js";
// myrmidon(REVIEW-ROUTING): the automatic reviewer routing settings stored in the same row.
import { reviewRoutingSettingsSchema } from "../myrmidon-review-routing.js";
// myrmidon(REVIEW-REWORK): the review-return loop settings stored in the same row.
import { reviewReworkSettingsSchema } from "../myrmidon-review-rework.js";
// myrmidon(1.7-BUDGET-CONFIG-B): the budget enforcement mode stored in the
// same general settings row.
import { budgetEnforcementSettingsSchema } from "../myrmidon-budget-enforcement.js";
// myrmidon(MEMORY-UI): the agent memory settings stored in the same row.
import { agentMemorySettingsSchema } from "../myrmidon-agent-memory.js";
// myrmidon(PAUSE-GUARD): the forgotten-pause guard settings stored in the same
// general settings row (the sweep reads them through this schema).
import { storedPauseGuardSettingsSchema } from "../myrmidon-pause-guard.js";
// myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys stored
// in the same general settings row.
import { pluginEntitlementKeysSchema } from "../myrmidon-plugin-entitlement.js";
// myrmidon(DM-PROGRESS): live progress steps of the bridged Telegram DM status
// message, stored in the same general settings row.
import { telegramDmProgressSettingsSchema } from "../myrmidon-telegram-dm-progress.js";
// myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language of the
// bridged Telegram DM, changed from Settings → Language and
// /api/myrmidon/bridge-language.
import { bridgeLanguageSettingsSchema } from "../myrmidon-bridge-language.js";
// myrmidon(1.6.1-FORAGING-LIMITS-UI)
import { foragingSettingsSchema } from "../myrmidon-foraging.js";
// myrmidon(TEAM-LIVENESS-SETTINGS): the knobs of the three automatic team-liveness
// behaviours, changed from the instance settings page and /api/myrmidon/team-liveness.
import {
  patchTeamLivenessSettingsSchema,
  storedTeamLivenessSettingsSchema,
} from "../myrmidon-team-liveness.js";
// myrmidon(1.6.3 PROMPT-BUDGET B): the prompt-budget thresholds (warn/crit
// percent of the model window, fallback window, optimizer agent) stored in the
// same general settings row.
import { promptBudgetSettingsSchema } from "../myrmidon-prompt-budget.js";
import { budgetLimitsSettingsSchema } from "../myrmidon-budget-limits.js";
// myrmidon(1.6.1-BOT-DISK-D): shared mount settings stored in the same general settings row
import { sharedMountSettingsSchema } from "../myrmidon-shared-mount.js";
import { foragingIdleGateSettingsSchema } from "../myrmidon-foraging-idle-gate.js";

// myrmidon(1.6.5 BOT-RUNTIME-TUNING D2): the fallback-signal settings (switch,
// threshold percent, minimum calls, window and sweep interval) stored in the
// same general settings row.
import { storedFallbackSignalSettingsSchema } from "../myrmidon-fallback-signal.js";
// myrmidon(DB-PERF-C-P4): the TTL of the tool gateway policy cache, stored in
// the same general settings row.
import { toolPolicyCacheSettingsSchema } from "../myrmidon-tool-policy-cache.js";

// myrmidon(PARALLEL-HELPERS): re-exported for the barrel so the settings page and the
// /api/myrmidon/parallel-helpers route validate with the exact schema stored here.
export { parallelHelpersSettingsSchema, patchParallelHelpersSettingsSchema };

// myrmidon(TEAM-LIVENESS-SETTINGS): the same for /api/myrmidon/team-liveness — the route
// and the settings page must validate with the schema the row is stored under.
export { patchTeamLivenessSettingsSchema, storedTeamLivenessSettingsSchema };

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
  // myrmidon(BACKUP-KEEP-LAST): "keep only the last verified backup" mode;
  // absent/false keeps tiered retention. Additive — old payloads parse unchanged.
  keepLastOnly: z.boolean().optional(),
});

// myrmidon(1.6.5 PROCS-0.1): `general.processes`. Every field has a default and
// the defaults are the single-process board: nothing changes until an operator
// explicitly switches `mode` to `split`.
export const boardProcessesSettingsSchema = z.object({
  mode: z.enum(["single", "split"]).default("single"),
  apiCount: z.number().int().min(1).max(4).default(1),
  leaderLeaseTtlSec: z.number().int().min(5).max(300).default(30),
  liveEventsBus: z.enum(["local", "pg"]).default("local"),
  admissionStore: z.enum(["memory", "db"]).default("memory"),
  singletonProxy: z.boolean().default(true),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  // Execution policy. Absent/"any" = unrestricted; "kubernetes" forces the
  // Kubernetes sandbox provider and denies local/ssh execution (cloud_tenant).
  executionMode: z.enum(["kubernetes", "any"]).optional(),
  // myrmidon(WORKSPACE-HYGIENE): disk quotas for execution workspaces, changed
  // from /api/myrmidon/workspace-hygiene; absent means "use the environment
  // variable, then the default (both quotas off)".
  workspaceHygiene: workspaceHygieneLimitsSchema.optional(),
  // myrmidon(C0): run admission limits changed from the instance settings
  // page and /api/myrmidon/runtime-limits; absent means "use the environment
  // variable, then the default" (see packages/shared/src/myrmidon-runtime-limits.ts).
  // myrmidon(1.6.2 RUN-ADMISSION): the stored shape, so a row saved before
  // `minFreeHostMemoryMb` existed still parses (a strict miss here would fail
  // the whole general block and the next write would drop every setting).
  // myrmidon(1.6.5 RUN-ADMISSION): the shape also tolerates a row saved
  // before `maxHostLoadPercentPerCore` existed.
  runLimits: storedRunLimitsSchema.optional(),
  // myrmidon(1.6.5 RUN-PRIORITY A): the stored run queue priority settings,
  // changed from /api/myrmidon/run-priority; absent means "use the environment
  // variable, then the default". Lenient: like the runtime-limits row, a row
  // saved before a key existed still parses.
  runPriority: storedRunPrioritySchema.optional(),
  // myrmidon(RUN-STALL-SETTINGS): the run stall detection settings, changed
  // from the instance settings page and /api/myrmidon/run-stall; absent means
  // "use the environment variable, then the default" (see
  // packages/shared/src/myrmidon-run-stall.ts). Canonical: every key present,
  // numbers whole and in range, so a strict miss here cannot hide behind an
  // older row — the key did not exist before 1.6.5.
  runStall: runStallSettingsSchema.optional(),
  // myrmidon(BOT-DISK E): the host disk usage threshold, changed from
  // /api/myrmidon/host-disk; absent means "use the environment variable, then
  // the default (85)".
  hostDisk: hostDiskSettingsSchema.optional(),
  // myrmidon(1.6.5-DBC1): the datastore-care block (the retention sub-block
  // with the run-context compaction window), changed from
  // /api/myrmidon/datastore-care; absent means "use the environment
  // variable, then the default" (see packages/shared/src/myrmidon-datastore-care.ts).
  datastoreCare: datastoreCareSettingsSchema.optional(),
  // myrmidon(BOT-DISK-A): the bot draft-directory lifecycle (enabled, idle TTL),
  // changed from /api/myrmidon/bot-disk; absent means "use the environment
  // variable, then the default". Lenient: a row without the key, with unknown
  // keys or with an invalid value still parses (see myrmidon-bot-disk.ts).
  botDisk: storedBotDiskSettingsSchema,
  // myrmidon(1.6.1-BOT-DISK-C): the per-bot disk quota, changed from
  // /api/myrmidon/bot-disk-quota; absent means "no quota" (enforcement off).
  // Lenient: an invalid value reads as absent (see myrmidon-bot-disk-quota.ts).
  botDiskQuota: storedBotDiskQuotaSettingsSchema,
  // myrmidon(BOT-ROLLOUT): the release bot-image rollout settings (busy-wait
  // timeout, batch size, soft pause), changed from /api/myrmidon/bot-image-rollout;
  // absent means \"use the environment variable, then the default\". Lenient: an
  // invalid value reads as absent (see myrmidon-bot-image-rollout.ts).
  myrmidonBotImageRollout: storedBotImageRolloutSettingsSchema,
  // myrmidon(PERF-DIET-K): thresholds of the issue-scoped session generations
  // of a container bot, read at every run dispatch; absent means the plan's
  // defaults (400 runs / 14 days, the fix on). Lenient: an invalid value reads
  // as absent (see myrmidon-session-generations.ts).
  sessions: storedSessionGenerationsSettingsSchema,
  // myrmidon(PARALLEL-HELPERS): company ceiling and default for the "Parallel
  // helpers" block on an agent card, changed from the instance settings page
  // and /api/myrmidon/parallel-helpers; absent means the module defaults apply
  // (see packages/shared/src/myrmidon-parallel-helpers.ts).
  parallelHelpers: parallelHelpersSettingsSchema.optional(),
  // myrmidon(BOT-LSP-DEFAULTS): which roles write code and which language-server
  // mode coding and non-coding bots run with, changed from the instance settings
  // page and /api/myrmidon/bot-lsp; absent means the module defaults apply (see
  // packages/shared/src/myrmidon-bot-lsp.ts).
  botLsp: botLspSettingsSchema.optional(),
  // myrmidon(EXTCASE-B): browser-bridge allowlist changed from the bridge panel;
  // absent means "no domain is allowed" (deny by default).
  browserBridge: browserBridgeSettingsSchema.optional(),
  // myrmidon(1.6-SWARM): the swarm (self-organisation) — the on/off switch, the
  // lease TTL, the per-agent ceiling and the sweep interval, changed from
  // /api/myrmidon/swarm-claim; absent means "use the environment variable, then
  // the built-in default".
  swarmClaim: swarmClaimSettingsSchema.optional(),
  // myrmidon(1.6.5 F-26 T5 + T10): the swarm block — one namespace for the
  // swarm family. T5 owns the wake guard (run-without-task gate and the
  // exponential cooling of stale wake candidates, design 1.6.5 §3.7, §4.3);
  // T10 owns `general.swarm.scent` (classifier model, weights, switch).
  // Absent means the module defaults.
  swarm: swarmSettingsSchema
    .extend({
      scent: scentSettingsSchema.optional(),
    })
    .optional(),
  // myrmidon(1.6.1 SWARM-SETTINGS-UI): the change journal of the swarm
  // settings (who changed what, and when), kept by the settings service
  // under `general.swarmClaimJournal` and read by GET /api/myrmidon/swarm-claim.
  // Stored passthrough, never validated here beyond being a list-shaped value
  // the service re-reads defensively.
  swarmClaimJournal: z.array(z.unknown()).optional(),
  // myrmidon(1.6.1-WIP-LIMIT-A): per-agent WIP limits — the company default and
  // per-agent overrides, changed from /api/myrmidon/companies/:id/wip-limit/settings;
  // absent means the feature counts but never signals (all limits null).
  wipLimit: wipLimitSettingsSchema.optional(),
  // myrmidon(1.6.5-OWNER-DM-FILTER): the owner-DM delivery filter mode,
  // changed from /api/myrmidon/owner-delivery; absent means the default
  // "via_bot" (1.6.5-OWNER-VIA-BOT: no card, the author's message instead).
  ownerDelivery: ownerDeliverySettingsSchema.optional(),
  // myrmidon(REVIEW-ROUTING): automatic reviewer routing, changed from
  // /api/myrmidon/companies/:id/review-routing/settings; absent means the defaults.
  reviewRouting: reviewRoutingSettingsSchema.optional(),
  // myrmidon(REVIEW-REWORK): the review-return loop (RETURN verdict -> rework
  // task; review blocked until the PR head moves), changed from
  // /api/myrmidon/review-rework; absent means the defaults (the fix is on).
  reviewRework: reviewReworkSettingsSchema.optional(),
  // myrmidon(F16): the issue-list agent defaults (compact view, limit 200/500,
  // description omitted in compact), read at the list route; absent means the
  // fix is ON — `{enabled: false}` restores the pre-feature agent behaviour
  // byte-for-byte (see packages/shared/src/myrmidon-issue-list-agent-defaults.ts).
  issuesListAgentDefaults: issueListAgentDefaultsSchema.optional(),
  // myrmidon(PAUSE-GUARD): the forgotten-pause guard (enabled, threshold,
  // interval, allowlist, per-pass ceiling), changed from
  // /api/myrmidon/pause-guard; absent means "use the environment variable, then
  // the defaults" (see packages/shared/src/myrmidon-pause-guard.ts). Lenient
  // shape: a row saved before a key existed still parses.
  pauseGuard: storedPauseGuardSettingsSchema.optional(),
  // myrmidon(REVIEW-REWORK): the change journal of the loop settings, kept by
  // the settings service under `general.reviewReworkJournal` and read by
  // GET /api/myrmidon/review-rework. Stored passthrough, like swarmClaimJournal.
  reviewReworkJournal: z.array(z.unknown()).optional(),
  // myrmidon(1.7-SETTINGS-TO-UI): the channel settings document (the Telegram
  // bridge switches, the chat limits, the cross-channel numbers), changed from
  // /api/myrmidon/channel-settings; absent means "use the environment variable,
  // then the default". Passthrough on purpose: the resolver in
  // server/src/myrmidon/channel-settings/settings.ts re-reads it defensively, so
  // a row written by an older or a newer version still parses.
  channelSettings: z.unknown().optional(),
  // myrmidon(1.7-BUDGET-CONFIG-B): what a crossed budget limit does while the
  // incident is open — signal only (default), pause with an owner card (soft),
  // or refuse new runs with the budget reason (hard); changed from
  // /api/myrmidon/budget-enforcement; absent means the default (signal only).
  budgetEnforcement: budgetEnforcementSettingsSchema.optional(),
  // how far back unresolved failed/timed-out runs may enter the
  // attention feed (default 7 days); written from the instance settings page,
  // read by server/src/services/attention.ts. Absent means the default.
  attentionFailedRunHorizonDays: z.number().int().min(1).max(365).optional(),
  // TTL in seconds of the in-process attention-feed cache
  // (default 45 s; 0 disables). Stale-by-TTL writes (dismiss and friends) stay
  // invisible until the entry expires — see the comment in attention.ts.
  attentionFeedCacheTtlSeconds: z.number().int().min(0).max(300).optional(),
  // myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys, managed
  // from the instance settings page and PATCH /api/myrmidon/plugin-entitlement/keys;
  // absent means "no keys are registered" (no plugin is unlocked).
  pluginEntitlementKeys: pluginEntitlementKeysSchema.optional(),
  // myrmidon(DM-PROGRESS): live progress steps in the bridged Telegram DM status
  // message (on/off and the minimum spacing between edits), changed from
  // /api/myrmidon/telegram-dm-progress; absent means the defaults.
  telegramDmProgress: telegramDmProgressSettingsSchema.optional(),
  // myrmidon(1.6.5-TG-LOCALE-C): the instance-wide default language of the
  // bridged Telegram DM (the fallback for a board user with no stored
  // `user_ui_language` row), changed from Settings → Language and
  // /api/myrmidon/bridge-language; absent means "use the environment force,
  // then English".
  bridgeLanguage: bridgeLanguageSettingsSchema.optional(),
  // myrmidon(MEMORY-UI): agent card Memory tab — service address, optional key
  // secret name and the switch, changed from the instance settings page and
  // /api/myrmidon/agent-memory; absent means "use the environment".
  agentMemory: agentMemorySettingsSchema.optional(),
  teamLiveness: storedTeamLivenessSettingsSchema.optional(),
  // myrmidon(1.6.3 PROMPT-BUDGET B): prompt-budget thresholds, changed from
  // /api/myrmidon/companies/:id/prompt-budget/settings; absent means the
  // defaults (warn 70, crit 90, enabled, 200k fallback window).
  promptBudget: promptBudgetSettingsSchema.optional(),
  // myrmidon(1.6.1-BOT-DISK-D): shared mount settings changed from the instance
  // settings API; absent means "the shared mount is disabled" (deny by default).
  sharedMount: sharedMountSettingsSchema.optional(),
  // myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the pass journal — the last
  // passes of every company (what each read, and which roles were skipped why),
  // kept by the foraging pass under `general.foragingPassJournal` and read by
  // GET /api/myrmidon/companies/:id/foraging/passes. Stored passthrough, never
  // validated here beyond being a list-shaped value the service re-reads
  // defensively.
  foragingPassJournal: z.array(z.unknown()).optional(),
  // myrmidon(1.6.5 BOT-RUNTIME-TUNING D2): the fallback-signal settings, changed
  // from /api/myrmidon/model-fallback/settings; absent means "use the
  // environment variable, then the default" (see
  // packages/shared/src/myrmidon-fallback-signal.ts).
  modelFallbackSignal: storedFallbackSignalSettingsSchema.optional(),
  // myrmidon(1.7-BUDGET-CONFIG A): the global "signal only" flag of the
  // per-level spend limits, changed from PATCH …/budget-limits/signal-only;
  // absent means the default (signal only ON — limits never stop work).
  budgetLimits: budgetLimitsSettingsSchema.optional(),
  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the foraging switch and spend limits,
  // changed from /api/myrmidon/foraging-settings; absent means "use the
  // environment variable, then the default (the sweep is off)".
  foraging: foragingSettingsSchema.optional(),
  // myrmidon(DB-PERF-C-P4): TTL of the in-process cache behind the tool
  // gateway's policy, profile, binding and profile-entry reads, changed from
  // GET/PATCH /api/myrmidon/tool-policy-cache; absent means the default (30 s)
  // and `0` switches the cache off (every read is a fresh query).
  toolPolicyCache: toolPolicyCacheSettingsSchema.optional(),
  // myrmidon(1.6.3-FORAGING-IDLE-GATE): whether foraging runs only when the
  // role is idle (empty queue + a free agent), changed from
  // /api/myrmidon/foraging/idle-gate; absent means the environment variable,
  // then the default (on).
  foragingIdleGate: foragingIdleGateSettingsSchema.optional(),
  // myrmidon(1.6.5 PROCS-0.1): the multi-process board mode (BOARD-PROCESSES),
  // edited at Instance settings -> Processes; absent means the defaults, which
  // are exactly today's single-process behavior (mode `single`).
  processes: boardProcessesSettingsSchema.optional(),
}).strict();

export const patchInstanceGeneralSettingsSchema = z
  .object(shapeWithoutDefaults(instanceGeneralSettingsSchema.shape))
  .partial()
  .strict();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableNativeRunner: z.boolean().default(true),
  enableManagedSandboxOnly: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  enableIsolatedWorkspacesByDefault: z.boolean().default(false),
  enableStreamlinedLeftNavigation: z.boolean().default(true),
  enableStreamlinedUi: z.boolean().default(true),
  // Deprecated compatibility key. Apps is a standard product surface and is
  // always enabled; this remains accepted so older stored rows and managed
  // configs continue to load during upgrades.
  enableApps: z.boolean().default(true),
  enableChatConnectors: z.boolean().default(false),
  enablePipelines: z.boolean().default(false),
  enableCases: z.boolean().default(false),
  enableAgentChat: z.boolean().default(false),
  enableConferenceRoomChat: z.boolean().default(false),
  enableClassicTaskInterface: z.boolean().default(false),
  enableIssuePlanDecompositions: z.boolean().default(false),
  enableExperimentalFileViewer: z.boolean().default(false),
  enableExternalObjects: z.boolean().default(false),
  enableSmokeLab: z.boolean().default(false),
  enableBuiltInAgents: z.boolean().default(false),
  enableBetaSkills: z.boolean().default(false),
  enableSummaries: z.boolean().default(false),
  enableStatusCards: z.boolean().default(false),
  enableDecisions: z.boolean().default(false),
  enableGoalsSidebarLink: z.boolean().default(false),
  enableServerInfoDebugView: z.boolean().default(false),
  enablePaperclipDeveloperMode: z.boolean().default(false),
  enableSimplifiedEnglishInteractions: z.boolean().default(false),
  enableFirstTaskPlanProposal: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableWorkspaceBranchReconcileForward: z.boolean().default(true),
  enableWorkspaceDirtyQuarantineRepair: z.boolean().default(true),
  // myrmidon(UI-0a): UI-2.0 shell flag — opt-in, default off. While off the
  // vendor 1.x shell renders unchanged; the ui2 tree mounts only under this
  // flag (owner decision 02.10: clean-room toward 2.0, parallel with 1.5).
  enableMyrmidonUi2: z.boolean().default(false),
  enableOwnerInstanceAdmin: z.boolean().default(false),
  // Kill switch for the sandbox duplex command-stream bridge. Default off. When
  // off the host keeps the file bridge for every run with no manifest change and
  // no redeploy. The host reads this per run before it selects the transport.
  enableSandboxDuplexBridge: z.boolean().default(false),
  // Deprecated compatibility key. Runner ingress follows enableNativeRunner;
  // this remains accepted so older stored rows and managed configs keep loading.
  enableRunnerPreviewIngress: z.boolean().default(false),
  enableWorktreeRunExecution: z.boolean().default(false),
  worktreeRunExecutionActivatedAt: z.string().datetime().nullable().default(null),
  worktreeRunExecutionActivationInstanceId: z.string().min(1).nullable().default(null),
}).strict();

export const patchInstanceExperimentalSettingsSchema = z
  .object(
    shapeWithoutDefaults(
      instanceExperimentalSettingsSchema
        .omit({
          worktreeRunExecutionActivatedAt: true,
          worktreeRunExecutionActivationInstanceId: true,
        })
        .shape,
    ),
  )
  .partial()
  .strip();

export const managedSettingMetadataSchema = z.object({
  managed: z.literal(true),
  managedBy: z.literal("paperclip-cloud"),
}).strict();

// Response shape of the experimental settings endpoints: on cloud-managed
// instances every overlaid key is listed in `managedKeys`; self-hosted
// responses omit the field entirely.
export const instanceExperimentalSettingsWithManagedSchema = instanceExperimentalSettingsSchema.extend({
  managedKeys: z.record(z.string(), managedSettingMetadataSchema).optional(),
}).strict();

export const patchInstanceSettingsSchema = z.object({
  defaultEnvironmentId: z.string().guid().nullable().optional(),
}).strict();

// The longest time a task drain can run before it expires on its own. A
// caller can send a shorter `ttlMs`, but not a longer one — the request must
// fail instead of the server silently clamping the value.
export const MAX_TASK_DRAIN_TTL_MS = 24 * 60 * 60 * 1000;

export const startTaskDrainRequestSchema = z.object({
  ttlMs: z.number().int().positive().max(MAX_TASK_DRAIN_TTL_MS).nullable().optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
// The patch schema removes each default so an absent key stays absent. Declare
// the type from the full settings type, so every field keeps its precise type.
export type PatchInstanceGeneralSettings = Partial<InstanceGeneralSettings>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = Partial<
  Omit<
    InstanceExperimentalSettings,
    "worktreeRunExecutionActivatedAt" | "worktreeRunExecutionActivationInstanceId"
  >
>;
export type PatchInstanceSettings = z.infer<typeof patchInstanceSettingsSchema>;
export type StartTaskDrainRequest = z.infer<typeof startTaskDrainRequestSchema>;

export const instanceSettingsSchema = z.object({
  id: z.string().guid(),
  defaultEnvironmentId: z.string().guid().nullable(),
  general: instanceGeneralSettingsSchema,
  experimental: instanceExperimentalSettingsWithManagedSchema,
  createdAt: z.union([z.date(), z.string().datetime()]),
  updatedAt: z.union([z.date(), z.string().datetime()]),
}).strict();
