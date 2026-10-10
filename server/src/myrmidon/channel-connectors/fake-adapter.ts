// Reference fake channel connector for the contract test suite (OPE-7004).
//
// The fake is the reference implementation of the contract of
// `server/src/myrmidon/channel-connectors/contract.ts`: an in-memory adapter
// with no network and no database that passes every contract test in
// `contract-test-suite.ts`. The suite runs against it here, and a real
// connector (the Telegram adapter of OPE-6960) plugs the same suite in with
// one line: `runChannelConnectorContractTests("telegram", () => telegramConnector())`.
//
// Behaviours a real adapter must show, scripted here instead of wired to a
// vendor runtime:
// - scripted send failures (`failNextSends`) so the retry/backoff tests can
//   drive provider errors without a network;
// - a send ledger keyed by the idempotency key, so the idempotency tests can
//   read back what actually went out;
// - an optional `sendDelayMs` plus per-attempt timeout support, so the
//   timeout tests run with fake timers and no real waiting;
// - a raw-event inbox (`pushRawEvent`) standing in for the provider webhook.

import type {
  ChannelAdmission,
  ChannelConnector,
  ChannelConnectorContext,
  ChannelEndpointView,
  ChannelPublication,
  ChannelRawEvent,
  ChannelRoute,
  ChannelRuntime,
  ChannelStatus,
  ChannelStopReason,
  ChannelTurn,
  MediaIntakeResult,
  SendResult,
  TransportPlan,
  ResolvedChannelSettings,
  ChannelTransportSink,
  ChannelConversation,
} from "./contract.js";

/** One inbound event in the fake transport's own shape, before normalize. */
export interface FakeRawEvent {
  readonly externalId: string;
  readonly conversationKey: string;
  readonly authorExternalId: string;
  readonly text: string;
  readonly addressedToBot: boolean;
  readonly receivedAt?: Date;
  /** When true, normalize returns null: the event is not a message for us. */
  readonly notAMessage?: boolean;
}

/** One attempt the fake transport recorded, in order. */
export interface FakeSendAttempt {
  readonly idempotencyKey: string;
  readonly text: string;
  readonly attempt: number;
  readonly at: Date;
  readonly outcome: "delivered" | "failed";
}

/** Error the fake transport raises for a scripted failed send. */
export class FakeProviderError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = "FakeProviderError";
    this.retryable = retryable;
  }
}

export interface FakeChannelAdapterOptions {
  /** Delay every send by this many milliseconds (drives the timeout tests). */
  readonly sendDelayMs?: number;
  /** Milliseconds a send may take before the adapter raises a timeout. */
  readonly sendTimeoutMs?: number;
}

/** One lifecycle transition the fake recorded, in order. */
export interface FakeLifecycleEntry {
  readonly action: "start" | "stop";
  readonly status: ChannelStatus | null;
  readonly reason: ChannelStopReason | null;
}

