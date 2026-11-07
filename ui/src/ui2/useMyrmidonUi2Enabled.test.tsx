// @vitest-environment jsdom
// myrmidon(UI-0a): tests for the enableMyrmidonUi2 flag resolution and hook —
// the shell must be strictly opt-in: off while loading, off on read failure,
// off when the key is missing, on only for an explicit true.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSafeLocalStorage,
  readUi2PersonalOverride,
  rememberUi2PersonalOverride,
  resolveMyrmidonUi2Enabled,
  setUi2PersonalOverride,
  useMyrmidonUi2Enabled,
} from "./useMyrmidonUi2Enabled";

const mockInstanceSettingsApi = vi.hoisted(() => ({ getExperimental: vi.fn() }));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

function Probe() {
  const state = useMyrmidonUi2Enabled();
  return <output>{`${state.enabled}:${state.loaded}`}</output>;
}

async function flushReact() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  flushSync(() => {});
}

describe("resolveMyrmidonUi2Enabled", () => {
  it("is off for missing, null, and empty settings", () => {
    expect(resolveMyrmidonUi2Enabled(undefined)).toBe(false);
    expect(resolveMyrmidonUi2Enabled(null)).toBe(false);
    expect(resolveMyrmidonUi2Enabled({} as never)).toBe(false);
  });

  it("is on only for an explicit true", () => {
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: true })).toBe(true);
    expect(resolveMyrmidonUi2Enabled({ enableMyrmidonUi2: false })).toBe(false);
  });
});

describe("useMyrmidonUi2Enabled", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    host.remove();
    vi.clearAllMocks();
  });

  it("stays off while the settings request is in flight (no shell flash)", () => {
    mockInstanceSettingsApi.getExperimental.mockImplementation(() => new Promise(() => {}));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });

    expect(host.textContent).toBe("false:false");
  });

  it("turns on only for an explicit true from the settings payload", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("true:true");
  });

  it("resolves off when the payload omits the flag (legacy stored rows)", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableStreamlinedUi: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("false:true");
  });

  it("fails closed on a settings read error", async () => {
    mockInstanceSettingsApi.getExperimental.mockRejectedValue(new Error("network down"));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    flushSync(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <Probe />
        </QueryClientProvider>,
      );
    });
    await flushReact();

    expect(host.textContent).toBe("false:true");
  });

  describe("storage access and privacy mode safety", () => {
    it("handles storage access errors gracefully without throwing on render", async () => {
      const originalLocalStorage = window.localStorage;
      try {
        Object.defineProperty(window, "localStorage", {
          get() {
            throw new DOMException("Access denied", "SecurityError");
          },
          configurable: true,
        });

        expect(getSafeLocalStorage()).toBeNull();
        expect(readUi2PersonalOverride()).toBeNull();
        expect(() => rememberUi2PersonalOverride("2")).not.toThrow();

        mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: true });
        const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
        expect(() => {
          flushSync(() => {
            root.render(
              <QueryClientProvider client={queryClient}>
                <Probe />
              </QueryClientProvider>,
            );
          });
        }).not.toThrow();
        await flushReact();
        expect(host.textContent).toBe("true:true");
      } finally {
        Object.defineProperty(window, "localStorage", {
          value: originalLocalStorage,
          configurable: true,
          writable: true,
        });
      }
    });
  });

  describe("live shell switching behavior without page reload", () => {
    function ShellMock() {
      const { enabled } = useMyrmidonUi2Enabled();
      return <div data-testid="active-shell">{enabled ? "UI2_SHELL" : "LEGACY_SHELL"}</div>;
    }

    it("switches root shell from legacy to UI2 and back on button/override trigger without page reload", async () => {
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: false });
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.localStorage.clear();

      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient}>
            <ShellMock />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      expect(host.textContent).toBe("LEGACY_SHELL");

      // Switch to UI2 ("Новая")
      setUi2PersonalOverride("2");
      await flushReact();
      expect(host.textContent).toBe("UI2_SHELL");
      expect(window.localStorage.getItem("myr.ui2.personal")).toBe("2");

      // Switch back to legacy ("Прежняя")
      setUi2PersonalOverride("1");
      await flushReact();
      expect(host.textContent).toBe("LEGACY_SHELL");
      expect(window.localStorage.getItem("myr.ui2.personal")).toBe("1");
    });

    it("resets to instance setting when 'По настройке экземпляра' is selected (with enableMyrmidonUi2 = true)", async () => {
      // 1. Instance setting is enableMyrmidonUi2 = true
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: true });
      const queryClient1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.localStorage.setItem("myr.ui2.personal", "1"); // personal forced legacy

      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient1}>
            <ShellMock />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      // Initially forced to legacy despite instance flag being true
      expect(host.textContent).toBe("LEGACY_SHELL");

      // Select "По настройке экземпляра" (setUi2PersonalOverride(null))
      setUi2PersonalOverride(null);
      await flushReact();
      // Should now follow instance setting (enableMyrmidonUi2: true -> UI2_SHELL)
      expect(host.textContent).toBe("UI2_SHELL");
      expect(window.localStorage.getItem("myr.ui2.personal")).toBeNull();
    });

    it("resets to instance setting when 'По настройке экземпляра' is selected (with enableMyrmidonUi2 = false)", async () => {
      // 2. Now test with instance setting enableMyrmidonUi2 = false
      mockInstanceSettingsApi.getExperimental.mockResolvedValue({ enableMyrmidonUi2: false });
      const queryClient2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      window.localStorage.setItem("myr.ui2.personal", "2"); // personal forced UI2
      flushSync(() => {
        root.render(
          <QueryClientProvider client={queryClient2}>
            <ShellMock />
          </QueryClientProvider>,
        );
      });
      await flushReact();
      expect(host.textContent).toBe("UI2_SHELL");

      // Reset to instance default again
      setUi2PersonalOverride(null);
      await flushReact();
      // Should now follow instance setting (enableMyrmidonUi2: false -> LEGACY_SHELL)
      expect(host.textContent).toBe("LEGACY_SHELL");
      expect(window.localStorage.getItem("myr.ui2.personal")).toBeNull();
    });

    it("clears ?ui= parameter from window URL upon selecting an interface override", async () => {
      window.history.pushState({}, "", "/some/path?ui=2&tab=overview");
      expect(window.location.search).toContain("ui=2");

      setUi2PersonalOverride("1");
      expect(window.location.search).not.toContain("ui=");
      expect(window.location.search).toContain("tab=overview");

      setUi2PersonalOverride(null);
      expect(window.location.search).not.toContain("ui=");
    });
  });
});
