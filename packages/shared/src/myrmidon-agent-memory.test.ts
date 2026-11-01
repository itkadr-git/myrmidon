// packages/shared/src/myrmidon-agent-memory.test.ts
//
// OPE-9858: Shared schema and normalization tests for Hindsight model roles.

import { describe, expect, it } from "vitest";
import {
  applyAgentMemoryPatch,
  HINDSIGHT_API_LIMITATIONS,
  HINDSIGHT_ROLES,
  normalizeAgentMemorySettings,
  patchHindsightModelsSchema,
} from "./myrmidon-agent-memory.js";

describe("myrmidon-agent-memory (OPE-9858)", () => {
  it("normalizes stored models into hindsightModels config", () => {
    const raw = {
      enabled: true,
      apiUrl: "https://memory.internal:8000",
      hindsightModels: {
        write: "gpt-4o",
        summarize: "claude-3-5-haiku",
        search: "bge-m3",
      },
    };

    const normalized = normalizeAgentMemorySettings(raw);
    expect(normalized.hindsightModels).toEqual({
      write: "gpt-4o",
      summarize: "claude-3-5-haiku",
      search: "bge-m3",
    });
    expect(normalized.writeModel).toBe("gpt-4o");
    expect(normalized.summarizeModel).toBe("claude-3-5-haiku");
    expect(normalized.searchModel).toBe("bge-m3");
  });

  it("handles legacy/direct writeModel, summarizeModel, searchModel fields", () => {
    const raw = {
      writeModel: "qwen-plus",
      searchModel: "text-embedding-3-small",
    };

    const normalized = normalizeAgentMemorySettings(raw);
    expect(normalized.hindsightModels?.write).toBe("qwen-plus");
    expect(normalized.hindsightModels?.search).toBe("text-embedding-3-small");
    expect(normalized.hindsightModels?.summarize).toBeUndefined();
  });

  it("applies patch to update specific model role and clears on null", () => {
    const initial = {
      hindsightModels: {
        write: "gpt-4o-mini",
        summarize: "gpt-4o-mini",
        search: "gpt-4o-mini",
      },
    };

    const patched = applyAgentMemoryPatch(initial, {
      hindsightModels: {
        write: "claude-3-5-haiku",
        summarize: null,
      },
    });

    expect(patched.hindsightModels?.write).toBe("claude-3-5-haiku");
    expect(patched.hindsightModels?.summarize).toBeUndefined();
    expect(patched.hindsightModels?.search).toBe("gpt-4o-mini");
  });

  it("validates patchHindsightModelsSchema", () => {
    const validSingle = patchHindsightModelsSchema.safeParse({
      role: "write",
      model: "gpt-4o",
    });
    expect(validSingle.success).toBe(true);

    const validMulti = patchHindsightModelsSchema.safeParse({
      models: {
        write: "gpt-4o",
        summarize: "claude-3-5-haiku",
      },
    });
    expect(validMulti.success).toBe(true);

    const invalidEmpty = patchHindsightModelsSchema.safeParse({});
    expect(invalidEmpty.success).toBe(false);

    const invalidRole = patchHindsightModelsSchema.safeParse({
      role: "unknown_role" as any,
      model: "gpt-4o",
    });
    expect(invalidRole.success).toBe(false);
  });

  it("documents API limitations explicitly", () => {
    expect(HINDSIGHT_ROLES).toEqual(["write", "summarize", "search"]);
    expect(HINDSIGHT_API_LIMITATIONS.length).toBeGreaterThanOrEqual(4);
    expect(HINDSIGHT_API_LIMITATIONS.some((l) => l.includes("OPE-9469"))).toBe(true);
  });
});
