// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HeartbeatRun } from "@myrmidon/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunsWithResultPanel } from "./RunsWithResultPanel";

const listAgentsMock = vi.hoisted(() => vi.fn());
const listRunsMock = vi.hoisted(() => vi.fn());
const setSearchParamsMock = vi.hoisted(() => vi.fn());
let currentSearch = "";

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
  useSearchParams: () => [
    new URLSearchParams(currentSearch),
    setSearchParamsMock,
  ],
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
  let queryClient: QueryClient;

  beforeEach(() => {
    currentSearch = "";
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
    setSearchParamsMock.mockReset();
    listAgentsMock.mockResolvedValue([
      { id: "agent-1", name: "Builder Bot" },
      { id: "agent-2", name: "Reviewer Bot" },
    ]);
    listRunsMock.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    queryClient.clear();
  });

  function render() {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
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

    const root = render();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

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

    const root = render();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

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

    const root = render();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    expect(listRunsMock).toHaveBeenCalledWith("company-1", "agent-2", 200, {
      wakeReason: undefined,
      hasResult: true,
    });
    expect(container.textContent).toContain("Reviewer Bot");
    expect(container.textContent).toContain("Periodic check finished");
  });

  it("shows empty state when no runs match", async () => {
    listRunsMock.mockResolvedValue([]);

    const root = render();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("No runs with result found.");
  });

  it("shows error state with retry button on failure", async () => {
    listRunsMock.mockRejectedValue(new Error("Database connection timed out"));

    const root = render();
    await Promise.resolve();
    await Promise.resolve();
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <RunsWithResultPanel companyId="company-1" />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain("Database connection timed out");
    const retryButton = container.querySelector("button");
    expect(retryButton?.textContent).toContain("Try again");
  });
});
