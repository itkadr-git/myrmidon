// The Telegram channel connector (chat-provider-telegram).
// Design: docs/myrmidon/design/chat-channel-connector.md, sections 3.1-3.4.
// Task: OPE-6960 (OPE-4956 part C).
//
// One connector object for the `telegram` provider over the contract of
// contract.ts: lifecycle, links, inbound, outbound, media and settings. The
// module is self-contained — it edits no vendor file and registers itself
// nowhere. Until the installation flag is on and a later step wires the hub
// into the message lanes, nothing in the running server changes: the direct
// Telegram integration keeps carrying traffic exactly as before (fail-open
// section 7: an unregistered provider is a pass-through).
//
// What the connector does reuse from the vendor path are pure helpers, not
// lanes: the text-splitting rule of chat-publication-stream, so the planned
// parts are byte-for-byte the parts the direct integration would have sent.
// The conversation key mirrors the vendor's `telegram:<chat>` /
// `telegram:<chat>:<topic>` — the same conversations, one key, no re-linking.

import { MEDIA_KINDS, isChatProviderName } from "./contract.js";
import type {
  ChannelAdmission,
  ChannelConnector,
  ChannelConversation,
  ChannelMediaRejection,
  ChannelEndpointView,
  ChannelMediaRef,
  ChannelPublication,
  ChannelRoute,
  ChannelRuntime,
  ChannelSettingDescriptor,
  ChannelSettingValue,
  ChannelTransportSink,
  ChannelTurn,
  ChatProviderName,
  MediaIntakeResult,
  ResolvedChannelSettings,
  SendResult,
  TransportPart,
  TransportPlan,
} from "./contract.js";
import type { ChannelConnectorFactory, ChannelConnectorFactoryDeps } from "./registry.js";
import { registerChannelConnector } from "./registry.js";
import { splitTelegramPublicationText } from "../../services/chat-publication-stream.js";

/** The provider this connector answers for. */
export const TELEGRAM_CONNECTOR_PROVIDER: ChatProviderName = "telegram";

/** Installation kill switch. Unset or off — the connector is not registered at
 *  all and Telegram stays on the vendor path. This is the config flag the task
 *  asks for: the adapter switches on only here, and off the same way. */
export const TELEGRAM_CHAT_PROVIDER_ENV = "MYRMIDON_TELEGRAM_CHAT_PROVIDER";

/** The bot's Telegram username without the leading `@`. Group messages count
 *  as addressed to the bot only when they mention this name; private chats
 *  are addressed by definition. Unset — the connector admits no group turn. */
export const TELEGRAM_BOT_USERNAME_ENV = "MYRMIDON_TELEGRAM_BOT_USERNAME";

/** Telegram's own limits — the connector carries them so the core never
 *  learns a number of the provider (contract.ts, media area). */
export const TELEGRAM_CAPTION_LIMIT = 1024;
export const TELEGRAM_FILE_LIMIT_BYTES = 50 * 1024 * 1024;

type EnvLike = Record<string, string | undefined>;

export interface TelegramChannelConnectorOptions {
  /** Injectable environment so a test pins time and flags without process. */
  readonly env?: EnvLike;
}

/** True when the value reads as an on-switch: 1/true/yes/on, everything else
 *  (unset, empty, a typo) is off. A typo must never flip the vendor path to
 *  the connector silently (CONVENTIONS.md fail-safe rule). */
