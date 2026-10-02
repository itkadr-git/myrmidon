// @vitest-environment jsdom
// myrmidon(TRACING-HEALTH): tests for the "LLM tracing" status card.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TracingHealthCard, TracingHealthCardView } from "./TracingHealthCard";
import { formatWindowLabel, type TracingHealthCard as Card } from "./tracingHealthApi";

const mockApi = vi.hoisted(() => ({ get: vi.fn() }));

vi.mock("@/api/client", () => ({ api: mockApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "11111111-1111-4111-8111-111111111111" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function card(overrides: Partial<Card> = {}): Card {
  return {
    status: "ok",
    checks: {
      gatewayTraffic: { ok: true, note: "12 gateway requests in the window" },
      eventsCore: { ok: true, note: "9 event(s) in events_core over 15 min", count: 9 },
      callbackErrors: { ok: true, note: "no callback logging failures", failures: 0 },
    },
    summary: "LLM tracing is healthy: 12 gateway requests in the window",
    enabled: true,
    windowMs: 900_000,
    checkedAt: "2026-10-02T12:00:00.000Z",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
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

describe("TracingHealthCardView", () => {
  it("renders a green ok card with the summary and the three legs", () => {
    render(<TracingHealthCardView card={card()} loading={false} error={null} />);
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-card"]')).not.toBeNull();
    const status = container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent ?? "";
    expect(status).toContain("ok");
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-summary"]')?.textContent).toContain("healthy");
    const legs = container.querySelectorAll('[data-testid="myrmidon-tracing-health-checks"] li');
    expect(legs).toHaveLength(3);
  });

  it("renders a red card when the check reports red", () => {
    render(
      <TracingHealthCardView
        card={card({
          status: "red",
          summary: "LLM tracing is unhealthy: no events in events_core over 15 min while the gateway served traffic",
          checks: {
            gatewayTraffic: { ok: true, note: "30 gateway requests in the window" },
            eventsCore: { ok: false, note: "no events in events_core over 15 min while the gateway served traffic", count: 0 },
            callbackErrors: { ok: true, note: "no callback logging failures", failures: 0 },
          },
        })}
        loading={false}
        error={null}
      />,
    );
    const status = container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent ?? "";
    expect(status).toContain("red");
    const summary = container.querySelector('[data-testid="myrmidon-tracing-health-summary"]')?.textContent ?? "";
    expect(summary).toContain("unhealthy");
  });

  it("renders the not-enabled state with the setting names", () => {
    render(
      <TracingHealthCardView
        card={card({
          enabled: false,
          summary:
            "LLM tracing health is not enabled: set MYRMIDON_TRACING_CLICKHOUSE_URL, MYRMIDON_TRACING_CLICKHOUSE_KEY_SECRET, MYRMIDON_TRACING_LITELLM_METRICS_URL and MYRMIDON_TRACING_LITELLM_KEY_SECRET.",
          checks: {
            gatewayTraffic: { ok: true, note: "not evaluated" },
            eventsCore: { ok: true, note: "not evaluated", count: null },
            callbackErrors: { ok: true, note: "not evaluated", failures: null },
          },
        })}
        loading={false}
        error={null}
      />,
    );
    const status = container.querySelector('[data-testid="myrmidon-tracing-health-status"]')?.textContent ?? "";
    expect(status).toContain("not enabled");
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-checks"]')).toBeNull();
  });

  it("renders the error state", () => {
    render(<TracingHealthCardView card={null} loading={false} error="Request failed" />);
    expect(container.querySelector('[data-testid="myrmidon-tracing-health-error"]')?.textContent).toContain("Request failed");
  });
});

describe("TracingHealthCard container", () => {
  it("loads the card through the API client", async () => {
    mockApi.get.mockResolvedValue(card());
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <TracingHealthCard />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="myrmidon-tracing-health-summary"]')).not.toBeNull();
    });
    expect(mockApi.get).toHaveBeenCalledWith("/myrmidon/companies/11111111-1111-4111-8111-111111111111/tracing/health");
    queryClient.clear();
  });
});

describe("formatWindowLabel", () => {
  it("labels minutes and hours", () => {
    expect(formatWindowLabel(900_000)).toBe("15 min");
    expect(formatWindowLabel(3_600_000)).toBe("1 h");
    expect(formatWindowLabel(7_200_000)).toBe("2 h");
  });
});
