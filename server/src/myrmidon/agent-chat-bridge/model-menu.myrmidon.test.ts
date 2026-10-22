import { describe, expect, it } from "vitest";
import {
  collectModelIds,
  resolveModelMenu,
  type ModelMenuNode,
  type ResolvedModelMenu,
} from "@paperclipai/shared";
import {
  MODEL_MENU_ENTRY_LABEL_MAX_CHARS,
  MODEL_MENU_MAX_ENTRIES,
  MODEL_MENU_PAGE_SIZE,
  buildModelMenuScreen,
  modelMenuNodeAtPath,
  modelMenuNodeModelCount,
  truncateModelMenuEntryLabel,
  type ModelMenuScreenLabels,
} from "./model-menu.js";

/**
 * myrmidon(1.6.6 MODEL-MENU A): the screens of `/model`.
 *
 * The ticket's own acceptance list is here: the tree from the settings row
 * shows up as the buttons of the first screen; a group opens, «Назад» returns
 * and «Ещё →» walks a long group; and the visible models are exactly the
 * catalog minus the hidden ones.
 */

const LABELS: ModelMenuScreenLabels = {
  rootTitle: "Модель бота",
  back: "Назад",
  more: "Ещё →",
};

function model(id: string, label?: string) {
  return { id, label: label ?? id };
}

function menuOf(groups: ModelMenuNode[]): ResolvedModelMenu {
  return {
    groups,
    visibleModelIds: collectModelIds(groups),
    hiddenModelIds: [],
    missingModelIds: [],
    duplicateModelIds: [],
    newModelIds: [],
    source: "settings",
  };
}

describe("buildModelMenuScreen at the root", () => {
  const catalog = [
    { id: "qwen3-max" },
    { id: "glm-4.6" },
    { id: "deepseek-chat" },
  ];

  it("shows the first level as groups, and no «Назад» above the root", () => {
    const menu = resolveModelMenu({ catalog });
    const screen = buildModelMenuScreen({ menu, labels: LABELS });
    expect(screen).not.toBeNull();
    expect(screen!.title).toBe(LABELS.rootTitle);
    expect(screen!.path).toEqual([]);
    expect(screen!.entries.map((entry) => entry.kind)).toEqual(["group", "group", "group"]);
    expect(screen!.entries.map((entry) => entry.label)).toEqual(menu.groups.map((g) => g.title));
    expect(screen!.entries.map((entry) => entry.path)).toEqual([[0], [1], [2]]);
    expect(screen!.pageCount).toBe(1);
  });

  it("shows the configured tree from the settings row in its own order", () => {
    const menu = resolveModelMenu({
      catalog: [...catalog, { id: "gemini-2.5-pro" }],
      settings: {
        groups: [
          { title: "My Google", models: ["gemini-2.5-pro"] },
          { title: "My Chinese", models: ["qwen3-max", "glm-4.6"], children: [{ title: "Deep", models: ["deepseek-chat"] }] },
        ],
      },
    });
    const screen = buildModelMenuScreen({ menu, labels: LABELS })!;
    expect(screen.entries.map((entry) => entry.label)).toEqual(["My Google", "My Chinese"]);
  });
});

describe("buildModelMenuScreen inside a group", () => {
  const menu = menuOf([
    {
      title: "Chinese",
      models: [model("qwen3-max")],
      children: [{ title: "DeepSeek", models: [model("deepseek-chat")], children: [] }],
    },
    { title: "Google", models: [model("gemini-2.5-pro")], children: [] },
  ]);

  it("lists the subgroups, then the models, then «Назад»", () => {
    const screen = buildModelMenuScreen({ menu, path: [0], labels: LABELS })!;
    expect(screen.title).toBe("Chinese");
    expect(screen.entries.map((entry) => entry.kind)).toEqual(["group", "model", "back"]);
    expect(screen.entries[0]?.label).toBe("DeepSeek");
    expect(screen.entries[0]?.path).toEqual([0, 0]);
    expect(screen.entries[1]?.modelId).toBe("qwen3-max");
    expect(screen.entries[2]?.path).toEqual([]);
  });

  it("walks one more level down and back up", () => {
    const nested = buildModelMenuScreen({ menu, path: [0, 0], labels: LABELS })!;
    expect(nested.title).toBe("DeepSeek");
    expect(nested.entries.map((entry) => entry.kind)).toEqual(["model", "back"]);
    expect(nested.entries[0]?.modelId).toBe("deepseek-chat");
    expect(nested.entries.at(-1)?.path).toEqual([0]);
  });

  it("answers null for a position that does not exist", () => {
    expect(buildModelMenuScreen({ menu, path: [7], labels: LABELS })).toBeNull();
    expect(buildModelMenuScreen({ menu, path: [0, 3], labels: LABELS })).toBeNull();
  });

  it("counts the models of a group with its subgroups", () => {
    expect(modelMenuNodeModelCount(menu.groups[0]!)).toBe(2);
  });

  it("reports the root as a synthetic node whose children are the first level", () => {
    const root = modelMenuNodeAtPath(menu, []);
    expect(root?.children.map((group) => group.title)).toEqual(["Chinese", "Google"]);
    expect(root?.models).toEqual([]);
  });
});

