// server/src/myrmidon/agent-exchange/room-runner.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE, OPE-12079): unit tests for room-runner.
//
// Acceptance criteria of OPE-12079:
//  1. Unit tests: replica of participant B does not contain replica of A in round 1
//     (independent first round of answers to prevent echo chamber).
//  2. Final room cost is summed across ALL participants (tokens * rate).
//  3. CI is green.

import { describe, expect, it } from "vitest";
import {
  agentExchangeCallCostCents,
  DEFAULT_AGENT_EXCHANGE_SETTINGS,
  type AgentExchangeMessage,
  type AgentExchangeParticipantSpec,
  type AgentExchangeRoom,
} from "@myrmidon/shared";
import {
  buildParticipantPrompt,
  collectPreviousRoundAnswers,
  sumRoundTotals,
  EMPTY_ROUND_TOTALS,
} from "./room-runner.js";
import {
  finalizeRoom,
  openRoom,
  type AgentExchangeEngineDeps,
  type AgentExchangeModelCallInput,
  type AgentExchangeModelCallResult,
  type AgentExchangeModelPort,
  type AgentExchangeStore,
} from "./engine.js";

// ---------------------------------------------------------------------------
// Pure unit tests of room-runner functions
// ---------------------------------------------------------------------------

describe("room-runner pure logic (OPE-12079)", () => {
  const participants: AgentExchangeParticipantSpec[] = [
    { agentId: null, label: "Agent-A", providerId: "prov-1", model: "model-a" },
    { agentId: null, label: "Agent-B", providerId: "prov-1", model: "model-b" },
    { agentId: null, label: "Agent-C", providerId: "prov-2", model: "model-c" },
  ];

  it("round 1 prompt contains only opening prompt, never another participant's answer", () => {
    const openingPrompt = "Task: OPE-12079\\n\\nHow should we architect this?";
    const answersFromRound0: string[] = ["Agent-A: I think we should use approach X"];

    // In round 1, buildParticipantPrompt MUST ignore previousRoundAnswers
    const promptA = buildParticipantPrompt({
      round: 1,
      openingPrompt,
      previousRoundAnswers: answersFromRound0,
    });
    const promptB = buildParticipantPrompt({
      round: 1,
      openingPrompt,
      previousRoundAnswers: answersFromRound0,
    });

    expect(promptA).toBe(openingPrompt);
    expect(promptB).toBe(openingPrompt);

    // Participant B's prompt does not contain any part of participant A's answer
    expect(promptB).not.toContain("Agent-A");
    expect(promptB).not.toContain("approach X");
  });

  it("round 2 prompt includes round-1 answers from other participants", () => {
    const openingPrompt = "Task: OPE-12079\\n\\nHow should we architect this?";
    const round1Messages: AgentExchangeMessage[] = [
      {
        id: "msg-1",
        roomId: "room-1",
        round: 1,
        participantIndex: 0,
        status: "done",
        content: "Proposal from A: split runner into pure functions",
        error: null,
        promptTokens: 10,
        completionTokens: 20,
        costCents: 5,
        createdAt: "2026-11-07T00:00:00.000Z",
        completedAt: "2026-11-07T00:00:01.000Z",
      },
      {
        id: "msg-2",
        roomId: "room-1",
        round: 1,
        participantIndex: 1,
        status: "done",
        content: "Proposal from B: keep monolithic engine with subroutines",
        error: null,
        promptTokens: 12,
        completionTokens: 22,
        costCents: 6,
        createdAt: "2026-11-07T00:00:00.000Z",
        completedAt: "2026-11-07T00:00:01.000Z",
      },
    ];

    const collected = collectPreviousRoundAnswers({
      messages: round1Messages,
      round: 1,
      participants,
    });

    expect(collected).toEqual([
      "Agent-A: Proposal from A: split runner into pure functions",
      "Agent-B: Proposal from B: keep monolithic engine with subroutines",
    ]);

    const round2Prompt = buildParticipantPrompt({
      round: 2,
      openingPrompt,
      previousRoundAnswers: collected,
    });

    expect(round2Prompt).toContain("Round 1 answers:");
    expect(round2Prompt).toContain("Agent-A: Proposal from A: split runner into pure functions");
    expect(round2Prompt).toContain("Agent-B: Proposal from B: keep monolithic engine with subroutines");
    expect(round2Prompt).toContain("Round 2: reply to the answers above");
  });

  it("sumRoundTotals sums tokens and costCents across all participants (tokens * rate)", () => {
    expect(EMPTY_ROUND_TOTALS).toEqual({ tokens: 0, costCents: 0 });

    const callA = { tokens: 150, costCents: 12.5 };
    const callB = { tokens: 200, costCents: 18.0 };
    const callC = { tokens: 100, costCents: 7.25 };

    const total = sumRoundTotals([callA, callB, callC]);

    expect(total.tokens).toBe(150 + 200 + 100);
    expect(total.costCents).toBeCloseTo(12.5 + 18.0 + 7.25, 4);
  });
});

// ---------------------------------------------------------------------------
// Integration tests against engine with in-memory store & fake models
// ---------------------------------------------------------------------------

