// @vitest-environment jsdom
// myrmidon(1.6.6 OPE-9650): view-tier tests for the firing-journal block —
// verifies the journal columns, rule/mode/level/agent/severity/runId filters,
// UI filtering narrowing the output, empty/error states, and pagination controls.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuardrailsJournal } from "./GuardrailsJournal";
import type { GuardrailEventRow } from "./guardrailsApi";
import type { GuardrailsAgentRow } from "./GuardrailsScreen";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mockT = vi.hoisted(() => {
  const t = (key: string, opts?: Record<string, unknown>) => {
    if (opts?.page !== undefined) return `${key}:${opts.page}`;
    return key;
  };
  return { t };
});

vi.mock("@/i18n", () => ({ useTranslation: () => mockT }));

const listEventsMock = vi.hoisted(() => vi.fn());

vi.mock("./guardrailsApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./guardrailsApi")>()),
  guardrailsApi: {
    ...(await importOriginal<typeof import("./guardrailsApi")>()).guardrailsApi,
    listEvents: listEventsMock,
  },
  guardrailsEventsQueryKey: (companyId: string, filters: unknown) => [
    "myrmidon",
    "guardrails",
    "events",
    companyId,
    filters,
  ],
}));

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

const EVENT_1: GuardrailEventRow = {
  id: "event-1",
  companyId: "company-1",
  kind: "secret",
  rule: "secret",
  mode: "flag",
  level: "run",
  agentId: "agent-1",
  decision: "flag",
  surface: "run_output",
  severity: "error",
  runId: "run-1",
  issueId: "issue-1",
  snippet: "the key is [masked] for deploy",
  occurredAt: "2026-01-02T03:04:05.000Z",
};

const EVENT_2: GuardrailEventRow = {
  id: "event-2",
  companyId: "company-1",
  kind: "pii",
  rule: "pii",
  mode: "block",
  level: "company",
  agentId: "agent-2",
  decision: "block",
  surface: "tool_output",
  severity: "warn",
  runId: "run-2",
  issueId: "issue-2",
  snippet: "email john@example.com blocked",
  occurredAt: "2026-01-02T04:05:06.000Z",
};

const AGENTS: GuardrailsAgentRow[] = [
  { agentId: "agent-1", name: "Agent One" },
  { agentId: "agent-2", name: "Agent Two" },
];

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  listEventsMock.mockReset();
});

