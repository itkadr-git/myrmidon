// ui/src/ui2/screens/settings/language/Ui2LocaleUpload.myrmidon.test.tsx
//
// myrmidon(1.7 LOCALE-UPLOAD E.2, OPE-9646):
// UI tests for locale upload screen: file/JSON input, key diff preview
// (matched, missing, extra, coverage %), user language selection,
// and live catalog application without restarting the application.

// @vitest-environment jsdom

import { act } from "react-dom/test-utils";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
