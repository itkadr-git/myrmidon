// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { countKeyedAgents } from "./litellmKeysApi";
import { cycleLines, formatKeyBudget, keyRows } from "./GatewayKeysTab";
import type { AgentGatewayKeyView, KeyBudgetLimitView } from "./litellmKeysApi";

const view = (over: Partial<AgentGatewayKeyView>): AgentGatewayKeyView => ({
  agentId: "agent-a",
  secretName: "llm-gateway-key-agent-a",
  present: false,
  valueHash: null,
  canManageKeys: true,
  ...over,
});

describe("myrmidon(M2-B / OPE-9859) gateway keys tab", () => {
  it("joins key state with agent names, roles, and projected budgets, and sorts by name", () => {
    const budgetA: KeyBudgetLimitView = {
      amountUsd: 100,
      periodHours: 720,
      mode: "block",
      effectiveMode: "soft",
      caste: "engineer",
    };

    const rows = keyRows(
      [
        view({
          agentId: "agent-b",
          secretName: "llm-gateway-key-beta-agent-b",
          role: "qa",
          budget: null,
        }),
        view({
          agentId: "agent-a",
          secretName: "llm-gateway-key-alpha-agent-a",
          present: true,
          role: "engineer",
          budget: budgetA,
        }),
      ],
      new Map([
        ["agent-a", "alpha"],
        ["agent-b", "beta"],
      ]),
    );
    expect(rows.map((row) => row.agentName)).toEqual(["alpha", "beta"]);
    expect(rows[0]!.present).toBe(true);
    expect(rows[0]!.role).toBe("engineer");
    expect(rows[0]!.budget).toEqual(budgetA);
    expect(rows[1]!.budget).toBeNull();
  });

  it("formats key budget limits cleanly with amount, period, and enforcement mode", () => {
    const mockT = (key: string, opts?: Record<string, unknown>) => {
      if (key.endsWith("noLimit")) return "no limit";
      if (key.endsWith("limit") && opts) {
        return `$${opts.amount}${opts.period} (${opts.mode})`;
      }
      return key;
    };

    // With monthly budget in soft mode
    expect(
      formatKeyBudget(
        {
          amountUsd: 250,
          periodHours: 720,
          mode: "block",
          effectiveMode: "soft",
          caste: "engineer",
        },
        mockT,
      ),
    ).toBe("$250/mo (soft)");

    // With custom hours in block mode
    expect(
      formatKeyBudget(
        {
          amountUsd: 50,
          periodHours: 24,
          mode: "block",
          effectiveMode: "block",
          caste: "worker",
        },
        mockT,
      ),
    ).toBe("$50/24h (block)");

    // Null or empty budget
    expect(formatKeyBudget(null, mockT)).toBe("no limit");
    expect(formatKeyBudget(undefined, mockT)).toBe("no limit");
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
});
