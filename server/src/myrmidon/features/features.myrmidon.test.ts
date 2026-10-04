// server/src/myrmidon/features/features.myrmidon.test.ts
//
// myrmidon(FEATURES): the Instance -> Features page. No database: the
// definitions read through ports, so each case hands them plain objects.
//
// The decisions pinned here:
//   1. a module with no health signal reports `unknown`, never `working`;
//   2. an enabled feature whose configuration cannot work is `misconfigured`
//      (the bot disk volume root that does not exist, a floor that cannot read
//      the host memory, a half-set pair of variables);
//   3. an enabled feature whose last pass failed is `failing`, with the error
//      and the 24-hour count;
//   4. a feature enabled and broken for more than 30 minutes raises an
//      attention signal, and only then;
//   5. the registry is complete: unique keys, real docs, effective config.

import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FEATURE_ATTENTION_AFTER_MS, isFeatureBroken, type FeatureView } from "@paperclipai/shared";
import { sweepBotVolume } from "../bot-containers/draft-lifecycle.js";
import {
  observeFeatureHealth,
  readFeatureAttentionSignals,
  resetFeatureAttention,
} from "./attention.js";
import { agentMemoryFeature } from "./definitions/agent-memory.js";
import { botDiskFeature } from "./definitions/bot-disk.js";
import { botLspFeature } from "./definitions/bot-lsp.js";
import { budgetEnforcementFeature } from "./definitions/budget-enforcement.js";
import { chatHoldsFeature } from "./definitions/chat-holds.js";
import { costAttributionFeature } from "./definitions/cost-attribution.js";
import { hostDiskFeature } from "./definitions/host-disk.js";
import { pluginEntitlementsFeature } from "./definitions/plugin-entitlements.js";
import { runAdmissionFeature } from "./definitions/run-admission.js";
import { sharedPackageCacheFeature } from "./definitions/shared-package-cache.js";
import { swarmClaimFeature } from "./definitions/swarm-claim.js";
import { telegramDmStatusFeature } from "./definitions/telegram-dm-status.js";
import { workspaceHygieneFeature } from "./definitions/workspace-hygiene.js";
import { recordBotDiskSweepOutcome, reportBotContainerEvent } from "./reporters.js";
import { FEATURE_REGISTRY } from "./registry.js";
import {
  recordFeatureOutcome,
  resetFeatureOutcomes,
  sanitizeOutcomeMessage,
  summarizeFeatureOutcomes,
} from "./recorder.js";
import { evaluateFeature, FeatureError, featuresService, summarizeStatuses } from "./service.js";
import type { FeatureContext, FeatureDefinition, FeaturePorts } from "./types.js";

const NOW = new Date("2026-10-04T12:00:00.000Z");
const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../..");

function fakePorts(overrides: Partial<FeaturePorts> = {}): FeaturePorts {
  return {
    activity: { count: async () => 0, latest: async () => null },
    companies: { ids: async () => ["company-a"] },
    agents: { roles: async () => ["engineer"] },
    runs: { queuedCount: async () => 0, lastStartedAt: async () => null },
    chatStatus: { stats: async () => ({ delivered: 0, failed: 0, lastDeliveredAt: null, lastError: null }) },
    costs: { stats: async () => ({ collected: 0, lastCollectedAt: null, unpricedStale: 0 }) },
    budget: { stats: async () => ({ activePolicies: 0, openIncidents: 0, incidentsSince: 0 }) },
    lsp: { modeCounts: async () => ({ total: 0, limited: 0, full: 0, off: 0 }) },
    runtime: {
      runAdmission: () => ({ gate: { state: "off", availableMb: null, thresholdMb: null, reason: null, heldSince: null } }),
      hostDisk: () => null,
      workspaceHygiene: () => null,
    },
    ...overrides,
  };
}

function ctx(
  options: { env?: Record<string, string>; general?: Record<string, unknown>; ports?: Partial<FeaturePorts> } = {},
): FeatureContext {
  return {
    env: options.env ?? {},
    general: options.general ?? {},
    now: NOW,
    since: new Date(NOW.getTime() - 24 * 60 * 60_000),
    ports: fakePorts(options.ports),
    outcomes: (key) => summarizeFeatureOutcomes(key, NOW),
  };
}

