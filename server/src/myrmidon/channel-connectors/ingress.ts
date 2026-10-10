// The inbound read of the channel connectors — the ingress seam.
// Design: docs/myrmidon/design/chat-channel-connector.md, sections 3.2, 4 and 7.
//
// One transport event of one endpoint is read once. When a connector is
// registered for the provider of that endpoint — the switch of this step, see
// the change fragment — the read goes through it: the connector turns the event
// into a turn (normalize) and says whether the turn enters our pipeline (admit).
// The seam reports which path read the event, counts it in
// myrmidon_chat_ingress_total{path="adapter"|"direct"} and tells the caller
// whether the event stops here.
//
// The seam delivers nothing itself. An admitted turn goes on to the same
// internal queue the vendor path feeds (section 4: one connection point, one
// queue), so one update cannot be delivered twice and the idempotency key of
// that queue — its external event id — stays the only one. A turn the connector
// refuses never reaches the queue, and that includes the connector's own
// `duplicate` answer. Media stays with the vendor path for now: the connector
// classifies the media of a turn (intakeMedia) but the seam does not consume
// the result yet — media is a theme of its own (step 3).
//
// Fail-open (section 7): no connector, a connector that throws, an event the
// connector cannot read — every one of them reads as `direct` and leaves the
// event to the vendor path, so no channel goes silent on a mistake of ours.

import type { Logger } from "pino";
import { getChannelConnectorFactory } from "./registry.js";
import { channelEndpointIngressView, type ChannelEndpointRowInput } from "./store.js";
import type {
  ChannelAdmissionReason,
  ChannelEndpointView,
  ChannelLogSink,
  ChannelTurn,
  ChatProviderName,
} from "./contract.js";
import type {
  ChannelConnectorFailure,
  ChannelConnectorHub,
  ChannelHubOutcome,
  ChannelInboundOutcome,
} from "./hub.js";

/** Who read one inbound event: our connector (`adapter`) or the vendor path. */
export type ChannelIngressPath = "adapter" | "direct";

/** Why an event never reached the queue. */
export type ChannelIngressSuppression = "not-a-message" | "not-admitted";

/** What one read made of one transport event. */
export interface ChannelIngressReading {
  /** The path the event was read on. */
  readonly path: ChannelIngressPath;
  /** True when the caller must stop: the event does not go on to the queue. */
  readonly suppress: boolean;
  /** Why it stopped, null when the event goes on. */
  readonly suppression: ChannelIngressSuppression | null;
  /** The answer of the connector when it refused the turn — its own reason,
   *  including `duplicate`. Null when the connector did not answer one. */
  readonly admissionReason: ChannelAdmissionReason | null;
  /** The turn the connector made of the event, null when it made none. */
  readonly turn: ChannelTurn | null;
  /** Where the read broke, so the caller can report it. Fail-open reads as
   *  `direct` and carry the failure. */
  readonly failure: ChannelConnectorFailure | null;
}

export interface ChannelIngressInput {
  readonly endpoint: ChannelEndpointView;
  /** The transport event exactly as the provider sent it. Read lazily: a
   *  provider no connector reads never touches the body. */
  readonly readRaw: () => Promise<unknown>;
}

/** Ports of the seam. A test drives it without a database, a registry or a
 *  request. */
export interface ChannelIngressDeps {
  readonly hub: ChannelConnectorHub;
  readonly logger?: ChannelLogSink;
  /** Whether a connector reads this provider — the switch of this step. The
   *  default asks the registry, so registering a connector is what turns the
   *  read over to it. */
  readonly isConnected?: (provider: ChatProviderName) => boolean;
}

/** True when a connector is registered for this provider — the switch of this
 *  step, answered by the registry. */
export function channelIngressReadsProvider(provider: unknown): provider is ChatProviderName {
  return (
    typeof provider === "string" && getChannelConnectorFactory(provider as ChatProviderName) !== null
  );
}

/** The journal of the vendor service, in the words of the contract. Pino takes
 *  the fields first and the message second; `ChannelLogSink` the other way
 *  round, so one adapter is all the call site needs. */
export function channelLogSinkOf(
  log: Pick<Logger, "debug" | "info" | "warn" | "error">,
): ChannelLogSink {
  return {
    debug: (message, meta) => log.debug(meta ?? {}, message),
    info: (message, meta) => log.info(meta ?? {}, message),
    warn: (message, meta) => log.warn(meta ?? {}, message),
    error: (message, meta) => log.error(meta ?? {}, message),
  };
}

/** How many inbound events were read on each path, for the metric
 *  `myrmidon_chat_ingress_total{path=...}`. */
export interface ChannelIngressCounters {
  readonly adapter: number;
  readonly direct: number;
}

const ingressReads = { adapter: 0, direct: 0 };

/** Count one read. The seam calls it itself, so no call site can forget. */
export function recordChannelIngressRead(path: ChannelIngressPath): void {
  ingressReads[path] += 1;
}

/** The counters of this process. Both paths are always reported, a path nothing
 *  was read on as a zero. */
