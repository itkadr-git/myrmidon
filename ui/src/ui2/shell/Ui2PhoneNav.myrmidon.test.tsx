import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "@/lib/router";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { Ui2PhoneHeader, Ui2PhoneTabBar } from "./Ui2PhoneNav";

describe("Ui2PhoneNav", () => {
  it("renders compact language switch and localized status in Ui2PhoneHeader", () => {
    const { container } = render(
      <MemoryRouter>
        <Ui2I18nProvider initialLocale="en">
          <Ui2PhoneHeader />
        </Ui2I18nProvider>
      </MemoryRouter>
    );

    const switchEl = container.querySelector(".ui2-language-switch");
    expect(switchEl).not.toBeNull();
    expect(switchEl?.classList.contains("ui2-language-switch--compact")).toBe(true);
    expect(screen.getByRole("button", { name: "English" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Русский" })).toBeDefined();
  });

  it("renders localized phone tab bar without raw keys", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/OPE/company/settings"]}>
        <Ui2I18nProvider initialLocale="ru">
          <Ui2PhoneTabBar />
        </Ui2I18nProvider>
      </MemoryRouter>
    );

    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    const rawKeys = container.textContent?.match(/ui2\.[a-zA-Z0-9_.]+/g) ?? [];
    expect(rawKeys).toEqual([]);
  });
});
