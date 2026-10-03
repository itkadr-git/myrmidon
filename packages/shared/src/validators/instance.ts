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
// myrmidon(C0): run admission limits that can be changed while the server runs
import { storedRunLimitsSchema } from "../myrmidon-runtime-limits.js";
// myrmidon(PARALLEL-HELPERS): company ceiling/default for parallel helper
// subagents, changed from the instance settings page and /api/myrmidon/parallel-helpers.
import { parallelHelpersSettingsSchema, patchParallelHelpersSettingsSchema } from "../myrmidon-parallel-helpers.js";
// myrmidon(BOT-LSP-DEFAULTS): the language-server mode per role, changed from the instance
// settings page and /api/myrmidon/bot-lsp.
import { botLspSettingsSchema } from "../myrmidon-bot-lsp.js";
// myrmidon(EXTCASE-B): the browser-bridge allowlist stored in the same general settings row
import { browserBridgeSettingsSchema } from "../myrmidon-browser-bridge.js";
import { swarmClaimSettingsSchema } from "../myrmidon-swarm-claim.js";
// myrmidon(1.6.1-WIP-LIMIT-A): the per-agent WIP limit settings stored in the
// same general settings row.
import { wipLimitSettingsSchema } from "../myrmidon-wip-limit.js";
// myrmidon(REVIEW-ROUTING): the automatic reviewer routing settings stored in the same row.
import { reviewRoutingSettingsSchema } from "../myrmidon-review-routing.js";
// myrmidon(REVIEW-REWORK): the review-return loop settings stored in the same row.
import { reviewReworkSettingsSchema } from "../myrmidon-review-rework.js";
// myrmidon(1.7-BUDGET-CONFIG-B): the budget enforcement mode stored in the
// same general settings row.
import { budgetEnforcementSettingsSchema } from "../myrmidon-budget-enforcement.js";
// myrmidon(MEMORY-UI): the agent memory settings stored in the same row.
import { agentMemorySettingsSchema } from "../myrmidon-agent-memory.js";
// myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys stored
// in the same general settings row.
import { pluginEntitlementKeysSchema } from "../myrmidon-plugin-entitlement.js";
// myrmidon(DM-PROGRESS): live progress steps of the bridged Telegram DM status
// message, stored in the same general settings row.
import { telegramDmProgressSettingsSchema } from "../myrmidon-telegram-dm-progress.js";
// myrmidon(OPE-3789): the TG-NOTIFY settings document stored in the same
// general settings row (routes from part A, consumers in part D).
import { telegramNotifySettingsSchema } from "../myrmidon-telegram-notify.js";

// myrmidon(PARALLEL-HELPERS): re-exported for the barrel so the settings page and the
// /api/myrmidon/parallel-helpers route validate with the exact schema stored here.
export { parallelHelpersSettingsSchema, patchParallelHelpersSettingsSchema };

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
  // myrmidon(BOT-DISK E): the host disk usage threshold, changed from
  // /api/myrmidon/host-disk; absent means "use the environment variable, then
  // the default (85)".
  hostDisk: hostDiskSettingsSchema.optional(),
  // myrmidon(BOT-DISK-A): the bot draft-directory lifecycle (enabled, idle TTL),
  // changed from /api/myrmidon/bot-disk; absent means "use the environment
  // variable, then the default". Lenient: a row without the key, with unknown
  // keys or with an invalid value still parses (see myrmidon-bot-disk.ts).
  botDisk: storedBotDiskSettingsSchema,
  // myrmidon(1.6.1-BOT-DISK-C): the per-bot disk quota, changed from
  // /api/myrmidon/bot-disk-quota; absent means "no quota" (enforcement off).
  // Lenient: an invalid value reads as absent (see myrmidon-bot-disk-quota.ts).
  botDiskQuota: storedBotDiskQuotaSettingsSchema,
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
  // myrmidon(1.6-SWARM): per-role task queues with leased claims — the pilot flag,
  // the lease TTL, the per-agent ceiling and the sweep interval, changed from
  // /api/myrmidon/swarm-claim; absent means "use the environment variable, then
  // the default (the pilot is off)".
  swarmClaim: swarmClaimSettingsSchema.optional(),
  // myrmidon(1.6.1 SWARM-SETTINGS-UI): the change journal of the swarm-claim
  // pilot settings (who changed what, and when), kept by the settings service
  // under `general.swarmClaimJournal` and read by GET /api/myrmidon/swarm-claim.
  // Stored passthrough, never validated here beyond being a list-shaped value
  // the service re-reads defensively.
  swarmClaimJournal: z.array(z.unknown()).optional(),
  // myrmidon(1.6.1-WIP-LIMIT-A): per-agent WIP limits — the company default and
  // per-agent overrides, changed from /api/myrmidon/companies/:id/wip-limit/settings;
  // absent means the feature counts but never signals (all limits null).
  wipLimit: wipLimitSettingsSchema.optional(),
  // myrmidon(REVIEW-ROUTING): automatic reviewer routing, changed from
  // /api/myrmidon/companies/:id/review-routing/settings; absent means the defaults.
  reviewRouting: reviewRoutingSettingsSchema.optional(),
  // myrmidon(REVIEW-REWORK): the review-return loop (RETURN verdict -> rework
  // task; review blocked until the PR head moves), changed from
  // /api/myrmidon/review-rework; absent means the defaults (the fix is on).
  reviewRework: reviewReworkSettingsSchema.optional(),
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
  // myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys, managed
  // from the instance settings page and PATCH /api/myrmidon/plugin-entitlement/keys;
  // absent means "no keys are registered" (no plugin is unlocked).
  pluginEntitlementKeys: pluginEntitlementKeysSchema.optional(),
  // myrmidon(DM-PROGRESS): live progress steps in the bridged Telegram DM status
  // message (on/off and the minimum spacing between edits), changed from
  // /api/myrmidon/telegram-dm-progress; absent means the defaults.
  telegramDmProgress: telegramDmProgressSettingsSchema.optional(),
  // myrmidon(MEMORY-UI): agent card Memory tab — service address, optional key
  // secret name and the switch, changed from the instance settings page and
  // /api/myrmidon/agent-memory; absent means "use the environment".
  agentMemory: agentMemorySettingsSchema.optional(),
  // myrmidon(OPE-3789): TG-NOTIFY settings (digest/errors/inbound/escalations/
  // proactivity) changed from part A's routes; absent means every surface is
  // off (the 1.6.1 release criterion).
  telegramNotify: telegramNotifySettingsSchema.optional(),
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
