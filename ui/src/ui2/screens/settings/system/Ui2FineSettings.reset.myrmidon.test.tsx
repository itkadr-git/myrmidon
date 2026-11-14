// ui/src/ui2/screens/settings/system/Ui2FineSettings.reset.myrmidon.test.tsx
//
// myrmidon(OPE-12695): the "Reset to env/default" action on a fine-settings
// row whose source is "ui". The confirmed reset sends exactly one PATCH with
// `{ "<key>": null }` (never the default value — sending the default would
// keep the source "ui" and silently disable the env override), the row then
// renders the value and source from the server answer, the confirm step is a
// two-button inline state (no window.confirm), Cancel disarms without a
// request, a failed PATCH shows role="alert" in the row and re-enables the
// button, and rows with source env/default plus non-admins get no buttons.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FINE_SETTINGS_KEYS, Ui2FineSettings } from "./Ui2FineSettings";
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

// myrmidon(OPE-12677): keep the real module and replace only `api` — the
// Ui2I18nProvider loads the shell language through `api.get` on mount and a
// partial mock without the export blanks the tree (see
// Ui2FineSettings.myrmidon.test.tsx, PR #2891).
vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return {
    ...actual,
    api: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(null),
    },
  };
});

const mockAccessApi = vi.hoisted(() => ({
  getCurrentBoardAccess: vi.fn(),
}));

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

function setAdmin(admin: boolean | null) {
  mockAccess.mockReturnValue(admin);
}

/** A resolved view with one saved ("ui") key and one env-driven key. */
function apiView() {
  return {
    settings: {
      bot_egress_mode: "proxy",
      tool_breaker_failures: 4,
      tool_breaker_cooldown_ms: 60000,
    },
    sources: {
      bot_egress_mode: "ui",
      tool_breaker_failures: "env",
      tool_breaker_cooldown_ms: "default",
    },
  };
}

/** The view the server answers after a reset of bot_egress_mode:
 * the key stays present with its resolved value, the source falls back. */
function resetView() {
  return {
    settings: {
      bot_egress_mode: "direct",
      tool_breaker_failures: 4,
      tool_breaker_cooldown_ms: 60000,
    },
    sources: {
      bot_egress_mode: "default",
      tool_breaker_failures: "env",
      tool_breaker_cooldown_ms: "default",
    },
  };
}

function apiDefinitions() {
  const valueTypes: Record<string, string> = {
    bot_egress_mode: "string",
    tool_breaker_failures: "number",
    tool_breaker_cooldown_ms: "number",
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

describe("myrmidon(UI2) Ui2FineSettings reset (OPE-12695)", () => {
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

  function row(key: string): HTMLElement | null {
    return container.querySelector(`[data-testid="ui2-fine-row-${key}"]`);
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mockGet.mockResolvedValue(apiView());
    mockGetDefinitions.mockResolvedValue(apiDefinitions());
    setAdmin(true);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("admin confirms a reset: one PATCH with null, then value and source come from the answer", async () => {
    mockUpdate.mockResolvedValue(resetView());
    await renderBlock();

    const reset = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    expect(reset).not.toBeNull();
    reset!.click();
    await flushReact();

    // Two-step confirm in the same row, no window.confirm.
    const confirm = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-confirm-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    expect(confirm).not.toBeNull();
    expect(confirm?.textContent).toBe("Confirm reset");
    expect(mockUpdate).not.toHaveBeenCalled();

    confirm!.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ bot_egress_mode: null });

    // The row renders the value and source of the server answer. The row is
    // editable (string valueType), so the answered value is shown in the
    // input, not as cell text.
    const shownInput = row("bot_egress_mode")?.querySelector(
      ".ui2-fine-val input",
    ) as HTMLInputElement | null;
    expect(shownInput).not.toBeNull();
    expect(shownInput!.value).toBe("direct");
    expect(row("bot_egress_mode")?.querySelector(".ui2-fine-src")?.textContent).toContain("Default");
    // The confirm step is gone after success, and the row no longer offers a
    // reset (the source fell back from "ui" to "default").
    expect(
      row("bot_egress_mode")?.querySelector('[data-testid="ui2-fine-reset-confirm-bot_egress_mode"]'),
    ).toBeNull();
  });

  it("cancel disarms the confirm without sending any request", async () => {
    await renderBlock();

    const reset = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    expect(reset).not.toBeNull();
    reset!.click();
    await flushReact();

    const cancel = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-cancel-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    expect(cancel).not.toBeNull();
    cancel!.click();
    await flushReact();

    expect(mockUpdate).not.toHaveBeenCalled();
    expect(
      row("bot_egress_mode")?.querySelector('[data-testid="ui2-fine-reset-confirm-bot_egress_mode"]'),
    ).toBeNull();
    // The reset button is offered again.
    expect(
      row("bot_egress_mode")?.querySelector('[data-testid="ui2-fine-reset-bot_egress_mode"]'),
    ).not.toBeNull();
  });

  it("a failed reset shows role=alert in the row and the button is available again", async () => {
    mockUpdate.mockRejectedValue(new Error("PATCH /myrmidon/behavior-settings failed"));
    await renderBlock();

    const reset = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    reset!.click();
    await flushReact();

    const confirm = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-confirm-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    confirm!.click();
    await flushReact();

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith({ bot_egress_mode: null });

    const alert = row("bot_egress_mode")?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("PATCH /myrmidon/behavior-settings failed");
    // The reset button is enabled and offered again.
    const again = row("bot_egress_mode")?.querySelector(
      '[data-testid="ui2-fine-reset-bot_egress_mode"]',
    ) as HTMLButtonElement | null;
    expect(again).not.toBeNull();
    expect(again!.disabled).toBe(false);
  });

  it("env and default rows never show a reset button", async () => {
    await renderBlock();

    expect(
      row("tool_breaker_failures")?.querySelector("button"),
    ).toBeNull();
    expect(
      row("tool_breaker_cooldown_ms")?.querySelector("button"),
    ).toBeNull();
    // The saved row keeps its reset button.
    expect(
      row("bot_egress_mode")?.querySelector('[data-testid="ui2-fine-reset-bot_egress_mode"]'),
    ).not.toBeNull();
  });

  it("a non-admin sees no reset buttons anywhere", async () => {
    setAdmin(false);
    await renderBlock();

    expect(container.querySelector("input, textarea, select, button")).toBeNull();
    expect(container.querySelectorAll('[data-testid^="ui2-fine-reset"]').length).toBe(0);
  });
});