export function telegramChatProviderFlagEnabled(env: EnvLike): boolean {
  const raw = env[TELEGRAM_CHAT_PROVIDER_ENV];
  if (raw === undefined) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function telegramBotUsername(env: EnvLike): string | null {
  const raw = env[TELEGRAM_BOT_USERNAME_ENV];
  if (raw === undefined) return null;
  const trimmed = raw.trim().replace(/^@+/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** The vendor row status translated to the contract's ChannelStatus. Unknown
 *  values read as `connecting`: the row is the vendor's union, and a value we
 *  do not know must not stop a channel that works. */
export function telegramChannelStatusFor(endpointStatus: string): ChannelRuntime["status"] {
  switch (endpointStatus) {
    case "connected":
      return "ready";
    case "paused":
    case "disabled":
      return "disabled";
    case "error":
      return "degraded";
    default:
      return "connecting";
  }
}

/** Map a vendor row status onto the runtime the contract reports. */
function runtimeFor(endpoint: ChannelEndpointView): ChannelRuntime {
  return {
    endpointId: endpoint.id,
    provider: TELEGRAM_CONNECTOR_PROVIDER,
    status: telegramChannelStatusFor(endpoint.status),
    // The endpoint lease lives in `chat_endpoint_leases` and the vendor
    // lifecycle owns it until the traffic switch; the connector holds none of
    // its own and says so.
    leaseKey: null,
  };
}

/* ------------------------------------------------------------------ */
/* Telegram update shapes — read structurally, never trusted.           */
/* ------------------------------------------------------------------ */

interface TelegramFileLike {
  readonly file_id?: unknown;
  readonly file_unique_id?: unknown;
  readonly file_size?: unknown;
  readonly file_name?: unknown;
  readonly mime_type?: unknown;
}

interface TelegramUpdateLike {
  readonly message?: unknown;
  readonly edited_message?: unknown;
  readonly channel_post?: unknown;
  readonly edited_channel_post?: unknown;
}

interface TelegramMessageLike {
  readonly chat?: {
    readonly id?: unknown;
    readonly type?: unknown;
    readonly username?: unknown;
  };
  readonly from?: { readonly id?: unknown; readonly username?: unknown };
  readonly text?: unknown;
  readonly caption?: unknown;
  readonly message_id?: unknown;
  readonly message_thread_id?: unknown;
  readonly date?: unknown;
  readonly entities?: unknown;
  readonly photo?: unknown;
  readonly video?: unknown;
  readonly audio?: unknown;
  readonly voice?: unknown;
  readonly sticker?: unknown;
  readonly document?: unknown;
}

/** The message body of an update, whichever lane it arrived on. Mirrors the
 *  vendor's own preference: `message`, then an edited copy, then a channel
 *  post. Returns null for any other update (callback, membership, …) — the
 *  connector normalizes messages, not every event of the transport. */
function telegramMessageOf(raw: unknown): TelegramMessageLike | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const update = raw as TelegramUpdateLike;
  for (const candidate of [
    update.message,
    update.edited_message,
    update.channel_post,
    update.edited_channel_post,
  ]) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as TelegramMessageLike;
    }
  }
  return null;
}

function telegramChatId(message: TelegramMessageLike): string | null {
  const id = message.chat?.id;
  if (typeof id === "number" && Number.isSafeInteger(id)) return String(id);
  if (typeof id === "string" && id.length > 0) return id;
  return null;
}

/** The conversation key: identical to the vendor's (chat-channels.ts builds
 *  `telegram:<chat>` and `telegram:<chat>:<topic>`), so a conversation the
 *  direct integration already linked stays the same conversation here. */
export function telegramConversationKeyOf(event: unknown): string {
  const message = telegramMessageOf(event);
  if (message === null) return "";
  const chat = telegramChatId(message);
  if (chat === null) return "";
  const topic = message.message_thread_id;
  if (typeof topic === "number" && Number.isSafeInteger(topic) && topic > 0) {
    return `telegram:${chat}:${topic}`;
  }
  return `telegram:${chat}`;
}

function telegramText(message: TelegramMessageLike): string {
  if (typeof message.text === "string") return message.text;
  if (typeof message.caption === "string") return message.caption;
  return "";
}

function telegramMediaRef(kind: (typeof MEDIA_KINDS)[number], value: unknown): ChannelMediaRef | null {
  const file = (Array.isArray(value) ? [...value].reverse().find((i) => i && typeof i === "object") : value) as
    | TelegramFileLike
    | undefined;
  if (!file || typeof file !== "object") return null;
  const externalId =
    typeof file.file_unique_id === "string" && file.file_unique_id.length > 0
      ? file.file_unique_id
      : typeof file.file_id === "string" && file.file_id.length > 0
        ? file.file_id
        : null;
  if (externalId === null) return null;
  const size = typeof file.file_size === "number" && Number.isFinite(file.file_size) && file.file_size >= 0
    ? Math.trunc(file.file_size)
    : null;
  return {
    kind,
    externalId,
    fileName: typeof file.file_name === "string" && file.file_name.length > 0 ? file.file_name : null,
    mimeType: typeof file.mime_type === "string" && file.mime_type.length > 0 ? file.mime_type : null,
    sizeBytes: size,
  };
}

