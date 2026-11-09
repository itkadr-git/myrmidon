// ui/src/ui2/screens/settings/language/Ui2LocaleUpload.myrmidon.test.tsx
//
// myrmidon(1.7 LOCALE-UPLOAD E.2, OPE-9646):
// UI tests for locale upload screen: file/JSON input, key diff preview
// (matched, missing, extra, coverage %), user language selection,
// and live catalog application without restarting the application.

// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Ui2LanguageSettings } from "./Ui2LanguageSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

async function flushReact() {
  await act(async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    }
  });
}

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = input instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
}

describe("myrmidon(UI2) Ui2LocaleUpload screen (OPE-9646)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
  });

  it("renders upload section with locale code input, file input, and JSON area", async () => {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(container.querySelector('[data-testid="ui2-locale-upload"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="target-locale-input"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locale-file-input"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="locale-json-input"]')).not.toBeNull();
  });

  it("displays key diff preview with matched, missing, extra counts and before/after values", async () => {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const localeInput = container.querySelector<HTMLInputElement>(
      '[data-testid="target-locale-input"]',
    )!;
    const jsonInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="locale-json-input"]',
    )!;

    const sampleCatalog = JSON.stringify(
      {
        "ui2.settings.language.title": "Sprache",
        "ui2.settings.language.subtitle": "Benutzeroberfläche",
        "custom.extra.key": "Zusätzlicher Text",
      },
      null,
      2,
    );

    // Simulate entering target locale and JSON catalog content
    await act(async () => {
      setInputValue(localeInput, "de");
      localeInput.dispatchEvent(new Event("input", { bubbles: true }));
      localeInput.dispatchEvent(new Event("change", { bubbles: true }));

      setInputValue(jsonInput, sampleCatalog);
      jsonInput.dispatchEvent(new Event("input", { bubbles: true }));
      jsonInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const statusBadge = container.querySelector('[data-testid="validation-status"]');
    expect(statusBadge?.textContent).toContain("Valid");

    const matchedCount = container.querySelector('[data-testid="matched-keys-count"]');
    expect(matchedCount?.textContent).toBe("2");

    const extraCount = container.querySelector('[data-testid="extra-keys-count"]');
    expect(extraCount?.textContent).toBe("1");

    const diffTable = container.querySelector('[data-testid="diff-preview-table"]');
    expect(diffTable).not.toBeNull();
    expect(diffTable?.textContent).toContain("ui2.settings.language.title");
    expect(diffTable?.textContent).toContain("Language");
    expect(diffTable?.textContent).toContain("Sprache");
  });

  it("applies the uploaded catalog live without restart and updates user language", async () => {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const localeInput = container.querySelector<HTMLInputElement>(
      '[data-testid="target-locale-input"]',
    )!;
    const jsonInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="locale-json-input"]',
    )!;

    const sampleCatalog = JSON.stringify({
      "ui2.settings.language.title": "Sprache",
      "ui2.settings.language.subtitle": "Benutzeroberfläche Sprache",
    });

    await act(async () => {
      setInputValue(localeInput, "de");
      localeInput.dispatchEvent(new Event("change", { bubbles: true }));

      setInputValue(jsonInput, sampleCatalog);
      jsonInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const applyButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="apply-locale-button"]',
    );
    expect(applyButton).not.toBeNull();
    expect(applyButton?.disabled).toBe(false);

    // Apply the catalog
    await act(async () => {
      applyButton?.click();
    });

    // Verify success banner is shown
    const successBanner = container.querySelector('[data-testid="upload-success-message"]');
    expect(successBanner).not.toBeNull();
    expect(successBanner?.textContent).toContain("de");

    // Verify localStorage and root attribute are updated
    expect(window.localStorage.getItem("myrmidon.ui2.locale")).toBe("de");

    // Verify the page title immediately reflects the newly applied German catalog
    // without page reload!
    expect(container.textContent).toContain("Sprache");

    // Verify the switch renders DE option
    const deSwitchButton = [...container.querySelectorAll<HTMLButtonElement>(
      ".ui2-language-switch-option",
    )].find((button) => button.textContent?.includes("DE"));
    expect(deSwitchButton).toBeDefined();

    // Switch back to English, then back to DE
    const enSwitchButton = [...container.querySelectorAll<HTMLButtonElement>(
      ".ui2-language-switch-option",
    )].find((button) => button.textContent?.includes("English"));
    await act(async () => {
      enSwitchButton?.click();
    });
    await flushReact();
    expect(container.textContent).toContain("Language");

    await act(async () => {
      deSwitchButton?.click();
    });
    await flushReact();
    expect(container.textContent).toContain("Sprache");
  });

  it("handles invalid JSON safely by displaying validation error and disabling apply", async () => {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const jsonInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="locale-json-input"]',
    )!;

    await act(async () => {
      setInputValue(jsonInput, "{ invalid json syntax: 123 ");
      jsonInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const statusBadge = container.querySelector('[data-testid="validation-status"]');
    expect(statusBadge?.textContent).toContain("Invalid");

    const errorBlock = container.querySelector('[data-testid="validation-errors"]');
    expect(errorBlock).not.toBeNull();

    const applyButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="apply-locale-button"]',
    );
    expect(applyButton?.disabled).toBe(true);
  });
});
describe("myrmidon(UI2) Ui2LocaleUpload versions + activation (OPE-12118)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let fetchMock: ReturnType<typeof vi.fn>;

  const deCatalog = {
    "ui2.settings.language.title": "Sprache",
    "ui2.settings.language.subtitle": "Einstellungen",
  };
  // "tt" is a custom (non-built-in) locale so applyCustomCatalog creates a
  // fresh dictionary instead of mutating the real built-in ru catalog.
  const ttCatalog = {
    "ui2.settings.language.title": "Тел",
    "ui2.settings.language.subtitle": "Төп күчмәләр",
  };

  const versionsPayload = {
    locales: [
      {
        locale: "de",
        version: 1,
        uploadedAt: "2026-11-08T10:00:00.000Z",
        uploadedBy: null,
        keyCount: 2,
        checksum: "checksum-de-v1",
      },
      {
        locale: "tt",
        version: 3,
        uploadedAt: "2026-11-08T11:00:00.000Z",
        uploadedBy: null,
        keyCount: 2,
        checksum: "checksum-tt-v3",
      },
    ],
    total: 2,
    activeLocale: "de" as string | null,
  };

  function jsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }

  /** Minimal fetch router: /api/locale/* contract (OPE-12146-class, mocked),
   * plus the language/general-settings reads the screen makes on mount. */
  function installFetchRouter(options: { activateStatus?: number } = {}) {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = (init?.method ?? "GET").toUpperCase();

      if (url.endsWith("/api/locale/versions") && method === "GET") {
        return jsonResponse(versionsPayload);
      }
      if (url.endsWith("/api/locale/current") && method === "POST") {
        if (options.activateStatus && options.activateStatus !== 200) {
          return jsonResponse({ error: "ACTIVATION_FAILED" }, options.activateStatus);
        }
        const body = JSON.parse(String(init?.body ?? "{}")) as { locale?: string };
        const locale = body.locale === "tt" ? "tt" : "de";
        return jsonResponse({
          locale,
          version: locale === "tt" ? 3 : 1,
          checksum: locale === "tt" ? "checksum-tt-v3" : "checksum-de-v1",
          uploadedAt: "2026-11-08T11:00:00.000Z",
          catalog: locale === "tt" ? ttCatalog : deCatalog,
          keyCount: 2,
          active: true,
        });
      }
      if (url.endsWith("/api/locale/upload") && method === "POST") {
        return jsonResponse({
          stored: true,
          dryRun: false,
          locale: "de",
          version: 1,
          checksum: "checksum-de-v1",
          uploadedAt: "2026-11-08T10:00:00.000Z",
        });
      }
      if (url.endsWith("/api/myrmidon/ui2/language/me")) {
        return jsonResponse({ language: "en", updatedAt: null });
      }
      if (url.includes("/api/instance/settings")) {
        return jsonResponse({});
      }
      return jsonResponse({ error: "NOT_MOCKED" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
  }

  async function renderScreen() {
    await act(async () => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    installFetchRouter();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    window.localStorage.clear();
  });

  it("lists uploaded versions with the active one marked, from GET /api/locale/versions", async () => {
    await renderScreen();

    const versionsBlock = container.querySelector('[data-testid="locale-versions-block"]');
    expect(versionsBlock).not.toBeNull();

    const rows = container.querySelectorAll('[data-testid="locale-version-row"]');
    expect(rows.length).toBe(2);

    const activeBadges = container.querySelectorAll('[data-testid="locale-active-badge"]');
    expect(activeBadges.length).toBe(1);
    expect(rows[0]?.getAttribute("data-locale")).toBe("de");
    expect(rows[0]?.querySelector('[data-testid="locale-active-badge"]')).not.toBeNull();

    const activateDe = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-de"]',
    );
    expect(activateDe?.disabled).toBe(true);

    const activateTt = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-tt"]',
    );
    expect(activateTt?.disabled).toBe(false);
    expect(activateTt?.textContent).toContain("Make active");
  });

  it("activates a stored version: POST /api/locale/current applies the catalog live", async () => {
    await renderScreen();

    const activateTt = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-tt"]',
    )!;
    expect(activateTt).not.toBeNull();

    await act(async () => {
      activateTt.click();
    });
    await flushReact();

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/api/locale/current") &&
        String(init?.method ?? "GET").toUpperCase() === "POST",
    );
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ locale: "tt" });

    // The returned catalog is applied live without reload: title switches to the activated catalog.
    expect(container.textContent).toContain("Тел");
    expect(window.localStorage.getItem("myrmidon.ui2.locale")).toBe("tt");

    // The active badge moved to the tt row and its button is now disabled.
    const rows = container.querySelectorAll('[data-testid="locale-version-row"]');
    const ttRow = [...rows].find((row) => row.getAttribute("data-locale") === "tt");
    expect(ttRow?.querySelector('[data-testid="locale-active-badge"]')).not.toBeNull();
    const activateTtAfter = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-tt"]',
    );
    expect(activateTtAfter?.disabled).toBe(true);
  });

  it("shows an activation error when the server rejects activation", async () => {
    installFetchRouter({ activateStatus: 400 });
    await renderScreen();

    const activateTt = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-tt"]',
    )!;

    await act(async () => {
      activateTt.click();
    });
    await flushReact();

    const errorBlock = container.querySelector('[data-testid="locale-activation-error"]');
    expect(errorBlock).not.toBeNull();
    expect(errorBlock?.textContent).toContain("Activation failed");
    expect(errorBlock?.textContent).toContain("tt");

    // The active badge stays on de: the failed activation changed nothing.
    const rows = container.querySelectorAll('[data-testid="locale-version-row"]');
    const deRow = [...rows].find((row) => row.getAttribute("data-locale") === "de");
    expect(deRow?.querySelector('[data-testid="locale-active-badge"]')).not.toBeNull();
    const activateTtAfter = container.querySelector<HTMLButtonElement>(
      '[data-testid="activate-locale-button-tt"]',
    );
    expect(activateTtAfter?.disabled).toBe(false);
  });

  it("refreshes the versions list after a successful upload", async () => {
    await renderScreen();

    const localeInput = container.querySelector<HTMLInputElement>(
      '[data-testid="target-locale-input"]',
    )!;
    const jsonInput = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="locale-json-input"]',
    )!;

    await act(async () => {
      setInputValue(localeInput, "de");
      localeInput.dispatchEvent(new Event("change", { bubbles: true }));
      setInputValue(jsonInput, JSON.stringify(deCatalog));
      jsonInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await flushReact();

    const applyButton = container.querySelector<HTMLButtonElement>(
      '[data-testid="apply-locale-button"]',
    )!;
    expect(applyButton.disabled).toBe(false);

    await act(async () => {
      applyButton.click();
    });
    await flushReact();

    const upload = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith("/api/locale/upload") &&
        String(init?.method ?? "GET").toUpperCase() === "POST",
    );
    expect(upload).toBeDefined();
    expect(JSON.parse(String(upload?.[1]?.body)).locale).toBe("de");

    expect(container.querySelector('[data-testid="upload-success-message"]')).not.toBeNull();
    // GET /api/locale/versions was re-issued after the upload.
    const versionsGets = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/api/locale/versions") &&
        String(init?.method ?? "GET").toUpperCase() === "GET",
    );
    expect(versionsGets.length).toBeGreaterThanOrEqual(2);
  });
});
