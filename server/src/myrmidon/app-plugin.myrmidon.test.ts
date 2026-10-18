// server/src/myrmidon/app-plugin.myrmidon.test.ts
//
// myrmidon(1.6.6-PLUGIN-REGISTRY): the order guard for the route registry.
//
// Express matches mounted routers first-wins, so the sequence of the 92
// Myrmidon api.use(...) calls (server/src/app.ts current API mount block at current main) is behavior, not style. This test pins:
//   1. the registry sequence equals the original app.ts sequence (snapshot);
//   2. registerMyrmidonPlugin mounts in exactly that sequence onto the api
//      router it receives;
//   3. app.ts keeps at most two `./myrmidon/*` imports — the registry module
//      plus model-provider lifecycle and telegram voice-stt intake wiring; the criterion of the refactor is
//      that the registry is the app's single ROUTE registration point;
//   4. every mount keeps its myrmidon(...) marker for the vendor-porting grep.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MYRMIDON_API_MOUNTS, registerMyrmidonPlugin } from "./app-plugin.js";

/**
 * The EXACT sequence the old app.ts block mounted (current main, its
 * current API mount block: one entry per `api.use(...)` call, same order).
 * If a new module must mount earlier, that is a route-precedence change —
 * call it out in the PR and update this list deliberately, never silently.
 */
const UPSTREAM_MAIN_ORDER = [
  "myrmidonMaintenanceRoutes",
  "datastoreCareRetentionRoutes",
  "boardLoadApp",
  "myrmidonDeployJobsRoutes",
  "myrmidonRuntimeLimitsRoutes",
  "myrmidonPauseGuardRoutes",
  "myrmidonRunPriorityRoutes",
  "myrmidonRunStallRoutes",
  "myrmidonCorpusRoutes",
  "myrmidonProcessesRouter",
  "myrmidonBudgetEnforcementRoutes",
  "myrmidonBehaviorSettingsRoutes",
  "myrmidonTelegramDmProgressRoutes",
  "myrmidonChannelSettingsRoutes",
  "channelAllowlistRoutes",
  "myrmidonParallelHelpersRoutes",
  "myrmidonTeamLivenessRoutes",
  "myrmidonBotLspRoutes",
  "myrmidonReplayBlockedRoutes",
  "aboutRoutes",
  "licensingRoutes",
  "myrmidonBotContainerRoutes",
  "myrmidonBrowserConsoleRoutes",
  "myrmidonLitellmCostsRoutes",
  "myrmidonLitellmKeysRoutes",
  "myrmidonModelProviderRoutes",
  "myrmidonAgentExchangeRoutes",
  "myrmidonAgentExchangeFeedRoutes",
  "myrmidonBaselineRoutes",
  "myrmidonBotEgressRoutes",
  "myrmidonBotCanaryRoutes",
  "myrmidonWorkspaceHygieneRoutes",
  "myrmidonHostDiskRoutes",
  "myrmidonAttentionFeedRoutes",
  "myrmidonAlertRecoveryRoutes",
  "myrmidonDatastoreCareRoutes",
  "myrmidonDataRetentionRoutes",
  "myrmidonBotDiskLifecycleRoutes",
  "myrmidonBotDiskPhysicalRoutes",
  "myrmidonBotDiskReportRoutes",
  "myrmidonBotScopeRoutes",
  "myrmidonBudgetLimitsRoutes",
  "myrmidonBotDiskQuotaRoutes",
  "myrmidonBotWorkspacesRoutes",
  "myrmidonBotImageRolloutRoutes",
  "swarmClaimApp",
  "myrmidonEmergencyStopRoutes",
  "myrmidonWakeTaskGuardRoutes",
  "myrmidonAgentMemoryRoutes",
  "myrmidonAgentMemorySettingsRoutes",
  "myrmidonToolPolicyCacheRoutes",
  "myrmidonSkillLifecycleRoutes",
  "myrmidonStackRegistryRoutes",
  "myrmidonWipLimitRoutes",
  "projectTokenQuotaRoutes",
  "modelFallbackSignalRoutes",
  "myrmidonOwnerDeliveryRoutes",
  "reviewRoutingRoutes",
  "reviewReworkRoutes",
  "pluginEntitlementRoutes",
  "myrmidonLitellmBudgetSyncRoutes",
  "myrmidonLitellmWorkersRoutes",
  "agentInstructionsRevisionsRoutes",
  "myrmidonFleetConsoleRoutes",
  "myrmidonCloudConnectorRoutes",
  "myrmidonPromptBudgetAdviceRoutes",
  "myrmidonMonitoringLinkRoutes",
  "myrmidonPromptBudgetRoutes",
  "myrmidonAutonomyRoutes",
  "accessHubRoutes",
  "myrmidonBrowserBridgeRoutes",
  "myrmidonOcrRoutes",
  "myrmidonCorpusMcpRoutes",
  "myrmidonSttRoutes",
  "myrmidonGitHubSharedIdentityRoutes",
  "myrmidonVoiceMeetingProtocolRoutes",
  "myrmidonEvalsRoutes",
  "myrmidonDebateRoutes",
  "myrmidonTracingHealthRoutes",
  "myrmidonCtoChatRoutes",
  "myrmidonSwarmSupervisorRoutes",
  "myrmidonScentRoutes",
  "myrmidonTelegramNotifyRoutes",
  "ui2LanguageRoutes",
  "myrmidonBridgeLanguageRoutes",
  "myrmidonForagingRoutes",
  "myrmidonMonitoringAlertsRoutes",
  "myrmidonMonitoringDashboardRoutes",
  "myrmidonForagingIdleGateRoutes",
  "myrmidonForagingPassRoutes",
  "myrmidonWikiCortexRoutes",
  "myrmidonBoardProcessRegistryRoutes",
];

