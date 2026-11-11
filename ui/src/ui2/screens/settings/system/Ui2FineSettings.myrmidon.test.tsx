// ui/src/ui2/screens/settings/system/Ui2FineSettings.myrmidon.test.tsx
//
// myrmidon(OPE-12046): guard for the SWEEP-2 "Fine settings" block on
// Settings → System. Every displayed variable must come from the
// behavior-settings API (value + source), the definitions call supplies the
// env name, and a 403 renders the denied lock.
// myrmidon(OPE-12611): SWEEP-2 write — an instance admin edits the value
// inline (boolean checkbox / number / text), "Save" sends exactly one PATCH
// with only the changed key, a server 400 shows the error in the row and
// keeps the previous value, json rows stay read-only, and a non-admin never
// sees inputs or buttons.
// myrmidon(OPE-12677): SETTINGS-HONESTY — the four keys without a code
// consumer (`debug_mode`, `max_concurrent_agents`, `default_timeout_seconds`,
// `autonomy_level`) are removed from FINE_SETTINGS_KEYS and must never render
// as rows or become editable, even though the API still resolves them.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FINE_SETTINGS_KEYS,
  Ui2FineSettings,
  buildFineSettingsRows,
  formatFineSettingValue,
} from "./Ui2FineSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const mockBehaviorApi = vi.hoisted(() => ({
  get: vi.fn(),
  getDefinitions: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/api/myrmidonBehaviorSettings", () => ({
  behaviorSettingsQueryKey: ["myrmidon", "behavior-settings"] as const,
  behaviorSettingsApi: mockBehaviorApi,
  getBehaviorSettings: () => mockBehaviorApi.get(),
  getBehaviorSettingsDefinitions: () => mockBehaviorApi.getDefinitions(),
}));

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

// myrmidon(OPE-12677): the mock keeps the real module (spread of actual) and
// only replaces the `api` object: the shell Ui2I18nProvider now loads the
// server language preference through `api.get` on mount (ui2 wave A part 2),
// so a partial mock without the `api` export crashes the provider and blanks
// the whole tree (CI on 8b0985bf19: "No \"api\" export is defined on the
// \"@/api/client\" mock"). The stub resolves null, so the provider stays
// localStorage-only and no request is made.
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(null),
      post: vi.fn().mockResolvedValue(null),
      patch: vi.fn().mockResolvedValue(null),
      delete: vi.fn().mockResolvedValue(null),
    },
  };
});

vi.mock("@/components/myrmidon/licensingApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/myrmidon/licensingApi")>();
  return {
    ...actual,
    useIsInstanceAdmin: () => mockAccessApi.getCurrentBoardAccess(),
  };
});

const mockGet = mockBehaviorApi.get;
const mockGetDefinitions = mockBehaviorApi.getDefinitions;
const mockUpdate = mockBehaviorApi.update;
const mockAccess = mockAccessApi.getCurrentBoardAccess;

/** Set the admin status for tests. */
function setAdmin(admin: boolean | null) {
  mockAccess.mockReturnValue(admin);
}

/** The resolved view the server answers with for the first wave.
 *  myrmidon(OPE-12677): the server still resolves every registered key (the
 *  registry is untouched) — the screen just no longer shows the four keys
 *  without a consumer (`debug_mode`, `max_concurrent_agents`,
 *  `default_timeout_seconds`, `autonomy_level`), which must not appear as
 *  editable rows even though the API answers with them. */
function apiView() {
  return {
    settings: {
      debug_mode: false,
      max_concurrent_agents: 5,
      default_timeout_seconds: 300,
      autonomy_level: "full",
      bot_egress_mode: "off",
      tool_breaker_failures: 3,
      tool_breaker_cooldown_ms: 60000,
      tool_breaker_window_ms: 600000,
      tool_timeout_max_ms: 180000,
      tool_timeout_slow_ms: 45000,
      bot_reconcile_interval_sec: 60,
      input_limit_precheck: true,
    },
    sources: {
      debug_mode: "default",
      max_concurrent_agents: "ui",
      default_timeout_seconds: "env",
      autonomy_level: "default",
      bot_egress_mode: "default",
      tool_breaker_failures: "ui",
      tool_breaker_cooldown_ms: "default",
      tool_breaker_window_ms: "default",
      tool_timeout_max_ms: "env",
      tool_timeout_slow_ms: "default",
      bot_reconcile_interval_sec: "default",
      input_limit_precheck: "default",
    },
  };
}

/** The four keys without a code consumer (OPE-12677): never rendered, never
 *  editable on the Fine settings screen. */
