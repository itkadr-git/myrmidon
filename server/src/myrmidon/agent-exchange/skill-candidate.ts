// server/src/myrmidon/agent-exchange/skill-candidate.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): «the outcome of a room → a skill candidate».
//
// The owner reads the feed, finds a room whose outcome is worth keeping and
// presses one button. That button does exactly three things:
//
//   1. it takes the *outcome* the finisher already wrote (the summary document
//      of the task, `exchange:<roomId>`) — it never re-summarizes and never
//      invents content;
//   2. it creates the skill in the company library with that text as its body,
//      plus the provenance the owner needs to judge it (task, room,
//      participants, what it cost);
//   3. it registers that skill as a **candidate** of SKILL-LIFECYCLE.
//
// Step 3 is where the feature stops on purpose: promotion to a delivered skill
// goes through the existing approvals pipeline (`skill_promotion`), so a room
// outcome can propose a skill but can never hand one to the fleet. The port
// below has no promote method at all — the guarantee is structural, not a
// promise in a comment.
//
// The candidate is keyed from the room (`exchange-room-<roomId>`), so pressing
// the button twice returns the same skill (`created: false`) instead of
// failing or duplicating: idempotence without an extra column on the room.

import {
  agentExchangeRoomCandidateName,
  agentExchangeRoomSkillSlug,
  buildAgentExchangeSkillCandidateMarkdown,
  type AgentExchangeFeedParticipant,
  type AgentExchangeSkillCandidateResult,
} from "@paperclipai/shared";
import {
  AgentExchangeFeedError,
  type AgentExchangeFeedIssueRef,
  type AgentExchangeFeedRoomRow,
} from "./feed.js";

/** Who pressed the button (the board user, or an agent acting for them). */
export interface AgentExchangeSkillCandidateActor {
  actorType: "user" | "agent";
  actorId: string;
}

/** The create-or-get request the port receives. */
export interface AgentExchangeSkillCandidateRequest {
  companyId: string;
  /** The deterministic slug derived from the room id. */
  slug: string;
  name: string;
  description: string;
  markdown: string;
  actor: AgentExchangeSkillCandidateActor;
}

/** What the port answers: the candidate, and whether this call created it. */
export interface CreatedAgentExchangeSkillCandidate {
  skillId: string;
  key: string;
  name: string;
  state: string;
  created: boolean;
}

/**
 * The company-skill side of the action. `available()` is false when the
 * company library or the lifecycle service is not wired (a test double, or a
 * deployment without the skills module), so the route answers 422 instead of
 * pretending the button worked.
 */
export interface AgentExchangeSkillCandidatePort {
  available(): boolean;
  createOrGet(input: AgentExchangeSkillCandidateRequest): Promise<CreatedAgentExchangeSkillCandidate>;
}

/** The outcome of a room: the summary document part A wrote on the task. */
export interface AgentExchangeFeedSummaryDocument {
  title: string | null;
  body: string;
}

export interface AgentExchangeSkillCandidateStore {
  getRoom(companyId: string, roomId: string): Promise<AgentExchangeFeedRoomRow | null>;
  getIssueRef(issueId: string): Promise<AgentExchangeFeedIssueRef | null>;
  getSummaryDocument(issueId: string, key: string): Promise<AgentExchangeFeedSummaryDocument | null>;
}

export interface AgentExchangeSkillCandidateDeps {
  store: AgentExchangeSkillCandidateStore;
  port: AgentExchangeSkillCandidatePort;
  /** The resolved `skillCandidateEnabled` setting of this request. */
  skillCandidateEnabled: boolean;
}

/** The task label the candidate and its provenance line use. */
export function agentExchangeTaskLabel(
  ref: AgentExchangeFeedIssueRef | null,
  issueId: string,
): string {
  const parts = [ref?.identifier?.trim(), ref?.title?.trim()].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" — ") : issueId;
}

/** The description line of the candidate skill (one sentence, no content). */
export function agentExchangeCandidateDescription(ref: AgentExchangeFeedIssueRef | null, issueId: string): string {
  return `Outcome of an agent discussion room on ${agentExchangeTaskLabel(ref, issueId)}.`;
}

/**
 * Turn the outcome of one room into a candidate skill. Refusals are explicit:
 * a room without an outcome has nothing to propose, a switch that is off is
 * respected, and a missing skills library is reported instead of silently
 * creating nothing.
 */
export async function createAgentExchangeRoomSkillCandidate(
  deps: AgentExchangeSkillCandidateDeps,
  input: {
    companyId: string;
    roomId: string;
    actor: AgentExchangeSkillCandidateActor;
    /** Overrides the derived name. */
    name?: string | null;
    /** Optional note stored in the skill body. */
    note?: string | null;
  },
): Promise<AgentExchangeSkillCandidateResult> {
  if (!deps.skillCandidateEnabled) {
    throw new AgentExchangeFeedError(
      "skill_candidate_disabled",
      "Turning a room outcome into a skill candidate is switched off in the agent-exchange feed settings.",
    );
  }

  const room = await deps.store.getRoom(input.companyId, input.roomId);
  if (!room) {
    throw new AgentExchangeFeedError("room_not_found", `No discussion room ${input.roomId} in this company.`);
  }

  const summaryDocumentKey = room.summaryDocumentKey ?? null;
  if (!summaryDocumentKey) {
    throw new AgentExchangeFeedError(
      "room_not_summarized",
      "This room has no outcome yet — finalize it first, then it can become a skill candidate.",
    );
  }

  const document = await deps.store.getSummaryDocument(room.issueId, summaryDocumentKey);
  const summary = document?.body?.trim() ?? "";
  if (!summary) {
    throw new AgentExchangeFeedError(
      "room_not_summarized",
      "This room has no outcome yet — finalize it first, then it can become a skill candidate.",
    );
  }

  if (!deps.port.available()) {
    throw new AgentExchangeFeedError(
      "skill_candidate_unavailable",
      "The skill library of this company is not available, so the candidate cannot be registered.",
    );
  }

  const ref = await deps.store.getIssueRef(room.issueId);
  // The name comes from the owner or from the task; never from the summary
  // document title, which reads "Discussion room summary (eng-1, eng-2)" —
  // a fine title for a document, a useless name for a skill.
  const name =
    input.name?.trim() ||
    agentExchangeRoomCandidateName({
      issueIdentifier: ref?.identifier ?? null,
      issueTitle: ref?.title ?? null,
      roomId: room.id,
    });
  const description = agentExchangeCandidateDescription(ref, room.issueId);
  const participants: AgentExchangeFeedParticipant[] = room.participants.map((participant) => ({
    label: participant.label,
    model: participant.model,
  }));

  const candidate = await deps.port.createOrGet({
    companyId: input.companyId,
    slug: agentExchangeRoomSkillSlug(room.id),
    name,
    description,
    markdown: buildAgentExchangeSkillCandidateMarkdown({
      name,
      description,
      summary,
      issueIdentifier: ref?.identifier ?? null,
      issueTitle: ref?.title ?? null,
      issueId: room.issueId,
      roomId: room.id,
      participants,
      tokensUsed: room.tokensUsed,
      costCents: room.costCents,
      costKnown: room.tokensUsed <= 0 || room.costCents > 0,
      note: input.note ?? null,
    }),
    actor: input.actor,
  });

  return {
    skillId: candidate.skillId,
    key: candidate.key,
    name: candidate.name,
    state: candidate.state,
    created: candidate.created,
    // The feed never promotes: the candidate waits for the approvals pipeline.
    promotionRequired: true,
  };
}