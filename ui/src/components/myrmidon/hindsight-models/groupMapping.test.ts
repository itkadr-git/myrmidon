// ui/src/components/myrmidon/hindsight-models/groupMapping.test.ts
//
// OPE-9858: Tests for frontend Hindsight group mapping and limitations logic.

import { describe, expect, it } from "vitest";
import {
  getHindsightApiLimitations,
  groupIdToHindsightRole,
  hindsightRoleToGroupId,
  isHindsightGroup,
  mapHindsightToCatalogGroups,
  type HindsightModelGroupView,
} from "./groupMapping";

describe("groupMapping", () => {
  it("maps roles to group ids and back", () => {
    expect(hindsightRoleToGroupId("write")).toBe("hindsight-write");
    expect(hindsightRoleToGroupId("summarize")).toBe("hindsight-summarize");
    expect(hindsightRoleToGroupId("search")).toBe("hindsight-search");

    expect(groupIdToHindsightRole("hindsight-write")).toBe("write");
    expect(groupIdToHindsightRole("hindsight-summarize")).toBe("summarize");
    expect(groupIdToHindsightRole("hindsight-search")).toBe("search");
    expect(groupIdToHindsightRole("write")).toBe("write");
    expect(groupIdToHindsightRole("unknown-group")).toBeNull();

    expect(isHindsightGroup("hindsight-write")).toBe(true);
    expect(isHindsightGroup("hindsight-summarize")).toBe(true);
    expect(isHindsightGroup("hindsight-search")).toBe(true);
    expect(isHindsightGroup("claude-models")).toBe(false);
  });

  it("provides structured limitations with OPE-9469 dependency and reindex notices", () => {
    const limitations = getHindsightApiLimitations();
    expect(limitations.length).toBeGreaterThanOrEqual(4);

    const runtimeDep = limitations.find((l) => l.relatedIssue === "OPE-9469");
    expect(runtimeDep).toBeDefined();
    expect(runtimeDep?.severity).toBe("warning");
    expect(runtimeDep?.description).toContain("OPE-9469");

    const noSecret = limitations.find((l) => l.id === "no-secret-mutation");
    expect(noSecret).toBeDefined();

    const reindex = limitations.find((l) => l.id === "embedding-reindex-requirement");
    expect(reindex).toBeDefined();
    expect(reindex?.severity).toBe("warning");
  });

  it("maps HindsightModelGroupView items to generic catalog group format", () => {
    const rawGroups: HindsightModelGroupView[] = [
      {
        role: "write",
        group: "hindsight-write",
        name: "Hindsight Write (память: запись)",
        description: "Извлечение фактов и сохранение воспоминаний",
        model: "claude-3-5-haiku",
        defaultModel: "gpt-4o-mini",
        source: "setting",
        updatedAt: null,
      },
      {
        role: "summarize",
        group: "hindsight-summarize",
        name: "Hindsight Summarize (память: сведение)",
        description: "Консолидация базы памяти",
        model: "gpt-4o-mini",
        defaultModel: "gpt-4o-mini",
        source: "default",
        updatedAt: null,
      },
      {
        role: "search",
        group: "hindsight-search",
        name: "Hindsight Search (память: поиск)",
        description: "Семантический поиск",
        model: "bge-m3",
        defaultModel: "gpt-4o-mini",
        source: "setting",
        updatedAt: null,
      },
    ];

    const catalog = mapHindsightToCatalogGroups(rawGroups);
    expect(catalog).toHaveLength(3);

    expect(catalog[0]).toEqual({
      id: "hindsight-write",
      role: "write",
      name: "Hindsight Write (память: запись)",
      description: "Извлечение фактов и сохранение воспоминаний",
      model: "claude-3-5-haiku",
      defaultModel: "gpt-4o-mini",
      source: "setting",
      editable: true,
      isHindsight: true,
      suggestedModels: expect.arrayContaining(["gpt-4o-mini", "claude-3-5-haiku"]),
    });

    expect(catalog[2].model).toBe("bge-m3");
    expect(catalog[2].suggestedModels).toContain("bge-m3");
  });
});
