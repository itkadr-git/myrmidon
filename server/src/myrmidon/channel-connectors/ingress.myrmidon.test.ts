// myrmidon(1.6.6 CONNECTOR-IN): the inbound read of the channel connectors —
// the ingress seam the vendor webhook path goes through (design section 4).
//
// What this file pins:
//  - with no connector registered for the provider the vendor path reads the
//    event exactly as before and the counter says `direct`: the "flag off"
//    behaviour of the ticket is a whole test, not an assumption;
//  - with a connector registered the transport event is read by that connector
//    and the counter says `adapter`;
//  - a turn the connector refuses, or reads as no message for us, stops at the
//    seam: one update never reaches the queue twice (the connector answers
//    `duplicate` for the second read of the same externalId);
//  - every failure of ours (an unreadable body, a throwing connector) leaves
//    the event to the vendor path — fail-open, no channel falls silent.
//
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type {
  ChannelAdmission,
  ChannelConnector,
  ChannelConnectorStore,
  ChannelEndpointView,
  ChannelLogSink,
  ChannelTurn,
} from "./contract.js";
import { myrmidonChannelConnectorHub, type ChannelConnectorHub } from "./hub.js";
import { registerChannelConnector, unregisterChannelConnector } from "./registry.js";
import {
  channelIngressCounters,
  readChannelIngress,
  readInboundEventThroughConnector,
  resetChannelIngressCounters,
  type ChannelIngressWebhookInput,
} from "./ingress.js";

const TELEGRAM: ChannelEndpointView = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  provider: "telegram",
  publicId: "public-telegram",
  status: "active",
};

/** The row the vendor webhook path already holds; the projection reads it. */
const TELEGRAM_ROW = {
  id: TELEGRAM.id,
  companyId: TELEGRAM.companyId,
  provider: "telegram",
  publicId: TELEGRAM.publicId,
  status: "active",
};

const GITHUB_ROW = { ...TELEGRAM_ROW, provider: "github" };

const UPDATE = { update_id: 4001, message: { message_id: 17, text: "hello" } };

const noDb = {} as unknown as Db;

function webhookRequest(id: number): ChannelIngressWebhookInput["request"] {
  const text = JSON.stringify({ ...UPDATE, update_id: id });
  return { clone: () => ({ text: async () => text }) };
}

/** A body that cannot be read at all — the request of a transport we do not know. */
const unreadableRequest: ChannelIngressWebhookInput["request"] = {
  clone: () => ({
    text: async () => {
      throw new Error("body already consumed");
    },
  }),
};

interface Fixture {
  readonly connector: ChannelConnector;
  readonly calls: string[];
  readonly raws: unknown[];
}

/**
 * A fake connector for Telegram shaped like the adapter: it reads the update,
 * admits it once per externalId (the idempotency the ticket asks for) and
 * answers `duplicate` for the second read of the same event.
 */
function fakeTelegram(options: { admit?: boolean; normalize?: "turn" | "nothing" | "throw" } = {}) {
  const calls: string[] = [];
  const raws: unknown[] = [];
  const seen = new Set<string>();
  const connector: ChannelConnector = {
    provider: "telegram",
    lifecycle: {
      start: async (endpoint) => ({ endpointId: endpoint.id, provider: "telegram", status: "ready", leaseKey: null }),
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
      normalize: async (raw) => {
        calls.push("inbound.normalize");
        raws.push(raw);
        if (options.normalize === "throw") {
          throw new Error("no payload in the event");
        }
        if (options.normalize === "nothing") {
          return null;
        }
        const turn: ChannelTurn = {
          endpointId: TELEGRAM.id,
          provider: "telegram",
          conversationKey: "channel-1",
          conversationUrl: null,
          authorExternalId: "user-a",
          addressedToBot: true,
          text: "hello",
          media: [],
          receivedAt: new Date("2026-10-10T00:00:00.000Z"),
          raw,
        };
        return turn;
      },
      admit: async (turn): Promise<ChannelAdmission> => {
        calls.push("inbound.admit");
        const externalId = (turn.raw as { update_id?: number }).update_id;
        if (typeof externalId === "number") {
          if (seen.has(String(externalId))) {
            return { admitted: false, reason: "duplicate" };
          }
          seen.add(String(externalId));
        }
        const admitted = options.admit ?? true;
        return { admitted, reason: admitted ? null : "not-addressed" };
      },
      intakeMedia: async () => ({ accepted: true, intake: [], rejected: [] }),
    },
    outbound: {
      plan: async (publication) => ({
        endpointId: publication.endpointId,
        conversationKey: publication.conversationKey,
        idempotencyKey: publication.idempotencyKey,
        parts: [{ kind: "text", text: publication.text, media: null }],
      }),
      send: async () => ({ delivered: true, externalMessageIds: ["2002"], failedPartIndex: null }),
    },
    media: { fileLimitBytes: 1024, captionLimit: 64, accepts: ["photo"] },
    settings: { keys: [], resolve: async () => ({ endpointId: TELEGRAM.id, values: {}, sources: {} }) },
  };
  return { connector, calls, raws } satisfies Fixture;
}

function ingressHub(fixture?: Fixture) {
  if (fixture !== undefined) {
    registerChannelConnector("telegram", () => fixture.connector);
  }
  const logged: string[] = [];
  const store: ChannelConnectorStore = { readEndpoint: async () => TELEGRAM };
  const hub = myrmidonChannelConnectorHub(noDb, {
    store,
    logger: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (message) => {
        logged.push(message);
      },
    },
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  return { hub, logged };
}

function recordingSink() {
  const messages: string[] = [];
  const sink: ChannelLogSink = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => {
      messages.push(message);
    },
  };
  return { sink, messages };
}

