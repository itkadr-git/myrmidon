/**
 * Regression test for PAP-9585.
 *
 * `restartWorker` is called by the dev file-watcher whenever a local-path
 * plugin's source files change. Before PAP-9585 it only bounced the worker
 * subprocess, which left newly added `migrations/*.sql` files unapplied — the
 * plugin schema would silently drift out of sync with worker code.
 *
 * The fix is for `restartWorker` to do a full deactivate + reactivate cycle
 * via the plugin loader, which re-reads the manifest from disk and runs
 * `applyMigrations` (idempotently) before starting the new worker.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const pluginRecord = {
  id: "plugin-1",
  pluginKey: "example.plugin",
  status: "ready",
  manifestJson: { id: "example.plugin", capabilities: [] },
  packageName: "@example/plugin",
  version: "1.0.0",
  packagePath: "/tmp/example-plugin",
  companyId: "company-1",
};

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
  update: vi.fn(),
  updateStatus: vi.fn(),
  upsertConfig: vi.fn(),
  getConfig: vi.fn(),
  listConfigs: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
}));

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-loader.js", () => ({
  pluginLoader: vi.fn(),
}));
vi.mock("@paperclipai/plugin-sdk", () => ({ PLUGIN_RPC_ERROR_CODES: {} }));

import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";
import { getPluginProviderModels, listPluginProviderModels } from "../myrmidon/plugin-provider-models.js";
import type { PluginLoader } from "../services/plugin-loader.js";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.js";

function makeWorkerManagerStub() {
  const handle = {
    restart: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    handle,
    workerManager: {
      getWorker: vi.fn().mockReturnValue(handle),
      isRunning: vi.fn().mockReturnValue(true),
      startWorker: vi.fn().mockResolvedValue(undefined),
      stopWorker: vi.fn().mockResolvedValue(undefined),
      restartWorker: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginWorkerManager,
  };
}

describe("pluginLifecycleManager.restartWorker", () => {
  beforeEach(() => {
    mockRegistry.listConfigs.mockResolvedValue([{ companyId: "company-1" }]);
  });
  it("exposes declared models only while plugin records are ready", async () => {
    const ready = {
      ...pluginRecord,
      manifestJson: {
        id: "example.plugin", capabilities: [],
        providerModels: { provider: "example", baseUrl: "https://api.example.com/v1", credentialSecretName: "example-key", models: [{ id: "one" }, { id: "two", label: "Two" }] },
      },
    } as never;
    expect(listPluginProviderModels([ready]).map((model) => model.modelId)).toEqual(["example/one", "example/two"]);
    expect(listPluginProviderModels([{ ...ready, status: "disabled" } as never])).toEqual([]);
    expect(getPluginProviderModels(ready.companyId)).toEqual([]);
    const lifecycle = pluginLifecycleManager({} as never, { loader: {} as PluginLoader });
    const activationFailureLoader = {
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({
        success: false,
        error: "activation failed",
        plugin: ready,
      }),
    } as unknown as PluginLoader;
    const failingLifecycle = pluginLifecycleManager({} as never, { loader: activationFailureLoader });
    mockRegistry.getById.mockResolvedValue({ ...ready, status: "disabled" });
    mockRegistry.updateStatus.mockImplementation(async (_id: string, value: { status: string }) => ({ ...ready, ...value }));
    await expect(failingLifecycle.enable("plugin-1")).rejects.toThrow("activation failed");
    expect(getPluginProviderModels(ready.companyId)).toEqual([]);

    mockRegistry.getById.mockResolvedValue(ready);
    mockRegistry.updateStatus.mockImplementation(async (_id: string, value: { status: string }) => ({ ...ready, ...value }));
    await lifecycle.disable("plugin-1");
    expect(getPluginProviderModels(ready.companyId)).toEqual([]);
    mockRegistry.getById.mockResolvedValue({ ...ready, status: "disabled" });
    await lifecycle.enable("plugin-1");
    expect(getPluginProviderModels(ready.companyId).map((model) => model.modelId)).toEqual(["example/one", "example/two"]);
    mockRegistry.getById.mockResolvedValue(ready);
    await lifecycle.disable("plugin-1");
    expect(getPluginProviderModels(ready.companyId)).toEqual([]);
  });

  it("marks a newly loaded plugin as errored when runtime activation fails", async () => {
    const installed = {
      ...pluginRecord,
      status: "installed",
      manifestJson: {
        id: "example.plugin", capabilities: [],
        providerModels: { provider: "example", baseUrl: "https://api.example.com/v1", credentialSecretName: "example-key", models: [{ id: "one" }] },
      },
    } as never;
    const activationFailureLoader = {
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({
        success: false,
        error: "activation failed",
        plugin: installed,
      }),
    } as unknown as PluginLoader;
    const lifecycle = pluginLifecycleManager({} as never, { loader: activationFailureLoader });
    mockRegistry.getById.mockResolvedValue(installed);
    mockRegistry.updateStatus.mockImplementation(async (_id: string, value: { status: string; lastError?: string | null }) => ({
      ...installed,
      ...value,
    }));

    await expect(lifecycle.load("plugin-1")).rejects.toThrow("activation failed");
    expect(mockRegistry.updateStatus).toHaveBeenLastCalledWith("plugin-1", {
      status: "error",
      lastError: "activation failed",
    });
    expect(getPluginProviderModels(installed.companyId)).toEqual([]);
  });

  it("re-registers dynamic models idempotently when plugin is enabled", async () => {
    const ready = {
      ...pluginRecord,
      manifestJson: {
        id: "example.plugin", capabilities: [],
        providerModels: { provider: "example", baseUrl: "https://api.example.com/v1", credentialSecretName: "example-key", models: [{ id: "one" }] },
      },
    } as never;
    const lifecycle = pluginLifecycleManager({} as never, { loader: {} as PluginLoader });
    mockRegistry.getById.mockResolvedValue({ ...ready, status: "disabled" });
    mockRegistry.updateStatus.mockImplementation(async (_id: string, value: { status: string }) => ({ ...ready, ...value }));
    await lifecycle.enable("plugin-1");
    mockRegistry.getById.mockResolvedValue(ready);
    await lifecycle.disable("plugin-1");
    mockRegistry.getById.mockResolvedValue({ ...ready, status: "disabled" });
    await lifecycle.enable("plugin-1");
    expect(getPluginProviderModels(ready.companyId)).toHaveLength(1);
    mockRegistry.getById.mockResolvedValue(ready);
    await lifecycle.disable("plugin-1");
  });

  it("syncs provider models on runtime enable and removes them on disable", async () => {
    const ready = {
      ...pluginRecord,
      status: "disabled",
      manifestJson: {
        id: "example.plugin", capabilities: [],
        providerModels: {
          provider: "example",
          baseUrl: "https://api.example.com/v1",
          credentialSecretName: "example-key",
          models: [{ id: "one" }],
        },
      },
    } as never;
    const sync = vi.fn().mockResolvedValue(undefined);
    const remove = vi.fn().mockResolvedValue(undefined);
    const loader = {
      hasRuntimeServices: vi.fn().mockReturnValue(true),
      loadSingle: vi.fn().mockResolvedValue({ success: true, plugin: { ...ready, status: "ready" } }),
      unloadSingle: vi.fn().mockResolvedValue(undefined),
    } as unknown as PluginLoader;
    const lifecycle = pluginLifecycleManager({} as never, {
      loader,
      providerModelSync: { sync, remove },
    });
    mockRegistry.getById.mockResolvedValue(ready);
    mockRegistry.updateStatus.mockImplementation(async (_id: string, value: { status: string }) => ({
      ...ready,
      ...value,
    }));

    await lifecycle.enable("plugin-1");
    expect(sync).toHaveBeenCalledWith("company-1", expect.objectContaining({ id: "plugin-1" }));

    mockRegistry.getById.mockResolvedValue({ ...ready, status: "ready" });
    await lifecycle.disable("plugin-1");
    expect(remove).toHaveBeenCalledWith("company-1", expect.objectContaining({ id: "plugin-1" }));
    expect(getPluginProviderModels("company-1")).toEqual([]);
  });

  it("does a full deactivate+reactivate cycle when the loader has runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(true) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn().mockResolvedValue({
        success: true,
        plugin: pluginRecord,
        registered: { worker: true, eventSubscriptions: 0, jobs: 0, webhooks: 0, tools: 0 },
      }) as PluginLoader["loadSingle"],
      unloadSingle: vi.fn().mockResolvedValue(undefined) as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).toHaveBeenCalledWith("plugin-1", "example.plugin");
    expect(loader.loadSingle).toHaveBeenCalledWith("plugin-1");
    // The bare worker handle should NOT be bounced — the loader handles
    // worker (re)start as part of activate.
    expect(handle.restart).not.toHaveBeenCalled();
    expect(stopped).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  it("falls back to bouncing the worker handle when the loader has no runtime services", async () => {
    mockRegistry.getById.mockResolvedValue(pluginRecord);
    mockRegistry.updateStatus.mockResolvedValue(pluginRecord);

    const { handle, workerManager } = makeWorkerManagerStub();

    const loader: Partial<PluginLoader> = {
      hasRuntimeServices: vi.fn().mockReturnValue(false) as PluginLoader["hasRuntimeServices"],
      loadSingle: vi.fn() as PluginLoader["loadSingle"],
      unloadSingle: vi.fn() as PluginLoader["unloadSingle"],
    };

    const lifecycle = pluginLifecycleManager(
      {} as never,
      { loader: loader as PluginLoader, workerManager },
    );
    const stopped = vi.fn();
    const started = vi.fn();
    lifecycle.on("plugin.worker_stopped", stopped);
    lifecycle.on("plugin.worker_started", started);

    await lifecycle.restartWorker("plugin-1");

    expect(loader.unloadSingle).not.toHaveBeenCalled();
    expect(loader.loadSingle).not.toHaveBeenCalled();
    expect(handle.restart).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(stopped).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
    expect(started).toHaveBeenCalledTimes(1);
    expect(started).toHaveBeenCalledWith({ pluginId: "plugin-1", pluginKey: "example.plugin" });
  });
});
