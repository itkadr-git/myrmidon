// ui/src/ui2/i18n/Ui2I18n.shell-locale.myrmidon.test.tsx
//
// myrmidon(UI-2.0 Wave A part 2, §7.6): guard tests for the shell-wide
// language contract of the ui2 language provider:
//   - default locale for a NEW user is "en" (owner decision 03.10);
//   - choosing ru switches the shell's i18next instance and the flat
//     catalog WITHOUT a reload, and persists to localStorage + the server
//     preference (PUT /myrmidon/ui2/language/me);
//   - the server preference wins over the local mirror on mount, but a
//     user switch in this session is never overwritten by a late response;
//   - the `lang` attribute lands on the .myr-ui2 root (RU font contract).

// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMock = vi.hoisted(() => ({
  get: vi.fn().mockResolvedValue({ language: "en", updatedAt: null }),
  put: vi.fn().mockResolvedValue({ language: "en", updatedAt: null }),
}));

vi.mock("@/api/client", () => ({ api: apiMock }));

const i18nMock = vi.hoisted(() => ({
  changeLanguage: vi.fn().mockResolvedValue(undefined),
  language: "en",
  addResourceBundle: vi.fn(),
  hasResourceBundle: vi.fn().mockReturnValue(false),
}));

vi.mock("@/i18n", () => ({ i18n: i18nMock }));

// The shared provider module (index.tsx) is NOT under test here; stub it so
// this file owns the Ui2I18n provider behavior alone.
vi.mock("./index", () => ({
  registerUi2Catalogs: vi.fn(),
  Ui2LanguageProvider: ({ children }: { children: unknown }) => <>{children as never}</>,
}));

import { Ui2I18nProvider, useUi2I18n, readStoredLocale, resetUi2ServerPreferenceCacheForTests } from "./Ui2I18n";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

/** Flush the microtask queue N times: promise chains (load → then → set state)
 * settle across several ticks, and each settled set state needs its own
 * act flush for React to render it before the assertion reads the probe. */
async function flushTicks(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

let container: HTMLDivElement;
let shellRoot: HTMLDivElement;
let root: Root | null;
let probe: { locale: string };
let setLocaleFn: ((locale: "en" | "ru") => void) | null = null;

function Probe() {
  const value = useUi2I18n();
  probe = { locale: value.locale };
  setLocaleFn = value.setLocale;
  return null;
}

function renderTree(initialLocale?: "en" | "ru") {
  root = createRoot(container);
  flushSync(() => {
    root?.render(
      <Ui2I18nProvider initialLocale={initialLocale}>
        <Probe />
      </Ui2I18nProvider>,
    );
  });
}

beforeEach(() => {
  resetUi2ServerPreferenceCacheForTests();
  container = document.createElement("div");
  shellRoot = document.createElement("div");
  shellRoot.className = "myr-ui2";
  document.body.appendChild(shellRoot);
  document.body.appendChild(container);
  window.localStorage.clear();
  apiMock.get.mockReset().mockResolvedValue({ language: "en", updatedAt: null });
  apiMock.put.mockReset().mockResolvedValue({ language: "en", updatedAt: null });
  i18nMock.changeLanguage.mockClear();
  i18nMock.language = "en";
  shellRoot.removeAttribute("lang");
  probe = { locale: "en" };
  setLocaleFn = null;
});

afterEach(() => {
  flushSync(() => {
    root?.unmount();
  });
  root = null;
  container.remove();
  shellRoot.remove();
  window.localStorage.clear();
});

describe("myrmidon(UI2) shell language contract", () => {
  it("a new user starts on en (instance default, owner decision 03.10)", () => {
    renderTree("en");
    expect(probe.locale).toBe("en");
    expect(readStoredLocale()).toBeNull();
  });

  it("applies the starting locale to the shell (i18next + lang attribute) without a reload", async () => {
    // The mount effect guards `i18n.language !== locale`; start the mock as
    // if the vendor instance still sits on the ru default so the switch to
    // en is observable.
    i18nMock.language = "ru";
    renderTree("en");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushTicks();
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("en");
    expect(shellRoot.getAttribute("lang")).toBe("en");
  });

  it("switching to ru changes the i18next instance, the flat catalog and the lang attribute immediately", async () => {
    renderTree("en");
    await flushTicks();
    i18nMock.changeLanguage.mockClear();

    await act(() => {
      setLocaleFn?.("ru");
    });

    expect(probe.locale).toBe("ru");
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
    expect(shellRoot.getAttribute("lang")).toBe("ru");
    // Persistence: local mirror + server preference write.
    expect(window.localStorage.getItem("myrmidon.ui2.locale")).toBe("ru");
    expect(apiMock.put).toHaveBeenCalledWith("/myrmidon/ui2/language/me", { language: "ru" });
  });

  it("a failed server PUT keeps the local choice applied", async () => {
    apiMock.put.mockRejectedValue(new Error("offline"));
    renderTree("en");
    await flushTicks();
    await act(() => {
      setLocaleFn?.("ru");
    });
    expect(probe.locale).toBe("ru");
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
  });

  it("the server preference wins over the local mirror on mount", async () => {
    window.localStorage.setItem("myrmidon.ui2.locale", "en");
    apiMock.get.mockResolvedValue({ language: "ru", updatedAt: "2026-10-03T00:00:00.000Z" });
    renderTree("en");
    // Mount effect is async (post-paint) and the server GET resolves across
    // several microtask turns; wait a macrotask then drain the microtask queue.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flushTicks();
    expect(probe.locale).toBe("ru");
    expect(i18nMock.changeLanguage).toHaveBeenCalledWith("ru");
  });

  it("a late server response never overwrites a session switch", async () => {
    let resolveGet: (value: { language: string; updatedAt: string | null }) => void = () => {};
    apiMock.get.mockImplementation(
      () => new Promise((resolve) => { resolveGet = resolve; }),
    );
    renderTree("en");
    await act(() => {
      setLocaleFn?.("ru");
    });
    await act(async () => {
      resolveGet({ language: "en", updatedAt: null });
      await Promise.resolve();
    });
    await flushTicks();
    expect(probe.locale).toBe("ru");
  });

  it("reads the legacy and the shared mirror keys", () => {
    window.localStorage.setItem("myrmidon:ui2:language", "ru");
    expect(readStoredLocale()).toBe("ru");
    window.localStorage.clear();
    window.localStorage.setItem("myrmidon.ui2.locale", "en");
    expect(readStoredLocale()).toBe("en");
  });
});
