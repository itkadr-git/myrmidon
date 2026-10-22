// myrmidon(1.7-DEBATE-ASYM-A): the gateway-backed model call — one fake
// OpenAI-compatible server (a stubbed fetch) checks the request shape, the
// usage accounting (gateway usage when present, character/4 estimate when
// not) and the contour resolution. No secrets in any assertion: only secret
// NAMES appear in problems and prompts.

import { describe, expect, it } from "vitest";
import {
  chatCompletionsUrl,
  createDebateGatewayCall,
  debateGatewayProblem,
  estimateTokens,
  readDebateGatewaySettings,
} from "./gateway.js";
import { defaultDebateSettings, type DebateCallContext } from "@paperclipai/shared";

const role = defaultDebateSettings().generator!;
const ctx: DebateCallContext = { role: "generator", round: 0, independent: true };

function stubFetch(payload: unknown, capture?: (init: RequestInit | undefined) => void) {
  return (async (_url: string | URL | undefined | null, init?: RequestInit) => {
    capture?.(init);
    return {
      ok: true,
      status: 200,
      json: async () => payload,
    } as Response;
  }) as unknown as typeof fetch;
}

describe("myrmidon(1.7-DEBATE-ASYM-A): gateway settings contour", () => {
  it("resolves the debate contour over the evals fallback", () => {
    const own = readDebateGatewaySettings({
      MYRMIDON_DEBATE_BASE_URL: "https://gw.example/v1",
      MYRMIDON_DEBATE_KEY_SECRET: "debate-key",
    });
    expect(own.enabled).toBe(true);
    expect(own.baseUrl).toBe("https://gw.example/v1");

    const fallback = readDebateGatewaySettings({
      MYRMIDON_EVALS_BASE_URL: "https://evals.example",
      MYRMIDON_EVALS_KEY_SECRET: "evals-key",
    });
    expect(fallback.enabled).toBe(true);
    expect(fallback.keySecret).toBe("evals-key");

    const none = readDebateGatewaySettings({});
    expect(none.enabled).toBe(false);
    expect(debateGatewayProblem(none)).toContain("MYRMIDON_DEBATE_BASE_URL");
  });

  it("the chat-completions url respects an already-versioned base", () => {
    expect(chatCompletionsUrl("https://gw.example/")).toBe("https://gw.example/v1/chat/completions");
    expect(chatCompletionsUrl("https://gw.example/v1")).toBe("https://gw.example/v1/chat/completions");
  });
});

describe("myrmidon(1.7-DEBATE-ASYM-A): the model call", () => {
  it("posts a system+user pair for the role model and trusts the gateway usage", async () => {
    let captured: RequestInit | undefined;
    const call = createDebateGatewayCall({
      fetch: stubFetch(
        {
          choices: [{ message: { content: "the answer" } }],
          usage: { prompt_tokens: 111, completion_tokens: 22 },
        },
        (init) => (captured = init),
      ),
      apiKey: "sekret",
      baseUrl: "https://gw.example",
      timeoutMs: 5000,
    });
    const res = await call(role, "SYS", "USR", ctx);
    expect(res.text).toBe("the answer");
    expect(res.usage).toEqual({ inputTokens: 111, outputTokens: 22 });
    const body = JSON.parse(String(captured?.body)) as Record<string, unknown>;
    expect(body.model).toBe("qwen-plus-free");
    expect(body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ]);
    expect(body.temperature).toBe(0);
    expect((captured?.headers as Record<string, string>).Authorization).toBe("Bearer sekret");
  });

  it("estimates tokens when the gateway returns no usage", async () => {
    const call = createDebateGatewayCall({
      fetch: stubFetch({ choices: [{ message: { content: "x".repeat(400) } }] }),
      apiKey: "k",
      baseUrl: "https://gw.example",
      timeoutMs: 5000,
    });
    const res = await call(role, "S".repeat(80), "U".repeat(120), ctx);
    expect(res.usage.inputTokens).toBe(estimateTokens("S".repeat(80)) + estimateTokens("U".repeat(120)));
    expect(res.usage.outputTokens).toBe(estimateTokens("x".repeat(400)));
  });

  it("a non-OK gateway answer raises with the model name, never the key", async () => {
    const failing = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as unknown as typeof fetch;
    const call = createDebateGatewayCall({ fetch: failing, apiKey: "k", baseUrl: "https://gw", timeoutMs: 5000 });
    await expect(call(role, "S", "U", ctx)).rejects.toThrow(/answered 429 for model "qwen-plus-free"/);
  });
});
