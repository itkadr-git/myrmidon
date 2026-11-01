import { describe, expect, it } from "vitest";
import {
  estimateModelApiCostUsd,
  MODEL_API_PRICING_DEFAULTS,
  modelApiPricingSettingsSchema,
  normalizeModelApiPricingSettings,
} from "./myrmidon-model-api-pricing.js";

describe("model API-equivalent pricing", () => {
  it("prices uncached input, cached input and output with configured rates", () => {
    expect(estimateModelApiCostUsd({
      model: "gpt-6-luna",
      usage: { inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 100_000 },
      prices: MODEL_API_PRICING_DEFAULTS,
    })).toBe(0.114);
    expect(estimateModelApiCostUsd({
      model: "gpt-6.1-sol",
      usage: { inputTokens: 1_000, cachedInputTokens: 500, outputTokens: 100 },
      prices: MODEL_API_PRICING_DEFAULTS,
    })).toBe(0.00205);
  });

  it("uses initial rates only when no table is stored and leaves unknown prices explicit", () => {
    expect(normalizeModelApiPricingSettings(undefined)).toEqual(MODEL_API_PRICING_DEFAULTS);
    expect(normalizeModelApiPricingSettings({})).toEqual({});
    expect(estimateModelApiCostUsd({
      model: "unpriced-model",
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 },
      prices: MODEL_API_PRICING_DEFAULTS,
    })).toBeNull();
  });

  it("rejects negative, non-finite, unknown-key, or excessive price settings", () => {
    expect(modelApiPricingSettingsSchema.safeParse({ model: { inputUsdPerMillion: -1 } }).success).toBe(false);
    expect(modelApiPricingSettingsSchema.safeParse({ model: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: Number.NaN, outputUsdPerMillion: 1 } }).success).toBe(false);
    expect(modelApiPricingSettingsSchema.safeParse({ model: { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 1, extra: true } }).success).toBe(false);
    expect(modelApiPricingSettingsSchema.safeParse(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`m${i}`, { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 1, outputUsdPerMillion: 1 }]))).success).toBe(false);
  });
});
