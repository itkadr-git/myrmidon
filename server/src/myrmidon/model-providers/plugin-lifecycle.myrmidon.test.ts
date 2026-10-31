// server/src/myrmidon/model-providers/plugin-lifecycle.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-7198): tests for the production plugin lifecycle bridge
// connecting closed/plugin connectors (e.g. connectors/chatgpt-pool) to the
// model provider registry.
//
// Asserts:
// - Absent / not installed: provider type is unavailable.
// - Installed & ready: provider type becomes available in listAvailableModelProviderTypes().
// - Disabled / errored: provider type becomes unavailable.
// - Re-enabled: provider type becomes available again.
// - Unloaded / uninstalled: provider type becomes unavailable.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearModelProviderConnectors,
  getModelProviderConnector,
  isModelProviderTypeAvailable,
  listAvailableModelProviderTypes,
} from "@myrmidon/shared";
import {
  bindModelProviderPluginLifecycle,
  isChatGptPoolKey,
  isModelProviderPlugin,
  registerConnectorsForPlugin,
  unregisterConnectorsForPlugin,
} from "./plugin-lifecycle.js";

class FakePluginLifecycleManager extends EventEmitter {
  async load(id: string) {
    this.emit("plugin.loaded", { pluginId: id, pluginKey: "myrmidon.chatgpt-pool" });
    this.emit("plugin.enabled", { pluginId: id, pluginKey: "myrmidon.chatgpt-pool" });
  }

  async enable(id: string) {
    this.emit("plugin.enabled", { pluginId: id, pluginKey: "myrmidon.chatgpt-pool" });
    this.emit("plugin.status_changed", {
      pluginId: id,
      pluginKey: "myrmidon.chatgpt-pool",
      previousStatus: "disabled",
      newStatus: "ready",
    });
  }

  async disable(id: string) {
    this.emit("plugin.disabled", { pluginId: id, pluginKey: "myrmidon.chatgpt-pool" });
    this.emit("plugin.status_changed", {
      pluginId: id,
      pluginKey: "myrmidon.chatgpt-pool",
      previousStatus: "ready",
      newStatus: "disabled",
    });
  }

  async unload(id: string) {
    this.emit("plugin.unloaded", { pluginId: id, pluginKey: "myrmidon.chatgpt-pool", removeData: false });
    this.emit("plugin.status_changed", {
      pluginId: id,
      pluginKey: "myrmidon.chatgpt-pool",
      previousStatus: "ready",
      newStatus: "uninstalled",
    });
  }
}

describe("myrmidon(1.6.6 OPE-7198) model provider plugin lifecycle bridge", () => {
  beforeEach(() => {
    clearModelProviderConnectors();
  });

  afterEach(() => {
    clearModelProviderConnectors();
  });

  it("recognizes chatgpt-pool plugin keys and manifest declarations", () => {
    expect(isChatGptPoolKey("myrmidon.chatgpt-pool")).toBe(true);
    expect(isChatGptPoolKey("paperclip.chatgpt-pool")).toBe(true);
    expect(isChatGptPoolKey("custom.other-plugin")).toBe(false);

    expect(isModelProviderPlugin({ pluginKey: "myrmidon.chatgpt-pool" })).toBe(true);
    expect(
      isModelProviderPlugin({
        pluginKey: "custom.plugin",
        manifestJson: {
          id: "custom.plugin",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Custom",
          description: "Custom",
          author: "Test",
          categories: ["connector"],
          capabilities: ["agent.tools.register"],
          entrypoints: { worker: "./worker.js" },
          modelProviders: [{ type: "custom-pool", supportsChannels: true }],
        },
      }),
    ).toBe(true);
    expect(isModelProviderPlugin({ pluginKey: "custom.plugin", manifestJson: null })).toBe(false);
  });

  it("registers and unregisters connectors directly", () => {
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);

    registerConnectorsForPlugin({ pluginKey: "myrmidon.chatgpt-pool" });
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(true);
    expect(listAvailableModelProviderTypes()).toContain("chatgpt-pool");

    const connector = getModelProviderConnector("chatgpt-pool");
    expect(connector).not.toBeNull();
    expect(connector?.supportsChannels).toBe(true);
    expect(connector?.defaultBaseUrl).toBe("http://localhost:8895");

    unregisterConnectorsForPlugin("myrmidon.chatgpt-pool");
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);
    expect(listAvailableModelProviderTypes()).not.toContain("chatgpt-pool");
  });

  it("lifecycle events: absent -> installed/ready -> disabled -> re-enabled -> unloaded", async () => {
    const lifecycle = new FakePluginLifecycleManager();
    const pluginId = "plugin-pool-1";
    let pluginStatus = "uninstalled";

    const fakeRegistry = {
      list: async () => [
        {
          id: pluginId,
          pluginKey: "myrmidon.chatgpt-pool",
          status: pluginStatus,
          manifestJson: null,
        } as any,
      ],
      getById: async (id: string) => {
        if (id === pluginId) {
          return {
            id: pluginId,
            pluginKey: "myrmidon.chatgpt-pool",
            status: pluginStatus,
            manifestJson: null,
          } as any;
        }
        return null;
      },
    };

    const bridge = bindModelProviderPluginLifecycle({
      lifecycle: lifecycle as any,
      registry: fakeRegistry,
    });

    // 1. Absent / uninstalled: type is not available
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);

    // 2. Installed & ready: load triggers registration
    pluginStatus = "ready";
    await lifecycle.load(pluginId);
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(true);
    expect(listAvailableModelProviderTypes()).toContain("chatgpt-pool");

    // 3. Disabled: unregisters connector
    pluginStatus = "disabled";
    await lifecycle.disable(pluginId);
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);
    expect(listAvailableModelProviderTypes()).not.toContain("chatgpt-pool");

    // 4. Re-enabled: re-registers connector
    pluginStatus = "ready";
    await lifecycle.enable(pluginId);
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(true);
    expect(listAvailableModelProviderTypes()).toContain("chatgpt-pool");

    // 5. Unloaded: unregisters connector
    pluginStatus = "uninstalled";
    await lifecycle.unload(pluginId);
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);
    expect(listAvailableModelProviderTypes()).not.toContain("chatgpt-pool");

    bridge.teardown();
  });

  it("syncFromRegistry: initializes connectors for already-ready plugins on startup", async () => {
    const fakeRegistry = {
      list: async () => [
        {
          id: "p1",
          pluginKey: "myrmidon.chatgpt-pool",
          status: "ready",
          manifestJson: null,
        } as any,
        {
          id: "p2",
          pluginKey: "other-plugin",
          status: "ready",
          manifestJson: null,
        } as any,
      ],
      getById: async () => null,
    };

    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);

    const bridge = bindModelProviderPluginLifecycle({
      registry: fakeRegistry,
    });

    await bridge.syncFromRegistry();
    expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(true);

    bridge.teardown();
  });
});
