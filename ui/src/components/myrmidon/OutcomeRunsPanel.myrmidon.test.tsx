// @vitest-environment jsdom
// myrmidon(1.7 WAKE-8): Outcome-bearing runs dashboard by agent and wake reason.
// Checks:
// - Rate calculation (numerator/denominator)
// - Model calls and token counts
// - Spend calculation: paid gateway spend + subscription API equivalent pricing
// - Idle spend ("стоимость прогонов без результата")
// - Time window presets (6h, 24h, 48h, 7d, all)
// - Wake reason breakdown table
// - Outcome category badges and metrics
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Agent, HeartbeatRun } from "@myrmidon/shared";
import {
  OutcomeBadge,
  OutcomeRunsPanel,
  aggregateOutcomeMetrics,
  filterRunsByTimeRange,
  formatUsd,
  formatWakeReason,
  getRunTelemetryMetrics,
} from "./OutcomeRunsPanel";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS: Agent[] = [
  { id: "agent-eng-10", name: "adm-dev-eng-10" } as Agent,
  { id: "agent-eng-19", name: "adm-dev-eng-19" } as Agent,
];

function makeRun(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-" + Math.random().toString(36).slice(2, 10),
    companyId: "company-1",
    agentId: "agent-eng-10",
    invocationSource: "timer",
    status: "succeeded",
    startedAt: new Date("2026-10-30T10:00:00.000Z"),
    finishedAt: new Date("2026-10-30T10:02:00.000Z"),
    createdAt: new Date("2026-10-30T10:00:00.000Z"),
    resultJson: null,
    runTelemetry: null,
    error: null,
    ...overrides,
  } as HeartbeatRun;
}

