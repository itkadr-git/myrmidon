// server/src/myrmidon/agent-exchange/room.ts
//
// myrmidon(1.7 AGENT-EXCHANGE, OPE-12078): pure domain state operations for
// agent experience exchange rooms (roadmap-v1 §3.3, OPE-3965).
//
// Pure in, pure out: no drizzle, no HTTP, no clock dependency.
// Enforces every acceptance invariant:
//  - Room must have between 2 and 4 participants;
//  - Attempting to add a 5th participant throws too_many_participants error;
//  - Pulling the stop valve instantly transitions state to "closed";
//  - Closed rooms reject further message production or participant additions.

import {
  MAX_EXCHANGE_PARTICIPANTS,
  MIN_EXCHANGE_PARTICIPANTS,
  ExchangeRoomError,
  type CreateExchangeRoomInput,
  type ExchangeMessage,
  type ExchangeParticipant,
  type ExchangeRoom,
} from "./types.js";
import { validateExchangeRoom } from "./schema.js";

function normalizeParticipant(input: string | ExchangeParticipant): ExchangeParticipant {
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (!trimmed) {
      throw new ExchangeRoomError("invalid_config", "participant agent_id cannot be empty");
    }
    return { agent_id: trimmed, agentId: trimmed };
  }
  const id = (input.agent_id || input.agentId || "").trim();
  if (!id) {
    throw new ExchangeRoomError("invalid_config", "participant must have non-empty agent_id");
  }
  return {
    agent_id: id,
    agentId: id,
    model: input.model,
    name: input.name,
  };
}

/**
 * Create a new ExchangeRoom.
 * Acceptance criterion: room with 2 to 4 participants creates successfully;
 * fewer than 2 or 5+ participants is rejected.
 */
export function createExchangeRoom(
  input: CreateExchangeRoomInput,
  options?: { clock?: () => Date },
): ExchangeRoom {
  const clock = options?.clock ?? (() => new Date());
  const nowIso = input.created_at ?? clock().toISOString();

  if (!input.topic || !input.topic.trim()) {
    throw new ExchangeRoomError("invalid_config", "room topic cannot be empty");
  }

  if (!Number.isInteger(input.cost_limit_cents) || input.cost_limit_cents < 0) {
    throw new ExchangeRoomError("invalid_config", "cost_limit_cents must be a non-negative integer");
  }

  if (!Array.isArray(input.participants)) {
    throw new ExchangeRoomError("invalid_participant_count", "participants must be an array");
  }

  if (input.participants.length < MIN_EXCHANGE_PARTICIPANTS) {
    throw new ExchangeRoomError(
      "too_few_participants",
      `exchange room requires at least ${MIN_EXCHANGE_PARTICIPANTS} participants, got ${input.participants.length}`,
    );
  }

  if (input.participants.length > MAX_EXCHANGE_PARTICIPANTS) {
    throw new ExchangeRoomError(
      "too_many_participants",
      `cannot create room with ${input.participants.length} participants: maximum allowed is ${MAX_EXCHANGE_PARTICIPANTS}`,
    );
  }

  const normalizedParticipants: ExchangeParticipant[] = [];
  const seenIds = new Set<string>();

  for (const raw of input.participants) {
    const p = normalizeParticipant(raw);
    if (seenIds.has(p.agent_id)) {
      throw new ExchangeRoomError(
        "duplicate_participant",
        `participant agent '${p.agent_id}' is already present in the room`,
      );
    }
    seenIds.add(p.agent_id);
    normalizedParticipants.push(p);
  }

  const stopValveActive = Boolean(input.stop_valve);
  const roomId = input.id ?? `room-${clock().getTime()}-${Math.random().toString(36).slice(2, 8)}`;

  // If stop valve was triggered at creation, the state is immediately closed.
  const state = stopValveActive ? "closed" : "open";
  const closedAt = stopValveActive ? nowIso : null;

  const room: ExchangeRoom = {
    id: roomId,
    topic: input.topic.trim(),
    participants: normalizedParticipants,
    cost_limit_cents: input.cost_limit_cents,
    state,
    status: state,
    finisher: input.finisher ?? null,
    stop_valve: stopValveActive,
    stop_reason: stopValveActive ? (input.stop_reason ?? "stop_valve_engaged") : null,
    total_tokens: 0,
    total_cost_cents: 0,
    messages: [],
    created_at: nowIso,
    closed_at: closedAt,
  };

  // Run through schema validation to guarantee complete contract parity
  validateExchangeRoom(room);

  return room;
}

/**
 * Add an agent participant to an existing room.
 * Acceptance criterion: attempting to add a 5th participant throws too_many_participants.
 */
