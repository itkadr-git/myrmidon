import { describe, expect, it, vi } from "vitest";
import type { PoolChatMessage } from "./protocol.js";
import { createPoolChatTransports, redactTransportError } from "./transports.js";

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
});