beforeEach(() => {
  resetChannelIngressCounters();
});

afterEach(() => {
  unregisterChannelConnector("telegram");
});

describe("a provider no connector reads: the vendor path keeps the event", () => {
  it("counts a direct read and lets the event go on", async () => {
    const { hub } = ingressHub();
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(4001),
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 1 });
  });

  it("counts the read as direct when no connector reads the provider, and never touches the body", async () => {
    const { hub } = ingressHub();
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: GITHUB_ROW,
      request: unreadableRequest,
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 1 });
  });

  it("keeps out of the way of a provider the contract does not know, without counting it", async () => {
    const { hub } = ingressHub();
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: { ...TELEGRAM_ROW, provider: "email" },
      request: unreadableRequest,
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 0 });
  });

  it("asks for no request when the vendor path has no row to route by", async () => {
    const { hub } = ingressHub();
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: null,
      request: unreadableRequest,
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 0 });
  });
});

describe("a registered connector reads the transport event", () => {
  it("reads the update through the connector and leaves the one delivery to the vendor path", async () => {
    const fixture = fakeTelegram();
    const { hub } = ingressHub(fixture);
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(4001),
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 1, direct: 0 });
    expect(fixture.raws).toEqual([{ ...UPDATE, update_id: 4001 }]);
    expect(fixture.calls).toEqual(["inbound.normalize", "inbound.admit"]);
  });

  it("keeps a turn the connector refuses out of the queue", async () => {
    const fixture = fakeTelegram({ admit: false });
    const { hub } = ingressHub(fixture);
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(4002),
    });

    expect(stops).toBe(true);
    expect(channelIngressCounters()).toEqual({ adapter: 1, direct: 0 });
  });

  it("keeps an event the connector reads as no message for us out of the queue", async () => {
    const fixture = fakeTelegram({ normalize: "nothing" });
    const { hub } = ingressHub(fixture);
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(4003),
    });

    expect(stops).toBe(true);
    expect(channelIngressCounters()).toEqual({ adapter: 1, direct: 0 });
  });
});

describe("one update is delivered once", () => {
  it("stops the second read of the same externalId at the seam", async () => {
    const fixture = fakeTelegram();
    const { hub } = ingressHub(fixture);
    const first = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(5001),
    });
    const again = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(5001),
    });

    expect(first).toBe(false);
    expect(again).toBe(true);
    expect(channelIngressCounters()).toEqual({ adapter: 2, direct: 0 });
    expect(fixture.calls).toEqual([
      "inbound.normalize",
      "inbound.admit",
      "inbound.normalize",
      "inbound.admit",
    ]);
  });

  it("reads two different updates of one endpoint independently", async () => {
    const fixture = fakeTelegram();
    const { hub } = ingressHub(fixture);
    const first = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(5002),
    });
    const second = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(5003),
    });

    expect([first, second]).toEqual([false, false]);
    expect(channelIngressCounters()).toEqual({ adapter: 2, direct: 0 });
  });
});

describe("our own failures leave the event to the vendor path", () => {
  it("does not close the channel when the body cannot be read", async () => {
    const fixture = fakeTelegram();
    const { hub } = ingressHub(fixture);
    const { sink, messages } = recordingSink();
    const stops = await readInboundEventThroughConnector(
      hub,
      { endpoint: TELEGRAM_ROW, request: unreadableRequest },
      { logger: sink },
    );

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 1 });
    expect(fixture.calls).toEqual([]);
    expect(messages).toEqual(["channel ingress event is unreadable, the vendor path keeps the endpoint"]);
  });

  it("does not close the channel when the connector throws", async () => {
    const fixture = fakeTelegram({ normalize: "throw" });
    const { hub } = ingressHub(fixture);
    const stops = await readInboundEventThroughConnector(hub, {
      endpoint: TELEGRAM_ROW,
      request: webhookRequest(4004),
    });

    expect(stops).toBe(false);
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 1 });
  });
});

describe("the reading the seam reports", () => {
  it("names a refused turn, its reason and the turn itself", async () => {
    const fixture = fakeTelegram({ admit: false });
    const { hub } = ingressHub(fixture);
    const reading = await readChannelIngress(
      { endpoint: TELEGRAM, readRaw: async () => UPDATE },
      { hub },
    );

    expect(reading.path).toBe("adapter");
    expect(reading.suppress).toBe(true);
    expect(reading.suppression).toBe("not-admitted");
    expect(reading.admissionReason).toBe("not-addressed");
    expect(reading.turn?.text).toBe("hello");
    expect(reading.failure).toBeNull();
  });

  it("reads the vendor path when the switch says no, and asks the hub nothing", async () => {
    const hub = {
      inbound: async () => {
        throw new Error("the hub must not be asked");
      },
    } as unknown as ChannelConnectorHub;
    const reading = await readChannelIngress(
      { endpoint: TELEGRAM, readRaw: async () => UPDATE },
      { hub, isConnected: () => false },
    );

    expect(reading).toEqual({
      path: "direct",
      suppress: false,
      suppression: null,
      admissionReason: null,
      turn: null,
      failure: null,
    });
    expect(channelIngressCounters()).toEqual({ adapter: 0, direct: 1 });
  });

  it("names an unreadable body instead of throwing", async () => {
    const { hub } = ingressHub(fakeTelegram());
    const reading = await readChannelIngress(
      {
        endpoint: TELEGRAM,
        readRaw: async () => {
          throw new Error("body already consumed");
        },
      },
      { hub },
    );

    expect(reading.path).toBe("direct");
    expect(reading.failure).toEqual({ area: "ingress.readRaw", message: "body already consumed" });
  });
});