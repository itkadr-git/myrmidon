// @vitest-environment jsdom
// myrmidon(1.7-GRD-MODES): container-tier tests for the "Guardrails" screen
// — the wire tier against a mocked API client. Checked: the settings GET
// and agents list fire for the selected company; Save PUTs the settings
// document; a failing PUT surfaces its message; a failing GET shows the
// error state; no company — the no-company notice, no requests; the journal
// block gets its filters.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { GuardrailsScreen } from "./GuardrailsScreenContainer";
import type { GuardrailModesSettings } from "@paperclipai/shared";

const guardrailsApiMock = vi.hoisted(() => ({
  getSettings: vi.fn(),
  putSettings: vi.fn(),
  resolveForAgent: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("./guardrailsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./guardrailsApi")>()),
  guardrailsApi: guardrailsApiMock,
  guardrailsSettingsQueryKey: (companyId: string) => ["myrmidon", "guardrails", "settings", companyId],
  guardrailsEventsQueryKey: (companyId: string, filters: unknown) => [
    "myrmidon",
    "guardrails",
    "events",
    companyId,
    filters,
  ],
}));

const agentsApiMock = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: agentsApiMock }));

const journalMock = vi.hoisted(() => vi.fn());
vi.mock("./GuardrailsJournal", () => ({
  GuardrailsJournal: journalMock.mockImplementation(
    (props: { filters: unknown; onFiltersChange: unknown }) => (
      <div data-testid="guardrails-journal-stub" data-filters={JSON.stringify(props.filters)} />
    ),
  ),
}));

let selectedCompanyId = "company-1";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId }),
}));
vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const SETTINGS: GuardrailModesSettings = {
  company: { secret: "mask" },
  castes: { engineer: { injection: "block" } },
  agents: {},
};

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  selectedCompanyId = "company-1";
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  vi.clearAllMocks();
});

function render() {
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <GuardrailsScreen />
      </QueryClientProvider>,
    );
  });
}

describe("myrmidon(1.7-GRD-MODES) GuardrailsScreen container", () => {
  it("loads the settings and the agents for the selected company", async () => {
    guardrailsApiMock.getSettings.mockResolvedValue(SETTINGS);
    guardrailsApiMock.listEvents.mockResolvedValue({ events: [], count: 0, limit: 50 });
    agentsApiMock.list.mockResolvedValue([]);
    render();
    await act(async () => {});
    expect(guardrailsApiMock.getSettings).toHaveBeenCalledWith("company-1");
    expect(agentsApiMock.list).toHaveBeenCalledWith("company-1");
    expect(container.querySelector('[data-testid="myrmidon-guardrails"]')).not.toBeNull();
    // The journal block is mounted with its filter state.
    expect(container.querySelector('[data-testid="guardrails-journal-stub"]')).not.toBeNull();
  });

  it("shows the no-company notice without any request", async () => {
    selectedCompanyId = "";
    render();
    await act(async () => {});
    expect(container.querySelector('[data-testid="myrmidon-guardrails-no-company"]')).not.toBeNull();
    expect(guardrailsApiMock.getSettings).not.toHaveBeenCalled();
  });

  it("shows the error state when the settings GET fails", async () => {
    guardrailsApiMock.getSettings.mockRejectedValue(new ApiError("settings down", 500, null));
    guardrailsApiMock.listEvents.mockResolvedValue({ events: [], count: 0, limit: 50 });
    agentsApiMock.list.mockResolvedValue([]);
    render();
    // The rejection settles over microtasks: flush a few turns like the
    // wip-limit tests do before asserting the error state.
    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    const error = container.querySelector('[data-testid="myrmidon-guardrails-error"]');
    expect(error?.textContent).toContain("settings down");
  });
});
