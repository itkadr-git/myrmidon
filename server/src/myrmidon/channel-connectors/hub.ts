// The channel connector hub.
// Design: docs/myrmidon/design/chat-channel-connector.md, section 3.2.
//
// The hub is the only object the core knows. The core hands it an endpoint, an
// inbound transport event, a publication or a settings read; the hub routes by
// endpoint.provider through the registry. Nothing else of the conversation
// belongs here: which parts the channel takes, which media it carries and where
// a conversation points at are the business of the connector.
//
// Fail-open (section 7): a provider nobody registered, an endpoint the store
// cannot read, and a connector that throws all answer "passthrough", so the
// vendor path keeps the endpoint and no channel falls silent on a mistake of
// ours. Every failure is logged with its area for the journal of the caller.

import type { Db } from "@paperclipai/db";
import type {
  ChannelAdmission,
  ChannelConnector,
  ChannelConnectorContext,
  ChannelConnectorStore,
  ChannelEndpointView,
  ChannelLogSink,
  ChannelPublication,
  ChannelRuntime,
  ChannelStopReason,
  ChannelTransportSink,
  ChannelTurn,
  ChatProviderName,
  MediaIntakeResult,
  ResolvedChannelSettings,
  SendResult,
} from "./contract.js";
import { getChannelConnector } from "./registry.js";
import { channelConnectorStore } from "./store.js";

/** Who was in charge of one call: our connector or the vendor path. */
export type ChannelHubDecision = "connector" | "passthrough";

/** Where a connector broke and what it said. */
export interface ChannelConnectorFailure {
  /** The call that broke, "inbound" or "lifecycle.start" style. */
  readonly area: string;
  readonly message: string;
}

/** The answer of one hub call. `result` is null whenever the vendor path
 *  answered. A failure on the vendor path says why; a clean pass-through — a
 *  provider without a connector — carries none. */
export interface ChannelHubOutcome<T> {
  readonly decision: ChannelHubDecision;
  readonly provider: ChatProviderName | null;
  readonly result: T | null;
  readonly failure: ChannelConnectorFailure | null;
}

/** One inbound transport event of one endpoint. */
export interface ChannelInboundInput {
  readonly endpoint: ChannelEndpointView;
  readonly raw: unknown;
}

/** One publication and the vendor transport that delivers its parts. */
export interface ChannelOutboundInput {
  readonly publication: ChannelPublication;
  readonly transport: ChannelTransportSink;
}

export interface ChannelLifecycleInput {
  readonly endpoint: ChannelEndpointView;
}

export interface ChannelStopInput {
  readonly endpoint: ChannelEndpointView;
  readonly reason: ChannelStopReason;
}

export interface ChannelSettingsInput {
  readonly endpoint: ChannelEndpointView;
}

/** What the hub made of one inbound event. A null `turn` means the connector
 *  read the event as something other than a message for us; `media` stays null
 *  for a turn that was not admitted. */
export interface ChannelInboundOutcome {
  readonly turn: ChannelTurn | null;
  readonly admission: ChannelAdmission | null;
  readonly media: MediaIntakeResult | null;
}

/** Ports of the hub: the data seam, the journal and the clock. A test drives the
 *  hub through them without a database. */
export interface ChannelConnectorHubDeps {
  readonly store?: ChannelConnectorStore;
  readonly logger?: ChannelLogSink;
  readonly now?: () => Date;
}

export interface ChannelConnectorHub {
  inbound(input: ChannelInboundInput): Promise<ChannelHubOutcome<ChannelInboundOutcome>>;
  outbound(input: ChannelOutboundInput): Promise<ChannelHubOutcome<SendResult>>;
  readonly lifecycle: {
    start(input: ChannelLifecycleInput): Promise<ChannelHubOutcome<ChannelRuntime>>;
    stop(input: ChannelStopInput): Promise<ChannelHubOutcome<true>>;
  };
  settings(input: ChannelSettingsInput): Promise<ChannelHubOutcome<ResolvedChannelSettings>>;
}

