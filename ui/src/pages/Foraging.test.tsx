// @vitest-environment jsdom
// myrmidon(1.6-FORAGE): tests for the "Foraging" page. The API contract is the
// server module's (foraging/routes.ts); these tests mock the client.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Foraging } from "./Foraging";
import type {
  ForagingBudgetView,
  ForagingFinding,
  ForagingIdleGateView,
  ForagingPass,
  ForagingSource,
} from "@/api/foraging";

const sourcesMock = vi.hoisted(() => vi.fn());
const findingsMock = vi.hoisted(() => vi.fn());
const budgetMock = vi.hoisted(() => vi.fn());
// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the idle gate and the history.
const idleGateMock = vi.hoisted(() => vi.fn());
const passesMock = vi.hoisted(() => vi.fn());
const setIdleGateMock = vi.hoisted(() => vi.fn());
const setBreadcrumbsMock = vi.hoisted(() => vi.fn());
const companyContextMock = vi.hoisted(() => ({ companyId: "company-1" as string | null }));

vi.mock("@/api/foraging", async () => {
  const actual = await vi.importActual<typeof import("@/api/foraging")>("@/api/foraging");
  return {
    ...actual,
    foragingApi: {
      sources: (...args: unknown[]) => sourcesMock(...args),
      findings: (...args: unknown[]) => findingsMock(...args),
      budget: (...args: unknown[]) => budgetMock(...args),
      idleGate: (...args: unknown[]) => idleGateMock(...args),
      setIdleGate: (...args: unknown[]) => setIdleGateMock(...args),
      passes: (...args: unknown[]) => passesMock(...args),
      saveSource: vi.fn(),
      removeSource: vi.fn(),
      sweep: vi.fn(),
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
  EmptyState: ({ message }: { message: string }) => <div data-testid="foraging-empty">{message}</div>,
}));

vi.mock("@/components/PageSkeleton", () => ({
  PageSkeleton: () => <div data-testid="foraging-skeleton">Loading…</div>,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function source(overrides: Partial<ForagingSource> = {}): ForagingSource {
  return {
    id: "source-1",
    role: "engineer",
    url: "https://example.com/changelog",
    kind: "url",
    enabled: true,
    lastSnapshotAt: "2026-10-02T10:00:00.000Z",
    lastCheckedAt: "2026-10-02T10:00:00.000Z",
    lastError: null,
    snapshotLines: 12,
    ...overrides,
  };
}

function finding(overrides: Partial<ForagingFinding> = {}): ForagingFinding {
  return {
    id: "finding-1",
    sourceId: "source-1",
    role: "engineer",
    status: "unverified",
    summary: "foraged-engineer: 1 added",
    diff: { added: ["line-b"], removed: [] },
    skillKey: "foraged-engineer",
    candidateRef: null,
    reason: null,
    detectedAt: "2026-10-02T10:00:00.000Z",
    ...overrides,
  };
}

const budget: ForagingBudgetView = {
  enabled: true,
  budget: { maxCostCents: 50, enabled: true },
  spentCents: 4,
  minHostIntervalMs: 60_000,
  intervalMs: 3_600_000,
};

// myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the toggle and the pass history.
function idleGate(overrides: Partial<ForagingIdleGateView> = {}): ForagingIdleGateView {
  return { enabled: true, source: "settings", ...overrides };
}

function pass(overrides: Partial<ForagingPass> = {}): ForagingPass {
  return {
    at: "2026-10-04T12:00:00.000Z",
    companyId: "company-1",
    sourcesRead: 2,
    findings: 1,
    candidates: 0,
    errors: 0,
    stoppedByBudget: false,
    skippedReason: "no_idle_agent",
    skipped: [{ role: "engineer", reason: "no_idle_agent" }],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let queryClient: QueryClient;

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <Foraging />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
}

/** Renders and waits until `testId` is in the tree; queries settle on their own. */
async function renderAndSee(testId: string) {
  await render();
  await vi.waitFor(() => {
    expect(container.querySelector(`[data-testid="${testId}"]`)).not.toBeNull();
  });
}

function text() {
  return container.textContent ?? "";
}

beforeEach(() => {
  sourcesMock.mockResolvedValue({ sources: [source()], enabled: true });
  findingsMock.mockResolvedValue({ findings: [finding()], enabled: true });
  budgetMock.mockResolvedValue(budget);
  idleGateMock.mockResolvedValue(idleGate());
  passesMock.mockResolvedValue({ passes: [pass()] });
  setIdleGateMock.mockResolvedValue(idleGate({ enabled: false, source: "settings" }));
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  queryClient?.clear();
  vi.clearAllMocks();
});

describe("myrmidon(1.6-FORAGE) Foraging page", () => {
  it("lists the registry with the source role and url", async () => {
    await renderAndSee("foraging-sources-table");
    const rows = container.querySelectorAll('[data-testid="foraging-source-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("engineer");
    expect(rows[0].textContent).toContain("https://example.com/changelog");
  });

  it("shows the findings with their lifecycle state and diff size", async () => {
    await renderAndSee("foraging-findings-table");
    const rows = container.querySelectorAll('[data-testid="foraging-finding-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Unverified");
    expect(rows[0].textContent).toContain("foraged-engineer");
    expect(rows[0].textContent).toContain("+1");
  });

  it("shows a candidate reference once the lifecycle accepted a finding", async () => {
    findingsMock.mockResolvedValue({
      findings: [finding({ status: "candidate", candidateRef: "candidate-7" })],
      enabled: true,
    });
    await renderAndSee("foraging-findings-table");
    expect(container.querySelector('[data-testid="foraging-finding-row"]')?.textContent).toContain("candidate-7");
  });

  it("renders the pass budget", async () => {
    await renderAndSee("foraging-budget");
    const budgetRow = container.querySelector('[data-testid="foraging-budget"]');
    expect(budgetRow?.textContent).toContain("Pass budget");
    expect(budgetRow?.textContent).toContain("Spent this month");
  });

  it("explains that passes are off while the sweep is disabled", async () => {
    sourcesMock.mockResolvedValue({ sources: [], enabled: false });
    findingsMock.mockResolvedValue({ findings: [], enabled: false });
    await renderAndSee("foraging-disabled-note");
  });

  it("shows the empty state for the registry and the findings", async () => {
    sourcesMock.mockResolvedValue({ sources: [], enabled: true });
    findingsMock.mockResolvedValue({ findings: [], enabled: true });
    await renderAndSee("foraging-sources-empty");
    expect(container.querySelector('[data-testid="foraging-findings-empty"]')).not.toBeNull();
  });

  it("asks for an organization when none is selected", async () => {
    companyContextMock.companyId = null;
    await renderAndSee("foraging-empty");
    companyContextMock.companyId = "company-1";
  });

  it("shows a source error on its row", async () => {
    sourcesMock.mockResolvedValue({
      sources: [source({ lastError: "source answered 500" })],
      enabled: true,
    });
    await renderAndSee("foraging-source-row-error");
    expect(container.querySelector('[data-testid="foraging-source-row-error"]')?.textContent).toContain("500");
  });

  it("labels the page in the breadcrumbs", async () => {
    await renderAndSee("foraging-sources-table");
    expect(setBreadcrumbsMock).toHaveBeenCalledWith([{ label: "Foraging" }]);
  });

  // myrmidon(1.6.3-FORAGING-IDLE-GATE, UI half): the toggle with the source of
  // the value, and the pass history with the reason of a skip.
  it("shows the idle gate with its value and where the value came from", async () => {
    idleGateMock.mockResolvedValue(idleGate({ enabled: false, source: "env" }));
    // The source line only exists once the value arrived.
    await renderAndSee("foraging-idle-gate-source");
    expect(container.querySelector('[data-testid="foraging-idle-gate-toggle"]')?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[data-testid="foraging-idle-gate-value"]')?.textContent).toContain("off");
    expect(container.querySelector('[data-testid="foraging-idle-gate-source"]')?.textContent).toContain("the environment");
  });

  it("names the built-in default when nothing was ever saved", async () => {
    idleGateMock.mockResolvedValue(idleGate({ enabled: true, source: "default" }));
    await renderAndSee("foraging-idle-gate-source");
    expect(container.querySelector('[data-testid="foraging-idle-gate-source"]')?.textContent).toContain("the default");
  });

  it("switches the setting", async () => {
    // Wait for the value: the toggle is disabled until it knows the current value.
    await renderAndSee("foraging-idle-gate-source");
    const toggle = container.querySelector('[data-testid="foraging-idle-gate-toggle"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    await vi.waitFor(() => {
      expect(setIdleGateMock).toHaveBeenCalledWith(false);
    });
  });

  it("keeps a failed switch visible instead of swallowing it", async () => {
    setIdleGateMock.mockRejectedValue(new Error("Board access required"));
    await renderAndSee("foraging-idle-gate-source");
    const toggle = container.querySelector('[data-testid="foraging-idle-gate-toggle"]') as HTMLButtonElement;
    await act(async () => {
      toggle.click();
    });
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="foraging-idle-gate-error"]')?.textContent).toContain(
        "Board access required",
      );
    });
  });

  it("shows the pass history with the skipped role and the reason", async () => {
    await renderAndSee("foraging-passes-table");
    const row = container.querySelector('[data-testid="foraging-pass-row"]');
    expect(row?.textContent).toContain("engineer");
    expect(row?.textContent).toContain("no free agent of the role");
    expect(container.querySelectorAll('[data-testid="foraging-pass-skip"]')).toHaveLength(1);
  });

  it("shows both skip reasons when a pass left two roles alone", async () => {
    passesMock.mockResolvedValue({
      passes: [
        pass({
          skippedReason: "queue_not_empty",
          skipped: [
            { role: "engineer", reason: "queue_not_empty" },
            { role: "researcher", reason: "no_idle_agent" },
          ],
        }),
      ],
    });
    await renderAndSee("foraging-passes-table");
    expect(container.querySelectorAll('[data-testid="foraging-pass-skip"]')).toHaveLength(2);
    expect(text()).toContain("the role's queue is not empty");
    expect(text()).toContain("no free agent of the role");
  });

  it("says so when a pass skipped nothing", async () => {
    passesMock.mockResolvedValue({ passes: [pass({ skippedReason: null, skipped: [] })] });
    await renderAndSee("foraging-passes-table");
    expect(container.querySelector('[data-testid="foraging-pass-row"]')?.textContent).toContain("nothing skipped");
  });

  it("explains an empty pass history", async () => {
    passesMock.mockResolvedValue({ passes: [] });
    await renderAndSee("foraging-passes-empty");
  });
});