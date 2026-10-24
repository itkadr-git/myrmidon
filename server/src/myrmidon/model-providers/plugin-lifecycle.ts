// server/src/myrmidon/model-providers/plugin-lifecycle.ts
//
// myrmidon(1.6.6 OPE-7198): production lifecycle bridge connecting installed
// Paperclip plugins (e.g. connectors/chatgpt-pool) to the model-provider
// connector registry.
//
// When a plugin contributing a model-provider connector is installed and moves to
// 'ready', it is automatically registered in listAvailableModelProviderTypes() and
// getModelProviderConnector(), making its provider type available in UI and API.
// When disabled, uninstalled, or errored, it is automatically unregistered,
// returning the type to unavailable status (fail-closed).

import type { Db } from "@myrmidon/db";
import { plugins as pluginsTable } from "@myrmidon/db";
import {
  DEFAULT_CHATGPT_POOL_MODELS,
  registerModelProviderConnector,
  unregisterModelProviderConnectorForPlugin,
  unregisterModelProviderConnectorsByPlugin,
  type PaperclipPluginManifestV1,
  type PluginRecord,
} from "@myrmidon/shared";
import type { PluginLifecycleManager } from "../../services/plugin-lifecycle.js";
import { pluginRegistryService } from "../../services/plugin-registry.js";
import { logger } from "../../middleware/logger.js";

/** Identifies whether a pluginKey belongs to the ChatGPT / Codex subscription pool connector. */
export function isChatGptPoolKey(pluginKey: string): boolean {
  const norm = pluginKey.trim().toLowerCase();
  return (
    norm === "myrmidon.chatgpt-pool" ||
    norm === "paperclip.chatgpt-pool" ||
    norm.endsWith(".chatgpt-pool") ||
    norm === "chatgpt-pool"
  );
}

/** Determines if a plugin contributes model provider connector(s). */
export function isModelProviderPlugin(plugin: {
  pluginKey: string;
  manifestJson?: PaperclipPluginManifestV1 | null;
}): boolean {
  if (isChatGptPoolKey(plugin.pluginKey)) return true;
  const decls = plugin.manifestJson?.modelProviders;
  return Array.isArray(decls) && decls.length > 0;
}

/** Registers connectors contributed by a ready plugin. */
export function registerConnectorsForPlugin(plugin: {
  pluginKey: string;
  manifestJson?: PaperclipPluginManifestV1 | null;
}): void {
  const decls = plugin.manifestJson?.modelProviders;
  if (Array.isArray(decls) && decls.length > 0) {
    for (const d of decls) {
      registerModelProviderConnector({
        type: d.type,
        name: d.name ?? (d.type === "chatgpt-pool" ? "ChatGPT / Codex Subscription Pool" : undefined),
        pluginKey: plugin.pluginKey,
        defaultBaseUrl: d.defaultBaseUrl ?? (d.type === "chatgpt-pool" ? "http://localhost:8895" : null),
        defaultModels: d.defaultModels ?? (d.type === "chatgpt-pool" ? DEFAULT_CHATGPT_POOL_MODELS : undefined),
        supportsChannels: d.supportsChannels ?? (d.type === "chatgpt-pool"),
      });
    }
    return;
  }

  if (isChatGptPoolKey(plugin.pluginKey)) {
    registerModelProviderConnector({
      type: "chatgpt-pool",
      name: "ChatGPT / Codex Subscription Pool",
      pluginKey: plugin.pluginKey,
      defaultBaseUrl: "http://localhost:8895",
      defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
      supportsChannels: true,
    });
  }
}

/** Unregisters connectors contributed by a disabled or uninstalled plugin. */
export function unregisterConnectorsForPlugin(
  pluginKey: string,
  _manifestJson?: PaperclipPluginManifestV1 | null,
): void {
  unregisterModelProviderConnectorForPlugin("chatgpt-pool", pluginKey);
  unregisterModelProviderConnectorForPlugin("gemini", pluginKey);
  unregisterModelProviderConnectorsByPlugin(pluginKey);
}

export interface ModelProviderPluginLifecycleBinding {
  /** Synchronizes connector registrations with the database / plugin registry. */
  syncFromRegistry(): Promise<void>;
  /** Removes lifecycle event listeners. */
  teardown(): void;
}

export interface ModelProviderPluginLifecycleDeps {
  lifecycle?: PluginLifecycleManager;
  registry?: {
    list(): Promise<PluginRecord[]>;
    getById(id: string): Promise<PluginRecord | null>;
  };
  db?: Db;
  log?: typeof logger;
}

