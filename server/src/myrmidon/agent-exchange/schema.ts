// server/src/myrmidon/agent-exchange/schema.ts
//
// myrmidon(1.7 AGENT-EXCHANGE, OPE-12078): Zod schemas and validation logic
// for experience exchange rooms (roadmap-v1 §3.3, OPE-3965).
//
// Guarantees room integrity:
//  - 2 to 4 distinct agent participants (fewer or 5+ is rejected);
//  - Non-empty topic string;
//  - Non-negative integer cost_limit_cents;
//  - Valid room state (open | finalizing | closed);
//  - Stop-valve flag requires state === "closed";
//  - Message validity (agent_id, content, tokens_used).

import { z } from "zod";
import {
  EXCHANGE_ROOM_STATES,
  MAX_EXCHANGE_PARTICIPANTS,
  MIN_EXCHANGE_PARTICIPANTS,
  type ExchangeFinisher,
  type ExchangeMessage,
  type ExchangeParticipant,
  type ExchangeRoom,
  type ExchangeRoomState,
} from "./types.js";

export const exchangeRoomStateSchema = z.enum(EXCHANGE_ROOM_STATES);

export const exchangeParticipantSchema: z.ZodType<ExchangeParticipant> = z
  .union([
    z.string().min(1).transform((id) => ({ agent_id: id })),
    z.object({
      agent_id: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      model: z.string().optional(),
      name: z.string().optional(),
    }).refine((data) => Boolean(data.agent_id || data.agentId), {
      message: "participant must have agent_id or agentId",
    }).transform((data) => ({
      agent_id: data.agent_id ?? data.agentId!,
      agentId: data.agentId ?? data.agent_id,
      model: data.model,
      name: data.name,
    })),
  ]);

export const exchangeParticipantListSchema = z
  .array(exchangeParticipantSchema)
  .min(MIN_EXCHANGE_PARTICIPANTS, `exchange room must have at least ${MIN_EXCHANGE_PARTICIPANTS} participants`)
  .max(MAX_EXCHANGE_PARTICIPANTS, `exchange room cannot have more than ${MAX_EXCHANGE_PARTICIPANTS} participants`)
  .refine(
    (list) => {
      const ids = new Set(list.map((p) => p.agent_id));
      return ids.size === list.length;
    },
    { message: "participant agent ids must be unique within the room" },
  );

export const exchangeFinisherSchema: z.ZodType<ExchangeFinisher | null> = z
  .union([
    z.null(),
    z.object({
      agent_id: z.string().min(1).optional(),
      agentId: z.string().min(1).optional(),
      model: z.string().optional(),
      prompt: z.string().optional(),
    }).refine((data) => Boolean(data.agent_id || data.agentId), {
      message: "finisher must have agent_id or agentId",
    }).transform((data) => ({
      agent_id: data.agent_id ?? data.agentId!,
      agentId: data.agentId ?? data.agent_id,
      model: data.model,
      prompt: data.prompt,
    })),
  ]);

export const exchangeMessageSchema: z.ZodType<ExchangeMessage> = z
  .object({
    id: z.string().optional(),
    room_id: z.string().optional(),
    agent_id: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    content: z.string(),
    tokens_used: z.number().int().min(0).optional(),
    tokensUsed: z.number().int().min(0).optional(),
    created_at: z.string().optional(),
    round: z.number().int().min(0).optional(),
  })
  .refine((data) => Boolean(data.agent_id || data.agentId), {
    message: "message must specify agent_id or agentId",
  })
  .refine((data) => data.tokens_used !== undefined || data.tokensUsed !== undefined, {
    message: "message must specify tokens_used or tokensUsed",
  })
  .transform((data) => {
    const agentId = data.agent_id ?? data.agentId!;
    const tokens = data.tokens_used ?? data.tokensUsed ?? 0;
    return {
      id: data.id,
      room_id: data.room_id,
      agent_id: agentId,
      agentId,
      content: data.content,
      tokens_used: tokens,
      tokensUsed: tokens,
      created_at: data.created_at,
      round: data.round,
    };
  });

export const exchangeRoomSchema: z.ZodType<ExchangeRoom> = z
  .object({
    id: z.string().min(1),
    topic: z.string().min(1, "topic cannot be empty"),
    participants: exchangeParticipantListSchema,
    cost_limit_cents: z.number().int().min(0, "cost_limit_cents must be non-negative"),
    state: exchangeRoomStateSchema,
    status: exchangeRoomStateSchema.optional(),
    finisher: exchangeFinisherSchema.nullable().default(null),
    stop_valve: z.boolean(),
    stop_reason: z.string().nullable().optional(),
    total_tokens: z.number().int().min(0).optional().default(0),
    total_cost_cents: z.number().int().min(0).optional().default(0),
    messages: z.array(exchangeMessageSchema).optional().default([]),
    created_at: z.string().min(1),
    closed_at: z.string().nullable().optional(),
  })
  .refine(
    (room) => {
      if (room.stop_valve && room.state !== "closed") {
        return false;
      }
      return true;
    },
    {
      message: "when stop_valve is true, room state must immediately be closed",
      path: ["state"],
    },
  );

export class ExchangeSchemaValidationError extends Error {
  readonly issues: unknown;

  constructor(message: string, issues: unknown) {
    super(message);
    this.name = "ExchangeSchemaValidationError";
    this.issues = issues;
  }
}

function toValidationError(error: z.ZodError, what: string): ExchangeSchemaValidationError {
  const summary = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return new ExchangeSchemaValidationError(`invalid ${what}: ${summary}`, error.issues);
}

/** Validate participants list: returns parsed list or problem string. */
export function validateParticipants(participants: unknown): {
  participants: ExchangeParticipant[] | null;
  problem: string | null;
} {
  const parsed = exchangeParticipantListSchema.safeParse(participants);
  if (!parsed.success) {
    return {
      participants: null,
      problem: parsed.error.issues[0]?.message ?? "invalid participants",
    };
  }
  return { participants: parsed.data, problem: null };
}

/** Parse an exchange message, throwing ExchangeSchemaValidationError on failure. */
export function validateExchangeMessage(raw: unknown): ExchangeMessage {
  const parsed = exchangeMessageSchema.safeParse(raw);
  if (!parsed.success) {
    throw toValidationError(parsed.error, "exchange message");
  }
  return parsed.data;
}

/** Parse a full ExchangeRoom, throwing ExchangeSchemaValidationError on failure. */
export function validateExchangeRoom(raw: unknown): ExchangeRoom {
  const parsed = exchangeRoomSchema.safeParse(raw);
  if (!parsed.success) {
    throw toValidationError(parsed.error, "exchange room");
  }
  return parsed.data;
}

/** Non-throwing validation for ExchangeRoom. */
export function safeValidateExchangeRoom(raw: unknown):
  | { success: true; data: ExchangeRoom }
  | { success: false; error: ExchangeSchemaValidationError } {
  const parsed = exchangeRoomSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, error: toValidationError(parsed.error, "exchange room") };
}

/** Non-throwing validation for ExchangeMessage. */
export function safeValidateExchangeMessage(raw: unknown):
  | { success: true; data: ExchangeMessage }
  | { success: false; error: ExchangeSchemaValidationError } {
  const parsed = exchangeMessageSchema.safeParse(raw);
  if (parsed.success) {
    return { success: true, data: parsed.data };
  }
  return { success: false, error: toValidationError(parsed.error, "exchange message") };
}
