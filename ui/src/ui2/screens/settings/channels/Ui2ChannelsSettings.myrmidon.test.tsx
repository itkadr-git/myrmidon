// @vitest-environment jsdom
// myrmidon(UI2-CHANNELS): Tests for Ui2ChannelsSettings (OPE-10136).
// Verifies tabbed shell extensibility, default voice tab, and active sidebar item.
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Ui2ChannelsSettings, type Ui2ChannelTab } from "./Ui2ChannelsSettings";
import { Ui2SettingsSidebar } from "../../../shell/Ui2SettingsSidebar";
import { UI2_ROUTE_TABLE } from "../../../routes";
import { Ui2I18nProvider } from "../../../i18n/Ui2I18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: "company-1" }),
}));

vi.mock("@/components/myrmidon/voice-stt/voiceSttApi", () => ({
  voiceSttApi: {
    view: vi.fn().mockResolvedValue({
      enabled: false,
      backend: "dashscope",
      model: null,
      language: "auto",
      diarization: false,
      maxDurationSec: 600,
    }),
    update: vi.fn(),
  },
  voiceSttQueryKey: (id: string) => ["voice-stt", id],
  VOICE_STT_BACKENDS: ["dashscope", "deepgram"],
  VOICE_STT_LANGUAGES: ["auto", "ru"],
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string) => {
      const dict: Record<string, string> = {
        "ui2.settings.navLabel": "Settings navigation",
        "ui2.settings.general": "General",
        "ui2.settings.members": "Members",
        "ui2.settings.access": "Access",
        "ui2.settings.secrets": "Secrets",
        "ui2.settings.runs": "Runs and queue",
        "ui2.settings.budgets": "Budgets",
        "ui2.settings.autonomy": "Autonomy",
        "ui2.settings.castes": "Castes and models",
        "ui2.settings.channels": "Channels",
        "ui2.settings.system": "System",
      };
      return dict[key] ?? key;
    },
  }),
}));

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

async function click(selector: string): Promise<void> {
  await act(async () => {
    container
      .querySelector(selector)
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("Ui2ChannelsSettings (OPE-10136)", () => {
  it("renders default Voice STT tab with active state and tabpanel", async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2ChannelsSettings />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    const tablist = container.querySelector('[role="tablist"]');
    expect(tablist).not.toBeNull();

    const voiceTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="ui2-channels-tab-voice"]',
    );
    expect(voiceTab).not.toBeNull();
    expect(voiceTab?.getAttribute("aria-selected")).toBe("true");

    const voicePanel = container.querySelector(
      '[data-testid="ui2-channels-panel-voice"]',
    );
    expect(voicePanel).not.toBeNull();
  });

  it("extensible tabs shell: accepts custom tab list and switches active tab on click", async () => {
    const customTabs: Ui2ChannelTab[] = [
      {
        id: "telegram",
        label: "Telegram",
        content: <div data-testid="custom-telegram-content">Telegram Content</div>,
      },
      {
        id: "voice",
        label: "Voice (STT)",
        content: <div data-testid="custom-voice-content">Voice Content</div>,
      },
      {
        id: "connectors",
        label: "Connectors",
        content: <div data-testid="custom-connectors-content">Connectors Content</div>,
      },
    ];

    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <QueryClientProvider client={queryClient}>
          <Ui2I18nProvider initialLocale="en">
            <Ui2ChannelsSettings tabs={customTabs} defaultTab="telegram" />
          </Ui2I18nProvider>
        </QueryClientProvider>,
      );
    });
    await settle();

    // Telegram is active
    expect(
      container.querySelector('[data-testid="ui2-channels-tab-telegram"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(container.querySelector('[data-testid="custom-telegram-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="custom-connectors-content"]')).toBeNull();

    // Click Connectors tab
    await click('[data-testid="ui2-channels-tab-connectors"]');
    await settle();

    expect(
      container.querySelector('[data-testid="ui2-channels-tab-connectors"]')?.getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="ui2-channels-tab-telegram"]')?.getAttribute("aria-selected"),
    ).toBe("false");
    expect(container.querySelector('[data-testid="custom-connectors-content"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="custom-telegram-content"]')).toBeNull();
  });

  it("highlights Channels as active section in Ui2SettingsSidebar when on /company/settings/channels", async () => {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <MemoryRouter initialEntries={["/company/settings/channels"]}>
          <Ui2SettingsSidebar />
        </MemoryRouter>,
      );
    });
    await settle();

    const links = Array.from(container.querySelectorAll("a"));
    const channelsLink = links.find((link) => link.getAttribute("href") === "/company/settings/channels");
    expect(channelsLink).toBeDefined();
    expect(channelsLink?.textContent).toBe("Channels");
    expect(channelsLink?.className).toContain("bg-[var(--myr-navy-deep)]");

    const systemLink = links.find((link) => link.getAttribute("href") === "/company/settings/system");
    expect(systemLink?.className).not.toContain("bg-[var(--myr-navy-deep)]");
  });

  it("exposes settings-channels route in UI2_ROUTE_TABLE", () => {
    const route = UI2_ROUTE_TABLE.find((r) => r.key === "settings-channels");
    expect(route).toBeDefined();
    expect(route?.path).toBe("company/settings/channels");
    expect(route?.titleKey).toBe("ui2.screens.channels");
    expect(route?.element).toBeTruthy();
  });
});
