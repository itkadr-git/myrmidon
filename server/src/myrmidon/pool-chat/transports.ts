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

export function createPoolChatTransports(client: PoolChatTransportClient): Record<PoolChatProvider, PoolChatTransport> {
  return {
    chatgpt: {
      provider: "chatgpt",
      send: (request) => client.sendChatGpt(request),
    },
    google: {
      provider: "google",
      send: (request) => client.sendGoogle({
        ...request,
        messages: request.messages.filter(({ role }) => role === "user").slice(0, 1),
      }),
    },
  };
}

export function redactTransportError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.replace(
      /((?:api[_-]?key|sk|key|token|secret)[-_=: ]*)[^\s,;]+/gi,
      (_match, label: string) => `${label}[redacted]`,
    );
  }
  return "provider_transport_failed";
}