const UNWIRED_KEYS = [
  "debug_mode",
  "max_concurrent_agents",
  "default_timeout_seconds",
  "autonomy_level",
] as const;

function apiDefinitions() {
  const valueTypes: Record<string, string> = {
    debug_mode: "boolean",
    max_concurrent_agents: "number",
    default_timeout_seconds: "number",
    autonomy_level: "string",
    bot_egress_mode: "string",
    tool_breaker_failures: "number",
    tool_breaker_cooldown_ms: "number",
    tool_breaker_window_ms: "number",
    tool_timeout_max_ms: "number",
    tool_timeout_slow_ms: "number",
    bot_reconcile_interval_sec: "number",
    input_limit_precheck: "boolean",
  };
  return FINE_SETTINGS_KEYS.map((key) => ({
    key,
    envName: `MYRMIDON_${key.toUpperCase()}`,
    default: null,
    scope: "instance",
    section: "system",
    valueType: valueTypes[key] ?? "number",
  }));
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2FineSettings (SWEEP-2)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  async function renderBlock() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2FineSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockResolvedValue(apiView());
    mockGetDefinitions.mockResolvedValue(apiDefinitions());
    setAdmin(false);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("reads every displayed variable from the behavior-settings API and renders it", async () => {
    await renderBlock();

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGetDefinitions).toHaveBeenCalledTimes(1);

    const rows = container.querySelectorAll(".ui2-fine-row");
    expect(rows).toHaveLength(FINE_SETTINGS_KEYS.length);

    for (const key of FINE_SETTINGS_KEYS) {
      const row = container.querySelector(`[data-testid="ui2-fine-row-${key}"]`);
      expect(row, `row for ${key} must render`).not.toBeNull();
      const expected = String((apiView().settings as Record<string, unknown>)[key]);
      expect(row?.textContent).toContain(expected);
    }
  });

  it("never renders the four keys without a code consumer (OPE-12677)", async () => {
    // The API still resolves them — the screen must not show them.
    setAdmin(true);
    await renderBlock();

    expect(FINE_SETTINGS_KEYS.some((key) => (UNWIRED_KEYS as readonly string[]).includes(key))).toBe(
      false,
    );
    const rows = container.querySelectorAll(".ui2-fine-row");
    expect(rows).toHaveLength(FINE_SETTINGS_KEYS.length);
    for (const key of UNWIRED_KEYS) {
      const row = container.querySelector(`[data-testid="ui2-fine-row-${key}"]`);
      expect(row, `unwired key ${key} must not render as a row`).toBeNull();
      expect(
        container.querySelector(`input[aria-label="${key}"]`),
        `unwired key ${key} must not be editable`,
      ).toBeNull();
    }
    // The table shows only the eight wired keys.
    expect(container.textContent).not.toContain("autonomy_level");
  });

  it("shows where each value came from (saved / environment / default)", async () => {
    await renderBlock();

    const savedRow = container.querySelector('[data-testid="ui2-fine-row-tool_breaker_failures"]');
    expect(savedRow?.textContent).toContain("Saved");
    const envRow = container.querySelector('[data-testid="ui2-fine-row-tool_timeout_max_ms"]');
    expect(envRow?.textContent).toContain("Environment");
    const defaultRow = container.querySelector('[data-testid="ui2-fine-row-bot_egress_mode"]');
    expect(defaultRow?.textContent).toContain("Default");
  });

  it("renders the env variable name from the definitions API", async () => {
    await renderBlock();

    const envCell = container.querySelector(
      '[data-testid="ui2-fine-row-tool_timeout_max_ms"] .ui2-fine-envname',
    );
    expect(envCell?.textContent).toBe("MYRMIDON_TOOL_TIMEOUT_MAX_MS");
  });

  it("admin edits a boolean and Save sends one PATCH with only the changed key", async () => {
    setAdmin(true);
    mockUpdate.mockResolvedValue(apiView());
    await renderBlock();

    const checkbox = container.querySelector(
      '[data-testid="ui2-fine-row-input_limit_precheck"] input[type="checkbox"]',
    ) as HTMLInputElement | null;
    expect(checkbox).not.toBeNull();
    expect(checkbox!.checked).toBe(true);

    checkbox!.click();
    await flushReact();

    const button = container.querySelector(
      '[data-testid="ui2-fine-row-input_limit_precheck"] button',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    expect(button!.textContent).toBe("Save");
    button!.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ input_limit_precheck: false });
    expect(container.querySelector('[data-testid="ui2-fine-row-input_limit_precheck"] button')).toBeNull();
  });

  it("non-admin sees no inputs and no buttons", async () => {
    setAdmin(false);
    await renderBlock();

    expect(container.querySelector("input, textarea, select, button")).toBeNull();
    const row = container.querySelector('[data-testid="ui2-fine-row-input_limit_precheck"]');
    expect(row?.textContent).toContain("true");
  });

  it("unknown admin state (null) renders skeleton and no table content", async () => {
    setAdmin(null);
    await renderBlock();

    expect(container.querySelector("table")).toBeNull();
    expect(container.querySelector("input, textarea, select, button")).toBeNull();
  });

  it("a 400 answer shows the error in the row and keeps the previous value", async () => {
    setAdmin(true);
    mockUpdate.mockRejectedValue(new Error("Invalid value for setting 'tool_breaker_failures'"));
    await renderBlock();

    const numberInput = container.querySelector(
      '[data-testid="ui2-fine-row-tool_breaker_failures"] input[type="number"]',
    ) as HTMLInputElement | null;
    expect(numberInput).not.toBeNull();
    expect(numberInput!.value).toBe("3");

    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setValue.call(numberInput!, "0");
    numberInput!.dispatchEvent(new Event("input", { bubbles: true }));
    await flushReact();

    const button = container.querySelector(
      '[data-testid="ui2-fine-row-tool_breaker_failures"] button',
    ) as HTMLButtonElement | null;
    expect(button).not.toBeNull();
    button!.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ tool_breaker_failures: 0 });

    const row = container.querySelector('[data-testid="ui2-fine-row-tool_breaker_failures"]');
    expect(row?.querySelector('[role="alert"]')?.textContent).toContain(
      "Invalid value for setting 'tool_breaker_failures'",
    );
    // The previous value is kept on screen (3).
    const rowInput = row?.querySelector('input[type="number"]') as HTMLInputElement | null;
    expect(rowInput?.value).toBe("3");
    const sources = container.querySelector('[data-testid="ui2-fine-row-tool_breaker_failures"] .ui2-fine-src');
    expect(sources?.textContent).toContain("Saved");
  });

  it("a json-typed row stays read-only even for the admin", async () => {
    setAdmin(true);
    const definitions = apiDefinitions().map((definition) =>
      definition.key === "bot_egress_mode" ? { ...definition, valueType: "json" } : definition,
    );
    mockGetDefinitions.mockResolvedValue(definitions);
    await renderBlock();

    const row = container.querySelector('[data-testid="ui2-fine-row-bot_egress_mode"]');
    expect(row?.querySelector("input, button")).toBeNull();
    expect(row?.textContent).toContain("off");
    // Other rows stay editable.
    expect(
      container.querySelector('[data-testid="ui2-fine-row-input_limit_precheck"] input[type="checkbox"]'),
    ).not.toBeNull();
  });

  it("renders the denied lock on a 403", async () => {
    mockGet.mockRejectedValue(Object.assign(new Error("forbidden"), { status: 403 }));
    await renderBlock();

    expect(container.querySelector('[data-testid="ui2-denied-state"]')).not.toBeNull();
    expect(container.querySelector(".ui2-fine-row")).toBeNull();
  });

  it("never renders Page not found or an error boundary on the success path", async () => {
    await renderBlock();

    const text = container.textContent ?? "";
    expect(text).not.toContain("Page not found");
    expect(text).not.toContain("Something went wrong");
  });

  it("buildFineSettingsRows skips keys the API did not resolve", () => {
    const rows = buildFineSettingsRows({
      settings: { input_limit_precheck: true },
      sources: { input_limit_precheck: "ui" },
      definitions: [{ key: "input_limit_precheck", envName: "MYRMIDON_INPUT_LIMIT_PRECHECK" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "input_limit_precheck",
      value: "true",
      source: "ui",
      envName: "MYRMIDON_INPUT_LIMIT_PRECHECK",
    });
  });

  it("formatFineSettingValue renders booleans, empty collections and null as display text", () => {
    expect(formatFineSettingValue(true)).toBe("true");
    expect(formatFineSettingValue(false)).toBe("false");
    expect(formatFineSettingValue(null)).toBe("—");
    expect(formatFineSettingValue("")).toBe("—");
    expect(formatFineSettingValue([])).toBe("—");
    expect(formatFineSettingValue({})).toBe("—");
    expect(formatFineSettingValue(["a", "b"])).toBe("a, b");
    expect(formatFineSettingValue({ model: 8000 })).toBe("model=8000");
  });
});
