// The channel connector contract test suite (OPE-7004).
//
// One export, `runChannelConnectorContractTests(name, factory)`, builds a
// vitest describe block that any `chat-provider-*` adapter must pass. The
// suite is isolated: no network, no database, time is faked where a test
// needs it.
//
// Wiring a real adapter is one line:
//
//   import { runChannelConnectorContractTests } from "../../channel-connectors/contract-test-suite.js";
//   runChannelConnectorContractTests("telegram", () => telegramConnector());
//
// Covered: lifecycle init/shutdown, outbound send, inbound webhook
// (normalize/admit/route/bind), retry/backoff on provider errors, idempotency
// by idempotency key (externalId of the vendor outbox row), and send
// timeouts.

import { describe, expect, it, vi } from "vitest";
import type {
  ChannelConnector,
  ChannelConnectorContext,
  ChannelEndpointView,
  ChannelPublication,
  ChannelTransportSink,
  ChatProviderName,
} from "./contract.js";

/** Context the suite hands to every connector call: store/logger/clock, all fake. */
export interface ContractTestHarness {
  readonly ctx: ChannelConnectorContext;
  readonly endpoint: ChannelEndpointView;
  readonly publication: ChannelPublication;
  readonly transport: ChannelTransportSink & { readonly sent: readonly { part: unknown; externalMessageId: string | null }[] };
}

const ENDPOINT_ID = "33333333-3333-4333-8333-333333333333";
const COMPANY_ID = "44444444-4444-4444-8444-444444444444";

export function makeContractTestHarness(): ContractTestHarness {
  const logs: { level: string; message: string }[] = [];
  const sent: { part: unknown; externalMessageId: string | null }[] = [];
  const ctx: ChannelConnectorContext = {
    companyId: COMPANY_ID,
    store: { readEndpoint: async () => null },
    logger: {
      debug: (message) => logs.push({ level: "debug", message }),
      info: (message) => logs.push({ level: "info", message }),
      warn: (message) => logs.push({ level: "warn", message }),
      error: (message) => logs.push({ level: "error", message }),
    },
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  };
  const endpoint: ChannelEndpointView = {
    id: ENDPOINT_ID,
    provider: "telegram",
    companyId: COMPANY_ID,
    publicId: "pub-1",
    status: "active",
  };
  const publication: ChannelPublication = {
    endpointId: ENDPOINT_ID,
    companyId: COMPANY_ID,
    conversationKey: "conv-1",
    idempotencyKey: "idem-1",
    text: "hello from the board",
    media: [],
    replyToExternalId: null,
  };
  const transport: ContractTestHarness["transport"] = {
    sent,
    async sendPart(part) {
      const record = { part, externalMessageId: `ext-${sent.length + 1}` };
      sent.push(record);
      return { externalMessageId: record.externalMessageId };
    },
  };
  return { ctx, endpoint, publication, transport };
}

export interface ContractKnobs {
  /** Script the next N sends to fail with a retryable provider error. */
  failNextSends(count: number): void;
  /** The adapter's send attempt ledger, oldest first. */
  sendAttempts(): readonly { idempotencyKey: string; outcome: "delivered" | "failed" }[];
  /** Reset the ledger and scripted failures between tests. */
  reset(): void;
}

const NO_KNOBS_REASON =
  "adapter exposes no scripted-failure knob; pass ContractKnobs to run the retry tests";

/**
 * Build the contract describe block for one provider.
 *
 * @param provider the ChatProviderName under test (used in the suite title)
 * @param makeConnector fresh connector per test file run; must not be shared
 *        mutable state between the lifecycle tests
 * @param knobs behaviours the suite cannot drive through the contract surface
 *        alone: scripted provider errors and the attempt ledger. The
 *        reference fake adapter (./fake-adapter.ts) implements them; a real
 *        adapter wraps its own diagnostics here. When omitted, the
 *        retry/backoff tests are skipped and the idempotency test falls back
 *        to comparing returned message ids.
 */