async function view(definition: FeatureDefinition, context: FeatureContext): Promise<FeatureView> {
  return evaluateFeature(definition, context);
}

beforeEach(() => {
  resetFeatureOutcomes();
  resetFeatureAttention();
});

describe("outcome recorder", () => {
  it("sums the effect, counts errors in 24 hours and keeps the last error redacted and short", () => {
    recordFeatureOutcome("k", { ok: true, effect: 3, at: new Date(NOW.getTime() - 60_000) });
    recordFeatureOutcome("k", { ok: true, effect: 2, at: new Date(NOW.getTime() - 30_000) });
    recordFeatureOutcome("k", { ok: false, error: `failed ${"x".repeat(1000)}`, at: new Date(NOW.getTime() - 10_000) });
    const summary = summarizeFeatureOutcomes("k", NOW);
    expect(summary.effect24h).toBe(5);
    expect(summary.errors24h).toBe(1);
    expect(summary.lastOk).toBe(false);
    expect(summary.lastError!.length).toBeLessThanOrEqual(300);
    expect(summary.lastSuccessAt?.getTime()).toBe(NOW.getTime() - 30_000);
  });

  it("drops events older than 24 hours from the counts but keeps the last success time", () => {
    recordFeatureOutcome("k", { ok: true, effect: 9, at: new Date(NOW.getTime() - 26 * 60 * 60_000) });
    recordFeatureOutcome("k", { ok: false, error: "old", at: new Date(NOW.getTime() - 25 * 60 * 60_000) });
    const summary = summarizeFeatureOutcomes("k", NOW);
    expect(summary.effect24h).toBe(0);
    expect(summary.errors24h).toBe(0);
    expect(summary.lastSuccessAt).not.toBeNull();
  });

  it("reports nothing recorded for an unknown key", () => {
    const summary = summarizeFeatureOutcomes("never-ran", NOW);
    expect(summary.lastRunAt).toBeNull();
    expect(summary.lastOk).toBeNull();
  });

  it("collapses whitespace and truncates an error text before it is stored", () => {
    const text = sanitizeOutcomeMessage(`first line\n\n  second   line ${"y".repeat(500)}`);
    expect(text.startsWith("first line second line")).toBe(true);
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith("\u2026")).toBe(true);
  });
});

describe("swarm self-claim", () => {
  const enabled = { swarmClaim: { enabled: true, enabledRoles: [], enabledCompanyIds: [], leaseTtlSec: 900, maxActiveTasks: 3, sweepIntervalSec: 30, p0Preemption: true } };

  it("is off while the switch is off, and the toggle is offered", async () => {
    const result = await view(swarmClaimFeature, ctx());
    expect(result.health.status).toBe("off");
    expect(result.toggle).toEqual({ enabled: false, lockedBy: null });
  });

  it("locks the toggle when an environment variable forces the switch", async () => {
    const result = await view(swarmClaimFeature, ctx({ env: { MYRMIDON_SWARM_CLAIM_ENABLED: "1" } }));
    expect(result.toggle).toEqual({ enabled: true, lockedBy: "env" });
    expect(result.config.find((item) => item.label === "Enabled")?.source).toBe("env");
  });

  it("is misconfigured when the pilot role list matches no agent", async () => {
    const result = await view(
      swarmClaimFeature,
      ctx({ general: { swarmClaim: { ...enabled.swarmClaim, enabledRoles: ["designer"] } } }),
    );
    expect(result.health.status).toBe("misconfigured");
    expect(result.health.reason).toContain("role list");
  });

  it("is misconfigured when the pilot company list matches no company", async () => {
    const result = await view(
      swarmClaimFeature,
      ctx({ general: { swarmClaim: { ...enabled.swarmClaim, enabledCompanyIds: ["company-z"] } } }),
    );
    expect(result.health.status).toBe("misconfigured");
  });

  it("fails when free agents sit next to a queue and nothing was claimed or woken in 24 h", async () => {
    recordFeatureOutcome("swarm-claim", { ok: true, effect: 0, detail: { idleFreeAgents: 2 }, at: new Date(NOW.getTime() - 1000) });
    const result = await view(swarmClaimFeature, ctx({ general: enabled }));
    expect(result.health.status).toBe("failing");
    expect(result.health.effect).toEqual({ label: "issues claimed in 24 h", value: 0 });
  });

  it("fails when the last sweep pass failed", async () => {
    recordFeatureOutcome("swarm-claim", { ok: false, error: "the idle wake pass failed", at: new Date(NOW.getTime() - 1000) });
    const result = await view(swarmClaimFeature, ctx({ general: enabled }));
    expect(result.health.status).toBe("failing");
    expect(result.health.errors24h).toBe(1);
  });

  it("is working once something was claimed, with the claim count as the effect", async () => {
    recordFeatureOutcome("swarm-claim", { ok: true, at: new Date(NOW.getTime() - 1000) });
    const result = await view(
      swarmClaimFeature,
      ctx({
        general: enabled,
        ports: { activity: { count: async () => 4, latest: async () => new Date(NOW.getTime() - 5000) } },
      }),
    );
    expect(result.health.status).toBe("working");
    expect(result.health.effect?.value).toBe(4);
  });

  it("is unknown, not working, when no pass ran and nothing was claimed", async () => {
    const result = await view(swarmClaimFeature, ctx({ general: enabled }));
    expect(result.health.status).toBe("unknown");
  });
});