function inMemoryStore(): AgentExchangeStore & { rooms: AgentExchangeRoom[]; messages: AgentExchangeMessage[] } {
  let idCounter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
  const stamp = () => new Date("2026-11-07T12:00:00.000Z").toISOString();
  const rooms: AgentExchangeRoom[] = [];
  const messages: AgentExchangeMessage[] = [];
  return {
    rooms,
    messages,
    async insertRoom(record) {
      const room: AgentExchangeRoom = {
        id: nextId(),
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
        tokensUsed: 0,
        costCents: 0,
        currentRound: 0,
        stopReason: null,
        summaryDocumentKey: null,
        judge: null,
        createdAt: stamp(),
        closedAt: null,
      };
      rooms.push(room);
      return room;
    },
    async getRoom(roomId) {
      return rooms.find((r) => r.id === roomId) ?? null;
    },
    async updateRoom(roomId, patch) {
      const room = rooms.find((r) => r.id === roomId);
      if (!room) throw new Error("room not found");
      Object.assign(room, patch, { closedAt: patch.closedAt ? patch.closedAt.toISOString() : room.closedAt });
      return room;
    },
    async listRooms(companyId, issueId) {
      return rooms.filter((r) => r.companyId === companyId && r.issueId === issueId);
    },
    async insertMessage(input) {
      const message: AgentExchangeMessage = {
        id: nextId(),
        roomId: input.roomId,
        round: input.round,
        participantIndex: input.participantIndex,
        status: "pending",
        content: null,
        error: null,
        promptTokens: 0,
        completionTokens: 0,
        costCents: 0,
        createdAt: stamp(),
        completedAt: null,
      };
      messages.push(message);
      return message;
    },
    async updateMessage(messageId, patch) {
      const message = messages.find((m) => m.id === messageId);
      if (!message) throw new Error("message not found");
      const { completedAt, ...rest } = patch;
      Object.assign(message, rest);
      if (completedAt) message.completedAt = completedAt.toISOString();
    },
    async listMessages(roomId) {
      return messages
        .filter((m) => m.roomId === roomId)
        .sort((a, b) => a.round - b.round || a.participantIndex - b.participantIndex);
    },
  };
}

class FakePricingModels implements AgentExchangeModelPort {
  calls: AgentExchangeModelCallInput[] = [];
  // Per-model distinct pricing so we can verify the sum of (tokens * rate)
  priceMap: Record<string, { prompt: number; completion: number }> = {
    "model-a": { prompt: 2.0, completion: 4.0 }, // $2/M prompt, $4/M completion
    "model-b": { prompt: 3.0, completion: 6.0 }, // $3/M prompt, $6/M completion
    "model-c": { prompt: 5.0, completion: 10.0 }, // $5/M prompt, $10/M completion
  };

  async call(input: AgentExchangeModelCallInput): Promise<AgentExchangeModelCallResult> {
    this.calls.push(input);
    // Distinct recognizable replica content per model
    const content = `Unique replica from participant [${input.model}]: detailed recommendation`;
    return {
      content,
      promptTokens: 100,
      completionTokens: 50,
    };
  }

  async prices(input: { providerId: string; model: string }) {
    const p = this.priceMap[input.model] ?? { prompt: 1.0, completion: 2.0 };
    return {
      promptPriceUsdPerMillion: p.prompt,
      completionPriceUsdPerMillion: p.completion,
    };
  }
}