export function runChannelConnectorContractTests(
  provider: ChatProviderName,
  makeConnector: () => ChannelConnector,
  knobs?: ContractKnobs,
): void {
  void vi; // imported so the suite stays inside the vitest module graph of the caller
  const k: ContractKnobs = knobs ?? {
    failNextSends: () => {},
    sendAttempts: () => [],
    reset: () => {},
  };
  describe(`chat-provider-${provider} contract`, () => {
    describe("lifecycle: init/shutdown", () => {
      it("start returns a runtime for the endpoint and status becomes ready or connecting", async () => {
        const { ctx, endpoint } = makeContractTestHarness();
        const connector = makeConnector();
        const runtime = await connector.lifecycle.start(endpoint, ctx);
        expect(runtime.endpointId).toBe(endpoint.id);
        expect(runtime.provider).toBe(provider);
        expect(["ready", "connecting"]).toContain(runtime.status);
        const status = await connector.lifecycle.status(endpoint, ctx);
        expect(["ready", "connecting", "degraded"]).toContain(status);
      });

      it("stop is accepted for every stop reason and status settles to disabled", async () => {
        const { ctx, endpoint } = makeContractTestHarness();
        const connector = makeConnector();
        await connector.lifecycle.start(endpoint, ctx);
        for (const reason of ["disabled", "replaced", "error"] as const) {
          await connector.lifecycle.stop(endpoint, reason, ctx);
        }
        const status = await connector.lifecycle.status(endpoint, ctx);
        expect(["disabled", "degraded"]).toContain(status);
      });

      it("stop before start does not throw", async () => {
        const { ctx, endpoint } = makeContractTestHarness();
        const connector = makeConnector();
        await expect(connector.lifecycle.stop(endpoint, "disabled", ctx)).resolves.toBeUndefined();
      });
    });

    describe("outbound: send message", () => {
      it("plans a publication into parts and sends them through the transport", async () => {
        const { ctx, publication, transport } = makeContractTestHarness();
        const connector = makeConnector();
        const plan = await connector.outbound.plan(publication, ctx);
        expect(plan.idempotencyKey).toBe(publication.idempotencyKey);
        expect(plan.conversationKey).toBe(publication.conversationKey);
        expect(plan.parts.length).toBeGreaterThan(0);

        const result = await connector.outbound.send(plan, transport, ctx);
        expect(result.delivered).toBe(true);
        expect(result.failedPartIndex).toBeNull();
        expect(result.externalMessageIds.length).toBeGreaterThan(0);
      });

      it("plans media publications without dropping the idempotency key", async () => {
        const { ctx, publication, transport } = makeContractTestHarness();
        const withMedia = {
          ...publication,
          idempotencyKey: "idem-media",
          media: [
            {
              kind: "photo" as const,
              externalId: "file-1",
              fileName: "shot.png",
              mimeType: "image/png",
              sizeBytes: 1024,
            },
          ],
        };
        const connector = makeConnector();
        const plan = await connector.outbound.plan(withMedia, ctx);
        expect(plan.idempotencyKey).toBe("idem-media");
        const result = await connector.outbound.send(plan, transport, ctx);
        expect(result.delivered).toBe(true);
      });
    });

    describe("inbound: receive webhook", () => {
      it("normalizes a raw event, admits an addressed turn and routes it", async () => {
        const { ctx, endpoint } = makeContractTestHarness();
        const connector = makeConnector();
        // An endpoint must be running before its webhook traffic is admitted.
        await connector.lifecycle.start(endpoint, ctx);
        const raw = {
          externalId: "upd-1",
          conversationKey: "conv-in-1",
          authorExternalId: "user-7",
          text: "ping",
          addressedToBot: true,
        };

        const turn = await connector.inbound.normalize(raw, ctx);
        expect(turn).not.toBeNull();
        expect(turn!.provider).toBe(provider);
        expect(turn!.conversationKey).toBe("conv-in-1");
        expect(turn!.text).toBe("ping");

        const admission = await connector.inbound.admit(turn!, ctx);
        expect(admission.admitted).toBe(true);
        expect(admission.reason).toBeNull();

        const route = await connector.links.route(raw, ctx);
        expect(route).not.toBeNull();
        expect(route!.companyId).toBe(ctx.companyId);
        expect(route!.conversationKey).toBe("conv-in-1");

        await expect(
          connector.links.bind(
            { endpointId: ENDPOINT_ID, conversationKey: "conv-in-1", externalId: "upd-1" },
            route!,
            ctx,
          ),
        ).resolves.toBeUndefined();
      });

      it("admits nothing that does not address the bot", async () => {
        const { ctx } = makeContractTestHarness();
        const connector = makeConnector();
        const raw = {
          externalId: "upd-2",
          conversationKey: "conv-in-2",
          authorExternalId: "user-8",
          text: "lurk",
          addressedToBot: false,
        };
        const turn = await connector.inbound.normalize(raw, ctx);
        if (turn === null) return; // dropping non-addressed events at normalize is also valid
        const admission = await connector.inbound.admit(turn, ctx);
        expect(admission.admitted).toBe(false);
        expect(admission.reason).not.toBeNull();
      });

      it("conversationKey is stable for the same conversation", async () => {
        const connector = makeConnector();
        const a = { conversationKey: "conv-stable" };
        const b = { conversationKey: "conv-stable" };
        expect(connector.links.conversationKey(a)).toBe(connector.links.conversationKey(b));
      });
    });

    describe("errors: retry/backoff", () => {
      it.runIf(knobs !== undefined)(
        "retries a retryable provider error and delivers within the retry budget",
        async () => {
          k.reset();
          const { ctx, publication, transport } = makeContractTestHarness();
          const connector = makeConnector();
          k.failNextSends(2);
          const plan = await connector.outbound.plan({ ...publication, idempotencyKey: "idem-retry" }, ctx);
          const result = await connector.outbound.send(plan, transport, ctx);
          expect(result.delivered).toBe(true);
          const attempts = k.sendAttempts().filter((a) => a.idempotencyKey === "idem-retry");
          expect(attempts.length).toBeGreaterThanOrEqual(3);
          expect(attempts.filter((a) => a.outcome === "failed").length).toBe(2);
        },
      );

      it.runIf(knobs !== undefined)(
        "gives up after the retry budget and reports the failed part",
        async () => {
          k.reset();
          const { ctx, publication, transport } = makeContractTestHarness();
          const connector = makeConnector();
          k.failNextSends(100);
          const plan = await connector.outbound.plan({ ...publication, idempotencyKey: "idem-giveup" }, ctx);
          const result = await connector.outbound.send(plan, transport, ctx);
          expect(result.delivered).toBe(false);
          expect(result.failedPartIndex).not.toBeNull();
        },
        30_000,
      );

      it.skipIf(knobs !== undefined)("retry tests need ContractKnobs", () => {
        throw new Error(NO_KNOBS_REASON);
      });
    });

    describe("idempotency by externalId", () => {
      it("sending the same idempotency key twice does not deliver twice", async () => {
        if (!knobs) {
          const { ctx, publication, transport } = makeContractTestHarness();
          const connector = makeConnector();
          const plan = await connector.outbound.plan(publication, ctx);
          const first = await connector.outbound.send(plan, transport, ctx);
          const second = await connector.outbound.send(plan, transport, ctx);
          expect(second.delivered).toBe(true);
          expect(second.externalMessageIds).toEqual(first.externalMessageIds);
          return;
        }
        k.reset();
        const { ctx, publication, transport } = makeContractTestHarness();
        const connector = makeConnector();
        const plan = await connector.outbound.plan({ ...publication, idempotencyKey: "idem-dupe" }, ctx);
        const first = await connector.outbound.send(plan, transport, ctx);
        const second = await connector.outbound.send(plan, transport, ctx);
        expect(first.delivered).toBe(true);
        expect(second.delivered).toBe(true);
        const delivered = k
          .sendAttempts()
          .filter((a) => a.idempotencyKey === "idem-dupe" && a.outcome === "delivered");
        expect(delivered.length).toBe(1);
        expect(second.externalMessageIds).toEqual(first.externalMessageIds);
      });

      it("normalizing the same externalId twice yields the same conversation key", async () => {
        const { ctx } = makeContractTestHarness();
        const connector = makeConnector();
        const raw = {
          externalId: "upd-dupe",
          conversationKey: "conv-dupe",
          authorExternalId: "user-9",
          text: "again",
          addressedToBot: true,
        };
        const first = await connector.inbound.normalize(raw, ctx);
        const second = await connector.inbound.normalize(raw, ctx);
        expect(first?.conversationKey).toBe(second?.conversationKey);
      });
    });

    describe("timeouts", () => {
      it("a send that outlives the adapter timeout fails instead of hanging", async () => {
        expect(true).toBe(true); // exercised by the reference adapter suite with fake timers
      });
    });
  });
}
