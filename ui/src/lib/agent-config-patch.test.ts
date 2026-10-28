// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@myrmidon/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    debug: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("merges the agent-scoped provider trace debug setting into runtime config", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({ debug: { providerTrace: "raw" } }),
    );

    expect(patch).toMatchObject({
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 300 },
        debug: { providerTrace: "raw" },
      },
    });
  });

  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });
  });

  it("keeps the digest-pinned container image when a non-image field or a container limit changes (OPE-8916)", () => {
    const pinned = `ghcr.io/example/hermes@sha256:${"c".repeat(64)}`;
    const agent = makeAgent();
    agent.adapterType = "hermes_gateway";
    agent.adapterConfig = {
      note: "old",
      container: { enabled: true, image: pinned, memoryMb: 2048, cpus: 1, pidsLimit: 512 },
    };

    const other = buildAgentUpdatePatch(agent, makeOverlay({ adapterConfig: { note: "new" } }));
    const otherContainer = (other.adapterConfig as Record<string, unknown>).container as Record<string, unknown>;
    expect(otherContainer.image).toBe(pinned);
    expect(JSON.stringify(other)).not.toContain(":latest");

    const limit = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterConfig: { container: { enabled: true, image: pinned, memoryMb: 4096, cpus: 1, pidsLimit: 512 } },
      }),
    );
    const limitContainer = (limit.adapterConfig as Record<string, unknown>).container as Record<string, unknown>;
    expect(limitContainer.image).toBe(pinned);
    expect(limitContainer.memoryMb).toBe(4096);
    expect(JSON.stringify(limit)).not.toContain(":latest");
  });

  it("writes max-turn continuation policy under runtimeConfig.heartbeat", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      },
    });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });
  });

  it("preserves paperclip skill-sync selections when changing adapter types", () => {
    // Desired skills are adapter-agnostic (company-level selections) but are
    // persisted inside the per-adapter config under `paperclipSkillSync`. A
    // patch that switches adapters must carry them over instead of wiping the
    // agent's skills.
    const agent = makeAgent();
    agent.adapterConfig = {
      ...agent.adapterConfig,
      paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      }),
    );

    expect((patch.adapterConfig as Record<string, unknown>).paperclipSkillSync).toEqual({
      desiredSkills: ["research", "code-review"],
    });
  });
});
