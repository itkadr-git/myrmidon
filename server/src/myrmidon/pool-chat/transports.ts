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
