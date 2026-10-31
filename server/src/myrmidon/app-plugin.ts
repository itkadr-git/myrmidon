// server/src/myrmidon/app-plugin.ts
// Central Myrmidon module registry for app.ts (OPE-8384).
// Re-exports all Myrmidon routers, services, middleware, and types required by server/src/app.ts.

export { singletonProxyMiddleware } from "./singleton-proxy/index.js";
export type { SingletonProxyOptions } from "./singleton-proxy/index.js"; // myrmidon(1.6.6 PROCS-1.5 / OPE-5412)
export { instanceSecretSettingsRoutes } from "./secret-settings/routes.js"; // myrmidon(SETTINGS-UI E2.1)
export { installInstanceSecretResolver } from "./secret-settings/runtime.js"; // myrmidon(SETTINGS-UI E2.2)
export { createInstanceSecretSettingService } from "./secret-settings/wiring.js"; // myrmidon(SETTINGS-UI E2.2)
export { myrmidonMaintenanceRoutes } from "./maintenance/index.js"; // myrmidon(R3)
export { boardJanitorRoutes } from "./board-janitor/index.js"; // myrmidon(BOARD-JANITOR)
export { datastoreCareRetentionRoutes } from "./datastore-care/index.js"; // myrmidon(1.6.5-DBC1)
export { myrmidonDeployJobsRoutes } from "./deploy-jobs/index.js"; // myrmidon(R5-A)
export { myrmidonRuntimeLimitsRoutes } from "./runtime-limits/index.js"; // myrmidon(C0)
export { myrmidonRunStallRoutes } from "./run-stall/index.js"; // myrmidon(RUN-STALL-SETTINGS)
export { myrmidonCorpusRoutes, resolveCorpusPorts } from "./corpus/index.js"; // myrmidon(1.6.6 CORPUS-2.0 ч.C)
export { myrmidonProcessesRouter } from "./processes/index.js"; // myrmidon(PROCS-1.1)
export { myrmidonPauseGuardRoutes } from "./pause-guard/index.js";
export { myrmidonRunPriorityRoutes } from "./run-priority/index.js"; // myrmidon(1.6.5 RUN-PRIORITY A)
export { myrmidonBudgetEnforcementRoutes } from "./budget-enforcement/index.js"; // myrmidon(1.7-BUDGET-CONFIG-B)
export { myrmidonBehaviorSettingsRoutes } from "./behavior-settings/index.js"; // myrmidon(SETTINGS-CORE)
export { myrmidonTelegramDmProgressRoutes } from "./telegram-dm-progress/index.js"; // myrmidon(DM-PROGRESS)
export { myrmidonBridgeLanguageRoutes } from "./bridge-language/index.js";
export { myrmidonChannelSettingsRoutes } from "./channel-settings/index.js"; // myrmidon(1.7-SETTINGS-TO-UI)
export { myrmidonUsersAdminRoutes } from "./users-admin-a/index.js"; // myrmidon(OPE-8985)
export { channelAllowlistRoutes } from "./channel-allowlist/routes.js"; // myrmidon(CA-A)
export { channelAllowlistService } from "./channel-allowlist/service.js"; // myrmidon(CA-A)
export { myrmidonOwnerActiveChannelRoutes } from "./owner-active-channel/index.js"; // myrmidon(1.7-ACTIVE-CHANNEL)
export { myrmidonParallelHelpersRoutes } from "./parallel-helpers/index.js"; // myrmidon(PARALLEL-HELPERS)
export { myrmidonTeamLivenessRoutes } from "./team-liveness/index.js"; // myrmidon(TEAM-LIVENESS-SETTINGS)
export { myrmidonBotLspRoutes } from "./bot-lsp/index.js"; // myrmidon(BOT-LSP-DEFAULTS)
export { myrmidonFeaturesRoutes } from "./features/index.js"; // myrmidon(FEATURES)
export { myrmidonReplayBlockedRoutes } from "./replay-blocked/index.js"; // myrmidon(N1)
export { aboutRoutes } from "./about/routes.js"; // myrmidon(ABOUT)
export { licensingRoutes } from "./licensing/routes.js"; // myrmidon(LICENSING)
export { installIdProviderFor } from "./licensing/install-id.js"; // myrmidon(OPE-8836)
export { installedClosedModules } from "./licensing/installed-modules.js"; // myrmidon(LICENSING)
export { myrmidonBotContainerRoutes } from "./bot-containers/routes-wiring.js"; // myrmidon(W2b)
export { myrmidonBrowserConsoleRoutes } from "./browser-console/wiring.js"; // myrmidon(BROWSER-CONSOLE)
export { myrmidonLitellmCostsRoutes } from "./litellm-costs/routes.js"; // myrmidon(M2-A)
export { myrmidonLitellmKeysRoutes } from "./litellm-keys/routes.js"; // myrmidon(M2-B)
export { myrmidonModelProviderRoutes } from "./model-providers/wiring.js";
export { bindModelProviderPluginLifecycle } from "./model-providers/plugin-lifecycle.js"; // myrmidon(1.6.6 OPE-7198)
export { myrmidonAgentExchangeRoutes } from "./agent-exchange/wiring.js"; // myrmidon(1.7-AGENT-EXCHANGE-A)
export { myrmidonAgentExchangeFeedRoutes } from "./agent-exchange/feed-wiring.js"; // myrmidon(1.7-AGENT-EXCHANGE-B)
export { myrmidonBaselineRoutes } from "./baseline/routes.js"; // myrmidon(1.6-BASELINE)
export { myrmidonBotEgressRoutes } from "./bot-containers/egress-wiring.js"; // myrmidon(EGRESS-B)
export { myrmidonBotCanaryRoutes } from "./bot-containers/canary-index.js"; // myrmidon(R5-B)
export { myrmidonWorkspaceHygieneRoutes } from "./workspace-hygiene/index.js"; // myrmidon(WORKSPACE-HYGIENE)
export { hostDiskRuntime, myrmidonHostDiskRoutes } from "./host-disk/index.js"; // myrmidon(BOT-DISK E)
export { myrmidonModelMenuRoutes } from "./model-menu/index.js"; // myrmidon(1.6.6 MODEL-MENU B)
export { myrmidonAttentionFeedRoutes } from "./attention-feed/index.js"; // myrmidon(1.6.6 SETTINGS-UI C-4)
export { myrmidonAlertRecoveryRoutes } from "./monitoring/alert-recovery/index.js"; // myrmidon(1.6.6-MONITORING-D)
export { myrmidonDatastoreCareRoutes } from "./datastore-care/index.js"; // myrmidon(DBC-4)
export { myrmidonDataRetentionRoutes } from "./data-retention/index.js"; // myrmidon(1.6.5-DB-RETENTION)
export { myrmidonBotDiskLifecycleRoutes } from "./bot-containers/bot-disk-routes.js"; // myrmidon(BOT-DISK-A)
export { idleStopSettingsRoutes } from "./idle-stop-settings-routes.js"; // myrmidon(OPE-7898)
export { getIdleStopService } from "./idle-stop-startup.js"; // myrmidon(OPE-7898)
export { myrmidonBotDiskPhysicalRoutes } from "./bot-containers/bot-disk-physical-routes.js";
export { myrmidonBotDiskReportRoutes } from "./bot-containers/bot-disk-report-routes.js";
export { myrmidonBotScopeRoutes } from "./bot-containers/scope-wiring.js"; // myrmidon(BOT-DISK-F)
export { botWorkspacePressureFromPartition } from "./bot-containers/bot-workspaces-pressure.js"; // myrmidon(1.6.5-BOT-DISK-H4a)
export { myrmidonBotWorkspacesRoutes } from "./bot-containers/bot-workspaces-routes.js"; // myrmidon(1.6.5-BOT-DISK-H4a)
export { myrmidonBudgetLimitsRoutes } from "./budget-limits/index.js";
export { myrmidonBotDiskQuotaRoutes } from "./bot-containers/bot-disk-quota-routes.js"; // myrmidon(1.6.1-BOT-DISK-C)
export { myrmidonBotImageRolloutRoutes } from "./bot-containers/bot-image-rollout-routes.js"; // myrmidon(BOT-ROLLOUT)
export { myrmidonMetricsApp } from "./monitoring/metrics/index.js"; // myrmidon(1.7-METRICS)
export { boardLoadApp, boardLoadLaneTagMiddleware, boardLoadRequestMiddleware } from "./monitoring/board-load/index.js"; // myrmidon(1.6.6 PROCS-0.3A)
export { myrmidonMonitoringAlertsRoutes } from "./monitoring/alerts/index.js"; // myrmidon(1.6.6-ALERTS)
export { swarmClaimApp } from "./swarm-claim/index.js"; // myrmidon(1.6-SWARM)
export { createCasteDirectoryReader } from "./castes/directory.js"; // myrmidon(1.6.5 OPE-6608)
export { myrmidonEmergencyStopRoutes } from "./emergency-stop.js";
export { myrmidonWakeTaskGuardRoutes } from "./wake-task-guard-routes.js"; // myrmidon(1.6.5 F-26 T5)
export { myrmidonStackRegistryRoutes } from "./stack-registry/index.js"; // myrmidon(SUA)
export { myrmidonWipLimitRoutes } from "./wip-limit/index.js"; // myrmidon(1.6.1-WIP-LIMIT-A)
export { projectTokenQuotaRoutes } from "./project-token-quota/index.js"; // myrmidon(1.6.6 QUOTA-V2)
export { myrmidonPromptBudgetRoutes } from "./prompt-budget/index.js"; // myrmidon(1.6.3 PROMPT-BUDGET B)
export { modelFallbackSignalRoutes } from "./litellm-fallback-signal/routes.js"; // myrmidon(BOT-RUNTIME-TUNING D2)
export { myrmidonOwnerDeliveryRoutes } from "./owner-delivery/index.js"; // myrmidon(1.6.5-OWNER-DM-FILTER)
export { reviewRoutingRoutes } from "./review-routing/routes.js"; // myrmidon(REVIEW-ROUTING)
export { reviewReworkRoutes } from "./review-rework/routes.js"; // myrmidon(REVIEW-REWORK)
export { pluginEntitlementRoutes } from "./plugin-entitlement/index.js";
export { licensingInstallIdRoutes } from "./licensing-install-id/routes.js";
export { myrmidonLitellmBudgetSyncRoutes } from "./litellm-budget-sync/index.js"; // myrmidon(1.7-BUDGET-CONFIG-C)
export { myrmidonLitellmWorkersRoutes } from "./litellm-workers/routes.js"; // myrmidon(1.6.5 LITELLM-WORKERS A)
export { myrmidonLitellmChannelsRoutes } from "./litellm-channels/index.js"; // myrmidon(1.6.7 OPE-9854)
export { agentInstructionsRevisionsRoutes } from "./agent-instructions-revisions/index.js"; // myrmidon(H2)
export { myrmidonFleetConsoleRoutes } from "./fleet-console/index.js"; // myrmidon(SC1)
export { myrmidonFleetSiteRoutes } from "./bot-containers/fleet-site-wiring.js"; // myrmidon(1.6.6 OPE-8999)
export { myrmidonFleetSiteManageRoutes } from "./bot-containers/fleet-site-manage-wiring.js"; // myrmidon(1.6.6 REMOTE-SITES-T8)
export { myrmidonFleetMoveRoutes } from "./bot-containers/fleet-move-wiring.js"; // myrmidon(1.6.6 REMOTE-SITES-T5)
export type { FleetClientManager } from "./bot-containers/site-registry.js";
export { siteHealthRoutes } from "./bot-containers/site-health-routes.js"; // myrmidon(1.6.6 REMOTE-SITES-T4)
export { myrmidonPromptBudgetAdviceRoutes } from "./prompt-budget-advice/index.js"; // myrmidon(1.6.3 PROMPT-BUDGET C)
export { myrmidonMonitoringLinkRoutes } from "./monitoring/links/index.js"; // myrmidon(1.6.6 MONITORING E)
export { myrmidonMonitoringDashboardRoutes } from "./monitoring/dashboard/index.js"; // myrmidon(1.6.6 MONITORING C)
export { myrmidonCloudConnectorRoutes } from "./cloud-connector/index.js"; // myrmidon(CLOUD-CONNECTOR)
export { myrmidonBoardProcessRegistryRoutes } from "./process-registry/index.js"; // myrmidon(1.6.6 PROCS-0.1)
export { poolChatRoutes } from "./pool-chat/routes.js";
export { createPoolChatHttpTransport } from "./pool-chat/transports.js";
export type { PoolChatTransportResolver } from "./pool-chat/service.js";
export { myrmidonAutonomyRoutes } from "./autonomy/index.js"; // myrmidon(1.6-AUTONOMY)
export { myrmidonKnowledgeRoutes, myrmidonKnowledgeMcpRoutes } from "./knowledge/index.js"; // myrmidon(1.6.6 KNOWLEDGE-2.0 K-2)
export { sweepTelegramNotifyProactivity } from "./channel-connectors/bridge/notify-sweep.js";
export { accessHubRoutes } from "./access-hub/routes.js"; // myrmidon(SEC1)
export { ui2LanguageRoutes } from "./ui2-language/routes.js"; // myrmidon(UI2-I18N)
export { myrmidonForagingRoutes, myrmidonForagingIdleGateRoutes, myrmidonForagingPassRoutes } from "./foraging/index.js"; // myrmidon(1.6-FORAGE, 1.6.3-FORAGING-IDLE-GATE)
export { myrmidonAgentMemoryRoutes, myrmidonAgentMemorySettingsRoutes } from "./agent-memory/index.js"; // myrmidon(MEMORY-UI)
export { myrmidonToolPolicyCacheRoutes } from "./tool-policy-cache/index.js"; // myrmidon(DB-PERF-C-P4)
export { myrmidonSkillLifecycleRoutes } from "./skill-lifecycle/index.js";
export { myrmidonBrowserBridgePublicRoutes, myrmidonBrowserBridgeRoutes } from "./browser-bridge/index.js"; // myrmidon(EXTCASE-B)
export { myrmidonOcrRoutes } from "./ocr/index.js";
export { myrmidonCorpusMcpRoutes } from "./corpus/index.js";
export { myrmidonArchitectDataMcpRoutes, myrmidonArchitectDataRoutes } from "./architect-data/index.js";
export { myrmidonSttRoutes } from "./stt/index.js"; // myrmidon(1.6.1 VOICE-STT A1)
export { myrmidonGitHubSharedIdentityRoutes } from "./github-shared-identity/index.js"; // myrmidon(GITHUB-SHARED-IDENTITY)
export { createTelegramVoiceSttWiring } from "./channel-connectors/bridge/voice-stt.js"; // myrmidon(1.6.5 VOICE-STT A) myrmidon(1.6.6 CH-CONNECTOR-D)
export { myrmidonVoiceMeetingProtocolRoutes } from "./voice-meeting-protocol/index.js"; // myrmidon(1.6.5 VOICE-STT B)
export { myrmidonEvalsRoutes } from "./evals/index.js"; // myrmidon(1.6-EVALS)
export { myrmidonDebateRoutes } from "./debates/index.js"; // myrmidon(1.7-DEBATE-ASYM-A)
export { myrmidonScentRoutes } from "./scent/index.js"; // myrmidon(1.6.5 F-26 T10 SCENT)
export { myrmidonTracingHealthRoutes } from "./tracing-health/index.js"; // myrmidon(TRACING-HEALTH)
export { myrmidonWikiCortexRoutes } from "./wiki-cortex/wiring.js";
export { myrmidonCtoChatRoutes } from "./cto-chat/index.js";
export { myrmidonSwarmSupervisorRoutes } from "./swarm-claim-supervisor/index.js"; // myrmidon(1.6-SWARM-CLAIM-B)
export { myrmidonProcessReadinessRoutes } from "./process-readiness/index.js";
export type { ProcessSupervisorReadinessSource } from "./process-readiness/index.js";
export { myrmidonTelegramNotifyRoutes } from "./channel-connectors/bridge/notify.js";
export { chatReconcileMinimumSpacingMs, getChatReconcileFallbackIntervalMs, createReconcileInterval } from "./chat-reconciliation/reconcile-interval.js";
export { createChatReconciliationWorkGates } from "./chat-reconciliation/work-gates.js";
export type { ChatReconciliationWorkGates } from "./chat-reconciliation/work-gates.js";
export { myrmidonCasteRoutes } from "./castes/wiring.js";
export { myrmidonGuardrailsRoutes } from "./guardrails/index.js"; // myrmidon(1.6-GRD)
