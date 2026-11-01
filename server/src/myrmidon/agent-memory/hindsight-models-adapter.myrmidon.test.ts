// server/src/myrmidon/agent-memory/hindsight-models-adapter.myrmidon.test.ts
//
// OPE-9858: Tests for Hindsight model groups adapter.
// Validates mock config storage, persistence without server restart,
// zero secret/env mutation, role mapping, and explicit limitations.

import { describe, expect, it } from "vitest";
import {
  formatHindsightApiLimitations,
  groupToHindsightRole,
  hindsightModelsAdapter,
  hindsightRoleToGroup,
  isHindsightGroup,
} from "./hindsight-models-adapter.js";
import { AGENT_MEMORY_SETTINGS_KEY } from "./settings.js";

function makeMemoryStorage(initial: Record<string, unknown> = {}) {
  let general = { ...initial };
  return {
    adapter: hindsightModelsAdapter({
      getGeneral: async () => ({ ...general }),
      updateGeneral: async (patch) => {
        general = { ...general, ...patch };
      },
      env: { MYRMIDON_HINDSIGHT_API_KEY: "secret-env-key-do-not-touch" },
    }),
    getGeneral: () => general,
  };
}

describe("hindsight-models-adapter", () => {
  it("provides bidirectional role <-> group mapping", () => {
    expect(hindsightRoleToGroup("write")).toBe("hindsight-write");
    expect(hindsightRoleToGroup("summarize")).toBe("hindsight-summarize");
    expect(hindsightRoleToGroup("search")).toBe("hindsight-search");

    expect(groupToHindsightRole("hindsight-write")).toBe("write");
    expect(groupToHindsightRole("hindsight-summarize")).toBe("summarize");
    expect(groupToHindsightRole("hindsight-search")).toBe("search");
    expect(groupToHindsightRole("write")).toBe("write");
    expect(groupToHindsightRole("other-group")).toBeNull();

    expect(isHindsightGroup("hindsight-write")).toBe(true);
    expect(isHindsightGroup("unknown")).toBe(false);
  });

  it("lists explicit API limitations including OPE-9469 dependency", () => {
    const limitations = formatHindsightApiLimitations();
    expect(limitations.runtimeDependency).toBe("OPE-9469");
    expect(limitations.summary).toContain("OPE-9469");
    expect(limitations.items.length).toBeGreaterThanOrEqual(4);
    expect(limitations.items.some((item) => item.includes("OPE-9469"))).toBe(true);
    expect(limitations.items.some((item) => item.toLowerCase().includes("re-indexing") || item.toLowerCase().includes("reindex"))).toBe(true);
  });

  it("returns default gpt-4o-mini models when no settings are stored", async () => {
    const { adapter } = makeMemoryStorage();
    const catalog = await adapter.getCatalog();

    expect(catalog.status).toBe("mock_stored");
    expect(catalog.hotReloadDependency).toBe("OPE-9469");
    expect(catalog.hotReloadAvailable).toBe(false);
    expect(catalog.groups).toHaveLength(3);

    const writeGroup = catalog.groups.find((g) => g.role === "write");
    expect(writeGroup).toBeDefined();
    expect(writeGroup?.group).toBe("hindsight-write");
    expect(writeGroup?.model).toBe("gpt-4o-mini");
    expect(writeGroup?.source).toBe("default");

    const summarizeGroup = catalog.groups.find((g) => g.role === "summarize");
    expect(summarizeGroup?.model).toBe("gpt-4o-mini");

    const searchGroup = catalog.groups.find((g) => g.role === "search");
    expect(searchGroup?.model).toBe("gpt-4o-mini");
  });

  it("persists updated model for a role without restart and updates settings", async () => {
    const { adapter, getGeneral } = makeMemoryStorage();

    const updated = await adapter.updateCatalog({
      role: "write",
      model: "claude-3-5-haiku",
    });

    const writeGroup = updated.groups.find((g) => g.role === "write");
    expect(writeGroup?.model).toBe("claude-3-5-haiku");
    expect(writeGroup?.source).toBe("setting");

    // Stored directly in general.agentMemory
    const stored = getGeneral()[AGENT_MEMORY_SETTINGS_KEY] as Record<string, unknown>;
    expect(stored).toBeDefined();
    expect((stored.hindsightModels as Record<string, string>)?.write).toBe("claude-3-5-haiku");
    expect(stored.writeModel).toBe("claude-3-5-haiku");
  });

  it("updates multiple roles at once via models dictionary", async () => {
    const { adapter } = makeMemoryStorage();

    const updated = await adapter.updateCatalog({
      models: {
        write: "qwen-plus",
        summarize: "claude-3-5-sonnet",
        search: "bge-m3",
      },
    });

    const byRole = Object.fromEntries(updated.groups.map((g) => [g.role, g.model]));
    expect(byRole.write).toBe("qwen-plus");
    expect(byRole.summarize).toBe("claude-3-5-sonnet");
    expect(byRole.search).toBe("bge-m3");
  });

  it("resets role to default when set to null", async () => {
    const { adapter } = makeMemoryStorage();

    await adapter.updateCatalog({
      write: "custom-write-model",
    });

    let catalog = await adapter.getCatalog();
    expect(catalog.groups.find((g) => g.role === "write")?.model).toBe("custom-write-model");

    // Reset with null
    catalog = await adapter.updateCatalog({
      write: null,
    });
    expect(catalog.groups.find((g) => g.role === "write")?.model).toBe("gpt-4o-mini");
    expect(catalog.groups.find((g) => g.role === "write")?.source).toBe("default");
  });

  it("never mutates secrets, API keys, or process environment", async () => {
    const initialEnv = process.env.MYRMIDON_HINDSIGHT_API_KEY;
    const { adapter, getGeneral } = makeMemoryStorage({
      [AGENT_MEMORY_SETTINGS_KEY]: {
        apiUrl: "http://memory.internal:8000",
        keySecretName: "existing-secret-ref",
      },
    });

    await adapter.updateCatalog({
      write: "new-write-model",
    });

    const stored = getGeneral()[AGENT_MEMORY_SETTINGS_KEY] as Record<string, unknown>;
    expect(stored.keySecretName).toBe("existing-secret-ref");
    expect(stored.apiUrl).toBe("http://memory.internal:8000");
    expect(process.env.MYRMIDON_HINDSIGHT_API_KEY).toBe(initialEnv);
  });
});
