import { describe, expect, it } from "vitest";

import {
  MODEL_MENU_MAX_DEPTH,
  MODEL_MENU_NEW_GROUP_TITLE,
  MODEL_MENU_OTHER_FAMILY_KEY,
  collectModelIds,
  countModelMenuModels,
  modelMenuDepth,
  modelMenuFamilyKey,
  modelMenuFamilyTitle,
  normalizeModelMenuSettings,
  resolveModelMenu,
} from "./myrmidon-model-menu.js";

/**
 * myrmidon(1.6.6 MODEL-MENU A): the settings shape and the resolution rules
 * of the model menu. The bot and the web editor both read the result of
 * `resolveModelMenu`, so these cases are the contract of the feature: the
 * order of the automatic groups, the tree from the settings row, the «Новые»
 * group that keeps a new catalog model from disappearing, and the arithmetic
 * `visible = catalog − hidden`.
 */

const CATALOG = [
  { id: "qwen3-max" },
  { id: "qwen2.5-72b-instruct", label: "Qwen2.5 72B" },
  { id: "glm-4.6" },
  { id: "gemini-2.5-pro" },
  { id: "deepseek-chat" },
  { id: "gpt-5" },
  { id: "claude-sonnet-4" },
  { id: "acme-1" },
];

const CATALOG_IDS = CATALOG.map((model) => model.id);

describe("model menu families", () => {
  it("recognises the providers the owner groups by", () => {
    expect(modelMenuFamilyKey("qwen3-max")).toBe("dashscope");
    expect(modelMenuFamilyKey("glm-4.6")).toBe("zai");
    expect(modelMenuFamilyKey("gemini-2.5-pro")).toBe("google");
    expect(modelMenuFamilyKey("deepseek-chat")).toBe("deepseek");
    expect(modelMenuFamilyKey("gpt-5")).toBe("openai");
    expect(modelMenuFamilyKey("claude-sonnet-4")).toBe("anthropic");
  });

  it("keeps the leading families first, then alphabetical, then the other bucket", () => {
    const { groups } = resolveModelMenu({ catalog: CATALOG });
    expect(groups.map((group) => group.title)).toEqual([
      "DashScope",
      "z.ai",
      "Anthropic",
      "DeepSeek",
      "Google",
      "OpenAI",
      "Прочие",
    ]);
  });

  it("titles a family key and names the other bucket", () => {
    expect(modelMenuFamilyTitle("zai")).toBe("z.ai");
    expect(modelMenuFamilyTitle(MODEL_MENU_OTHER_FAMILY_KEY)).toBe("Прочие");
    expect(modelMenuFamilyTitle("something-new")).toBe("something-new");
  });
});

describe("resolveModelMenu without stored settings", () => {
  it("builds the automatic menu and reports it as the default one", () => {
    const menu = resolveModelMenu({ catalog: CATALOG });
    expect(menu.source).toBe("default");
    expect(menu.newModelIds).toEqual([]);
    expect(menu.hiddenModelIds).toEqual([]);
    expect(menu.missingModelIds).toEqual([]);
    expect(countModelMenuModels(menu.groups)).toBe(CATALOG_IDS.length);
    expect(menu.visibleModelIds).toEqual(expect.arrayContaining(CATALOG_IDS));
  });

  it("keeps the catalog order inside a group and labels a model by its id when the catalog has none", () => {
    const menu = resolveModelMenu({ catalog: CATALOG });
    const dashscope = menu.groups.find((group) => group.family === "dashscope");
    expect(dashscope?.models.map((model) => model.id)).toEqual([
      "qwen3-max",
      "qwen2.5-72b-instruct",
    ]);
    expect(dashscope?.models[0]?.label).toBe("qwen3-max");
    expect(dashscope?.models[1]?.label).toBe("Qwen2.5 72B");
  });

  it("treats an empty tree as no tree", () => {
    const menu = resolveModelMenu({ catalog: CATALOG, settings: { groups: [] } });
    expect(menu.source).toBe("default");
  });

  it("ignores a settings row that does not validate, as a whole", () => {
    const menu = resolveModelMenu({
      catalog: CATALOG,
      settings: { groups: [{ title: "" }] },
    });
    expect(menu.source).toBe("default");
    expect(countModelMenuModels(menu.groups)).toBe(CATALOG_IDS.length);
  });
});

