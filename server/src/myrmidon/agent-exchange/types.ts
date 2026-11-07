// server/src/myrmidon/agent-exchange/types.ts
//
// myrmidon(1.7 AGENT-EXCHANGE, OPE-12078): domain types for agent-to-agent
// experience exchange rooms outside tickets (roadmap-v1 §3.3, OPE-3965).
//
// A peer-to-peer discussion room where 2 to 4 autonomous agents debate solutions,
// share lessons, and synthesize conclusions without cluttering issue threads.
// Governed by an explicit cost ceiling (cost_limit_cents), a registered finisher,
// and an emergency stop-valve that halts execution immediately.

export const EXCHANGE_ROOM_STATES = ["open", "finalizing", "closed"] as const;
export type ExchangeRoomState = (typeof EXCHANGE_ROOM_STATES)[number];

export const MIN_EXCHANGE_PARTICIPANTS = 2;
export const MAX_EXCHANGE_PARTICIPANTS = 4;

/** One agent participant registered in the discussion room. */
export interface ExchangeParticipant {
  /** Stable agent identifier (unique within the room). */
  agent_id: string;
  /** Optional agent identifier alias in camelCase. */
  agentId?: string;
  /** The model configuration powering this participant's turns. */
  model?: string;
  /** Optional human-readable agent name or role description. */
  name?: string;
}

/** Configuration for the finishing synthesizer of the discussion room. */
export interface ExchangeFinisher {
  /** The agent responsible for concluding and extracting lessons. */
  agent_id: string;
  /** Optional agent identifier alias in camelCase. */
  agentId?: string;
  /** Model specified for the finishing step. */
  model?: string;
  /** Custom closing instructions or prompt template. */
  prompt?: string;
}

/** One message produced by an agent inside an exchange room. */
export interface ExchangeMessage {
  id?: string;
  room_id?: string;
  /** The agent who produced this message. */
  agent_id: string;
  /** Optional camelCase alias for agent_id. */
  agentId?: string;
  /** The message text/turn content. */
  content: string;
  /** LLM tokens consumed to generate this message. */
  tokens_used: number;
  /** Optional camelCase alias for tokens_used. */
  tokensUsed?: number;
  /** ISO timestamp when the message was recorded. */
  created_at?: string;
  /** Zero-based round index if the room operates in rounds. */
  round?: number;
}

/** The full exchange room domain record. */
export interface ExchangeRoom {
  /** Unique room identifier. */
  id: string;
  /** The discussion topic or theme (обмен опытом / тема). */
  topic: string;
  /** 2 to 4 registered agent participants. */
  participants: ExchangeParticipant[];
  /** Maximum allowable cost in cents before room must halt. */
  cost_limit_cents: number;
  /** Current lifecycle state: open -> finalizing -> closed. */
  state: ExchangeRoomState;
  /** Optional status alias matching state. */
  status?: ExchangeRoomState;
  /** The designated finisher agent / synthesizer, if specified. */
  finisher: ExchangeFinisher | null;
  /** Emergency stop-valve flag (стоп-кран). True forces state to closed. */
  stop_valve: boolean;
  /** Reason provided when the stop-valve was pulled or room was closed. */
  stop_reason?: string | null;
  /** Cumulative token count used by all messages in the room. */
  total_tokens?: number;
  /** Cumulative cost in cents incurred by all messages in the room. */
  total_cost_cents?: number;
  /** Messages recorded in this room. */
  messages?: ExchangeMessage[];
  /** ISO timestamp of room creation. */
  created_at: string;
  /** ISO timestamp when the room was closed (null while active). */
  closed_at?: string | null;
}

/** Input payload for opening a new discussion room. */
export interface CreateExchangeRoomInput {
  id?: string;
  topic: string;
  participants: (string | ExchangeParticipant)[];
  cost_limit_cents: number;
  finisher?: ExchangeFinisher | null;
  stop_valve?: boolean;
  stop_reason?: string | null;
  created_at?: string;
}

/** Error codes for domain failures. */
export type ExchangeRoomErrorCode =
  | "invalid_config"
  | "invalid_participant_count"
  | "too_many_participants"
  | "too_few_participants"
  | "duplicate_participant"
  | "room_closed"
  | "invalid_transition"
  | "cost_limit_exceeded"
  | "unknown_participant";

export class ExchangeRoomError extends Error {
  readonly code: ExchangeRoomErrorCode;

  constructor(code: ExchangeRoomErrorCode, message: string) {
    super(message);
    this.name = "ExchangeRoomError";
    this.code = code;
  }
}
