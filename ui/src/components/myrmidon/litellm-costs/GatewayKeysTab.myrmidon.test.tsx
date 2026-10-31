// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { countKeyedAgents } from "./litellmKeysApi";
import { cycleLines, keyRows } from "./GatewayKeysTab";
import type { AgentGatewayKeyView } from "./litellmKeysApi";
import {
  findUnknownModelGroups,
  sortFallbackTargets,
  validateFallbackDiversity,
  validateFallbackOrder,
  type KnownModelInfo,
} from "@myrmidon/shared";

const view = (over: Partial<AgentGatewayKeyView>): AgentGatewayKeyView => ({
  agentId: "agent-a",
  secretName: "llm-gateway-key-agent-a",
  present: false,
  valueHash: null,
  canManageKeys: true,
  ...over,
});

describe("myrmidon(M2-B) gateway keys tab", () => {
  it("joins key state with agent names and sorts by name", () => {
    const rows = keyRows(
      [
        view({ agentId: "agent-b", secretName: "llm-gateway-key-beta-agent-b" }),
        view({ agentId: "agent-a", secretName: "llm-gateway-key-alpha-agent-a", present: true }),
      ],
      new Map([
        ["agent-a", "alpha"],
        ["agent-b", "beta"],
      ]),
    );
    expect(rows.map((row) => row.agentName)).toEqual(["alpha", "beta"]);
    expect(rows[0]!.present).toBe(true);
  });

  it("counts how many agents have a key of their own", () => {
    expect(countKeyedAgents([view({ present: true }), view({ agentId: "b" })])).toEqual({ keyed: 1, total: 2 });
  });

  it("shows no loop lines while the gateway could not be read", () => {
    expect(cycleLines({ chains: [], cycles: [], error: "the gateway answered 500" })).toEqual([]);
    expect(cycleLines(undefined)).toEqual([]);
  });

  it("names each loop it found", () => {
    expect(
      cycleLines({
        chains: [],
        cycles: [
          { path: ["model-a", "model-b"], described: "model-a -> model-b -> model-a" },
        ],
      }),
    ).toEqual(["model-a -> model-b -> model-a"]);
  });

  describe("fallback editor validations & rules (OPE-9855)", () => {
    const catalog = new Map<string, KnownModelInfo>([
      ["openai/gpt-4o", { modelName: "openai/gpt-4o", provider: "openai", cost: 0.005 }],
      ["openai/gpt-4o-mini", { modelName: "openai/gpt-4o-mini", provider: "openai", cost: 0.00015 }],
      ["anthropic/claude-3-5-sonnet", { modelName: "anthropic/claude-3-5-sonnet", provider: "anthropic", cost: 0.003 }],
      ["ollama/llama-3-8b", { modelName: "ollama/llama-3-8b", provider: "ollama", isFree: true, cost: 0 }],
      ["openrouter/free-qwen", { modelName: "openrouter/free-qwen", provider: "openrouter", isFree: true, cost: 0 }],
    ]);

    it("rejects chains with a single provider across primary and fallbacks", () => {
      const single = validateFallbackDiversity(
        { model: "openai/gpt-4o", targets: ["openai/gpt-4o-mini"] },
        catalog,
      );
      expect(single.valid).toBe(false);
      expect(single.error).toMatch(/relies on a single provider/i);

      const multi = validateFallbackDiversity(
        { model: "openai/gpt-4o", targets: ["anthropic/claude-3-5-sonnet"] },
        catalog,
      );
      expect(multi.valid).toBe(true);
    });

    it("validates channel ordering: free channels first, then cheaper channels", () => {
      const valid = validateFallbackOrder(
        { model: "openai/gpt-4o", targets: ["ollama/llama-3-8b", "anthropic/claude-3-5-sonnet"] },
        catalog,
      );
      expect(valid.valid).toBe(true);

      const invalid = validateFallbackOrder(
        { model: "openai/gpt-4o", targets: ["anthropic/claude-3-5-sonnet", "ollama/llama-3-8b"] },
        catalog,
      );
      expect(invalid.valid).toBe(false);
      expect(invalid.warning).toMatch(/Free channel/i);
    });

    it("sorts fallback targets by policy (free first, then cheap on different provider)", () => {
      const targets = [
        "openai/gpt-4o-mini",
        "anthropic/claude-3-5-sonnet",
        "openrouter/free-qwen",
      ];
      const sorted = sortFallbackTargets(targets, "openai/gpt-4o", catalog);
      expect(sorted[0]).toBe("openrouter/free-qwen"); // free first
      expect(sorted[1]).toBe("anthropic/claude-3-5-sonnet"); // different provider
      expect(sorted[2]).toBe("openai/gpt-4o-mini"); // same provider
    });

    it("identifies unknown model groups not present in known models", () => {
      const known = new Set(["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]);
      const unknown = findUnknownModelGroups(
        [
          { model: "openai/gpt-4o", targets: ["unknown-group-1"] },
          { model: "unknown-group-2", targets: ["anthropic/claude-3-5-sonnet"] },
        ],
        known,
      );
      expect(unknown).toEqual(["unknown-group-2", "unknown-group-1"]);
    });
  });
});
