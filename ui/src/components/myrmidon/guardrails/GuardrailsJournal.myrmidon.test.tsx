// @vitest-environment jsdom
// myrmidon(1.7-GRD-MODES): view-tier tests for the firing-journal block —
// a mocked react-query drives the journal with fake event rows; the filters
// (kind, severity, runId), the empty state and the error state are the
// contract.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardrailsJournal } from "./GuardrailsJournal";
import type { GuardrailEventRow } from "./guardrailsApi";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string) => key;
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

const listEventsMock = vi.hoisted(() => vi.fn());

vi.mock("./guardrailsApi", async (importOriginal) => {
  const original = await importOriginal<typeof import("./guardrailsApi")>();
  return {
    ...original,
    guardrailsApi: {
      ...original.guardrailsApi,
      // The journal calls guardrailsApi.listEvents; mock the namespace
      // member, not a bare export.
      listEvents: listEventsMock,
    },
    guardrailsEventsQueryKey: (companyId: string, filters: unknown) => [
      "myrmidon",
      "guardrails",
      "events",
      companyId,
      filters,
    ],
  };
});

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

const EVENT: GuardrailEventRow = {
  id: "event-1",
  companyId: "company-1",
  kind: "secret",
  surface: "run_output",
  severity: "error",
  runId: "run-1",
  issueId: "issue-1",
  snippet: "the key is [masked] for deploy",
  occurredAt: "2026-01-02T03:04:05.000Z",
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  listEventsMock.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(filters: Parameters<typeof GuardrailsJournal>[0]["filters"], onFiltersChange = vi.fn()) {
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <GuardrailsJournal companyId="company-1" filters={filters} onFiltersChange={onFiltersChange} />
      </QueryClientProvider>,
    );
  });
}

// React-query resolves queries over microtasks; flush a few turns inside
// act() until the query settles (same pattern as the wip-limit tests).
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe("myrmidon(1.7-GRD-MODES) GuardrailsJournal", () => {
  it("lists the journaled events with their columns", async () => {
    listEventsMock.mockResolvedValue({ events: [EVENT], count: 1, limit: 50 });
    render({});
    await settle();
    const table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("secret");
    expect(table!.textContent).toContain("run_output");
    expect(table!.textContent).toContain("error");
    expect(table!.textContent).toContain("run-1");
    expect(table!.textContent).toContain("[masked]");
  });

  it("shows the empty state when no events match", async () => {
    listEventsMock.mockResolvedValue({ events: [], count: 0, limit: 50 });
    render({});
    await settle();
    expect(container.querySelector('[data-testid="guardrails-journal-empty"]')).not.toBeNull();
  });

  it("shows the error state when the query fails", async () => {
    listEventsMock.mockRejectedValue(new Error("journal down"));
    render({});
    await settle();
    expect(container.querySelector('[data-testid="guardrails-journal-error"]')).not.toBeNull();
  });

  it("renders the kind and severity filter controls", () => {
    listEventsMock.mockResolvedValue({ events: [], count: 0, limit: 50 });
    render({});
    expect(container.querySelector("#guardrails-journal-kind")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-severity")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#guardrails-journal-run")).not.toBeNull();
  });
});
