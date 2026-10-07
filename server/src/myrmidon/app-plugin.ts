// server/src/myrmidon/app-plugin.ts
//
// myrmidon(1.6.6-PLUGIN-REGISTRY): the single registration point for Myrmidon's
// route modules in the HTTP app (1.6.6 plan p.5, adapted to this fork).
//
// Before this file, server/src/app.ts carried ~60 `import ... from "./myrmidon/*"`
// lines and a 66-line block of `api.use(...)` calls. app.ts now imports the
// registry below plus the two wiring modules its non-route code needs directly
// (telegram-voice-stt intake, castes), and makes ONE registration call at the
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
import type { instanceSettingsService } from "../services/instance-settings.js";

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
import { myrmidonHostDiskRoutes } from "./host-disk/index.js";
import { myrmidonAlertRecoveryRoutes } from "./monitoring/alert-recovery/index.js";
import { myrmidonBotDiskLifecycleRoutes } from "./bot-containers/bot-disk-routes.js";
import { myrmidonBotScopeRoutes } from "./bot-containers/scope-wiring.js";
import { myrmidonBotDiskQuotaRoutes } from "./bot-containers/bot-disk-quota-routes.js";
import { myrmidonBotWorkspacesRoutes } from "./bot-containers/bot-workspaces-routes.js";
import { myrmidonBotImageRolloutRoutes } from "./bot-containers/bot-image-rollout-routes.js";
import { swarmClaimApp } from "./swarm-claim/index.js";
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
 * ./myrmidon/* imports down to the registry plus the two wiring modules
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
 * The api-phase registry: every Myrmidon route factory app.ts used to mount in its
 * old block (main tip bd4d47023, server/src/app.ts lines 904-969), in the SAME
 * order — 61 mounts. Do not re-sort — see the header and the order guard test.
 */
