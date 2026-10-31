// @vitest-environment jsdom

import type { ReactNode } from "react";
import { createContext, useContext, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@myrmidon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsWithResultPanel } from "./RunsWithResultPanel";

const listAgentsMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const searchParamsListeners = new Set<() => void>();
let currentSearch = "";

const setSearchParamsMock = vi.hoisted(() =>
  vi.fn((updater: unknown) => {
    if (typeof updater === "function") {
      const next = (updater as (prev: URLSearchParams) => URLSearchParams)(
        new URLSearchParams(currentSearch),
      );
      currentSearch = next.toString();
    } else {
      currentSearch = new URLSearchParams(updater as string).toString();
    }
    for (const listener of searchParamsListeners) {
      listener();
    }
  }),
);

vi.mock("@/api/agents", () => ({
  agentsApi: { list: (companyId: string) => listAgentsMock(companyId) },
}));

vi.mock("@/api/heartbeats", () => ({
  heartbeatsApi: {
    list: (companyId: string, agentId?: string, limit?: number, options?: unknown) =>
      listRunsMock(companyId, agentId, limit, options),
  },
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...props }: { to: string; children: ReactNode }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useSearchParams: () => {
    const [, setTick] = useState(0);
    useEffect(() => {
      const update = () => setTick((v) => v + 1);
      searchParamsListeners.add(update);
      return () => {
        searchParamsListeners.delete(update);
      };
    }, []);
    return [new URLSearchParams(currentSearch), setSearchParamsMock];
  },
}));

