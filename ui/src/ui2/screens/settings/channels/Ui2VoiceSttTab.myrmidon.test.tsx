// @vitest-environment jsdom
// myrmidon(UI2-CHANNELS): Tests for Ui2VoiceSttTab (OPE-10136).
// Verifies reading settings, PATCH saving, error handling without white screen,
// and secret values safety.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2VoiceSttTab } from "./Ui2VoiceSttTab";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";
import { type VoiceSttSettings } from "@/components/myrmidon/voice-stt/voiceSttApi";
import { ApiError } from "@/api/client";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const apiMock = vi.hoisted(() => ({
  view: vi.fn(),
  update: vi.fn(),
}));

vi.mock("@/components/myrmidon/voice-stt/voiceSttApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/myrmidon/voice-stt/voiceSttApi")>()),
  voiceSttApi: apiMock,
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

const COMPANY_ID = "company-1";

function record(overrides: Partial<VoiceSttSettings> = {}): VoiceSttSettings {
  return {
    enabled: false,
    backend: "dashscope",
    model: null,
    language: "auto",
    diarization: false,
    maxDurationSec: 600,
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let queryClient: QueryClient;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  apiMock.view.mockReset().mockResolvedValue(record());
  apiMock.update.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
  queryClient.clear();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  flushSync(() => {});
}

async function renderTab(): Promise<void> {
  root = createRoot(container);
  flushSync(() => {
    root!.render(
      <QueryClientProvider client={queryClient}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2VoiceSttTab />
        </Ui2I18nProvider>
      </QueryClientProvider>,
    );
  });
  await settle();
}

function inputByTestId(id: string): HTMLInputElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLInputElement;
}

function selectByTestId(id: string): HTMLSelectElement {
  return container.querySelector(`[data-testid="${id}"]`) as HTMLSelectElement;
}

async function typeInto(input: HTMLInputElement, text: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function selectOption(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Ui2VoiceSttTab (OPE-10136)", () => {
  it("loads settings via GET and renders initial form values", async () => {
    apiMock.view.mockResolvedValue(
      record({
        enabled: true,
        backend: "deepgram",
        language: "ru",
        model: "nova-2",
        diarization: true,
        maxDurationSec: 1200,
      }),
    );

    await renderTab();

    expect(apiMock.view).toHaveBeenCalledWith(COMPANY_ID);
    expect(inputByTestId("ui2-voice-stt-enabled").checked).toBe(true);
    expect(selectByTestId("ui2-voice-stt-backend").value).toBe("deepgram");
    expect(selectByTestId("ui2-voice-stt-language").value).toBe("ru");
    expect(inputByTestId("ui2-voice-stt-model").value).toBe("nova-2");
    expect(inputByTestId("ui2-voice-stt-diarization").checked).toBe(true);
    expect(inputByTestId("ui2-voice-stt-max-duration").value).toBe("1200");
  });

  it("PATCHes only modified fields on save", async () => {
    apiMock.view.mockResolvedValue(record({ language: "auto" }));
    await renderTab();

    const saveBtn = container.querySelector<HTMLButtonElement>(
      '[data-testid="ui2-voice-stt-save"]',
    );
    expect(saveBtn?.disabled).toBe(true);

    await selectOption(selectByTestId("ui2-voice-stt-language"), "ru");
    expect(saveBtn?.disabled).toBe(false);

    apiMock.update.mockResolvedValue(record({ language: "ru" }));
    await click('[data-testid="ui2-voice-stt-save"]');
    await settle();

    expect(apiMock.update).toHaveBeenCalledWith(COMPANY_ID, { language: "ru" });
  });

  it("handles model and maxDuration edits with trimming and integer parsing", async () => {
    await renderTab();

    await typeInto(inputByTestId("ui2-voice-stt-model"), " custom-model ");
    await typeInto(inputByTestId("ui2-voice-stt-max-duration"), "900");

    apiMock.update.mockResolvedValue(record({ model: "custom-model", maxDurationSec: 900 }));
    await click('[data-testid="ui2-voice-stt-save"]');
    await settle();

    expect(apiMock.update).toHaveBeenCalledWith(COMPANY_ID, {
      model: "custom-model",
      maxDurationSec: 900,
    });
  });

  it("surfaces API save error without white screen", async () => {
    await renderTab();

    apiMock.update.mockRejectedValue(
      new ApiError("Invalid STT settings: maxDurationSec must be >= 1", 422, {
        error: "invalid_settings",
      }),
    );

    await click('[data-testid="ui2-voice-stt-enabled"]');
    await click('[data-testid="ui2-voice-stt-save"]');
    await settle();

    const errorEl = container.querySelector('[data-testid="ui2-voice-stt-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("maxDurationSec must be >= 1");
    // Form is still visible, no white screen crash
    expect(container.querySelector('[data-testid="ui2-voice-stt-tab"]')).not.toBeNull();
  });

  it("surfaces GET load error with retry button without crashing", async () => {
    apiMock.view.mockRejectedValue(new Error("Network connection error"));

    await renderTab();

    const errorState = container.querySelector('[data-testid="ui2-voice-stt-load-error"]');
    expect(errorState).not.toBeNull();
    expect(errorState?.textContent).toContain("Network connection error");

    // Click retry
    apiMock.view.mockResolvedValue(record());
    await click(".ui2-error-retry");
    await settle();

    expect(apiMock.view).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="ui2-voice-stt-tab"]')).not.toBeNull();
  });

  it("never renders secret-shaped values in DOM", async () => {
    await renderTab();

    expect(container.innerHTML).not.toContain("sk-");
    expect(container.innerHTML).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{10,}/);
    expect(container.innerHTML).not.toContain("api_key");
  });
});
