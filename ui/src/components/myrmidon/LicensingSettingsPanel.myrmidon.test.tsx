// @vitest-environment jsdom
// myrmidon(LICENSING): tests for the licensing settings panel.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { LicensingSettingsPanel } from "./LicensingSettingsPanel";

const mockApi = vi.hoisted(() => ({
  status: vi.fn(),
  parseRequest: vi.fn(),
  issue: vi.fn(),
  issued: vi.fn(),
}));
const mockCopy = vi.hoisted(() => vi.fn());

vi.mock("./licensingApi", async () => {
  const actual = await vi.importActual<typeof import("./licensingApi")>("./licensingApi");
  return { ...actual, licensingApi: mockApi };
});
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mockCopy }));

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
  mockApi.status.mockResolvedValue(STATUS);
  mockApi.issued.mockResolvedValue([]);
  mockCopy.mockResolvedValue(undefined);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

function renderPanel() {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <LicensingSettingsPanel />
      </QueryClientProvider>,
    );
  });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

async function setValue(el: HTMLElement, value: string) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function ready() {
  await vi.waitFor(() => expect(q("licensing-panel")).not.toBeNull());
}

describe("LicensingSettingsPanel", () => {
  it("shows the install id and copies the license request", async () => {
    renderPanel();
    await ready();
    expect(q("licensing-install-id")?.textContent).toBe(STATUS.installId);
    expect((q("licensing-request-text") as HTMLTextAreaElement).value).toBe(STATUS.request);
    expect(q("licensing-source-warning")).toBeNull();
    q("licensing-copy-request")!.click();
    await vi.waitFor(() => expect(mockCopy).toHaveBeenCalledWith(STATUS.request));
  });

  it("renders nothing when the API refuses (not an instance admin)", async () => {
    mockApi.status.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    renderPanel();
    await vi.waitFor(() => expect(mockApi.status).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(q("licensing-panel")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("warns when the id does not come from the machine id", async () => {
    mockApi.status.mockResolvedValue({ ...STATUS, source: "generated" });
    renderPanel();
    await ready();
    expect(q("licensing-source-warning")).not.toBeNull();
  });

  it("fills the form from a pasted request and issues a license", async () => {
    mockApi.parseRequest.mockResolvedValue({
      instanceId: "myr-aaaaaaaaaaaaaaaaaaaa",
      board: "1.6.6",
      modules: ["google-ai"],
      requestedAt: "2026-10-16T08:00:00.000Z",
    });
    mockApi.issue.mockResolvedValue({
      license: "MYR1.payload.signature",
      id: "lic-1",
      payload: { instance_id: "myr-aaaaaaaaaaaaaaaaaaaa", modules: ["google-ai"], features: ["core"], expires: null, watermark: null },
    });
    renderPanel();
    await ready();
    expect((q("licensing-issue") as HTMLButtonElement).disabled).toBe(true);
    flushSync(() => void setValue(q("licensing-paste")!, "MYRQ1.abc"));
    await vi.waitFor(() => expect((q("licensing-manual-id") as HTMLInputElement).value).toBe("myr-aaaaaaaaaaaaaaaaaaaa"));
    expect((q("licensing-issue-google-ai") as HTMLInputElement).checked).toBe(true);
    flushSync(() => void setValue(q("licensing-client")!, "client-1"));
    await vi.waitFor(() => expect((q("licensing-issue") as HTMLButtonElement).disabled).toBe(false));
    q("licensing-issue")!.click();
    await vi.waitFor(() => expect(q("licensing-license-text")).not.toBeNull());
    expect(mockApi.issue).toHaveBeenCalledWith({
      request: "MYRQ1.abc",
      modules: ["google-ai"],
      days: 365,
      watermark: "client-1",
    });
    expect((q("licensing-license-text") as HTMLTextAreaElement).value).toBe("MYR1.payload.signature");
    expect(q("licensing-download")?.getAttribute("href")).toContain("MYR1.payload.signature");
    q("licensing-copy-license")!.click();
    await vi.waitFor(() => expect(mockCopy).toHaveBeenCalledWith("MYR1.payload.signature"));
  });

  it("shows one clear message for a bad request blob", async () => {
    mockApi.parseRequest.mockRejectedValue(new ApiError("x", 422, null));
    renderPanel();
    await ready();
    flushSync(() => void setValue(q("licensing-paste")!, "garbage"));
    await vi.waitFor(() => expect(q("licensing-error")).not.toBeNull());
    expect(q("licensing-error")!.textContent).not.toContain("422");
  });

  it("disables issuing and explains when the signing key is not configured", async () => {
    mockApi.status.mockResolvedValue({ ...STATUS, issuerConfigured: false });
    renderPanel();
    await ready();
    expect(q("licensing-issuer-missing")).not.toBeNull();
    flushSync(() => void setValue(q("licensing-manual-id")!, "myr-aaaaaaaaaaaaaaaaaaaa"));
    expect((q("licensing-issue") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists issued licenses", async () => {
    mockApi.issued.mockResolvedValue([
      {
        id: "lic-1",
        issuedAt: "2026-10-16T08:00:00.000Z",
        issuedBy: "user-a",
        instanceId: "myr-aaaaaaaaaaaaaaaaaaaa",
        modules: ["google-ai"],
        features: ["core"],
        expires: 1800000000,
        watermark: "client-1",
      },
    ]);
    renderPanel();
    await ready();
    await vi.waitFor(() => expect(q("licensing-issued-row")).not.toBeNull());
    expect(q("licensing-issued-row")!.textContent).toContain("myr-aaaaaaaaaaaaaaaaaaaa");
    expect(q("licensing-issued-row")!.textContent).toContain("2027-01-15");
  });
});
