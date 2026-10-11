// The channel connector registry (design section 3.2): registration, lookup,
// replacement of a factory and the pass-through of a provider nobody registered.

import { afterEach, describe, expect, it } from "vitest";
import type {
  ChannelConnector,
  ChannelConnectorStore,
  ChatProviderName,
} from "./contract.js";
import {
  getChannelConnector,
  getChannelConnectorFactory,
  registerChannelConnector,
  unregisterChannelConnector,
  type ChannelConnectorFactoryDeps,
} from "./registry.js";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";

const store: ChannelConnectorStore = { readEndpoint: async () => null };
const deps: ChannelConnectorFactoryDeps = {
  store,
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  now: () => new Date("2026-10-08T00:00:00.000Z"),
};

function stubConnector(provider: ChatProviderName): ChannelConnector {
  return {
    provider,
    lifecycle: {
      start: async (endpoint) => ({
        endpointId: endpoint.id,
        provider,
        status: "ready",
        leaseKey: null,
      }),
      stop: async () => {},
      status: async () => "ready",
    },
    links: {
      conversationKey: () => "channel-1",
      conversationUrl: () => null,
      route: async () => null,
      bind: async () => {},
    },
    inbound: {
      normalize: async () => null,
      admit: async () => ({ admitted: false, reason: "not-addressed" }),
      intakeMedia: async () => ({ accepted: false, intake: [], rejected: [] }),
    },
    outbound: {
      plan: async (publication) => ({
        endpointId: publication.endpointId,
        conversationKey: publication.conversationKey,
        idempotencyKey: publication.idempotencyKey,
        parts: [],
      }),
      send: async () => ({ delivered: false, externalMessageIds: [], failedPartIndex: null }),
    },
    media: { fileLimitBytes: 0, captionLimit: 0, accepts: [] },
    settings: {
      keys: [],
      resolve: async () => ({ endpointId: ENDPOINT_ID, values: {}, sources: {} }),
    },
  };
}

afterEach(() => {
  for (const provider of ["telegram", "slack"] as const) {
    unregisterChannelConnector(provider);
  }
});

describe("channel connector registry", () => {
  it("has no connector for a provider nobody registered", () => {
    expect(getChannelConnectorFactory("telegram")).toBeNull();
    expect(getChannelConnector("telegram", deps)).toBeNull();
  });

  it("hands back the connector a registered factory builds", () => {
    const factory = () => stubConnector("telegram");
    registerChannelConnector("telegram", factory);

    expect(getChannelConnectorFactory("telegram")).toBe(factory);
    const connector = getChannelConnector("telegram", deps);
    expect(connector).not.toBeNull();
    expect(connector?.provider).toBe("telegram");
  });

  it("keeps each provider apart", () => {
    registerChannelConnector("telegram", () => stubConnector("telegram"));

    expect(getChannelConnector("slack", deps)).toBeNull();
    expect(getChannelConnector("telegram", deps)?.provider).toBe("telegram");
    expect(unregisterChannelConnector("telegram")).toBeUndefined();
    expect(getChannelConnector("telegram", deps)).toBeNull();
  });

  it("allows the same factory twice and refuses a second one for the provider", () => {
    const factory = () => stubConnector("telegram");
    registerChannelConnector("telegram", factory);
    expect(() => registerChannelConnector("telegram", factory)).not.toThrow();

    expect(() =>
      registerChannelConnector("telegram", () => stubConnector("telegram")),
    ).toThrow(/already registered/);
  });

  it("refuses a factory that answers for another provider", () => {
    registerChannelConnector("telegram", () => stubConnector("slack"));

    expect(() => getChannelConnector("telegram", deps)).toThrow(/answered with a "slack" connector/);
  });
});