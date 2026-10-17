// server/src/myrmidon/agent-exchange/skill-candidate.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the acceptance criterion of the ticket —
// "the outcome of a room becomes a skill candidate and waits for approval" —
// run against the real logic with a fake port, plus the refusals that keep the
// button honest.
//
// What is pinned down:
//
//  1. an outcome becomes a candidate: the skill body carries the summary the
//     finisher wrote (not a re-summarization) plus the provenance, the key is
//     derived from the room id, and the result says `promotionRequired: true`;
//  2. the port is only ever asked to *register a candidate* — the fake has no
//     promote method, so a promotion from this path is impossible by type;
//  3. a second press is idempotent: the same key, `created: false`;
//  4. a room without an outcome, a switched-off button, an unknown room and a
//     missing skill library each refuse with their own code.

import { describe, expect, it } from "vitest";
import { agentExchangeRoomSkillKey, agentExchangeRoomSkillSlug } from "@paperclipai/shared";
import { AgentExchangeFeedError } from "./feed.js";
import {
  agentExchangeCandidateDescription,
  agentExchangeTaskLabel,
  createAgentExchangeRoomSkillCandidate,
  type AgentExchangeSkillCandidatePort,
  type AgentExchangeSkillCandidateRequest,
  type AgentExchangeSkillCandidateStore,
} from "./skill-candidate.js";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const ISSUE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_ID = "co-1";

const ROOM = {
  id: ROOM_ID,
  issueId: ISSUE_ID,
  status: "completed",
  participants: [
    { label: "eng-1", model: "gpt-5" },
    { label: "eng-2", model: "claude-4" },
  ],
  currentRound: 3,
  maxRounds: 3,
  tokensUsed: 4_000,
  costCents: 1_250,
  stopReason: null,
  summaryDocumentKey: `exchange:${ROOM_ID}`,
  createdAt: new Date("2026-10-07T06:10:00.000Z"),
  closedAt: new Date("2026-10-07T06:12:00.000Z"),
};

const SUMMARY = "## Where the two answers agreed\n\nRun the package checks with the shared store.\n";

function fakeStore(overrides: Partial<AgentExchangeSkillCandidateStore> = {}): AgentExchangeSkillCandidateStore {
  return {
    getRoom: async () => ROOM,
    getIssueRef: async () => ({ identifier: "OPE-4172", title: "1.7: AGENT-EXCHANGE B" }),
    getSummaryDocument: async (issueId, key) =>
      issueId === ISSUE_ID && key === ROOM.summaryDocumentKey ? { title: null, body: SUMMARY } : null,
    ...overrides,
  };
}

/** A port that records every request and mimics create-or-get by key. */
function fakePort(options: { available?: boolean; existing?: boolean } = {}) {
  const requests: AgentExchangeSkillCandidateRequest[] = [];
  const port: AgentExchangeSkillCandidatePort & { requests: AgentExchangeSkillCandidateRequest[] } = {
    requests,
    available: () => options.available ?? true,
    async createOrGet(input) {
      requests.push(input);
      const created = !(options.existing ?? false);
      return {
        skillId: "skill-1",
        key: `company/${input.companyId}/${input.slug}`,
        name: input.name,
        state: "candidate",
        created,
      };
    },
  };
  return port;
}

