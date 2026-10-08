// Routing through the channel connector hub (design section 3.2) with a fake
// connector for Telegram and a fake store for the endpoints.
//
// The registered provider gets the call; a provider without a connector, an
// endpoint the store cannot read and a connector that throws all leave the
// vendor path in charge.

import { afterEach, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import type {
  ChannelConnector,
  ChannelConnectorStore,
  ChannelEndpointView,
  ChannelLogSink,
  ChannelPublication,
  ChannelTransportSink,
} from "./contract.js";
import { myrmidonChannelConnectorHub } from "./hub.js";
import { registerChannelConnector, unregisterChannelConnector } from "./registry.js";

const ENDPOINT: ChannelEndpointView = {
  id: "11111111-1111-4111-8111-111111111111",
  companyId: "22222222-2222-4222-8222-222222222222",
  provider: "telegram",
  publicId: "public-telegram",
  status: "active",
};

const SLACK_ENDPOINT: ChannelEndpointView = { ...ENDPOINT, provider: "slack" };

const PUBLICATION: ChannelPublication = {
  endpointId: ENDPOINT.id,
  companyId: ENDPOINT.companyId,
  conversationKey: "channel-1",
  idempotencyKey: "publication-1",
  text: "hello",
  media: [],
  replyToExternalId: null,
};

const transport: ChannelTransportSink = {
  sendPart: async (part) => ({ externalMessageId: part.kind === "text" ? "2002" : null }),
};

const noDb = {} as unknown as Db;

interface Fixture {
  readonly connector: ChannelConnector;
  readonly calls: string[];
}

function fakeTelegram(options: { admit?: boolean; normalize?: "turn" | "nothing" | "throw" } = {}) {
  const calls: string[] = [];
  const connector: ChannelConnector = {
    provider: "telegram",
    lifecycle: {
      start: async (endpoint) => {
        calls.push("lifecycle.start");
        return { endpointId: endpoint.id, provider: "telegram", status: "ready", leaseKey: null };
      },
      stop: async () => {
        calls.push("lifecycle.stop");
      },
      status: async () => {
        calls.push("lifecycle.status");
        return "ready";
      },
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
        if (options.normalize === "throw") {
          throw new Error("no payload in the event");
        }
        if (options.normalize === "nothing") {
          return null;
        }
        return {
          endpointId: ENDPOINT.id,
          provider: "telegram",
          conversationKey: "channel-1",
          conversationUrl: null,
          authorExternalId: "user-a",
          addressedToBot: true,
          text: "hello",
          media: [],
          receivedAt: new Date("2026-10-08T00:00:00.000Z"),
          raw,
        };
      },
      admit: async () => {
        calls.push("inbound.admit");
        const admitted = options.admit ?? true;
        return { admitted, reason: admitted ? null : "not-addressed" };
      },
      intakeMedia: async () => {
        calls.push("inbound.intakeMedia");
        return { accepted: true, intake: [], rejected: [] };
      },
    },
    outbound: {
      plan: async (publication) => {
        calls.push("outbound.plan");
        return {
          endpointId: publication.endpointId,
          conversationKey: publication.conversationKey,
          idempotencyKey: publication.idempotencyKey,
          parts: [{ kind: "text", text: publication.text, media: null }],
        };
      },
      send: async () => {
        calls.push("outbound.send");
        return { delivered: true, externalMessageIds: ["2002"], failedPartIndex: null };
      },
    },
    media: { fileLimitBytes: 1024, captionLimit: 64, accepts: ["photo"] },
    settings: {
      keys: [],
      resolve: async () => {
        calls.push("settings.resolve");
        return { endpointId: ENDPOINT.id, values: { fileLimitBytes: 1024 }, sources: { fileLimitBytes: "default" } };
      },
    },
  };
  return { connector, calls } satisfies Fixture;
}

function hubWith(view: ChannelEndpointView | null, fixture?: Fixture) {
  if (fixture !== undefined) {
    registerChannelConnector("telegram", () => fixture.connector);
  }
  const logged: string[] = [];
  const logger: ChannelLogSink = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (message) => {
      logged.push(message);
    },
  };
  const store: ChannelConnectorStore = { readEndpoint: async () => view };
  const hub = myrmidonChannelConnectorHub(noDb, {
    store,
    logger,
    now: () => new Date("2026-10-08T00:00:00.000Z"),
  });
  return { hub, logged };
}

afterEach(() => {
  unregisterChannelConnector("telegram");
});

