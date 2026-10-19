// The shape of the channel connector contract (design section 3.1).
//
// The connector below is the fixture of the module: it is built from
// CHANNEL_CONNECTOR_AREAS and read back through the registry, so a member the
// interface grows without the fixture — or an area the fixture stops covering —
// fails here and not at a call site of a later step.

import { afterEach, describe, expect, it } from "vitest";
import {
  CHANNEL_CONNECTOR_AREAS,
  CHAT_PROVIDER_NAMES,
  MEDIA_KINDS,
  isChatProviderName,
  type ChannelConnector,
  type ChannelConnectorArea,
  type ChannelConnectorContext,
  type ChatProviderName,
} from "./contract.js";
import {
  getChannelConnector,
  registerChannelConnector,
  unregisterChannelConnector,
  type ChannelConnectorFactoryDeps,
} from "./registry.js";

const ENDPOINT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

/** Members of the contract that carry data rather than a method. */
const DATA_MEMBERS = new Set([
  "media.fileLimitBytes",
  "media.captionLimit",
  "media.accepts",
  "settings.keys",
]);

const context: ChannelConnectorContext = {
  companyId: COMPANY_ID,
  store: { readEndpoint: async () => null },
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  now: () => new Date("2026-10-08T00:00:00.000Z"),
};

const deps: ChannelConnectorFactoryDeps = {
  store: context.store,
  logger: context.logger,
  now: context.now,
};

function fixtureConnector(): ChannelConnector {
  return {
    provider: "telegram",
    lifecycle: {
      start: async (endpoint) => ({
        endpointId: endpoint.id,
        provider: "telegram",
        status: "ready",
        leaseKey: "lease-1",
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
      admit: async () => ({ admitted: true, reason: null }),
      intakeMedia: async () => ({ accepted: true, intake: [], rejected: [] }),
    },
    outbound: {
      plan: async (publication) => ({
        endpointId: publication.endpointId,
        conversationKey: publication.conversationKey,
        idempotencyKey: publication.idempotencyKey,
        parts: [{ kind: "text", text: publication.text, media: null }],
      }),
      send: async (plan) => ({
        delivered: plan.parts.length > 0,
        externalMessageIds: ["2002"],
        failedPartIndex: null,
      }),
    },
    media: {
      fileLimitBytes: 10 * 1024 * 1024,
      captionLimit: 1024,
      accepts: ["photo", "document"],
    },
    settings: {
      keys: [
        {
          key: "dmConversations",
          envVar: "MYRMIDON_TELEGRAM_DM_CONVERSATIONS",
          summary: "Conversations that keep direct messages enabled.",
          defaultValue: "",
        },
      ],
      resolve: async () => ({
        endpointId: ENDPOINT_ID,
        values: { dmConversations: "" },
        sources: { dmConversations: "default" },
      }),
    },
  };
}

afterEach(() => {
  unregisterChannelConnector("telegram");
});

describe("channel connector contract", () => {
  it("hands back a connector with every area and member of the map", () => {
    registerChannelConnector("telegram", () => fixtureConnector());
    const connector = getChannelConnector("telegram", deps);
    expect(connector).not.toBeNull();

    for (const [area, members] of Object.entries(CHANNEL_CONNECTOR_AREAS)) {
      const target = (connector as ChannelConnector)[area as ChannelConnectorArea] as Record<
        string,
        unknown
      >;
      expect(target, area).toBeDefined();
      for (const member of members) {
        expect(target[member], `${area}.${member}`).toBeDefined();
      }
    }
  });

  it("carries the methods of every area and the media limits as data", () => {
    const connector = fixtureConnector();

    for (const [area, members] of Object.entries(CHANNEL_CONNECTOR_AREAS)) {
      const target = connector[area as ChannelConnectorArea] as Record<string, unknown>;
      for (const member of members) {
        if (DATA_MEMBERS.has(`${area}.${member}`)) {
          continue;
        }
        expect(typeof target[member], `${area}.${member}`).toBe("function");
      }
    }

    expect(connector.media.fileLimitBytes).toBeGreaterThan(0);
    expect(connector.media.captionLimit).toBeGreaterThanOrEqual(0);
    expect(connector.media.accepts.length).toBeGreaterThan(0);
    for (const kind of connector.media.accepts) {
      expect(MEDIA_KINDS).toContain(kind);
    }
  });

  it("covers the provider ids of the vendor chat sdk and nothing else", () => {
    expect([...CHAT_PROVIDER_NAMES]).toEqual([
      "slack",
      "github",
      "discord",
      "microsoft-teams",
      "telegram",
      "imessage-photon",
    ]);
    for (const provider of CHAT_PROVIDER_NAMES) {
      expect(isChatProviderName(provider), provider).toBe(true);
    }
    for (const other of ["agentmail", "TELEGRAM", "telegram ", "", null, undefined, 7, {}]) {
      expect(isChatProviderName(other), String(other)).toBe(false);
    }
  });

  it("describes every settings key with an environment name and a default", async () => {
    const connector = fixtureConnector();
    const provider: ChatProviderName = connector.provider;
    expect(CHAT_PROVIDER_NAMES).toContain(provider);

    expect(connector.settings.keys.length).toBeGreaterThan(0);
    for (const descriptor of connector.settings.keys) {
      expect(descriptor.key).not.toBe("");
      expect(descriptor.envVar).not.toBe("");
      expect(descriptor.summary).not.toBe("");
    }

    const resolved = await connector.settings.resolve(context);
    expect(resolved.endpointId).toBe(ENDPOINT_ID);
    for (const [key, source] of Object.entries(resolved.sources)) {
      expect(["env", "ui", "default"], key).toContain(source);
    }
  });
});