// server/src/myrmidon/app-plugin.ts
//
// myrmidon(1.6.6-PLUGIN-REGISTRY): the single registration point for Myrmidon's
// route modules in the HTTP app (1.6.6 plan p.5, adapted to this fork).
//
// Before this file, server/src/app.ts carried ~60 `import ... from "./myrmidon/*"`
// lines and a 66-line block of `api.use(...)` calls. app.ts now imports the
// registry below plus the two wiring modules still needed directly
// (model-provider lifecycle and telegram voice-stt intake), and makes ONE registration call at the
// place the old block lived. Same factories, same arguments, same order:
// nothing about route precedence changed. The order is behavior — Express
// matches mounted routers first-wins — and
// server/src/myrmidon/app-plugin.myrmidon.test.ts pins it against the original
// app.ts sequence.
//
// Phases (from the release plan):
//   (a) pre-auth root mounts outside /api (metrics, browser-bridge public) —
//       they stay as literal `app.use(...)` lines in app.ts; their factories are
//       re-exported here so app.ts needs no extra ./myrmidon/* import.
//   (b) middleware (actor, board-key scope, mutation guard) — the vendor chain,
//       stays in app.ts.
//   (c) the /api route factories — MYRMIDON_API_MOUNTS below, applied in order
//       by registerMyrmidonPlugin().
//   (d) startup sweeps and schedulers — index.ts, deliberately NOT part of this
//       registry (a separate task); the sweep/spacing/reconcile re-exports below
//       are only what app.ts still calls or reads directly.

import type { Db } from "@paperclipai/db";
import type { Router } from "express";

import { instanceSettingsService } from "../services/instance-settings.js";

import { myrmidonMaintenanceRoutes } from "./maintenance/index.js";
import { myrmidonDeployJobsRoutes } from "./deploy-jobs/index.js";
import { myrmidonRuntimeLimitsRoutes } from "./runtime-limits/index.js";
import { myrmidonBudgetEnforcementRoutes } from "./budget-enforcement/index.js";
import { myrmidonBehaviorSettingsRoutes } from "./behavior-settings/index.js";
import { myrmidonTelegramDmProgressRoutes } from "./telegram-dm-progress/index.js";
import { myrmidonChannelSettingsRoutes } from "./channel-settings/index.js";
import { myrmidonParallelHelpersRoutes } from "./parallel-helpers/index.js";
import { myrmidonTeamLivenessRoutes } from "./team-liveness/index.js";
import { myrmidonBotLspRoutes } from "./bot-lsp/index.js";
import { myrmidonReplayBlockedRoutes } from "./replay-blocked/index.js";
import { aboutRoutes } from "./about/routes.js";
import { myrmidonBotContainerRoutes } from "./bot-containers/routes-wiring.js";
import { myrmidonBrowserConsoleRoutes } from "./browser-console/wiring.js";
import { myrmidonLitellmCostsRoutes } from "./litellm-costs/routes.js";
import { myrmidonLitellmKeysRoutes } from "./litellm-keys/routes.js";
import { myrmidonModelProviderRoutes } from "./model-providers/wiring.js";
import { myrmidonAgentExchangeRoutes } from "./agent-exchange/wiring.js";
import { myrmidonBaselineRoutes } from "./baseline/routes.js";
import { myrmidonBotEgressRoutes } from "./bot-containers/egress-wiring.js";
import { myrmidonBotCanaryRoutes } from "./bot-containers/canary-index.js";
import { myrmidonWorkspaceHygieneRoutes } from "./workspace-hygiene/index.js";
import { hostDiskRuntime, myrmidonHostDiskRoutes } from "./host-disk/index.js";
import { myrmidonAlertRecoveryRoutes } from "./monitoring/alert-recovery/index.js";
import { myrmidonBotDiskLifecycleRoutes } from "./bot-containers/bot-disk-routes.js";
import { myrmidonBotScopeRoutes } from "./bot-containers/scope-wiring.js";
import { myrmidonBotDiskQuotaRoutes } from "./bot-containers/bot-disk-quota-routes.js";
import { botWorkspacePressureFromPartition } from "./bot-containers/bot-workspaces-pressure.js";
import { myrmidonBotWorkspacesRoutes } from "./bot-containers/bot-workspaces-routes.js";

