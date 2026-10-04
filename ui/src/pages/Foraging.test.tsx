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
// myrmidon(1.6.2-FORAGING-IDLE-GATE): the switch, the pass history and the write.
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
      passes: (...args: unknown[]) => passesMock(...args),
      setIdleGate: (...args: unknown[]) => setIdleGateMock(...args),
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

// myrmidon(1.6.2-FORAGING-IDLE-GATE): the default of the rule is off, and the
// company has no stored row — so the source of the value is the default.
function idleGate(overrides: Partial<ForagingIdleGateView> = {}): ForagingIdleGateView {
  return {
    idleOnly: false,
    source: "default",
    storedIdleOnly: null,
    envOverride: null,
    updatedAt: null,
    ...overrides,
  };
}

function pass(overrides: Partial<ForagingPass> = {}): ForagingPass {
  return {
    at: "2026-10-04T09:10:00.000Z",
    skipReason: null,
    skippedRoles: [],
    sourcesRead: 1,
    findings: 0,
    candidates: 0,
    spentCents: 1,
    stoppedByBudget: false,
    errors: 0,
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
  passesMock.mockResolvedValue({ passes: [], enabled: true });
  setIdleGateMock.mockResolvedValue(idleGate({ idleOnly: true, source: "interface" }));
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

  // myrmidon(1.6.2-FORAGING-IDLE-GATE): the rule, the source of its value, the
  // switch itself and the reason of a skipped pass.
  it("shows the rule and where its value comes from", async () => {
    idleGateMock.mockResolvedValue(
      idleGate({ idleOnly: true, source: "env", storedIdleOnly: false, envOverride: true }),
    );
    await renderAndSee("foraging-idle-gate-source");
    // The card renders before the query settles, so wait for the resolved value.
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="foraging-idle-gate-source"]')?.textContent)
        .toContain("the environment");
    });
    const gate = container.querySelector('[data-testid="foraging-idle-gate"]');
    expect(gate?.textContent).toContain("Only when idle");
  });

  it("shows the default and the off label when nobody answered", async () => {
    await renderAndSee("foraging-idle-gate-source");
    // The switch is disabled until the stored value arrives: an enabled switch
    // proves the panel is showing the API answer, not the pre-load placeholder.
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="foraging-idle-gate-toggle"]')?.hasAttribute("disabled"),
      ).toBe(false);
    });
    const gate = container.querySelector('[data-testid="foraging-idle-gate"]');
    expect(gate?.textContent).toContain("On schedule, regardless of load");
    expect(gate?.textContent).toContain("the default");
  });

  it("flips the switch and stores the new value", async () => {
    await renderAndSee("foraging-idle-gate-source");
    await vi.waitFor(() => {
      expect(
        container.querySelector('[data-testid="foraging-idle-gate-toggle"]')?.hasAttribute("disabled"),
      ).toBe(false);
    });
    const toggle = container.querySelector('[data-testid="foraging-idle-gate-toggle"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      (toggle as HTMLButtonElement).click();
    });
    await vi.waitFor(() => {
      expect(setIdleGateMock).toHaveBeenCalledWith("company-1", true);
    });
  });

  it("shows why a pass was skipped in the history", async () => {
    passesMock.mockResolvedValue({
      passes: [
        pass({ skipReason: "agents_busy_for_role", skippedRoles: ["engineer"], sourcesRead: 0 }),
      ],
      enabled: true,
    });
    await renderAndSee("foraging-passes-table");
    const skipped = container.querySelector('[data-testid="foraging-pass-skipped"]');
    expect(skipped).not.toBeNull();
    expect(skipped?.textContent).toContain("work in flight");
    expect(container.querySelector('[data-testid="foraging-pass-row"]')?.textContent).toContain("engineer");
  });

  it("shows the empty history note before the first pass", async () => {
    await renderAndSee("foraging-passes-empty");
  });

  it("shows a pass that ran without a reason", async () => {
    passesMock.mockResolvedValue({ passes: [pass({ sourcesRead: 3, findings: 2 })], enabled: true });
    await renderAndSee("foraging-passes-table");
    expect(container.querySelector('[data-testid="foraging-pass-ran"]')?.textContent).toContain("Ran");
    expect(container.querySelector('[data-testid="foraging-pass-row"]')?.textContent).toContain("3");
  });
});