describe("OutcomeRunsPanel unit logic", () => {
  it("formats USD currency correctly for zero, micro amounts, and dollars", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(-5)).toBe("$0.00");
    expect(formatUsd(0.000377)).toBe("$0.0004");
    expect(formatUsd(0.0099)).toBe("$0.0099");
    expect(formatUsd(0.05)).toBe("$0.05");
    expect(formatUsd(1.234)).toBe("$1.23");
    expect(formatUsd(10.5)).toBe("$10.50");
  });

  it("formats wake reason strings into readable labels", () => {
    expect(formatWakeReason("timer")).toBe("Timer");
    expect(formatWakeReason("issue_continuation_needed")).toBe("Continuation");
    expect(formatWakeReason("issue_commented")).toBe("Issue comment");
    expect(formatWakeReason("issue_assigned")).toBe("Issue assigned");
    expect(formatWakeReason("custom_wake_reason")).toBe("Custom Wake Reason");
  });

  it("extracts telemetry metrics with outcome and spend correctly", () => {
    const runWithOutcome = makeRun({
      runTelemetry: {
        outcomeCategory: "commit_push",
        wakeReason: "issue_continuation_needed",
        modelCallCount: 3,
        inputTokens: 2000,
        cachedInputTokens: 500,
        outputTokens: 400,
        gatewaySpendCents: 50, // $0.50
        apiEquivalentCostUsd: 0.015, // $0.015
      },
    });

    const m = getRunTelemetryMetrics(runWithOutcome);
    expect(m.isOutcome).toBe(true);
    expect(m.isIdle).toBe(false);
    expect(m.outcomeCategory).toBe("commit_push");
    expect(m.wakeReason).toBe("issue_continuation_needed");
    expect(m.modelCalls).toBe(3);
    expect(m.inputTokens).toBe(2000);
    expect(m.cachedInputTokens).toBe(500);
    expect(m.outputTokens).toBe(400);
    expect(m.totalTokens).toBe(2900);
    expect(m.gatewaySpendUsd).toBe(0.5);
    expect(m.apiEquivalentCostUsd).toBe(0.015);
    expect(m.totalCostUsd).toBeCloseTo(0.515, 4);
  });

  it("extracts idle runs metrics and flags them as without outcome", () => {
    const runCommentOnly = makeRun({
      runTelemetry: {
        outcomeCategory: "comment_only",
        wakeReason: "timer",
        modelCallCount: 1,
        inputTokens: 1000,
        cachedInputTokens: 0,
        outputTokens: 200,
        gatewaySpendCents: 0,
        apiEquivalentCostUsd: 0.005,
      },
    });
    const m1 = getRunTelemetryMetrics(runCommentOnly);
    expect(m1.isOutcome).toBe(false);
    expect(m1.isIdle).toBe(true);
    expect(m1.totalCostUsd).toBe(0.005);

    const runNothing = makeRun({
      runTelemetry: {
        outcomeCategory: "nothing",
        wakeReason: "timer",
        modelCallCount: 0,
      },
    });
    const m2 = getRunTelemetryMetrics(runNothing);
    expect(m2.isOutcome).toBe(false);
    expect(m2.isIdle).toBe(true);
  });

  it("filters runs by time ranges (6h, 24h, 48h, 7d, all)", () => {
    const now = new Date("2026-10-30T12:00:00.000Z").getTime();
    const r1 = makeRun({ startedAt: new Date(now - 2 * 3600 * 1000) }); // 2h ago
    const r2 = makeRun({ startedAt: new Date(now - 10 * 3600 * 1000) }); // 10h ago
    const r3 = makeRun({ startedAt: new Date(now - 30 * 3600 * 1000) }); // 30h ago
    const r4 = makeRun({ startedAt: new Date(now - 100 * 3600 * 1000) }); // 100h ago (~4 days)
    const r5 = makeRun({ startedAt: new Date(now - 200 * 3600 * 1000) }); // 200h ago (~8 days)

    const allRuns = [r1, r2, r3, r4, r5];

    expect(filterRunsByTimeRange(allRuns, "6h", now)).toEqual([r1]);
    expect(filterRunsByTimeRange(allRuns, "24h", now)).toEqual([r1, r2]);
    expect(filterRunsByTimeRange(allRuns, "48h", now)).toEqual([r1, r2, r3]);
    expect(filterRunsByTimeRange(allRuns, "7d", now)).toEqual([r1, r2, r3, r4]);
    expect(filterRunsByTimeRange(allRuns, "all", now)).toEqual([r1, r2, r3, r4, r5]);
  });

  it("aggregates outcome rate, tokens, calls, total cost, and idle cost correctly", () => {
    const r1 = makeRun({
      runTelemetry: {
        outcomeCategory: "artifact",
        wakeReason: "issue_commented",
        modelCallCount: 2,
        inputTokens: 1000,
        cachedInputTokens: 200,
        outputTokens: 300,
        gatewaySpendCents: 10,
        apiEquivalentCostUsd: 0.002,
      },
    });
    const r2 = makeRun({
      runTelemetry: {
        outcomeCategory: "status",
        wakeReason: "issue_continuation_needed",
        modelCallCount: 1,
        inputTokens: 500,
        cachedInputTokens: 0,
        outputTokens: 100,
        gatewaySpendCents: 0,
        apiEquivalentCostUsd: 0.001,
      },
    });
    const r3 = makeRun({
      runTelemetry: {
        outcomeCategory: "comment_only",
        wakeReason: "timer",
        modelCallCount: 1,
        inputTokens: 800,
        cachedInputTokens: 0,
        outputTokens: 150,
        gatewaySpendCents: 0,
        apiEquivalentCostUsd: 0.003,
      },
    });
    const r4 = makeRun({
      runTelemetry: {
        outcomeCategory: "nothing",
        wakeReason: "timer",
        modelCallCount: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        gatewaySpendCents: 0,
        apiEquivalentCostUsd: 0,
      },
    });

    const metrics = aggregateOutcomeMetrics([r1, r2, r3, r4]);

    expect(metrics.totalRuns).toBe(4);
    expect(metrics.evaluatedRuns).toBe(4);
    expect(metrics.outcomeRuns).toBe(2); // r1 + r2
    expect(metrics.idleRuns).toBe(2); // r3 + r4
    expect(metrics.outcomeRatePct).toBe(50.0); // 2 / 4 = 50%

    expect(metrics.totalModelCalls).toBe(4);
    expect(metrics.outcomeModelCalls).toBe(3);
    expect(metrics.idleModelCalls).toBe(1);

    expect(metrics.totalTokens).toBe(1500 + 600 + 950); // 3050

    // r1: $0.10 + $0.002 = $0.102
    // r2: $0.001
    // r3: $0.003
    // r4: $0.00
    // totalCostUsd: $0.106
    // idleCostUsd: r3 + r4 = $0.003
    expect(metrics.totalCostUsd).toBeCloseTo(0.106, 4);
    expect(metrics.idleCostUsd).toBeCloseTo(0.003, 4);
    expect(metrics.outcomeCostUsd).toBeCloseTo(0.103, 4);

    expect(metrics.categoryCounts.artifact).toBe(1);
    expect(metrics.categoryCounts.status).toBe(1);
    expect(metrics.categoryCounts.comment_only).toBe(1);
    expect(metrics.categoryCounts.nothing).toBe(1);

    // Reasons breakdown
    const timerRow = metrics.reasonsBreakdown.find((r) => r.reason === "timer");
    expect(timerRow).toBeDefined();
    expect(timerRow?.totalRuns).toBe(2);
    expect(timerRow?.outcomeRuns).toBe(0);
    expect(timerRow?.outcomeRatePct).toBe(0);
    expect(timerRow?.idleCostUsd).toBeCloseTo(0.003, 4);

    const commentedRow = metrics.reasonsBreakdown.find((r) => r.reason === "issue_commented");
    expect(commentedRow).toBeDefined();
    expect(commentedRow?.outcomeRuns).toBe(1);
    expect(commentedRow?.outcomeRatePct).toBe(100.0);
  });
});

