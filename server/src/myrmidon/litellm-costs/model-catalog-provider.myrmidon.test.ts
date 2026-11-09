// server/src/myrmidon/litellm-costs/model-catalog-provider.myrmidon.test.ts
//
// myrmidon(1.6.7 LITELLM-BOARD): the provider of a catalog model.
//
// The fallback checks read the provider from the model catalog. LiteLLM
// declares it as `model_info.litellm_provider`; reading only
// `custom_llm_provider` left every catalog row without a provider, and every
// fallback save was refused for it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createLitellmGatewayClient, readModelInfoProvider } from "./litellm-costs.js";

describe("myrmidon(1.6.7 LITELLM-BOARD) model catalog provider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads litellm_provider first and custom_llm_provider second", () => {
    expect(readModelInfoProvider({ litellm_provider: "hosted_vllm" })).toBe("hosted_vllm");
    expect(readModelInfoProvider({ custom_llm_provider: "openai" })).toBe("openai");
    expect(readModelInfoProvider({ litellm_provider: "anthropic", custom_llm_provider: "openai" })).toBe("anthropic");
  });

  it("reads a blank or non-string value as not declared", () => {
    expect(readModelInfoProvider({ litellm_provider: "  ", custom_llm_provider: "openai" })).toBe("openai");
    expect(readModelInfoProvider({ litellm_provider: 5 })).toBeNull();
    expect(readModelInfoProvider({})).toBeNull();
    expect(readModelInfoProvider(null)).toBeNull();
  });

  it("fills the catalog provider from /v1/model/info", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            data: [
              {
                model_name: "group-a",
                model_info: { litellm_provider: "hosted_vllm", input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
              },
              { model_name: "group-b", model_info: { custom_llm_provider: "openai" } },
              { model_name: "group-c", model_info: {} },
            ],
          }),
          { status: 200 },
        ),
    );

    const rows = await createLitellmGatewayClient("http://gateway.test", "sk-test").listModels();

    expect(rows.map((row) => [row.modelName, row.provider])).toEqual([
      ["group-a", "hosted_vllm"],
      ["group-b", "openai"],
      ["group-c", null],
    ]);
    expect(rows[0]!.rates.input_cost_per_token).toBe(0.000001);
  });
});