describe("resolveModelMenu with a stored tree", () => {
  const SETTINGS = {
    groups: [
      {
        title: "Go",
        models: ["gemini-2.5-pro"],
        children: [
          { title: "Go mini", models: ["gemini-2.5-flash"] },
        ],
      },
      { title: "DeepSeek", models: ["deepseek-chat", "deepseek-reasoner"] },
    ],
    hidden: ["acme-1"],
  };

  it("renders the tree in the configured order and keeps the nesting", () => {
    const menu = resolveModelMenu({ catalog: [...CATALOG, { id: "gemini-2.5-flash" }], settings: SETTINGS });
    expect(menu.source).toBe("settings");
    expect(menu.groups.map((group) => group.title)).toEqual(["Go", "DeepSeek", MODEL_MENU_NEW_GROUP_TITLE]);
    expect(menu.groups[0]?.children.map((group) => group.title)).toEqual(["Go mini"]);
    expect(menu.groups[0]?.models.map((model) => model.id)).toEqual(["gemini-2.5-pro"]);
    expect(menu.groups[0]?.children[0]?.models.map((model) => model.id)).toEqual([
      "gemini-2.5-flash",
    ]);
  });

  it("collects every catalog model the tree misses into «Новые»", () => {
    const menu = resolveModelMenu({ catalog: [...CATALOG, { id: "gemini-2.5-flash" }], settings: SETTINGS });
    const fresh = menu.groups.at(-1);
    expect(fresh?.title).toBe(MODEL_MENU_NEW_GROUP_TITLE);
    expect(menu.newModelIds).toEqual([
      "qwen3-max",
      "qwen2.5-72b-instruct",
      "glm-4.6",
      "gpt-5",
      "claude-sonnet-4",
    ]);
    expect(fresh?.models.map((model) => model.id)).toEqual(menu.newModelIds);
  });

  it("never shows a hidden model, and keeps visible = catalog − hidden", () => {
    const menu = resolveModelMenu({ catalog: CATALOG, settings: SETTINGS });
    expect(menu.hiddenModelIds).toEqual(["acme-1"]);
    expect(menu.visibleModelIds).not.toContain("acme-1");
    expect(menu.visibleModelIds.sort()).toEqual(
      CATALOG_IDS.filter((id) => id !== "acme-1").sort(),
    );
  });

  it("drops a group that holds nothing visible", () => {
    const menu = resolveModelMenu({
      catalog: CATALOG,
      settings: { groups: [{ title: "Empty", models: ["acme-1"] }], hidden: ["acme-1"] },
    });
    expect(menu.groups.map((group) => group.title)).toEqual([MODEL_MENU_NEW_GROUP_TITLE]);
    expect(menu.visibleModelIds).toHaveLength(CATALOG_IDS.length - 1);
  });

  it("reports a model the tree names but the catalog does not offer, and does not invent it", () => {
    const menu = resolveModelMenu({
      catalog: CATALOG,
      settings: { groups: [{ title: "Go", models: ["gemini-9-ultra"] }] },
    });
    expect(menu.missingModelIds).toEqual(["gemini-9-ultra"]);
    expect(menu.visibleModelIds).not.toContain("gemini-9-ultra");
    expect(menu.groups.map((group) => group.title)).toEqual([MODEL_MENU_NEW_GROUP_TITLE]);
  });

  it("keeps a model named twice once, at its first position", () => {
    const menu = resolveModelMenu({
      catalog: CATALOG,
      settings: {
        groups: [
          { title: "A", models: ["gpt-5"] },
          { title: "B", models: ["gpt-5"] },
        ],
      },
    });
    expect(menu.duplicateModelIds).toEqual(["gpt-5"]);
    expect(menu.groups.map((group) => group.title)).toEqual(["A", MODEL_MENU_NEW_GROUP_TITLE]);
    expect(collectModelIds(menu.groups).filter((id) => id === "gpt-5")).toHaveLength(1);
  });

  it("counts the depth of the tree and refuses a tree deeper than the limit", () => {
    const nested = (depth: number) => {
      let node: { title: string; children?: unknown[] } = { title: `L${depth}` };
      for (let level = depth - 1; level >= 1; level -= 1) {
        node = { title: `L${level}`, children: [node] };
      }
      return node;
    };

    const deepEnough = { groups: [nested(MODEL_MENU_MAX_DEPTH)] };
    expect(normalizeModelMenuSettings(deepEnough)).not.toBeNull();

    const tooDeep = { groups: [nested(MODEL_MENU_MAX_DEPTH + 1)] };
    expect(normalizeModelMenuSettings(tooDeep)).toBeNull();

    const menu = resolveModelMenu({ catalog: CATALOG, settings: tooDeep });
    expect(menu.source).toBe("default");
  });

  it("measures the depth of a resolved tree", () => {
    const menu = resolveModelMenu({
      catalog: CATALOG,
      settings: { groups: [{ title: "A", children: [{ title: "B", models: ["gpt-5"] }] }] },
    });
    expect(modelMenuDepth(menu.groups)).toBe(2);
    expect(modelMenuDepth([])).toBe(0);
  });
});