// server/src/myrmidon/agent-exchange/feed.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the owner-facing feed of discussion rooms.
//
// Part A owns the room: who took part, how many rounds ran, what the room
// cost and — once the finisher ran — the summary document on the task. Part B
// owns nothing of that; it only *reads* the room records of a company and
// arranges them for the owner:
//
//   - newest first, with the task link (`OPE-1234 — the title`),
//   - the price tag of the room, and an honest "unknown" when the room spent
//     tokens but the model catalog knew no price for the model (part A then
//     records 0 — see `isAgentExchangeCostKnown`),
//   - whether an outcome exists, and whether that outcome is already a skill
//     candidate (the key of a candidate is derived from the room id, so no
//     extra column and no second write path is needed).
//
// Everything below is pure: the store is a port, so the whole assembly is
// tested without a database, and the route layer only authenticates.

import type {
  AgentExchangeFeedResponse,
  AgentExchangeFeedRoom,
  AgentExchangeFeedSkillCandidate,
  AgentExchangeFeedTotals,
} from "@paperclipai/shared";

/** The stable error codes of the feed and of the «to skill» action. */
export type AgentExchangeFeedErrorCode =
  | "room_not_found"
  | "room_not_summarized"
  | "skill_candidate_disabled"
  | "skill_candidate_unavailable";

/** A refusal of the feed or of the «to skill» action, translated by the routes. */
export class AgentExchangeFeedError extends Error {
  constructor(
    readonly code: AgentExchangeFeedErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentExchangeFeedError";
  }
}

/** One participant of the frozen roster, as part A stores it. */
export interface AgentExchangeFeedParticipantRow {
  label: string;
  model: string;
}

/** One room row, narrowed to what the feed renders. */
export interface AgentExchangeFeedRoomRow {
  id: string;
  issueId: string;
  status: string;
  participants: AgentExchangeFeedParticipantRow[];
  currentRound: number;
  maxRounds: number;
  tokensUsed: number;
  costCents: number;
  stopReason: string | null;
  summaryDocumentKey: string | null;
  createdAt: Date | string;
  closedAt: Date | string | null;
}

/** The task label of a room: the identifier and the title as the owner knows them. */
export interface AgentExchangeFeedIssueRef {
  identifier: string | null;
  title: string | null;
}

/** The port the feed reads through — bound to the database in `feed-wiring.ts`. */
export interface AgentExchangeFeedStore {
  /** The newest rooms of the company, at most `limit`, plus the total count. */
  listRooms(companyId: string, limit: number): Promise<{ rows: AgentExchangeFeedRoomRow[]; total: number }>;
  /** The task labels of the referenced issues (`getIssueRefs([])` answers empty). */
  getIssueRefs(issueIds: string[]): Promise<Map<string, AgentExchangeFeedIssueRef>>;
  /**
   * The skill candidates of these rooms, keyed by room id. A candidate is
   * found by the key derived from the room (`agentExchangeRoomSkillKey`).
   */
  findSkillCandidates(
    companyId: string,
    roomIds: string[],
  ): Promise<Map<string, AgentExchangeFeedSkillCandidate>>;
}

export interface AgentExchangeFeedDeps {
  store: AgentExchangeFeedStore;
}

/**
 * False when the room spent tokens but recorded no cost: part A writes 0 when
 * the model catalog carries no price, so 0 alone would read as "free". A room
 * that spent nothing is known to be free.
 */
export function isAgentExchangeCostKnown(row: { tokensUsed: number; costCents: number }): boolean {
  return row.tokensUsed <= 0 || row.costCents > 0;
}

/** The company totals under the feed list. */
export function summarizeAgentExchangeFeedRooms(rooms: AgentExchangeFeedRoom[]): AgentExchangeFeedTotals {
  const totals: AgentExchangeFeedTotals = {
    rooms: rooms.length,
    summarizedRooms: 0,
    candidateRooms: 0,
    tokensUsed: 0,
    costCents: 0,
    costUnknownRooms: 0,
  };
  for (const room of rooms) {
    if (room.summarized) totals.summarizedRooms += 1;
    if (room.skillCandidate) totals.candidateRooms += 1;
    if (!room.costKnown) totals.costUnknownRooms += 1;
    totals.tokensUsed += room.tokensUsed;
    totals.costCents += room.costCents;
  }
  return totals;
}

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Assemble the feed of one company. `limit` and `skillCandidateEnabled` are
 * the resolved settings of the caller (read per request, never cached at
 * boot), so a settings-page change reaches the next read without a restart.
 */
export async function readAgentExchangeFeed(
  deps: AgentExchangeFeedDeps,
  input: { companyId: string; limit: number; skillCandidateEnabled: boolean },
): Promise<AgentExchangeFeedResponse> {
  const { rows, total } = await deps.store.listRooms(input.companyId, input.limit);
  const issueRefs = await deps.store.getIssueRefs([...new Set(rows.map((row) => row.issueId))]);
  const candidates = await deps.store.findSkillCandidates(
    input.companyId,
    rows.map((row) => row.id),
  );

  const rooms: AgentExchangeFeedRoom[] = rows.map((row) => {
    const ref = issueRefs.get(row.issueId) ?? null;
    const summaryDocumentKey = row.summaryDocumentKey ?? null;
    return {
      roomId: row.id,
      issueId: row.issueId,
      issueIdentifier: ref?.identifier ?? null,
      issueTitle: ref?.title ?? null,
      status: row.status,
      stopReason: row.stopReason ?? null,
      participants: row.participants.map((p) => ({ label: p.label, model: p.model })),
      currentRound: row.currentRound,
      maxRounds: row.maxRounds,
      tokensUsed: row.tokensUsed,
      costCents: row.costCents,
      costKnown: isAgentExchangeCostKnown(row),
      summaryDocumentKey,
      summarized: summaryDocumentKey !== null,
      skillCandidate: candidates.get(row.id) ?? null,
      createdAt: toIso(row.createdAt) ?? new Date(0).toISOString(),
      closedAt: toIso(row.closedAt),
    };
  });

  return {
    rooms,
    totals: summarizeAgentExchangeFeedRooms(rooms),
    limit: input.limit,
    truncated: total > rooms.length,
    skillCandidateEnabled: input.skillCandidateEnabled,
  };
}