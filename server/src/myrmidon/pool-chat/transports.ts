import type { PoolChatMessage } from "./protocol.js";

export type PoolChatProvider = "chatgpt" | "google";

export type PoolChatTransportRequest = {
  model: string;
  messages: PoolChatMessage[];
  maxOutputTokens: number;
};

export type PoolChatTransportResult = {
  text: string;
  inputUnits: number;
  outputUnits: number;
  providerRequestRef: string | null;
};

export type PoolChatTransport = {
  readonly provider: PoolChatProvider;
  send(request: PoolChatTransportRequest): Promise<PoolChatTransportResult>;
};

export type PoolChatTransportClient = {
  sendChatGpt(request: PoolChatTransportRequest): Promise<PoolChatTransportResult>;
  sendGoogle(request: PoolChatTransportRequest): Promise<PoolChatTransportResult>;
};

export type PoolChatHttpTransportOptions = {
  provider: PoolChatProvider;
  endpoint: string;
  apiKey: string;
};

function usageNumber(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Build the deployment-owned HTTP adapter; provider payloads stay behind this boundary. */
export function createPoolChatHttpTransport(options: PoolChatHttpTransportOptions): PoolChatTransport {
  return {
    provider: options.provider,
    async send(request) {
      const headers: Record<string, string> = { "content-type": "application/json" };
      let body: Record<string, unknown>;
      if (options.provider === "google") {
        headers["x-goog-api-key"] = options.apiKey;
        body = {
          contents: request.messages.map((message) => ({
            // Gemini calls the assistant role "model" and accepts text parts.
            role: message.role === "assistant" ? "model" : "user",
            parts: [{ text: message.content }],
          })),
          generationConfig: { maxOutputTokens: request.maxOutputTokens },
        };
      } else {
        headers.authorization = `Bearer ${options.apiKey}`;
        body = {
          model: request.model,
          messages: request.messages,
          max_tokens: request.maxOutputTokens,
        };
      }
      const response = await fetch(options.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error("provider request failed");
      const payload = (await response.json()) as Record<string, any>;
      const text = options.provider === "google"
        ? payload.candidates?.[0]?.content?.parts
          ?.map((part: any) => part?.text)
          .filter((part: any) => typeof part === "string")
          .join("")
        : payload.choices?.[0]?.message?.content;
      if (typeof text !== "string" || text.length === 0) throw new Error("provider response invalid");
      const usage = payload.usage ?? payload.usageMetadata ?? {};
      return {
        text,
        inputUnits: usageNumber(usage.prompt_tokens ?? usage.promptTokenCount),
        outputUnits: usageNumber(usage.completion_tokens ?? usage.candidatesTokenCount),
        providerRequestRef: typeof payload.id === "string" ? payload.id : null,
      };
    },
  };
}

export function createPoolChatTransports(client: PoolChatTransportClient): Record<PoolChatProvider, PoolChatTransport> {
  return {
    chatgpt: {
      provider: "chatgpt",
      send: (request) => client.sendChatGpt(request),
    },
    google: {
      provider: "google",
      send: (request) => client.sendGoogle(request),
    },
  };
}

export function redactTransportError(error: unknown): string {
  // Provider exceptions may contain headers, URLs, or response bodies. Keep
  // only a stable code; never persist or return vendor-controlled text.
  void error;
  return "provider_transport_failed";
}
