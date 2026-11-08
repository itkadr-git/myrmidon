// server/src/myrmidon/agent-exchange/feed.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-B): the feed assembly, run against a fake store
// so the shape, the price tag and the candidate mapping are checked without a
// database.
//
// What the tests pin down:
//
//  1. the feed reads the rooms of ONE company, newest first as the store
//     answers, with the task label attached and the cap forwarded;
//  2. the price tag is honest: a room that spent tokens with no recorded cost
//     reads as "unknown", a room that spent nothing reads as known-free;
//  3. a room with an outcome is marked summarized, and the candidate of the
//     room is the one the store found for its derived key;
//  4. the totals add up over the rooms the feed actually answered with, and
//     `truncated` says when the company has more.

import { describe, expect, it } from "vitest";
import {
  isAgentExchangeCostKnown,
  readAgentExchangeFeed,
  summarizeAgentExchangeFeedRooms,
  type AgentExchangeFeedStore,
} from "./feed.js";

function fakeStore(overrides: Partial<AgentExchangeFeedStore> = {}): AgentExchangeFeedStore {
  return {
    listRooms: async () => ({ rows: [], total: 0 }),
    getIssueRefs: async () => new Map(),
    findSkillCandidates: async () => new Map(),
    ...overrides,
  };
}

const ROOM_A = {
  id: "11111111-1111-4111-8111-111111111111",
  issueId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  status: "completed",
  participants: [
    { label: "eng-1", model: "gpt-5" },
    { label: "eng-2", model: "claude-4" },
  ],
  currentRound: 3,
  maxRounds: 3,
  tokensUsed: 12_345,
  costCents: 4_200,
  stopReason: null,
  summaryDocumentKey: "exchange:11111111-1111-4111-8111-111111111111",
  createdAt: new Date("2026-10-07T06:10:00.000Z"),
  closedAt: new Date("2026-10-07T06:12:00.000Z"),
};

const ROOM_B = {
  id: "22222222-2222-4222-8222-222222222222",
  issueId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  status: "stopped",
  participants: [{ label: "eng-3", model: "gpt-5" }],
  currentRound: 1,
  maxRounds: 3,
  // Spent tokens but no price was known: part A records 0.
  tokensUsed: 900,
  costCents: 0,
  stopReason: "owner_stop",
  summaryDocumentKey: null,
  createdAt: new Date("2026-10-07T06:05:00.000Z"),
  closedAt: new Date("2026-10-07T06:06:00.000Z"),
};

describe("isAgentExchangeCostKnown", () => {
  it("treats a spent room without a recorded cost as unknown", () => {
    expect(isAgentExchangeCostKnown({ tokensUsed: 900, costCents: 0 })).toBe(false);
  });

  it("treats a room that spent nothing as known", () => {
    expect(isAgentExchangeCostKnown({ tokensUsed: 0, costCents: 0 })).toBe(true);
  });
});