afterEach(() => {
  flushSync(() => root?.unmount());
  root = null;
  queryClient.clear();
  container.remove();
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function flushQuery(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function settleQuery(): Promise<void> {
  await flushQuery();
  await flushQuery();
  await flushQuery();
}

function render(
  filters: Parameters<typeof GuardrailsJournal>[0]["filters"],
  onFiltersChange = vi.fn(),
  agents: GuardrailsAgentRow[] = AGENTS,
) {
  root = createRoot(container);
  act(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <GuardrailsJournal
          companyId="company-1"
          agents={agents}
          filters={filters}
          onFiltersChange={onFiltersChange}
        />
      </QueryClientProvider>,
    );
  });
}

describe("myrmidon(1.6.6 OPE-9650) GuardrailsJournal", () => {
  it("lists the journaled events with their columns", async () => {
    listEventsMock.mockResolvedValue({ events: [EVENT_1], count: 1, limit: 50, offset: 0 });
    render({});
    await act(settleQuery);
    const table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table).not.toBeNull();
    expect(table!.textContent).toContain("secret");
    expect(table!.textContent).toContain("flag");
    expect(table!.textContent).toContain("run");
    expect(table!.textContent).toContain("Agent One");
    expect(table!.textContent).toContain("run_output");
    expect(table!.textContent).toContain("error");
    expect(table!.textContent).toContain("run-1");
    expect(table!.textContent).toContain("[masked]");
  });

  it("shows the empty state when no events match", async () => {
    listEventsMock.mockResolvedValue({ events: [], count: 0, limit: 50, offset: 0 });
    render({});
    await act(settleQuery);
    expect(container.querySelector('[data-testid="guardrails-journal-empty"]')).not.toBeNull();
  });

  it("shows the error state when the query fails", async () => {
    listEventsMock.mockRejectedValue(new Error("journal down"));
    render({});
    await act(settleQuery);
    expect(container.querySelector('[data-testid="guardrails-journal-error"]')).not.toBeNull();
  });

  it("renders the rule, mode, level, agent, kind, severity, and runId filter controls", () => {
    listEventsMock.mockResolvedValue({ events: [], count: 0, limit: 50, offset: 0 });
    render({});
    expect(container.querySelector("#guardrails-journal-rule")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-mode")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-level")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-agent")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-kind")).not.toBeNull();
    expect(container.querySelector("#guardrails-journal-severity")).not.toBeNull();
    expect(container.querySelector<HTMLInputElement>("#guardrails-journal-run")).not.toBeNull();
  });

  it("UI-тест фильтрации: фильтр сужает выдачу", async () => {
    // 1. Without filter: returns all events (both secret and pii)
    listEventsMock.mockImplementation((_companyId, filters) => {
      let filtered = [EVENT_1, EVENT_2];
      if (filters.rule) filtered = filtered.filter((e) => e.rule === filters.rule);
      if (filters.mode) filtered = filtered.filter((e) => e.mode === filters.mode);
      if (filters.level) filtered = filtered.filter((e) => e.level === filters.level);
      if (filters.agentId) filtered = filtered.filter((e) => e.agentId === filters.agentId);
      return Promise.resolve({ events: filtered, count: filtered.length, limit: 50, offset: 0 });
    });

    render({});
    await act(settleQuery);
    let table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table!.textContent).toContain("secret");
    expect(table!.textContent).toContain("pii");

    // 2. Filter by rule="secret" narrows output: only EVENT_1 is shown, EVENT_2 is excluded
    flushSync(() => root?.unmount());
    root = null;
    render({ rule: "secret" });
    await act(settleQuery);
    table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table!.textContent).toContain("secret");
    expect(table!.textContent).not.toContain("pii");

    // 3. Filter by mode="block" narrows output: only EVENT_2 is shown, EVENT_1 is excluded
    flushSync(() => root?.unmount());
    root = null;
    render({ mode: "block" });
    await act(settleQuery);
    table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table!.textContent).toContain("pii");
    expect(table!.textContent).not.toContain("secret");

    // 4. Filter by agentId="agent-1" narrows output: only EVENT_1 is shown
    flushSync(() => root?.unmount());
    root = null;
    render({ agentId: "agent-1" });
    await act(settleQuery);
    table = container.querySelector('[data-testid="guardrails-journal-table"]');
    expect(table!.textContent).toContain("Agent One");
    expect(table!.textContent).not.toContain("Agent Two");
  });

  it("pagination controls: navigates pages and updates offset", async () => {
    const onFiltersChange = vi.fn();
    listEventsMock.mockResolvedValue({ events: [EVENT_1], count: 1, limit: 1, offset: 0 });

    // Page 1 (offset: 0, limit: 1): Previous disabled, Next enabled
    render({ limit: 1, offset: 0 }, onFiltersChange);
    await act(settleQuery);

    const prevBtn = container.querySelector<HTMLButtonElement>('[data-testid="guardrails-journal-prev"]')!;
    const nextBtn = container.querySelector<HTMLButtonElement>('[data-testid="guardrails-journal-next"]')!;
    const pageLabel = container.querySelector('[data-testid="guardrails-journal-page"]')!;

    expect(prevBtn).not.toBeNull();
    expect(nextBtn).not.toBeNull();
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(pageLabel.textContent).toContain("guardrails.paginationPage:1");

    // Clicking Next calls onFiltersChange with offset = 1
    act(() => {
      nextBtn.click();
    });
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, offset: 1 }),
    );

    // Page 2 (offset: 1, limit: 1): Previous enabled
    flushSync(() => root?.unmount());
    root = null;
    render({ limit: 1, offset: 1 }, onFiltersChange);
    await act(settleQuery);

    const prevBtnPage2 = container.querySelector<HTMLButtonElement>('[data-testid="guardrails-journal-prev"]')!;
    const pageLabel2 = container.querySelector('[data-testid="guardrails-journal-page"]')!;

    expect(prevBtnPage2.disabled).toBe(false);
    expect(pageLabel2.textContent).toContain("guardrails.paginationPage:2");

    act(() => {
      prevBtnPage2.click();
    });
    expect(onFiltersChange).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1, offset: 0 }),
    );
  });
});
