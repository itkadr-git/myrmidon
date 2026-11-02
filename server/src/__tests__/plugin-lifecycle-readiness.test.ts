import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { pluginLifecycleManager } from "../services/plugin-lifecycle.js";

function createLifecycle() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    discoverAll: async () => [],
    hasRuntimeServices: () => true,
    loadSingle: async (pluginId: string) => ({
      success: true,
      plugin: { id: pluginId, pluginKey: "example.plugin" },
    }),
  });
}

function createDb(status: string) {
  const plugin = { id: "plugin-id", pluginKey: "example.plugin", status, enabled: true };
  return {
    select: () => ({ from: () => ({ where: async () => [plugin] }) }),
    update: () => ({
      set: (updates: Record<string, unknown>) => ({
        where: () => ({ returning: async () => [{ ...plugin, ...updates }] }),
      }),
    }),
  };
}

describe("plugin lifecycle readiness", () => {
  it("emits ready only after activation succeeds", async () => {
    const lifecycle = pluginLifecycleManager(createDb("disabled") as never, createLifecycle() as never);
    const ready = new Promise<{ pluginId: string; pluginKey: string }>((resolve) => {
      lifecycle.on("plugin.ready", resolve);
    });
    await lifecycle.enable("plugin-id");
    await expect(ready).resolves.toEqual({ pluginId: "plugin-id", pluginKey: "example.plugin" });
  });

  it("does not emit ready when activation fails", async () => {
    const loader = createLifecycle();
    loader.loadSingle = async () => ({
      success: false,
      plugin: { id: "plugin-id", pluginKey: "example.plugin" },
      error: "activation failed",
    });
    const lifecycle = pluginLifecycleManager(createDb("disabled") as never, loader as never);
    let readinessEvents = 0;
    lifecycle.on("plugin.ready", () => { readinessEvents += 1; });
    await expect(lifecycle.enable("plugin-id")).rejects.toThrow("activation failed");
    expect(readinessEvents).toBe(0);
  });
});
