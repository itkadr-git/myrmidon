// myrmidon(F06-D): the gateway model catalog behind `/model` must read the key
// the bot really sends (its card's binding, else the shared company secret) and
// must say why it fell back to the whole catalog instead of doing it silently.
// Red before F06-D: only the minted per-agent secret was looked up, and every
// failure came back as the same bare `null`.

import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import { readGatewayModelCatalog, type GatewayModelCatalogDeps } from "./gateway-model-catalog.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const AGENT_ID = "22222222-2222-4222-8222-222222222222";
const GATEWAY_ENV = { MYRMIDON_LITELLM_BASE_URL: "http://gateway.test:4000" } as NodeJS.ProcessEnv;
const COLLECTED = async () => [
  { modelName: "dashscope-qwen3-max", provider: "dashscope", mode: "chat" },
  { modelName: "zai-glm-4.6", provider: "z.ai", mode: null },
  { modelName: "dashscope-text-embedding-v4", provider: "dashscope", mode: "embedding" },
];

function deps(overrides: Partial<GatewayModelCatalogDeps> = {}): GatewayModelCatalogDeps {
  return {
    db: {} as Db,
    companyId: COMPANY_ID,
    agentId: AGENT_ID,
    agentSlug: "Agent B",
    adapterType: "hermes_gateway",
    adapterConfig: { env: { LLM_KEY: { type: "secret_ref", secretId: "s1" } } },
    env: GATEWAY_ENV,
    readSecretValue: async () => null,
    readCardKey: async () => null,
    readCollectedModels: COLLECTED,
    ...overrides,
  };
}

describe("readGatewayModelCatalog (F06-D)", () => {
  it("lists the agent's own allowlist using the key its card binds", async () => {
    const keysSeen: string[] = [];
    const catalog = await readGatewayModelCatalog(
      deps({
        readCardKey: async () => "card-key",
        clientFor: (_baseUrl, key) => {
          keysSeen.push(key);
          return { listAvailableModels: async () => [" dashscope-qwen3-max ", "", "zai-glm-5.3"] };
        },
      }),
    );
    // The allowlist is the agent's own; the family and the gateway-declared
    // mode of each model come from the board's collected catalog.
    expect(catalog).toEqual({
      models: ["dashscope-qwen3-max", "zai-glm-5.3"],
      scope: "agentKey",
      providers: {
        "dashscope-qwen3-max": "dashscope",
        "zai-glm-4.6": "z.ai",
        "dashscope-text-embedding-v4": "dashscope",
      },
      modes: { "dashscope-qwen3-max": "chat", "dashscope-text-embedding-v4": "embedding" },
    });
    expect(keysSeen).toEqual(["card-key"]);
  });

  it("prefers the key the bot sends over a minted per-agent secret", async () => {
    const keysSeen: string[] = [];
    await readGatewayModelCatalog(
      deps({
        readCardKey: async () => "card-key",
        readSecretValue: async () => "minted-key",
        clientFor: (_baseUrl, key) => {
          keysSeen.push(key);
          return { listAvailableModels: async () => ["a"] };
        },
      }),
    );
    expect(keysSeen).toEqual(["card-key"]);
  });

  it("still falls back to the minted per-agent secret when the card binds no key", async () => {
    const keysSeen: string[] = [];
    const catalog = await readGatewayModelCatalog(
      deps({
        readSecretValue: async () => "minted-key",
        clientFor: (_baseUrl, key) => {
          keysSeen.push(key);
          return { listAvailableModels: async () => ["a"] };
        },
      }),
    );
    expect(catalog?.scope).toBe("agentKey");
    expect(keysSeen).toEqual(["minted-key"]);
  });

  it("names the reason when it has to fall back to the whole catalog", async () => {
    const noGatewayUrl = await readGatewayModelCatalog(deps({ env: {} as NodeJS.ProcessEnv }));
    expect(noGatewayUrl).toMatchObject({ scope: "catalog", keyFailure: "no_gateway_url" });

    const noKey = await readGatewayModelCatalog(deps());
    expect(noKey).toMatchObject({ scope: "catalog", keyFailure: "no_key" });
    expect(noKey?.providers).toMatchObject({ "dashscope-qwen3-max": "dashscope", "zai-glm-4.6": "z.ai" });
    expect(noKey?.modes).toEqual({ "dashscope-qwen3-max": "chat", "dashscope-text-embedding-v4": "embedding" });

    const secretError = await readGatewayModelCatalog(
      deps({
        readSecretValue: async () => {
          throw new Error("secret store down");
        },
      }),
    );
    expect(secretError).toMatchObject({ scope: "catalog", keyFailure: "secret_error" });

    const cardSecretError = await readGatewayModelCatalog(
      deps({
        readCardKey: async () => {
          throw new Error("secret is not active");
        },
      }),
    );
    expect(cardSecretError).toMatchObject({ scope: "catalog", keyFailure: "secret_error" });

    const gatewayError = await readGatewayModelCatalog(
      deps({
        readCardKey: async () => "card-key",
        clientFor: () => ({
          listAvailableModels: async () => {
            throw new Error("401 key not allowed");
          },
        }),
      }),
    );
    expect(gatewayError).toMatchObject({ scope: "catalog", keyFailure: "gateway_error" });

    const emptyList = await readGatewayModelCatalog(
      deps({
        readCardKey: async () => "card-key",
        clientFor: () => ({ listAvailableModels: async () => ["  "] }),
      }),
    );
    expect(emptyList).toMatchObject({ scope: "catalog", keyFailure: "empty_list" });
  });

  it("keeps the agent's own list when the collected catalog cannot be read", async () => {
    const catalog = await readGatewayModelCatalog(
      deps({
        readCardKey: async () => "card-key",
        clientFor: () => ({ listAvailableModels: async () => ["a"] }),
        readCollectedModels: async () => {
          throw new Error("db down");
        },
      }),
    );
    expect(catalog).toEqual({ models: ["a"], scope: "agentKey" });
  });

  it("answers null when neither tier has anything", async () => {
    expect(await readGatewayModelCatalog(deps({ readCollectedModels: async () => [] }))).toBeNull();
  });
});