describe("OutcomeRunsPanel component DOM rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders panel header, KPI cards, category breakdown, and reasons table", () => {
    const runs = [
      makeRun({
        agentId: "agent-eng-10",
        runTelemetry: {
          outcomeCategory: "commit_push",
          wakeReason: "issue_continuation_needed",
          modelCallCount: 2,
          inputTokens: 1500,
          cachedInputTokens: 300,
          outputTokens: 200,
          gatewaySpendCents: 20,
          apiEquivalentCostUsd: 0.002,
        },
      }),
      makeRun({
        agentId: "agent-eng-10",
        runTelemetry: {
          outcomeCategory: "comment_only",
          wakeReason: "timer",
          modelCallCount: 1,
          inputTokens: 800,
          cachedInputTokens: 0,
          outputTokens: 100,
          gatewaySpendCents: 0,
          apiEquivalentCostUsd: 0.002,
        },
      }),
    ];

    act(() => {
      root.render(
        <OutcomeRunsPanel
          runs={runs}
          agents={AGENTS}
          selectedAgentId="__all"
          selectedWakeReason="__all"
          selectedTimeRange="all"
        />,
      );
    });

    const panel = container.querySelector('[data-testid="outcome-runs-panel"]');
    expect(panel).toBeTruthy();

    const outcomeVal = container.querySelector('[data-testid="outcome-rate-value"]');
    expect(outcomeVal?.textContent).toBe("50.0%");

    const outcomeSub = container.querySelector('[data-testid="outcome-rate-sub"]');
    expect(outcomeSub?.textContent).toContain("1 / 2");

    const callsVal = container.querySelector('[data-testid="model-calls-value"]');
    expect(callsVal?.textContent).toBe("3");

    const totalCostVal = container.querySelector('[data-testid="total-cost-value"]');
    expect(totalCostVal?.textContent).toBe("$0.20"); // $0.204 formatted to $0.20

    const idleCostVal = container.querySelector('[data-testid="idle-cost-value"]');
    expect(idleCostVal?.textContent).toContain("$0.0020");

    const reasonsTable = container.querySelector('[data-testid="reasons-breakdown-table"]');
    expect(reasonsTable).toBeTruthy();
    expect(reasonsTable?.textContent).toContain("Continuation");
    expect(reasonsTable?.textContent).toContain("Timer");
  });

  it("handles time range selection clicks", () => {
    const onSelectTimeRange = vi.fn();
    act(() => {
      root.render(
        <OutcomeRunsPanel
          runs={[]}
          agents={AGENTS}
          selectedTimeRange="48h"
          onSelectTimeRange={onSelectTimeRange}
        />,
      );
    });

    const btn6h = container.querySelector('[data-testid="time-filter-6h"]');
    expect(btn6h).toBeTruthy();
    act(() => {
      btn6h?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectTimeRange).toHaveBeenCalledWith("6h");
  });

  it("handles clicking on a wake reason row to filter by that reason", () => {
    const onSelectWakeReason = vi.fn();
    const runs = [
      makeRun({
        runTelemetry: {
          outcomeCategory: "artifact",
          wakeReason: "timer",
        },
      }),
    ];

    act(() => {
      root.render(
        <OutcomeRunsPanel
          runs={runs}
          agents={AGENTS}
          onSelectWakeReason={onSelectWakeReason}
        />,
      );
    });

    const timerRow = container.querySelector('[data-testid="reason-row-timer"]');
    expect(timerRow).toBeTruthy();
    act(() => {
      timerRow?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onSelectWakeReason).toHaveBeenCalledWith("timer");
  });

  it("renders OutcomeBadge for all supported categories", () => {
    const categories = [
      "artifact",
      "commit_push",
      "status",
      "other_work_product",
      "comment_only",
      "nothing",
    ];

    for (const cat of categories) {
      act(() => {
        root.render(<OutcomeBadge category={cat} />);
      });
      expect(container.textContent).toBeTruthy();
    }

    act(() => {
      root.render(<OutcomeBadge category={null} />);
    });
    expect(container.textContent).toBe("");
  });
});
