/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PluginRecord } from "@shared/types/plugin";
import { queryKeys } from "../queryKeys";
import { pluginsApi } from "../api/plugins";
import { PluginManager } from "./PluginManager";

vi.mock("../api/plugins", () => ({
  pluginsApi: {
    list: vi.fn(),
    listBundled: vi.fn(),
    install: vi.fn(),
    uninstall: vi.fn(),
    enable: vi.fn(),
    disable: vi.fn(),
    upgrade: vi.fn(),
  },
}));

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "c1", name: "Acme" } }),
}));

vi.mock("../context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

vi.mock("../context/ToastContext", () => ({
  useToastActions: () => ({ pushToast: vi.fn() }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k }),
}));

vi.mock("../lib/router", () => ({
  Link: ({ children, to, ...props }: any) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useNavigate: () => vi.fn(),
}));

vi.mock("../plugins/slots", () => ({
  PluginSlotMount: () => null,
  usePluginSlots: () => [],
}));

vi.mock("../components/PageTabBar", () => ({
  PageTabBar: () => null,
}));

function flushReact(): Promise<void> {
  return act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const mockPluginReady: PluginRecord = {
  id: "plugin-uuid-1",
  pluginKey: "paperclip.slack",
  packageName: "@paperclip/plugin-slack",
  version: "1.0.0",
  apiVersion: 1,
  categories: ["adapters" as any],
  manifestJson: {
    schemaVersion: 1,
    id: "paperclip.slack",
    displayName: "Slack Connector",
    version: "1.0.0",
    description: "Slack integration plugin",
    capabilities: [],
  } as any,
  status: "ready",
  installOrder: 1,
  packagePath: null,
  lastError: null,
  installedAt: new Date(),
  updatedAt: new Date(),
};

describe("PluginManager UI regression tests", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.mocked(pluginsApi.listBundled).mockResolvedValue([]);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.clearAllMocks();
  });

  it("renders loading message initially before first fetch resolves", async () => {
    // Keep promise pending
    let resolvePromise: (value: PluginRecord[]) => void = () => {};
    const pendingPromise = new Promise<PluginRecord[]>((res) => {
      resolvePromise = res;
    });
    vi.mocked(pluginsApi.list).mockReturnValue(pendingPromise);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginManager />
        </QueryClientProvider>,
      );
    });

    expect(container.textContent).toContain(
      "area.adapters-plugins-2.plugin-manager.loading",
    );
    expect(container.textContent).not.toContain("Slack Connector");

    // Resolve query and flush
    await act(async () => {
      resolvePromise([mockPluginReady]);
    });
    await flushReact();

    expect(container.textContent).toContain("Slack Connector");
  });

  it("regression: does not unmount or clear the plugin list during background refetch", async () => {
    vi.mocked(pluginsApi.list).mockResolvedValue([mockPluginReady]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginManager />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // Verify initial load displays plugin
    expect(container.textContent).toContain("Slack Connector");

    // Simulate background refetch where query function takes time to respond
    let resolveRefetch: (value: PluginRecord[]) => void = () => {};
    const refetchPromise = new Promise<PluginRecord[]>((res) => {
      resolveRefetch = res;
    });
    vi.mocked(pluginsApi.list).mockReturnValue(refetchPromise);

    // Trigger refetch in background
    act(() => {
      queryClient.refetchQueries({ queryKey: queryKeys.plugins.all });
    });
    await flushReact();

    // Crucial regression check: while background refetch is running,
    // the existing plugin list MUST NOT disappear or be replaced by the full-page loading placeholder
    expect(container.textContent).toContain("Slack Connector");
    expect(container.querySelector(".p-4.text-sm.text-muted-foreground")).toBeNull();

    // Resolve refetch
    await act(async () => {
      resolveRefetch([mockPluginReady]);
    });
    await flushReact();

    expect(container.textContent).toContain("Slack Connector");
  });

  it("renders loading badge and disables toggle when plugin status is loading/transitioning", async () => {
    const mockPluginLoading: PluginRecord = {
      ...mockPluginReady,
      id: "plugin-uuid-2",
      status: "loading" as any,
    };
    vi.mocked(pluginsApi.list).mockResolvedValue([mockPluginLoading]);

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <PluginManager />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.textContent).toContain("Slack Connector");
    // Verify loading badge is rendered instead of inactive
    const loadingBadge = container.querySelector('[role="status"]');
    expect(loadingBadge).not.toBeNull();
    expect(loadingBadge?.textContent).toContain(
      "area.adapters-plugins-2.plugin-manager.loading",
    );

    // Verify power toggle button is disabled while loading
    const powerButton = container.querySelector(
      'button[title="area.adapters-plugins-2.plugin-manager.enable"]',
    ) as HTMLButtonElement | null;
    expect(powerButton?.disabled).toBe(true);
  });
});
