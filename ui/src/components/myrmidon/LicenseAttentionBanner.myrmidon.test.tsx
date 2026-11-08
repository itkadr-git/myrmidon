// @vitest-environment jsdom
// myrmidon(LICENSING): the "closed module without a license" banner.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LicenseAttentionBanner } from "./LicenseAttentionBanner";

const mockApi = vi.hoisted(() => ({ status: vi.fn(), saveLicense: vi.fn() }));
const mockAccess = vi.hoisted(() => ({ getCurrentBoardAccess: vi.fn() }));

vi.mock("./licensingApi", async () => {
  const actual = await vi.importActual<typeof import("./licensingApi")>("./licensingApi");
  return { ...actual, licensingApi: mockApi };
});
vi.mock("@/api/access", () => ({ accessApi: mockAccess }));
vi.mock("@/lib/router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const status = (attention: boolean) => ({
  installId: "myr-0123456789abcdef0123",
  source: "machine-id",
  board: "1.6.6",
  knownModules: ["google-ai", "antigravity", "chatgpt-pool"],
  installedModules: ["antigravity"],
  request: "MYRQ1.eyJ2IjoxfQ",
  license: { source: "none", path: "/etc/myrmidon-license/license.key", envOverride: false, share: "mounted" },
  modules: [
    { module: "google-ai", installed: false, state: "missing", reason: "no_license", expires: null },
    { module: "antigravity", installed: true, state: attention ? "expired" : "valid", reason: attention ? "expired" : "ok", expires: null },
    { module: "chatgpt-pool", installed: false, state: "missing", reason: "no_license", expires: null },
  ],
  attention,
});

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockAccess.getCurrentBoardAccess.mockResolvedValue({ source: "session", isInstanceAdmin: true });
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

function render() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <MemoryRouter>
        <QueryClientProvider client={queryClient}>
          <LicenseAttentionBanner />
        </QueryClientProvider>
      </MemoryRouter>,
    );
  });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const settle = () => new Promise((r) => setTimeout(r, 30));

describe("LicenseAttentionBanner", () => {
  it("names the unlicensed installed module and links to the Licenses screen", async () => {
    mockApi.status.mockResolvedValue(status(true));
    render();
    await vi.waitFor(() => expect(q("license-attention-banner")).not.toBeNull());
    expect(q("license-attention-banner")!.textContent).toContain("antigravity");
    expect(q("license-attention-banner")!.textContent).not.toContain("google-ai");
    expect(q("license-attention-link")!.getAttribute("href")).toBe("/company/settings/instance/licenses");
  });

  it("stays hidden when every installed module is licensed", async () => {
    mockApi.status.mockResolvedValue(status(false));
    render();
    await vi.waitFor(() => expect(mockApi.status).toHaveBeenCalled());
    await settle();
    expect(q("license-attention-banner")).toBeNull();
  });

  it("never asks the licensing API for a user who is not an instance admin", async () => {
    mockAccess.getCurrentBoardAccess.mockResolvedValue({ source: "session", isInstanceAdmin: false });
    mockApi.status.mockResolvedValue(status(true));
    render();
    await vi.waitFor(() => expect(mockAccess.getCurrentBoardAccess).toHaveBeenCalled());
    await settle();
    expect(mockApi.status).not.toHaveBeenCalled();
    expect(container.textContent).toBe("");
  });
});
