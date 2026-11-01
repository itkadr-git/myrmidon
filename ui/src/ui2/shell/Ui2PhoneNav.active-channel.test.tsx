// @vitest-environment jsdom
//
// myrmidon(1.7-ACTIVE-CHANNEL): UI shell test for active-channel freshness in Ui2PhoneHeader and Ui2Rail.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Ui2PhoneHeader } from "./Ui2PhoneNav";
import { ownerActiveChannelQueryKey } from "../useOwnerActiveChannel";
import type { OwnerActiveChannelView } from "@myrmidon/shared";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to }: { children: unknown; to: string }) => <a href={to}>{children as never}</a>,
  useLocation: () => ({ pathname: "/" }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => {
      const dict: Record<string, string> = {
        "ui2.shell.activeChannel.web": "Active · Web",
        "ui2.shell.activeChannel.telegram": "Active · Telegram",
        "ui2.shell.activeChannel.none": "Active · not seen recently",
        "time.justNow": "just now",
      };
      return dict[key] ?? opts?.defaultValue ?? key;
    },
    i18n: { language: "en" },
  }),
}));

vi.mock("@/components/myrmidon/MyrmidonLockup", () => ({
  MyrmidonLockup: () => <span>Brand</span>,
}));

vi.mock("./Ui2AccountMenu", () => ({
  Ui2AccountMenu: () => <div data-testid="ui2-account-menu-stub" />,
}));

vi.mock("../i18n/LanguageSwitch", () => ({
  LanguageSwitch: () => <div className="ui2-language-switch" />,
}));

vi.mock("../i18n/Ui2I18n", () => ({
  useUi2I18n: () => ({ t: (k: string) => k, locale: "en", setLocale: () => {} }),
  useUi2I18nOptional: () => ({ t: (k: string) => k, locale: "en", setLocale: () => {} }),
  Ui2I18nProvider: ({ children }: { children: unknown }) => children,
}));

describe("Ui2PhoneHeader active channel integration", () => {
  it("renders active channel and relative freshness from QueryClient data", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const mockData: OwnerActiveChannelView = {
      channel: "web",
      lastActiveAt: { web: fiveMinutesAgo, telegram: null },
      thresholdMin: 120,
      thresholdSource: "default",
    };

    queryClient.setQueryData(ownerActiveChannelQueryKey, mockData);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Ui2PhoneHeader />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-testid="ui2-phone-owner-active-channel"');
    expect(html).toContain("Active · Web · 5 minutes ago");
  });

  it("renders not-seen-recently status when channel is null", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    const mockData: OwnerActiveChannelView = {
      channel: null,
      lastActiveAt: { web: null, telegram: null },
      thresholdMin: 120,
      thresholdSource: "default",
    };

    queryClient.setQueryData(ownerActiveChannelQueryKey, mockData);

    const html = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <Ui2PhoneHeader />
      </QueryClientProvider>,
    );

    expect(html).toContain('data-testid="ui2-phone-owner-active-channel"');
    expect(html).toContain("Active · not seen recently");
  });
});
