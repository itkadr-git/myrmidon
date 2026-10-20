// @vitest-environment jsdom
// myrmidon(LICENSING): module-screen flow tests for google-ai, antigravity, and chatgpt-pool.
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LICENSE_MODULES } from "@/components/myrmidon/ModuleLicenseBanner";
import { PluginPage } from "./PluginPage";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockLicensingApi = vi.hoisted(() => ({
  status: vi.fn(),
  parseRequest: vi.fn(),
  issue: vi.fn(),
  issued: vi.fn(),
}));

const mockCopy = vi.hoisted(() => vi.fn());
const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());

const mockParams = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
  pluginId: undefined as string | undefined,
  pluginRoutePath: undefined as string | undefined,
  "*": undefined as string | undefined,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/components/myrmidon/licensingApi", async () => {
  const actual = await vi.importActual<typeof import("@/components/myrmidon/licensingApi")>("@/components/myrmidon/licensingApi");
  return { ...actual, licensingApi: mockLicensingApi };
});

vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: mockCopy,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => mockParams,
}));

vi.mock("@/plugins/slots", async () => {
  const actual = await vi.importActual<typeof import("@/plugins/slots")>("@/plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    PluginSlotMount: ({ slot }: { slot: { displayName: string } }) => (
      <div data-testid="plugin-slot-mount">{slot.displayName}</div>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS = {
  installId: "myr-0123456789abcdef0123",
  source: "machine-id" as const,
  board: "1.6.6",
  knownModules: ["google-ai", "antigravity", "chatgpt-pool"],
  issuerConfigured: true,
  request: "MYRQ1.eyJ2IjoxfQ",
};

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function moduleContribution(moduleName: string) {
  return {
    pluginId: `plugin-${moduleName}`,
    pluginKey: `myrmidon.${moduleName}`,
    displayName: moduleName,
    version: "1.0.0",
    uiEntryFile: "ui.js",
    slots: [
      {
        type: "page",
        id: `${moduleName}-page`,
        displayName: moduleName,
        exportName: "ModulePage",
        routePath: moduleName,
      },
    ],
    launchers: [],
  };
}

describe("PluginPage module screen licensing flows", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.companyPrefix = "PAP";
    mockParams.pluginId = undefined;
    mockParams.pluginRoutePath = undefined;
    mockParams["*"] = undefined;

    mockLicensingApi.status.mockResolvedValue(STATUS);
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      source: "session",
      isInstanceAdmin: true,
      membershipRole: "owner",
    });
    mockCopy.mockResolvedValue(undefined);
  });

  afterEach(() => {
    container.remove();
    vi.clearAllMocks();
  });

  async function renderPage() {
    const root = createRoot(container);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginPage />
        </QueryClientProvider>,
      );
    });
    await flushReact();
    await flushReact();
    return root;
  }

  const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

  for (const module of LICENSE_MODULES) {
    it(`shows no-license banner with install-id and copy action for ${module} screen to instance admin`, async () => {
      mockParams.pluginRoutePath = module;
      mockPluginsApi.listUiContributions.mockResolvedValue([moduleContribution(module)]);

      await renderPage();

      const banner = q("module-license-banner");
      expect(banner).not.toBeNull();
      expect(banner?.getAttribute("data-module")).toBe(module);

      const installIdEl = q("module-license-install-id");
      expect(installIdEl?.textContent?.trim()).toBe(STATUS.installId);

      const copyBtn = q("module-license-copy-request");
      expect(copyBtn).not.toBeNull();
      copyBtn!.click();

      const expectedRequest = `MYR-LICENSE-REQUEST v1 install_id=${STATUS.installId} modules=${module} board=${STATUS.board}`;
      await vi.waitFor(() => expect(mockCopy).toHaveBeenCalledWith(expectedRequest));
      await vi.waitFor(() => expect(q("module-license-copied")).not.toBeNull());

      expect(q("plugin-slot-mount")?.textContent).toBe(module);
    });

    it(`blocks access to ${module} module screen for non-instance-admin`, async () => {
      mockParams.pluginRoutePath = module;
      mockPluginsApi.listUiContributions.mockResolvedValue([moduleContribution(module)]);
      mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
        source: "session",
        isInstanceAdmin: false,
        membershipRole: "member",
      });

      await renderPage();

      expect(q("module-license-banner")).toBeNull();
      expect(q("plugin-slot-mount")).toBeNull();
      expect(container.textContent).toContain("Page not found");
    });
  }
});
