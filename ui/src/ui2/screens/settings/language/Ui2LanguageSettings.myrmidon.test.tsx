// ui/src/ui2/screens/settings/language/Ui2LanguageSettings.myrmidon.test.tsx
//
// myrmidon(UI2): screen guard for Settings → Language. The screen embeds
// the shared language-switch module at the agreed import path `ui2/i18n/LanguageSwitch`
// (local implementation until that part merges — the import-path contract
// is exactly what this guard pins: renaming the module or path fails here).
// The catalog switches language as a whole; the preview re-renders in RU.

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { Ui2LanguageSettings } from "./Ui2LanguageSettings";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { formatUi2Message } from "../../../i18n/locales";

vi.mock("../../../i18n/locale-validation", () => ({
  assertValidLocaleMessages: vi.fn(),
  validateLocaleMessages: vi.fn(() => []),
}));
vi.mock("@/i18n/locale-validation", () => ({
  assertValidLocaleMessages: vi.fn(),
  validateLocaleMessages: vi.fn(() => []),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("myrmidon(UI2) Ui2LanguageSettings screen parity", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      censorUsernameInLogs: false,
      keyboardShortcuts: true,
      feedbackDataSharingPreference: "full",
      backupRetention: "30d",
      timeZone: "Asia/Irkutsk",
      numberFormat: "en-US",
      dateFormat: "ymd",
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    flushSync(() => root?.unmount());
    root = null;
    queryClient.clear();
    container.remove();
    window.localStorage.clear();
    await flushReact();
  });

  it("embeds the LanguageSwitch module at the agreed ui2/i18n path", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    // The switch renders the two locale self-names as radio options.
    const options = [...container.querySelectorAll(".ui2-language-switch-option")];
    expect(options.length).toBe(2);
    expect(options[0]?.textContent).toContain("English");
    expect(options[1]?.textContent).toContain("Русский");
  });

  it("switches the whole catalog to RU and back to EN", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2LanguageSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();

    const ruOption = [...container.querySelectorAll<HTMLButtonElement>(".ui2-language-switch-option")].find(
      (button) => button.textContent?.includes("Русский"),
    );
    ruOption?.click();
    await flushReact();
    await vi.waitFor(() => expect(i18n.language).toBe("ru"));

    expect(window.localStorage.getItem("myrmidon.ui2.locale")).toBe("ru");
    expect(window.localStorage.getItem("myrmidon:ui-language")).toBe("ru");
    // The preview card re-rendered in Russian.
    expect(container.textContent).toContain("Поднять мягкий лимит на день");

    const enOption = [...container.querySelectorAll<HTMLButtonElement>(".ui2-language-switch-option")].find(
      (button) => button.textContent?.includes("English"),
    );
    enOption?.click();
    await flushReact();
    await vi.waitFor(() => expect(i18n.language).toBe("en"));
    expect(container.textContent).toContain("Raise the soft limit for the day");
  });

  it("shows the timezone and format controls with a live preview", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<QueryClientProvider client={queryClient}><Ui2I18nProvider initialLocale="en"><Ui2LanguageSettings /></Ui2I18nProvider></QueryClientProvider>));
    await flushReact();
    // The language screen is one of the legacy UI2 surfaces whose catalog is
    // still sourced from the shared application i18n catalog.
    expect(container.textContent).toContain("Time zone and formats");
    expect(container.textContent).toContain("1,234.56 · 2026-10-31 09:00");
    const selects = container.querySelectorAll("select");
    (selects[1] as HTMLSelectElement).value = "ru-RU";
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    expect(container.textContent).toContain("1 234,56 · 2026-10-31 09:00");

    // Changing timezone updates the live preview date/time according to the selected zone
    (selects[0] as HTMLSelectElement).value = "Europe/Moscow";
    selects[0].dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    expect(container.textContent).toContain("1 234,56 · 2026-10-31 04:00");

    // Changing date format updates the date pattern in the preview
    (selects[2] as HTMLSelectElement).value = "dmy";
    selects[2].dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    expect(container.textContent).toContain("1 234,56 · 31.10.2026 04:00");
  });

  it("patches only changed format fields", async () => {
    const fetchMock = vi.mocked(fetch);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => root!.render(<QueryClientProvider client={queryClient}><Ui2I18nProvider initialLocale="en"><Ui2LanguageSettings /></Ui2I18nProvider></QueryClientProvider>));
    await flushReact();
    const selects = container.querySelectorAll("select");
    (selects[1] as HTMLSelectElement).value = "ru-RU";
    selects[1].dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();
    [...container.querySelectorAll("button")].find((button) => button.textContent === "Save")?.click();
    await flushReact();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
    expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ numberFormat: "ru-RU" });
  });

  it("formats the preview metadata through the same helper the screens use", () => {
    expect(formatUi2Message("Prepared by {{agent}}", { agent: "agent-a" })).toBe("Prepared by agent-a");
    expect(formatUi2Message("Ждёт {{age}}", { age: "2h" })).toBe("Ждёт 2h");
  });
});
