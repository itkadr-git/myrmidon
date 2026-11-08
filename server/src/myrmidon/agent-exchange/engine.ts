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
} from "@myrmidon/shared";
import {
  buildParticipantPrompt,
  collectPreviousRoundAnswers,
  type RoundTotals,
} from "./room-runner.js";

// Round-running rules live in room-runner.ts (OPE-12079): the first-round
// independence rule, the previous-round transcript assembly, and the cost
// summation over all participants. Re-exported here so the engine's public
// surface (and the existing importers/tests) keep their names.
export {
  buildParticipantPrompt,
  collectPreviousRoundAnswers,
  sumRoundTotals,
  EMPTY_ROUND_TOTALS,
  type RoundTotals,
} from "./room-runner.js";

/** Stable failure codes. Callers and tests switch on these, never messages. */
export type AgentExchangeErrorCode =
  | "feature_disabled"
  | "room_not_found"
  | "room_closed"
  | "not_room_stopper"
  | "too_many_participants"
  | "token_budget_exhausted"
  | "round_cap_reached";

/** The stop valve reason recorded on a stopped room. */
export type AgentExchangeStopReason = "owner_stop" | "participant_stop";

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
  /** Marks the room's still-`pending` messages as interrupted by a stop. */
  failPendingMessages?(roomId: string, error: string): Promise<number>;
}

// ---------------------------------------------------------------------------
// Model port and summary sink.
// ---------------------------------------------------------------------------

export interface AgentExchangeModelCallInput {
  providerId: string;
  model: string;
  messages: Array<{ role: "system" | "user"; content: string }>;
  timeoutMs: number;
  /** Aborted when the room's stop valve interrupts the in-flight round. */
  signal?: AbortSignal;
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

/**
 * The in-flight round of a room, keyed by roomId: created before the calls
 * dispatch, aborted by the stop valve. An interrupted round lands as `error`
 * messages (`room_stopped:interrupted_by_stop`) and writes no room totals.
 */
const activeRounds = new Map<string, AbortController>();

function stopAbortReason(): AgentExchangeError {
  return new AgentExchangeError("room_closed", "the room was stopped");
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
 * When the stop valve interrupts the round, the in-flight call is aborted and
 * lands the same way, with the `room_stopped` error.
 */
async function runParticipantCall(
  deps: AgentExchangeEngineDeps,
  room: AgentExchangeRoom,
  messageId: string,
  participant: AgentExchangeParticipantSpec,
  userPrompt: string,
  active: AbortController | null,
): Promise<{ tokens: number; costCents: number; interrupted: boolean }> {
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
      signal: active?.signal,
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
    return { tokens: result.promptTokens + result.completionTokens, costCents, interrupted: false };
  } catch (error) {
    await deps.store.updateMessage(messageId, {
      status: "error",
      error: isStopInterruption(error)
        ? "room_stopped:interrupted_by_stop"
        : `participant_error:${error instanceof Error ? error.message.slice(0, 200) : "call_failed"}`,
      completedAt: now(deps),
    });
    if (isStopInterruption(error)) return { tokens: 0, costCents: 0, interrupted: true };
    return { tokens: 0, costCents: 0, interrupted: false };
  }
}

/** True when the error is the stop valve aborting an in-flight call. */
function isStopInterruption(error: unknown): boolean {
  return error instanceof AgentExchangeError && error.code === "room_closed";
}

/**
 * Runs one round: creates the pending cells, then dispatches every
 * participant of the round in parallel. Returns what the round consumed;
 * `interrupted` is true when the stop valve aborted the round mid-flight.
 */
async function runRound(
  deps: AgentExchangeEngineDeps,
  room: AgentExchangeRoom,
  round: number,
  openingPrompt: string,
): Promise<RoundTotals> {
  const participants = room.participants;
  const messages = round > 1 ? await deps.store.listMessages(room.id) : [];
  // Round 1: previousRoundAnswers is empty, so every prompt is the opening
  // prompt alone (the independence rule in room-runner.ts). Round n>1: every
  // prompt carries the previous round's landed answers.
  const previousRoundAnswers = collectPreviousRoundAnswers({
    messages,
    round: round - 1,
    participants,
  });

  const active = new AbortController();
  activeRounds.set(room.id, active);
  try {
    const calls: Array<Promise<{ tokens: number; costCents: number; interrupted: boolean }>> = [];
    for (let index = 0; index < participants.length; index += 1) {
      const participant = participants[index];
      const prompt = buildParticipantPrompt({ round, openingPrompt, previousRoundAnswers });
      // The cell row exists before the call: a crash mid-round leaves a pending
      // cell, not a silent gap, and a redispatch reuses it.
      const cell = await deps.store.insertMessage({ roomId: room.id, round, participantIndex: index });
      calls.push(runParticipantCall(deps, room, cell.id, participant, prompt, active));
    }
    const results = await Promise.all(calls);
    // The room-round total = the sum over ALL participants' calls (room-runner);
    // `interrupted` rides along per call and OR-folds here so the stop valve
    // can tell an aborted round from a landed one.
    const folded = results.reduce<{ tokens: number; costCents: number; interrupted: boolean }>(
      (acc, r) => ({
        tokens: acc.tokens + r.tokens,
        costCents: acc.costCents + r.costCents,
        interrupted: acc.interrupted || r.interrupted,
      }),
      { tokens: 0, costCents: 0, interrupted: false },
    );
    return { tokens: folded.tokens, costCents: folded.costCents };
  } finally {
    if (activeRounds.get(room.id) === active) activeRounds.delete(room.id);
  }
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
    `Room cost: ${input.totalTokens} tokens, ${input.totalCostCents.toFixed(2)} ¢ ` +
      `(${input.participantCount} participants, ${input.answerCount} answers + finisher).`,
  ].join("\n");
}

