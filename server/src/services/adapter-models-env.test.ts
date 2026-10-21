import { describe, expect, it } from "vitest";
import { parseAdapterModelsEnv } from "./adapter-models-env.js";

const ENV = JSON.stringify({
  opencode_local: [
    { id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" },
    { id: "tensorix/z-ai/glm-4.7", label: "GLM 4.7" },
  ],
});

describe("parseAdapterModelsEnv", () => {
  it("returns null when unset", () => {
    expect(parseAdapterModelsEnv({})).toBeNull();
  });
  it("parses the per-adapter model map", () => {
    const m = parseAdapterModelsEnv({ PAPERCLIP_ADAPTER_MODELS: ENV });
    expect(m?.opencode_local?.[0]).toEqual({ id: "tensorix/deepseek/deepseek-chat-v3.1", label: "DeepSeek v3.1" });
    expect(m?.opencode_local?.length).toBe(2);
  });
  it("defaults label to id when omitted", () => {
    const m = parseAdapterModelsEnv({ PAPERCLIP_ADAPTER_MODELS: JSON.stringify({ pi_local: [{ id: "tensorix/x/y" }] }) });
    expect(m?.pi_local?.[0]).toEqual({ id: "tensorix/x/y", label: "tensorix/x/y" });
  });
  it("prefers MYRMIDON_ADAPTER_MODELS when both names are provided", () => {
    const models = parseAdapterModelsEnv({ MYRMIDON_ADAPTER_MODELS: ENV, PAPERCLIP_ADAPTER_MODELS: "bad" });
    expect(models?.opencode_local).toHaveLength(2);
  });
  it("parses legacy adapter models configuration", () => {
    expect(parseAdapterModelsEnv({ PAPERCLIP_ADAPTER_MODELS: ENV })?.opencode_local).toHaveLength(2);
  });
  it("throws on invalid JSON (fail loud)", () => {
    expect(() => parseAdapterModelsEnv({ MYRMIDON_ADAPTER_MODELS: "{bad" })).toThrow(/MYRMIDON_ADAPTER_MODELS/);
  });
  it("throws when an entry lacks a string id", () => {
    expect(() => parseAdapterModelsEnv({ PAPERCLIP_ADAPTER_MODELS: JSON.stringify({ a: [{ label: "x" }] }) })).toThrow();
  });
});