import { myrmidonBotImageRolloutRoutes } from "./bot-containers/bot-image-rollout-routes.js";
import { swarmClaimApp } from "./swarm-claim/index.js";
import { datastoreCareRetentionRoutes } from "./datastore-care/retention/routes.js";
import { boardLoadApp } from "./board-load/index.js";
import { myrmidonPauseGuardRoutes } from "./pause-guard/routes.js";
import { myrmidonRunPriorityRoutes } from "./run-priority/routes.js";
import { myrmidonRunStallRoutes } from "./run-stall/routes.js";
import { myrmidonCorpusRoutes } from "./corpus/routes.js";
import { myrmidonProcessesRouter } from "./processes/index.js";
import { myrmidonAgentMemorySettingsRoutes } from "./agent-memory/index.js";
import { channelAllowlistRoutes } from "./channel-allowlist/routes.js";
import { channelAllowlistService } from "./channel-allowlist/service.js";
import { licensingRoutes } from "./licensing/routes.js";
import { myrmidonAgentExchangeFeedRoutes } from "./agent-exchange/feed-routes.js";
import { myrmidonAttentionFeedRoutes } from "./attention/feed-routes.js";
import { myrmidonDatastoreCareRoutes } from "./datastore-care/index.js";
import { myrmidonDataRetentionRoutes } from "./data-retention/index.js";
import { myrmidonBotDiskPhysicalRoutes } from "./bot-containers/bot-disk-physical-routes.js";
import { myrmidonBotDiskReportRoutes } from "./bot-containers/bot-disk-report-routes.js";
import { myrmidonBudgetLimitsRoutes } from "./budget-limits/routes.js";
import { myrmidonWakeTaskGuardRoutes } from "./wake-task-guard/routes.js";
import { myrmidonToolPolicyCacheRoutes } from "./tool-policy-cache/routes.js";
import { myrmidonOwnerDeliveryRoutes } from "./owner-delivery/routes.js";
import { myrmidonLitellmWorkersRoutes } from "./litellm/workers-routes.js";
import { myrmidonCorpusMcpRoutes } from "./corpus/index.js";
import { myrmidonScentRoutes } from "./scent/routes.js";
import { myrmidonBridgeLanguageRoutes } from "./channel-connectors/bridge/language.js";
import { myrmidonMonitoringAlertsRoutes } from "./monitoring/alerts-routes.js";
import { myrmidonMonitoringDashboardRoutes } from "./monitoring/dashboard-routes.js";
import { myrmidonForagingIdleGateRoutes } from "./foraging/idle-gate-routes.js";
import { myrmidonForagingPassRoutes } from "./foraging/pass-routes.js";
import { myrmidonBoardProcessRegistryRoutes } from "./processes/board-registry.js";
import { createCasteDirectoryReader, myrmidonCasteRoutes } from "./castes/wiring.js";
import { myrmidonGuardrailsRoutes } from "./guardrails/routes.js";
import { myrmidonEmergencyStopRoutes } from "./emergency-stop.js";
import {
  myrmidonAgentMemoryRoutes,
  myrmidonAgentMemorySettingsRoutes,
} from "./agent-memory/index.js";
import { myrmidonSkillLifecycleRoutes } from "./skill-lifecycle/index.js";
import { myrmidonStackRegistryRoutes } from "./stack-registry/index.js";
import { myrmidonWipLimitRoutes } from "./wip-limit/index.js";
import { modelFallbackSignalRoutes } from "./litellm-fallback-signal/routes.js";
import { reviewRoutingRoutes } from "./review-routing/routes.js";
import { reviewReworkRoutes } from "./review-rework/routes.js";
import { pluginEntitlementRoutes } from "./plugin-entitlement/index.js";
import { myrmidonLitellmBudgetSyncRoutes } from "./litellm-budget-sync/index.js";
import { agentInstructionsRevisionsRoutes } from "./agent-instructions-revisions/index.js";
import { myrmidonFleetConsoleRoutes } from "./fleet-console/index.js";
import { myrmidonCloudConnectorRoutes } from "./cloud-connector/index.js";
import { myrmidonPromptBudgetAdviceRoutes } from "./prompt-budget-advice/index.js";
import { myrmidonMonitoringLinkRoutes } from "./monitoring/links/index.js";
import { myrmidonPromptBudgetRoutes } from "./prompt-budget/index.js";
import { myrmidonAutonomyRoutes } from "./autonomy/index.js";
import { accessHubRoutes } from "./access-hub/routes.js";
import { myrmidonBrowserBridgeRoutes } from "./browser-bridge/index.js";
import { myrmidonOcrRoutes } from "./ocr/index.js";
import { myrmidonSttRoutes } from "./stt/index.js";
import { myrmidonGitHubSharedIdentityRoutes } from "./github-shared-identity/index.js";
import { myrmidonVoiceMeetingProtocolRoutes } from "./voice-meeting-protocol/index.js";
import { myrmidonEvalsRoutes } from "./evals/index.js";
import { myrmidonDebateRoutes } from "./debates/index.js";
import { myrmidonTracingHealthRoutes } from "./tracing-health/index.js";
import { myrmidonCtoChatRoutes } from "./cto-chat/index.js";
import { myrmidonSwarmSupervisorRoutes } from "./swarm-claim-supervisor/index.js";
import { myrmidonTelegramNotifyRoutes } from "./telegram-notify/index.js";
import { ui2LanguageRoutes } from "./ui2-language/routes.js";
import { myrmidonForagingRoutes } from "./foraging/index.js";
import { myrmidonWikiCortexRoutes } from "./wiki-cortex/wiring.js";

