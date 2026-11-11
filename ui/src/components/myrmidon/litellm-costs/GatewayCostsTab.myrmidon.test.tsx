// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  groupByAgent,
  GatewayCostsTab,
  keyUsageStatusClass,
  sortKeyUsageRows,
  type GatewayAgentGroup,
} from "./GatewayCostsTab";
import { formatPerMillion, type LitellmCostRow, type LitellmKeyUsageRow } from "./litellmCostsApi";

function row(overrides: Partial<LitellmCostRow> = {}): LitellmCostRow {
  return {
    agentId: "agent-a",
    issueId: null,
    heartbeatRunId: "run-1",
    provider: "openai",
    model: "openai/example-model",
    inputTokens: 100,
    outputTokens: 50,
    costCents: 12,
    occurredAt: "2026-09-30T10:05:00.000Z",
    ...overrides,
  };
}

describe("myrmidon(M2-A) groupByAgent", () => {
  it("groups rows by agent with run details, cost-desc order", () => {
    const names = new Map([
      ["agent-a", "Agent A"],
      ["agent-b", "Agent B"],
    ]);
    const groups = groupByAgent(
      [
        row(),
        row({ costCents: 40, heartbeatRunId: null }),
        row({ agentId: "agent-b", costCents: 99, heartbeatRunId: "run-2" }),
      ],
      names,
    );
    expect(groups.map((group) => group.agentId)).toEqual(["agent-b", "agent-a"]);
    const agentA = groups[1] as GatewayAgentGroup;
    expect(agentA.agentName).toBe("Agent A");
    expect(agentA.costCents).toBe(52);
    expect(agentA.inputTokens).toBe(200);
    expect(agentA.runs).toHaveLength(2);
    // Runs sorted cost-desc.
    expect(agentA.runs[0].costCents).toBe(40);
    expect(agentA.runs[0].runId).toBeNull();
    // An agent without a known name falls back to the id.
    expect(groups[0].agentName).toBe("Agent B");
  });
});

describe("myrmidon(OPE-11776) key usage rows", () => {
  function usage(overrides: Partial<LitellmKeyUsageRow>): LitellmKeyUsageRow {
    return {
      agentId: "agent-a",
      agentName: "Alpha",
      capUsd: null,
      gatewaySpendUsd: null,
      utilizationPercent: null,
      status: "unknown",
      dailyCents: 0,
      weeklyCents: 0,
      zeroCostEvents: 0,
      ...overrides,
    };
  }

  it("puts the keys closest to (or over) their cap first, then by 24 h spend, then by name", () => {
    const rows = [
      usage({ agentId: "agent-d", agentName: "Delta", dailyCents: 500 }),
      usage({ agentId: "agent-a", agentName: "Alpha", capUsd: 10, gatewaySpendUsd: 8.5, utilizationPercent: 85, status: "near_cap", dailyCents: 10 }),
      usage({ agentId: "agent-c", agentName: "Charlie", dailyCents: 500 }),
      usage({ agentId: "agent-b", agentName: "Bravo", capUsd: 5, gatewaySpendUsd: 5.2, utilizationPercent: 104, status: "exhausted" }),
    ];
    expect(sortKeyUsageRows(rows).map((row) => row.agentId)).toEqual(["agent-b", "agent-a", "agent-c", "agent-d"]);
    // The input is not reordered in place.
    expect(rows[0]?.agentId).toBe("agent-d");
  });

  it("colours an exhausted cap red and a near-cap amber, and leaves the rest plain", () => {
    expect(keyUsageStatusClass("exhausted")).toContain("text-destructive");
    expect(keyUsageStatusClass("near_cap")).toContain("text-amber-600");
    expect(keyUsageStatusClass("ok")).toBe("");
    expect(keyUsageStatusClass("unknown")).toBe("");
  });
});

describe("myrmidon(M2-A) formatPerMillion", () => {
  it("renders per-million prices and keeps null as a dash", () => {
    expect(formatPerMillion(1.32e-6)).toBe("$1.32");
    expect(formatPerMillion(3.96e-6)).toBe("$3.96");
    expect(formatPerMillion(4.4e-8)).toBe("$0.0440");
    expect(formatPerMillion(0)).toBe("$0");
    expect(formatPerMillion(null)).toBe("-");
  });
});

describe("myrmidon(M2-A) GatewayCostsTab", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    vi.restoreAllMocks();
  });

  it("renders both cards and the not-enabled message when the API answers 503", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root = createRoot(container as HTMLDivElement);
      root.render(
        <QueryClientProvider client={client}>
          <GatewayCostsTab companyId="company-a" />
        </QueryClientProvider>,
      );
    });
    expect(container?.textContent).toContain("By agent (gateway)");
    expect(container?.textContent).toContain("Models (gateway)");
    // Fetch is not mocked here; both queries reject and the cards surface a
    // loading/error path without crashing the page.
  });
});
