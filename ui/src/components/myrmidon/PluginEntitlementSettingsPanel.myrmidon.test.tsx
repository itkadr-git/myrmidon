// @vitest-environment jsdom
// myrmidon(PLUGIN-ENTITLEMENT C / 1.6.3 A): the settings panel — accept a key,
// see the list with expiry, remove a key, show the server's rejection reason,
// and manage the ed25519 verification public key (with its value source).
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

function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? window.HTMLTextAreaElement : window.HTMLInputElement;
  const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

const FAR_FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2000-01-01T00:00:00.000Z";

// The list view carries no key values — the server strips them.
const keys = [
  { pluginId: "example.premium-feature", expiresAt: FAR_FUTURE, acceptedAt: FAR_FUTURE },
  { pluginId: "example.expired-feature", expiresAt: PAST, acceptedAt: PAST },
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

function findButton(container: HTMLDivElement, testId: string): HTMLButtonElement {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`)!;
}

describe("PluginEntitlementSettingsPanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    // The panel also loads the verification public key; default to "not set".
    vi.spyOn(apiModule.pluginEntitlementApi, "getPublicKey").mockResolvedValue({
      publicKey: null,
      source: "none",
    } as never);
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
    await act(async () => {
      setInputValue(idInput, "example.premium-feature");
      setInputValue(keyInput, "PEK1.payload.signature");
    });
    await act(async () => {
      findButton(container, "plugin-entitlement-add").click();
    });
    await waitFor(() => accept.mock.calls.length > 0);
    expect(accept).toHaveBeenCalledWith({ pluginId: "example.premium-feature", key: "PEK1.payload.signature" });
  });

  it("shows the server's rejection reason when a key does not verify", async () => {
    const accept = vi
      .fn()
      .mockRejectedValue(new Error("the key signature does not verify against this instance's public key"));
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "accept").mockImplementation(accept as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-empty"]')));
    const idInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-plugin-id-input"]')!;
    const keyInput = container.querySelector<HTMLInputElement>('[data-testid="plugin-entitlement-key-input"]')!;
    await act(async () => {
      setInputValue(idInput, "example.premium-feature");
      setInputValue(keyInput, "PEK1.payload.forged-signature");
    });
    await act(async () => {
      findButton(container, "plugin-entitlement-add").click();
    });
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-error"]')));
    expect(container.querySelector('[data-testid="plugin-entitlement-error"]')!.textContent).toContain(
      "signature does not verify",
    );
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
    // Empty key disables the add button: clicking is a no-op.
    expect(findButton(container, "plugin-entitlement-add").disabled).toBe(true);
    expect(accept).not.toHaveBeenCalled();
  });

  it("removes a key through the API", async () => {
    const remove = vi.fn().mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue(keys as never);
    vi.spyOn(apiModule.pluginEntitlementApi, "remove").mockImplementation(remove as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-list"]')));
    await act(async () => {
      findButton(container, "plugin-entitlement-remove").click();
    });
    await waitFor(() => remove.mock.calls.length > 0);
    expect(remove).toHaveBeenCalledWith("example.premium-feature");
  });

  it("shows where the effective verification public key comes from", async () => {
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "getPublicKey").mockResolvedValue({
      publicKey: "-----BEGIN PUBLIC KEY-----...",
      source: "env",
    } as never);
    const container = renderPanel();
    await waitFor(() =>
      Boolean(
        container
          .querySelector('[data-testid="plugin-entitlement-public-key-source"]')
          ?.textContent?.includes("MYRMIDON_PLUGIN_ENTITLEMENT_PUBLIC_KEY"),
      ),
    );
  });

  it("saves the verification public key through the API", async () => {
    const setPublicKey = vi.fn().mockResolvedValue({ publicKey: "-----BEGIN PUBLIC KEY-----...", source: "settings" });
    vi.spyOn(apiModule.pluginEntitlementApi, "list").mockResolvedValue([]);
    vi.spyOn(apiModule.pluginEntitlementApi, "setPublicKey").mockImplementation(setPublicKey as never);
    const container = renderPanel();
    await waitFor(() => Boolean(container.querySelector('[data-testid="plugin-entitlement-public-key-input"]')));
    const input = container.querySelector<HTMLTextAreaElement>('[data-testid="plugin-entitlement-public-key-input"]')!;
    await act(async () => {
      setInputValue(input, "-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----");
    });
    await act(async () => {
      findButton(container, "plugin-entitlement-public-key-save").click();
    });
    await waitFor(() => setPublicKey.mock.calls.length > 0);
    expect(setPublicKey).toHaveBeenCalledWith("-----BEGIN PUBLIC KEY-----\nAAA\n-----END PUBLIC KEY-----");
  });
});