export interface MyrmidonPluginDeps {
  /** Instance settings service — swarm-claim reads its role-queue config through it. */
  instanceSettingsService: typeof instanceSettingsService;
  botWorkspacePressureFromPartition: typeof botWorkspacePressureFromPartition;
  hostDiskRuntime: typeof hostDiskRuntime;
  createCasteDirectoryReader: typeof createCasteDirectoryReader;
  processSupervisor?: import("./processes/index.js").ProcessSupervisor | null;
}

export interface MyrmidonApiMount {
  /** Factory export name — the stable identity the order guard test pins. */
  name: string;
  /** The myrmidon(...) marker of the original app.ts line. */
  tag: string;
  /** Mounts the router on the /api router — one-for-one with the old `api.use(...)` line. */
  use: (api: Router, db: Db, deps: MyrmidonPluginDeps) => void;
}

/**
 * Non-route symbols app.ts still uses directly; re-exported so app.ts keeps its
 * ./myrmidon/* imports down to the registry while preserving the two remaining wiring modules
 * (voice-stt intake, castes).
 */
export {
  chatReconcileMinimumSpacingMs,
  createReconcileInterval,
  getChatReconcileFallbackIntervalMs,
} from "./chat-reconciliation/reconcile-interval.js";
export { sweepTelegramNotifyProactivity } from "./telegram-notify/sweep.js";
export { myrmidonBrowserBridgePublicRoutes } from "./browser-bridge/index.js";
export { myrmidonMetricsApp } from "./monitoring/metrics/index.js";

/**
 * The api-phase registry preserves all 92 API mount identities, arguments, and
 * positions from upstream main. Do not reorder these entries: Express
 * resolves matching routes first-wins; the order guard test pins the sequence.
 */