describe("run admission", () => {
  it("is off with no limit", async () => {
    const result = await view(
      runAdmissionFeature,
      ctx({ env: { MYRMIDON_MAX_RUN_STARTS_PER_MINUTE: "off", MYRMIDON_MIN_FREE_HOST_MEMORY_MB: "off" } }),
    );
    expect(result.health.status).toBe("off");
  });

  it("is misconfigured when the host floor cannot read the host memory", async () => {
    const result = await view(
      runAdmissionFeature,
      ctx({
        ports: {
          runtime: {
            ...fakePorts().runtime,
            runAdmission: () => ({ gate: { state: "unknown", availableMb: null, thresholdMb: 15360, reason: "meminfo is scoped to the container", heldSince: null } }),
          },
        },
      }),
    );
    expect(result.health.status).toBe("misconfigured");
    expect(result.health.reason).toContain("meminfo is scoped");
  });

  it("is working with the queued runs as the effect while the floor holds runs back", async () => {
    const result = await view(
      runAdmissionFeature,
      ctx({
        ports: {
          runs: { queuedCount: async () => 7, lastStartedAt: async () => new Date(NOW.getTime() - 60_000) },
          runtime: {
            ...fakePorts().runtime,
            runAdmission: () => ({ gate: { state: "closed", availableMb: 4000, thresholdMb: 15360, reason: "host MemAvailable 4000 MB is below the 15360 MB floor", heldSince: new Date(NOW.getTime() - 120_000) } }),
          },
        },
      }),
    );
    expect(result.health.status).toBe("working");
    expect(result.health.effect).toEqual({ label: "runs held in the queue now", value: 7 });
  });
});

describe("bot disk lifecycle", () => {
  const containers = { MYRMIDON_BOT_CONTAINERS: "1", MYRMIDON_BOT_VOLUME_ROOT: "/srv/bots" };

  it("is off when bot containers are off, even with the switch on", async () => {
    const result = await view(botDiskFeature, ctx());
    expect(result.health.status).toBe("off");
  });

  it("is misconfigured when bot containers are on and the volume root is not set", async () => {
    const result = await view(botDiskFeature, ctx({ env: { MYRMIDON_BOT_CONTAINERS: "1" } }));
    expect(result.health.status).toBe("misconfigured");
    expect(result.health.reason).toContain("MYRMIDON_BOT_VOLUME_ROOT");
  });

  it("reports a volume root that does not exist as misconfigured, not as a silent success", async () => {
    recordBotDiskSweepOutcome({
      rootError: { code: "ENOENT", message: "ENOENT: no such file or directory, scandir '/srv/bots'" },
      reaped: 0,
      errors: 0,
      firstError: null,
      skipped: false,
    });
    const result = await view(botDiskFeature, ctx({ env: containers }));
    expect(result.health.status).toBe("misconfigured");
    expect(result.health.errors24h).toBe(1);
    expect(result.health.lastError?.message).toContain("ENOENT");
  });

  it("is failing for any other sweep error, and working with the reaped count after a clean pass", async () => {
    recordBotDiskSweepOutcome(null, new Error("EACCES"));
    expect((await view(botDiskFeature, ctx({ env: containers }))).health.status).toBe("failing");
    recordBotDiskSweepOutcome({ rootError: null, reaped: 3, errors: 0, firstError: null, skipped: false });
    const healthy = await view(botDiskFeature, ctx({ env: containers }));
    expect(healthy.health.status).toBe("working");
    expect(healthy.health.effect).toEqual({ label: "draft directories reaped in 24 h", value: 3 });
  });

  it("is unknown before the first pass", async () => {
    expect((await view(botDiskFeature, ctx({ env: containers }))).health.status).toBe("unknown");
  });

  it("does not count a pass skipped by the switch", async () => {
    recordBotDiskSweepOutcome({ rootError: null, reaped: 0, errors: 0, firstError: null, skipped: true });
    expect(summarizeFeatureOutcomes("bot-disk-lifecycle", NOW).lastRunAt).toBeNull();
  });

  it("offers the inline switch", async () => {
    expect((await view(botDiskFeature, ctx({ env: containers }))).toggle).toEqual({ enabled: true, lockedBy: null });
  });
});

