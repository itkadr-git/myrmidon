import type { FeedbackDataSharingPreference } from "./feedback.js";
// myrmidon(WORKSPACE-HYGIENE): the workspace quotas stored in instance settings
import type { WorkspaceHygieneLimits } from "../myrmidon-workspace-hygiene.js";
// myrmidon(C0): the run admission limits stored in instance settings
import type { StoredRunLimits } from "../myrmidon-runtime-limits.js";
import type { HostDiskSettings } from "../myrmidon-host-disk.js";
// myrmidon(BOT-DISK-A): the bot draft-directory lifecycle stored in instance settings
import type { StoredBotDiskSettings } from "../myrmidon-bot-disk.js";
// myrmidon(1.6.1-BOT-DISK-C): per-bot disk quota of its own general settings key.
import type { StoredBotDiskQuotaSettings } from "../myrmidon-bot-disk-quota.js";
// myrmidon(PARALLEL-HELPERS): the helper ceiling/default stored in instance settings
import type { ParallelHelpersSettings } from "../myrmidon-parallel-helpers.js";
import type { BotLspSettings } from "../myrmidon-bot-lsp.js";
// myrmidon(EXTCASE-B): the browser-bridge allowlist stored in instance settings
import type { BrowserBridgeSettings } from "../myrmidon-browser-bridge.js";
import type { SwarmClaimSettings } from "../myrmidon-swarm-claim.js";
// myrmidon(1.6.1-WIP-LIMIT-A): per-agent WIP limits of the same general settings row.
import type { AgentMemorySettings } from "../myrmidon-agent-memory.js";
import type { WipLimitSettings } from "../myrmidon-wip-limit.js";
// myrmidon(REVIEW-ROUTING): automatic reviewer routing settings of the same row.
import type { ReviewRoutingSettings } from "../myrmidon-review-routing.js";
import type { ReviewReworkSettings } from "../myrmidon-review-rework.js";
import type { BudgetEnforcementSettings } from "../myrmidon-budget-enforcement.js";
// myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys live in
// the same general settings row.
import type { PluginEntitlementKey } from "../myrmidon-plugin-entitlement.js";
// myrmidon(DM-PROGRESS): live progress steps of the bridged Telegram DM status message.
import type { TelegramDmProgressSettings } from "../myrmidon-telegram-dm-progress.js";

export const DAILY_RETENTION_PRESETS = [3, 7, 14] as const;
export const WEEKLY_RETENTION_PRESETS = [1, 2, 4] as const;
export const MONTHLY_RETENTION_PRESETS = [1, 3, 6] as const;
export interface BackupRetentionPolicy {
  dailyDays: (typeof DAILY_RETENTION_PRESETS)[number];
  weeklyWeeks: (typeof WEEKLY_RETENTION_PRESETS)[number];
  monthlyMonths: (typeof MONTHLY_RETENTION_PRESETS)[number];
}

export const DEFAULT_BACKUP_RETENTION: BackupRetentionPolicy = {
  dailyDays: 7,
  weeklyWeeks: 4,
  monthlyMonths: 1,
};

/**
 * Instance-wide execution policy.
 *
 * - `"any"` (default / absent): unrestricted — any environment driver (local,
 *   ssh, sandbox) may run agents. Preserves single-tenant / local-trusted
 *   behavior.
 * - `"kubernetes"`: force ALL agent execution onto the Kubernetes
 *   sandbox-provider environment and REFUSE local/in-process execution. Used by
 *   shared cloud (cloud_tenant) instances so untrusted tenant agents can never
 *   run in the server process or on an unsandboxed local/ssh adapter.
 */
export type InstanceExecutionMode = "kubernetes" | "any";

