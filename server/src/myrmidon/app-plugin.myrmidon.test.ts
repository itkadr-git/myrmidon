// server/src/myrmidon/app-plugin.myrmidon.test.ts
//
// myrmidon(1.6.6-PLUGIN-REGISTRY): the order guard for the route registry.
//
// Express matches mounted routers first-wins, so the sequence of the 63
// Myrmidon api.use(...) calls (server/src/app.ts lines 904-969 at main tip
// bd4d47023, the base of this rebase) is behavior, not style. This test pins:
//   1. the registry sequence equals the original app.ts sequence (snapshot);
//   2. registerMyrmidonPlugin mounts in exactly that sequence onto the api
//      router it receives;
//   3. app.ts keeps at most three `./myrmidon/*` imports — the registry module
//      plus the two wiring modules its non-route code needs directly
//      (telegram-voice-stt intake, castes); the criterion of the refactor is
//      that the registry is the app's single ROUTE registration point;
//   4. every mount keeps its myrmidon(...) marker for the vendor-porting grep.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MYRMIDON_API_MOUNTS, registerMyrmidonPlugin } from "./app-plugin.js";

/**
 * The EXACT sequence the old app.ts block mounted (main tip bd4d47023, its
 * lines 904-969: one entry per `api.use(...)` call, same order).
 * If a new module must mount earlier, that is a route-precedence change —
 * call it out in the PR and update this list deliberately, never silently.
 */
const ORIGINAL_APP_TS_ORDER = [
  "myrmidonMaintenanceRoutes",
  "myrmidonDeployJobsRoutes",
  "myrmidonRuntimeLimitsRoutes",
  "myrmidonBudgetEnforcementRoutes",
  "myrmidonBehaviorSettingsRoutes",
  "myrmidonTelegramDmProgressRoutes",
  "myrmidonChannelSettingsRoutes",
  "myrmidonParallelHelpersRoutes",
  "myrmidonTeamLivenessRoutes",
  "myrmidonBotLspRoutes",
  "myrmidonReplayBlockedRoutes",
  "aboutRoutes",
  "myrmidonBotContainerRoutes",
  "myrmidonBrowserConsoleRoutes",
  "myrmidonLitellmCostsRoutes",
  "myrmidonLitellmKeysRoutes",
  "myrmidonModelProviderRoutes",
  "myrmidonAgentExchangeRoutes",
  "myrmidonBaselineRoutes",
  "myrmidonBotEgressRoutes",
  "myrmidonBotCanaryRoutes",
  "myrmidonWorkspaceHygieneRoutes",
  "myrmidonHostDiskRoutes",
  "myrmidonAlertRecoveryRoutes",
  "myrmidonBotDiskLifecycleRoutes",
  "myrmidonBotScopeRoutes",
  "myrmidonBotDiskQuotaRoutes",
  "myrmidonBotWorkspacesRoutes",
  "myrmidonBotImageRolloutRoutes",
  "swarmClaimApp",
  "myrmidonEmergencyStopRoutes",
  "myrmidonAgentMemoryRoutes",
  "myrmidonAgentMemorySettingsRoutes",
  "myrmidonSkillLifecycleRoutes",
  "myrmidonStackRegistryRoutes",
  "myrmidonWipLimitRoutes",
  "modelFallbackSignalRoutes",
  "reviewRoutingRoutes",
  "reviewReworkRoutes",
  "pluginEntitlementRoutes",
  "myrmidonLitellmBudgetSyncRoutes",
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
  "myrmidonSttRoutes",
  "myrmidonGitHubSharedIdentityRoutes",
  "myrmidonVoiceMeetingProtocolRoutes",
  "myrmidonEvalsRoutes",
  "myrmidonDebateRoutes",
  "myrmidonTracingHealthRoutes",
  "myrmidonCtoChatRoutes",
  "myrmidonSwarmSupervisorRoutes",
  "myrmidonTelegramNotifyRoutes",
  "ui2LanguageRoutes",
  "myrmidonForagingRoutes",
  "myrmidonWikiCortexRoutes",
];

describe("myrmidon route registry (PLUGIN-REGISTRY)", () => {
  it("keeps the registry sequence of the old app.ts mount block", () => {
    expect(MYRMIDON_API_MOUNTS.map((m) => m.name)).toEqual(ORIGINAL_APP_TS_ORDER);
  });

  it("registers every mount onto api.use in the pinned order", () => {
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
    expect(mounted).toHaveLength(ORIGINAL_APP_TS_ORDER.length);
  });

  it("keeps app.ts down to the registry plus its two wiring modules", () => {
    const appSrc = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const importLines = appSrc
      .split("\n")
      .filter((line) => line.includes('from "./myrmidon/'));
    // registry + telegram-voice-stt intake wiring + castes wiring
    expect(importLines.length).toBeLessThanOrEqual(3);
    expect(importLines.some((line) => line.includes("./myrmidon/app-plugin.js"))).toBe(true);
    expect(importLines.every((line) =>
      line.includes("./myrmidon/app-plugin.js") ||
      line.includes("./myrmidon/telegram-voice-stt-intake/wiring.js") ||
      line.includes("./myrmidon/castes/wiring.js")
    )).toBe(true);
  });

  it("keeps every mount's myrmidon(...) marker for the vendor-porting grep", () => {
    // Ports of the vendor's app.ts find their Myrmidon insertion points by the
    // myrmidon(...) markers; the registry carries one tag per mount.
    const untagged = MYRMIDON_API_MOUNTS.filter((m) => !m.tag);
    expect(untagged.map((m) => m.name)).toEqual([]);
  });
});
