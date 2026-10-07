// server/src/myrmidon/agent-exchange/store.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the drizzle-backed AgentExchangeStore. All
// room logic lives in engine.ts; this file only translates the store contract
// into the two tables of migration 0307.

import { and, asc, eq } from "drizzle-orm";
import {
  agentExchangeMessages,
  agentExchangeRooms,
  type AgentExchangeMessageRow,
  type AgentExchangeRoomRow,
  type Db,
} from "@paperclipai/db";
import type { AgentExchangeMessage, AgentExchangeRoom } from "@paperclipai/shared";
import type {
  AgentExchangeStore,
  MessagePatch,
  NewRoomRecord,
  RoomPatch,
} from "./engine.js";

type DbExecutor = Pick<Db, "insert" | "select" | "update">;

function toRoom(row: AgentExchangeRoomRow): AgentExchangeRoom {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    status: row.status as AgentExchangeRoom["status"],
    openerType: row.openerType as "user" | "agent",
    openerId: row.openerId,
    stopperType: row.stopperType as "user" | "agent",
    stopperId: row.stopperId,
    participants: (row.participants ?? []) as AgentExchangeRoom["participants"],
    finisher: (row.finisher ?? null) as AgentExchangeRoom["finisher"],
    maxRounds: row.maxRounds,
    tokenBudget: row.tokenBudget,
    tokensUsed: row.tokensUsed,
    costCents: row.costCents,
    currentRound: row.currentRound,
    stopReason: row.stopReason,
    summaryDocumentKey: row.summaryDocumentKey,
    judge: row.judge ?? null,
    createdAt: row.createdAt.toISOString(),
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
  };
}

function toMessage(row: AgentExchangeMessageRow): AgentExchangeMessage {
  return {
    id: row.id,
    roomId: row.roomId,
    round: row.round,
    participantIndex: row.participantIndex,
    status: row.status as AgentExchangeMessage["status"],
    content: row.content,
    error: row.error,
    promptTokens: row.promptTokens,
    completionTokens: row.completionTokens,
    costCents: row.costCents,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}

export function agentExchangeStore(db: DbExecutor): AgentExchangeStore {
  return {
    async insertRoom(record: NewRoomRecord): Promise<AgentExchangeRoom> {
      const [row] = await db
        .insert(agentExchangeRooms)
        .values({
          companyId: record.companyId,
          issueId: record.issueId,
          status: record.status,
          openerType: record.openerType,
          openerId: record.openerId,
          stopperType: record.stopperType,
          stopperId: record.stopperId,
          participants: record.participants,
          finisher: record.finisher,
          maxRounds: record.maxRounds,
          tokenBudget: record.tokenBudget,
        })
        .returning();
      return toRoom(row);
    },

    async getRoom(roomId: string): Promise<AgentExchangeRoom | null> {
      const row = await db
        .select()
        .from(agentExchangeRooms)
        .where(eq(agentExchangeRooms.id, roomId))
        .then((rows) => rows[0] ?? null);
      return row ? toRoom(row) : null;
    },

    async updateRoom(roomId: string, patch: RoomPatch): Promise<AgentExchangeRoom> {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.tokensUsed !== undefined) values.tokensUsed = patch.tokensUsed;
      if (patch.costCents !== undefined) values.costCents = patch.costCents;
      if (patch.currentRound !== undefined) values.currentRound = patch.currentRound;
      if (patch.stopReason !== undefined) values.stopReason = patch.stopReason;
      if (patch.summaryDocumentKey !== undefined) values.summaryDocumentKey = patch.summaryDocumentKey;
      if (patch.closedAt !== undefined) values.closedAt = patch.closedAt;
      const [row] = await db
        .update(agentExchangeRooms)
        .set(values)
        .where(eq(agentExchangeRooms.id, roomId))
        .returning();
      return toRoom(row);
    },

    async listRooms(companyId: string, issueId: string): Promise<AgentExchangeRoom[]> {
      const rows = await db
        .select()
        .from(agentExchangeRooms)
        .where(and(eq(agentExchangeRooms.companyId, companyId), eq(agentExchangeRooms.issueId, issueId)));
      return rows.map(toRoom);
    },

    async insertMessage(input): Promise<AgentExchangeMessage> {
      const [row] = await db
        .insert(agentExchangeMessages)
        .values({
          roomId: input.roomId,
          round: input.round,
          participantIndex: input.participantIndex,
          status: "pending",
        })
        .returning();
      return toMessage(row);
    },

    async updateMessage(messageId: string, patch: MessagePatch): Promise<void> {
      const values: Record<string, unknown> = {};
      if (patch.status !== undefined) values.status = patch.status;
      if (patch.content !== undefined) values.content = patch.content;
      if (patch.error !== undefined) values.error = patch.error;
      if (patch.promptTokens !== undefined) values.promptTokens = patch.promptTokens;
      if (patch.completionTokens !== undefined) values.completionTokens = patch.completionTokens;
      if (patch.costCents !== undefined) values.costCents = patch.costCents;
      if (patch.completedAt !== undefined) values.completedAt = patch.completedAt;
      await db.update(agentExchangeMessages).set(values).where(eq(agentExchangeMessages.id, messageId));
    },

    async listMessages(roomId: string): Promise<AgentExchangeMessage[]> {
      const rows = await db
        .select()
        .from(agentExchangeMessages)
        .where(eq(agentExchangeMessages.roomId, roomId))
        .orderBy(asc(agentExchangeMessages.round), asc(agentExchangeMessages.participantIndex));
      return rows.map(toMessage);
    },
  };
}
