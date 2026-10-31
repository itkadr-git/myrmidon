import { describe, expect, it, vi } from "vitest";
import { MODEL_MENU_DEFAULT_ADAPTER_TYPE, modelMenuService } from "./service.js";
import type { ModelMenuServiceDeps } from "./service.js";
import type { ModelMenuActor } from "./service.js";

/**
 * The setting is one settings row, and every read goes back to it: the tests
 * below save through `update` and then read again through the same deps, which
 * is what "the change applies without a restart" means for the bot.
 */

const CATALOG = [
  { id: "qwen3-max", label: "Qwen3 Max" },
  { id: "zai/glm-4.6", label: "GLM 4.6" },
  { id: "gpt-5.2", label: "GPT-5.2" },
];

const actor: ModelMenuActor = {
  actorType: "user",
  actorId: "user-1",
  agentId: null,
  runId: null,
  agentApiKeyId: null,
};

function deps(overrides: Partial<ModelMenuServiceDeps> = {}, stored: unknown = undefined): ModelMenuServiceDeps {
  const settingsRow: { modelMenu?: unknown } = stored === undefined ? {} : { modelMenu: stored };
  return {
    settings: {
      getGeneral: async () => settingsRow,
      updateGeneral: async (patch) => {
        settingsRow.modelMenu = patch.modelMenu;
        return patch;
      },
    },
    listCompanyIds: async () => ["company-1"],
    logActivity: vi.fn(async () => undefined),
    listModels: async () => CATALOG,
    listAdapterTypes: async () => [
      { type: MODEL_MENU_DEFAULT_ADAPTER_TYPE, label: MODEL_MENU_DEFAULT_ADAPTER_TYPE },
      { type: "claude_local", label: "claude_local" },
    ],
    ...overrides,
  };
}

describe("modelMenuService read", () => {
  it("groups the catalog automatically when nothing is stored", async () => {
    const service = modelMenuService(deps());
    const view = await service.read();

    expect(view.adapterType).toBe(MODEL_MENU_DEFAULT_ADAPTER_TYPE);
    expect(view.catalog).toEqual(CATALOG);
    expect(view.stored).toBeNull();
    expect(view.menu.source).toBe("default");
    expect([...view.menu.visibleModelIds].sort()).toEqual(["gpt-5.2", "qwen3-max", "zai/glm-4.6"]);
    expect(view.menu.hiddenModelIds).toEqual([]);
  });

  it("resolves against the requested adapter type", async () => {
    const listModels = vi.fn(async (adapterType: string) =>
      adapterType === "claude_local" ? [{ id: "claude-opus-5", label: "Opus 5" }] : CATALOG,
    );
    const service = modelMenuService(deps({ listModels }));
    const view = await service.read({ adapterType: "claude_local" });

    expect(view.adapterType).toBe("claude_local");
    expect(view.catalog).toEqual([{ id: "claude-opus-5", label: "Opus 5" }]);
    expect(view.menu.visibleModelIds).toEqual(["claude-opus-5"]);
  });

  it("falls back to the automatic menu when the stored row is unusable", async () => {
    const service = modelMenuService(deps({}, { groups: "not a tree" }));
    const view = await service.read();

    expect(view.stored).toBeNull();
    expect(view.menu.source).toBe("default");
    expect([...view.menu.visibleModelIds].sort()).toEqual(["gpt-5.2", "qwen3-max", "zai/glm-4.6"]);
  });
});

describe("modelMenuService update", () => {
  it("saves the tree, audits it for every company and shows it on the next read", async () => {
    const logActivity = vi.fn();
    const base = deps({ logActivity });
    const service = modelMenuService(base);

    const saved = await service.update({ groups: [{ title: "Мои", models: ["gpt-5.2"] }] }, actor);
    expect(saved.stored).toEqual({ groups: [{ title: "Мои", models: ["gpt-5.2"] }] });
    expect(saved.menu.source).toBe("settings");
    // The resolved menu is the configured groups plus «Новые» for the rest.
    expect(saved.menu.groups.map((group) => group.title)).toEqual(["Мои", "Новые"]);
    // «Новые»: the catalog models the tree does not mention are not lost.
    expect(saved.menu.newModelIds.sort()).toEqual(["qwen3-max", "zai/glm-4.6"]);
    expect(saved.menu.groups.find((group) => group.title === "Новые")?.models.map((m) => m.id).sort()).toEqual([
      "qwen3-max",
      "zai/glm-4.6",
    ]);

    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.action).toBe("instance.model_menu.updated");
    expect(entry.companyId).toBe("company-1");
    expect(entry.entityId).toBe("model-menu");
    expect(entry.details.changedKeys).toEqual(["groups"]);

    // A second read — a later `/model` — sees the saved tree: no restart.
    const again = await service.read();
    expect(again.stored).toEqual({ groups: [{ title: "Мои", models: ["gpt-5.2"] }] });
    expect(again.menu.source).toBe("settings");
  });

  it("keeps the stored hidden list when the patch only changes the tree", async () => {
    const logActivity = vi.fn();
    const service = modelMenuService(deps({ logActivity }, { hidden: ["zai/glm-4.6"] }));

    const view = await service.update({ groups: [{ title: "Мои", models: ["gpt-5.2"] }] }, actor);
    expect(view.stored).toEqual({
      groups: [{ title: "Мои", models: ["gpt-5.2"] }],
      hidden: ["zai/glm-4.6"],
    });
    expect(view.menu.hiddenModelIds).toEqual(["zai/glm-4.6"]);
    expect(view.menu.visibleModelIds.sort()).toEqual(["gpt-5.2", "qwen3-max"]);

    const entry = (logActivity as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(entry.details.changedKeys).toEqual(["groups"]);
    expect(entry.details.previous).toEqual({ hidden: ["zai/glm-4.6"] });
  });

  it("clears a key the patch sends explicitly", async () => {
    const service = modelMenuService(deps({}, { hidden: ["zai/glm-4.6"] }));

    const view = await service.update({ hidden: [] }, actor);
    expect(view.stored).toEqual({ hidden: [] });
    expect(view.menu.hiddenModelIds).toEqual([]);
    expect(view.menu.visibleModelIds.sort()).toEqual(["gpt-5.2", "qwen3-max", "zai/glm-4.6"]);
  });
});