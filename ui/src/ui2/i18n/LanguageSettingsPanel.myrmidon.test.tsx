// @vitest-environment jsdom
// myrmidon(UI2-I18N): Behavior tests for LanguageSettingsPanel upload flow:
// file selection, JSON validation, preview display, error handling and apply.

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Ui2LanguageProvider } from "./index";
import { LanguageSettingsPanel } from "./LanguageSettingsPanel";
import { en } from "./catalogs/en";
import { ru } from "./catalogs/ru";

const putCatalogMock = vi.fn().mockResolvedValue({ success: true });
const getMock = vi.fn().mockResolvedValue({ language: "en", catalogs: {}, updatedAt: null });
const putMock = vi.fn().mockResolvedValue({ language: "en", updatedAt: null });

vi.mock("./api", () => ({
  ui2LanguageApi: {
    get: () => getMock(),
    put: (lang: string) => putMock(lang),
    putCatalog: (locale: string, catalog: Record<string, unknown>) => putCatalogMock(locale, catalog),
  },
  bridgeLanguageApi: {
    get: vi.fn().mockResolvedValue({ language: "en", stored: "en", source: "instance" }),
    patch: vi.fn().mockResolvedValue({ language: "en" }),
  },
}));

vi.mock("@/api/client", () => ({
  api: {
    get: () => getMock(),
    put: () => putMock(),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("LanguageSettingsPanel: Catalog Upload Behavior", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  let queryClient: QueryClient;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, gcTime: 0 },
      },
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
  });

  async function renderPanel() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2LanguageProvider>
            <LanguageSettingsPanel />
          </Ui2LanguageProvider>
        </QueryClientProvider>,
      );
    });
    await flushReact();
  }

  it("renders upload section with file input and locale selector", async () => {
    await renderPanel();
    const uploadSection = container.querySelector('[data-testid="ui2-language-upload"]');
    expect(uploadSection).not.toBeNull();
    const fileInput = uploadSection?.querySelector('input[type="file"]');
    expect(fileInput).not.toBeNull();
    const applyButton = uploadSection?.querySelector("button");
    expect(applyButton?.disabled).toBe(true);
  });

  it("handles valid catalog upload, displays preview, and saves catalog", async () => {
    await renderPanel();
    const uploadSection = container.querySelector('[data-testid="ui2-language-upload"]');
    const fileInput = uploadSection?.querySelector('input[type="file"]') as HTMLInputElement;

    const validJson = JSON.stringify(ru);
    const file = new File([validJson], "ru-custom.json", { type: "application/json" });

    // Simulate file input change
    Object.defineProperty(fileInput, "files", {
      value: [file],
      writable: false,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();

    // Verify preview and validation counts are displayed
    const previewPre = uploadSection?.querySelector("pre");
    expect(previewPre).not.toBeNull();
    expect(previewPre?.textContent?.length).toBeGreaterThan(0);

    const applyButton = uploadSection?.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(applyButton.disabled).toBe(false);

    // Click apply button
    applyButton.click();
    await flushReact();

    expect(putCatalogMock).toHaveBeenCalledWith("ru", expect.objectContaining({ nav: expect.any(Object) }));
  });

  it("rejects incomplete catalog with missing keys and disables apply", async () => {
    await renderPanel();
    const uploadSection = container.querySelector('[data-testid="ui2-language-upload"]');
    const fileInput = uploadSection?.querySelector('input[type="file"]') as HTMLInputElement;

    const incompleteCatalog = { common: { save: "Сохранить" } };
    const file = new File([JSON.stringify(incompleteCatalog)], "incomplete.json", { type: "application/json" });

    Object.defineProperty(fileInput, "files", {
      value: [file],
      writable: false,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();

    const applyButton = uploadSection?.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);

    const alert = uploadSection?.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
  });

  it("rejects oversized file exceeding 256 KiB", async () => {
    await renderPanel();
    const uploadSection = container.querySelector('[data-testid="ui2-language-upload"]');
    const fileInput = uploadSection?.querySelector('input[type="file"]') as HTMLInputElement;

    const largeContent = "a".repeat(270 * 1024);
    const file = new File([largeContent], "huge.json", { type: "application/json" });

    Object.defineProperty(fileInput, "files", {
      value: [file],
      writable: false,
    });
    fileInput.dispatchEvent(new Event("change", { bubbles: true }));
    await flushReact();

    const applyButton = uploadSection?.querySelectorAll("button")[0] as HTMLButtonElement;
    expect(applyButton.disabled).toBe(true);
    expect(uploadSection?.textContent).toContain("256");
  });
});