/**
 * The finisher: one model call over the transcript. The synthesis lands as a
 * message in the room transcript with a `[finisher]` mark in the content, so
 * `GET /myrmidon/agent-exchange/rooms/:roomId` returns it after the
 * participants' answers (the message grid cell `round = currentRound + 1`,
 * `participantIndex = participants.length` — one past the roster; the unique
 * cell index still holds). It also lands as the issue document
 * `exchange:<roomId>` with the room's cost in the body.
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
  // The synthesis is also a room message: GET /rooms/:roomId returns the
  // transcript, and the finisher mark is what distinguishes the result from a
  // participant answer. Finisher messages use round = currentRound + 1 and a
  // participant index one past the roster, so listMessages ordering places
  // the result after the last participant answer.
  const finisherMessage = await deps.store.insertMessage({
    roomId: room.id,
    round: room.currentRound + 1,
    participantIndex: room.participants.length,
  });
  await deps.store.updateMessage(finisherMessage.id, {
    status: "done",
    content: `[finisher]\n${body}`,
    promptTokens: result.promptTokens,
    completionTokens: result.completionTokens,
    costCents,
    completedAt: now(deps),
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
  if (consumed.interrupted) return room;
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
  if (consumed.interrupted) {
    // The stop valve closed the room mid-round; the closed room is the truth.
    return deps.store.getRoom(roomId).then((closed) => closed ?? room);
  }
  return deps.store.updateRoom(roomId, {
    currentRound: nextRound,
    tokensUsed: room.tokensUsed + consumed.tokens,
    costCents: room.costCents + consumed.costCents,
  });
}

/**
 * The stop valve. `finalize: true` runs the finisher on the stopped room.
 * The room's opener and every room participant may pull it; a participant
 * stop interrupts the in-flight round and records `participant_stop`.
 */
export async function stopRoom(
  deps: AgentExchangeEngineDeps,
  input: { roomId: string; actorType: "user" | "agent"; actorId: string; finalize?: boolean },
): Promise<AgentExchangeRoom> {
  const room = await requireRoom(deps.store, input.roomId);
  const isOpener = room.openerType === input.actorType && room.openerId === input.actorId;
  const isParticipant =
    input.actorType === "agent" &&
    room.participants.some((p) => p.agentId !== null && p.agentId === input.actorId);
  if (!isOpener && !isParticipant) {
    throw new AgentExchangeError(
      "not_room_stopper",
      `Only the room owner or a room participant may stop room ${input.roomId}`,
    );
  }
  if (room.status !== "open") return room;

  const stopReason: AgentExchangeStopReason = isOpener ? "owner_stop" : "participant_stop";
  // Abort before the room row closes: the in-flight calls reject immediately
  // and land as room_stopped errors instead of racing the status flip.
  const active = activeRounds.get(input.roomId);
  if (active) active.abort(stopAbortReason());

  let tokens = room.tokensUsed;
  let costCents = room.costCents;
  let documentKey: string | null = null;
  if (input.finalize === true) {
    const finished = await runFinisher(deps, room);
    documentKey = finished.documentKey;
    tokens += finished.tokens;
    costCents += finished.costCents;
  }
  await deps.store.failPendingMessages?.(input.roomId, "room_stopped:interrupted_by_stop");
  return deps.store.updateRoom(input.roomId, {
    status: input.finalize === true ? "completed" : "stopped",
    stopReason,
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
  const active = activeRounds.get(roomId);
  if (active) active.abort(stopAbortReason());
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