export function addParticipant(
  room: ExchangeRoom,
  participant: string | ExchangeParticipant,
): ExchangeRoom {
  if (room.state === "closed" || room.stop_valve) {
    throw new ExchangeRoomError("room_closed", "cannot add participant to a closed exchange room");
  }

  if (room.participants.length >= MAX_EXCHANGE_PARTICIPANTS) {
    throw new ExchangeRoomError(
      "too_many_participants",
      `cannot add participant: room already reached the maximum of ${MAX_EXCHANGE_PARTICIPANTS} participants`,
    );
  }

  const normalized = normalizeParticipant(participant);
  if (room.participants.some((p) => p.agent_id === normalized.agent_id)) {
    throw new ExchangeRoomError(
      "duplicate_participant",
      `agent '${normalized.agent_id}' is already a participant in room ${room.id}`,
    );
  }

  const updatedParticipants = [...room.participants, normalized];

  const updated: ExchangeRoom = {
    ...room,
    participants: updatedParticipants,
  };

  validateExchangeRoom(updated);
  return updated;
}

/**
 * Engage the stop-valve flag (стоп-кран).
 * Acceptance criterion: stop valve flag instantly transitions status/state to "closed".
 */
export function pullStopValve(
  room: ExchangeRoom,
  reason?: string,
  options?: { clock?: () => Date },
): ExchangeRoom {
  const clock = options?.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  const updated: ExchangeRoom = {
    ...room,
    state: "closed",
    status: "closed",
    stop_valve: true,
    stop_reason: reason ?? "stop_valve_pulled",
    closed_at: room.closed_at ?? nowIso,
  };

  validateExchangeRoom(updated);
  return updated;
}

/**
 * Transition room to "finalizing" state when ready to synthesize conclusions.
 */
export function finalizeExchangeRoom(room: ExchangeRoom): ExchangeRoom {
  if (room.state === "closed" || room.stop_valve) {
    throw new ExchangeRoomError("room_closed", "cannot finalize a closed exchange room");
  }

  const updated: ExchangeRoom = {
    ...room,
    state: "finalizing",
    status: "finalizing",
  };

  validateExchangeRoom(updated);
  return updated;
}

/**
 * Orderly close of the exchange room after finisher completes.
 */
export function closeExchangeRoom(
  room: ExchangeRoom,
  reason?: string,
  options?: { clock?: () => Date },
): ExchangeRoom {
  const clock = options?.clock ?? (() => new Date());
  const nowIso = clock().toISOString();

  const updated: ExchangeRoom = {
    ...room,
    state: "closed",
    status: "closed",
    stop_reason: reason ?? room.stop_reason ?? "orderly_closure",
    closed_at: room.closed_at ?? nowIso,
  };

  validateExchangeRoom(updated);
  return updated;
}

/**
 * Record a message in the exchange room.
 * Verifies room is open/finalizing and participant is registered.
 */
export function addExchangeMessage(
  room: ExchangeRoom,
  input: {
    agent_id: string;
    content: string;
    tokens_used: number;
    round?: number;
    cost_cents?: number;
  },
  options?: { clock?: () => Date },
): { room: ExchangeRoom; message: ExchangeMessage } {
  if (room.state === "closed" || room.stop_valve) {
    throw new ExchangeRoomError("room_closed", "cannot add message to a closed exchange room");
  }

  const isParticipant = room.participants.some((p) => p.agent_id === input.agent_id);
  const isFinisher = room.finisher?.agent_id === input.agent_id;

  if (!isParticipant && !isFinisher) {
    throw new ExchangeRoomError(
      "unknown_participant",
      `agent '${input.agent_id}' is neither a participant nor the finisher in room ${room.id}`,
    );
  }

  const clock = options?.clock ?? (() => new Date());
  const nowIso = clock().toISOString();
  const tokens = Math.max(0, input.tokens_used);
  const cost = input.cost_cents ?? 0;

  const message: ExchangeMessage = {
    id: `msg-${clock().getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    room_id: room.id,
    agent_id: input.agent_id,
    agentId: input.agent_id,
    content: input.content,
    tokens_used: tokens,
    tokensUsed: tokens,
    created_at: nowIso,
    round: input.round,
  };

  const newTotalTokens = (room.total_tokens ?? 0) + tokens;
  const newTotalCost = (room.total_cost_cents ?? 0) + cost;

  let nextState = room.state;
  let stopValve = room.stop_valve;
  let stopReason = room.stop_reason;
  let closedAt = room.closed_at;

  // If cost exceeds limit, stop-valve auto-triggers
  if (room.cost_limit_cents > 0 && newTotalCost >= room.cost_limit_cents) {
    nextState = "closed";
    stopValve = true;
    stopReason = "cost_limit_exceeded";
    closedAt = nowIso;
  }

  const updatedRoom: ExchangeRoom = {
    ...room,
    state: nextState,
    status: nextState,
    stop_valve: stopValve,
    stop_reason: stopReason,
    closed_at: closedAt,
    total_tokens: newTotalTokens,
    total_cost_cents: newTotalCost,
    messages: [...(room.messages ?? []), message],
  };

  validateExchangeRoom(updatedRoom);
  return { room: updatedRoom, message };
}
