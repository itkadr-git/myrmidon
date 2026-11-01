import { describe, expect, it } from "vitest";
import {
  GATEWAY_ADMIN_KEY_SECRET_ENV,
  GATEWAY_KEY_ENV_NAME_ENV,
  agentKeySecretName,
  describeFallbackCycle,
  findCardFallbackCycle,
  findFallbackTopologyCycles,
  isAgentKeySecretName,
  parseFallbackTopology,
  assertFallbackTopologyAcyclic,
  readGatewayKeySettings,
  validateFallbackDiversity,
  validateFallbackOrder,
  sortFallbackTargets,
  findUnknownModelGroups,
} from "./myrmidon-litellm-sync.js";

describe("myrmidon(M2-B) per-agent gateway key names", () => {
  it("derives one name per agent, from the id first", () => {
    const name = agentKeySecretName({ agentId: "8e426442-1111-2222-3333-444455556666", agentSlug: "copywriter" });
    expect(name).toBe("llm-gateway-key-copywriter-8e426442-1111-2222-3333-444455556666");
    expect(isAgentKeySecretName(name)).toBe(true);
  });

  it("gives two agents two names even when their display names collide", () => {
    const first = agentKeySecretName({ agentId: "agent-a", agentSlug: "same name" });
    const second = agentKeySecretName({ agentId: "agent-b", agentSlug: "same name" });
    expect(first).not.toBe(second);
  });

  it("is total: a missing or unusable slug still yields a name", () => {
    expect(agentKeySecretName({ agentId: "agent-a" })).toBe("llm-gateway-key-agent-a");
    expect(agentKeySecretName({ agentId: "agent-a", agentSlug: "!!!" })).toBe("llm-gateway-key-agent-a");
  });

  it("leaves a foreign secret name unmanaged", () => {
    expect(isAgentKeySecretName("bot-llm-key")).toBe(false);
  });
});

