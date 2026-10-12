// @vitest-environment jsdom

import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./Sidebar";

vi.mock("../context/DialogContext", () => ({
  useDialogActions: () => ({ openNewIssue: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Operations", issuePrefix: "OPE" },
  }),
}));

vi.mock("../context/SidebarContext", () => ({
  useSidebar: () => ({ collapsed: false, peeking: false, isMobile: false, setSidebarOpen: vi.fn() }),
}));

vi.mock("@/hooks/useAgentChatEnabled", () => ({
  useAgentChatEnabled: () => ({ enabled: false }),
}));

vi.mock("../hooks/useInboxBadge", () => ({
  useInboxBadge: () => ({ inbox: 0, failedRuns: 0 }),
}));

vi.mock("../hooks/useStreamlinedUiEnabled", () => ({
  useStreamlinedUiEnabled: () => ({ enabled: false }),
}));

vi.mock("../hooks/useSharedPolling", () => ({
  useSharedPollingQuery: () => ({ enabled: false, refetchInterval: false }),
  usePublishSharedQueryData: vi.fn(),
}));

vi.mock("./SidebarCompanyMenu", () => ({
  SidebarCompanyMenu: () => <div>Operations</div>,
}));

vi.mock("./SidebarProjects", () => ({ SidebarProjects: () => null }));
vi.mock("./SidebarAgents", () => ({ SidebarAgents: () => null }));
vi.mock("./SidebarAgentChats", () => ({ SidebarAgentChats: () => null }));
vi.mock("./SidebarRecentTasks", () => ({ SidebarRecentTasks: () => null }));
vi.mock("./SidebarStarredProjects", () => ({ SidebarStarredProjects: () => null }));
vi.mock("@/plugins/slots", () => ({ PluginSlotOutlet: () => null }));
vi.mock("@/plugins/launchers", () => ({ PluginLauncherOutlet: () => null }));

function renderSidebar() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/OPE/dashboard"]}>
        <Routes>
          <Route path=":companyPrefix/*" element={<Sidebar />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("Myrmidon sidebar navigation", () => {
  it("builds every sidebar href with the current company prefix", () => {
    const markup = renderSidebar();
    const hrefs = Array.from(markup.matchAll(/href="([^"]+)"/g), (match) => match[1]);

    expect(hrefs.length).toBeGreaterThan(0);
    expect(hrefs.every((href) => href.startsWith("/OPE/"))).toBe(true);
    expect(hrefs).toContain("/OPE/swarm-claim");
    expect(hrefs).toContain("/OPE/foraging");
  });
});
