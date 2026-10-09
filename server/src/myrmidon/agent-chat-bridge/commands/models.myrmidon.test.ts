// myrmidon(F06-D): the pure part of the `/model` list — which gateway ids are
// chat models, the owner's channel order, and what the screen-sized text list
// shows. No database: the command flow itself is covered in
// commands.myrmidon.test.ts.

import { describe, expect, it } from "vitest";
import {
  formatChatChoiceList,
  isChatGatewayModelId,
  listModelCandidates,
  listedChatChoices,
} from "./models.js";

describe("isChatGatewayModelId (F06-D)", () => {
  it("rejects embedding, OCR, speech, rerank and the board's own service models", () => {
    for (const id of [
      "dashscope-text-embedding-v4",
      "dashscope-ocr",
      "dashscope-ocr-vl",
      "vision-ocr",
      "dashscope-tts-flash",
      "tts",
      "dashscope-asr",
      "qwen-asr-flash",
      "dashscope-rerank-v3",
      "omni-moderation",
      "whisper-transcribe",
      "intent-classifier",
      "hindsight-mem",
      "hindsight-chat",
      "deepseek-v4-flash-mem",
      "hindsight-consolidation",
      "x-summary",
    ]) {
      expect(isChatGatewayModelId(id), id).toBe(false);
    }
  });

  it("keeps chat models, including ids that merely contain a short service token", () => {
    for (const id of ["dashscope-qwen3-max", "zai-glm-5.3", "nous-hermes-4", "x-matts-pro", "basra-chat", "memory-chat"]) {
      expect(isChatGatewayModelId(id), id).toBe(true);
    }
  });
});

describe("listModelCandidates ordering (F06-D)", () => {
  const catalog = (models: string[], providers?: Record<string, string>) => async () => ({
    models,
    ...(providers ? { providers } : {}),
    scope: "agentKey" as const,
  });

  it("orders DashScope, then z.ai, then other families alphabetically, ids as numbers", async () => {
    const list = await listModelCandidates("hermes_gateway", {}, catalog([
      "zai-glm-5.10",
      "nous-hermes-4",
      "zai-glm-5.3",
      "mistral-large",
      "dashscope-qwen3-max",
      "zai-glm-4.6",
      "dashscope-qwen3-coder",
    ], { "mistral-large": "mistral" }));
    expect(list.candidates.map((c) => c.id)).toEqual([
      "dashscope-qwen3-coder",
      "dashscope-qwen3-max",
      "zai-glm-4.6",
      "zai-glm-5.3",
      "zai-glm-5.10",
      "mistral-large",
      "nous-hermes-4",
    ]);
  });

  it("accepts the collected catalog's spellings of the z.ai family", async () => {
    const list = await listModelCandidates("hermes_gateway", {}, catalog(
      ["aaa-model", "glm-5.3", "qwen3-max"],
      { "glm-5.3": "z.ai", "qwen3-max": "DashScope" },
    ));
    expect(list.candidates.map((c) => c.id)).toEqual(["qwen3-max", "glm-5.3", "aaa-model"]);
  });

  it("ranks the card's own models inside the order and drops a non-chat one", async () => {
    const list = await listModelCandidates(
      "hermes_gateway",
      { model: "nous-hermes-4", models: { fallbacks: ["bge-embed-v3"] } },
      catalog(["zai-glm-4.6", "dashscope-qwen3-max"]),
    );
    expect(list.candidates.map((c) => c.id)).toEqual(["dashscope-qwen3-max", "zai-glm-4.6", "nous-hermes-4"]);
  });

  it("keeps the card's models first when no catalog could be read", async () => {
    const list = await listModelCandidates("hermes_gateway", { model: "nous-hermes-4" }, async () => null);
    expect(list.candidates[0]?.id).toBe("nous-hermes-4");
  });

  it("carries the reason the agent's own list was not used", async () => {
    const list = await listModelCandidates("hermes_gateway", {}, async () => ({
      models: ["dashscope-qwen3-max"],
      scope: "catalog",
      keyFailure: "gateway_error",
    }));
    expect(list).toMatchObject({ wholeCatalog: true, keyFailure: "gateway_error" });
  });
});

describe("formatChatChoiceList (F06-D)", () => {
  const ids = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${String(i + 1).padStart(2, "0")}`, label: "", provider: prefix }));

  it("numbers continuously with no family header lines", () => {
    const text = formatChatChoiceList([...ids("dashscope", 2), ...ids("zai", 1)], "en");
    expect(text).toBe("1) dashscope-01\n2) dashscope-02\n3) zai-01");
  });

  it("cuts a long list to the screen and says how many it left out", () => {
    const candidates = ids("other", 25);
    expect(listedChatChoices(candidates)).toHaveLength(20);
    const text = formatChatChoiceList(candidates, "en");
    expect(text.split("\n")).toHaveLength(21);
    expect(text).toContain("…and 5 more — choose by name or number.");
    expect(formatChatChoiceList(candidates, "ru")).toContain("…и ещё 5");
  });

  it("never cuts the owner-ranked families by the general cap, only by the hard ceiling", () => {
    const ranked = [...ids("dashscope", 24), ...ids("zai", 4)];
    expect(listedChatChoices([...ranked, ...ids("other", 5)])).toHaveLength(28);
    const huge = [...ids("dashscope", 40), ...ids("other", 5)];
    expect(listedChatChoices(huge)).toHaveLength(30);
  });
});