describe("channel connector hub", () => {
  it("routes an inbound event of a registered provider through its connector", async () => {
    const fixture = fakeTelegram();
    const { hub } = hubWith(ENDPOINT, fixture);

    const outcome = await hub.inbound({ endpoint: ENDPOINT, raw: { text: "hello" } });

    expect(outcome.decision).toBe("connector");
    expect(outcome.provider).toBe("telegram");
    expect(outcome.failure).toBeNull();
    expect(outcome.result?.turn?.text).toBe("hello");
    expect(outcome.result?.admission?.admitted).toBe(true);
    expect(outcome.result?.media?.accepted).toBe(true);
    expect(fixture.calls).toEqual(["inbound.normalize", "inbound.admit", "inbound.intakeMedia"]);
  });

  it("leaves a provider without a connector on the vendor path", async () => {
    const { hub } = hubWith(SLACK_ENDPOINT);

    const inbound = await hub.inbound({ endpoint: SLACK_ENDPOINT, raw: { text: "hello" } });
    expect(inbound).toEqual({
      decision: "passthrough",
      provider: "slack",
      result: null,
      failure: null,
    });

    const outbound = await hub.outbound({ publication: PUBLICATION, transport });
    expect(outbound.decision).toBe("passthrough");
    expect(outbound.provider).toBeNull();
    expect(outbound.failure).toBeNull();

    const started = await hub.lifecycle.start({ endpoint: SLACK_ENDPOINT });
    const stopped = await hub.lifecycle.stop({ endpoint: SLACK_ENDPOINT, reason: "disabled" });
    const settings = await hub.settings({ endpoint: SLACK_ENDPOINT });
    expect([started.decision, stopped.decision, settings.decision]).toEqual([
      "passthrough",
      "passthrough",
      "passthrough",
    ]);
  });

  it("passes an event the connector reads as something other than a message", async () => {
    const fixture = fakeTelegram({ normalize: "nothing" });
    const { hub } = hubWith(ENDPOINT, fixture);

    const outcome = await hub.inbound({ endpoint: ENDPOINT, raw: {} });

    expect(outcome.decision).toBe("connector");
    expect(outcome.result).toEqual({ turn: null, admission: null, media: null });
    expect(fixture.calls).toEqual(["inbound.normalize"]);
  });

  it("skips the media intake of a turn that was not admitted", async () => {
    const fixture = fakeTelegram({ admit: false });
    const { hub } = hubWith(ENDPOINT, fixture);

    const outcome = await hub.inbound({ endpoint: ENDPOINT, raw: { text: "hello" } });

    expect(outcome.result?.admission).toEqual({ admitted: false, reason: "not-addressed" });
    expect(outcome.result?.media).toBeNull();
    expect(fixture.calls).toEqual(["inbound.normalize", "inbound.admit"]);
  });

  it("keeps the vendor path when the connector throws, and logs the area", async () => {
    const fixture = fakeTelegram({ normalize: "throw" });
    const { hub, logged } = hubWith(ENDPOINT, fixture);

    const outcome = await hub.inbound({ endpoint: ENDPOINT, raw: { text: "hello" } });

    expect(outcome.decision).toBe("passthrough");
    expect(outcome.provider).toBe("telegram");
    expect(outcome.result).toBeNull();
    expect(outcome.failure).toEqual({ area: "inbound", message: "no payload in the event" });
    expect(logged).toEqual(["channel connector failed, the vendor path keeps the endpoint"]);
  });

  it("reads the endpoint of a publication and sends its parts", async () => {
    const fixture = fakeTelegram();
    const { hub } = hubWith(ENDPOINT, fixture);

    const outcome = await hub.outbound({ publication: PUBLICATION, transport });

    expect(outcome.decision).toBe("connector");
    expect(outcome.result).toEqual({
      delivered: true,
      externalMessageIds: ["2002"],
      failedPartIndex: null,
    });
    expect(fixture.calls).toEqual(["outbound.plan", "outbound.send"]);
  });

  it("keeps the vendor path when the endpoint of a publication is unreadable", async () => {
    const fixture = fakeTelegram();
    const { hub } = hubWith(null, fixture);

    const outcome = await hub.outbound({ publication: PUBLICATION, transport });

    expect(outcome.decision).toBe("passthrough");
    expect(outcome.failure?.area).toBe("hub.outbound");
    expect(fixture.calls).toEqual([]);
  });

  it("routes the start, the stop and the settings of a registered provider", async () => {
    const fixture = fakeTelegram();
    const { hub } = hubWith(ENDPOINT, fixture);

    const started = await hub.lifecycle.start({ endpoint: ENDPOINT });
    expect(started.decision).toBe("connector");
    expect(started.result?.status).toBe("ready");

    const stopped = await hub.lifecycle.stop({ endpoint: ENDPOINT, reason: "disabled" });
    expect(stopped.decision).toBe("connector");
    expect(stopped.result).toBe(true);

    const settings = await hub.settings({ endpoint: ENDPOINT });
    expect(settings.result?.values.fileLimitBytes).toBe(1024);

    expect(fixture.calls).toEqual(["lifecycle.start", "lifecycle.stop", "settings.resolve"]);
  });
});