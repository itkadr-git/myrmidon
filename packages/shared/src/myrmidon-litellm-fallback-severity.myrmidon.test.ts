import { describe, expect, it } from "vitest";
import {
  evaluateFallbackChain,
  missingGatewayEnv,
  readGatewayKeySettings,
  validateFallbackOrder,
  type KnownModelInfo,
} from "./myrmidon-litellm-sync.js";

// myrmidon(1.6.7 LITELLM-BOARD): which fallback findings refuse a save and which
// only warn. The order policy (free first, then cheaper) refuses; a fallback
// inside one provider, or a provider the catalog does not know, warns.

function catalogOf(rows: KnownModelInfo[]) {
  return new Map(rows.map((row) => [row.modelName, row]));
}

describe("myrmidon(1.6.7 LITELLM-BOARD) fallback chain findings", () => {
  it("warns, and does not refuse, a paid fallback inside the primary's provider", () => {
    const catalog = catalogOf([
      { modelName: "zai-glm-5.3", provider: "hosted_vllm", inputCostPerToken: 0.0000014, outputCostPerToken: 0.0000044 },
      { modelName: "zai-glm-5.3-flash", provider: "hosted_vllm", inputCostPerToken: 0.00000015, outputCostPerToken: 0.0000005 },
    ]);

    const result = evaluateFallbackChain({ model: "zai-glm-5.3", targets: ["zai-glm-5.3-flash"] }, catalog);

    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.kind)).toEqual(["same_provider_as_primary", "single_provider"]);
    expect(result.warnings.every((issue) => issue.severity === "warning")).toBe(true);
  });

  it("warns about a later paid fallback on the provider of an earlier one", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: "openai" },
      { modelName: "first", provider: "anthropic", cost: 0.01 },
      { modelName: "second", provider: "anthropic", cost: 0.02 },
    ]);

    const result = evaluateFallbackChain({ model: "primary", targets: ["first", "second"] }, catalog);

    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.kind)).toEqual(["same_provider_as_earlier_paid"]);
  });

  it("still refuses a free channel after a paid one and a cheaper channel after a dearer one", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: "openai" },
      { modelName: "paid", provider: "anthropic", cost: 0.01 },
      { modelName: "free", provider: "google", isFree: true },
      { modelName: "dear", provider: "anthropic", cost: 0.02 },
      { modelName: "cheap", provider: "google", cost: 0.001 },
    ]);

    const freeLate = evaluateFallbackChain({ model: "primary", targets: ["paid", "free"] }, catalog);
    const cheapLate = evaluateFallbackChain({ model: "primary", targets: ["dear", "cheap"] }, catalog);

    expect(freeLate.errors.map((issue) => issue.kind)).toEqual(["free_after_paid"]);
    expect(cheapLate.errors.map((issue) => issue.kind)).toEqual(["cheaper_after_expensive"]);
  });

  it("does not let a provider warning hide an ordering error later in the chain", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: "openai" },
      { modelName: "paid-same", provider: "openai", cost: 0.01 },
      { modelName: "free-late", provider: "google", isFree: true },
    ]);

    const result = evaluateFallbackChain({ model: "primary", targets: ["paid-same", "free-late"] }, catalog);

    expect(result.errors.map((issue) => issue.kind)).toEqual(["free_after_paid"]);
    expect(result.warnings.map((issue) => issue.kind)).toContain("same_provider_as_primary");
  });

  it("warns about an unknown provider and skips the single-provider check for it", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: null },
      { modelName: "backup", provider: null },
    ]);

    const result = evaluateFallbackChain({ model: "primary", targets: ["backup"] }, catalog);

    expect(result.errors).toEqual([]);
    expect(result.warnings.map((issue) => issue.kind)).toEqual(["unknown_provider"]);
    expect(result.warnings[0]!.message).toContain("primary, backup");
  });

  it("has no findings for a diverse, well-ordered chain", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: "openai", cost: 0.03 },
      { modelName: "free", provider: "google", isFree: true },
      { modelName: "paid", provider: "anthropic", cost: 0.01 },
    ]);

    expect(evaluateFallbackChain({ model: "primary", targets: ["free", "paid"] }, catalog)).toEqual({
      errors: [],
      warnings: [],
    });
  });

  it("has no findings for a chain without targets", () => {
    expect(evaluateFallbackChain({ model: "primary", targets: [] }, new Map())).toEqual({ errors: [], warnings: [] });
  });

  it("keeps reporting the first finding through validateFallbackOrder, same-provider ones included", () => {
    const catalog = catalogOf([
      { modelName: "primary", provider: "openai" },
      { modelName: "paid-same", provider: "openai", cost: 0.01 },
    ]);

    const result = validateFallbackOrder({ model: "primary", targets: ["paid-same"] }, catalog);

    expect(result.valid).toBe(false);
    expect(result.error).toContain("uses the same provider (openai) as primary model");
    expect(result.warning).toContain("uses the same provider (openai) as primary model");
  });
});

describe("myrmidon(1.6.7 LITELLM-BOARD) missing gateway settings", () => {
  it("names the variables that keep gateway management off", () => {
    expect(missingGatewayEnv(readGatewayKeySettings({}))).toEqual([
      "MYRMIDON_LITELLM_BASE_URL",
      "MYRMIDON_LITELLM_ADMIN_KEY_SECRET",
    ]);
    expect(missingGatewayEnv(readGatewayKeySettings({ MYRMIDON_LITELLM_BASE_URL: "http://gateway.test" }))).toEqual([
      "MYRMIDON_LITELLM_ADMIN_KEY_SECRET",
    ]);
    expect(
      missingGatewayEnv(readGatewayKeySettings({ MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin-key" })),
    ).toEqual(["MYRMIDON_LITELLM_BASE_URL"]);
  });

  it("names nothing when management can run", () => {
    const settings = readGatewayKeySettings({
      MYRMIDON_LITELLM_BASE_URL: "http://gateway.test",
      MYRMIDON_LITELLM_ADMIN_KEY_SECRET: "gateway-admin-key",
    });
    expect(settings.canManageKeys).toBe(true);
    expect(missingGatewayEnv(settings)).toEqual([]);
  });
});