export const MYRMIDON_API_MOUNTS: readonly MyrmidonApiMount[] = [
  {
    name: "myrmidonMaintenanceRoutes",
    tag: "R3",
    // myrmidon(R3)
    use: (api, db, deps) => {
      api.use(myrmidonMaintenanceRoutes(db));
    },
  },
  {
    name: "myrmidonDeployJobsRoutes",
    tag: "R5-A",
    // myrmidon(R5-A)
    use: (api, db, deps) => {
      api.use(myrmidonDeployJobsRoutes(db));
    },
  },
  {
    name: "myrmidonRuntimeLimitsRoutes",
    tag: "C0",
    // myrmidon(C0)
    use: (api, db, deps) => {
      api.use(myrmidonRuntimeLimitsRoutes(db));
    },
  },
  {
    name: "myrmidonBudgetEnforcementRoutes",
    tag: "1.7-BUDGET-CONFIG-B",
    // myrmidon(1.7-BUDGET-CONFIG-B)
    use: (api, db, deps) => {
      api.use(myrmidonBudgetEnforcementRoutes(db));
    },
  },
  {
    name: "myrmidonBehaviorSettingsRoutes",
    tag: "SETTINGS-CORE",
    // myrmidon(SETTINGS-CORE): unified behavior settings, UI→env→default without restart
    use: (api, db, deps) => {
      api.use(myrmidonBehaviorSettingsRoutes(db));
    },
  },
  {
    name: "myrmidonTelegramDmProgressRoutes",
    tag: "DM-PROGRESS",
    // myrmidon(DM-PROGRESS): live progress steps of the Telegram DM status
    use: (api, db, deps) => {
      api.use(myrmidonTelegramDmProgressRoutes(db));
    },
  },
  {
    name: "myrmidonChannelSettingsRoutes",
    tag: "1.7-SETTINGS-TO-UI",
    // myrmidon(1.7-SETTINGS-TO-UI): GET/PATCH /api/myrmidon/channel-settings
    use: (api, db, deps) => {
      api.use(myrmidonChannelSettingsRoutes(db));
    },
  },
  {
    name: "myrmidonParallelHelpersRoutes",
    tag: "PARALLEL-HELPERS",
    // myrmidon(PARALLEL-HELPERS)
    use: (api, db, deps) => {
      api.use(myrmidonParallelHelpersRoutes(db));
    },
  },
  {
    name: "myrmidonTeamLivenessRoutes",
    tag: "TEAM-LIVENESS-SETTINGS",
    // myrmidon(TEAM-LIVENESS-SETTINGS)
    use: (api, db, deps) => {
      api.use(myrmidonTeamLivenessRoutes(db));
    },
  },
  {
    name: "myrmidonBotLspRoutes",
    tag: "BOT-LSP-DEFAULTS",
    // myrmidon(BOT-LSP-DEFAULTS)
    use: (api, db, deps) => {
      api.use(myrmidonBotLspRoutes(db));
    },
  },
  {
    name: "myrmidonReplayBlockedRoutes",
    tag: "N1",
    // myrmidon(N1)
    use: (api, db, deps) => {
      api.use(myrmidonReplayBlockedRoutes(db));
    },
  },
  {
    name: "aboutRoutes",
    tag: "ABOUT",
    // myrmidon(ABOUT)
    use: (api, db, deps) => {
      api.use(aboutRoutes());
    },
  },
  {
    name: "myrmidonBotContainerRoutes",
    tag: "W2b",
    // myrmidon(W2b)
    use: (api, db, deps) => {
      api.use(myrmidonBotContainerRoutes(db));
    },
  },
  {
    name: "myrmidonBrowserConsoleRoutes",
    tag: "BROWSER-CONSOLE",
    // myrmidon(BROWSER-CONSOLE)
    use: (api, db, deps) => {
      api.use(myrmidonBrowserConsoleRoutes(db));
    },
  },
  {
    name: "myrmidonLitellmCostsRoutes",
    tag: "M2-A",
    // myrmidon(M2-A): gateway-collected costs and model catalog
    use: (api, db, deps) => {
      api.use(myrmidonLitellmCostsRoutes(db));
    },
  },
  {
    name: "myrmidonLitellmKeysRoutes",
    tag: "M2-B",
    // myrmidon(M2-B): per-agent gateway keys and fallback topology
    use: (api, db, deps) => {
      api.use(myrmidonLitellmKeysRoutes(db));
    },
  },
  {
    name: "myrmidonModelProviderRoutes",
    tag: "1.6.1 MODEL-PROVIDERS A+B",
    // myrmidon(1.6.1 MODEL-PROVIDERS A+B): model-provider store, settings API and LiteLLM sync
    use: (api, db, deps) => {
      api.use(myrmidonModelProviderRoutes(db));
    },
  },
  {
    name: "myrmidonAgentExchangeRoutes",
    tag: "1.7-AGENT-EXCHANGE-A",
    // myrmidon(1.7-AGENT-EXCHANGE-A): discussion rooms on issue cards
    use: (api, db, deps) => {
      api.use(myrmidonAgentExchangeRoutes(db));
    },
  },
  {
    name: "myrmidonBaselineRoutes",
    tag: "1.6-BASELINE",
    // myrmidon(1.6-BASELINE): cycle/review/return/blocked/run/cost metrics
    use: (api, db, deps) => {
      api.use(myrmidonBaselineRoutes(db));
    },
  },
  {
    name: "myrmidonBotEgressRoutes",
    tag: "EGRESS-B",
    // myrmidon(EGRESS-B)
    use: (api, db, deps) => {
      api.use(myrmidonBotEgressRoutes(db));
    },
  },
  {
    name: "myrmidonBotCanaryRoutes",
    tag: "R5-B",
    // myrmidon(R5-B)
    use: (api, db, deps) => {
      api.use(myrmidonBotCanaryRoutes(db));
    },
  },
  {
    name: "myrmidonWorkspaceHygieneRoutes",
    tag: "WORKSPACE-HYGIENE",
    // myrmidon(WORKSPACE-HYGIENE)
    use: (api, db, deps) => {
      api.use(myrmidonWorkspaceHygieneRoutes(db));
    },
  },
  {
    name: "myrmidonHostDiskRoutes",
    tag: "BOT-DISK E",
    // myrmidon(BOT-DISK E)
    use: (api, db, deps) => {
      api.use(myrmidonHostDiskRoutes(db));
    },
  },
  {
    name: "myrmidonAlertRecoveryRoutes",
    tag: "1.6.6-MONITORING-D",
    // myrmidon(1.6.6-MONITORING-D)
    use: (api, db, deps) => {
      api.use(myrmidonAlertRecoveryRoutes(db));
    },
  },
  {
    name: "myrmidonBotDiskLifecycleRoutes",
    tag: "BOT-DISK-A",
    // myrmidon(BOT-DISK-A)
    use: (api, db, deps) => {
      api.use(myrmidonBotDiskLifecycleRoutes(db));
    },
  },
  {
    name: "myrmidonBotScopeRoutes",
    tag: "BOT-DISK-F",
    // myrmidon(BOT-DISK-F)
    use: (api, db, deps) => {
      api.use(myrmidonBotScopeRoutes(db));
    },
  },
  {
    name: "myrmidonBotDiskQuotaRoutes",
    tag: "1.6.1-BOT-DISK-C",
    // myrmidon(1.6.1-BOT-DISK-C)
    use: (api, db, deps) => {
      api.use(myrmidonBotDiskQuotaRoutes(db));
    },
  },
  {
    name: "myrmidonBotWorkspacesRoutes",
    tag: "1.6.5-BOT-DISK-H4a",
    // myrmidon(1.6.5-BOT-DISK-H4a)
    use: (api, db, deps) => {
      api.use(myrmidonBotWorkspacesRoutes(db));
    },
  },
  {
    name: "myrmidonBotImageRolloutRoutes",
    tag: "BOT-ROLLOUT",
    // myrmidon(BOT-ROLLOUT)
    use: (api, db, deps) => {
      api.use(myrmidonBotImageRolloutRoutes(db));
    },
  },
  {
    name: "swarmClaimApp",
    tag: "1.6-SWARM",
    // myrmidon(1.6-SWARM): per-role queues with leased claims
    use: (api, db, deps) => {
      api.use(swarmClaimApp({
        db,
        settings: deps.instanceSettingsService(db),
        // agent claim wake goes through the board queue admission; heartbeat injects it at runtime
        enqueueWakeup: undefined,
        env: process.env,
      }));
    },
  },
  {
    name: "myrmidonEmergencyStopRoutes",
    tag: "EMERGENCY-STOP",
    // myrmidon(EMERGENCY-STOP)
    use: (api, db, deps) => {
      api.use(myrmidonEmergencyStopRoutes(db));
    },
  },
  {
    name: "myrmidonAgentMemoryRoutes",
    tag: "MEMORY-UI",
    // myrmidon(MEMORY-UI): agent card Memory tab
    use: (api, db, deps) => {
      api.use(myrmidonAgentMemoryRoutes(db));
    },
  },
  {
    name: "myrmidonAgentMemorySettingsRoutes",
    tag: "MEMORY-UI",
    // myrmidon(MEMORY-UI): Memory tab settings (instance admin)
    use: (api, db, deps) => {
      api.use(myrmidonAgentMemorySettingsRoutes(db));
    },
  },
  {
    name: "myrmidonSkillLifecycleRoutes",
    tag: "1.6-SKILL-LIFE",
    // myrmidon(1.6-SKILL-LIFE): skill lifecycle API
    use: (api, db, deps) => {
      api.use(myrmidonSkillLifecycleRoutes(db));
    },
  },
  {
    name: "myrmidonStackRegistryRoutes",
    tag: "SUA",
    // myrmidon(SUA)
    use: (api, db, deps) => {
      api.use(myrmidonStackRegistryRoutes(db));
    },
  },
  {
    name: "myrmidonWipLimitRoutes",
    tag: "1.6.1-WIP-LIMIT-A",
    // myrmidon(1.6.1-WIP-LIMIT-A): per-agent WIP limit settings and status
    use: (api, db, deps) => {
      api.use(myrmidonWipLimitRoutes(db));
    },
  },
  {
    name: "modelFallbackSignalRoutes",
    tag: "BOT-RUNTIME-TUNING D2",
    // myrmidon(BOT-RUNTIME-TUNING D2): fallback-signal settings and the live per-agent fallback share
    use: (api, db, deps) => {
      api.use(modelFallbackSignalRoutes(db));
    },
  },
  {
    name: "reviewRoutingRoutes",
    tag: "REVIEW-ROUTING",
    // myrmidon(REVIEW-ROUTING): automatic reviewer routing settings
    use: (api, db, deps) => {
      api.use(reviewRoutingRoutes(db));
    },
  },
  {
    name: "reviewReworkRoutes",
    tag: "REVIEW-REWORK",
    // myrmidon(REVIEW-REWORK): review-return loop settings
    use: (api, db, deps) => {
      api.use(reviewReworkRoutes(db));
    },
  },
  {
    name: "pluginEntitlementRoutes",
    tag: "PLUGIN-ENTITLEMENT C",
    // myrmidon(PLUGIN-ENTITLEMENT C): accept/remove plugin keys (instance admin)
    use: (api, db, deps) => {
      api.use(pluginEntitlementRoutes(db));
    },
  },
  {
    name: "myrmidonLitellmBudgetSyncRoutes",
    tag: "1.7-BUDGET-CONFIG-C",
    // myrmidon(1.7-BUDGET-CONFIG-C): LiteLLM budget projection settings, status, re-sync
    use: (api, db, deps) => {
      api.use(myrmidonLitellmBudgetSyncRoutes(db));
    },
  },
  {
    name: "agentInstructionsRevisionsRoutes",
    tag: "H2",
    // myrmidon(H2)
    use: (api, db, deps) => {
      api.use(agentInstructionsRevisionsRoutes(db));
    },
  },
  {
    name: "myrmidonFleetConsoleRoutes",
    tag: "SC1",
    // myrmidon(SC1)
    use: (api, db, deps) => {
      api.use(myrmidonFleetConsoleRoutes(db));
    },
  },
  {
    name: "myrmidonCloudConnectorRoutes",
    tag: "CLOUD-CONNECTOR",
    // myrmidon(CLOUD-CONNECTOR)
    use: (api, db, deps) => {
      api.use(myrmidonCloudConnectorRoutes(db));
    },
  },
  {
    name: "myrmidonPromptBudgetAdviceRoutes",
    tag: "1.6.3 PROMPT-BUDGET C",
    // myrmidon(1.6.3 PROMPT-BUDGET C): prompt-budget advice and deep analysis
    use: (api, db, deps) => {
      api.use(myrmidonPromptBudgetAdviceRoutes(db));
    },
  },
  {
    name: "myrmidonMonitoringLinkRoutes",
    tag: "1.6.6 MONITORING E",
    // myrmidon(1.6.6 MONITORING E): link liveness feed and the link pulse endpoint
    use: (api, db, deps) => {
      api.use(myrmidonMonitoringLinkRoutes(db));
    },
  },
  {
    name: "myrmidonPromptBudgetRoutes",
    tag: "1.6.3 PROMPT-BUDGET B",
    // myrmidon(1.6.3 PROMPT-BUDGET B): prompt-budget threshold settings and status
    use: (api, db, deps) => {
      api.use(myrmidonPromptBudgetRoutes(db));
    },
  },
  {
    name: "myrmidonAutonomyRoutes",
    tag: "1.6-AUTONOMY",
    // myrmidon(1.6-AUTONOMY): role × action-class matrix and regulations
    use: (api, db, deps) => {
      api.use(myrmidonAutonomyRoutes(db));
    },
  },
  {
    name: "accessHubRoutes",
    tag: "SEC1",
    // myrmidon(SEC1): access-hub routes
    use: (api, db, deps) => {
      api.use(accessHubRoutes(db));
    },
  },
  {
    name: "myrmidonBrowserBridgeRoutes",
    tag: "EXTCASE-B",
    // myrmidon(EXTCASE-B): bridge panel (codes, devices, allowlist)
    use: (api, db, deps) => {
      api.use(myrmidonBrowserBridgeRoutes(db));
    },
  },
  {
    name: "myrmidonOcrRoutes",
    tag: "EXT-CASE-OCR",
    // myrmidon(EXT-CASE-OCR): company OCR MCP endpoint (ocr.pdf)
    use: (api, db, deps) => {
      api.use(myrmidonOcrRoutes(db));
    },
  },
  {
    name: "myrmidonSttRoutes",
    tag: "1.6.1 VOICE-STT A1",
    // myrmidon(1.6.1 VOICE-STT A1)
    use: (api, db, deps) => {
      api.use(myrmidonSttRoutes(db));
    },
  },
  {
    name: "myrmidonGitHubSharedIdentityRoutes",
    tag: "GITHUB-SHARED-IDENTITY",
    // myrmidon(GITHUB-SHARED-IDENTITY): access rules of the shared GitHub authorization
    use: (api, db, deps) => {
      api.use(myrmidonGitHubSharedIdentityRoutes(db));
    },
  },
  {
    name: "myrmidonVoiceMeetingProtocolRoutes",
    tag: "1.6.5-VOICE-STT-B",
    // myrmidon(1.6.5 VOICE-STT B): meeting protocol from a labeled transcript
    use: (api, db, deps) => {
      api.use(myrmidonVoiceMeetingProtocolRoutes());
    },
  },
  {
    name: "myrmidonEvalsRoutes",
    tag: "1.6-EVALS",
    // myrmidon(1.6-EVALS): reference-task evals (judge runs, scores, verdict)
    use: (api, db, deps) => {
      api.use(myrmidonEvalsRoutes(db));
    },
  },
  {
    name: "myrmidonDebateRoutes",
    tag: "1.7-DEBATE-ASYM-A",
    // myrmidon(1.7-DEBATE-ASYM-A): asymmetric debates (roles, rounds, token ceiling, cost, result document)
    use: (api, db, deps) => {
      api.use(myrmidonDebateRoutes(db));
    },
  },
  {
    name: "myrmidonTracingHealthRoutes",
    tag: "TRACING-HEALTH",
    // myrmidon(TRACING-HEALTH): LLM tracing health check
    use: (api, db, deps) => {
      api.use(myrmidonTracingHealthRoutes(db));
    },
  },
  {
    name: "myrmidonCtoChatRoutes",
    tag: "1.6-CTO-CHAT-B",
    // myrmidon(1.6-CTO-CHAT-B): board chat planner (owner text -> proposed epic)
    use: (api, db, deps) => {
      api.use(myrmidonCtoChatRoutes(db));
    },
  },
  {
    name: "myrmidonSwarmSupervisorRoutes",
    tag: "1.6-SWARM-CLAIM-B",
    // myrmidon(1.6-SWARM-CLAIM-B): supervisor view, rebalance, pilot report
    use: (api, db, deps) => {
      api.use(myrmidonSwarmSupervisorRoutes(db));
    },
  },
  {
    name: "myrmidonTelegramNotifyRoutes",
    tag: "TG-NOTIFY-A",
    // myrmidon(TG-NOTIFY-A): telegramNotify settings core (GET/PATCH + changelog)
    use: (api, db, deps) => {
      api.use(myrmidonTelegramNotifyRoutes(db));
    },
  },
  {
    name: "ui2LanguageRoutes",
    tag: "UI2-I18N",
    // myrmidon(UI2-I18N): per-user UI language preference
    use: (api, db, deps) => {
      api.use(ui2LanguageRoutes(db));
    },
  },
  {
    name: "myrmidonForagingRoutes",
    tag: "1.6-FORAGE",
    // myrmidon(1.6-FORAGE): source registry, findings and the manual sweep
    use: (api, db, deps) => {
      api.use(myrmidonForagingRoutes(db));
    },
  },
  {
    name: "myrmidonWikiCortexRoutes",
    tag: "1.6-WIKI",
    // myrmidon(1.6-WIKI): company regulations (wiki pages, revisions, resolver)
    use: (api, db, deps) => {
      api.use(myrmidonWikiCortexRoutes(db));
    },
  },
];

/**
 * Register every Myrmidon /api route module in the pinned order (phase (c)).
 * app.ts calls this exactly once, at the place of the old 61-mount block.
 */
export function registerMyrmidonPlugin(api: Router, db: Db, deps: MyrmidonPluginDeps): void {
  for (const mount of MYRMIDON_API_MOUNTS) {
    mount.use(api, db, deps);
  }
}