describe("myrmidon(M2-B) gateway key settings", () => {
  it("requires both an address and an admin key secret to manage keys", () => {
    expect(readGatewayKeySettings({}).canManageKeys).toBe(false);
    expect(readGatewayKeySettings({ [GATEWAY_ADMIN_KEY_SECRET_ENV]: "k" }).canManageKeys).toBe(false);
    expect(
      readGatewayKeySettings({ MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000" }).canManageKeys,
    ).toBe(false);
    const both = readGatewayKeySettings({
      [GATEWAY_ADMIN_KEY_SECRET_ENV]: "gateway-admin",
      MYRMIDON_LITELLM_BASE_URL: "http://gateway.internal:4000",
    });
    expect(both.canManageKeys).toBe(true);
    expect(both.adminKeySecret).toBe("gateway-admin");
  });

  it("refuses a key env name the image owns, instead of projecting into it", () => {
    expect(
      readGatewayKeySettings({ [GATEWAY_KEY_ENV_NAME_ENV]: "PAPERCLIP_API_KEY" }).agentKeyEnv,
    ).toBeNull();
    expect(readGatewayKeySettings({ [GATEWAY_KEY_ENV_NAME_ENV]: "not a name" }).agentKeyEnv).toBeNull();
    expect(readGatewayKeySettings({ [GATEWAY_KEY_ENV_NAME_ENV]: "LLM_GATEWAY_API_KEY" }).agentKeyEnv).toBe(
      "LLM_GATEWAY_API_KEY",
    );
  });
});

describe("myrmidon(M2-B) card fallback chains", () => {
  it("accepts a chain that never repeats", () => {
    expect(
      findCardFallbackCycle({ primaryModel: "model-a", fallbacks: ["model-b", "model-c"] }),
    ).toBeNull();
  });

  it("rejects a chain that falls back to the primary model", () => {
    const cycle = findCardFallbackCycle({ primaryModel: "model-a", fallbacks: ["model-b", "model-a"] });
    expect(cycle?.path).toEqual(["model-a", "model-b", "model-a"]);
  });

  it("rejects a chain that names the same fallback twice", () => {
    const cycle = findCardFallbackCycle({ primaryModel: "model-a", fallbacks: ["model-b", "model-b"] });
    expect(cycle?.path).toEqual(["model-b", "model-b"]);
  });

  it("ignores the adapter's special values", () => {
    expect(
      findCardFallbackCycle({ primaryModel: "auto", fallbacks: ["default", "auto"] }),
    ).toBeNull();
  });
});

describe("myrmidon(M2-B) fallback topology", () => {
  it("accepts an acyclic topology", () => {
    const chains = [
      { model: "model-a", targets: ["model-b"] },
      { model: "model-b", targets: ["model-c"] },
    ];
    expect(findFallbackTopologyCycles(chains)).toEqual([]);
  });

  it("finds a loop that is not a self-loop", () => {
    const chains = [
      { model: "model-a", targets: ["model-b"] },
      { model: "model-b", targets: ["model-c"] },
      { model: "model-c", targets: ["model-a"] },
    ];
    const cycles = findFallbackTopologyCycles(chains);
    expect(cycles).toHaveLength(1);
    expect(describeFallbackCycle(cycles[0]!)).toBe("model-a -> model-b -> model-c -> model-a");
  });

  it("finds a two-model loop and reports it once", () => {
    const chains = [
      { model: "model-a", targets: ["model-b"] },
      { model: "model-b", targets: ["model-a"] },
    ];
    const cycles = findFallbackTopologyCycles(chains);
    expect(cycles).toHaveLength(1);
    expect(describeFallbackCycle(cycles[0]!)).toBe("model-a -> model-b -> model-a");
  });

  it("finds a self-loop", () => {
    const cycles = findFallbackTopologyCycles([{ model: "model-a", targets: ["model-a"] }]);
    expect(cycles).toHaveLength(1);
    expect(describeFallbackCycle(cycles[0]!)).toBe("model-a -> model-a");
  });

  it("treats a target that is not a group as a leaf, not a loop", () => {
    const cycles = findFallbackTopologyCycles([
      { model: "model-a", targets: ["model-b", "model-c"] },
      { model: "model-c", targets: ["model-d"] },
    ]);
    expect(cycles).toEqual([]);
  });

  it("reads the gateway's stored shape, one group per entry", () => {
    const chains = parseFallbackTopology([
      { "model-a": ["model-b"] },
      { "model-b": ["model-a"] },
    ]);
    expect(chains).toEqual([
      { model: "model-a", targets: ["model-b"] },
      { model: "model-b", targets: ["model-a"] },
    ]);
  });

  it("refuses a shape it cannot read, instead of checking nothing", () => {
    expect(parseFallbackTopology([{ "model-a": ["model-b"], "model-b": ["model-a"] }])).toBeNull();
    expect(parseFallbackTopology([{ "model-a": "model-b" }])).toBeNull();
    expect(parseFallbackTopology({ "model-a": ["model-b"] })).toBeNull();
  });

  it("assertFallbackTopologyAcyclic accepts acyclic chains and throws on cycles", () => {
    expect(() =>
      assertFallbackTopologyAcyclic([
        { "model-a": ["model-b"] },
        { "model-b": ["model-c"] },
      ]),
    ).not.toThrow();

    expect(() =>
      assertFallbackTopologyAcyclic([
        { "model-a": ["model-b"] },
        { "model-b": ["model-a"] },
      ]),
    ).toThrow(/loops/);
  });

  it("enforces provider diversity across the chain (rule: do not allow single provider)", () => {
    const catalog = new Map([
      ["gpt-4o", { modelName: "gpt-4o", provider: "openai" }],
      ["gpt-4o-mini", { modelName: "gpt-4o-mini", provider: "openai" }],
      ["claude-3-5-sonnet", { modelName: "claude-3-5-sonnet", provider: "anthropic" }],
    ]);

    const singleProvider = validateFallbackDiversity(
      { model: "gpt-4o", targets: ["gpt-4o-mini"] },
      catalog,
    );
    expect(singleProvider.valid).toBe(false);
    expect(singleProvider.error).toContain("relies on a single provider");

    const diverse = validateFallbackDiversity(
      { model: "gpt-4o", targets: ["claude-3-5-sonnet"] },
      catalog,
    );
    expect(diverse.valid).toBe(true);
  });

  it("validates ordering: free channels first, then paid channels on different providers", () => {
    const catalog = new Map([
      ["primary", { modelName: "primary", provider: "openai" }],
      ["paid-diff-provider", { modelName: "paid-diff-provider", provider: "anthropic", cost: 0.01 }],
      ["paid-same-provider", { modelName: "paid-same-provider", provider: "openai", cost: 0.005 }],
      ["paid-diff-provider-2", { modelName: "paid-diff-provider-2", provider: "anthropic", cost: 0.02 }],
      ["free-model", { modelName: "free-model", provider: "google", isFree: true }],
    ]);

    const validOrder = validateFallbackOrder(
      { model: "primary", targets: ["free-model", "paid-diff-provider"] },
      catalog,
    );
    expect(validOrder.valid).toBe(true);

    const invalidOrder = validateFallbackOrder(
      { model: "primary", targets: ["paid-diff-provider", "free-model"] },
      catalog,
    );
    expect(invalidOrder.valid).toBe(false);
    expect(invalidOrder.warning).toContain("Free channel 'free-model' appears after paid channels");

    // Paid fallback on the same provider as primary model is forbidden
    const sameProviderOrder = validateFallbackOrder(
      { model: "primary", targets: ["paid-same-provider"] },
      catalog,
    );
    expect(sameProviderOrder.valid).toBe(false);
    expect(sameProviderOrder.error).toContain("uses the same provider (openai) as primary model");

    // Subsequent paid fallback on the same provider as an earlier paid fallback is forbidden
    const repeatProviderOrder = validateFallbackOrder(
      { model: "primary", targets: ["free-model", "paid-diff-provider", "paid-diff-provider-2"] },
      catalog,
    );
    expect(repeatProviderOrder.valid).toBe(false);
    expect(repeatProviderOrder.error).toContain("uses the same provider (anthropic) as an earlier paid fallback");
  });

  it("sorts fallback targets by policy: free channels first, then cheap on another provider", () => {
    const catalog = new Map([
      ["primary", { modelName: "primary", provider: "openai" }],
      ["expensive-diff-provider", { modelName: "expensive-diff-provider", provider: "anthropic", cost: 0.05 }],
      ["cheap-diff-provider", { modelName: "cheap-diff-provider", provider: "anthropic", cost: 0.002 }],
      ["same-provider", { modelName: "same-provider", provider: "openai", cost: 0.001 }],
      ["free-diff-provider", { modelName: "free-diff-provider", provider: "google", isFree: true }],
    ]);

    const sorted = sortFallbackTargets(
      ["expensive-diff-provider", "same-provider", "cheap-diff-provider", "free-diff-provider"],
      "primary",
      catalog,
    );
    expect(sorted).toEqual([
      "free-diff-provider",
      "cheap-diff-provider",
      "expensive-diff-provider",
      "same-provider",
    ]);
  });

  it("identifies unknown model groups in the chain, including when catalog is empty", () => {
    const known = new Set(["model-a", "model-b"]);
    const unknown = findUnknownModelGroups(
      [{ model: "model-a", targets: ["model-b", "model-x"] }],
      known,
    );
    expect(unknown).toEqual(["model-x"]);

    // Empty known set treats all model groups as unknown
    const emptyKnown = findUnknownModelGroups(
      [{ model: "model-a", targets: ["model-b"] }],
      new Set(),
    );
    expect(emptyKnown).toEqual(["model-a", "model-b"]);
  });
});
