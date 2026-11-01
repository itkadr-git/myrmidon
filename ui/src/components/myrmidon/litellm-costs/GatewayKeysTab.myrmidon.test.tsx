// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { countKeyedAgents, litellmKeysApi } from "./litellmKeysApi";
import { cycleLines, GatewayKeysTab, keyRows } from "./GatewayKeysTab";
import type { AgentGatewayKeyView } from "./litellmKeysApi";
import { agentsApi } from "@/api/agents";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const view = (over: Partial<AgentGatewayKeyView>): AgentGatewayKeyView => ({
  agentId: "agent-a",
  secretName: "llm-gateway-key-agent-a",
  present: false,
  valueHash: null,
  canManageKeys: true,
  ...over,
});

describe("myrmidon(M2-B) gateway keys tab", () => {
  it("joins key state with agent names and sorts by name", () => {
    const rows = keyRows(
      [
        view({ agentId: "agent-b", secretName: "llm-gateway-key-beta-agent-b" }),
        view({ agentId: "agent-a", secretName: "llm-gateway-key-alpha-agent-a", present: true }),
      ],
      new Map([
        ["agent-a", "alpha"],
        ["agent-b", "beta"],
      ]),
    );
    expect(rows.map((row) => row.agentName)).toEqual(["alpha", "beta"]);
    expect(rows[0]!.present).toBe(true);
  });

  it("preserves model allowlist and defaults undefined to empty array", () => {
    const rows = keyRows(
      [
        view({
          agentId: "agent-a",
          present: true,
          models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
        }),
        view({ agentId: "agent-b", present: true, models: undefined }),
      ],
      new Map([
        ["agent-a", "alpha"],
        ["agent-b", "beta"],
      ]),
    );
    expect(rows[0]!.models).toEqual(["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]);
    expect(rows[1]!.models).toEqual([]);
  });

  it("projects an agent key budget into the display row", () => {
    const budget = {
      amountUsd: 9.5,
      periodHours: 24,
      mode: "block" as const,
      effectiveMode: "soft" as const,
      caste: "engineer",
    };
    const [row] = keyRows(
      [view({ agentId: "agent-a", budget, role: "engineer" })],
      new Map([["agent-a", "alpha"]]),
    );
    expect(row?.budget).toEqual(budget);
  });

  it("counts how many agents have a key of their own", () => {
    expect(countKeyedAgents([view({ present: true }), view({ agentId: "b" })])).toEqual({ keyed: 1, total: 2 });
  });

  it("shows no loop lines while the gateway could not be read", () => {
    expect(cycleLines({ chains: [], cycles: [], error: "the gateway answered 500" })).toEqual([]);
    expect(cycleLines(undefined)).toEqual([]);
  });

  it("names each loop it found", () => {
    expect(
      cycleLines({
        chains: [],
        cycles: [
          { path: ["model-a", "model-b"], described: "model-a -> model-b -> model-a" },
        ],
      }),
    ).toEqual(["model-a -> model-b -> model-a"]);
  });
});

describe("myrmidon(M2-B) gateway keys tab UI rendering", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it("renders explicit warning «пусто = все модели» when models list is empty", async () => {
    vi.spyOn(agentsApi, "list").mockResolvedValue([
      { id: "agent-a", name: "researcher" } as never,
    ]);
    vi.spyOn(litellmKeysApi, "keys").mockResolvedValue([
      view({
        agentId: "agent-a",
        present: true,
        models: [],
      }),
    ]);
    vi.spyOn(litellmKeysApi, "fallbacks").mockResolvedValue({
      chains: [],
      cycles: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GatewayKeysTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    // Wait for queries to settle
    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="empty-models-warning"]')).not.toBeNull();
    });

    const warningEl = container.querySelector('[data-testid="empty-models-warning"]');
    expect(warningEl?.textContent).toContain("пусто = все модели");

    // Agent card link
    const agentLink = container.querySelector('a[href="/agents/agent-a"]');
    expect(agentLink).not.toBeNull();
    expect(agentLink?.textContent).toBe("researcher");
  });

  it("fetches and renders service budgets from the key-budgets API", async () => {
    vi.spyOn(agentsApi, "list").mockResolvedValue([{ id: "agent-a", name: "coder" }] as never);
    vi.spyOn(litellmKeysApi, "keys").mockResolvedValue([view({ agentId: "agent-a", present: true })]);
    vi.spyOn(litellmKeysApi, "fallbacks").mockResolvedValue({ chains: [], cycles: [] });
    vi.spyOn(litellmKeysApi, "keyBudgets").mockResolvedValue({
      companyId: "company-1",
      signalOnly: false,
      projectionEnabled: true,
      agents: [],
      services: [
        {
          serviceId: "service-engineering",
          serviceName: "Engineering",
          level: "caste",
          scopeId: "engineering",
          tag: "myrm-caste-engineering",
          secretName: null,
          budget: {
            amountUsd: 42,
            periodHours: 24,
            mode: "block",
            effectiveMode: "block",
            caste: "engineering",
          },
        },
      ],
    });

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GatewayKeysTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="service-budget-service-engineering"]')).not.toBeNull();
    });
    expect(container.textContent).toContain("Engineering");
    expect(container.textContent).toContain("$42.00/24h");
    expect(litellmKeysApi.keyBudgets).toHaveBeenCalledWith("company-1");
  });

  it("shows the key-budget API error without hiding the keys card", async () => {
    vi.spyOn(agentsApi, "list").mockResolvedValue([{ id: "agent-a", name: "coder" }] as never);
    vi.spyOn(litellmKeysApi, "keys").mockResolvedValue([view({ agentId: "agent-a", present: true })]);
    vi.spyOn(litellmKeysApi, "fallbacks").mockResolvedValue({ chains: [], cycles: [] });
    vi.spyOn(litellmKeysApi, "keyBudgets").mockRejectedValue(new Error("budget API unavailable"));

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GatewayKeysTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => expect(container.textContent).toContain("budget API unavailable"));
    expect(container.textContent).toContain("coder");
  });

  it("renders model tags when models allowlist is populated", async () => {
    vi.spyOn(agentsApi, "list").mockResolvedValue([
      { id: "agent-a", name: "coder" } as never,
    ]);
    vi.spyOn(litellmKeysApi, "keys").mockResolvedValue([
      view({
        agentId: "agent-a",
        present: true,
        models: ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"],
      }),
    ]);
    vi.spyOn(litellmKeysApi, "fallbacks").mockResolvedValue({
      chains: [],
      cycles: [],
    });

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <GatewayKeysTab companyId="company-1" />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });

    await vi.waitFor(() => {
      expect(container.textContent).toContain("openai/gpt-4o");
    });

    expect(container.textContent).toContain("openai/gpt-4o");
    expect(container.textContent).toContain("anthropic/claude-3-5-sonnet");
    expect(container.querySelector('[data-testid="empty-models-warning"]')).toBeNull();
  });
});
