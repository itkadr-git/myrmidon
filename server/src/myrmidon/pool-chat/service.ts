import type { Db } from "@paperclipai/db";
import { poolChatModuleInstances, poolChatQuotaReservations, poolChatRequestAttempts, poolChatRequests } from "@paperclipai/db";
import { and, eq } from "drizzle-orm";
import { conflict, notFound, HttpError } from "../../errors.js";
import { canonicalRequestHash, type PoolChatRequestBody } from "./protocol.js";
import { selectPoolChatAccount } from "./router.js";
import type { PoolChatProvider, PoolChatTransport } from "./transports.js";

export type PoolChatTransportResolver = (input: { provider: PoolChatProvider; moduleId: string; config: Record<string, unknown> }) => PoolChatTransport | null;

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
      const module = await db.select({ provider: poolChatModuleInstances.provider, config: poolChatModuleInstances.config }).from(poolChatModuleInstances).where(and(eq(poolChatModuleInstances.companyId, input.companyId), eq(poolChatModuleInstances.id, input.moduleId), eq(poolChatModuleInstances.status, "active"))).then((rows) => rows[0]);
      if (!module) throw notFound("Pool-chat module not found");
      const provider = providerOf(module.provider);
      const config = module.config ?? {};
      const outcome = await db.transaction(async (tx) => {
        const existing = await tx.select().from(poolChatRequests).where(and(eq(poolChatRequests.companyId, input.companyId), eq(poolChatRequests.moduleId, input.moduleId), eq(poolChatRequests.channel, input.channel), eq(poolChatRequests.subjectId, input.subjectId), eq(poolChatRequests.idempotencyKey, input.idempotencyKey))).then((rows) => rows[0]);
        if (existing) {
          if (existing.requestHash !== hash) throw conflict("Idempotency key was reused with a different request");
          return { request: existing, created: false };
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
      const transport = resolveTransport({ provider, moduleId: input.moduleId, config: { ...config, selectedAccountRef: outcome.accountRef } });
      if (!transport) throw new HttpError(503, "Pool-chat provider transport is not configured");
      let request = outcome.request;
      try {
        const result = await transport.send({ model: input.body.model, messages: input.body.messages, maxOutputTokens: input.body.maxOutputTokens ?? 2048 });
        request = await db.transaction(async (tx) => {
          await tx.update(poolChatRequestAttempts).set({ state: "sent", settledUnits: result.inputUnits + result.outputUnits, providerRequestRef: result.providerRequestRef, updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, request.id), eq(poolChatRequestAttempts.attemptNo, 1)));
          await tx.update(poolChatQuotaReservations).set({ state: "settled", settledUnits: result.inputUnits + result.outputUnits, updatedAt: new Date() }).where(eq(poolChatQuotaReservations.requestId, request.id));
          const [updated] = await tx.update(poolChatRequests).set({ status: "completed", charged: true, result: { text: result.text }, usage: { inputUnits: result.inputUnits, outputUnits: result.outputUnits }, updatedAt: new Date() }).where(eq(poolChatRequests.id, request.id)).returning();
          return updated;
        });
      } catch (error) {
        await db.transaction(async (tx: any) => {
          await tx.update(poolChatRequestAttempts).set({ state: "uncertain", failureCode: "provider_unknown", failureDetail: error instanceof Error ? error.message.slice(0, 256) : "provider_unknown", updatedAt: new Date() }).where(and(eq(poolChatRequestAttempts.requestId, request.id), eq(poolChatRequestAttempts.attemptNo, 1)));
          await tx.update(poolChatRequests).set({ status: "uncertain", updatedAt: new Date() }).where(eq(poolChatRequests.id, request.id));
        });
        throw error;
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