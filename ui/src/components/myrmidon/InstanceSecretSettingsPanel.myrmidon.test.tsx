// @vitest-environment jsdom
// myrmidon(SETTINGS-UI E2.1): the UI path of a secret ref - set, swap, revoke - and the
// guarantee that no value is rendered or sent. The API module is mocked at the client seam.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InstanceSecretSettingsPanel } from "./InstanceSecretSettingsPanel";

const mockApi = vi.hoisted(() => ({ list: vi.fn(), setRef: vi.fn(), clearRef: vi.fn(), migrationPlan: vi.fn() }));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));

vi.mock("@/api/instanceSecretSettings", () => ({
  instanceSecretSettingsApi: mockApi,
  instanceSecretSettingsQueryKey: ["instance", "secret-settings"],
}));
vi.mock("@/api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("@/context/CompanyContext", () => ({
  useOptionalCompany: () => ({ selectedCompanyId: "company-1" }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
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
        <InstanceSecretSettingsPanel />
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
    { id: "s-3", name: "gone", status: "disabled" },
  ]);
});

afterEach(() => {
  flushSync(() => root?.unmount());
  queryClient.clear();
  container.remove();
  vi.clearAllMocks();
});

describe("InstanceSecretSettingsPanel", () => {
  it("renders nothing when no setting is registered or the list is refused", async () => {
    mockApi.list.mockResolvedValue({ settings: [] });
    render();
    await flush();
    expect(container.querySelector("[data-testid=instance-secret-settings-panel]")).toBeNull();

    flushSync(() => root?.unmount());
    mockApi.list.mockRejectedValue({ status: 403 });
    queryClient.clear();
    render();
    await flush();
    expect(container.querySelector("[data-testid=instance-secret-settings-panel]")).toBeNull();
  });

  it("uses the Russian description for registered settings", async () => {
    mockApi.list.mockResolvedValue({ settings: [{ ...unset, name: "bot.disk.dockergate_token", description: "Board-to-dockergate token for the physical bot disk" }] });
    render();
    await flush();
    expect(container.textContent).toContain("Токен доски для доступа к физическому диску бота через dockergate");
    expect(container.textContent).not.toContain("Board-to-dockergate token");
  });

  it("sets a ref chosen from active secrets only, sending the secret id and nothing else", async () => {
    mockApi.list.mockResolvedValue({ settings: [unset] });
    mockApi.setRef.mockResolvedValue(bound);
    render();
    await flush();

    const select = container.querySelector<HTMLSelectElement>(`[id="secret-setting-select-${NAME}"]`)!;
    expect([...select.options].map((option) => option.value)).toEqual(["", "s-1", "s-2"]);
    const save = container.querySelector<HTMLButtonElement>(`[data-testid="secret-setting-save-${NAME}"]`)!;
    expect(save.disabled).toBe(true);

    flushSync(() => {
      select.value = "s-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(save.disabled).toBe(false);
    flushSync(() => save.click());
    await flush();

    expect(mockApi.setRef).toHaveBeenCalledWith(NAME, "s-2");
  });

  it("renders a provider-specific setting from the API and saves only its secret id", async () => {
    const providerName = "tool-oauth.acme_cloud.client-secret";
    mockApi.list.mockResolvedValue({ settings: [{ ...unset, name: providerName }] });
    mockApi.setRef.mockResolvedValue({ ...unset, name: providerName, ref: { secretId: "s-2", secretName: "second", status: "active" }, effectiveSource: "secret_ref" });
    render();
    await flush();
    const select = container.querySelector<HTMLSelectElement>(`[id="secret-setting-select-${providerName}"]`)!;
    flushSync(() => {
      select.value = "s-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>(`[data-testid="secret-setting-save-${providerName}"]`)!.click());
    await flush();
    expect(mockApi.setRef).toHaveBeenCalledWith(providerName, "s-2");
    expect(container.textContent).not.toContain("provider-ref-value");
  });

  it("swaps a bound ref and revokes it", async () => {
    mockApi.list.mockResolvedValue({ settings: [bound] });
    mockApi.setRef.mockResolvedValue({ ...bound, ref: { secretId: "s-2", secretName: "second", status: "active" } });
    mockApi.clearRef.mockResolvedValue(unset);
    render();
    await flush();

    expect(container.querySelector(`[data-testid="secret-setting-source-${NAME}"]`)!.textContent).toContain("first");
    const select = container.querySelector<HTMLSelectElement>(`[id="secret-setting-select-${NAME}"]`)!;
    flushSync(() => {
      select.value = "s-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>(`[data-testid="secret-setting-save-${NAME}"]`)!.click());
    await flush();
    expect(mockApi.setRef).toHaveBeenCalledWith(NAME, "s-2");

    const clear = container.querySelector<HTMLButtonElement>(`[data-testid="secret-setting-clear-${NAME}"]`)!;
    expect(clear.disabled).toBe(false);
    flushSync(() => clear.click());
    await flush();
    expect(mockApi.clearRef).toHaveBeenCalledWith(NAME);
  });

  it("shows the migration dry run as a count and never a value", async () => {
    mockApi.list.mockResolvedValue({ settings: [unset] });
    mockApi.migrationPlan.mockResolvedValue({
      dryRun: true,
      rows: [{ name: NAME, envOverride: "TEST_ENV", outcome: "planned" }],
    });
    render();
    await flush();
    flushSync(() => container.querySelector<HTMLButtonElement>("[data-testid=secret-settings-plan]")!.click());
    await flush();
    expect(container.querySelector("[data-testid=secret-settings-plan-result]")).not.toBeNull();
    expect(mockApi.migrationPlan).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failed save without echoing a server message", async () => {
    mockApi.list.mockResolvedValue({ settings: [unset] });
    mockApi.setRef.mockRejectedValue(new Error("leaky-server-message-value"));
    render();
    await flush();
    const select = container.querySelector<HTMLSelectElement>(`[id="secret-setting-select-${NAME}"]`)!;
    flushSync(() => {
      select.value = "s-1";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    flushSync(() => container.querySelector<HTMLButtonElement>(`[data-testid="secret-setting-save-${NAME}"]`)!.click());
    await flush();
    expect(container.textContent).toContain("saveError");
    expect(container.textContent).not.toContain("leaky-server-message-value");
  });
});
