// @vitest-environment jsdom
// myrmidon(SETTINGS-UI E2.1): UI2 path of a secret ref - set and revoke through the shared hook.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2InstanceSecretSettings } from "./Ui2InstanceSecretSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { ui2Messages, type Ui2Locale, type Ui2MessageKey } from "../../../i18n/locales";

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

const STATIC_SETTING_NAMES = [
  "bot.disk.dockergate_token",
  "bot.egress.proxy_token",
  "browser_console.node_token",
  "cloud-oauth.google-drive.client-secret",
  "cloud-oauth.onedrive.client-secret",
  "cloud-oauth.yandex-disk.client-secret",
  "feedback_export.backend_token",
  "provider.openai.model_discovery_api_key",
  "runner.acpx_codex_auth_json",
  "sandbox.daytona.api_key",
  "sandbox.e2b.api_key",
  "sandbox.exe-dev.api_key",
  "sandbox.novita.api_key",
  "stack.github_token",
  "tool-oauth.client-secret",
  "tracing.clickhouse_password",
] as const;

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

function render(initialLocale: Ui2Locale = "ru") {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Ui2I18nProvider initialLocale={initialLocale}>
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

  it("uses the Russian description rather than the server's English fallback", async () => {
    mockApi.list.mockResolvedValue({ settings: [{ ...unset, name: "bot.disk.dockergate_token", description: "Board-to-dockergate token for the physical bot disk" }] });
    render("ru");
    await flush();
    expect(container.textContent).toContain("Токен доски для доступа к физическому диску бота через dockergate");
    expect(container.textContent).not.toContain("Board-to-dockergate token");
  });

  it("translates every registered setting in the registry and dynamic tool-oauth family without falling back to English", async () => {
    const settings = [
      ...STATIC_SETTING_NAMES.map((name) => ({ ...unset, name, description: `English description for ${name}` })),
      { ...unset, name: "tool-oauth.custom_tool.client-secret", description: "English description for custom tool" },
    ];
    mockApi.list.mockResolvedValue({ settings });
    render("ru");
    await flush();

    expect(container.textContent).not.toContain("English description for");
    for (const name of STATIC_SETTING_NAMES) {
      const normalizedKey = name.replace(/[.-]/g, "_");
      const key = `ui2.settings.system.secretRefs.settingDescriptions.${normalizedKey}` as Ui2MessageKey;
      const ruDesc = ui2Messages.ru[key];
      expect(ruDesc).toBeDefined();
      expect(container.textContent).toContain(ruDesc);
    }
    expect(container.textContent).toContain("Секрет клиента OAuth для custom tool");
  });

  it("falls back to server English description for unknown setting names", async () => {
    mockApi.list.mockResolvedValue({
      settings: [{ ...unset, name: "unknown.future.setting", description: "Future server setting description" }],
    });
    render("ru");
    await flush();
    expect(container.textContent).toContain("Future server setting description");
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
