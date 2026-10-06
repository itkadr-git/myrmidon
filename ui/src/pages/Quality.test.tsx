// @vitest-environment jsdom
// myrmidon(1.6-BASELINE part B): tests for the "Quality" page. The metrics
// API contract is frozen in the design note (server part A); until part A
// merges these tests mock the contract's response shape.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Quality, rowKeyLabel, topCausesLine } from "./Quality";
import type { BaselineComparisonResult, BaselineMetricRow, BaselineMetricsReport } from "@/api/baseline";

const metricsMock = vi.hoisted(() => vi.fn());
const compareMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const companyContextMock = vi.hoisted(() => ({ companyId: "company-1" as string | null }));

vi.mock("@/api/baseline", async () => {
  const actual = await vi.importActual<typeof import("@/api/baseline")>("@/api/baseline");
  return {
    ...actual,
    baselineApi: {
      metrics: (...args: unknown[]) => metricsMock(...args),
      compare: (...args: unknown[]) => compareMock(...args),
    },
  };
});

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: companyContextMock.companyId }),
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: setBreadcrumbsMock }),
}));

vi.mock("@/components/EmptyState", () => ({
  EmptyState: ({ message, title, description }: { message: string; title?: string; description?: string }) => (
    <div data-testid="quality-empty">
      {title ? <p>{title}</p> : null}
      <p>{message}</p>
      {description ? <p>{description}</p> : null}
    </div>
  ),
}));

vi.mock("@/components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="quality-skeleton">Loading…</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function row(overrides: Partial<BaselineMetricRow> = {}): BaselineMetricRow {
  return {
    key: "project-a",
    tasksCompleted: 6,
    cycleTimeHours: { mean: 20.5, median: 18.25, p90: 40.75 },
    timeInReviewHours: { mean: 4.5, median: 3.25 },
    returnRate: { enteredReview: 8, returned: 2, rate: 0.25 },
    blockedHours: {
      total: 12.5,
      mean: 2.08,
      topCauses: [
        { cause: "blocker-a", hours: 6.5 },
        { cause: "blocker-b", hours: 3.25 },
      ],
    },
    runsPerTask: { total: 24, mean: 4.0 },
    costPerTask: { totalCents: 1250, meanCents: 208 },
    ...overrides,
  };
}

function report(overrides: Partial<BaselineMetricsReport> = {}): BaselineMetricsReport {
  return {
    window: { from: "2026-09-18T00:00:00.000Z", to: "2026-10-02T12:00:00.000Z" },
    generatedAt: "2026-10-02T12:05:00.000Z",
    source: { statusLog: "activity_log", costs: "litellm_cost_events" },
    byProject: [row()],
    byRole: [row({ key: "engineer", tasksCompleted: 4 })],
    ...overrides,
  };
}

// myrmidon(1.6.5-BASELINE-COMPARE-UI): the default baseline snapshot for the
// comparison block — same shape as `report`, weaker numbers, so every delta
// is a visible improvement of the current window.
function baselineSnapshot(): BaselineMetricsReport {
  return report({
    window: { from: "2026-09-04T00:00:00.000Z", to: "2026-09-18T00:00:00.000Z" },
    generatedAt: "2026-09-18T00:05:00.000Z",
    byProject: [
      row({
        tasksCompleted: 4,
        cycleTimeHours: { mean: 41.0, median: 36.5, p90: 81.5 },
        timeInReviewHours: { mean: 9.0, median: 6.5 },
        returnRate: { enteredReview: 8, returned: 4, rate: 0.5 },
        costPerTask: { totalCents: 2500, meanCents: 416 },
      }),
    ],
    byRole: [
      row({
        key: "engineer",
        tasksCompleted: 2,
        cycleTimeHours: { mean: 41.0, median: 36.5, p90: 81.5 },
        timeInReviewHours: { mean: 9.0, median: 6.5 },
        returnRate: { enteredReview: 4, returned: 2, rate: 0.5 },
        costPerTask: { totalCents: 1250, meanCents: 416 },
      }),
    ],
  });
}

