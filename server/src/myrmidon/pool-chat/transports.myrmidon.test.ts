import { describe, expect, it, vi } from "vitest";
import type { PoolChatMessage } from "./protocol.js";
import { createPoolChatHttpTransport, createPoolChatTransports, redactTransportError } from "./transports.js";

const messages: PoolChatMessage[] = [
  { role: "user", content: "question" },
  { role: "assistant", content: "prior answer" },
  { role: "user", content: "follow-up" },
];

describe("pool-chat transports", () => {
  it("passes ChatGPT messages through without exposing transport selection to callers", async () => {
    const sendChatGpt = vi.fn(async (request) => ({
      text: "answer", inputUnits: 2, outputUnits: 1, providerRequestRef: null,
    }));
    const transports = createPoolChatTransports({ sendChatGpt, sendGoogle: vi.fn() });
    const request = { model: "balanced", messages, maxOutputTokens: 100 };

    await transports.chatgpt.send(request);
    expect(sendChatGpt).toHaveBeenCalledWith(request);
  });

  it("preserves the full conversation for the Google text bridge", async () => {
    const sendGoogle = vi.fn(async (request) => ({
      text: "answer", inputUnits: 1, outputUnits: 1, providerRequestRef: null,
    }));
    const transports = createPoolChatTransports({ sendChatGpt: vi.fn(), sendGoogle });

    await transports.google.send({ model: "fast", messages, maxOutputTokens: 100 });
    expect(sendGoogle).toHaveBeenCalledTimes(1);
    expect(sendGoogle.mock.calls[0]?.[0].messages).toEqual(messages);
  });

  it("redacts key-like values from provider errors", () => {
    expect(redactTransportError(new Error("request failed: api_key=secret-value")))
      .toBe("provider_transport_failed");
    expect(redactTransportError(new Error("https://provider.test/?token=secret")))
      .toBe("provider_transport_failed");
    expect(redactTransportError({ token: "private" })).toBe("provider_transport_failed");
  });
  it("translates pool-chat messages to the Gemini contents contract", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "part 1" }, { text: "part 2" }] } }],
        usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3 },
      }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = createPoolChatHttpTransport({ provider: "google", endpoint: "https://generativelanguage.test/generate", apiKey: "google-secret" });
      const result = await transport.send({ model: "gemini-2.0-flash", messages, maxOutputTokens: 128 });
      expect(result).toMatchObject({ text: "part 1part 2", inputUnits: 7, outputUnits: 3 });
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.headers).toEqual({ "content-type": "application/json", "x-goog-api-key": "google-secret" });
      expect(JSON.parse(String(init?.body))).toEqual({
        contents: [
          { role: "user", parts: [{ text: "question" }] },
          { role: "model", parts: [{ text: "prior answer" }] },
          { role: "user", parts: [{ text: "follow-up" }] },
        ],
        generationConfig: { maxOutputTokens: 128 },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects Gemini non-2xx responses without exposing provider details", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 429,
      json: async () => ({ error: { message: "api_key=provider-secret" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = createPoolChatHttpTransport({ provider: "google", endpoint: "https://generativelanguage.test/generate", apiKey: "google-secret" });
      await expect(transport.send({ model: "gemini-2.0-flash", messages, maxOutputTokens: 128 }))
        .rejects.toThrow("provider request failed");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("redacts Gemini network failures", async () => {
    const fetchMock = vi.fn(async () => { throw new Error("request to https://provider.test/?token=provider-secret failed"); });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = createPoolChatHttpTransport({ provider: "google", endpoint: "https://generativelanguage.test/generate", apiKey: "google-secret" });
      let thrown: unknown;
      try {
        await transport.send({ model: "gemini-2.0-flash", messages, maxOutputTokens: 128 });
      } catch (error) {
        thrown = error;
      }
      expect(redactTransportError(thrown)).toBe("provider_transport_failed");
      expect(String(thrown)).not.toContain("provider-secret");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["missing candidates", {}],
    ["empty parts", { candidates: [{ content: { parts: [] } }] }],
    ["non-text parts", { candidates: [{ content: { parts: [{ inlineData: { data: "private" } }] } }] }],
    ["malformed JSON", null],
  ])("rejects Gemini %s without exposing response content", async (_label, payload) => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => payload }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = createPoolChatHttpTransport({ provider: "google", endpoint: "https://generativelanguage.test/generate", apiKey: "google-secret" });
      await expect(transport.send({ model: "gemini-2.0-flash", messages, maxOutputTokens: 128 }))
        .rejects.toThrow("provider response invalid");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses bearer auth and the OpenAI payload for ChatGPT", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({ ok: true, json: async () => ({ choices: [{ message: { content: "answer" } }] }) }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const transport = createPoolChatHttpTransport({ provider: "chatgpt", endpoint: "https://chatgpt.test/chat", apiKey: "chatgpt-secret" });
      await transport.send({ model: "gpt-4o-mini", messages, maxOutputTokens: 64 });
      const init = fetchMock.mock.calls[0]?.[1];
      expect(init?.headers).toEqual({ "content-type": "application/json", authorization: "Bearer chatgpt-secret" });
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-4o-mini", messages, max_tokens: 64 });
    } finally {
      vi.unstubAllGlobals();
    }
  });

});