describe("bot disk sweep report (the sweep itself)", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "features-bot-disk-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const config = { enabled: true, idleTtlMs: 60_000, defaultIdleTtlMs: 60_000 };

  it("reports a missing root as a root error with the code", async () => {
    const report = await sweepBotVolume(join(root, "missing"), config);
    expect(report.rootError?.code).toBe("ENOENT");
    expect(report.reaped).toBe(0);
  });

  it("reports the draft directories it reaped and keeps the memory volume", async () => {
    const draft = join(root, "bot-a", "scratch", "old-clone");
    const memory = join(root, "bot-a", "hermes", "memory");
    mkdirSync(draft, { recursive: true });
    mkdirSync(memory, { recursive: true });
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(draft, old, old);
    const report = await sweepBotVolume(root, config);
    expect(report.rootError).toBeNull();
    expect(report.reaped).toBe(1);
    expect(existsSync(draft)).toBe(false);
    expect(existsSync(memory)).toBe(true);
  });

  it("reports a skipped pass when the lifecycle is off", async () => {
    const report = await sweepBotVolume(root, { ...config, enabled: false });
    expect(report.skipped).toBe(true);
  });
});

describe("shared package cache", () => {
  const withCache = { botDisk: { enabled: true, idleTtlMs: 3_600_000, sharedPackageCachePath: "/srv/package-cache" } };
  const env = { MYRMIDON_BOT_CONTAINERS: "1" };

  it("is off without a path", async () => {
    expect((await view(sharedPackageCacheFeature, ctx({ env }))).health.status).toBe("off");
  });

  it("reads a stored path the driver would refuse as no cache at all", async () => {
    const result = await view(sharedPackageCacheFeature, ctx({ env, general: { botDisk: { sharedPackageCachePath: "/srv/../cache" } } }));
    expect(result.health.status).toBe("off");
  });

  it("is failing after the socket filter refused a bind, and says what to do", async () => {
    reportBotContainerEvent({ level: "error", message: "bot container reconcile failed", details: { error: "mount_source_not_allowed: /srv/package-cache/pnpm" } });
    const result = await view(sharedPackageCacheFeature, ctx({ env, general: withCache }));
    expect(result.health.status).toBe("failing");
    expect(result.health.reason).toContain("packageCacheRoot");
  });

  it("is working after a bot was recreated with the binds", async () => {
    reportBotContainerEvent({ level: "info", message: "bot container recreated for a template change (image, resource limits or network)" });
    const result = await view(sharedPackageCacheFeature, ctx({ env, general: withCache }));
    expect(result.health.status).toBe("working");
  });

  it("is unknown, not working, when nothing exercised the filter yet", async () => {
    const result = await view(sharedPackageCacheFeature, ctx({ env, general: withCache }));
    expect(result.health.status).toBe("unknown");
  });

  it("ignores reconcile events that are not about a bind", () => {
    reportBotContainerEvent({ level: "error", message: "bot container reconcile failed", details: { error: "image not allowed" } });
    reportBotContainerEvent({ level: "info", message: "bot container restarted with updated profile" });
    expect(summarizeFeatureOutcomes("shared-package-cache", NOW).lastRunAt).toBeNull();
  });
});

