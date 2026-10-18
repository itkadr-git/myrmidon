import { afterEach, describe, expect, it } from "vitest";
import {
  ensureOmpModelConfiguredAndAvailable,
  listOmpModels,
  parseModelsOutput,
  resetOmpModelsCacheForTests,
} from "./models.js";

describe("omp models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OMP_COMMAND;
    resetOmpModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    await expect(listOmpModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOmpModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OMP requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    await expect(
      ensureOmpModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  describe("parseModelsOutput", () => {
    it("parses JSON models output", () => {
      const json = JSON.stringify({
        models: [
          { provider: "openai", id: "gpt-4o", selector: "openai/gpt-4o" },
          { provider: "anthropic", id: "claude-3-7-sonnet", selector: "anthropic/claude-3-7-sonnet" },
        ],
      });

      const parsed = parseModelsOutput(json);
      expect(parsed).toEqual([
        { id: "openai/gpt-4o", label: "openai/gpt-4o" },
        { id: "anthropic/claude-3-7-sonnet", label: "anthropic/claude-3-7-sonnet" },
      ]);
    });

    it("parses columnar/table models output", () => {
      const table = `
openai (2)
┌──────────────────┬─────────┐
│ model            │ context │
├──────────────────┼─────────┤
│ gpt-4o           │ 128k    │
│ gpt-4o-mini      │ 128k    │
└──────────────────┴─────────┘
anthropic (1)
┌──────────────────────┬─────────┐
│ model                │ context │
├──────────────────────┼─────────┤
│ claude-3-7-sonnet    │ 200k    │
└──────────────────────┴─────────┘
`;
      const parsed = parseModelsOutput(table);
      expect(parsed.some((m) => m.id === "openai/gpt-4o")).toBe(true);
      expect(parsed.some((m) => m.id === "openai/gpt-4o-mini")).toBe(true);
      expect(parsed.some((m) => m.id === "anthropic/claude-3-7-sonnet")).toBe(true);
    });

    it("parses slash-delimited list of models", () => {
      const output = `
openai/gpt-4o
openai/gpt-4o-mini
google/gemini-2.5-pro
`;
      const parsed = parseModelsOutput(output);
      expect(parsed).toEqual([
        { id: "openai/gpt-4o", label: "openai/gpt-4o" },
        { id: "openai/gpt-4o-mini", label: "openai/gpt-4o-mini" },
        { id: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro" },
      ]);
    });

    it("ignores log warnings and non-model lines", () => {
      const output = `
WARN   failed to fetch remote plugin manifest
INFO   loaded cache from disk
error: something went wrong
openai/gpt-4o
`;
      const parsed = parseModelsOutput(output);
      expect(parsed).toEqual([{ id: "openai/gpt-4o", label: "openai/gpt-4o" }]);
    });
  });
});
