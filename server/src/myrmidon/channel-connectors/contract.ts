// The channel connector contract.
// Design: docs/myrmidon/design/chat-channel-connector.md, section 3.1.
//
// One connector is one object per provider. It owns five areas over the vendor
// runtime — lifecycle, links, inbound, outbound and media — plus its settings,
// and it neither reaches into the vendor runtime nor writes SQL of its own: the
// data arrives through ChannelConnectorStore and the delivery seam through the
// hub (section 3.3). Every method that touches data takes an explicit context,
// so the contract carries no state of the module.
//
// This file is ours: no vendor file is edited, and no connector is registered
// yet, so nothing in the running server changes behaviour.

/** The provider ids our connectors may be registered for. The set mirrors the
 *  vendor chat sdk union `ChatSdkProvider` (server/src/services/chat-sdk-runtime.ts).
 *  An endpoint whose provider falls outside the set — the vendor `ChatProvider`
 *  union also carries other ids — has no connector and stays on the vendor path. */
export type ChatProviderName =
  | "slack"
  | "github"
  | "discord"
  | "microsoft-teams"
  | "telegram"
  | "imessage-photon";

/** Every provider of the contract, in the order of the vendor union. */
export const CHAT_PROVIDER_NAMES: readonly ChatProviderName[] = [
  "slack",
  "github",
  "discord",
  "microsoft-teams",
  "telegram",
  "imessage-photon",
];

/** True when the value is one of the provider ids of this contract. */
export function isChatProviderName(value: unknown): value is ChatProviderName {
  return typeof value === "string" && (CHAT_PROVIDER_NAMES as readonly string[]).includes(value);
}

/** The media kinds a connector may declare. The vendor runtime carries the same
 *  families; a connector names them in its own words and translates on the way
 *  out. */
export const MEDIA_KINDS = ["photo", "video", "audio", "voice", "sticker", "document"] as const;

export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Where a channel stands. The hub reads it; the vendor row keeps its own union
 *  and is never rewritten from here. */
export type ChannelStatus = "disabled" | "connecting" | "ready" | "degraded";

/** Why a channel was stopped: the switch in the interface (`disabled`), a newer
 *  runtime taking the endpoint over (`replaced`) or a failure (`error`). */
export type ChannelStopReason = "disabled" | "replaced" | "error";

/** The endpoint the hub routes by: an id and its provider. */
export interface ChannelEndpointRef {
  readonly id: string;
  readonly provider: ChatProviderName;
}

/** Read-only projection of a `chat_endpoints` row (store.ts). `status` stays a
 *  string on purpose: the vendor union owns it, and an unknown value must not
 *  make the projection fail. */
export interface ChannelEndpointView extends ChannelEndpointRef {
  readonly companyId: string;
  readonly publicId: string;
  readonly status: string;
}

/** The runtime a connector holds for one endpoint. `start` and `stop` write the
 *  state and the endpoint lease; they never restart the server (design section 7). */
export interface ChannelRuntime {
  readonly endpointId: string;
  readonly provider: ChatProviderName;
  readonly status: ChannelStatus;
  /** The lease the runtime holds in `chat_endpoint_leases`, null when it holds none. */
  readonly leaseKey: string | null;
}

/** A transport event exactly as the vendor runtime hands it over. The shape is
 *  the provider's business: `normalize` turns it into a ChannelTurn. */
export type ChannelRawEvent = unknown;

/** One conversation as the connector sees it. */
export interface ChannelConversation {
  readonly endpointId: string;
  readonly conversationKey: string;
  readonly externalId: string | null;
}

/** The task and the agent a turn is addressed to. */
export interface ChannelRoute {
  readonly endpointId: string;
  readonly companyId: string;
  readonly conversationKey: string;
  readonly issueId: string | null;
  readonly agentId: string | null;
}

