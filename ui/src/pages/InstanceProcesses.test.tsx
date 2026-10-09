// @vitest-environment jsdom

// myrmidon(PROCS-0.1): the «Processes» panel. A fake api layer answers one
// live row; the page must render the role, boot id, pulse age, metrics and
// the host/version columns — and the empty state when no process has ever
// pulsed.

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockListProcesses = vi.hoisted(() => vi.fn());
vi.mock("@/api/instanceSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/instanceSettings")>();
  return {
    ...actual,
    boardProcessesApi: { list: () => mockListProcesses() },
  };
});

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }),
}));

import { MemoryRouter } from "react-router-dom";
import { InstanceProcesses } from "./InstanceProcesses";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
  });
}

const ROW = {
  bootId: "9c2b7a7e-1111-4a2b-9b11-0123456789ab",
  role: "single",
  pid: 42,
  hostname: "board-1",
  container: "0123456789abcdef99",
  version: "1.6.6-rc.1",
  startedAt: new Date(Date.now() - 3_600_000).toISOString(),
  lastSeenAt: new Date(Date.now() - 5_000).toISOString(),
  apiPort: 3100,
  eventLoopLagMs: 3,
  rssBytes: 500 * 1024 * 1024,
};

describe("InstanceProcesses (PROCS-0.1)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    mockListProcesses.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  afterEach(() => {
    if (root) flushSync(() => root!.unmount());
    root = null;
    container.remove();
  });

  async function renderPage() {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <MemoryRouter>
            <InstanceProcesses />
          </MemoryRouter>
        </QueryClientProvider>,
      );
    });
    // The query resolves a tick after mount; wait until the loading text is gone.
    for (let i = 0; i < 20 && (container.textContent ?? "").includes("Loading processes"); i++) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
    }
  }

  it("renders the live process row with role, boot id, pulse and metrics", async () => {
    mockListProcesses.mockResolvedValue([ROW]);
    await renderPage();
    const text = container.textContent ?? "";
    expect(text).toContain("single");
    expect(text).toContain("9c2b7a7e");
    expect(text).toContain("0123456789abcdef99");
    expect(text).toContain("1.6.6-rc.1");
    expect(text).toContain("3.0 ms");
    expect(text).toContain("500 MB");
    expect(text).toMatch(/\ds ago/);
  });

  it("renders the empty state when no process has ever pulsed", async () => {
    mockListProcesses.mockResolvedValue([]);
    await renderPage();
    expect(container.textContent ?? "").toContain("No processes have reported yet");
  });
});
