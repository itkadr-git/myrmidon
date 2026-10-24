// @vitest-environment jsdom
//
// myrmidon(1.7 BUDGET-CONFIG D): container-tier tests of the "Budgets" screen —
// the wire tier against a mocked API client. Part A of BUDGET-CONFIG (the
// routes) is not merged yet, so the mocks stand in for the frozen contract.
//
// Checked: the four reads fire for the selected company; editing + Save PUTs
// the row and refetches; the "signal only" switch PATCHes and takes the new
// source from the response; a failing read shows the error state; no company —
// the notice, no requests.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { BudgetLimitsScreen } from "./BudgetLimitsScreenContainer";
import type { BudgetLimitUsageRow, BudgetLimitView, BudgetLimitsSignalOnlyView } from "./budgetLimitsApi";

const budgetLimitsApiMock = vi.hoisted(() => ({
  list: vi.fn(),
  usage: vi.fn(),
  journal: vi.fn(),
  getSignalOnly: vi.fn(),
  patchSignalOnly: vi.fn(),
  saveLimit: vi.fn(),
  removeLimit: vi.fn(),
}));

vi.mock("./budgetLimitsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./budgetLimitsApi")>()),
  budgetLimitsApi: budgetLimitsApiMock,
}));

const projectsApiMock = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/projects", () => ({ projectsApi: projectsApiMock }));

let selectedCompanyId = "company-1";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const PROJECT_ID = "11111111-2222-3333-4444-555555555555";
const COMPANY: BudgetLimitView = {
  id: "id-nest-company",
  companyId: "company-1",
  level: "nest",
  ref: "company",
  amountCents: 50000,
  period: "calendar_month_utc",
  mode: "hard",
  isActive: true,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const USAGE: BudgetLimitUsageRow[] = [{ ...COMPANY, spentCents: 60000, events: 3, overLimit: true }];
const SIGNAL_ONLY: BudgetLimitsSignalOnlyView = { signalOnly: true, source: "stored" };

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  selectedCompanyId = "company-1";
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  budgetLimitsApiMock.list.mockReset().mockResolvedValue([COMPANY]);
  budgetLimitsApiMock.usage.mockReset().mockResolvedValue(USAGE);
  budgetLimitsApiMock.journal.mockReset().mockResolvedValue([]);
  budgetLimitsApiMock.getSignalOnly.mockReset().mockResolvedValue(SIGNAL_ONLY);
  budgetLimitsApiMock.patchSignalOnly.mockReset().mockResolvedValue({ signalOnly: false, source: "stored" });
  budgetLimitsApiMock.saveLimit.mockReset().mockResolvedValue(COMPANY);
  budgetLimitsApiMock.removeLimit.mockReset().mockResolvedValue({ removed: true });
  projectsApiMock.list.mockReset().mockResolvedValue([{ id: PROJECT_ID, name: "Board" }]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderScreen(): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <BudgetLimitsScreen />
      </QueryClientProvider>,
    );
  });
  await settle();
}

function byTestId<T extends HTMLElement>(testId: string): T {
  return container.querySelector<T>(`[data-testid="${testId}"]`)!;
}

describe("myrmidon(1.7 BUDGET-CONFIG D) container", () => {
  it("reads the limits, the usage, the journal and the mode for the selected company", async () => {
    await renderScreen();
    expect(budgetLimitsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.usage).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.journal).toHaveBeenCalledWith("company-1");
    expect(budgetLimitsApiMock.getSignalOnly).toHaveBeenCalledWith("company-1");
    expect(projectsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(byTestId("budget-limits-spent-nest:company").textContent).toContain("$600.00");
    expect(byTestId<HTMLInputElement>("budget-limits-amount-nest:company").value).toBe("500.00");
  });

  it("PUTs the edited limit and refetches the limits, the usage and the journal", async () => {
    await renderScreen();
    const input = byTestId<HTMLInputElement>("budget-limits-amount-nest:company");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "750");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byTestId<HTMLButtonElement>("budget-limits-save-nest:company").click());
    await settle();

    expect(budgetLimitsApiMock.saveLimit).toHaveBeenCalledWith("company-1", "nest", "company", {
      amountCents: 75000,
      period: "calendar_month_utc",
      mode: "hard",
      isActive: true,
    });
    expect(budgetLimitsApiMock.list.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(budgetLimitsApiMock.usage.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(budgetLimitsApiMock.journal.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("PATCHes the signal-only mode and takes the returned source", async () => {
    await renderScreen();
    await act(async () => byTestId<HTMLButtonElement>("budget-limits-signal-only").click());
    await settle();

    expect(budgetLimitsApiMock.patchSignalOnly).toHaveBeenCalledWith("company-1", false);
    expect(byTestId<HTMLButtonElement>("budget-limits-signal-only").getAttribute("aria-checked")).toBe("false");
  });

  it("DELETEs a limit and refreshes the tree", async () => {
    await renderScreen();
    await act(async () => byTestId<HTMLButtonElement>("budget-limits-remove-nest:company").click());
    await settle();

    expect(budgetLimitsApiMock.removeLimit).toHaveBeenCalledWith("company-1", "nest", "company");
    expect(budgetLimitsApiMock.list.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("surfaces a save failure", async () => {
    budgetLimitsApiMock.saveLimit.mockReset().mockRejectedValue(new ApiError("Saving failed", 500, {}));
    await renderScreen();
    const input = byTestId<HTMLInputElement>("budget-limits-amount-nest:company");
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "750");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => byTestId<HTMLButtonElement>("budget-limits-save-nest:company").click());
    await settle();

    expect(byTestId("myrmidon-budget-limits-error").textContent).toContain("Saving failed");
  });

  it("shows the error state when the limits read fails, and the notice without a company", async () => {
    budgetLimitsApiMock.list.mockReset().mockRejectedValue(new ApiError("Not found", 404, {}));
    await renderScreen();
    expect(byTestId("myrmidon-budget-limits-error").textContent).toContain("Not found");

    selectedCompanyId = "";
    const usageCalls = budgetLimitsApiMock.usage.mock.calls.length;
    const listCalls = budgetLimitsApiMock.list.mock.calls.length;
    await renderScreen();
    expect(byTestId("myrmidon-budget-limits-no-company")).not.toBeNull();
    // No company — the four reads are disabled: their call counts do not move.
    expect(budgetLimitsApiMock.usage.mock.calls.length).toBe(usageCalls);
    expect(budgetLimitsApiMock.list.mock.calls.length).toBe(listCalls);
  });
});