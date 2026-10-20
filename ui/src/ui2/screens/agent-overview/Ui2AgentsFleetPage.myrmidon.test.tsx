// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import type { AnchorHTMLAttributes } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2AgentsFleetPage } from "./Ui2AgentsFleetPage";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";

const mockApi = vi.hoisted(() => ({ agentsList: vi.fn(), liveRuns: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { list: mockApi.agentsList } }));
vi.mock("@/api/heartbeats", () => ({ heartbeatsApi: { liveRunsForCompany: mockApi.liveRuns } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "co1" }) }));
vi.mock("@/lib/router", () => ({ Link: ({ to, children, ...props }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) => <a href={to} {...props}>{children}</a> }));

async function settle() {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => window.setTimeout(resolve, 0));
  flushSync(() => {});
}

describe("agents fleet screen", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  beforeEach(() => {
    container = document.createElement("div"); document.body.appendChild(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    mockApi.liveRuns.mockResolvedValue([]);
  });
  afterEach(() => { root?.unmount(); client.clear(); container.remove(); vi.clearAllMocks(); });
  async function renderScreen() {
    root = createRoot(container);
    flushSync(() => root.render(<QueryClientProvider client={client}><Ui2I18nProvider initialLocale="en"><Ui2AgentsFleetPage /></Ui2I18nProvider></QueryClientProvider>));
    await settle();
  }
  it("renders the empty state", async () => {
    mockApi.agentsList.mockResolvedValue([]);
    await renderScreen();
    expect(container.textContent).toContain("No agents configured yet.");
  });
  it("renders a cycle without dropping agents, paused status, and agent links", async () => {
    mockApi.agentsList.mockResolvedValue([
      { id: "a", name: "Alpha", role: "lead", status: "paused", reportsTo: "b" },
      { id: "b", name: "Beta", role: "engineer", status: "active", reportsTo: "a" },
    ]);
    await renderScreen();
    expect(container.textContent).toContain("Alpha");
    expect(container.textContent).toContain("Beta");
    expect(container.textContent).toContain("Paused");
    expect(container.querySelector('a[href="/agents/a"]')).not.toBeNull();
    expect(container.querySelector('a[href="/agents/b"]')).not.toBeNull();
  });
});
