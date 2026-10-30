// @vitest-environment jsdom
// myrmidon(OPE-9382): tests for Ui2AccountMenu — interface version switcher
// and language selection parity in UI2.
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { name: "Test Corp", id: "co-1" } }),
}));

vi.mock("@/hooks/useHealth", () => ({
  useHealth: () => ({ data: { status: "ok", deploymentMode: "local" } }),
}));

vi.mock("@/hooks/useSignOut", () => ({
  useSignOut: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/i18n", () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

vi.mock("@/i18n/myrmidon-i18n", () => ({
  FORK_LANGUAGES: ["en", "ru"],
  forkLanguageLabel: (code: string) => (code === "ru" ? "Русский" : "English"),
  useAppLanguage: () => ({ language: "ru", setLanguage: vi.fn() }),
}));

import { Ui2AccountMenu } from "./Ui2AccountMenu";
import { readUi2PersonalOverride } from "../useMyrmidonUi2Enabled";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

describe("Ui2AccountMenu", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(() => {
      root?.unmount();
    });
    container.remove();
    root = null;
    document.body.innerHTML = "";
  });

  it("renders the compact trigger and opens the menu with interface switch options", async () => {
    await act(() => {
      root!.render(<Ui2AccountMenu compact />);
    });

    const trigger = container.querySelector('[data-testid="ui2-account-menu-trigger-compact"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.textContent).toContain("Test Corp");

    // Open menu
    await act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const menu = document.body.querySelector('[data-testid="ui2-account-menu-content"]');
    expect(menu).not.toBeNull();

    // Verify interface switch section
    const section = document.body.querySelector('[data-testid="ui2-interface-toggle-section"]');
    expect(section).not.toBeNull();

    const optNew = document.body.querySelector('[data-testid="ui2-switch-option-new"]');
    const optLegacy = document.body.querySelector('[data-testid="ui2-switch-option-legacy"]');
    const optInstance = document.body.querySelector('[data-testid="ui2-switch-option-instance"]');
    expect(optNew).not.toBeNull();
    expect(optLegacy).not.toBeNull();
    expect(optInstance).not.toBeNull();

    // Click "Legacy" (Прежняя)
    await act(() => {
      optLegacy?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(readUi2PersonalOverride(window.localStorage)).toBe("1");
  });

  it("can switch to UI2 (Новая) and follow instance setting", async () => {
    window.localStorage.setItem("myr.ui2.personal", "1");

    await act(() => {
      root!.render(<Ui2AccountMenu />);
    });

    const trigger = container.querySelector('[data-testid="ui2-account-menu-trigger-full"]');
    expect(trigger).not.toBeNull();

    // Open menu
    await act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const optNew = document.body.querySelector('[data-testid="ui2-switch-option-new"]');
    await act(() => {
      optNew?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(readUi2PersonalOverride(window.localStorage)).toBe("2");

    // Re-open and click instance setting
    await act(() => {
      trigger?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    const optInstance = document.body.querySelector('[data-testid="ui2-switch-option-instance"]');
    await act(() => {
      optInstance?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(readUi2PersonalOverride(window.localStorage)).toBeNull();
  });
});