export interface InstanceGeneralSettings {
  censorUsernameInLogs: boolean;
  keyboardShortcuts: boolean;
  feedbackDataSharingPreference: FeedbackDataSharingPreference;
  backupRetention: BackupRetentionPolicy;
  /**
   * Execution policy. Absent/`"any"` = unrestricted; `"kubernetes"` forces the
   * Kubernetes sandbox provider and denies local/ssh execution.
   */
  executionMode?: InstanceExecutionMode;
  /**
   * myrmidon(WORKSPACE-HYGIENE): disk quotas for execution workspaces, changed
   * from `GET`/`PATCH /api/myrmidon/workspace-hygiene`. Absent means "use the
   * environment variable, then the default (both quotas off)"; kept in sync with
   * the validator of the same field (packages/shared/src/validators/instance.ts).
   */
  workspaceHygiene?: WorkspaceHygieneLimits;
  /**
   * myrmidon(BOT-DISK E): the host disk usage threshold, changed from
   * `GET`/`PATCH /api/myrmidon/host-disk`. Absent means "use the environment
   * variable, then the default (85)"; kept in sync with the validator of the
   * same field (packages/shared/src/validators/instance.ts).
   */
  hostDisk?: HostDiskSettings;
  /**
   * myrmidon(BOT-DISK-A): the bot draft-directory lifecycle, changed from
   * `GET`/`PATCH /api/myrmidon/bot-disk`. Absent means "use the environment
   * variable, then the default"; kept in sync with the validator of the same
   * field (packages/shared/src/validators/instance.ts).
   */
  botDisk?: StoredBotDiskSettings;
  /**
   * myrmidon(1.6.1-BOT-DISK-C): per-bot disk quota (company default, per-caste
   * and per-agent overrides), changed from `GET`/`PATCH /api/myrmidon/bot-disk-quota`.
   * Its own key, not a sub-key of `botDisk`: part A's PATCH rewrites the whole
   * `botDisk` object. Absent means "no quota" (enforcement off); kept in sync
   * with the validator of the same field (packages/shared/src/validators/instance.ts).
   */
  botDiskQuota?: StoredBotDiskQuotaSettings;
  /**
   * myrmidon(C0): run admission limits changed from the instance settings page
   * and `GET`/`PATCH /api/myrmidon/runtime-limits`. Absent means "use the
   * environment variable, then the default"; kept in sync with the validator of
   * the same field (packages/shared/src/validators/instance.ts). A row saved
   * before 1.6.2 lacks `minFreeHostMemoryMb` (myrmidon 1.6.2 RUN-ADMISSION),
   * a row saved before 1.6.5 lacks `maxHostLoadPercentPerCore` (myrmidon
   * 1.6.5 RUN-ADMISSION).
   */
  runLimits?: StoredRunLimits;
  /**
   * myrmidon(PARALLEL-HELPERS): company ceiling/default for parallel helper
   * subagents, changed from the instance settings page and
   * `GET`/`PATCH /api/myrmidon/parallel-helpers`. Absent means "use the module
   * defaults" (ceiling 10, default 2 — see
   * packages/shared/src/myrmidon-parallel-helpers.ts); kept in sync with the
   * validator of the same field.
   */
  parallelHelpers?: ParallelHelpersSettings;
  /**
   * myrmidon(BOT-LSP-DEFAULTS): which roles write code and which language-server
   * mode coding and non-coding bots run with, changed from the instance settings
   * page and `GET`/`PATCH /api/myrmidon/bot-lsp`. Absent means "use the module
   * defaults" (coding roles limited, every other role off — see
   * packages/shared/src/myrmidon-bot-lsp.ts); kept in sync with the validator of
   * the same field.
   */
  botLsp?: BotLspSettings;
  /**
   * myrmidon(EXTCASE-B): browser-bridge allowlist (the tender-platform domains
   * the gateway and the extension both accept), changed from the bridge panel.
   * Absent means "no domain is allowed" — the bridge denies by default.
   * Kept in sync with the validator of the same field
   * (packages/shared/src/validators/instance.ts).
   */
  browserBridge?: BrowserBridgeSettings;
  /**
   * myrmidon(1.6-SWARM): per-role queues with leased claims, changed from
   * `GET`/`PATCH /api/myrmidon/swarm-claim`. Absent means "use the environment
   * variable, then the default (the pilot is off)". Kept in sync with the
   * validator of the same field (packages/shared/src/validators/instance.ts).
   */
  swarmClaim?: SwarmClaimSettings;
  /**
   * myrmidon(1.6.1 SWARM-SETTINGS-UI): the change journal of the swarm-claim
   * pilot settings — who changed what, and when, newest first. Written by the
   * swarm-claim settings service on every PATCH, read by
   * GET /api/myrmidon/swarm-claim. Kept in sync with the validator of the
   * same field (packages/shared/src/validators/instance.ts).
   */
  swarmClaimJournal?: unknown[];
  /**
   * myrmidon(1.6.1-WIP-LIMIT-A): per-agent WIP limits, changed from
   * `GET`/`PUT /api/myrmidon/companies/:companyId/wip-limit/settings`. Absent
   * means "count only, never signal". Kept in sync with the validator of the
   * same field (packages/shared/src/validators/instance.ts).
   */
  wipLimit?: WipLimitSettings;
  /**
   * myrmidon(REVIEW-ROUTING): automatic reviewer routing, changed from
   * `GET`/`PUT /api/myrmidon/companies/:companyId/review-routing/settings`.
   * Absent means the defaults.
   */
  reviewRouting?: ReviewRoutingSettings;
  /**
   * myrmidon(REVIEW-REWORK): the review-return loop — a RETURN verdict opens
   * the rework task and the review waits blocked until the PR head moves,
   * changed from `GET`/`PATCH /api/myrmidon/review-rework`. Absent means the
   * defaults (the fix is on); kept in sync with the validator of the same
   * field (packages/shared/src/validators/instance.ts).
   */
  reviewRework?: ReviewReworkSettings;
  /**
   * myrmidon(REVIEW-REWORK): the change journal of the loop settings (who
   * changed what, and when), newest first. Stored passthrough, like
   * `swarmClaimJournal`.
   */
  reviewReworkJournal?: unknown[];
  /**
   * myrmidon(1.7-SETTINGS-TO-UI): the channel settings document — the Telegram
   * bridge switches, the chat limits and the cross-channel numbers, changed from
   * `GET`/`PATCH /api/myrmidon/channel-settings`. An absent (or partial) document
   * means "use the environment variable, then the default" for every key; the
   * resolver in server/src/myrmidon/channel-settings/settings.ts normalizes it,
   * so the stored value is read back defensively. Kept in sync with the
   * validator of the same field (packages/shared/src/validators/instance.ts).
   */
  channelSettings?: unknown;
  /**
   * myrmidon(1.7-BUDGET-CONFIG-B): what a crossed budget limit does —
   * signal only (default), pause with an owner card (soft), or refuse new
   * runs (hard); changed from `GET`/`PATCH /api/myrmidon/budget-enforcement`.
   * Kept in sync with the validator of the same field
   * (packages/shared/src/validators/instance.ts).
   */
  budgetEnforcement?: BudgetEnforcementSettings;
  /**
   * myrmidon(PLUGIN-ENTITLEMENT C): accepted plugin entitlement keys, managed
   * from the instance settings page. Absent means "no keys registered". Kept
   * in sync with the validator of the same field
   * (packages/shared/src/validators/instance.ts).
   */
  pluginEntitlementKeys?: PluginEntitlementKey[];
  /**
   * myrmidon(DM-PROGRESS): live progress steps in the bridged Telegram DM
   * status message — on/off and the minimum spacing between edits; changed
   * from `GET`/`PATCH /api/myrmidon/telegram-dm-progress`. Kept in sync with
   * the validator of the same field (packages/shared/src/validators/instance.ts).
   */
  telegramDmProgress?: TelegramDmProgressSettings;
  /**
   * myrmidon(MEMORY-UI): agent memory service address, optional key secret name
   * and switch, changed from the instance settings page. Absent means "use the
   * environment". Kept in sync with the validator of the same field.
   */
  agentMemory?: AgentMemorySettings;
}