function comparison(overrides: Partial<BaselineComparisonResult> = {}): BaselineComparisonResult {
  return {
    current: report(),
    baseline: baselineSnapshot(),
    differences: {
      cycleTimeMean: { absolute: -20.5, percentage: -50 },
      cycleTimeMedian: null,
      cycleTimeP90: null,
      reviewTimeMean: { absolute: -4.5, percentage: -50 },
      reviewTimeMedian: null,
      reviewTimeP90: null,
      returnRate: { absolute: -0.25, percentage: -50 },
      blockedTotal: null,
      blockedMean: null,
      runsPerTask: null,
      costPerTask: { absolute: -208, percentage: -50 },
      tasksCompleted: { absolute: 2, percentage: 50 },
    },
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  // myrmidon(1.6.5-BASELINE-COMPARE-UI): default — no pinned snapshot; the
  // comparison block shows its "no baseline" state unless a test overrides.
  compareMock.mockResolvedValue(comparison({ baseline: null }));
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(node: React.ReactNode) {
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

async function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pageRoot = createRoot(container);
  root = pageRoot;
  await act(async () => {
    pageRoot.render(
      <QueryClientProvider client={queryClient}>
        <Quality />
      </QueryClientProvider>,
    );
    await Promise.resolve();
  });
  return queryClient;
}

describe("formatters", () => {
  it("labels a null key as no-project and keeps ids as-is", () => {
    expect(rowKeyLabel(null)).toBe("No project");
    expect(rowKeyLabel("project-a")).toBe("project-a");
  });

  it("renders up to three top blocked causes, most hours first, and a dash when none", () => {
    expect(topCausesLine(row())).toBe("blocker-a 6.50 h, blocker-b 3.25 h");
    expect(topCausesLine(row({ blockedHours: { total: 0, mean: 0, topCauses: [] } }))).toBe("—");
  });
});

describe("Quality page", () => {
  it("renders both tables with every contract metric, the cost source and generatedAt", async () => {
    metricsMock.mockResolvedValue(report());
    await renderPage();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
    });

    const meta = container.querySelector('[data-testid="quality-report-meta"]')?.textContent ?? "";
    expect(meta).toContain("Cost source: LLM gateway cost events");
    expect(meta).toContain("Generated");

    const projectTable = container.querySelector('[data-testid="quality-by-project-table"]');
    expect(projectTable?.textContent).toContain("project-a");
    expect(projectTable?.textContent).toContain("20.50 h");
    expect(projectTable?.textContent).toContain("18.25 h");
    expect(projectTable?.textContent).toContain("40.75 h");
    expect(projectTable?.textContent).toContain("4.50 h");
    expect(projectTable?.textContent).toContain("3.25 h");
    expect(projectTable?.textContent).toContain("25% (2/8)");
    expect(projectTable?.textContent).toContain("12.50 h");
    expect(projectTable?.textContent).toContain("2.08 h");
    expect(projectTable?.textContent).toContain("blocker-a 6.50 h");
    expect(projectTable?.textContent).toContain("24");
    expect(projectTable?.textContent).toContain("4.00");
    expect(projectTable?.textContent).toContain("$12.50");
    expect(projectTable?.textContent).toContain("$2.08");

    const roleTable = container.querySelector('[data-testid="quality-by-role-table"]');
    expect(roleTable?.textContent).toContain("engineer");

    // The first fetch uses the default 14-day window preset.
    expect(metricsMock).toHaveBeenCalledTimes(1);
    const [companyId, from, to] = metricsMock.mock.calls[0];
    expect(companyId).toBe("company-1");
    expect(from).toBeDefined();
    expect(to).toBeDefined();
  });

  it("labels a null project key as no project inside the table", async () => {
    metricsMock.mockResolvedValue(report({ byProject: [row({ key: null })] }));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-by-project-table"]')?.textContent).toContain("No project");
    });
  });

  it("shows the empty state when both groups are empty", async () => {
    metricsMock.mockResolvedValue(
      report({ byProject: [], byRole: [], source: { statusLog: "activity_log", costs: "none" } }),
    );
    await renderPage();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("No tasks completed in this window");
    });
    expect(container.textContent).toContain("Try a wider window");
    expect(container.textContent).toContain("Cost source: no cost source");
  });

  it("shows the not-enabled empty state on a 503-style error", async () => {
    metricsMock.mockRejectedValue(new Error("baseline metrics collection is not enabled"));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.textContent).toContain("Baseline metrics are not available");
    });
    expect(container.textContent).toContain("not enabled on this instance");
  });

  it("shows a plain error message for other failures", async () => {
    metricsMock.mockRejectedValue(new Error("Request failed: 500"));
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-error"]')?.textContent).toContain("Request failed: 500");
    });
  });

  it("refetches with a new window when the preset changes", async () => {
    metricsMock.mockResolvedValue(report());
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
    });

    const firstCall = metricsMock.mock.calls[0] as unknown[];
    await act(async () => {
      const buttons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent === "Last 30 Days",
      );
      (buttons[0] as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(metricsMock).toHaveBeenCalledTimes(2);
    });

    const secondCall = metricsMock.mock.calls[1] as unknown[];
    expect(secondCall[0]).toBe("company-1");
    // The 30-day window starts strictly earlier than the 14-day one.
    expect((secondCall[1] as string) < (firstCall[1] as string)).toBe(true);
  });

  it("prompts for dates in the custom preset and fetches once they are set", async () => {
    metricsMock.mockResolvedValue(report());
    await renderPage();
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
    });

    await act(async () => {
      const buttons = Array.from(container.querySelectorAll("button")).filter((button) =>
        button.textContent === "Custom",
      );
      (buttons[0] as HTMLButtonElement).click();
    });
    expect(container.textContent).toContain("Select a start and end date to load data.");
    expect(metricsMock).toHaveBeenCalledTimes(1);

    const dateInputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[type="date"]'));
    expect(dateInputs).toHaveLength(2);
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(dateInputs[0], "2026-09-01");
      dateInputs[0].dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
      setter?.call(dateInputs[1], "2026-09-30");
      dateInputs[1].dispatchEvent(new Event("input", { bubbles: true }));
    });

    await vi.waitFor(() => {
      expect(metricsMock).toHaveBeenCalledTimes(2);
    });
    const customCall = metricsMock.mock.calls[1] as unknown[];
    expect(customCall[1]).toContain("2026-09-01");
    expect(customCall[2]).toContain("2026-09-30");
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
    });
  });

  it("does not fetch and shows the company prompt without a company selection", () => {
    companyContextMock.companyId = null;
    try {
      metricsMock.mockResolvedValue(report());
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={queryClient}>
          <Quality />
        </QueryClientProvider>,
      );
      expect(container.textContent).toContain("Select an organization to view quality metrics.");
      expect(metricsMock).not.toHaveBeenCalled();
    } finally {
      companyContextMock.companyId = "company-1";
    }
  });
});