describe("buildModelMenuScreen paging a long group", () => {
  const total = MODEL_MENU_PAGE_SIZE * 2 + 5;
  const menu = menuOf([
    {
      title: "Long",
      models: Array.from({ length: total }, (_, index) => model(`model-${index + 1}`)),
      children: [],
    },
  ]);

  it("pages the level and puts «Ещё →» after a full page", () => {
    const first = buildModelMenuScreen({ menu, path: [0], labels: LABELS })!;
    expect(first.pageCount).toBe(3);
    expect(first.total).toBe(total);
    expect(first.entries).toHaveLength(MODEL_MENU_PAGE_SIZE + 2);
    expect(first.entries.slice(0, MODEL_MENU_PAGE_SIZE).map((entry) => entry.modelId)).toEqual(
      Array.from({ length: MODEL_MENU_PAGE_SIZE }, (_, index) => `model-${index + 1}`),
    );
    expect(first.entries.at(-2)).toMatchObject({ kind: "more", page: 1 });
    expect(first.entries.at(-1)).toMatchObject({ kind: "back", path: [] });
  });

  it("shows the tail of the level on the last page, with «Назад» and no «Ещё →»", () => {
    const last = buildModelMenuScreen({ menu, path: [0], page: 2, labels: LABELS })!;
    expect(last.entries.map((entry) => entry.kind)).toEqual([
      ...Array.from({ length: 5 }, () => "model"),
      "back",
    ]);
    expect(last.entries[0]?.modelId).toBe(`model-${total - 4}`);
  });

  it("clamps a page outside the range into it", () => {
    expect(buildModelMenuScreen({ menu, path: [0], page: 99, labels: LABELS })!.page).toBe(2);
    expect(buildModelMenuScreen({ menu, path: [0], page: -3, labels: LABELS })!.page).toBe(0);
  });

  it("never builds a keyboard Telegram would refuse", () => {
    for (const page of [0, 1, 2]) {
      const screen = buildModelMenuScreen({ menu, path: [0], page, labels: LABELS })!;
      expect(screen.entries.length).toBeLessThanOrEqual(MODEL_MENU_MAX_ENTRIES);
    }
  });
});

describe("entry labels", () => {
  it("cuts a long model label and marks the cut", () => {
    const long = "qwen3-max-preview-instruct-2026-very-long-suffix-that-does-not-fit";
    const cut = truncateModelMenuEntryLabel(long);
    expect(cut.length).toBeLessThanOrEqual(MODEL_MENU_ENTRY_LABEL_MAX_CHARS);
    expect(cut.endsWith("…")).toBe(true);
  });

  it("keeps a short label as it is", () => {
    expect(truncateModelMenuEntryLabel("GPT-5")).toBe("GPT-5");
  });

  it("lets the caller label a group and a model", () => {
    const menu = menuOf([{ title: "Chinese", models: [model("qwen3-max")], children: [] }]);
    const inner = buildModelMenuScreen({
      menu,
      path: [0],
      labels: {
        ...LABELS,
        groupLabel: (node) => node.title,
        modelLabel: (model) => `★ ${model.label}`,
      },
    })!;
    expect(inner.entries.at(0)?.label).toBe("★ qwen3-max");
  });
});