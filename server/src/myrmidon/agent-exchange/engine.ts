// server/src/myrmidon/agent-exchange/engine.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the room engine — pure room logic over a
// store interface. The engine owns every rule of the discussion room:
//
//  - Round 1 is INDEPENDENT: every participant's round-1 prompt is the
//    opening prompt alone. The acceptance test proves it from the fake model
//    port's call log (no round-1 prompt may contain another answer).
//  - From round 2 on, a participant's prompt includes the previous round's
//    landed answers.
//  - The room keeps its own copy of the ceilings (rounds, tokens) resolved at
//    open, so a later settings change does not retroactively shrink it.
//  - One failing participant is a message in `error` state, never a dead room.
//  - The stop valve ends the room WITHOUT new model calls — not even the
//    finisher — unless the caller passes `finalize: true`.
//
// The engine never touches drizzle: every read/write goes through
// AgentExchangeStore (store.ts has the real tables; the tests use an
// in-memory store). The model port and the summary sink are injected the same
// way.

import {
  agentExchangeCallCostCents,
  estimateAgentExchangeTokens,
  type AgentExchangeMessage,
  type AgentExchangeParticipantSpec,
  type AgentExchangeRoom,
  type AgentExchangeSettings,
} from "@paperclipai/shared";

/** Stable failure codes. Callers and tests switch on these, never messages. */
export type AgentExchangeErrorCode =
  | "feature_disabled"
  | "room_not_found"
  | "room_closed"
  | "not_room_stopper"
  | "too_many_participants"
  | "token_budget_exhausted"
  | "round_cap_reached";

