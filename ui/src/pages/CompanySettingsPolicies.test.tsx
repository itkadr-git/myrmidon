// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { CompanySettings } from "./CompanySettings";

const mockCompaniesApi = vi.hoisted(() => ({
  update: vi.fn(),
  archive: vi.fn(),
}));
const mockAccessApi = vi.hoisted(() => ({
  listMembers: vi.fn(),
}));
const mockAssetsApi = vi.hoisted(() => ({
  uploadCompanyLogo: vi.fn(),
}));
const mockCompany = vi.hoisted(() => ({
  current: {} as Record<string, unknown>,
}));

vi.mock("../api/companies", () => ({ companiesApi: mockCompaniesApi }));
vi.mock("../api/access", () => ({ accessApi: mockAccessApi }));
vi.mock("../api/assets", () => ({ assetsApi: mockAssetsApi }));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [mockCompany.current],
    selectedCompany: mockCompany.current,
    selectedCompanyId: "company-1",
    setSelectedCompanyId: vi.fn(),
  }),
}));

vi.mock("../components/InteractionGovernancePanel", () => ({
  InteractionGovernancePanel: () => null,
  applyGovernanceChange: (governance: unknown) => governance,
}));

vi.mock("./InstanceGeneralSettings", () => ({
  InstanceGeneralSettings: () => null,
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function company(overrides: Record<string, unknown> = {}) {
  return {
    id: "company-1",
    name: "Acme Robotics",
    description: null,
    status: "active",
    issuePrefix: "ACM",
    brandColor: null,
    logoUrl: null,
    attachmentMaxBytes: null,
    requireBoardApprovalForNewAgents: false,
    interactionResolverGovernance: {},
    feedbackDataSharingEnabled: false,
    defaultResponsibleUserId: "user-1",
    ...overrides,
  };
}

const MEMBERS = {
  members: [
    { id: "m1", principalId: "user-1", status: "active", user: { name: "Alice", email: "a@x.test" } },
    { id: "m2", principalId: "user-2", status: "active", user: { name: "Bob", email: "b@x.test" } },
    { id: "m3", principalId: "user-3", status: "archived", user: { name: "Gone", email: "g@x.test" } },
  ],
};

describe("CompanySettings policies and pause/resume", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockCompany.current = company();
    mockAccessApi.listMembers.mockResolvedValue(MEMBERS);
    mockCompaniesApi.update.mockResolvedValue(company());
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  async function render() {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TooltipProvider>
            <CompanySettings />
          </TooltipProvider>
        </QueryClientProvider>,
      );
    });
    await vi.waitFor(() => expect(mockAccessApi.listMembers).toHaveBeenCalledWith("company-1"));
    await vi.waitFor(() =>
      expect(container.querySelectorAll("[data-testid=company-settings-responsible-user-select] option").length).toBe(3),
    );
    return root;
  }

  it("reads stored values and lists only active members", async () => {
    mockCompany.current = company({ feedbackDataSharingEnabled: true });
    const root = await render();
    const select = container.querySelector<HTMLSelectElement>("[data-testid=company-settings-responsible-user-select]")!;
    expect(select.value).toBe("user-1");
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(["Not set", "Alice", "Bob"]);
    const toggle = container.querySelector("[data-testid=company-settings-feedback-sharing-toggle]")!;
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    flushSync(() => root.unmount());
  });

  it("patches the responsible user from the select", async () => {
    const root = await render();
    const select = container.querySelector<HTMLSelectElement>("[data-testid=company-settings-responsible-user-select]")!;
    select.value = "user-2";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { defaultResponsibleUserId: "user-2" }),
    );
    flushSync(() => root.unmount());
  });

  it("enables feedback sharing from the toggle", async () => {
    const root = await render();
    container.querySelector<HTMLElement>("[data-testid=company-settings-feedback-sharing-toggle]")!.click();
    await vi.waitFor(() =>
      expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { feedbackDataSharingEnabled: true }),
    );
    flushSync(() => root.unmount());
  });

  it("shows the server error when the save is rejected", async () => {
    mockCompaniesApi.update.mockRejectedValue(new Error("Forbidden"));
    const root = await render();
    container.querySelector<HTMLElement>("[data-testid=company-settings-feedback-sharing-toggle]")!.click();
    await vi.waitFor(() =>
      expect(container.querySelector("[data-testid=company-settings-policies-error]")?.textContent).toBe("Forbidden"),
    );
    flushSync(() => root.unmount());
  });

  it("pauses only after confirmation", async () => {
    const root = await render();
    const button = container.querySelector<HTMLButtonElement>("[data-testid=company-settings-pause-resume]")!;
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    button.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(mockCompaniesApi.update).not.toHaveBeenCalled();
    confirm.mockReturnValue(true);
    button.click();
    await vi.waitFor(() =>
      expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { status: "paused" }),
    );
    flushSync(() => root.unmount());
  });

  it("resumes a paused company", async () => {
    mockCompany.current = company({ status: "paused" });
    const root = await render();
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const button = container.querySelector<HTMLButtonElement>("[data-testid=company-settings-pause-resume]")!;
    expect(button.textContent).toBe("Resume organization");
    button.click();
    await vi.waitFor(() =>
      expect(mockCompaniesApi.update).toHaveBeenCalledWith("company-1", { status: "active" }),
    );
    flushSync(() => root.unmount());
  });
});
