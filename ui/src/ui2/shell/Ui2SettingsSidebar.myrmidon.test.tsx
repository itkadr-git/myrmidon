// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "@/lib/router";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { UI2_SETTINGS_SECTIONS, Ui2SettingsSidebar } from "./Ui2SettingsSidebar";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
});

function render(node: ReactNode) {
  flushSync(() => {
    root?.render(node);
  });
  return { container };
}

describe("Ui2SettingsSidebar", () => {
  it("renders all 11 settings sections without raw keys in English", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/OPE/company/settings"]}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();

    // Check all 11 sections are present
    expect(UI2_SETTINGS_SECTIONS).toHaveLength(11);
    for (const section of UI2_SETTINGS_SECTIONS) {
      const link = nav?.querySelector(`a[href$="${section.path}"]`);
      expect(link).not.toBeNull();
      const text = link?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      // Must not render raw key
      expect(text).not.toContain("ui2.settings.");
    }

    // Explicit checks for critical sections
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.some((a) => a.textContent?.includes("General"))).toBe(true);
    expect(links.some((a) => a.textContent?.includes("Language"))).toBe(true);
  });

  it("renders all 11 settings sections without raw keys in Russian", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/OPE/company/settings/language"]}>
        <Ui2I18nProvider initialLocale="ru">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();

    for (const section of UI2_SETTINGS_SECTIONS) {
      const link = nav?.querySelector(`a[href$="${section.path}"]`);
      expect(link).not.toBeNull();
      const text = link?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      // Must not render raw key
      expect(text).not.toContain("ui2.settings.");
    }

    // Explicit checks for Russian translations
    const links = Array.from(container.querySelectorAll("a"));
    expect(links.some((a) => a.textContent?.includes("Общие"))).toBe(true);
    expect(links.some((a) => a.textContent?.includes("Язык"))).toBe(true);
  });

  it("marks the active link for the current route", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/OPE/company/settings/language"]}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const languageLink = container.querySelector('a[href$="/company/settings/language"]');
    expect(languageLink).not.toBeNull();
    expect(languageLink?.className).toContain("myr-ui2-settings-item--active");
  });
});