export class AgentExchangeError extends Error {
  readonly code: AgentExchangeErrorCode;
  constructor(code: AgentExchangeErrorCode, message: string) {
    super(message);
    this.name = "AgentExchangeError";
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// Store contract — the only persistence surface the engine knows.
// ---------------------------------------------------------------------------

export interface NewRoomRecord {
  companyId: string;
  issueId: string;
  status: "open";
  openerType: "user" | "agent";
  openerId: string;
  stopperType: "user" | "agent";
  stopperId: string;
  participants: AgentExchangeParticipantSpec[];
  finisher: { providerId: string; model: string } | null;
  maxRounds: number;
  tokenBudget: number;
}

export interface RoomPatch {
  status?: AgentExchangeRoom["status"];
  tokensUsed?: number;
  costCents?: number;
  currentRound?: number;
  stopReason?: string | null;
  summaryDocumentKey?: string | null;
  closedAt?: Date | null;
}

export interface MessagePatch {
  status?: AgentExchangeMessage["status"];
  content?: string | null;
  error?: string | null;
  promptTokens?: number;
  completionTokens?: number;
  costCents?: number;
  completedAt?: Date | null;
}

export interface AgentExchangeStore {
  insertRoom(record: NewRoomRecord): Promise<AgentExchangeRoom>;
  getRoom(roomId: string): Promise<AgentExchangeRoom | null>;
  updateRoom(roomId: string, patch: RoomPatch): Promise<AgentExchangeRoom>;
  listRooms(companyId: string, issueId: string): Promise<AgentExchangeRoom[]>;
  insertMessage(input: { roomId: string; round: number; participantIndex: number }): Promise<AgentExchangeMessage>;
  updateMessage(messageId: string, patch: MessagePatch): Promise<void>;
  listMessages(roomId: string): Promise<AgentExchangeMessage[]>;
}

// ---------------------------------------------------------------------------
// Model port and summary sink.
// ---------------------------------------------------------------------------

export interface AgentExchangeModelCallInput {
  providerId: string;
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  timeoutMs: number;
}

export interface AgentExchangeModelCallResult {
  content: string;
  promptTokens: number;
  completionTokens: number;
}

export interface AgentExchangeModelPort {
  call(input: AgentExchangeModelCallInput): Promise<AgentExchangeModelCallResult>;
  prices(input: { providerId: string; model: string }): Promise<{
    promptPriceUsdPerMillion: number | null;
    completionPriceUsdPerMillion: number | null;
  }>;
}

export interface AgentExchangeSummarySink {
  putSummary(input: {
    issueId: string;
    roomId: string;
    title: string;
    body: string;
    changeSummary: string;
  }): Promise<string>;
}

export interface AgentExchangeEngineDeps {
  store: AgentExchangeStore;
  models: AgentExchangeModelPort;
  summaries: AgentExchangeSummarySink;
  settings: AgentExchangeSettings;
  now?(): Date;
}

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------

export const AGENT_EXCHANGE_PARTICIPANT_SYSTEM_PROMPT = [
  "You are one of several agents discussing a task. Answer with your own",
  "position: what you would do, what you see as the risk, one concrete step.",
  "Be brief (at most 300 words). Do not repeat the question.",
].join("\n");

export const AGENT_EXCHANGE_FINISHER_SYSTEM_PROMPT = [
  "You close a multi-agent discussion. You are given the full transcript of a",
  "room: several participants answered an opening prompt in independent first",
  "answers, then possibly replied to each other in further rounds.",
  "Write the summary: (1) where the participants agree, (2) where they differ",
  "and on what, (3) the recommended next step. Be brief (at most 400 words).",
].join("\n");

/** The prompt of one participant call. Round 1 sees the opening prompt ONLY. */
export function buildParticipantPrompt(input: {
  round: number;
  openingPrompt: string;
  previousRoundAnswers: string[];
}): string {
  if (input.round === 1) return input.openingPrompt;
  return [
    input.openingPrompt,
    "",
    `Round ${input.round - 1} answers:`,
    ...input.previousRoundAnswers,
    "",
    `Round ${input.round}: reply to the answers above — where do you agree, where do you differ?`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Engine.
// ---------------------------------------------------------------------------

function now(deps: AgentExchangeEngineDeps): Date {
  return deps.now?.() ?? new Date();
}

async function requireRoom(store: AgentExchangeStore, roomId: string): Promise<AgentExchangeRoom> {
  const room = await store.getRoom(roomId);
  if (!room) throw new AgentExchangeError("room_not_found", `Room ${roomId} not found`);
  return room;
}

/**
 * The one model call of a participant. A failing or slow model lands as a
 * message in `error` state — one broken participant never kills the room.
 */
async function runParticipantCall(
  deps: AgentExchangeEngineDeps,
  room: AgentExchangeRoom,
  messageId: string,
  participant: AgentExchangeParticipantSpec,
  userPrompt: string,
): Promise<{ tokens: number; costCents: number }> {
  void room;
  try {
    const result = await deps.models.call({
      providerId: participant.providerId,
      model: participant.model,
      messages: [
        { role: "system", content: AGENT_EXCHANGE_PARTICIPANT_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ],
      timeoutMs: deps.settings.responseTimeoutMs,
    });
    const prices = await deps.models.prices({ providerId: participant.providerId, model: participant.model });
    const costCents = agentExchangeCallCostCents({
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      promptPriceUsdPerMillion: prices.promptPriceUsdPerMillion,
      completionPriceUsdPerMillion: prices.completionPriceUsdPerMillion,
    });
    await deps.store.updateMessage(messageId, {
      status: "done",
      content: result.content,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      costCents,
      completedAt: now(deps),
    });
    return { tokens: result.promptTokens + result.completionTokens, costCents };
  } catch (error) {
    await deps.store.updateMessage(messageId, {
      status: "error",
      error: `participant_error:${error instanceof Error ? error.message.slice(0, 200) : "call_failed"}`,
      completedAt: now(deps),
    });
    return { tokens: 0, costCents: 0 };
  }
}

/**
 * Runs one round: creates the pending cells, then dispatches every
 * participant of the round in parallel. Returns what the round consumed.
 */
async function runRound(
  deps: AgentExchangeEngineDeps,
  room: AgentExchangeRoom,
  round: number,
  openingPrompt: string,
): Promise<{ tokens: number; costCents: number }> {
  const participants = room.participants;
  const messages = round > 1 ? await deps.store.listMessages(room.id) : [];
  const previousRoundAnswers = messages
    .filter((m) => m.round === round - 1 && m.status === "done" && m.content)
    .map((m) => `${participants[m.participantIndex]?.label ?? `participant-${m.participantIndex}`}: ${m.content}`);

  const calls: Array<Promise<{ tokens: number; costCents: number }>> = [];
  for (let index = 0; index < participants.length; index += 1) {
    const participant = participants[index];
    const prompt = buildParticipantPrompt({ round, openingPrompt, previousRoundAnswers });
    // The cell row exists before the call: a crash mid-round leaves a pending
    // cell, not a silent gap, and a redispatch reuses it.
    const cell = await deps.store.insertMessage({ roomId: room.id, round, participantIndex: index });
    calls.push(runParticipantCall(deps, room, cell.id, participant, prompt));
  }
  const results = await Promise.all(calls);
  return results.reduce(
    (acc, r) => ({ tokens: acc.tokens + r.tokens, costCents: acc.costCents + r.costCents }),
    { tokens: 0, costCents: 0 },
  );
}

/** The transcript the finisher reads: every landed answer, in round order. */
export function buildTranscript(room: AgentExchangeRoom, messages: AgentExchangeMessage[]): string {
  const lines: string[] = [];
  const rounds = [...new Set(messages.filter((m) => m.status === "done").map((m) => m.round))].sort(
    (a, b) => a - b,
  );
  for (const round of rounds) {
    lines.push(`--- Round ${round} ---`);
    for (const m of messages.filter((x) => x.round === round && x.status === "done" && x.content)) {
      const spec = room.participants[m.participantIndex];
      lines.push(`${spec?.label ?? `participant-${m.participantIndex}`} (${spec?.model ?? "?"}): ${m.content}`);
    }
  }
  return lines.join("\n");
}

/** The summary document body: the finisher's answer plus the room's cost. */
export function buildSummaryBody(input: {
  finisherAnswer: string;
  totalTokens: number;
  totalCostCents: number;
  participantCount: number;
  answerCount: number;
}): string {
  return [
    input.finisherAnswer,
    "",
    "---",
    `Room cost: ${input.totalTokens} tokens, ${(input.totalCostCents / 100).toFixed(2)} ¢ ` +
      `(${input.participantCount} participants, ${input.answerCount} answers + finisher).`,
  ].join("\n");
}

/**
 * The finisher: one model call over the transcript; the answer lands as the
 * issue document `exchange:<roomId>` with the room's cost in the body.
 */
async function runFinisher(
  deps: AgentExchangeEngineDeps,
  room: AgentExchangeRoom,
): Promise<{ documentKey: string; tokens: number; costCents: number }> {
  const messages = await deps.store.listMessages(room.id);
  const transcript = buildTranscript(room, messages);
  const finisher = room.finisher ?? {
    providerId: room.participants[0].providerId,
    model: room.participants[0].model,
  };

  const estimatedPromptTokens = estimateAgentExchangeTokens(AGENT_EXCHANGE_FINISHER_SYSTEM_PROMPT + transcript);
  if (room.tokensUsed + estimatedPromptTokens > room.tokenBudget) {
    throw new AgentExchangeError(
      "token_budget_exhausted",
      `Room ${room.id} has ${room.tokenBudget - room.tokensUsed} tokens left; the finisher prompt needs ~${estimatedPromptTokens}`,
    );
  }

  const result = await deps.models.call({
    providerId: finisher.providerId,
    model: finisher.model,
    messages: [
      { role: "system", content: AGENT_EXCHANGE_FINISHER_SYSTEM_PROMPT },
      { role: "user", content: transcript },
    ],
    timeoutMs: deps.settings.responseTimeoutMs,
  });
  const prices = await deps.models.prices({ providerId: finisher.providerId, model: finisher.model });
  const costCents = agentExchangeCallCostCents({
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    promptPriceUsdPerMillion: prices.promptPriceUsdPerMillion,
    completionPriceUsdPerMillion: prices.completionPriceUsdPerMillion,
  });
  const tokens = result.promptTokens + result.completionTokens;

  const body = buildSummaryBody({
    finisherAnswer: result.content,
    totalTokens: room.tokensUsed + tokens,
    totalCostCents: room.costCents + costCents,
    participantCount: room.participants.length,
    answerCount: messages.filter((m) => m.status === "done").length,
  });
  const documentKey = await deps.summaries.putSummary({
    issueId: room.issueId,
    roomId: room.id,
    title: `Discussion room summary (${room.participants.map((p) => p.label).join(", ")})`,
    body,
    changeSummary: `agent-exchange room ${room.id} summary`,
  });
  return { documentKey, tokens, costCents };
}

export interface OpenRoomInput {
  companyId: string;
  issueId: string;
  openerType: "user" | "agent";
  openerId: string;
  participants: AgentExchangeParticipantSpec[];
  finisher?: { providerId: string; model: string } | null;
  maxRounds?: number;
  tokenBudget?: number;
  prompt: string;
  issueTitle: string;
}

/**
 * Opens the room and runs round 1 (the independent answers). The room record
 * is written before any model call, so a crash mid-round leaves a resumable
 * room with pending cells.
 */
export async function openRoom(
  deps: AgentExchangeEngineDeps,
  input: OpenRoomInput,
): Promise<AgentExchangeRoom> {
  if (!deps.settings.enabled) {
    throw new AgentExchangeError("feature_disabled", "Discussion rooms are disabled (agentExchange.enabled)");
  }
  if (input.participants.length > deps.settings.maxParticipants) {
    throw new AgentExchangeError(
      "too_many_participants",
      `${input.participants.length} participants; the limit is ${deps.settings.maxParticipants}`,
    );
  }
  const maxRounds = input.maxRounds ?? deps.settings.maxRounds;
  const tokenBudget = input.tokenBudget ?? deps.settings.tokenBudget;

  const openingPrompt = `Task: ${input.issueTitle}\n\n${input.prompt}`;
  if (estimateAgentExchangeTokens(openingPrompt) * input.participants.length > tokenBudget) {
    throw new AgentExchangeError(
      "token_budget_exhausted",
      "The opening prompt alone exceeds the room token budget",
    );
  }

  let room = await deps.store.insertRoom({
    companyId: input.companyId,
    issueId: input.issueId,
    status: "open",
    openerType: input.openerType,
    openerId: input.openerId,
    stopperType: input.openerType,
    stopperId: input.openerId,
    participants: input.participants,
    finisher: input.finisher ?? null,
    maxRounds,
    tokenBudget,
  });

  const consumed = await runRound(deps, room, 1, openingPrompt);
  room = await deps.store.updateRoom(room.id, {
    currentRound: 1,
    tokensUsed: consumed.tokens,
    costCents: consumed.costCents,
  });
  return room;
}

/** Runs the next round (round >= 2), after the previous round landed. */
export async function runNextRound(
  deps: AgentExchangeEngineDeps,
  roomId: string,
  openingPrompt: string,
): Promise<AgentExchangeRoom> {
  const room = await requireRoom(deps.store, roomId);
  if (room.status !== "open") {
    throw new AgentExchangeError("room_closed", `Room ${roomId} is ${room.status}`);
  }
  const nextRound = room.currentRound + 1;
  if (nextRound > room.maxRounds) {
    throw new AgentExchangeError("round_cap_reached", `Room ${roomId} reached ${room.maxRounds} rounds`);
  }
  if (room.tokensUsed >= room.tokenBudget) {
    throw new AgentExchangeError("token_budget_exhausted", `Room ${roomId} spent its token budget`);
  }
  const consumed = await runRound(deps, room, nextRound, openingPrompt);
  return deps.store.updateRoom(roomId, {
    currentRound: nextRound,
    tokensUsed: room.tokensUsed + consumed.tokens,
    costCents: room.costCents + consumed.costCents,
  });
}

/** The stop valve. `finalize: true` runs the finisher on the stopped room. */
export async function stopRoom(
  deps: AgentExchangeEngineDeps,
  input: { roomId: string; actorType: "user" | "agent"; actorId: string; finalize?: boolean },
): Promise<AgentExchangeRoom> {
  const room = await requireRoom(deps.store, input.roomId);
  if (room.stopperType !== input.actorType || room.stopperId !== input.actorId) {
    throw new AgentExchangeError(
      "not_room_stopper",
      `Only the room owner (${room.stopperType}:${room.stopperId}) may stop room ${input.roomId}`,
    );
  }
  if (room.status !== "open") return room;

  let tokens = room.tokensUsed;
  let costCents = room.costCents;
  let documentKey: string | null = null;
  if (input.finalize === true) {
    const finished = await runFinisher(deps, room);
    documentKey = finished.documentKey;
    tokens += finished.tokens;
    costCents += finished.costCents;
  }
  return deps.store.updateRoom(input.roomId, {
    status: input.finalize === true ? "completed" : "stopped",
    stopReason: "owner_stop",
    closedAt: now(deps),
    tokensUsed: tokens,
    costCents,
    summaryDocumentKey: documentKey,
  });
}

/**
 * Closes the room with the summary: runs the finisher and marks the room
 * completed. Used when the participants are done before the round cap.
 */
export async function finalizeRoom(deps: AgentExchangeEngineDeps, roomId: string): Promise<AgentExchangeRoom> {
  const room = await requireRoom(deps.store, roomId);
  if (room.status !== "open") {
    throw new AgentExchangeError("room_closed", `Room ${roomId} is ${room.status}`);
  }
  const finished = await runFinisher(deps, room);
  return deps.store.updateRoom(roomId, {
    status: "completed",
    closedAt: now(deps),
    tokensUsed: room.tokensUsed + finished.tokens,
    costCents: room.costCents + finished.costCents,
    summaryDocumentKey: finished.documentKey,
  });
}

export async function getRoom(
  store: AgentExchangeStore,
  roomId: string,
): Promise<{ room: AgentExchangeRoom; messages: AgentExchangeMessage[] }> {
  const room = await requireRoom(store, roomId);
  return { room, messages: await store.listMessages(roomId) };
}
