// @vitest-environment jsdom
// myrmidon(LICENSING): tests for the client licensing screen.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { LicensingSettingsPanel } from "./LicensingSettingsPanel";
import type { LicensingStatus } from "./licensingApi";

const mockApi = vi.hoisted(() => ({
  status: vi.fn(),
  saveLicense: vi.fn(),
}));
const mockCopy = vi.hoisted(() => vi.fn());

vi.mock("./licensingApi", async () => {
  const actual = await vi.importActual<typeof import("./licensingApi")>("./licensingApi");
  return { ...actual, licensingApi: mockApi };
});
vi.mock("@/lib/clipboard", () => ({ copyTextToClipboard: mockCopy }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS: LicensingStatus = {
  installId: "myr-0123456789abcdef0123",
  source: "machine-id",
  board: "1.6.6",
  knownModules: ["google-ai", "antigravity", "chatgpt-pool"],
  installedModules: ["antigravity", "google-ai"],
  request: "MYRQ1.eyJ2IjoxfQ",
  license: { source: "none", path: "/etc/myrmidon-license/license.key", envOverride: false, share: "mounted" },
  modules: [
    { module: "google-ai", installed: true, state: "missing", reason: "no_license", expires: null },
    { module: "antigravity", installed: true, state: "missing", reason: "no_license", expires: null },
    { module: "chatgpt-pool", installed: false, state: "missing", reason: "no_license", expires: null },
  ],
  attention: true,
};

const LICENSED: LicensingStatus = {
  ...STATUS,
  license: { ...STATUS.license, source: "file" },
  modules: [
    { module: "google-ai", installed: true, state: "valid", reason: "ok", expires: 1800000000 },
    { module: "antigravity", installed: true, state: "expiring", reason: "ok", expires: 1792800000 },
    { module: "chatgpt-pool", installed: false, state: "wrong_instance", reason: "instance_mismatch", expires: null },
  ],
  attention: false,
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

function setValue(el: HTMLElement, value: string) {
  const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

async function ready() {
  await vi.waitFor(() => expect(q("licensing-panel")).not.toBeNull());
}

describe("LicensingSettingsPanel", () => {
  it("shows the install id, preselects the installed modules and copies the request", async () => {
    renderPanel();
    await ready();
    expect(q("licensing-install-id")?.textContent).toBe(STATUS.installId);
    expect((q("licensing-req-google-ai") as HTMLInputElement).checked).toBe(true);
    expect((q("licensing-req-antigravity") as HTMLInputElement).checked).toBe(true);
    expect((q("licensing-req-chatgpt-pool") as HTMLInputElement).checked).toBe(false);
    expect((q("licensing-request-text") as HTMLTextAreaElement).value).toBe(STATUS.request);
    q("licensing-copy-request")!.click();
    await vi.waitFor(() => expect(mockCopy).toHaveBeenCalledWith(STATUS.request));
  });

  it("asks the server for a request naming the modules the admin picks", async () => {
    renderPanel();
    await ready();
    q("licensing-req-chatgpt-pool")!.click();
    await vi.waitFor(() =>
      expect(mockApi.status).toHaveBeenLastCalledWith(["antigravity", "google-ai", "chatgpt-pool"]),
    );
  });

  it("shows the state of every closed module", async () => {
    mockApi.status.mockResolvedValue(LICENSED);
    renderPanel();
    await ready();
    expect(q("licensing-module-google-ai")?.getAttribute("data-state")).toBe("valid");
    expect(q("licensing-module-state-google-ai")?.textContent).toContain("2027-01-15");
    expect(q("licensing-module-antigravity")?.getAttribute("data-state")).toBe("expiring");
    expect(q("licensing-module-state-antigravity")?.textContent).toContain("2026-10-24");
    expect(q("licensing-module-chatgpt-pool")?.getAttribute("data-state")).toBe("wrong_instance");
    expect(q("licensing-path")?.textContent).toContain("/etc/myrmidon-license/license.key");
  });

  it("renders nothing when the API refuses (not an instance admin)", async () => {
    mockApi.status.mockRejectedValue(new ApiError("Instance admin access required", 403, null));
    renderPanel();
    await vi.waitFor(() => expect(mockApi.status).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(q("licensing-panel")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("warns when the id is not machine-derived or the file is not shared with the host", async () => {
    mockApi.status.mockResolvedValue({
      ...STATUS,
      source: "generated",
      license: { ...STATUS.license, share: "container-only" },
    });
    renderPanel();
    await ready();
    expect(q("licensing-source-warning")).not.toBeNull();
    expect(q("licensing-share-warning")).not.toBeNull();
  });

  it("saves a pasted license and shows the new state", async () => {
    mockApi.saveLicense.mockResolvedValue(LICENSED);
    renderPanel();
    await ready();
    expect((q("licensing-save") as HTMLButtonElement).disabled).toBe(true);
    flushSync(() => setValue(q("licensing-license-input")!, "  MYR1.payload.signature\n"));
    await vi.waitFor(() => expect((q("licensing-save") as HTMLButtonElement).disabled).toBe(false));
    mockApi.status.mockResolvedValue(LICENSED); // what the server reports once the file is written
    q("licensing-save")!.click();
    await vi.waitFor(() => expect(q("licensing-saved")).not.toBeNull());
    expect(mockApi.saveLicense).toHaveBeenCalledWith("MYR1.payload.signature");
    await vi.waitFor(() => expect(q("licensing-module-google-ai")?.getAttribute("data-state")).toBe("valid"));
    expect((q("licensing-license-input") as HTMLTextAreaElement).value).toBe("");
  });

  it("loads the license from a license.key file", async () => {
    renderPanel();
    await ready();
    const input = q("licensing-license-file") as HTMLInputElement;
    const file = new File(["MYR1.from.file\n"], "license.key", { type: "text/plain" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() =>
      expect((q("licensing-license-input") as HTMLTextAreaElement).value).toBe("MYR1.from.file"),
    );
  });

  it("explains a refused license by its code, without raw server text", async () => {
    mockApi.saveLicense.mockRejectedValue(
      new ApiError("This license was issued for another installation", 422, {
        error: "x",
        code: "license_instance_mismatch",
      }),
    );
    renderPanel();
    await ready();
    flushSync(() => setValue(q("licensing-license-input")!, "MYR1.a.b"));
    await vi.waitFor(() => expect((q("licensing-save") as HTMLButtonElement).disabled).toBe(false));
    q("licensing-save")!.click();
    await vi.waitFor(() => expect(q("licensing-save-error")).not.toBeNull());
    expect(q("licensing-save-error")!.textContent).not.toContain("422");
    expect(q("licensing-saved")).toBeNull();
  });

  it("names the path when the license directory is not writable", async () => {
    mockApi.saveLicense.mockRejectedValue(new ApiError("x", 409, { code: "license_path_unwritable" }));
    renderPanel();
    await ready();
    flushSync(() => setValue(q("licensing-license-input")!, "MYR1.a.b"));
    await vi.waitFor(() => expect((q("licensing-save") as HTMLButtonElement).disabled).toBe(false));
    q("licensing-save")!.click();
    await vi.waitFor(() => expect(q("licensing-save-error")?.textContent).toContain("/etc/myrmidon-license/license.key"));
  });

  it("does not offer saving when MYR_LICENSE overrides the file", async () => {
    mockApi.status.mockResolvedValue({ ...LICENSED, license: { ...LICENSED.license, source: "env", envOverride: true } });
    renderPanel();
    await ready();
    expect(q("licensing-env-override")).not.toBeNull();
    expect(q("licensing-save")).toBeNull();
  });
});
