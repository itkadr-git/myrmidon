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
  DEFAULT_ANTIGRAVITY_POOL_MODELS,
  DEFAULT_CHATGPT_POOL_MODELS,
  getModelProviderConnector,
  isModelProviderTypeAvailable,
  listAvailableModelProviderTypes,
} from "@myrmidon/shared";
import {
  bindModelProviderPluginLifecycle,
  isAntigravityPoolKey,
  isChatGptPoolKey,
  isGoogleAiPoolKey,
  isModelProviderPlugin,
  isPoolConnectorPluginKey,
  poolConnectorTypeForPluginKey,
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

  it("keeps a connector type registered while another plugin still owns it", () => {
    const manifest = {
      id: "custom.plugin",
      apiVersion: 1,
      version: "1.0.0",
      displayName: "Custom",
      description: "Custom",
      author: "Test",
      categories: ["connector"],
      capabilities: ["agent.tools.register"],
      entrypoints: { worker: "./worker.js" },
      modelProviders: [{ type: "shared-pool", defaultModels: ["shared/model"] }],
    } as any;
    registerConnectorsForPlugin({ pluginKey: "plugin.one", manifestJson: manifest });
    registerConnectorsForPlugin({ pluginKey: "plugin.two", manifestJson: manifest });

    unregisterConnectorsForPlugin("plugin.one", manifest);

    expect(isModelProviderTypeAvailable("shared-pool")).toBe(true);
    expect(getModelProviderConnector("shared-pool")?.pluginKey).toBe("plugin.two");
    unregisterConnectorsForPlugin("plugin.two", manifest);
    expect(isModelProviderTypeAvailable("shared-pool")).toBe(false);
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
  // myrmidon(1.6.7 OPE-12345): the installed antigravity and google-ai plugins
  // declare no `modelProviders` in their manifests, so the core registers their
  // connectors by plugin key, as it does for the ChatGPT pool.
  describe("antigravity-pool and google-ai-pool connectors", () => {
    it("recognizes the plugin keys and maps each to its connector type", () => {
      expect(isAntigravityPoolKey("myrmidon.antigravity")).toBe(true);
      expect(isAntigravityPoolKey("paperclip.antigravity")).toBe(true);
      expect(isAntigravityPoolKey(" Myrmidon.Antigravity ")).toBe(true);
      expect(isAntigravityPoolKey("custom.antigravity-adapter")).toBe(false);
      expect(isGoogleAiPoolKey("myrmidon.google-ai")).toBe(true);
      expect(isGoogleAiPoolKey("myrmidon.google-ai-gemini")).toBe(false);

      expect(poolConnectorTypeForPluginKey("myrmidon.chatgpt-pool")).toBe("chatgpt-pool");
      expect(poolConnectorTypeForPluginKey("myrmidon.antigravity")).toBe("antigravity-pool");
      expect(poolConnectorTypeForPluginKey("myrmidon.google-ai")).toBe("google-ai-pool");
      expect(poolConnectorTypeForPluginKey("custom.plugin")).toBeNull();
      expect(isPoolConnectorPluginKey("myrmidon.antigravity")).toBe(true);
      expect(isPoolConnectorPluginKey("custom.plugin")).toBe(false);

      expect(isModelProviderPlugin({ pluginKey: "myrmidon.antigravity" })).toBe(true);
      expect(isModelProviderPlugin({ pluginKey: "myrmidon.google-ai" })).toBe(true);
    });

    it("registers antigravity-pool with channels and the four gateway group names", () => {
      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(false);

      registerConnectorsForPlugin({ pluginKey: "myrmidon.antigravity" });

      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(true);
      const connector = getModelProviderConnector("antigravity-pool");
      expect(connector?.pluginKey).toBe("myrmidon.antigravity");
      expect(connector?.supportsChannels).toBe(true);
      expect(connector?.defaultModels).toEqual([
        "antigravity/gemini-3.8-flash-high",
        "antigravity/gemini-3.8-flash-medium",
        "antigravity/gemini-3.8-flash-low",
        "antigravity/gemini-3.5-flash-lite",
      ]);
      expect(connector?.defaultModels).toEqual([...DEFAULT_ANTIGRAVITY_POOL_MODELS]);
      // No pool service address is guessed: the operator enters it.
      expect(connector?.defaultBaseUrl ?? null).toBeNull();

      unregisterConnectorsForPlugin("myrmidon.antigravity");
      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(false);
    });

    it("registers google-ai-pool with channels and no ChatGPT models", () => {
      registerConnectorsForPlugin({ pluginKey: "myrmidon.google-ai" });

      const connector = getModelProviderConnector("google-ai-pool");
      expect(connector?.pluginKey).toBe("myrmidon.google-ai");
      expect(connector?.supportsChannels).toBe(true);
      expect(connector?.defaultModels).toBeUndefined();
      expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);
    });

    it("a manifest declaration of a pool type gets the pool defaults for what it leaves out", () => {
      registerConnectorsForPlugin({
        pluginKey: "custom.agy",
        manifestJson: {
          id: "custom.agy",
          apiVersion: 1,
          version: "1.0.0",
          displayName: "Custom",
          description: "Custom",
          author: "Test",
          categories: ["connector"],
          capabilities: ["agent.tools.register"],
          entrypoints: { worker: "./worker.js" },
          modelProviders: [{ type: "antigravity-pool" }, { type: "chatgpt-pool" }],
        } as any,
      });

      const agy = getModelProviderConnector("antigravity-pool");
      expect(agy?.name).toBe("Antigravity Pool");
      expect(agy?.supportsChannels).toBe(true);
      expect(agy?.defaultModels).toEqual([...DEFAULT_ANTIGRAVITY_POOL_MODELS]);
      const chatgpt = getModelProviderConnector("chatgpt-pool");
      expect(chatgpt?.defaultBaseUrl).toBe("http://localhost:8895");
      expect(chatgpt?.defaultModels).toEqual([...DEFAULT_CHATGPT_POOL_MODELS]);
    });

    it("lifecycle events register and unregister the antigravity connector", async () => {
      const lifecycle = new EventEmitter();
      let status = "ready";
      const row = () => ({ id: "agy-1", pluginKey: "myrmidon.antigravity", status, manifestJson: null }) as any;
      const bridge = bindModelProviderPluginLifecycle({
        lifecycle: lifecycle as any,
        registry: { list: async () => [row()], getById: async (id: string) => (id === "agy-1" ? row() : null) },
      });

      lifecycle.emit("plugin.loaded", { pluginId: "agy-1", pluginKey: "myrmidon.antigravity" });
      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(true);
      expect(isModelProviderTypeAvailable("chatgpt-pool")).toBe(false);

      status = "disabled";
      lifecycle.emit("plugin.disabled", { pluginId: "agy-1", pluginKey: "myrmidon.antigravity" });
      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(false);

      bridge.teardown();
    });

    it("syncFromRegistry registers every ready pool plugin and drops a pool plugin that is not ready", async () => {
      const bridge = bindModelProviderPluginLifecycle({
        registry: {
          list: async () =>
            [
              { id: "p1", pluginKey: "myrmidon.chatgpt-pool", status: "ready", manifestJson: null },
              { id: "p2", pluginKey: "myrmidon.antigravity", status: "ready", manifestJson: null },
              { id: "p3", pluginKey: "myrmidon.google-ai", status: "ready", manifestJson: null },
            ] as any[],
          getById: async () => null,
        },
      });
      await bridge.syncFromRegistry();
      expect(listAvailableModelProviderTypes()).toEqual(
        expect.arrayContaining(["chatgpt-pool", "antigravity-pool", "google-ai-pool"]),
      );
      bridge.teardown();

      const stopped = bindModelProviderPluginLifecycle({
        registry: {
          list: async () =>
            [{ id: "p2", pluginKey: "myrmidon.antigravity", status: "error", manifestJson: null }] as any[],
          getById: async () => null,
        },
      });
      await stopped.syncFromRegistry();
      expect(isModelProviderTypeAvailable("antigravity-pool")).toBe(false);
      stopped.teardown();
    });
  });
});