describe("bot language servers", () => {
  it("reports unknown with what is known, never working", async () => {
    const result = await view(
      botLspFeature,
      ctx({ ports: { lsp: { modeCounts: async () => ({ total: 5, limited: 3, full: 1, off: 1 }) } } }),
    );
    expect(result.health.status).toBe("unknown");
    expect(result.health.reason).toContain("no health signal");
    expect(result.health.effect?.value).toBe(4);
  });

  it("is off when no bot resolves to a mode", async () => {
    expect((await view(botLspFeature, ctx())).health.status).toBe("off");
  });
});

describe("agent memory card", () => {
  const both = { MYRMIDON_HINDSIGHT_API_URL: "http://127.0.0.1:8888", MYRMIDON_HINDSIGHT_KEY_SECRET: "memory-key" };

  it("is off when neither variable is set", async () => {
    expect((await view(agentMemoryFeature, ctx())).health.status).toBe("off");
  });

  it("is misconfigured when only one of the pair is set", async () => {
    const result = await view(agentMemoryFeature, ctx({ env: { MYRMIDON_HINDSIGHT_API_URL: "http://127.0.0.1:8888" } }));
    expect(result.health.status).toBe("misconfigured");
    expect(result.health.reason).toContain("MYRMIDON_HINDSIGHT_KEY_SECRET");
  });

  it("does not print the service address or a secret", async () => {
    const result = await view(agentMemoryFeature, ctx({ env: both }));
    const text = JSON.stringify(result);
    expect(text).not.toContain("127.0.0.1:8888");
  });

  it("is unknown until a card request reached the service, then follows the last call", async () => {
    expect((await view(agentMemoryFeature, ctx({ env: both }))).health.status).toBe("unknown");
    recordFeatureOutcome("agent-memory", { ok: true, effect: 1, at: new Date(NOW.getTime() - 1000) });
    expect((await view(agentMemoryFeature, ctx({ env: both }))).health.status).toBe("working");
    recordFeatureOutcome("agent-memory", { ok: false, error: "HTTP 503", at: new Date(NOW.getTime() - 500) });
    expect((await view(agentMemoryFeature, ctx({ env: both }))).health.status).toBe("failing");
  });
});

describe("cost attribution sweep", () => {
  const both = { MYRMIDON_LITELLM_BASE_URL: "http://127.0.0.1:4000", MYRMIDON_LITELLM_KEY_SECRET: "gateway-key" };

  it("is off without the pair and misconfigured with half of it", async () => {
    expect((await view(costAttributionFeature, ctx())).health.status).toBe("off");
    const half = await view(costAttributionFeature, ctx({ env: { MYRMIDON_LITELLM_BASE_URL: "http://127.0.0.1:4000" } }));
    expect(half.health.status).toBe("misconfigured");
  });

  it("is failing when the last pass failed", async () => {
    recordFeatureOutcome("cost-attribution", { ok: false, error: "the gateway key secret was not found in any company", at: new Date(NOW.getTime() - 1000) });
    const result = await view(costAttributionFeature, ctx({ env: both }));
    expect(result.health.status).toBe("failing");
  });

  it("is failing when runs stay unpriced and nothing was collected", async () => {
    recordFeatureOutcome("cost-attribution", { ok: true, at: new Date(NOW.getTime() - 1000) });
    const result = await view(
      costAttributionFeature,
      ctx({ env: both, ports: { costs: { stats: async () => ({ collected: 0, lastCollectedAt: null, unpricedStale: 5 }) } } }),
    );
    expect(result.health.status).toBe("failing");
  });

  it("is working with the attributed rows as the effect", async () => {
    recordFeatureOutcome("cost-attribution", { ok: true, at: new Date(NOW.getTime() - 1000) });
    const result = await view(
      costAttributionFeature,
      ctx({ env: both, ports: { costs: { stats: async () => ({ collected: 120, lastCollectedAt: NOW, unpricedStale: 0 }) } } }),
    );
    expect(result.health.status).toBe("working");
    expect(result.health.effect?.value).toBe(120);
  });
});