/** The attachments of one message, in the fixed order of the vendor fields.
 *  Telegram reports one kind per message; the scan stays defensive anyway. */
function telegramMediaRefs(message: TelegramMessageLike): ChannelMediaRef[] {
  const refs: ChannelMediaRef[] = [];
  for (const kind of MEDIA_KINDS) {
    const ref = telegramMediaRef(kind, message[kind]);
    if (ref !== null) refs.push(ref);
  }
  return refs;
}

/** Is the message addressed to the bot? A private chat always is. A group or
 *  channel message is, only when it carries an explicit `@username` mention
 *  of the bot — the same rule the direct integration uses for its own group
 *  gate. Without a configured username no group turn is admitted: silence
 *  here is safer than answering strangers in a group we do not own. */
export function telegramAddressedToBot(
  message: TelegramMessageLike,
  botUsername: string | null,
): boolean {
  if (message.chat?.type === "private") return true;
  if (botUsername === null) return false;
  const text = telegramText(message);
  const mention = `@${botUsername.toLowerCase()}`;
  if (text.toLowerCase().includes(mention)) return true;
  if (Array.isArray(message.entities)) {
    for (const entity of message.entities) {
      if (!entity || typeof entity !== "object") continue;
      const candidate = entity as { type?: unknown; text?: unknown };
      if (
        candidate.type === "mention" &&
        typeof candidate.text === "string" &&
        candidate.text.toLowerCase() === mention
      ) {
        return true;
      }
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* The connector.                                                       */
/* ------------------------------------------------------------------ */

/** Build the Telegram connector over the hub's ports. Pure object: every
 *  method takes its context and the module holds no state — the hub may build
 *  a connector per call, and the vendor row in `chat_endpoints` stays the
 *  source of truth for what a channel is. */
export function createTelegramChannelConnector(
  deps: ChannelConnectorFactoryDeps,
  options: TelegramChannelConnectorOptions = {},
): ChannelConnector {
  const env: EnvLike = options.env ?? process.env;

  const settingsKeys: readonly ChannelSettingDescriptor[] = [
    {
      key: "telegram.chatProvider.enabled",
      envVar: TELEGRAM_CHAT_PROVIDER_ENV,
      summary: "Install the chat-provider-telegram connector for this deployment.",
      defaultValue: false,
    },
    {
      key: "telegram.botUsername",
      envVar: TELEGRAM_BOT_USERNAME_ENV,
      summary: "Bot username for the group mention gate; unset means no group turns.",
      defaultValue: null,
    },
  ];

  const connector: ChannelConnector = {
    provider: TELEGRAM_CONNECTOR_PROVIDER,

    lifecycle: {
      async start(endpoint, ctx) {
        // The transport is the vendor webhook lane until the traffic switch:
        // starting a channel records its runtime state, it does not restart
        // anything (design section 7). A disabled row reads as a disabled
        // runtime, not as a lie about the channel being up. The lease stays
        // with the vendor lifecycle lane, so the runtime reports none.
        const runtime = runtimeFor(endpoint);
        ctx.logger.info("telegram connector: channel runtime started", {
          endpointId: endpoint.id,
          status: runtime.status,
        });
        return runtime;
      },
      async stop(endpoint, reason, ctx) {
        // Dropping the runtime is the journal entry plus the lease the vendor
        // lane owns; this step keeps no process of its own to tear down.
        ctx.logger.info("telegram connector: channel runtime stopped", {
          endpointId: endpoint.id,
          reason,
        });
      },
      async status(endpoint, _ctx) {
        // The row is the only truth: `chat_endpoints.status` answers for the
        // channel, the connector never rewrites it.
        return telegramChannelStatusFor(endpoint.status);
      },
    },

    links: {
      conversationKey(event) {
        return telegramConversationKeyOf(event);
      },
      conversationUrl(conversation) {
        // Provider permalinks are built from the bot identity, which lives in
        // the vendor link lane until the traffic switch; the contract allows a
        // null and the vendor `chat_conversations` column keeps its value.
        void conversation;
        return null;
      },
      async route(_event, _ctx): Promise<ChannelRoute | null> {
        // Task and agent resolution reads the link tables (the 77-point map of
        // OPE-6629); the store seam grows that read in the bridge step. Until
        // the connector answers null and the vendor link lane routes — which
        // is also the traffic-switch guarantee: this step switches nothing.
        return null;
      },
      async bind(_conversation: ChannelConversation, _route: ChannelRoute, ctx) {
        // Same seam note as route(): binding writes through the link tables
        // the bridge step opens. Record the intent in the journal for now.
        ctx.logger.debug("telegram connector: bind asked before the link seam opened", {
          companyId: ctx.companyId,
        });
      },
    },

    inbound: {
      async normalize(raw, ctx) {
        const message = telegramMessageOf(raw);
        if (message === null) return null;
        const chat = telegramChatId(message);
        if (chat === null) return null;
        const conversationKey = telegramConversationKeyOf(raw);
        if (conversationKey === "") return null;
        const author =
          typeof message.from?.id === "number"
            ? String(message.from.id)
            : chat;
        return {
          // `normalize` receives no endpoint row — the hub routes by
          // `endpoint.provider` and ChannelConnectorContext carries none — and
          // the store seam has no read of `chat_endpoints` by the bot's
          // identity yet (the bridge step of the OPE-6629 map opens it, per
          // design section 3.3 "the later steps add the reads the connectors
          // ask for"). The slot stays empty rather than faking an identity:
          // the vendor binding key `telegram:<chat>` resolves the real
          // endpoint on the outbound leg, as before.
          endpointId: "",
          provider: TELEGRAM_CONNECTOR_PROVIDER,
          conversationKey,
          conversationUrl: null,
          authorExternalId: author,
          addressedToBot: telegramAddressedToBot(message, telegramBotUsername(env)),
          text: telegramText(message),
          media: telegramMediaRefs(message),
          receivedAt: ctx.now(),
          raw,
        } satisfies ChannelTurn;
      },

      async admit(turn, ctx) {
        const resolved = await connector.settings.resolve(ctx);
        if (resolved.values["telegram.chatProvider.enabled"] !== true) {
          return { admitted: false, reason: "disabled" } satisfies ChannelAdmission;
        }
        if (!turn.addressedToBot) {
          return { admitted: false, reason: "not-addressed" } satisfies ChannelAdmission;
        }
        return { admitted: true, reason: null } satisfies ChannelAdmission;
      },

      async intakeMedia(turn, _ctx): Promise<MediaIntakeResult> {
        const accepted: ChannelMediaRef[] = [];
        const rejected: ChannelMediaRejection[] = [];
        for (const ref of turn.media) {
          if (!connector.media.accepts.includes(ref.kind)) {
            rejected.push({ media: ref, reason: "unsupported" });
            continue;
          }
          if (ref.sizeBytes !== null && ref.sizeBytes > connector.media.fileLimitBytes) {
            rejected.push({ media: ref, reason: "too-large" });
            continue;
          }
          accepted.push(ref);
        }
        return { accepted: rejected.length === 0, intake: accepted, rejected };
      },
    },

    outbound: {
      async plan(publication: ChannelPublication, ctx) {
        const parts: TransportPart[] = [];
        // The vendor splitter, not a second copy of the rule: the durable
        // parts of a publication are identical to the parts the direct
        // integration would have sent (4,096 ceiling, 1,600-code-point parts).
        const textParts =
          publication.text.length > 0 ? splitTelegramPublicationText(publication.text) : [];
        for (const text of textParts) {
          parts.push({ kind: "text", text, media: null });
        }
        for (const ref of publication.media) {
          parts.push({ kind: "media", text: null, media: ref });
        }
        if (parts.length === 0) {
          // An empty publication still needs one part for the outbox record
          // to keep an idempotent send.
          parts.push({ kind: "text", text: "", media: null });
          ctx.logger.debug("telegram connector: planned an empty publication part", {
            endpointId: publication.endpointId,
            idempotencyKey: publication.idempotencyKey,
          });
        }
        return {
          endpointId: publication.endpointId,
          conversationKey: publication.conversationKey,
          idempotencyKey: publication.idempotencyKey,
          parts,
        } satisfies TransportPlan;
      },

      async send(plan, transport: ChannelTransportSink, ctx): Promise<SendResult> {
        const externalMessageIds: string[] = [];
        for (let index = 0; index < plan.parts.length; index += 1) {
          try {
            const outcome = await transport.sendPart(plan.parts[index]!);
            if (outcome.externalMessageId !== null) {
              externalMessageIds.push(outcome.externalMessageId);
            }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            ctx.logger.error("telegram connector: part delivery failed", {
              endpointId: plan.endpointId,
              idempotencyKey: plan.idempotencyKey,
              failedPartIndex: index,
              message,
            });
            return { delivered: false, externalMessageIds, failedPartIndex: index };
          }
        }
        return { delivered: true, externalMessageIds, failedPartIndex: null };
      },
    },

    media: {
      fileLimitBytes: TELEGRAM_FILE_LIMIT_BYTES,
      captionLimit: TELEGRAM_CAPTION_LIMIT,
      accepts: MEDIA_KINDS,
    },

    settings: {
      keys: settingsKeys,
      async resolve(ctx): Promise<ResolvedChannelSettings> {
        // env → stored document → default. The stored-document leg reads the
        // per-endpoint settings row through the store seam; until the bridge
        // step adds that read the environment answers for what it pins and
        // the defaults cover the rest, so the precedence the design sets is
        // preserved, not silently skipped. This connector's settings are
        // deployment-level (the environment), so the endpoint slot is empty
        // until the store grows the per-endpoint read.
        const values: Record<string, ChannelSettingValue> = {};
        const sources: Record<string, ResolvedChannelSettings["sources"][string]> = {};
        for (const descriptor of settingsKeys) {
          const raw = env[descriptor.envVar];
          if (raw !== undefined && raw.trim().length > 0) {
            if (typeof descriptor.defaultValue === "boolean") {
              values[descriptor.key] = telegramChatProviderFlagEnabled({
                [descriptor.envVar]: raw,
              });
            } else if (descriptor.key === "telegram.botUsername") {
              const username = telegramBotUsername(env);
              values[descriptor.key] = username ?? descriptor.defaultValue;
            } else {
              values[descriptor.key] = raw.trim();
            }
            sources[descriptor.key] = "env";
          } else {
            values[descriptor.key] = descriptor.defaultValue;
            sources[descriptor.key] = "default";
          }
        }
        return {
          // The contract hands `resolve` no endpoint row (the context carries
          // company, store, journal, clock), and the settings of this
          // connector are deployment-level (the environment) — so the
          // endpoint slot stays empty until the store seam grows the
          // per-endpoint settings read of section 3.3.
          endpointId: "",
          values,
          sources,
        };
      },
    },
  };

  return connector;
}

/** The factory the registry stores for the `telegram` provider. */
export const telegramConnectorFactory: ChannelConnectorFactory = (deps) =>
  createTelegramChannelConnector(deps);

/** Register (connect) the connector when, and only when, the installation
 *  flag says so. Returns true when the connector took the field. Calling it
 *  again with the flag still on is a no-op: the registry allows re-registering
 *  the same factory, and this keeps the vendor path untouched when it is off.
 *  Dropping the flag between calls does not unregister — disconnecting an
 *  installed channel goes through `lifecycle.stop`, and the registry is a
 *  startup surface, not a runtime switch. */
export function installTelegramChannelConnector(env: EnvLike = process.env): boolean {
  if (!telegramChatProviderFlagEnabled(env)) {
    return false;
  }
  registerChannelConnector(TELEGRAM_CONNECTOR_PROVIDER, telegramConnectorFactory);
  return true;
}

/** Guard for callers that wire the hub later: a provider string becomes a
 *  contract name only when the contract knows it. */
export function asTelegramConnectorProvider(value: unknown): ChatProviderName | null {
  return isChatProviderName(value) ? value : null;
}
