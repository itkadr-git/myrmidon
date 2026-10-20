import { describe, expect, it, vi } from "vitest";
import type { PoolChatMessage } from "./protocol.js";
import { createPoolChatTransports, redactTransportError } from "./transports.js";

const messages: PoolChatMessage[] = [
  { role: "system", content: "instructions" },
  { role: "user", content: "question" },
  { role: "assistant", content: "prior answer" },
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

  it("converts Google requests to user text and performs a single transport call", async () => {
    const sendGoogle = vi.fn(async (request) => ({
      text: "answer", inputUnits: 1, outputUnits: 1, providerRequestRef: null,
    }));
    const transports = createPoolChatTransports({ sendChatGpt: vi.fn(), sendGoogle });

    await transports.google.send({ model: "fast", messages, maxOutputTokens: 100 });
    expect(sendGoogle).toHaveBeenCalledTimes(1);
    expect(sendGoogle.mock.calls[0]?.[0].messages).toEqual([{ role: "user", content: "question" }]);
  });

  it("redacts key-like values from provider errors", () => {
    expect(redactTransportError(new Error("request failed: api_key=secret-value")))
      .toBe("request failed: api_key=[redacted]");
    expect(redactTransportError({ token: "private" })).toBe("provider_transport_failed");
  });
});