describe("telegram DM status", () => {
  const on = { MYRMIDON_TELEGRAM_DM_STATUS: "1", MYRMIDON_TELEGRAM_DM_CONVERSATIONS: "*" };

  it("is off by default", async () => {
    expect((await view(telegramDmStatusFeature, ctx())).health.status).toBe("off");
  });

  it("is misconfigured when the status is on but no DM is bridged", async () => {
    const result = await view(telegramDmStatusFeature, ctx({ env: { MYRMIDON_TELEGRAM_DM_STATUS: "1" } }));
    expect(result.health.status).toBe("misconfigured");
  });

  it("is failing when deliveries failed and none succeeded after the failure", async () => {
    const result = await view(
      telegramDmStatusFeature,
      ctx({
        env: on,
        ports: {
          chatStatus: {
            stats: async () => ({
              delivered: 2,
              failed: 3,
              lastDeliveredAt: new Date(NOW.getTime() - 3_600_000),
              lastError: { at: new Date(NOW.getTime() - 60_000), message: "provider rejected the edit" },
            }),
          },
        },
      }),
    );
    expect(result.health.status).toBe("failing");
    expect(result.health.errors24h).toBe(3);
  });

  it("is working with delivered messages as the effect, unknown with none", async () => {
    const working = await view(
      telegramDmStatusFeature,
      ctx({ env: on, ports: { chatStatus: { stats: async () => ({ delivered: 9, failed: 0, lastDeliveredAt: NOW, lastError: null }) } } }),
    );
    expect(working.health.status).toBe("working");
    expect((await view(telegramDmStatusFeature, ctx({ env: on }))).health.status).toBe("unknown");
  });
});

describe("chat hold rules", () => {
  it("is unknown without a lift and working with one, and has no switch", async () => {
    const quiet = await view(chatHoldsFeature, ctx());
    expect(quiet.health.status).toBe("unknown");
    expect(quiet.enabled).toBeNull();
    expect(quiet.toggle).toBeNull();
    const active = await view(chatHoldsFeature, ctx({ ports: { activity: { count: async () => 2, latest: async () => NOW } } }));
    expect(active.health.status).toBe("working");
  });
});

describe("budget enforcement", () => {
  it("is off with signal-only mode and no active limit", async () => {
    expect((await view(budgetEnforcementFeature, ctx())).health.status).toBe("off");
  });

  it("is misconfigured when a stopping mode has no active limit to act on", async () => {
    const result = await view(budgetEnforcementFeature, ctx({ general: { budgetEnforcement: { mode: "hard" } } }));
    expect(result.health.status).toBe("misconfigured");
  });

  it("is working with active limits and reports the incidents of the day", async () => {
    const result = await view(
      budgetEnforcementFeature,
      ctx({
        general: { budgetEnforcement: { mode: "soft" } },
        ports: { budget: { stats: async () => ({ activePolicies: 2, openIncidents: 1, incidentsSince: 1 }) } },
      }),
    );
    expect(result.health.status).toBe("working");
    expect(result.health.effect?.value).toBe(1);
  });
});

describe("plugin entitlements", () => {
  it("is off with no keys, working with live keys, misconfigured with an expired one", async () => {
    expect((await view(pluginEntitlementsFeature, ctx())).health.status).toBe("off");
    const live = { pluginEntitlementKeys: [{ pluginId: "example.plugin", key: "example-entitlement-value", expiresAt: null, acceptedAt: null }] };
    expect((await view(pluginEntitlementsFeature, ctx({ general: live }))).health.status).toBe("working");
    const expired = { pluginEntitlementKeys: [{ pluginId: "example.plugin", key: "example-entitlement-value", expiresAt: "2020-01-01T00:00:00.000Z", acceptedAt: null }] };
    const result = await view(pluginEntitlementsFeature, ctx({ general: expired }));
    expect(result.health.status).toBe("misconfigured");
    expect(JSON.stringify(result)).not.toContain("example-entitlement-value");
  });
});