/** One piece of inbound media, as the transport describes it before download. */
export interface ChannelMediaRef {
  readonly kind: MediaKind;
  readonly externalId: string;
  readonly fileName: string | null;
  readonly mimeType: string | null;
  readonly sizeBytes: number | null;
}

/** An inbound turn in our terms: what the connector made of one transport event. */
export interface ChannelTurn {
  readonly endpointId: string;
  readonly provider: ChatProviderName;
  readonly conversationKey: string;
  readonly conversationUrl: string | null;
  readonly authorExternalId: string;
  /** True when the message addresses the bot (mention, direct message, reply). */
  readonly addressedToBot: boolean;
  readonly text: string;
  readonly media: readonly ChannelMediaRef[];
  readonly receivedAt: Date;
  /** The event the turn came from, for a connector that needs the details back. */
  readonly raw: ChannelRawEvent;
}

/** Why a turn does not enter our pipeline. */
export type ChannelAdmissionReason =
  | "disabled"
  | "not-addressed"
  | "held"
  | "topic-gated"
  | "no-rights"
  | "duplicate";

/** The decision of the connector on one turn. */
export interface ChannelAdmission {
  readonly admitted: boolean;
  readonly reason: ChannelAdmissionReason | null;
}

/** One piece of media the connector refused, and why. */
export interface ChannelMediaRejection {
  readonly media: ChannelMediaRef;
  readonly reason: "too-large" | "unsupported" | "download-failed";
}

/** What came of the media of one turn. */
export interface MediaIntakeResult {
  readonly accepted: boolean;
  readonly intake: readonly ChannelMediaRef[];
  readonly rejected: readonly ChannelMediaRejection[];
}

/** One publication to deliver: the outbox record of the vendor path, in our terms. */
export interface ChannelPublication {
  readonly endpointId: string;
  readonly companyId: string;
  readonly conversationKey: string;
  /** The idempotency key of the outbox row this publication came from. */
  readonly idempotencyKey: string;
  readonly text: string;
  readonly media: readonly ChannelMediaRef[];
  readonly replyToExternalId: string | null;
}

export type TransportPartKind = "text" | "media" | "status-line";

/** One part of a plan, as the transport takes it. */
export interface TransportPart {
  readonly kind: TransportPartKind;
  readonly text: string | null;
  readonly media: ChannelMediaRef | null;
}

/** What the connector decided to send, in transport terms. */
export interface TransportPlan {
  readonly endpointId: string;
  readonly conversationKey: string;
  readonly idempotencyKey: string;
  readonly parts: readonly TransportPart[];
}

/** The delivery seam the hub hands to the connector (section 3.3): the connector
 *  plans, the vendor transport delivers one part and keeps the outbox record. */
export interface ChannelTransportSink {
  sendPart(part: TransportPart): Promise<{ externalMessageId: string | null }>;
}

/** What came of a plan. `failedPartIndex` indexes TransportPlan.parts and is
 *  null when every part went out. */
export interface SendResult {
  readonly delivered: boolean;
  readonly externalMessageIds: readonly string[];
  readonly failedPartIndex: number | null;
}

export type ChannelSettingValue = string | number | boolean | null;

/** Where a setting value comes from. The names are the ones the settings track
 *  already uses (server/src/myrmidon/channel-settings/settings.ts). */
export type ChannelSettingSource = "env" | "ui" | "default";

/** One setting a connector declares: the key, the environment name that pins it
 *  and the value in force when nobody set anything. */
export interface ChannelSettingDescriptor {
  readonly key: string;
  readonly envVar: string;
  readonly summary: string;
  readonly defaultValue: ChannelSettingValue;
}

/** The settings in force for one endpoint, with the source of every value. */
export interface ResolvedChannelSettings {
  readonly endpointId: string;
  readonly values: Readonly<Record<string, ChannelSettingValue>>;
  readonly sources: Readonly<Record<string, ChannelSettingSource>>;
}