export interface FakeChannelAdapter {
  readonly connector: ChannelConnector;
  /** Queue inbound raw events; the suite drains them through inbound.normalize. */
  pushRawEvent(event: FakeRawEvent): void;
  /** Take the queued raw events, oldest first. */
  drainRawEvents(): FakeRawEvent[];
  /** Script the next N sends to fail with a retryable provider error. */
  failNextSends(count: number, message?: string): void;
  /** Every send attempt the adapter made, in order. */
  readonly attempts: FakeSendAttempt[];
  /** Runtime states the lifecycle produced, in order. */
  readonly lifecycles: readonly FakeLifecycleEntry[];
  /** Reset attempts, lifecycle log and scripted failures. */
  reset(): void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryable(error: unknown): boolean {
  return error instanceof FakeProviderError ? error.retryable : true;
}

export function createFakeChannelAdapter(options: FakeChannelAdapterOptions = {}): FakeChannelAdapter {
  const sendDelayMs = options.sendDelayMs ?? 0;
  const sendTimeoutMs = options.sendTimeoutMs ?? 5_000;

  let inbox: FakeRawEvent[] = [];
  let failedSendsLeft = 0;
  let scriptedMessage = "provider unavailable";
  let stopped = false;
  const attempts: FakeSendAttempt[] = [];
  const deliveredByKey = new Map<string, string[]>();
  const lifecycles: FakeLifecycleEntry[] = [];
  let currentStatus: ChannelStatus = "disabled";

  async function sendOnce(key: string, text: string, now: () => Date): Promise<string> {
    const attempt = attempts.filter((a) => a.idempotencyKey === key).length + 1;
    const send = (async () => {
      if (sendDelayMs > 0) await delay(sendDelayMs);
      if (failedSendsLeft > 0) {
        failedSendsLeft -= 1;
        throw new FakeProviderError(scriptedMessage, true);
      }
      return `fake-msg-${attempts.length + 1}`;
    })();
    const timeout = (async () => {
      await delay(sendTimeoutMs);
      throw new FakeProviderError("send timed out", false);
    })();
    try {
      const id = await Promise.race([send, timeout]);
      attempts.push({ idempotencyKey: key, text, attempt, at: now(), outcome: "delivered" });
      return id;
    } catch (error) {
      attempts.push({ idempotencyKey: key, text, attempt, at: now(), outcome: "failed" });
      throw error;
    }
  }

  const connector: ChannelConnector = {
    provider: "telegram",

    lifecycle: {
      async start(endpoint: ChannelEndpointView): Promise<ChannelRuntime> {
        stopped = false;
        currentStatus = "ready";
        lifecycles.push({ action: "start", status: currentStatus, reason: null });
        return {
          endpointId: endpoint.id,
          provider: "telegram",
          status: currentStatus,
          leaseKey: `fake-lease-${endpoint.id}`,
        };
      },
      async stop(_endpoint: ChannelEndpointView, reason: ChannelStopReason): Promise<void> {
        stopped = true;
        currentStatus = "disabled";
        lifecycles.push({ action: "stop", status: null, reason });
      },
      async status(): Promise<ChannelStatus> {
        return currentStatus;
      },
    },

    links: {
      conversationKey(event: ChannelRawEvent): string {
        const e = event as FakeRawEvent;
        return e.conversationKey ?? "";
      },
      conversationUrl(conversation: ChannelConversation): string | null {
        return `fake://conversation/${conversation.conversationKey}`;
      },
      async route(event: ChannelRawEvent, ctx: ChannelConnectorContext): Promise<ChannelRoute | null> {
        const e = event as FakeRawEvent;
        if (!e.addressedToBot) return null;
        return {
          endpointId: "endpoint-under-test",
          companyId: ctx.companyId,
          conversationKey: e.conversationKey,
          issueId: null,
          agentId: null,
        };
      },
      async bind(): Promise<void> {},
    },

    inbound: {
      async normalize(raw: ChannelRawEvent, ctx: ChannelConnectorContext): Promise<ChannelTurn | null> {
        const e = raw as FakeRawEvent;
        if (e.notAMessage) return null;
        return {
          endpointId: "endpoint-under-test",
          provider: "telegram",
          conversationKey: e.conversationKey,
          conversationUrl: `fake://conversation/${e.conversationKey}`,
          authorExternalId: e.authorExternalId,
          addressedToBot: e.addressedToBot,
          text: e.text,
          media: [],
          receivedAt: e.receivedAt ?? ctx.now(),
          raw,
        };
      },
      async admit(turn: ChannelTurn): Promise<ChannelAdmission> {
        if (stopped) return { admitted: false, reason: "disabled" };
        if (!turn.addressedToBot) return { admitted: false, reason: "not-addressed" };
        return { admitted: true, reason: null };
      },
      async intakeMedia(turn: ChannelTurn): Promise<MediaIntakeResult> {
        const tooLarge = turn.media.filter(
          (m) => m.sizeBytes !== null && m.sizeBytes > connector.media.fileLimitBytes,
        );
        return {
          accepted: tooLarge.length === 0,
          intake: turn.media.filter((m) => !tooLarge.includes(m)),
          rejected: tooLarge.map((m) => ({ media: m, reason: "too-large" as const })),
        };
      },
    },

    outbound: {
      async plan(publication: ChannelPublication): Promise<TransportPlan> {
        return {
          endpointId: publication.endpointId,
          conversationKey: publication.conversationKey,
          idempotencyKey: publication.idempotencyKey,
          parts: [{ kind: "text", text: publication.text, media: null }],
        };
      },
      async send(
        plan: TransportPlan,
        _transport: ChannelTransportSink,
        ctx: ChannelConnectorContext,
      ): Promise<SendResult> {
        // Idempotency: a key that already delivered is not sent again.
        const already = deliveredByKey.get(plan.idempotencyKey);
        if (already) {
          return { delivered: true, externalMessageIds: already, failedPartIndex: null };
        }
        const ids: string[] = [];
        for (let i = 0; i < plan.parts.length; i += 1) {
          const part = plan.parts[i];
          // Retry with backoff on retryable provider errors.
          let lastError: unknown = null;
          let deliveredId: string | null = null;
          for (let attempt = 0; attempt < 3; attempt += 1) {
            if (attempt > 0) await delay(2 ** attempt);
            try {
              deliveredId = await sendOnce(plan.idempotencyKey, part.text ?? "", ctx.now);
              break;
            } catch (error) {
              lastError = error;
              if (!isRetryable(error)) break;
            }
          }
          if (deliveredId === null) {
            ctx.logger.warn("send failed", { idempotencyKey: plan.idempotencyKey, error: String(lastError) });
            return { delivered: false, externalMessageIds: ids, failedPartIndex: i };
          }
          ids.push(deliveredId);
        }
        deliveredByKey.set(plan.idempotencyKey, ids);
        return { delivered: true, externalMessageIds: ids, failedPartIndex: null };
      },
    },

    media: {
      fileLimitBytes: 10 * 1024 * 1024,
      captionLimit: 1024,
      accepts: ["photo", "document"],
    },

    settings: {
      keys: [
        {
          key: "fakeGreeting",
          envVar: "MYRMIDON_FAKE_GREETING",
          summary: "Greeting the fake adapter would send on connect.",
          defaultValue: "hello",
        },
      ],
      async resolve(ctx: ChannelConnectorContext): Promise<ResolvedChannelSettings> {
        return {
          endpointId: "endpoint-under-test",
          values: { fakeGreeting: "hello" },
          sources: { fakeGreeting: "default" },
        };
      },
    },
  };

  return {
    connector,
    pushRawEvent(event: FakeRawEvent) {
      inbox.push(event);
    },
    drainRawEvents() {
      const out = inbox;
      inbox = [];
      return out;
    },
    failNextSends(count: number, message?: string) {
      failedSendsLeft = count;
      if (message) scriptedMessage = message;
    },
    attempts,
    lifecycles,
    reset() {
      attempts.length = 0;
      lifecycles.length = 0;
      deliveredByKey.clear();
      failedSendsLeft = 0;
      inbox = [];
      stopped = false;
      currentStatus = "disabled";
    },
  };
}