/** Journal of the hub when the caller passes none: at this step no connector is
 *  registered, so there is nothing to report and nothing to write to. */
const silentChannelLog: ChannelLogSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** The hub over the vendor database. The core builds one hub and keeps it. */
export function myrmidonChannelConnectorHub(
  db: Db,
  deps: ChannelConnectorHubDeps = {},
): ChannelConnectorHub {
  const store = deps.store ?? channelConnectorStore(db);
  const logger = deps.logger ?? silentChannelLog;
  const now = deps.now ?? (() => new Date());

  const contextOf = (endpoint: ChannelEndpointView): ChannelConnectorContext => ({
    companyId: endpoint.companyId,
    store,
    logger,
    now,
  });

  const passedThrough = <T>(
    provider: ChatProviderName | null,
    failure: ChannelConnectorFailure | null = null,
  ): ChannelHubOutcome<T> => ({
    decision: "passthrough",
    provider,
    result: null,
    failure,
  });

  /** One connector call. The registry picks the connector; every way of not
   *  having a working one leaves the vendor path in charge. */
  async function routed<T>(
    endpoint: ChannelEndpointView,
    area: string,
    call: (connector: ChannelConnector) => Promise<T>,
  ): Promise<ChannelHubOutcome<T>> {
    try {
      const connector = getChannelConnector(endpoint.provider, { store, logger, now });
      if (connector === null) {
        return passedThrough<T>(endpoint.provider);
      }
      const result = await call(connector);
      return { decision: "connector", provider: endpoint.provider, result, failure: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("channel connector failed, the vendor path keeps the endpoint", {
        endpointId: endpoint.id,
        provider: endpoint.provider,
        area,
        message,
      });
      return passedThrough<T>(endpoint.provider, { area, message });
    }
  }

  return {
    async inbound(input) {
      const endpoint = input.endpoint;
      return routed<ChannelInboundOutcome>(endpoint, "inbound", async (connector) => {
        const ctx = contextOf(endpoint);
        const turn = await connector.inbound.normalize(input.raw, ctx);
        if (turn === null) {
          return { turn: null, admission: null, media: null };
        }
        const admission = await connector.inbound.admit(turn, ctx);
        const media = admission.admitted ? await connector.inbound.intakeMedia(turn, ctx) : null;
        return { turn, admission, media };
      });
    },

    async outbound(input) {
      const endpointId = input.publication.endpointId;
      let endpoint: ChannelEndpointView | null;
      try {
        endpoint = await store.readEndpoint(endpointId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error("channel endpoint read failed, the vendor path keeps the endpoint", {
          endpointId,
          message,
        });
        return passedThrough<SendResult>(null, { area: "hub.outbound", message });
      }
      if (endpoint === null) {
        return passedThrough<SendResult>(null, {
          area: "hub.outbound",
          message: `endpoint ${endpointId} is not readable for the connector contract`,
        });
      }
      return routed<SendResult>(endpoint, "outbound", async (connector) => {
        const ctx = contextOf(endpoint);
        const plan = await connector.outbound.plan(input.publication, ctx);
        return connector.outbound.send(plan, input.transport, ctx);
      });
    },

    lifecycle: {
      start(input) {
        return routed<ChannelRuntime>(input.endpoint, "lifecycle.start", (connector) =>
          connector.lifecycle.start(input.endpoint, contextOf(input.endpoint)),
        );
      },
      async stop(input) {
        return routed<true>(input.endpoint, "lifecycle.stop", async (connector) => {
          await connector.lifecycle.stop(input.endpoint, input.reason, contextOf(input.endpoint));
          return true as const;
        });
      },
    },

    settings(input) {
      return routed<ResolvedChannelSettings>(input.endpoint, "settings.resolve", (connector) =>
        connector.settings.resolve(contextOf(input.endpoint)),
      );
    },
  };
}