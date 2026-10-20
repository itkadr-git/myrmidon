// @vitest-environment jsdom
// myrmidon(LICENSING): tests for per-module no-license banner on closed module screens.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { LICENSE_MODULES, ModuleLicenseBanner } from "./ModuleLicenseBanner";

const mockLicensingApi = vi.hoisted(() => ({
  status: vi.fn(),
  parseRequest: vi.fn(),
  issue: vi.fn(),
  issued: vi.fn(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

const mockCopy = vi.hoisted(() => vi.fn());

vi.mock("./licensingApi", async () => {
  const actual = await vi.importActual<typeof import("./licensingApi")>("./licensingApi");
  return { ...actual, licensingApi: mockLicensingApi };
});

vi.mock("@/api/access", () => ({
  accessApi: mockAccessApi,
}));

vi.mock("@/lib/clipboard", () => ({
  copyTextToClipboard: mockCopy,
}));

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

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockLicensingApi.status.mockResolvedValue(STATUS);
  mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
    source: "session",
    isInstanceAdmin: true,
    membershipRole: "owner",
  });
  mockCopy.mockResolvedValue(undefined);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

function renderBanner(module: (typeof LICENSE_MODULES)[number], isLicensed?: boolean) {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <ModuleLicenseBanner module={module} isLicensed={isLicensed} />
      </QueryClientProvider>,
    );
  });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe("ModuleLicenseBanner", () => {
  for (const module of LICENSE_MODULES) {
    it(`shows server identifier and copies request for ${module} when unlicensed`, async () => {
      renderBanner(module);
      await vi.waitFor(() => expect(q("module-license-banner")).not.toBeNull());

      expect(q("module-license-install-id")?.textContent?.trim()).toBe(STATUS.installId);
      expect(mockLicensingApi.status).toHaveBeenCalledWith([module]);

      const copyBtn = q("module-license-copy-request") as HTMLButtonElement | null;
      expect(copyBtn).not.toBeNull();
      copyBtn!.click();

      const expectedOneLiner = `MYR-LICENSE-REQUEST v1 install_id=${STATUS.installId} modules=${module} board=${STATUS.board}`;
      await vi.waitFor(() => expect(mockCopy).toHaveBeenCalledWith(expectedOneLiner));
      await vi.waitFor(() => expect(q("module-license-copied")).not.toBeNull());
    });
  }

  it("renders nothing when user is not an instance admin (B4 visibility)", async () => {
    mockAccessApi.getCurrentBoardAccess.mockResolvedValue({
      source: "session",
      isInstanceAdmin: false,
      membershipRole: "member",
    });

    renderBanner("google-ai");
    await new Promise((r) => setTimeout(r, 20));

    expect(q("module-license-banner")).toBeNull();
    expect(container.textContent).toBe("");
    expect(mockLicensingApi.status).not.toHaveBeenCalled();
  });

  it("renders nothing when the licensing API refuses with 403", async () => {
    mockLicensingApi.status.mockRejectedValue(new ApiError("Instance admin access required", 403, null));

    renderBanner("antigravity");
    await vi.waitFor(() => expect(mockLicensingApi.status).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));

    expect(q("module-license-banner")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("renders nothing when module is licensed", async () => {
    renderBanner("chatgpt-pool", true);
    await new Promise((r) => setTimeout(r, 20));

    expect(q("module-license-banner")).toBeNull();
    expect(container.textContent).toBe("");
    expect(mockLicensingApi.status).not.toHaveBeenCalled();
  });
});
