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
  MAX_CHOICE_BUTTONS,
} from "./models.js";
import { providerOverrideForModel } from "./overrides.js";

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
      "dashscope-wan2.6-t2v",
      "wan2.2-i2v-plus",
      "dashscope-qwen-image",
      "dashscope-qwen-image-edit",
      "cogview-4",
      "cogvideox-3",
      "dashscope-cosyvoice-v2",
      "paraformer-v2",
      "sensevoice-v1",
      "whisper-1",
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

describe("isChatGatewayModelId by the gateway-declared mode (F06-D)", () => {
  it("lets the declared mode decide, whatever the id looks like", () => {
    // Red against an id-only rule: an unfamiliar generation model passes it.
    expect(isChatGatewayModelId("acme-pixel-maker", "image_generation")).toBe(false);
    expect(isChatGatewayModelId("acme-voice-9", "audio_speech")).toBe(false);
    expect(isChatGatewayModelId("acme-ocr-lite", "ocr")).toBe(false);
    // ... and an id that looks like a service model but is declared chat stays.
    expect(isChatGatewayModelId("embedding-tutor", "chat")).toBe(true);
    expect(isChatGatewayModelId("acme-think-2", "responses")).toBe(true);
    expect(isChatGatewayModelId("acme-think-2", " CHAT ")).toBe(true);
  });

  it("drops the board's own service models even when the gateway calls them chat", () => {
    expect(isChatGatewayModelId("hindsight-mem", "chat")).toBe(false);
    expect(isChatGatewayModelId("deepseek-v4-flash-mem", "chat")).toBe(false);
  });
});

describe("listModelCandidates with declared modes and no ceiling (F06-D)", () => {
  it("drops models declared non-chat and keeps all families, DashScope then z.ai first", async () => {
    const dash = Array.from({ length: 35 }, (_, i) => `dashscope-m${String(i + 1).padStart(2, "0")}`);
    const zai = ["zai-glm-5.3", "zai-glm-5.3-flash"];
    const list = await listModelCandidates("hermes_gateway", {}, async () => ({
      models: ["mistral-large", ...zai, "acme-pixel-maker", ...dash],
      modes: { "acme-pixel-maker": "image_generation", "mistral-large": "chat" },
      scope: "agentKey" as const,
    }));
    const listed = list.candidates.map((c) => c.id);
    expect(listed).toHaveLength(35 + 2 + 1);
    expect(listed.slice(0, 35)).toEqual(dash);
    expect(listed.slice(35)).toEqual(["zai-glm-5.3", "zai-glm-5.3-flash", "mistral-large"]);
    expect(listed).not.toContain("acme-pixel-maker");
  });

  it("puts the card's models through the same filter", async () => {
    const list = await listModelCandidates(
      "hermes_gateway",
      { model: "acme-pixel-maker" },
      async () => ({ models: ["zai-glm-5.3"], modes: { "acme-pixel-maker": "image_generation" }, scope: "agentKey" as const }),
    );
    expect(list.candidates.map((c) => c.id)).toEqual(["zai-glm-5.3"]);
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

  it("shows every candidate, however many: no ceiling on the list (owner 09.10)", () => {
    const candidates = [...ids("dashscope", 40), ...ids("zai", 25), ...ids("other", 40)];
    const text = formatChatChoiceList(candidates, "en");
    expect(text.split("\n")).toHaveLength(105);
    expect(text).toContain("105) other-40");
    expect(text).not.toContain("more");
  });

  it("gives the keyboard only what the platform allows, in list order", () => {
    const candidates = [...ids("dashscope", 60), ...ids("zai", 60)];
    const shown = listedChatChoices(candidates);
    expect(shown).toHaveLength(MAX_CHOICE_BUTTONS);
    expect(shown[0]!.id).toBe("dashscope-01");
    expect(listedChatChoices(ids("zai", 3))).toHaveLength(3);
  });
});

describe("providerOverrideForModel (F06-D)", () => {
  it("routes a gateway model of a native-provider card through the gateway", () => {
    expect(providerOverrideForModel({ provider: "anthropic", model: "claude-own" }, "zai-glm-5.3")).toBe("custom");
  });

  it("keeps the card's provider for the card's own model and fallbacks", () => {
    const card = { provider: "anthropic", model: "claude-own", models: { fallbacks: ["claude-small"] } };
    expect(providerOverrideForModel(card, "claude-own")).toBeNull();
    expect(providerOverrideForModel(card, " claude-small ")).toBeNull();
  });

  it("writes nothing for a gateway card or for no model", () => {
    expect(providerOverrideForModel({}, "zai-glm-5.3")).toBeNull();
    expect(providerOverrideForModel({ provider: "auto" }, "zai-glm-5.3")).toBeNull();
    expect(providerOverrideForModel({ provider: "custom:litellm" }, "zai-glm-5.3")).toBeNull();
    expect(providerOverrideForModel({ provider: "anthropic" }, null)).toBeNull();
  });
});