/**
 * Connects the plugin lifecycle state machine and registry to the model provider
 * connector registry.
 */
export function bindModelProviderPluginLifecycle(
  deps: ModelProviderPluginLifecycleDeps,
): ModelProviderPluginLifecycleBinding {
  const log = deps.log ?? logger.child({ service: "model-provider-plugin-lifecycle" });
  const registry = deps.registry ?? (deps.db ? pluginRegistryService(deps.db) : undefined);
  const lifecycle = deps.lifecycle;

  async function resolvePluginRecord(pluginId: string, pluginKey: string): Promise<{
    pluginKey: string;
    manifestJson?: PaperclipPluginManifestV1 | null;
  }> {
    if (registry) {
      const row = await registry.getById(pluginId).catch(() => null);
      if (row) return row;
    }
    return { pluginKey, manifestJson: null };
  }

  const unregisterOwnedConnectors = (pluginKey: string, manifestJson?: PaperclipPluginManifestV1 | null) => {
    unregisterConnectorsForPlugin(pluginKey, manifestJson);
  };
  const handlePluginReady = (payload: { pluginId: string; pluginKey: string }) => {
    if (isChatGptPoolKey(payload.pluginKey)) {
      log.info({ pluginKey: payload.pluginKey }, "registering model provider connector for ready plugin");
      registerConnectorsForPlugin({ pluginKey: payload.pluginKey });
      return;
    }
    void resolvePluginRecord(payload.pluginId, payload.pluginKey)
      .then((plugin) => {
        if (isModelProviderPlugin(plugin)) {
          log.info({ pluginKey: plugin.pluginKey }, "registering model provider connector for ready plugin");
          registerConnectorsForPlugin(plugin);
        }
      })
      .catch((err) => {
        log.warn({ err, pluginId: payload.pluginId }, "failed to resolve plugin record for ready event");
      });
  };

  const handlePluginDeactivated = (payload: { pluginId: string; pluginKey: string }) => {
    // Remove the event's provider immediately; registry lookup is asynchronous.
    unregisterOwnedConnectors(payload.pluginKey);
    void resolvePluginRecord(payload.pluginId, payload.pluginKey)
      .then((plugin) => unregisterOwnedConnectors(plugin.pluginKey, plugin.manifestJson))
      .catch((err) => {
        log.warn({ err, pluginId: payload.pluginId }, "failed to unregister model provider connector");
      });
  };

  const handleStatusChanged = (payload: {
    pluginId: string;
    pluginKey: string;
    previousStatus: string;
    newStatus: string;
  }) => {
    if (payload.newStatus === "ready") {
      handlePluginReady(payload);
    } else if (payload.previousStatus === "ready" || payload.newStatus === "disabled" || payload.newStatus === "uninstalled") {
      handlePluginDeactivated(payload);
    }
  };

  if (lifecycle) {
    lifecycle.on("plugin.loaded", handlePluginReady);
    lifecycle.on("plugin.enabled", handlePluginReady);
    lifecycle.on("plugin.disabled", handlePluginDeactivated);
    lifecycle.on("plugin.unloaded", handlePluginDeactivated);
    lifecycle.on("plugin.error", handlePluginDeactivated);
    lifecycle.on("plugin.status_changed", handleStatusChanged as any);
  }

  async function syncFromRegistry(): Promise<void> {
    let rows: Array<{ pluginKey: string; status: string; manifestJson?: PaperclipPluginManifestV1 | null }> = [];
    if (registry) {
      rows = await registry.list();
    } else if (deps.db) {
      rows = await deps.db.select().from(pluginsTable);
    }

    for (const plugin of rows) {
      if (plugin.status === "ready" && isModelProviderPlugin(plugin)) {
        registerConnectorsForPlugin(plugin);
      } else if (isChatGptPoolKey(plugin.pluginKey) && plugin.status !== "ready") {
        unregisterConnectorsForPlugin(plugin.pluginKey, plugin.manifestJson);
      }
    }
  }

  function teardown(): void {
    if (lifecycle) {
      lifecycle.off("plugin.loaded", handlePluginReady);
      lifecycle.off("plugin.enabled", handlePluginReady);
      lifecycle.off("plugin.disabled", handlePluginDeactivated);
      lifecycle.off("plugin.unloaded", handlePluginDeactivated);
      lifecycle.off("plugin.error", handlePluginDeactivated);
      lifecycle.off("plugin.status_changed", handleStatusChanged as any);
    }
  }

  return {
    syncFromRegistry,
    teardown,
  };
}