const SelectMockContext = createContext<{
  value?: string;
  onValueChange?: (value: string) => void;
}>({});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (val: string) => void;
    children: ReactNode;
  }) => (
    <SelectMockContext.Provider value={{ value, onValueChange }}>
      <div data-testid="select-root" data-value={value}>
        {children}
      </div>
    </SelectMockContext.Provider>
  ),
  SelectTrigger: ({
    children,
    "aria-label": ariaLabel,
    ...props
  }: {
    children: ReactNode;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} {...props}>
      {children}
    </button>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => {
    const { value } = useContext(SelectMockContext);
    return <span>{value && value !== "__all" ? value : placeholder}</span>;
  },
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: ReactNode;
  }) => {
    const { onValueChange } = useContext(SelectMockContext);
    return (
      <button
        type="button"
        role="option"
        data-value={value}
        onClick={() => onValueChange?.(value)}
      >
        {children}
      </button>
    );
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(overrides: Partial<HeartbeatRun> = {}): HeartbeatRun {
  return {
    id: "run-12345678-abcd",
    companyId: "company-1",
    agentId: "agent-1",
    invocationSource: "manual",
    status: "succeeded",
    startedAt: new Date("2026-08-31T18:00:00.000Z"),
    finishedAt: new Date("2026-08-31T18:01:05.000Z"),
    resultJson: { summary: "Resolved task and opened PR" },
    error: null,
    createdAt: new Date("2026-08-31T18:00:00.000Z"),
    contextSnapshot: { wakeReason: "issue_assigned" },
    ...overrides,
  } as HeartbeatRun;
}

describe("RunsWithResultPanel", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    currentSearch = "";
    searchParamsListeners.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
        },
      },
    });
    listAgentsMock.mockReset();
    listRunsMock.mockReset();
    setSearchParamsMock.mockClear();
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Builder Bot" },
      { id: "agent-2", name: "Reviewer Bot" },
    ]);
    listRunsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
      root = null;
    }
    container.remove();
    queryClient.clear();
  });

  async function flushReact() {
    for (let i = 0; i < 4; i += 1) {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 10));
      flushSync(() => {});
    }
  }

  async function flushUntil(predicate: () => boolean, timeoutMs = 3000) {
    const start = Date.now();
    while (!predicate()) {
      if (Date.now() - start > timeoutMs) break;
      await flushReact();
    }
  }

  function render() {
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });
    return root;
  }

  it("fetches runs with hasResult=true and renders the table with transition links", async () => {
    const run1 = run({
      id: "run-11111111-aaaa",
      agentId: "agent-1",
      contextSnapshot: { wakeReason: "issue_assigned" },
      resultJson: { summary: "Resolved issue OPE-9652" },
    });
    listRunsMock.mockResolvedValue([run1]);

    render();
    await flushUntil(() => container.textContent?.includes("Resolved issue OPE-9652") ?? false);

    expect(listRunsMock).toHaveBeenCalledWith("company-1", undefined, 200, {
      wakeReason: undefined,
      hasResult: true,
    });

    expect(container.textContent).toContain("Runs with result");
    expect(container.textContent).toContain("Builder Bot");
    expect(container.textContent).toContain("issue assigned");
    expect(container.textContent).toContain("Resolved issue OPE-9652");

    const link = container.querySelector(
      'a[href="/agents/agent-1/runs/run-11111111-aaaa"]',
    );
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe("run-1111");
  });

  it("filters runs by wakeReason when set in search params", async () => {
    currentSearch = "wakeReason=issue_commented";
    const run1 = run({
      id: "run-comment-1",
      agentId: "agent-1",
      contextSnapshot: { wakeReason: "issue_commented" },
      resultJson: { summary: "Answered comment" },
    });
    listRunsMock.mockResolvedValue([run1]);

    render();
    await flushUntil(() => container.textContent?.includes("Answered comment") ?? false);

    expect(listRunsMock).toHaveBeenCalledWith("company-1", undefined, 200, {
      wakeReason: "issue_commented",
      hasResult: true,
    });
    expect(container.textContent).toContain("Answered comment");
  });

  it("filters runs by agentId when set in search params", async () => {
    currentSearch = "agentId=agent-2";
    const run2 = run({
      id: "run-agent-2",
      agentId: "agent-2",
      contextSnapshot: { wakeReason: "timer" },
      resultJson: { summary: "Periodic check finished" },
    });
    listRunsMock.mockResolvedValue([run2]);

    render();
    await flushUntil(() => container.textContent?.includes("Periodic check finished") ?? false);

    expect(listRunsMock).toHaveBeenCalledWith("company-1", "agent-2", 200, {
      wakeReason: undefined,
      hasResult: true,
    });
    expect(container.textContent).toContain("Reviewer Bot");
    expect(container.textContent).toContain("Periodic check finished");
  });

  it("shows empty state when no runs match", async () => {
    listRunsMock.mockResolvedValue([]);

    render();
    await flushUntil(() => container.textContent?.includes("No runs with result found.") ?? false);

    expect(container.textContent).toContain("No runs with result found.");
  });

  it("shows error state with retry button on failure", async () => {
    listRunsMock.mockRejectedValue(new Error("Database connection timed out"));

    render();
    await flushUntil(
      () => container.textContent?.includes("Database connection timed out") ?? false,
    );

    expect(container.textContent).toContain("Database connection timed out");
    const retryButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Try again"),
    );
    expect(retryButton).toBeDefined();
    expect(retryButton?.textContent).toContain("Try again");

    expect(listRunsMock).toHaveBeenCalledTimes(1);
    flushSync(() => {
      retryButton?.click();
    });
    expect(listRunsMock).toHaveBeenCalledTimes(2);
  });

  it("allows changing selectors interactively to update the filtered result set, then clearing filters", async () => {
    const runAlpha = run({
      id: "run-alpha",
      agentId: "agent-1",
      contextSnapshot: { wakeReason: "issue_assigned" },
      resultJson: { summary: "Alpha completed task" },
    });
    const runBeta = run({
      id: "run-beta",
      agentId: "agent-2",
      contextSnapshot: { wakeReason: "timer" },
      resultJson: { summary: "Beta periodic sync" },
    });

    listRunsMock.mockImplementation((_companyId, agentId, _limit, options) => {
      let filtered = [runAlpha, runBeta];
      if (agentId) {
        filtered = filtered.filter((r) => r.agentId === agentId);
      }
      if (options?.wakeReason) {
        filtered = filtered.filter((r) => r.contextSnapshot?.wakeReason === options.wakeReason);
      }
      return Promise.resolve(filtered);
    });

    render();
    await flushUntil(
      () =>
        (container.textContent?.includes("Alpha completed task") &&
          container.textContent?.includes("Beta periodic sync")) ??
        false,
    );

    // Initial state: both runs are visible
    expect(container.textContent).toContain("Alpha completed task");
    expect(container.textContent).toContain("Beta periodic sync");

    // 1. Select Agent 2: click option for agent-2
    const agent2Option = container.querySelector<HTMLButtonElement>(
      '[role="option"][data-value="agent-2"]',
    );
    expect(agent2Option).not.toBeNull();
    agent2Option?.click();

    await flushUntil(
      () =>
        (container.textContent?.includes("Beta periodic sync") &&
          !container.textContent?.includes("Alpha completed task")) ??
        false,
    );

    // Result set is updated: only Agent 2's run is visible
    expect(container.textContent).toContain("Beta periodic sync");
    expect(container.textContent).not.toContain("Alpha completed task");

    // 2. Select Wake Reason "issue_assigned": Beta has "timer", so no runs should match
    const wakeOption = container.querySelector<HTMLButtonElement>(
      '[role="option"][data-value="issue_assigned"]',
    );
    expect(wakeOption).not.toBeNull();
    wakeOption?.click();

    await flushUntil(
      () =>
        container.textContent?.includes("No runs with result match the selected filters.") ??
        false,
    );
    expect(container.textContent).toContain("No runs with result match the selected filters.");

    // 3. Click "Clear filters" button
    const clearButton = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes("Clear filters"),
    );
    expect(clearButton).not.toBeUndefined();
    clearButton?.click();

    await flushUntil(
      () =>
        (container.textContent?.includes("Alpha completed task") &&
          container.textContent?.includes("Beta periodic sync")) ??
        false,
    );

    // Both runs are visible again
    expect(container.textContent).toContain("Alpha completed task");
    expect(container.textContent).toContain("Beta periodic sync");
  });
});