describe("createAgentExchangeRoomSkillCandidate", () => {
  it("turns the outcome of a room into a candidate that waits for an approval", async () => {
    const port = fakePort();
    const result = await createAgentExchangeRoomSkillCandidate(
      { store: fakeStore(), port, skillCandidateEnabled: true },
      { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
    );

    expect(result).toEqual({
      skillId: "skill-1",
      key: `company/${COMPANY_ID}/${agentExchangeRoomSkillSlug(ROOM_ID)}`,
      name: "Exchange room: OPE-4172",
      state: "candidate",
      created: true,
      promotionRequired: true,
    });
    expect(port.requests).toHaveLength(1);

    const request = port.requests[0]!;
    // The key derived from the room id is what makes the second press a no-op.
    expect(`company/${request.companyId}/${request.slug}`).toBe(
      agentExchangeRoomSkillKey(COMPANY_ID, ROOM_ID),
    );
    // The body is the finisher's summary, not a new one, plus who took part.
    expect(request.markdown).toContain("Run the package checks with the shared store.");
    expect(request.markdown).toContain(`- Discussion room: \`${ROOM_ID}\``);
    expect(request.markdown).toContain("- Task: OPE-4172 — 1.7: AGENT-EXCHANGE B");
    expect(request.markdown).toContain("eng-1 (gpt-5), eng-2 (claude-4)");
    expect(request.markdown).toContain("cost: $0.1250");
    expect(request.markdown).toContain("candidate");
    expect(request.description).toBe("Outcome of an agent discussion room on OPE-4172 — 1.7: AGENT-EXCHANGE B.");
    expect(request.actor).toEqual({ actorType: "user", actorId: "user-1" });
  });

  it("registers the candidate again on a second press instead of promoting it", async () => {
    const port = fakePort({ existing: true });
    const result = await createAgentExchangeRoomSkillCandidate(
      { store: fakeStore(), port, skillCandidateEnabled: true },
      { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "agent", actorId: "agent-7" } },
    );
    expect(result.created).toBe(false);
    expect(result.state).toBe("candidate");
    expect(result.promotionRequired).toBe(true);
    expect(port.requests[0]!.slug).toBe(agentExchangeRoomSkillSlug(ROOM_ID));
  });

  it("takes the name of the owner and keeps the note in the body", async () => {
    const port = fakePort();
    await createAgentExchangeRoomSkillCandidate(
      { store: fakeStore(), port, skillCandidateEnabled: true },
      {
        companyId: COMPANY_ID,
        roomId: ROOM_ID,
        actor: { actorType: "user", actorId: "user-1" },
        name: "Shared package checks",
        note: "Agreed on the 7th of October.",
      },
    );
    const request = port.requests[0]!;
    expect(request.name).toBe("Shared package checks");
    expect(request.markdown).toContain("# Shared package checks");
    expect(request.markdown).toContain("## Note from the owner");
    expect(request.markdown).toContain("Agreed on the 7th of October.");
  });

  it("refuses a room without an outcome", async () => {
    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore({ getRoom: async () => ({ ...ROOM, summaryDocumentKey: null }) }), port: fakePort(), skillCandidateEnabled: true },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toMatchObject({ code: "room_not_summarized" });
  });

  it("refuses when the summary document is gone", async () => {
    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore({ getSummaryDocument: async () => null }), port: fakePort(), skillCandidateEnabled: true },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toMatchObject({ code: "room_not_summarized" });
  });

  it("refuses when the button is switched off in the settings", async () => {
    const port = fakePort();
    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore(), port, skillCandidateEnabled: false },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toMatchObject({ code: "skill_candidate_disabled" });
    expect(port.requests).toHaveLength(0);
  });

  it("refuses an unknown room and a missing skill library", async () => {
    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore({ getRoom: async () => null }), port: fakePort(), skillCandidateEnabled: true },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toMatchObject({ code: "room_not_found" });

    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore(), port: fakePort({ available: false }), skillCandidateEnabled: true },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toMatchObject({ code: "skill_candidate_unavailable" });
  });

  it("answers the stable codes as instances of the domain error", async () => {
    await expect(
      createAgentExchangeRoomSkillCandidate(
        { store: fakeStore({ getRoom: async () => null }), port: fakePort(), skillCandidateEnabled: true },
        { companyId: COMPANY_ID, roomId: ROOM_ID, actor: { actorType: "user", actorId: "user-1" } },
      ),
    ).rejects.toBeInstanceOf(AgentExchangeFeedError);
  });
});

describe("labels", () => {
  it("falls back to the issue id when the task has no label", () => {
    expect(agentExchangeTaskLabel(null, ISSUE_ID)).toBe(ISSUE_ID);
    expect(agentExchangeTaskLabel({ identifier: null, title: "Just a title" }, ISSUE_ID)).toBe("Just a title");
  });

  it("describes the candidate without quoting content", () => {
    expect(agentExchangeCandidateDescription({ identifier: "OPE-1", title: "T" }, ISSUE_ID)).toBe(
      "Outcome of an agent discussion room on OPE-1 — T.",
    );
  });
});