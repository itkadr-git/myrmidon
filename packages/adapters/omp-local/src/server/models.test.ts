import { afterEach, describe, expect, it, vi } from "vitest";
const { runChildProcessMock } = vi.hoisted(() => ({
  runChildProcessMock: vi.fn(),
}));

vi.mock("@myrmidon/adapter-utils/server-utils", async (importOriginal) => {
  const actual = (await importOriginal()) as typeof import("@myrmidon/adapter-utils/server-utils");
  return {
    ...actual,
    runChildProcess: (...args: Parameters<typeof actual.runChildProcess>) => runChildProcessMock(...args),
  };
});

import {
  ensureOmpModelConfiguredAndAvailable,
  listOmpModels,
  parseModelsOutput,
  resetOmpModelsCacheForTests,
} from "./models.js";

function ompProcessResult(stdout: string) {
  return {
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
    pid: 123,
    startedAt: new Date().toISOString(),
  };
}

describe("omp models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OMP_COMMAND;
    resetOmpModelsCacheForTests();
    runChildProcessMock.mockReset();
    runChildProcessMock.mockRejectedValue(new Error("omp discovery unavailable in test"));
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    await expect(listOmpModels()).resolves.toEqual([]);
  });

  it("lists host models under the litellm/ prefix the run sees (OPE-12464)", async () => {
    runChildProcessMock.mockResolvedValue(
      ompProcessResult(
        JSON.stringify({ models: [{ provider: "antigravity", id: "gemini-3.8-flash-medium", selector: "antigravity/gemini-3.8-flash-medium" }] }),
      ),
    );
    const models = await listOmpModels();
    expect(models.map((m) => m.id)).toContain("litellm/antigravity/gemini-3.8-flash-medium");
  });

  it("accepts the litellm-prefixed configured model at run start (OPE-12464)", async () => {
    runChildProcessMock.mockResolvedValue(
      ompProcessResult(
        JSON.stringify({ models: [{ provider: "antigravity", id: "gemini-3.8-flash-medium", selector: "antigravity/gemini-3.8-flash-medium" }] }),
      ),
    );
    await expect(
      ensureOmpModelConfiguredAndAvailable({ model: "litellm/antigravity/gemini-3.8-flash-medium" }),
    ).resolves.toBeDefined();
  });

  it("rejects when model is missing", async () => {
    runChildProcessMock.mockRejectedValue(new Error("omp discovery unavailable in test"));
    await expect(
      ensureOmpModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OMP requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OMP_COMMAND = "__paperclip_missing_omp_command__";
    runChildProcessMock.mockRejectedValue(new Error("spawn missing command"));
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
