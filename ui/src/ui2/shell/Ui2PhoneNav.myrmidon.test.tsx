// @vitest-environment jsdom
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRouter } from "@/lib/router";
import { Ui2I18nProvider } from "../i18n/Ui2I18n";
import { Ui2PhoneHeader, Ui2PhoneTabBar } from "./Ui2PhoneNav";

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

describe("Ui2PhoneNav", () => {
  it("renders compact language switch and localized status in Ui2PhoneHeader", () => {
    const { container } = render(
      <MemoryRouter>
        <Ui2I18nProvider initialLocale="en">
          <Ui2PhoneHeader />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const switchEl = container.querySelector(".ui2-language-switch");
    expect(switchEl).not.toBeNull();
    expect(switchEl?.classList.contains("ui2-language-switch--compact")).toBe(true);

    const buttons = Array.from(container.querySelectorAll("button"));
    const enButton = buttons.find((b) => b.textContent?.includes("English"));
    const ruButton = buttons.find((b) => b.textContent?.includes("Русский"));
    expect(enButton).toBeDefined();
    expect(ruButton).toBeDefined();
  });

  it("renders localized phone tab bar without raw keys", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/OPE/company/settings"]}>
        <Ui2I18nProvider initialLocale="ru">
          <Ui2PhoneTabBar />
        </Ui2I18nProvider>
      </MemoryRouter>,
    );

    const nav = container.querySelector("nav");
    expect(nav).not.toBeNull();
    const rawKeys = container.textContent?.match(/ui2\.[a-zA-Z0-9_.]+/g) ?? [];
    expect(rawKeys).toEqual([]);
  });
});