describe("readAgentExchangeFeed", () => {
  it("returns the rooms with the task label, the cap and the source of truth", async () => {
    const asked: Array<{ companyId: string; limit: number }> = [];
    const feed = await readAgentExchangeFeed(
      {
        store: fakeStore({
          listRooms: async (companyId, limit) => {
            asked.push({ companyId, limit });
            return { rows: [ROOM_A, ROOM_B], total: 7 };
          },
          getIssueRefs: async (issueIds) =>
            new Map([
              [
                "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                { identifier: "OPE-4172", title: "1.7: AGENT-EXCHANGE B" },
              ],
            ]),
        }),
      },
      { companyId: "co-1", limit: 25, skillCandidateEnabled: true },
    );

    expect(asked).toEqual([{ companyId: "co-1", limit: 25 }]);
    expect(feed.limit).toBe(25);
    expect(feed.truncated).toBe(true);
    expect(feed.skillCandidateEnabled).toBe(true);
    expect(feed.rooms).toHaveLength(2);

    const [first, second] = feed.rooms;
    expect(first!.issueIdentifier).toBe("OPE-4172");
    expect(first!.issueTitle).toBe("1.7: AGENT-EXCHANGE B");
    expect(first!.costKnown).toBe(true);
    expect(first!.summarized).toBe(true);
    expect(first!.createdAt).toBe("2026-10-07T06:10:00.000Z");
    expect(first!.closedAt).toBe("2026-10-07T06:12:00.000Z");

    // A room of a task the feed could not resolve still answers, without a label.
    expect(second!.issueIdentifier).toBeNull();
    expect(second!.issueTitle).toBeNull();
    expect(second!.costKnown).toBe(false);
    expect(second!.summarized).toBe(false);
    expect(second!.stopReason).toBe("owner_stop");
  });

  it("is not truncated when the company has exactly the rooms answered", async () => {
    const feed = await readAgentExchangeFeed(
      { store: fakeStore({ listRooms: async () => ({ rows: [ROOM_A], total: 1 }) }) },
      { companyId: "co-1", limit: 50, skillCandidateEnabled: false },
    );
    expect(feed.truncated).toBe(false);
    expect(feed.skillCandidateEnabled).toBe(false);
  });

  it("attaches the candidate the store found for the room", async () => {
    const feed = await readAgentExchangeFeed(
      {
        store: fakeStore({
          listRooms: async () => ({ rows: [ROOM_A, ROOM_B], total: 2 }),
          findSkillCandidates: async (companyId, roomIds) => {
            expect(companyId).toBe("co-1");
            expect(roomIds.sort()).toEqual([ROOM_A.id, ROOM_B.id].sort());
            return new Map([
              [
                ROOM_A.id,
                {
                  skillId: "skill-1",
                  key: `company/co-1/exchange-room-${ROOM_A.id}`,
                  name: "Exchange room: OPE-4172",
                  state: "candidate",
                },
              ],
            ]);
          },
        }),
      },
      { companyId: "co-1", limit: 50, skillCandidateEnabled: true },
    );

    expect(feed.rooms[0]!.skillCandidate).toEqual({
      skillId: "skill-1",
      key: `company/co-1/exchange-room-${ROOM_A.id}`,
      name: "Exchange room: OPE-4172",
      state: "candidate",
    });
    expect(feed.rooms[1]!.skillCandidate).toBeNull();
  });

  it("adds up the totals of the rooms it answered with, not of the company", async () => {
    const feed = await readAgentExchangeFeed(
      { store: fakeStore({ listRooms: async () => ({ rows: [ROOM_A, ROOM_B], total: 40 }) }) },
      { companyId: "co-1", limit: 2, skillCandidateEnabled: true },
    );
    expect(feed.totals).toEqual({
      rooms: 2,
      summarizedRooms: 1,
      candidateRooms: 0,
      tokensUsed: 13_245,
      costCents: 4_200,
      costUnknownRooms: 1,
    });
  });

  it("asks the store once for the distinct tasks of the page", async () => {
    const asked: string[][] = [];
    await readAgentExchangeFeed(
      {
        store: fakeStore({
          listRooms: async () => ({ rows: [ROOM_A, { ...ROOM_A, id: "33333333-3333-4333-8333-333333333333" }], total: 2 }),
          getIssueRefs: async (issueIds) => {
            asked.push(issueIds);
            return new Map();
          },
        }),
      },
      { companyId: "co-1", limit: 50, skillCandidateEnabled: true },
    );
    expect(asked).toEqual([["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"]]);
  });
});

describe("summarizeAgentExchangeFeedRooms", () => {
  it("counts candidates only for rooms that have one", () => {
    const totals = summarizeAgentExchangeFeedRooms([
      {
        roomId: "r1",
        issueId: "i1",
        issueIdentifier: null,
        issueTitle: null,
        status: "completed",
        stopReason: null,
        participants: [],
        currentRound: 1,
        maxRounds: 3,
        tokensUsed: 10,
        costCents: 100,
        costKnown: true,
        summaryDocumentKey: "exchange:r1",
        summarized: true,
        skillCandidate: { skillId: "s1", key: "company/c/exchange-room-r1", name: "n", state: "candidate" },
        createdAt: "2026-10-07T06:00:00.000Z",
        closedAt: null,
      },
    ]);
    expect(totals.candidateRooms).toBe(1);
    expect(totals.summarizedRooms).toBe(1);
    expect(totals.costUnknownRooms).toBe(0);
  });
});