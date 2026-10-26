import { z } from "zod";

/** API-equivalent list-price estimates for subscription-backed model usage. */
export const MODEL_API_PRICING_DEFAULTS = {
  "gpt-6-luna": { inputUsdPerMillion: 0.1, cachedInputUsdPerMillion: 0.01, outputUsdPerMillion: 0.5 },
  "gpt-6.1-sol": { inputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 10 },
} as const;

const modelApiPriceSchema = z.object({
  inputUsdPerMillion: z.number().finite().min(0).max(100_000),
  cachedInputUsdPerMillion: z.number().finite().min(0).max(100_000),
  outputUsdPerMillion: z.number().finite().min(0).max(100_000),
}).strict();

export const modelApiPricingSettingsSchema = z.record(
  z.string().trim().min(1).max(256),
  modelApiPriceSchema,
).superRefine((prices, context) => {
  if (Object.keys(prices).length > 500) {
    context.addIssue({ code: "custom", message: "At most 500 model prices may be configured." });
  }
});

export type ModelApiPrice = z.infer<typeof modelApiPriceSchema>;
export type ModelApiPricingSettings = z.infer<typeof modelApiPricingSettingsSchema>;

export function normalizeModelApiPricingSettings(value: unknown): ModelApiPricingSettings {
  const parsed = modelApiPricingSettingsSchema.safeParse(value);
  return parsed.success ? parsed.data : { ...MODEL_API_PRICING_DEFAULTS };
}

/** Returns API-equivalent USD, or null when the model has no configured price. */
export function estimateModelApiCostUsd(input: {
  model: string;
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
  prices: ModelApiPricingSettings;
}): number | null {
  const price = Object.hasOwn(input.prices, input.model) ? input.prices[input.model] : undefined;
  if (!price) return null;
  const cachedInputTokens = Math.min(
    Math.max(0, input.usage.inputTokens),
    Math.max(0, input.usage.cachedInputTokens),
  );
  const uncachedInputTokens = Math.max(0, input.usage.inputTokens - cachedInputTokens);
  const usd = (
    uncachedInputTokens * price.inputUsdPerMillion
      + cachedInputTokens * price.cachedInputUsdPerMillion
      + Math.max(0, input.usage.outputTokens) * price.outputUsdPerMillion
  ) / 1_000_000;
  return Number.isFinite(usd) ? Math.round(usd * 1_000_000) / 1_000_000 : null;
}
