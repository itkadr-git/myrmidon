// @vitest-environment jsdom
// myrmidon(PLUGIN-ENTITLEMENT C): the settings panel — accept a key, see the
// list with expiry, remove a key, and a clear local error on empty input.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PluginEntitlementSettings } from "./PluginEntitlementSettingsPanel";
import * as apiModule from "./pluginEntitlementApi";

function renderPanel(): HTMLDivElement {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  createRoot(container).render(
    <QueryClientProvider client={queryClient}>
      <PluginEntitlementSettings />
    </QueryClientProvider>,
  );
  return container;
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

const keys = [
  { pluginId: "example.premium-feature", key: "k1", expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE },
  { pluginId: "example.expired-feature", key: "k2", expiresAt: PAST, acceptedAt: PAST },
];

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("waitFor timeout");
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

describe("PluginEntitlementSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("lists the accepted keys with expiry status", async () => {
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue(keys as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-list"]')));
    const rows = container.querySelectorAll('[data-testid="plugin-entitlement-row"]');
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("example.premium-feature");
    expect(container.textContent).toContain("2999-01-01");
    // The expired entry carries the expired badge.
    expect(container.querySelector('[data-testid="plugin-entitlement-expired"]')).not.toBeNull();
  });

  it("shows the empty state before any key is accepted", async () => {
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-empty"]')));
    expect(container.querySelector('[data-testid="plugin-entitlement-list"]')).toBeNull();
  });

  it("accepts a key through the API", async () => {
    const accept = vi.fn().mockResolvedValue(keys.slice(0, 1));
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "accept").mockImplementation(accept as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-empty"]')));
    const idInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-plugin-id-input"]')!;
    const keyInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-key-input"]')!;
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    const addButton = Array.from(buttons).find((b) => b.textContent?.includes("key") || b.textContent?.includes("ключ"))!;
    await act(async () => {
      setInputValue(idInput, "example.premium-feature");
      setInputValue(keyInput, "PC-example-123");
    });
    await act(async () => {
      addButton.click();
    });
    await waitFor(() => accept.mock.calls.length > 0);
    expect(accept).toHaveBeenCalledWith({ pluginId: "example.premium-feature", key: "PC-example-123" });
  });

  it("does not call the API with an empty key", async () => {
    const accept = vi.fn();
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "accept").mockImplementation(accept as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-empty"]')));
    const idInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-plugin-id-input"]')!;
    const keyInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-key-input"]')!;
    await act(async () => {
      setInputValue(idInput, "example.premium-feature");
      setInputValue(keyInput, "   ");
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    const addButton = Array.from(buttons).find((b) => b.textContent?.includes("key") || b.textContent?.includes("ключ"))!;
    // Empty key disables the add button: clicking is a no-op.
    expect(addButton.disabled).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it("removes a key through the API", async () => {
    const remove = vi.fn().mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue(keys as never);
    vi.spyOn(apiModule.pluginEntitlementApi, "remove").mockImplementation(remove as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-list"]')));
    const removeButton = container.querySelector<HTMLButtonElement>('[data-testid="plugin-entitlement-remove"]')!;
    await act(async () => {
      removeButton.click();
    });
    await waitFor(() => remove.mock.calls.length > 0);
    expect(remove).toHaveBeenCalledWith("example.premium-feature");
  });
});
