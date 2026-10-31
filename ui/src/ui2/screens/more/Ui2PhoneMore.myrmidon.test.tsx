// ui/src/ui2/screens/more/Ui2PhoneMore.myrmidon.test.tsx
//
// myrmidon(OPE-10135): Unit tests for the phone "More" screen at /{P}/more.
// Tests links with company prefix, theme switch persistence to "myrmidon.theme",
// and locale catalog rendering. Uses the repo-standard createRoot renderer
// (no @testing-library/react dependency in this workspace).

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ThemeProvider } from "@/context/ThemeContext";
import { Ui2I18nProvider } from "../../i18n/Ui2I18n";
import { Ui2PhoneMore } from "./Ui2PhoneMore";

let mockSelectedCompany: { id: string; name: string; issuePrefix: string } | null = {
  id: "company-test",
  name: "Acme Corp",
  issuePrefix: "ACME",
};

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: mockSelectedCompany ? [mockSelectedCompany] : [],
    selectedCompanyId: mockSelectedCompany?.id ?? null,
    selectedCompany: mockSelectedCompany,
    selectionSource: "storage",
    loading: false,
    error: null,
    companiesUnavailable: false,
    reloadCompanies: async () => {},
    createCompany: async () => {
      throw new Error("not implemented in test");
    },
  }),
}));

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("Ui2PhoneMore", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  async function renderScreen(initialLocale: "en" | "ru" = "en", path = "/ACME/more") {
    root = createRoot(container);
    flushSync(() => {
      root!.render(
        <ThemeProvider>
          <Ui2I18nProvider initialLocale={initialLocale}>
            <MemoryRouter initialEntries={[path]}>
              <Ui2PhoneMore />
            </MemoryRouter>
          </Ui2I18nProvider>
        </ThemeProvider>,
      );
    });
    await flushReact();
  }

  function clickButtonByTestId(testId: string) {
    const button = container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
    if (!button) throw new Error(`button not found: ${testId}`);
    button.click();
    flushSync(() => {});
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    mockSelectedCompany = {
      id: "company-test",
      name: "Acme Corp",
      issuePrefix: "ACME",
    };
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    localStorage.clear();
    document.documentElement.classList.remove("dark");
  });

  it("renders all required navigation links with the ACME company prefix", async () => {
    await renderScreen("en", "/ACME/more");

    const expected: Array<[string, string]> = [
      ["more-link-swarm", "/ACME/swarm-claim"],
      ["more-link-costs", "/ACME/activity/costs"],
      ["more-link-quality", "/ACME/quality"],
      ["more-link-settings", "/ACME/company/settings"],
      ["more-link-agentCard", "/ACME/agents"],
    ];
    for (const [testId, href] of expected) {
      const anchor = container.querySelector(`[data-testid="${testId}"]`);
      expect(anchor, testId).toBeTruthy();
      expect(anchor!.getAttribute("href"), testId).toBe(href);
    }
  });

  it("renders navigation links with a different company prefix (OPE)", async () => {
    mockSelectedCompany = {
      id: "company-ope",
      name: "OPE Team",
      issuePrefix: "OPE",
    };

    await renderScreen("en", "/OPE/more");

    const expected: Array<[string, string]> = [
      ["more-link-swarm", "/OPE/swarm-claim"],
      ["more-link-costs", "/OPE/activity/costs"],
      ["more-link-quality", "/OPE/quality"],
      ["more-link-settings", "/OPE/company/settings"],
      ["more-link-agentCard", "/OPE/agents"],
    ];
    for (const [testId, href] of expected) {
      const anchor = container.querySelector(`[data-testid="${testId}"]`);
      expect(anchor, testId).toBeTruthy();
      expect(anchor!.getAttribute("href"), testId).toBe(href);
    }
  });

  it("toggles and persists theme using the standard myrmidon.theme key", async () => {
    await renderScreen("en", "/ACME/more");

    clickButtonByTestId("theme-dark-btn");
    expect(localStorage.getItem("myrmidon.theme")).toBe("dark");

    clickButtonByTestId("theme-light-btn");
    expect(localStorage.getItem("myrmidon.theme")).toBe("light");

    clickButtonByTestId("theme-toggle-btn");
    expect(localStorage.getItem("myrmidon.theme")).toBe("dark");
  });

  it("renders labels from the Russian catalog when initialLocale is ru", async () => {
    await renderScreen("ru", "/ACME/more");

    for (const label of [
      "Рой",
      "Расходы",
      "Качество",
      "Настройки",
      "Карточка агента",
      "Тема",
      "Светлая",
      "Тёмная",
    ]) {
      expect(container.textContent, label).toContain(label);
    }
  });

  it("renders labels from the English catalog when initialLocale is en", async () => {
    await renderScreen("en", "/ACME/more");

    for (const label of ["Swarm", "Costs", "Quality", "Settings", "Agent card", "Theme", "Light", "Dark"]) {
      expect(container.textContent, label).toContain(label);
    }
  });
});
