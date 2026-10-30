import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "@/lib/router";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { UI2_SETTINGS_SECTIONS, Ui2SettingsSidebar } from "./Ui2SettingsSidebar";

describe("Ui2SettingsSidebar", () => {
  it("renders all 11 settings sections without raw keys in English", () => {
    render(
      <MemoryRouter initialEntries={["/OPE/company/settings"]}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(nav).toBeDefined();

    // Check all 11 sections are present
    expect(UI2_SETTINGS_SECTIONS).toHaveLength(11);
    for (const section of UI2_SETTINGS_SECTIONS) {
      const link = nav.querySelector(`a[href$="${section.path}"]`);
      expect(link).not.toBeNull();
      const text = link?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      // Must not render raw key
      expect(text).not.toContain("ui2.settings.");
    }

    // Explicit checks for critical sections
    expect(screen.getByText("General")).toBeDefined();
    expect(screen.getByText("Language")).toBeDefined();
  });

  it("renders all 11 settings sections without raw keys in Russian", () => {
    render(
      <MemoryRouter initialEntries={["/OPE/company/settings/language"]}>
        <Ui2I18nProvider initialLocale="ru">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const nav = screen.getByRole("navigation", { name: "Настройки" });
    expect(nav).toBeDefined();

    for (const section of UI2_SETTINGS_SECTIONS) {
      const link = nav.querySelector(`a[href$="${section.path}"]`);
      expect(link).not.toBeNull();
      const text = link?.textContent ?? "";
      expect(text.length).toBeGreaterThan(0);
      // Must not render raw key
      expect(text).not.toContain("ui2.settings.");
    }

    // Explicit checks for Russian translations
    expect(screen.getByText("Общие")).toBeDefined();
    expect(screen.getByText("Язык")).toBeDefined();
  });

  it("marks the active link for the current route", () => {
    render(
      <MemoryRouter initialEntries={["/OPE/company/settings/language"]}>
        <Ui2I18nProvider initialLocale="en">
          <Ui2SettingsSidebar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const languageLink = screen.getByRole("link", { name: "Language" });
    expect(languageLink.className).toContain("myr-ui2-settings-item--active");
  });
});