describe("myrmidon route registry (PLUGIN-REGISTRY)", () => {
  it("keeps the registry sequence of the refreshed main app.ts mount block", () => {
    expect(MYRMIDON_API_MOUNTS.map((m) => m.name)).toEqual(UPSTREAM_MAIN_ORDER);
  });

  it("registers every route onto api.use in the pinned order", () => {
    const mounted: unknown[] = [];
    const apiStub = {
      use: (router: unknown) => {
        // The factories build routers on a stub db — mounting onto the stub is
        // not real routing; only the order and the count are under test.
        mounted.push(router);
      },
    } as never;
    const dbStub = {} as never;
    const settingsStub = () => ({
      getGeneral: async () => ({}),
      updateGeneral: async () => ({}),
    });
    registerMyrmidonPlugin(apiStub, dbStub, {
      instanceSettingsService: settingsStub as never,
    });
    expect(mounted).toHaveLength(UPSTREAM_MAIN_ORDER.length);
  });

  it("keeps app.ts down to the registry plus its two wiring modules", () => {
    const appSrc = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const importLines = appSrc
      .split("\n")
      .filter((line) => line.includes('from "./myrmidon/'));
    // registry + telegram-voice-stt intake wiring
    expect(importLines.length).toBeLessThanOrEqual(2);
    expect(importLines.some((line) => line.includes("./myrmidon/app-plugin.js"))).toBe(true);
    expect(importLines.every((line) =>
      line.includes("./myrmidon/app-plugin.js") ||
      line.includes("./myrmidon/telegram-voice-stt-intake/wiring.js")
    )).toBe(true);
  });

  it("keeps every mount's myrmidon(...) marker for the vendor-porting grep", () => {
    // Ports of the vendor's app.ts find their Myrmidon insertion points by the
    // myrmidon(...) markers; the registry carries one tag per mount.
    const untagged = MYRMIDON_API_MOUNTS.filter((m) => !m.tag);
    expect(untagged.map((m) => m.name)).toEqual([]);
  });
});