describe("agent-exchange room-runner acceptance criteria (OPE-12079)", () => {
  it("acceptance 1: replica of participant B does not contain replica of A in round 1", async () => {
    const store = inMemoryStore();
    const models = new FakePricingModels();
    const deps: AgentExchangeEngineDeps = {
      store,
      models,
      summaries: { written: [], async putSummary() { return "doc-1"; } } as any,
      settings: { ...DEFAULT_AGENT_EXCHANGE_SETTINGS, enabled: true },
    };

    const participants: AgentExchangeParticipantSpec[] = [
      { agentId: null, label: "Participant-A", providerId: "prov-1", model: "model-a" },
      { agentId: null, label: "Participant-B", providerId: "prov-1", model: "model-b" },
      { agentId: null, label: "Participant-C", providerId: "prov-2", model: "model-c" },
    ];

    const _room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "agent",
      openerId: "agent-opener",
      participants,
      prompt: "Draft initial proposal for deployment",
      issueTitle: "OPE-12079 AGENT-EXCHANGE",
    });

    // 3 participants dispatched in round 1
    expect(models.calls).toHaveLength(3);

    // Call 0 was for Participant-A, Call 1 was for Participant-B, Call 2 for Participant-C
    const callA = models.calls[0];
    const callB = models.calls[1];
    const callC = models.calls[2];

    const promptTextA = callA.messages.find((m) => m.role === "user")?.content ?? "";
    const promptTextB = callB.messages.find((m) => m.role === "user")?.content ?? "";
    const promptTextC = callC.messages.find((m) => m.role === "user")?.content ?? "";

    // Both prompts must contain the opening prompt
    expect(promptTextA).toContain("Draft initial proposal for deployment");
    expect(promptTextB).toContain("Draft initial proposal for deployment");
    expect(promptTextC).toContain("Draft initial proposal for deployment");

    // CRITICAL: Participant B's prompt MUST NOT contain any part of Participant A's replica
    // or label or answer
    expect(promptTextB).not.toContain("Participant-A");
    expect(promptTextB).not.toContain("model-a");
    expect(promptTextB).not.toContain("Unique replica from participant");

    // Participant C's prompt MUST NOT contain Participant A or B's replica
    expect(promptTextC).not.toContain("Participant-A");
    expect(promptTextC).not.toContain("Participant-B");

    // Messages recorded in store for round 1
    const round1Messages = store.messages.filter((m) => m.round === 1);
    expect(round1Messages).toHaveLength(3);
    const msgA = round1Messages.find((m) => m.participantIndex === 0);
    const msgB = round1Messages.find((m) => m.participantIndex === 1);
    expect(msgA?.content).toContain("Unique replica from participant [model-a]");
    expect(msgB?.content).toContain("Unique replica from participant [model-b]");
  });

  it("acceptance 2: final room cost is summed across ALL participants (tokens * rate)", async () => {
    const store = inMemoryStore();
    const models = new FakePricingModels();
    const summariesWritten: any[] = [];
    const deps: AgentExchangeEngineDeps = {
      store,
      models,
      summaries: {
        async putSummary(input: any) {
          summariesWritten.push(input);
          return `exchange:${input.roomId}`;
        },
      },
      settings: { ...DEFAULT_AGENT_EXCHANGE_SETTINGS, enabled: true },
    };

    const participants: AgentExchangeParticipantSpec[] = [
      { agentId: null, label: "Participant-A", providerId: "prov-1", model: "model-a" },
      { agentId: null, label: "Participant-B", providerId: "prov-1", model: "model-b" },
      { agentId: null, label: "Participant-C", providerId: "prov-2", model: "model-c" },
    ];

    // Expected costs for each participant in round 1:
    // Prompt tokens = 100, Completion tokens = 50
    // Model A: prompt $2.0/M, compl $4.0/M => (100*2 + 50*4)/1M = 400/1M = $0.0004 = 0.04 cents
    // Model B: prompt $3.0/M, compl $6.0/M => (100*3 + 50*6)/1M = 600/1M = $0.0006 = 0.06 cents
    // Model C: prompt $5.0/M, compl $10.0/M => (100*5 + 50*10)/1M = 1000/1M = $0.0010 = 0.10 cents
    const costA = agentExchangeCallCostCents({
      promptTokens: 100,
      completionTokens: 50,
      promptPriceUsdPerMillion: 2.0,
      completionPriceUsdPerMillion: 4.0,
    });
    const costB = agentExchangeCallCostCents({
      promptTokens: 100,
      completionTokens: 50,
      promptPriceUsdPerMillion: 3.0,
      completionPriceUsdPerMillion: 6.0,
    });
    const costC = agentExchangeCallCostCents({
      promptTokens: 100,
      completionTokens: 50,
      promptPriceUsdPerMillion: 5.0,
      completionPriceUsdPerMillion: 10.0,
    });

    expect(costA).toBe(0.04);
    expect(costB).toBe(0.06);
    expect(costC).toBe(0.1);

    const expectedRound1Cost = costA + costB + costC; // 0.20 cents
    const expectedRound1Tokens = 3 * (100 + 50); // 450 tokens

    const room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "agent",
      openerId: "agent-opener",
      participants,
      prompt: "Draft initial proposal for deployment",
      issueTitle: "OPE-12079 AGENT-EXCHANGE",
    });

    // Check individual messages stored
    const msgA = store.messages.find((m) => m.participantIndex === 0 && m.round === 1);
    const msgB = store.messages.find((m) => m.participantIndex === 1 && m.round === 1);
    const msgC = store.messages.find((m) => m.participantIndex === 2 && m.round === 1);

    expect(msgA?.costCents).toBe(costA);
    expect(msgB?.costCents).toBe(costB);
    expect(msgC?.costCents).toBe(costC);

    // Verify room.costCents is the sum over ALL participants
    expect(room.tokensUsed).toBe(expectedRound1Tokens);
    expect(room.costCents).toBeCloseTo(expectedRound1Cost, 4);

    // Finalize room: finisher also adds its cost to the grand total
    const closedRoom = await finalizeRoom(deps, room.id);
    expect(closedRoom.status).toBe("completed");
    expect(closedRoom.costCents).toBeGreaterThan(expectedRound1Cost);
    expect(closedRoom.tokensUsed).toBeGreaterThan(expectedRound1Tokens);

    // Finisher used model-a (first participant default): prompt 100, compl 50 -> cost 0.04 cents
    expect(closedRoom.costCents).toBeCloseTo(expectedRound1Cost + costA, 4);
    expect(closedRoom.tokensUsed).toBe(expectedRound1Tokens + 150);

    // Summary document written includes the total cost
    expect(summariesWritten).toHaveLength(1);
    expect(summariesWritten[0].body).toContain("Room cost: 600 tokens, 0.24 ¢");
  });
});