describe("host disk and workspace quotas", () => {
  it("host disk: unknown before a sweep, misconfigured when the root cannot be measured, working otherwise", async () => {
    expect((await view(hostDiskFeature, ctx())).health.status).toBe("unknown");
    const broken = await view(
      hostDiskFeature,
      ctx({ ports: { runtime: { ...fakePorts().runtime, hostDisk: () => ({ at: NOW.toISOString(), usedPercent: null, thresholdPercent: 85, overThreshold: false, error: "usage unavailable" }) } } }),
    );
    expect(broken.health.status).toBe("misconfigured");
    const fine = await view(
      hostDiskFeature,
      ctx({ ports: { runtime: { ...fakePorts().runtime, hostDisk: () => ({ at: NOW.toISOString(), usedPercent: 61, thresholdPercent: 85, overThreshold: false, error: null }) } } }),
    );
    expect(fine.health.status).toBe("working");
    expect(fine.health.effect).toEqual({ label: "disk used", value: 61, unit: "%" });
  });

  it("workspace quotas: off with both quotas off, failing when nothing could be measured", async () => {
    expect((await view(workspaceHygieneFeature, ctx())).health.status).toBe("off");
    const failing = await view(
      workspaceHygieneFeature,
      ctx({
        env: { MYRMIDON_WORKSPACE_QUOTA_MB: "500" },
        ports: { runtime: { ...fakePorts().runtime, workspaceHygiene: () => ({ at: NOW.toISOString(), scanned: 5, measured: 0, failed: 5, overQuota: 0 }) } },
      }),
    );
    expect(failing.health.status).toBe("failing");
  });
});

describe("attention signal", () => {
  const broken = [{ key: "bot-disk-lifecycle", name: "Bot disk lifecycle", status: "misconfigured" as const, reason: "volume root missing" }];

  it("raises nothing before 30 minutes of being broken, and a card after", () => {
    observeFeatureHealth(broken, NOW);
    expect(readFeatureAttentionSignals(new Date(NOW.getTime() + FEATURE_ATTENTION_AFTER_MS - 1))).toEqual([]);
    const later = new Date(NOW.getTime() + FEATURE_ATTENTION_AFTER_MS + 60_000);
    observeFeatureHealth(broken, later);
    const [signal] = readFeatureAttentionSignals(later);
    expect(signal!.key).toBe("bot-disk-lifecycle");
    expect(signal!.dedupKey).toBe("feature_health:bot-disk-lifecycle");
    expect(signal!.activityAt).toBe(NOW.toISOString());
    expect(signal!.whyNow).toContain("volume root missing");
  });

  it("failing is high severity, misconfigured is medium", () => {
    observeFeatureHealth([{ ...broken[0]!, status: "failing" }], NOW);
    const [signal] = readFeatureAttentionSignals(new Date(NOW.getTime() + FEATURE_ATTENTION_AFTER_MS));
    expect(signal!.severity).toBe("high");
  });

  it("the clock restarts when the feature recovers, and off or unknown never raise", () => {
    observeFeatureHealth(broken, NOW);
    observeFeatureHealth([{ ...broken[0]!, status: "working" }], new Date(NOW.getTime() + 10 * 60_000));
    observeFeatureHealth(broken, new Date(NOW.getTime() + 20 * 60_000));
    expect(readFeatureAttentionSignals(new Date(NOW.getTime() + 40 * 60_000))).toEqual([]);
    observeFeatureHealth([{ ...broken[0]!, status: "unknown" }], new Date(NOW.getTime() + 50 * 60_000));
    expect(readFeatureAttentionSignals(new Date(NOW.getTime() + 120 * 60_000))).toEqual([]);
    expect(isFeatureBroken("off")).toBe(false);
    expect(isFeatureBroken("unknown")).toBe(false);
  });
});

