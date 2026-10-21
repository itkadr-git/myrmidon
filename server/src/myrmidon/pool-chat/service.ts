import type { Db } from "@paperclipai/db";
import { poolChatModuleInstances, poolChatQuotaReservations, poolChatRequestAttempts, poolChatRequests } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { conflict, notFound, HttpError } from "../../errors.js";
import { canonicalRequestHash, type PoolChatRequestBody } from "./protocol.js";
import { selectPoolChatAccount } from "./router.js";
import type { PoolChatProvider, PoolChatTransport } from "./transports.js";

export type PoolChatTransportResolver = (input: {
  companyId: string;
  provider: PoolChatProvider;
  moduleId: string;
  credentialSecretName: string | null;
  accountRef: string;
  config: Record<string, unknown>;
}) => PoolChatTransport | null | Promise<PoolChatTransport | null>;

function providerOf(value: string): PoolChatProvider {
  if (value === "chatgpt" || value === "google") return value;
  throw new HttpError(503, "Pool-chat provider is not configured");
}

export function poolChatService(db: Db, resolveTransport: PoolChatTransportResolver) {
  return {
    async capabilities(companyId: string, moduleId: string) {
      const row = await db.select({ provider: poolChatModuleInstances.provider, config: poolChatModuleInstances.config })
        .from(poolChatModuleInstances)
        .where(and(eq(poolChatModuleInstances.companyId, companyId), eq(poolChatModuleInstances.id, moduleId), eq(poolChatModuleInstances.status, "active")))
        .then((rows) => rows[0]);
      if (!row) throw notFound("Pool-chat module not found");
      const config = row.config ?? {};
      return { provider: providerOf(row.provider), models: Array.isArray(config.allowedModels) ? config.allowedModels.filter((v: unknown): v is string => typeof v === "string") : [], maxOutputTokens: 4096 };
    },
    async submit(input: { companyId: string; moduleId: string; channel: string; subjectId: string; idempotencyKey: string; body: PoolChatRequestBody }) {
      const hash = canonicalRequestHash(input.body);
      // Resolve an existing logical request before reading mutable module
      // configuration. Replays must remain observable after disable/reconfig.
      const existing = await db.select().from(poolChatRequests).where(and(
        eq(poolChatRequests.companyId, input.companyId),
        eq(poolChatRequests.moduleId, input.moduleId),
        eq(poolChatRequests.channel, input.channel),
        eq(poolChatRequests.subjectId, input.subjectId),
        eq(poolChatRequests.idempotencyKey, input.idempotencyKey),
      )).then((rows) => rows[0]);
      if (existing) {
        if (existing.requestHash !== hash) throw conflict("Idempotency key was reused with a different request");
        return existing;
      }
      const eventReplay = await db.select().from(poolChatRequests).where(and(
        eq(poolChatRequests.companyId, input.companyId),
        eq(poolChatRequests.moduleId, input.moduleId),
        eq(poolChatRequests.channel, input.channel),
        eq(poolChatRequests.subjectId, input.subjectId),
        eq(poolChatRequests.clientMessageId, input.body.clientMessageId),
      )).then((rows) => rows[0]);
      if (eventReplay) {
        if (eventReplay.requestHash !== hash) throw conflict("Client message was reused with a different request");
        return eventReplay;
      }
      const module = await db.select({ provider: poolChatModuleInstances.provider, config: poolChatModuleInstances.config, credentialSecretName: poolChatModuleInstances.credentialSecretName }).from(poolChatModuleInstances).where(and(eq(poolChatModuleInstances.companyId, input.companyId), eq(poolChatModuleInstances.id, input.moduleId), eq(poolChatModuleInstances.status, "active"))).then((rows) => rows[0]);
      if (!module) throw notFound("Pool-chat module not found");
      const provider = providerOf(module.provider);
      const config = module.config ?? {};
      const outcome = await db.transaction(async (tx) => {
        const existing = await tx.select().from(poolChatRequests).where(and(eq(poolChatRequests.companyId, input.companyId), eq(poolChatRequests.moduleId, input.moduleId), eq(poolChatRequests.channel, input.channel), eq(poolChatRequests.subjectId, input.subjectId), eq(poolChatRequests.idempotencyKey, input.idempotencyKey))).then((rows) => rows[0]);
        if (existing) {
          if (existing.requestHash !== hash) throw conflict("Idempotency key was reused with a different request");
          return { request: existing, created: false };
        }
        const eventReplay = await tx.select().from(poolChatRequests).where(and(
          eq(poolChatRequests.companyId, input.companyId),
          eq(poolChatRequests.moduleId, input.moduleId),
          eq(poolChatRequests.channel, input.channel),
          eq(poolChatRequests.subjectId, input.subjectId),
          eq(poolChatRequests.clientMessageId, input.body.clientMessageId),
        )).then((rows) => rows[0]);
        if (eventReplay) {
          if (eventReplay.requestHash !== hash) throw conflict("Client message was reused with a different request");
          return { request: eventReplay, created: false };
        }
        // Select and reserve only for a new logical request. Replays must
        // return the durable result even if account availability changed.
        const account = selectPoolChatAccount(config, provider, 1);
        const [created] = await tx.insert(poolChatRequests).values({ companyId: input.companyId, moduleId: input.moduleId, channel: input.channel, subjectId: input.subjectId, conversationId: input.body.conversationId, clientMessageId: input.body.clientMessageId, idempotencyKey: input.idempotencyKey, requestHash: hash, model: input.body.model, status: "dispatching", reservationUnits: 1 }).returning();
        await tx.insert(poolChatQuotaReservations).values({ companyId: input.companyId, requestId: created.id, units: 1, state: "reserved" });
        await tx.insert(poolChatRequestAttempts).values({ companyId: input.companyId, requestId: created.id, attemptNo: 1, state: "dispatching", provider, accountRef: account.accountRef, reservedUnits: 1 });
        return { request: created, created: true, accountRef: account.accountRef };
      });
      // Only the transaction winner may perform upstream I/O. Replays must
      // observe the durable state rather than sending the request again.
      if (!outcome.created) return outcome.request;
      let transport: PoolChatTransport | null;
      try {
        transport = await resolveTransport({ companyId: input.companyId, provider, moduleId: input.moduleId, credentialSecretName: module.credentialSecretName ?? null, accountRef: outcome.accountRef, config });
      } catch {
        // Secret/provider resolution is before upstream I/O, so release the
        // reservation instead of leaving a new request permanently dispatching.
        await db.transaction(async (tx: any) => {
          await tx.update(poolChatRequestAttempts).set({ state: "failed", failureCode: "provider_not_configured", failureDetail: "provider_transport_unavailable", settledUnits: 0, updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, outcome.request.id), eq(poolChatRequestAttempts.attemptNo, 1), eq(poolChatRequestAttempts.state, "dispatching")));
          await tx.update(poolChatQuotaReservations).set({ state: "released", settledUnits: 0, updatedAt: new Date() }).where(and(eq(poolChatQuotaReservations.requestId, outcome.request.id), eq(poolChatQuotaReservations.state, "reserved")));
          await tx.update(poolChatRequests).set({ status: "failed", charged: false, updatedAt: new Date() }).where(and(eq(poolChatRequests.id, outcome.request.id), eq(poolChatRequests.status, "dispatching")));
        });
        throw new HttpError(503, "Pool-chat provider transport is not configured");
      }
      if (!transport) {
        await db.transaction(async (tx: any) => {
          await tx.update(poolChatRequestAttempts).set({ state: "failed", failureCode: "provider_not_configured", failureDetail: "provider_transport_unavailable", settledUnits: 0, updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, outcome.request.id), eq(poolChatRequestAttempts.attemptNo, 1), eq(poolChatRequestAttempts.state, "dispatching")));
          await tx.update(poolChatQuotaReservations).set({ state: "released", settledUnits: 0, updatedAt: new Date() }).where(and(eq(poolChatQuotaReservations.requestId, outcome.request.id), eq(poolChatQuotaReservations.state, "reserved")));
          await tx.update(poolChatRequests).set({ status: "failed", charged: false, updatedAt: new Date() }).where(and(eq(poolChatRequests.id, outcome.request.id), eq(poolChatRequests.status, "dispatching")));
        });
        throw new HttpError(503, "Pool-chat provider transport is not configured");
      }
      let request = outcome.request;
      try {
        const result = await transport.send({ model: input.body.model, messages: input.body.messages, maxOutputTokens: input.body.maxOutputTokens ?? 2048 });
        if (
          !result || typeof result.text !== "string" ||
          !Number.isSafeInteger(result.inputUnits) || result.inputUnits < 0 ||
          !Number.isSafeInteger(result.outputUnits) || result.outputUnits < 0 ||
          (result.providerRequestRef !== null && typeof result.providerRequestRef !== "string")
        ) {
          throw new Error("invalid_provider_result");
        }
        request = await db.transaction(async (tx) => {
          const [attempt] = await tx.update(poolChatRequestAttempts).set({ state: "sent", settledUnits: result.inputUnits + result.outputUnits, providerRequestRef: result.providerRequestRef, updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, request.id), eq(poolChatRequestAttempts.attemptNo, 1), eq(poolChatRequestAttempts.state, "dispatching"))).returning({ id: poolChatRequestAttempts.id });
          if (!attempt) return (await tx.select().from(poolChatRequests).where(eq(poolChatRequests.id, request.id)))[0];
          await tx.update(poolChatQuotaReservations).set({ state: "settled", settledUnits: result.inputUnits + result.outputUnits, updatedAt: new Date() }).where(and(eq(poolChatQuotaReservations.requestId, request.id), eq(poolChatQuotaReservations.state, "reserved")));
          const [updated] = await tx.update(poolChatRequests).set({ status: "completed", charged: true, result: { text: result.text }, usage: { inputUnits: result.inputUnits, outputUnits: result.outputUnits }, updatedAt: new Date() }).where(and(eq(poolChatRequests.id, request.id), eq(poolChatRequests.status, "dispatching"))).returning();
          return updated;
        });
      } catch {
        await db.transaction(async (tx: any) => {
          await tx.update(poolChatRequestAttempts).set({ state: "uncertain", failureCode: "provider_unknown", failureDetail: "provider_transport_failed", updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, request.id), eq(poolChatRequestAttempts.attemptNo, 1), eq(poolChatRequestAttempts.state, "dispatching")));
          await tx.update(poolChatRequests).set({ status: "uncertain", updatedAt: new Date() }).where(and(eq(poolChatRequests.id, request.id), eq(poolChatRequests.status, "dispatching")));
        });
        throw new HttpError(502, "Pool-chat provider request failed");
      }
      return request;
    },
    async status(companyId: string, moduleId: string, requestId: string) {
      const row = await db.select().from(poolChatRequests).where(and(eq(poolChatRequests.companyId, companyId), eq(poolChatRequests.moduleId, moduleId), eq(poolChatRequests.id, requestId))).then((rows) => rows[0]);
      if (!row) throw notFound("Pool-chat request not found");
      return row;
    },
  };
}