export interface InstanceExperimentalSettings {
  enableEnvironments: boolean;
  /**
   * Exposes the experimental Paperclip Runner adapter for new selections.
   * Existing native runs ignore later flag changes so they remain recoverable.
   */
  enableNativeRunner: boolean;
  /**
   * Hide the local environment and run all agents in the platform-managed
   * sandbox environment. Run selection refuses local while this is on.
   */
  enableManagedSandboxOnly: boolean;
  enableIsolatedWorkspaces: boolean;
  /**
   * Move the execution workspace default for a project that carries no policy
   * of its own from the shared project checkout to an isolated per-task
   * worktree. Inert unless `enableIsolatedWorkspaces` is also on, and never
   * overrides a project that stores its own policy.
   */
  enableIsolatedWorkspacesByDefault: boolean;
  enableStreamlinedLeftNavigation: boolean;
  /**
   * Use the streamlined shell, navigation, and contextual-sidebar experience.
   * Missing legacy values default on; the retired left-navigation preference
   * remains separate so an old opt-out cannot disable the broader UI.
   */
  enableStreamlinedUi: boolean;
  /** @deprecated Compatibility key only. Apps is always enabled. */
  enableApps: boolean;
  /** Exposes chat connector setup and Board surfaces; existing delivery continues when hidden. */
  enableChatConnectors: boolean;
  enablePipelines: boolean;
  enableCases: boolean;
  enableAgentChat: boolean;
  enableConferenceRoomChat: boolean;
  enableClassicTaskInterface: boolean;
  enableIssuePlanDecompositions: boolean;
  enableExperimentalFileViewer: boolean;
  enableExternalObjects: boolean;
  enableSmokeLab: boolean;
  enableBuiltInAgents: boolean;
  enableBetaSkills: boolean;
  enableSummaries: boolean;
  enableStatusCards: boolean;
  enableDecisions: boolean;
  /**
   * myrmidon(UI-0a): the Myrmidon 2.0 shell (rail, top bar, phone bottom bar,
   * Commander entry). Strictly opt-in, default off; the 1.x shell renders
   * unchanged while this is false. Kept in sync with the validator default
   * (packages/shared/src/validators/instance.ts).
   */
  enableMyrmidonUi2: boolean;
  enableGoalsSidebarLink: boolean;
  enableServerInfoDebugView: boolean;
  /** Shows internal Paperclip maintainer tools and observability links. */
  enablePaperclipDeveloperMode: boolean;
  /**
   * Instructs agents to write user-interaction content (confirmations,
   * questions, suggested tasks, checkbox prompts) in ASD-STE100 Simplified
   * Technical English with brief decision context. Prompt-side only; no
   * behavior change outside interaction wording.
   */
  enableSimplifiedEnglishInteractions: boolean;
  /**
   * When the user's first onboarding request is a single task, the chief of
   * staff proposes with a short plan document and a checkbox card instead of a
   * one-card confirmation. Read once, when the onboarding first task is created;
   * flipping it later does not change an existing first task.
   */
  enableFirstTaskPlanProposal: boolean;
  autoRestartDevServerWhenIdle: boolean;
  enableWorkspaceBranchReconcileForward: boolean;
  enableWorkspaceDirtyQuarantineRepair: boolean;
  /**
   * On cloud-managed instances, grant the stack owner instance-admin access
   * to their own dedicated instance. Elevation is computed per request at the
   * trusted-header auth boundary (owner stack role + this flag); no
   * `instance_user_roles` row is ever written. Inert on self-hosted
   * instances, which have no trusted cloud tenant path.
   */
  enableOwnerInstanceAdmin: boolean;
  /**
   * Kill switch for the sandbox duplex command-stream bridge. Default off. The
   * host reads this per run before it selects the callback bridge transport.
   * Off forces the file bridge for every run with no manifest change and no
   * redeploy.
   */
  enableSandboxDuplexBridge: boolean;
  /**
   * @deprecated Compatibility-only. Provider WebSocket ingress now follows
   * enableNativeRunner and this value has no runtime effect.
   */
  enableRunnerPreviewIngress: boolean;
  /**
   * Worktree preview instances (`PAPERCLIP_IN_WORKTREE=true`) suppress the
   * heartbeat run engine by default so previews never self-execute tasks. When
   * this is enabled the worktree-instance scheduling suppression is lifted so
   * runs actually execute inside the preview. Ignored outside a worktree.
   */
  enableWorktreeRunExecution: boolean;
  /**
   * Server-managed cutoff recorded when worktree run execution is enabled in
   * this instance. Client PATCH payloads must not control this value.
   */
  worktreeRunExecutionActivatedAt: string | null;
  /**
   * Server-managed instance id captured with the cutoff so copied settings rows
   * from another instance fail closed.
   */
  worktreeRunExecutionActivationInstanceId: string | null;
}