// myrmidon(1.6.5-BASELINE-COMPARE-UI): the comparison-with-pinned-snapshot
// block — deltas per project/role, a "no baseline" state that is not an
// error, and an isolated error state.
describe("Quality page — comparison with the pinned snapshot", () => {
  it("renders the comparison tables with per-row deltas against the snapshot", async () => {
    metricsMock.mockResolvedValue(report());
    compareMock.mockResolvedValue(comparison());
    await renderPage();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-compare-by-project-table"]')).not.toBeNull();
    });

    const projectTable = container.querySelector('[data-testid="quality-compare-by-project-table"]');
    // current vs baseline values side by side
    expect(projectTable?.textContent).toContain("project-a");
    expect(projectTable?.textContent).toContain("20.50 h"); // current cycle mean
    expect(projectTable?.textContent).toContain("41.00 h"); // baseline cycle mean
    expect(projectTable?.textContent).toContain("$2.08"); // current cost per task mean
    expect(projectTable?.textContent).toContain("$4.16"); // baseline cost per task mean
    // deltas: cycle time halved (-50.0%), return rate down 25 pp
    expect(projectTable?.textContent).toContain("50.0%");
    expect(projectTable?.textContent).toContain("25.0 pp");

    const roleTable = container.querySelector('[data-testid="quality-compare-by-role-table"]');
    expect(roleTable?.textContent).toContain("engineer");

    // same window as the metrics query
    expect(compareMock).toHaveBeenCalledTimes(1);
    const [companyId, from, to] = compareMock.mock.calls[0] as unknown[];
    expect(companyId).toBe("company-1");
    expect(from).toBeDefined();
    expect(to).toBeDefined();
  });

  it("shows the no-baseline state (not an error) when no snapshot is pinned", async () => {
    metricsMock.mockResolvedValue(report());
    compareMock.mockResolvedValue(comparison({ baseline: null }));
    await renderPage();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-compare-no-baseline"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("No pinned baseline snapshot yet");
    // the metrics tables still render normally
    expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="quality-compare-error"]')).toBeNull();
  });

  it("shows an isolated error state when the compare request fails", async () => {
    metricsMock.mockResolvedValue(report());
    compareMock.mockRejectedValue(new Error("Request failed: 500"));
    await renderPage();

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="quality-compare-error"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("Failed to load the comparison");
    // the metrics tables are unaffected
    expect(container.querySelector('[data-testid="quality-by-project-table"]')).not.toBeNull();
  });
});