describe("registry", () => {
  it("has unique keys, names, descriptions and a docs file that exists", () => {
    const keys = new Set<string>();
    for (const feature of FEATURE_REGISTRY) {
      expect(keys.has(feature.key)).toBe(false);
      keys.add(feature.key);
      expect(feature.name.length).toBeGreaterThan(0);
      expect(feature.description.length).toBeGreaterThan(20);
      expect(existsSync(join(REPO_ROOT, feature.docs.split("#")[0]!))).toBe(true);
    }
    expect(keys.size).toBeGreaterThanOrEqual(14);
  });

  it("covers the features the owner named", () => {
    const keys = FEATURE_REGISTRY.map((feature) => feature.key);
    for (const key of [
      "swarm-claim",
      "run-admission",
      "bot-disk-lifecycle",
      "shared-package-cache",
      "bot-lsp",
      "agent-memory",
      "cost-attribution",
      "telegram-dm-status",
      "chat-holds",
      "budget-enforcement",
      "plugin-entitlements",
    ]) {
      expect(keys).toContain(key);
    }
  });

  it("every feature evaluates on an empty instance without throwing, and never says working with no signal at all", async () => {
    const empty = ctx();
    for (const feature of FEATURE_REGISTRY) {
      const result = await view(feature, empty);
      expect(result.health.reason.length).toBeGreaterThan(0);
      expect(result.config.length).toBeGreaterThan(0);
      expect(result.health.reason).not.toContain("health check could not run");
      if (result.health.status === "working") {
        // a working feature must carry evidence: an effect or a last success
        expect(result.health.effect !== null || result.health.lastSuccessAt !== null).toBe(true);
      }
    }
  });

  it("a feature with an inline switch has a setEnabled, and the switch states are not invented", () => {
    for (const feature of FEATURE_REGISTRY) {
      if (feature.setEnabled) expect(["swarm-claim", "bot-disk-lifecycle"]).toContain(feature.key);
    }
  });
});

describe("service", () => {
  const stub: FeatureDefinition = {
    key: "stub",
    name: "Stub",
    description: "A stub feature for the service tests.",
    docs: "docs/myrmidon/SETTINGS.md",
    readConfig: () => ({ enabled: true, entries: [], toggle: { enabled: true, lockedBy: null } }),
    health: () => {
      throw new Error("probe exploded");
    },
    setEnabled: async () => undefined,
  };

  it("turns a throwing health check into an unknown row and keeps the other rows", async () => {
    const service = featuresService({
      db: {} as never,
      ports: fakePorts(),
      registry: [stub, chatHoldsFeature],
      readGeneral: async () => ({}),
      now: () => NOW,
      env: {},
    });
    const report = await service.report({ fresh: true });
    expect(report.features[0]!.health.status).toBe("unknown");
    expect(report.features[0]!.health.reason).toContain("probe exploded");
    expect(report.features[1]!.health.status).toBe("unknown");
    expect(summarizeStatuses(report.features).unknown).toBe(2);
  });

  it("refuses a switch for an unknown key, a feature without a switch, and an env-locked switch", async () => {
    const noSwitch: FeatureDefinition = { ...stub, key: "no-switch", setEnabled: undefined };
    const locked: FeatureDefinition = {
      ...stub,
      key: "locked",
      readConfig: () => ({ enabled: true, entries: [], toggle: { enabled: true, lockedBy: "env" } }),
    };
    const service = featuresService({
      db: {} as never,
      ports: fakePorts(),
      registry: [noSwitch, locked],
      readGeneral: async () => ({}),
      now: () => NOW,
      env: {},
    });
    const actor = { actorType: "user" as const, actorId: "user-a", agentId: null, runId: null, agentApiKeyId: null };
    await expect(service.setEnabled("nope", true, actor)).rejects.toMatchObject({ status: 404 });
    await expect(service.setEnabled("no-switch", true, actor)).rejects.toMatchObject({ status: 422 });
    await expect(service.setEnabled("locked", false, actor)).rejects.toBeInstanceOf(FeatureError);
    await expect(service.setEnabled("locked", false, actor)).rejects.toMatchObject({ status: 409 });
  });

  it("feeds the attention clock from a report", async () => {
    resetFeatureAttention();
    const brokenFeature: FeatureDefinition = {
      ...stub,
      key: "broken",
      name: "Broken",
      health: () => ({ status: "failing", reason: "last pass failed", lastSuccessAt: null, lastError: null, errors24h: 1, effect: null }),
    };
    let at = NOW;
    const service = featuresService({
      db: {} as never,
      ports: fakePorts(),
      registry: [brokenFeature],
      readGeneral: async () => ({}),
      now: () => at,
      env: {},
    });
    await service.report({ fresh: true });
    at = new Date(NOW.getTime() + FEATURE_ATTENTION_AFTER_MS + 1000);
    const report = await service.report({ fresh: true });
    expect(report.features[0]!.needsAttentionSince).toBe(NOW.toISOString());
    expect(readFeatureAttentionSignals(at)).toHaveLength(1);
  });
});
