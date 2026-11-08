// ui/src/ui2/screens/settings/system/Ui2FineSettings.myrmidon.test.tsx
//
// myrmidon(OPE-12046): guard for the SWEEP-2 read-only "Fine settings"
// block on Settings → System. Every displayed variable must come from the
// behavior-settings API (value + source), the definitions call supplies the
// env name, nothing writes (no buttons/inputs), a 403 renders the denied
// lock, and the block never shows "Page not found".

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
}));

vi.mock("@/api/myrmidonBehaviorSettings", () => ({
  behaviorSettingsQueryKey: ["myrmidon", "behavior-settings"] as const,
  behaviorSettingsApi: mockBehaviorApi,
  getBehaviorSettings: () => mockBehaviorApi.get(),
  getBehaviorSettingsDefinitions: () => mockBehaviorApi.getDefinitions(),
}));

const mockGet = mockBehaviorApi.get;
const mockGetDefinitions = mockBehaviorApi.getDefinitions;

/** The resolved view the server answers with for the first wave. */
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
      tool_breaker_failures: "default",
      tool_breaker_cooldown_ms: "default",
      tool_breaker_window_ms: "default",
      tool_timeout_max_ms: "env",
      tool_timeout_slow_ms: "default",
      bot_reconcile_interval_sec: "default",
      input_limit_precheck: "default",
    },
  };
}

function apiDefinitions() {
  return FINE_SETTINGS_KEYS.map((key) => ({
    key,
    envName: `MYRMIDON_${key.toUpperCase()}`,
    default: null,
    scope: "instance",
    section: "system",
    valueType: "number",
  }));
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2FineSettings (SWEEP-2 read-only)", () => {
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

  it("shows where each value came from (saved / environment / default)", async () => {
    await renderBlock();

    const savedRow = container.querySelector('[data-testid="ui2-fine-row-max_concurrent_agents"]');
    expect(savedRow?.textContent).toContain("Saved");
    const envRow = container.querySelector('[data-testid="ui2-fine-row-default_timeout_seconds"]');
    expect(envRow?.textContent).toContain("Environment");
    const defaultRow = container.querySelector('[data-testid="ui2-fine-row-debug_mode"]');
    expect(defaultRow?.textContent).toContain("Default");
  });

  it("renders the env variable name from the definitions API", async () => {
    await renderBlock();

    const envCell = container.querySelector(
      '[data-testid="ui2-fine-row-tool_timeout_max_ms"] .ui2-fine-envname',
    );
    expect(envCell?.textContent).toBe("MYRMIDON_TOOL_TIMEOUT_MAX_MS");
  });

  it("is read-only: no inputs, no buttons", async () => {
    await renderBlock();

    expect(container.querySelector("input, textarea, select, button")).toBeNull();
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
      settings: { debug_mode: true },
      sources: { debug_mode: "ui" },
      definitions: [{ key: "debug_mode", envName: "MYRMIDON_DEBUG_MODE" }],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: "debug_mode",
      value: "true",
      source: "ui",
      envName: "MYRMIDON_DEBUG_MODE",
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
