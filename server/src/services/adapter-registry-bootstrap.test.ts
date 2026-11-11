import { describe, expect, it } from "vitest";
import { parseAdapterRegistryEnv } from "./adapter-registry-bootstrap.js";

const ENTRY = JSON.stringify([
  { adapterType: "opencode_local", runtimeImage: "img", envKeys: ["ANTHROPIC_API_KEY"], allowFqdns: [], probeCommand: ["opencode", "--version"], defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080" } },
]);

describe("parseAdapterRegistryEnv", () => {
  it("returns null when neither env nor file is set", () => {
    expect(parseAdapterRegistryEnv({})).toBeNull();
  });

  it("parses MYRMIDON adapter env and gives it precedence over legacy values", () => {
    const result = parseAdapterRegistryEnv({ MYRMIDON_ADAPTERS: ENTRY, PAPERCLIP_ADAPTERS: "bad" });
    expect(result).toHaveLength(1);
    expect(result?.[0].adapterType).toBe("opencode_local");
  });

  it("supports the legacy adapter env alias", () => {
    expect(parseAdapterRegistryEnv({ PAPERCLIP_ADAPTERS: ENTRY })).toHaveLength(1);
  });

  it("throws on malformed JSON (fail loud)", () => {
    expect(() => parseAdapterRegistryEnv({ MYRMIDON_ADAPTERS: "{not json" })).toThrow(
      /MYRMIDON_ADAPTERS/,
    );
  });

  it("throws on schema-invalid content (fail loud)", () => {
    expect(() =>
      parseAdapterRegistryEnv({ MYRMIDON_ADAPTERS: JSON.stringify([{ enabled: true }]) }),
    ).toThrow(/MYRMIDON_ADAPTERS/);
  });
});
