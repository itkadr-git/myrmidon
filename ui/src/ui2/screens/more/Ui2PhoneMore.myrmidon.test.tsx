// ui/src/ui2/screens/more/Ui2PhoneMore.myrmidon.test.tsx
//
// myrmidon(OPE-10135): Unit tests for the phone "More" screen at /{P}/more.
// Tests links with company prefix, theme switch persistence to "myrmidon.theme",
// and locale catalog rendering.

// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { Ui2PhoneMore } from "./Ui2PhoneMore";

let mockCurrentCompany: { id: string; name: string; prefix: string } | null = {
  id: "company-test",
  name: "Acme Corp",
  prefix: "ACME",
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    currentCompany: mockCurrentCompany,
    selectedCompanyId: mockCurrentCompany?.id ?? null,
  }),
  useOptionalCompany: () => ({
    currentCompany: mockCurrentCompany,
    selectedCompanyId: mockCurrentCompany?.id ?? null,
  }),
}));

describe("Ui2PhoneMore", () => {
  beforeEach(() => {
    localStorage.clear();
    mockCurrentCompany = {
      id: "company-test",
      name: "Acme Corp",
      prefix: "ACME",
    };
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders all required navigation links with the ACME company prefix", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <Ui2I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={["/ACME/more"]}>
            <Ui2PhoneMore />
          </MemoryRouter>
        </Ui2I18nProvider>
      </ThemeProvider>,
    );

    const swarmLink = screen.getByTestId("more-link-swarm");
    const costsLink = screen.getByTestId("more-link-costs");
    const qualityLink = screen.getByTestId("more-link-quality");
    const settingsLink = screen.getByTestId("more-link-settings");
    const agentCardLink = screen.getByTestId("more-link-agentCard");

    expect(swarmLink.getAttribute("href")).toBe("/ACME/swarm-claim");
    expect(costsLink.getAttribute("href")).toBe("/ACME/activity/costs");
    expect(qualityLink.getAttribute("href")).toBe("/ACME/quality");
    expect(settingsLink.getAttribute("href")).toBe("/ACME/company/settings");
    expect(agentCardLink.getAttribute("href")).toBe("/ACME/agents");
  });

  it("renders navigation links with a different company prefix (OPE)", () => {
    mockCurrentCompany = {
      id: "company-ope",
      name: "OPE Team",
      prefix: "OPE",
    };

    render(
      <ThemeProvider defaultTheme="light">
        <Ui2I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={["/OPE/more"]}>
            <Ui2PhoneMore />
          </MemoryRouter>
        </Ui2I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByTestId("more-link-swarm").getAttribute("href")).toBe("/OPE/swarm-claim");
    expect(screen.getByTestId("more-link-costs").getAttribute("href")).toBe("/OPE/activity/costs");
    expect(screen.getByTestId("more-link-quality").getAttribute("href")).toBe("/OPE/quality");
    expect(screen.getByTestId("more-link-settings").getAttribute("href")).toBe("/OPE/company/settings");
    expect(screen.getByTestId("more-link-agentCard").getAttribute("href")).toBe("/OPE/agents");
  });

  it("toggles and persists theme using the standard myrmidon.theme key", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <Ui2I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={["/ACME/more"]}>
            <Ui2PhoneMore />
          </MemoryRouter>
        </Ui2I18nProvider>
      </ThemeProvider>,
    );

    const darkBtn = screen.getByTestId("theme-dark-btn");
    fireEvent.click(darkBtn);
    expect(localStorage.getItem("myrmidon.theme")).toBe("dark");

    const lightBtn = screen.getByTestId("theme-light-btn");
    fireEvent.click(lightBtn);
    expect(localStorage.getItem("myrmidon.theme")).toBe("light");

    const toggleBtn = screen.getByTestId("theme-toggle-btn");
    fireEvent.click(toggleBtn);
    expect(localStorage.getItem("myrmidon.theme")).toBe("dark");
  });

  it("renders labels from the Russian catalog when initialLocale is ru", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <Ui2I18nProvider initialLocale="ru">
          <MemoryRouter initialEntries={["/ACME/more"]}>
            <Ui2PhoneMore />
          </MemoryRouter>
        </Ui2I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText("Рой")).toBeTruthy();
    expect(screen.getByText("Расходы")).toBeTruthy();
    expect(screen.getByText("Качество")).toBeTruthy();
    expect(screen.getByText("Настройки")).toBeTruthy();
    expect(screen.getByText("Карточка агента")).toBeTruthy();
    expect(screen.getByText("Тема")).toBeTruthy();
    expect(screen.getByText("Светлая")).toBeTruthy();
    expect(screen.getByText("Тёмная")).toBeTruthy();
  });

  it("renders labels from the English catalog when initialLocale is en", () => {
    render(
      <ThemeProvider defaultTheme="light">
        <Ui2I18nProvider initialLocale="en">
          <MemoryRouter initialEntries={["/ACME/more"]}>
            <Ui2PhoneMore />
          </MemoryRouter>
        </Ui2I18nProvider>
      </ThemeProvider>,
    );

    expect(screen.getByText("Swarm")).toBeTruthy();
    expect(screen.getByText("Costs")).toBeTruthy();
    expect(screen.getByText("Quality")).toBeTruthy();
    expect(screen.getByText("Settings")).toBeTruthy();
    expect(screen.getByText("Agent card")).toBeTruthy();
    expect(screen.getByText("Theme")).toBeTruthy();
    expect(screen.getByText("Light")).toBeTruthy();
    expect(screen.getByText("Dark")).toBeTruthy();
  });
});