/** Journal the hub hands to a connector. */
export interface ChannelLogSink {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

/** The single data-access seam for the connectors (section 3.3): implemented in
 *  store.ts over the existing vendor tables, so no connector writes SQL of its
 *  own. Step S1 ships the read the hub itself needs; the later steps add the
 *  reads the connectors ask for. */
export interface ChannelConnectorStore {
  readEndpoint(endpointId: string): Promise<ChannelEndpointView | null>;
}

/** What every connector method gets: the company, the data seam, the journal and
 *  the clock. The clock is injected so a test can pin time. */
export interface ChannelConnectorContext {
  readonly companyId: string;
  readonly store: ChannelConnectorStore;
  readonly logger: ChannelLogSink;
  readonly now: () => Date;
}

/** The connector itself, grouped by area. */
export interface ChannelConnector {
  readonly provider: ChatProviderName;

  /** Creates and drops the runtime of one endpoint. */
  readonly lifecycle: {
    start(endpoint: ChannelEndpointView, ctx: ChannelConnectorContext): Promise<ChannelRuntime>;
    stop(
      endpoint: ChannelEndpointView,
      reason: ChannelStopReason,
      ctx: ChannelConnectorContext,
    ): Promise<void>;
    status(endpoint: ChannelEndpointView, ctx: ChannelConnectorContext): Promise<ChannelStatus>;
  };

  /** Conversation identity and the task link. */
  readonly links: {
    /** Stable key of the conversation an event belongs to. An event the
     *  connector cannot read answers with an empty key. */
    conversationKey(event: ChannelRawEvent): string;
    conversationUrl(conversation: ChannelConversation): string | null;
    route(event: ChannelRawEvent, ctx: ChannelConnectorContext): Promise<ChannelRoute | null>;
    bind(
      conversation: ChannelConversation,
      route: ChannelRoute,
      ctx: ChannelConnectorContext,
    ): Promise<void>;
  };

  /** The inbound path: transport event, decision, media. */
  readonly inbound: {
    /** The event in our terms, or null when it is not a message for us. */
    normalize(raw: ChannelRawEvent, ctx: ChannelConnectorContext): Promise<ChannelTurn | null>;
    admit(turn: ChannelTurn, ctx: ChannelConnectorContext): Promise<ChannelAdmission>;
    intakeMedia(turn: ChannelTurn, ctx: ChannelConnectorContext): Promise<MediaIntakeResult>;
  };

  /** The outbound path: plan, then send part by part. */
  readonly outbound: {
    plan(publication: ChannelPublication, ctx: ChannelConnectorContext): Promise<TransportPlan>;
    send(
      plan: TransportPlan,
      transport: ChannelTransportSink,
      ctx: ChannelConnectorContext,
    ): Promise<SendResult>;
  };

  /** What the channel carries. The limits are numbers of the provider, not of
   *  the core: the core asks the connector instead of knowing Telegram. */
  readonly media: {
    readonly fileLimitBytes: number;
    readonly captionLimit: number;
    readonly accepts: readonly MediaKind[];
  };

  /** The settings of the channel. */
  readonly settings: {
    readonly keys: readonly ChannelSettingDescriptor[];
    resolve(ctx: ChannelConnectorContext): Promise<ResolvedChannelSettings>;
  };
}

/** Areas and members every connector carries. The watchdog test builds the
 *  connector of the module from this map, so a member the interface grows
 *  without the fixture — or a fixture member the interface drops — fails there
 *  instead of at a call site in a later step. */
export const CHANNEL_CONNECTOR_AREAS = {
  provider: [],
  lifecycle: ["start", "stop", "status"],
  links: ["conversationKey", "conversationUrl", "route", "bind"],
  inbound: ["normalize", "admit", "intakeMedia"],
  outbound: ["plan", "send"],
  media: ["fileLimitBytes", "captionLimit", "accepts"],
  settings: ["keys", "resolve"],
} as const;

export type ChannelConnectorArea = keyof typeof CHANNEL_CONNECTOR_AREAS;