export const MYRMIDON_API_MOUNTS: readonly MyrmidonApiMount[] = [
  { name: "myrmidonMaintenanceRoutes", tag: "R3", use: (api, db, deps) => { api.use(myrmidonMaintenanceRoutes(db)); } },
  { name: "datastoreCareRetentionRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(datastoreCareRetentionRoutes(db)); } },
  { name: "boardLoadApp", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(boardLoadApp(db)); } },
  { name: "myrmidonDeployJobsRoutes", tag: "R5-A", use: (api, db, deps) => { api.use(myrmidonDeployJobsRoutes(db)); } },
  { name: "myrmidonRuntimeLimitsRoutes", tag: "C0", use: (api, db, deps) => { api.use(myrmidonRuntimeLimitsRoutes(db)); } },
  { name: "myrmidonPauseGuardRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonPauseGuardRoutes(db)); } },
  { name: "myrmidonRunPriorityRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonRunPriorityRoutes(db)); } },
  { name: "myrmidonRunStallRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonRunStallRoutes(db)); } },
  { name: "myrmidonCorpusRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonCorpusRoutes(db, { ports: resolveCorpusPorts })); } },
  { name: "myrmidonProcessesRouter", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonProcessesRouter(db as any, deps.processSupervisor ?? null)); } },
  { name: "myrmidonBudgetEnforcementRoutes", tag: "1.7-BUDGET-CONFIG-B", use: (api, db, deps) => { api.use(myrmidonBudgetEnforcementRoutes(db)); } },
  { name: "myrmidonBehaviorSettingsRoutes", tag: "SETTINGS-CORE", use: (api, db, deps) => { api.use(myrmidonBehaviorSettingsRoutes(db)); } },
  { name: "myrmidonTelegramDmProgressRoutes", tag: "DM-PROGRESS", use: (api, db, deps) => { api.use(myrmidonTelegramDmProgressRoutes(db)); } },
  { name: "myrmidonChannelSettingsRoutes", tag: "1.7-SETTINGS-TO-UI", use: (api, db, deps) => { api.use(myrmidonChannelSettingsRoutes(db)); } },
  { name: "channelAllowlistRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(channelAllowlistRoutes(db, channelAllowlistService(db))); } },
  { name: "myrmidonParallelHelpersRoutes", tag: "PARALLEL-HELPERS", use: (api, db, deps) => { api.use(myrmidonParallelHelpersRoutes(db)); } },
  { name: "myrmidonTeamLivenessRoutes", tag: "TEAM-LIVENESS-SETTINGS", use: (api, db, deps) => { api.use(myrmidonTeamLivenessRoutes(db)); } },
  { name: "myrmidonBotLspRoutes", tag: "BOT-LSP-DEFAULTS", use: (api, db, deps) => { api.use(myrmidonBotLspRoutes(db)); } },
  { name: "myrmidonReplayBlockedRoutes", tag: "N1", use: (api, db, deps) => { api.use(myrmidonReplayBlockedRoutes(db)); } },
  { name: "aboutRoutes", tag: "ABOUT", use: (api, db, deps) => { api.use(aboutRoutes()); } },
  { name: "licensingRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(licensingRoutes()); } },
  { name: "myrmidonBotContainerRoutes", tag: "W2b", use: (api, db, deps) => { api.use(myrmidonBotContainerRoutes(db)); } },
  { name: "myrmidonBrowserConsoleRoutes", tag: "BROWSER-CONSOLE", use: (api, db, deps) => { api.use(myrmidonBrowserConsoleRoutes(db)); } },
  { name: "myrmidonLitellmCostsRoutes", tag: "M2-A", use: (api, db, deps) => { api.use(myrmidonLitellmCostsRoutes(db)); } },
  { name: "myrmidonLitellmKeysRoutes", tag: "M2-B", use: (api, db, deps) => { api.use(myrmidonLitellmKeysRoutes(db)); } },
  { name: "myrmidonModelProviderRoutes", tag: "1.6.1 MODEL-PROVIDERS A+B", use: (api, db, deps) => { api.use(myrmidonModelProviderRoutes(db)); } },
  { name: "myrmidonAgentExchangeRoutes", tag: "1.7-AGENT-EXCHANGE-A", use: (api, db, deps) => { api.use(myrmidonAgentExchangeRoutes(db)); } },
  { name: "myrmidonAgentExchangeFeedRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonAgentExchangeFeedRoutes(db)); } },
  { name: "myrmidonBaselineRoutes", tag: "1.6-BASELINE", use: (api, db, deps) => { api.use(myrmidonBaselineRoutes(db)); } },
  { name: "myrmidonBotEgressRoutes", tag: "EGRESS-B", use: (api, db, deps) => { api.use(myrmidonBotEgressRoutes(db)); } },
  { name: "myrmidonBotCanaryRoutes", tag: "R5-B", use: (api, db, deps) => { api.use(myrmidonBotCanaryRoutes(db)); } },
  { name: "myrmidonWorkspaceHygieneRoutes", tag: "WORKSPACE-HYGIENE", use: (api, db, deps) => { api.use(myrmidonWorkspaceHygieneRoutes(db)); } },
  { name: "myrmidonHostDiskRoutes", tag: "BOT-DISK E", use: (api, db, deps) => { api.use(myrmidonHostDiskRoutes(db)); } },
  { name: "myrmidonAttentionFeedRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonAttentionFeedRoutes(db)); } },
  { name: "myrmidonAlertRecoveryRoutes", tag: "1.6.6-MONITORING-D", use: (api, db, deps) => { api.use(myrmidonAlertRecoveryRoutes(db)); } },
  { name: "myrmidonDatastoreCareRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonDatastoreCareRoutes(db)); } },
  { name: "myrmidonDataRetentionRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonDataRetentionRoutes(db)); } },
  { name: "myrmidonBotDiskLifecycleRoutes", tag: "BOT-DISK-A", use: (api, db, deps) => { api.use(myrmidonBotDiskLifecycleRoutes(db)); } },
  { name: "myrmidonBotDiskPhysicalRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonBotDiskPhysicalRoutes(db)); } },
  { name: "myrmidonBotDiskReportRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonBotDiskReportRoutes()); } },
  { name: "myrmidonBotScopeRoutes", tag: "BOT-DISK-F", use: (api, db, deps) => { api.use(myrmidonBotScopeRoutes(db)); } },
  { name: "myrmidonBudgetLimitsRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonBudgetLimitsRoutes(db)); } },
  { name: "myrmidonBotDiskQuotaRoutes", tag: "1.6.1-BOT-DISK-C", use: (api, db, deps) => { api.use(myrmidonBotDiskQuotaRoutes(db)); } },
  { name: "myrmidonBotWorkspacesRoutes", tag: "1.6.5-BOT-DISK-H4a", use: (api, db, deps) => { api.use(myrmidonBotWorkspacesRoutes(db, {
    // myrmidon(1.6.5-BOT-DISK-H4a): the pressure block comes from the host-disk partition measurement
    readPressure: async () => deps.botWorkspacePressureFromPartition(deps.hostDiskRuntime(db).partition.current()),
  })); } },
  { name: "myrmidonBotImageRolloutRoutes", tag: "BOT-ROLLOUT", use: (api, db, deps) => { api.use(myrmidonBotImageRolloutRoutes(db)); } },
  { name: "swarmClaimApp", tag: "1.6-SWARM", use: (api, db, deps) => { api.use(swarmClaimApp({
    db,
    settings: deps.instanceSettingsService(db),
    enqueueWakeup: undefined, // the explicit pull wakes nobody (the asking agent is awake); the matcher events carry their own wake port
    castes: deps.createCasteDirectoryReader(db), // myrmidon(1.6.5 OPE-6608): the claim API honours swarmEligible=false and the per-caste ceiling
    env: process.env,
  })); } },
  { name: "myrmidonEmergencyStopRoutes", tag: "EMERGENCY-STOP", use: (api, db, deps) => { api.use(myrmidonEmergencyStopRoutes(db)); } },
  { name: "myrmidonWakeTaskGuardRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonWakeTaskGuardRoutes(db)); } },
  { name: "myrmidonAgentMemoryRoutes", tag: "MEMORY-UI", use: (api, db, deps) => { api.use(myrmidonAgentMemoryRoutes(db)); } },
  { name: "myrmidonAgentMemorySettingsRoutes", tag: "MEMORY-UI", use: (api, db, deps) => { api.use(myrmidonAgentMemorySettingsRoutes(db)); } },
  { name: "myrmidonToolPolicyCacheRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonToolPolicyCacheRoutes(db)); } },
  { name: "myrmidonSkillLifecycleRoutes", tag: "1.6-SKILL-LIFE", use: (api, db, deps) => { api.use(myrmidonSkillLifecycleRoutes(db)); } },
  { name: "myrmidonStackRegistryRoutes", tag: "SUA", use: (api, db, deps) => { api.use(myrmidonStackRegistryRoutes(db)); } },
  { name: "myrmidonWipLimitRoutes", tag: "1.6.1-WIP-LIMIT-A", use: (api, db, deps) => { api.use(myrmidonWipLimitRoutes(db)); } },
  { name: "projectTokenQuotaRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(projectTokenQuotaRoutes(db)); } },
  { name: "modelFallbackSignalRoutes", tag: "BOT-RUNTIME-TUNING D2", use: (api, db, deps) => { api.use(modelFallbackSignalRoutes(db)); } },
  { name: "myrmidonOwnerDeliveryRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonOwnerDeliveryRoutes(db)); } },
  { name: "reviewRoutingRoutes", tag: "REVIEW-ROUTING", use: (api, db, deps) => { api.use(reviewRoutingRoutes(db)); } },
  { name: "reviewReworkRoutes", tag: "REVIEW-REWORK", use: (api, db, deps) => { api.use(reviewReworkRoutes(db)); } },
  { name: "pluginEntitlementRoutes", tag: "PLUGIN-ENTITLEMENT C", use: (api, db, deps) => { api.use(pluginEntitlementRoutes(db)); } },
  { name: "myrmidonLitellmBudgetSyncRoutes", tag: "1.7-BUDGET-CONFIG-C", use: (api, db, deps) => { api.use(myrmidonLitellmBudgetSyncRoutes(db)); } },
  { name: "myrmidonLitellmWorkersRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonLitellmWorkersRoutes(db)); } },
  { name: "agentInstructionsRevisionsRoutes", tag: "H2", use: (api, db, deps) => { api.use(agentInstructionsRevisionsRoutes(db)); } },
  { name: "myrmidonFleetConsoleRoutes", tag: "SC1", use: (api, db, deps) => { api.use(myrmidonFleetConsoleRoutes(db)); } },
  { name: "myrmidonCloudConnectorRoutes", tag: "CLOUD-CONNECTOR", use: (api, db, deps) => { api.use(myrmidonCloudConnectorRoutes(db)); } },
  { name: "myrmidonPromptBudgetAdviceRoutes", tag: "1.6.3 PROMPT-BUDGET C", use: (api, db, deps) => { api.use(myrmidonPromptBudgetAdviceRoutes(db)); } },
  { name: "myrmidonMonitoringLinkRoutes", tag: "1.6.6 MONITORING E", use: (api, db, deps) => { api.use(myrmidonMonitoringLinkRoutes(db)); } },
  { name: "myrmidonPromptBudgetRoutes", tag: "1.6.3 PROMPT-BUDGET B", use: (api, db, deps) => { api.use(myrmidonPromptBudgetRoutes(db)); } },
  { name: "myrmidonAutonomyRoutes", tag: "1.6-AUTONOMY", use: (api, db, deps) => { api.use(myrmidonAutonomyRoutes(db)); } },
  { name: "accessHubRoutes", tag: "SEC1", use: (api, db, deps) => { api.use(accessHubRoutes(db)); } },
  { name: "myrmidonBrowserBridgeRoutes", tag: "EXTCASE-B", use: (api, db, deps) => { api.use(myrmidonBrowserBridgeRoutes(db)); } },
  { name: "myrmidonOcrRoutes", tag: "EXT-CASE-OCR", use: (api, db, deps) => { api.use(myrmidonOcrRoutes(db)); } },
  { name: "myrmidonCorpusMcpRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonCorpusMcpRoutes(db)); } },
  { name: "myrmidonSttRoutes", tag: "1.6.1 VOICE-STT A1", use: (api, db, deps) => { api.use(myrmidonSttRoutes(db)); } },
  { name: "myrmidonGitHubSharedIdentityRoutes", tag: "GITHUB-SHARED-IDENTITY", use: (api, db, deps) => { api.use(myrmidonGitHubSharedIdentityRoutes(db)); } },
  { name: "myrmidonVoiceMeetingProtocolRoutes", tag: "1.6.5-VOICE-STT-B", use: (api, db, deps) => { api.use(myrmidonVoiceMeetingProtocolRoutes()); } },
  { name: "myrmidonEvalsRoutes", tag: "1.6-EVALS", use: (api, db, deps) => { api.use(myrmidonEvalsRoutes(db)); } },
  { name: "myrmidonDebateRoutes", tag: "1.7-DEBATE-ASYM-A", use: (api, db, deps) => { api.use(myrmidonDebateRoutes(db)); } },
  { name: "myrmidonTracingHealthRoutes", tag: "TRACING-HEALTH", use: (api, db, deps) => { api.use(myrmidonTracingHealthRoutes(db)); } },
  { name: "myrmidonCtoChatRoutes", tag: "1.6-CTO-CHAT-B", use: (api, db, deps) => { api.use(myrmidonCtoChatRoutes(db)); } },
  { name: "myrmidonSwarmSupervisorRoutes", tag: "1.6-SWARM-CLAIM-B", use: (api, db, deps) => { api.use(myrmidonSwarmSupervisorRoutes(db)); } },
  { name: "myrmidonScentRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonScentRoutes(db)); } },
  { name: "myrmidonTelegramNotifyRoutes", tag: "TG-NOTIFY-A", use: (api, db, deps) => { api.use(myrmidonTelegramNotifyRoutes(db)); } },
  { name: "ui2LanguageRoutes", tag: "UI2-I18N", use: (api, db, deps) => { api.use(ui2LanguageRoutes(db)); } },
  { name: "myrmidonBridgeLanguageRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonBridgeLanguageRoutes(db)); } },
  { name: "myrmidonForagingRoutes", tag: "1.6-FORAGE", use: (api, db, deps) => { api.use(myrmidonForagingRoutes(db)); } },
  { name: "myrmidonMonitoringAlertsRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonMonitoringAlertsRoutes(db)); } },
  { name: "myrmidonMonitoringDashboardRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonMonitoringDashboardRoutes(db)); } },
  { name: "myrmidonForagingIdleGateRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonForagingIdleGateRoutes(db)); } },
  { name: "myrmidonForagingPassRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonForagingPassRoutes(db)); } },
  { name: "myrmidonWikiCortexRoutes", tag: "1.6-WIKI", use: (api, db, deps) => { api.use(myrmidonWikiCortexRoutes(db)); } },
  { name: "myrmidonBoardProcessRegistryRoutes", tag: "UPSTREAM-MAIN", use: (api, db, deps) => { api.use(myrmidonBoardProcessRegistryRoutes(db)); } },
];

/**
 * Register every Myrmidon /api route module in the pinned order (phase (c)).
 * app.ts calls this once in the same position as the API registry block on upstream main.
 */
export function registerMyrmidonPlugin(api: Router, db: Db, deps: MyrmidonPluginDeps): void {
  for (const mount of MYRMIDON_API_MOUNTS) {
    mount.use(api, db, deps);
  }
}