export function channelIngressCounters(): ChannelIngressCounters {
  return { adapter: ingressReads.adapter, direct: ingressReads.direct };
}

/** Test seam: forget the reads of this process. */
export function resetChannelIngressCounters(): void {
  ingressReads.adapter = 0;
  ingressReads.direct = 0;
}

const silentChannelLog: ChannelLogSink = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Read one inbound transport event of one endpoint, through the connector when
 *  one reads this provider. Never throws: every way of not having a working
 *  connector answers `direct` and leaves the event to the vendor path. */
export async function readChannelIngress(
  input: ChannelIngressInput,
  deps: ChannelIngressDeps,
): Promise<ChannelIngressReading> {
  const endpoint = input.endpoint;
  const logger = deps.logger ?? silentChannelLog;
  const isConnected =
    deps.isConnected ??
    ((provider: ChatProviderName) => getChannelConnectorFactory(provider) !== null);

  const readAs = (
    path: ChannelIngressPath,
    rest: Partial<ChannelIngressReading> = {},
  ): ChannelIngressReading => {
    recordChannelIngressRead(path);
    return {
      path,
      suppress: false,
      suppression: null,
      admissionReason: null,
      turn: null,
      failure: null,
      ...rest,
    };
  };

  if (!isConnected(endpoint.provider)) {
    return readAs("direct");
  }

  let raw: unknown;
  try {
    raw = await input.readRaw();
  } catch (error) {
    const message = messageOf(error);
    logger.error("channel ingress event is unreadable, the vendor path keeps the endpoint", {
      endpointId: endpoint.id,
      provider: endpoint.provider,
      message,
    });
    return readAs("direct", { failure: { area: "ingress.readRaw", message } });
  }

  let outcome: ChannelHubOutcome<ChannelInboundOutcome>;
  try {
    outcome = await deps.hub.inbound({ endpoint, raw });
  } catch (error) {
    // The hub answers `passthrough` instead of throwing; a port of ours that
    // breaks anyway must not close the channel.
    const message = messageOf(error);
    logger.error("channel ingress read failed, the vendor path keeps the endpoint", {
      endpointId: endpoint.id,
      provider: endpoint.provider,
      message,
    });
    return readAs("direct", { failure: { area: "ingress.inbound", message } });
  }

  if (outcome.decision !== "connector" || outcome.result === null) {
    return readAs("direct", { failure: outcome.failure });
  }

  const { turn, admission } = outcome.result;
  if (turn === null) {
    // The connector read the event as something other than a message for us.
    return readAs("adapter", { suppress: true, suppression: "not-a-message" });
  }
  if (admission === null || !admission.admitted) {
    // A turn without an answer is not admitted: the hub always answers, and the
    // one reading that has none is a contract breach, not a licence to deliver.
    return readAs("adapter", {
      suppress: true,
      suppression: "not-admitted",
      admissionReason: admission?.reason ?? null,
      turn,
    });
  }
  return readAs("adapter", { turn });
}

// What the vendor webhook path already holds: the endpoint row it read and the
// request it has. The row is structural, so this module never imports the vendor
// row type.

/** What the vendor webhook path hands over: the row it already read and the
 *  request it already holds. */
export interface ChannelIngressWebhookInput {
  readonly endpoint: ChannelEndpointRowInput | null | undefined;
  readonly request: { clone: () => { text: () => Promise<string> } };
}

/** One inbound webhook event, handed to this seam by the vendor path. Answers
 *  true when the event stops with us: the connector read it as no message for
 *  us or refused the turn, and the caller returns its own 200 without the event
 *  going on. False means the vendor path keeps the event — also the answer for
 *  a provider no connector reads, for a row the contract cannot read, and for
 *  every mistake of ours: fail-open, no channel goes silent.
 *
 *  One of the four flows of the hub (design section 4), and the call the vendor
 *  file grows for it: everything channel-specific is here. */
export async function readInboundEventThroughConnector(
  hub: ChannelConnectorHub,
  input: ChannelIngressWebhookInput,
  deps: { readonly logger?: ChannelLogSink } = {},
): Promise<boolean> {
  const endpoint = channelEndpointIngressView(input.endpoint);
  if (endpoint === null) {
    // A row the contract cannot read (a provider of the vendor union outside
    // this contract, or a row without the fields of a view) is never the
    // business of a channel connector, and it is not ingress of ours to count.
    return false;
  }
  if (!channelIngressReadsProvider(endpoint.provider)) {
    // Nobody reads this provider yet: the vendor path reads the event as it
    // always did, and the counter says so — the whole ingress reads as direct
    // until a connector is registered, and the switch shows up when it is.
    recordChannelIngressRead("direct");
    return false;
  }

  const reading = await readChannelIngress(
    {
      endpoint,
      readRaw: async () => JSON.parse(await input.request.clone().text()) as unknown,
    },
    { hub, logger: deps.logger, isConnected: () => true },
  );

  return reading.suppress;
}