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
  DEFAULT_ANTIGRAVITY_POOL_MODELS,
  DEFAULT_CHATGPT_POOL_MODELS,
  isPoolModelProviderType,
  registerModelProviderConnector,
  unregisterModelProviderConnectorForPlugin,
  unregisterModelProviderConnectorsByPlugin,
  type PaperclipPluginManifestV1,
  type PluginRecord,
  type PoolModelProviderType,
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

/** Identifies whether a pluginKey belongs to the Google Antigravity subscription pool connector. */
export function isAntigravityPoolKey(pluginKey: string): boolean {
  const norm = pluginKey.trim().toLowerCase();
  return (
    norm === "myrmidon.antigravity" ||
    norm === "paperclip.antigravity" ||
    norm.endsWith(".antigravity") ||
    norm === "antigravity"
  );
}

/** Identifies whether a pluginKey belongs to the Google AI Pro subscription pool connector. */
export function isGoogleAiPoolKey(pluginKey: string): boolean {
  const norm = pluginKey.trim().toLowerCase();
  return (
    norm === "myrmidon.google-ai" ||
    norm === "paperclip.google-ai" ||
    norm.endsWith(".google-ai") ||
    norm === "google-ai"
  );
}

/** The pool connector type a plugin key stands for, or null when it is not a pool plugin. */
export function poolConnectorTypeForPluginKey(pluginKey: string): PoolModelProviderType | null {
  if (isChatGptPoolKey(pluginKey)) return "chatgpt-pool";
  if (isAntigravityPoolKey(pluginKey)) return "antigravity-pool";
  if (isGoogleAiPoolKey(pluginKey)) return "google-ai-pool";
  return null;
}

/** True when the plugin key is one of the three subscription pool connectors. */
export function isPoolConnectorPluginKey(pluginKey: string): boolean {
  return poolConnectorTypeForPluginKey(pluginKey) !== null;
}

/**
 * What a pool connector registers when its plugin is ready and the manifest
 * does not say otherwise. The antigravity model ids are the names of the
 * gateway model groups. The antigravity and google-ai base URL is the address
 * of the pool service as the board container reaches it; it differs per
 * deployment, so it has no default and the operator enters it.
 */
const POOL_CONNECTOR_DEFAULTS: Record<
  PoolModelProviderType,
  { name: string; defaultBaseUrl: string | null; defaultModels: readonly string[] | undefined }
> = {
  "chatgpt-pool": {
    name: "ChatGPT / Codex Subscription Pool",
    defaultBaseUrl: "http://localhost:8895",
    defaultModels: DEFAULT_CHATGPT_POOL_MODELS,
  },
  "antigravity-pool": {
    name: "Antigravity Pool",
    defaultBaseUrl: null,
    defaultModels: DEFAULT_ANTIGRAVITY_POOL_MODELS,
  },
  "google-ai-pool": {
    name: "Google AI Pool",
    defaultBaseUrl: null,
    defaultModels: undefined,
  },
};

/** Determines if a plugin contributes model provider connector(s). */
export function isModelProviderPlugin(plugin: {
  pluginKey: string;
  manifestJson?: PaperclipPluginManifestV1 | null;
}): boolean {
  if (isPoolConnectorPluginKey(plugin.pluginKey)) return true;
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
      const pool = isPoolModelProviderType(d.type) ? POOL_CONNECTOR_DEFAULTS[d.type] : undefined;
      registerModelProviderConnector({
        type: d.type,
        name: d.name ?? pool?.name,
        pluginKey: plugin.pluginKey,
        defaultBaseUrl: d.defaultBaseUrl ?? pool?.defaultBaseUrl ?? null,
        defaultModels: d.defaultModels ?? pool?.defaultModels,
        supportsChannels: d.supportsChannels ?? Boolean(pool),
      });
    }
    return;
  }

  // No manifest declaration: the three subscription pool plugins register by
  // their plugin key (the installed antigravity and google-ai plugins do not
  // declare modelProviders in their manifests).
  const poolType = poolConnectorTypeForPluginKey(plugin.pluginKey);
  if (poolType) {
    const pool = POOL_CONNECTOR_DEFAULTS[poolType];
    registerModelProviderConnector({
      type: poolType,
      name: pool.name,
      pluginKey: plugin.pluginKey,
      defaultBaseUrl: pool.defaultBaseUrl,
      defaultModels: pool.defaultModels,
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
    if (isPoolConnectorPluginKey(payload.pluginKey)) {
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
      } else if (isPoolConnectorPluginKey(plugin.pluginKey) && plugin.status !== "ready") {
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
