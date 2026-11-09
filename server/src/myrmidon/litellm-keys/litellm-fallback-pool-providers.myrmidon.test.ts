// server/src/myrmidon/litellm-keys/litellm-fallback-pool-providers.myrmidon.test.ts
//
// OPE-12361 (review): unit coverage for the pool-provider mapping and the
// free/paid flag of the fallback-editor catalog copy.
//
//   - readPoolGroupProviders joins the board channel registry
//     (model_provider_models × model_providers) and maps LiteLLM model names
//     to the pool's own type instead of the generic "openai" LiteLLM prefix.
//   - withPoolProviders rewrites provider only for registered pool groups.
//   - fallbackCatalogEntry: a missing cost (null) is NOT a free model — only
//     explicit zero pricing marks a group free (kie-gpt-6-luna must not show
//     «Бесплатно» in the fallback editor).

import { describe, expect, it } from "vitest";
import {
  fallbackCatalogEntry,
  readPoolGroupProviders,
  withPoolProviders,
} from "./routes.js";

function dbWithRegistryRows(rows: Array<{ litellmModelName: string; providerType: string }>) {
  return {
    select: () => ({
      from: () => ({
        // The real query awaits the drizzle chain after innerJoin.
        innerJoin: async () => rows,
      }),
    }),
  } as any;
}

describe("myrmidon(OPE-12361) fallback catalog pool providers", () => {
  it("readPoolGroupProviders maps litellm model names to pool types from the registry", async () => {
    const db = dbWithRegistryRows([
      { litellmModelName: "gpt-5.2", providerType: "chatgpt-pool" },
      { litellmModelName: "gemini-3-pro", providerType: "antigravity-pool" },
      { litellmModelName: "qwen-max", providerType: "openai" },
      { litellmModelName: "claude-sonnet-4", providerType: "anthropic" },
    ]);

    const poolGroups = await readPoolGroupProviders(db);

    expect(poolGroups.get("gpt-5.2")).toBe("chatgpt-pool");
    expect(poolGroups.get("gemini-3-pro")).toBe("antigravity-pool");
    // Non-pool types are not mapped: they keep their LiteLLM provider.
    expect(poolGroups.has("qwen-max")).toBe(false);
    expect(poolGroups.has("claude-sonnet-4")).toBe(false);
  });

  it("readPoolGroupProviders survives an unready registry (no tables) with an empty map", async () => {
    const db = {
      select: () => {
        throw new Error("relation does not exist");
      },
    } as any;

    const poolGroups = await readPoolGroupProviders(db);
    expect(poolGroups.size).toBe(0);
  });

  it("withPoolProviders turns provider 'openai' into the pool type for pool groups only", () => {
    const known = [
      { modelName: "gpt-5.2", provider: "openai" },
      { modelName: "gemini-3-pro", provider: "openai" },
      { modelName: "qwen-max", provider: "openai" },
    ];
    const poolGroups = new Map([
      ["gpt-5.2", "chatgpt-pool"],
      ["gemini-3-pro", "antigravity-pool"],
    ]);

    const result = withPoolProviders(known, poolGroups);

    expect(result.find((m) => m.modelName === "gpt-5.2")?.provider).toBe("chatgpt-pool");
    expect(result.find((m) => m.modelName === "gemini-3-pro")?.provider).toBe("antigravity-pool");
    // Regular LiteLLM groups keep the generic provider.
    expect(result.find((m) => m.modelName === "qwen-max")?.provider).toBe("openai");
  });

  it("fallbackCatalogEntry marks explicit zero pricing free and null cost paid", () => {
    const free = fallbackCatalogEntry({
      modelName: "pool-gpt-mini",
      provider: "chatgpt-pool",
      inputCostPerToken: 0,
      outputCostPerToken: 0,
    });
    expect(free.isFree).toBe(true);

    // kie-gpt-6-luna: a paid gateway that reports no cost must NOT show «Бесплатно».
    const kie = fallbackCatalogEntry({
      modelName: "kie-gpt-6-luna",
      provider: "openai",
      inputCostPerToken: null,
      outputCostPerToken: null,
    });
    expect(kie.isFree).toBe(false);

    const paid = fallbackCatalogEntry({
      modelName: "gpt-4o",
      provider: "openai",
      inputCostPerToken: 2.5,
      outputCostPerToken: 10,
    });
    expect(paid.isFree).toBe(false);
  });
});