/**
 * Boolean feature-flag keys of the experimental settings — the only keys a
 * cloud managed-config overlay may target. Server-managed bookkeeping fields
 * (activation cutoffs, lookback hours) are excluded by construction.
 */
export type ManagedExperimentalFeatureKey = {
  [K in keyof InstanceExperimentalSettings]-?: InstanceExperimentalSettings[K] extends boolean
    ? K
    : never;
}[keyof InstanceExperimentalSettings];

export const PAPERCLIP_CLOUD_MANAGED_BY = "paperclip-cloud" as const;

/** Per-key metadata attached to settings responses for cloud-overlaid keys. */
export interface ManagedSettingMetadata {
  managed: true;
  managedBy: typeof PAPERCLIP_CLOUD_MANAGED_BY;
}

/**
 * Experimental settings as returned by the settings API. On cloud-managed
 * instances (`PAPERCLIP_MANAGED_CONFIG` present) `managedKeys` lists every key
 * whose value is overlaid by the harness; self-hosted responses omit it.
 */
export interface InstanceExperimentalSettingsWithManaged extends InstanceExperimentalSettings {
  managedKeys?: Partial<Record<ManagedExperimentalFeatureKey, ManagedSettingMetadata>>;
}

export interface InstanceSettings {
  id: string;
  defaultEnvironmentId: string | null;
  general: InstanceGeneralSettings;
  experimental: InstanceExperimentalSettingsWithManaged;
  createdAt: Date;
  updatedAt: Date;
}
