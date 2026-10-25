// @vitest-environment jsdom
// myrmidon(SETTINGS-UI E2.1): UI2 path of a secret ref - set and revoke through the shared hook.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2InstanceSecretSettings } from "./Ui2InstanceSecretSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const mockApi = vi.hoisted(() => ({ list: vi.fn(), setRef: vi.fn(), clearRef: vi.fn(), migrationPlan: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/instanceSecretSettings", () => ({
  instanceSecretSettingsApi: mockApi,
  instanceSecretSettingsQueryKey: ["instance", "secret-settings"],
}));
vi.mock("@/api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NAME = "test.connector.client_secret";
const unset = { name: NAME, description: "Test setting", envOverride: "TEST_ENV", envOverrideActive: false, consumers: ["c"], ref: null, effectiveSource: "unset" as const };
const bound = { ...unset, ref: { secretId: "s-1", secretName: "first", status: "active" }, effectiveSource: "secret_ref" as const };

let container: HTMLDivElement;
let root: Root | null;
let queryClient: QueryClient;

async function flush() {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

function render() {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Ui2I18nProvider>
          <Ui2InstanceSecretSettings />
        </Ui2I18nProvider>
      </QueryClientProvider>,
    );
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = null;
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  mockSecretsApi.list.mockResolvedValue([
    { id: "s-1", name: "first", status: "active" },
    { id: "s-2", name: "second", status: "active" },
  ]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("Ui2InstanceSecretSettings", () => {
  it("renders nothing for an empty registry", async () => {
    mockApi.list.mockResolvedValue({ settings: [] });
    render();
    await flush();
    expect(container.querySelector(".ui2-section")).toBeNull();
  });

  it("sets a ref by secret id, then revokes it", async () => {
    mockApi.list.mockResolvedValue({ settings: [unset] });
    mockApi.setRef.mockResolvedValue(bound);
    mockApi.clearRef.mockResolvedValue(unset);
    render();
    await flush();

    const select = container.querySelector<HTMLSelectElement>(`[data-testid="ui2-secret-setting-select-${NAME}"]`)!;
    flushSync(() => {
      select.value = "s-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>(`[data-testid="ui2-secret-setting-save-${NAME}"]`)!.click());
    await flush();
    expect(mockApi.setRef).toHaveBeenCalledWith(NAME, "s-1");

    mockApi.list.mockResolvedValue({ settings: [bound] });
    await queryClient.invalidateQueries({ queryKey: ["instance", "secret-settings"] });
    await flush();
    const clear = container.querySelector<HTMLButtonElement>(`[data-testid="ui2-secret-setting-clear-${NAME}"]`)!;
    expect(clear.disabled).toBe(false);
    flushSync(() => clear.click());
    await flush();
    expect(mockApi.clearRef).toHaveBeenCalledWith(NAME);
  });

  it("shows a provider-specific tool OAuth setting and saves only its secret id", async () => {
    const providerName = "tool-oauth.acme_cloud.client-secret";
    mockApi.list.mockResolvedValue({ settings: [{ ...unset, name: providerName }] });
    mockApi.setRef.mockResolvedValue({ ...unset, name: providerName, ref: { secretId: "s-2", secretName: "second", status: "active" }, effectiveSource: "secret_ref" as const });
    render();
    await flush();
    expect(container.textContent).toContain("acme cloud");
    const select = container.querySelector<HTMLSelectElement>(`[data-testid="ui2-secret-setting-select-${providerName}"]`)!;
    flushSync(() => {
      select.value = "s-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>(`[data-testid="ui2-secret-setting-save-${providerName}"]`)!.click());
    await flush();
    expect(mockApi.setRef).toHaveBeenCalledWith(providerName, "s-2");
  });
});
