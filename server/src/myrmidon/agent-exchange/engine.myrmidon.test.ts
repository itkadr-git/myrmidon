// server/src/myrmidon/agent-exchange/engine.myrmidon.test.ts
//
// myrmidon(1.7-AGENT-EXCHANGE-A): the two acceptance criteria of the ticket,
// run against the real engine with a fake model port and an in-memory store:
//
//  1. A room with 3 participants yields independent first answers and a
//     summary. "Independent" is proven from the fake's call log: the round-1
//     prompts must NOT contain another participant's answer.
//  2. The stop valve stops the room without new model calls — the fake's
//     call count after `stopRoom` equals the count before.

import { describe, expect, it, beforeEach } from "vitest";
import { DEFAULT_AGENT_EXCHANGE_SETTINGS, type AgentExchangeParticipantSpec } from "@paperclipai/shared";
import type { AgentExchangeMessage, AgentExchangeRoom } from "@paperclipai/shared";
import {
  finalizeRoom,
  openRoom,
  runNextRound,
  stopRoom,
  type AgentExchangeEngineDeps,
  type AgentExchangeModelCallInput,
  type AgentExchangeModelCallResult,
  type AgentExchangeModelPort,
  type AgentExchangeStore,
} from "./engine.js";

// ---------------------------------------------------------------------------
// In-memory store (engine.testStore — the real one lives in store.ts).
// ---------------------------------------------------------------------------

function inMemoryStore(): AgentExchangeStore & { rooms: AgentExchangeRoom[]; messages: AgentExchangeMessage[] } {
  let idCounter = 0;
  const nextId = () => `00000000-0000-4000-8000-${String(++idCounter).padStart(12, "0")}`;
  const stamp = () => new Date("2026-10-07T06:00:00.000Z").toISOString();
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

// ---------------------------------------------------------------------------
// Fake model port: records every call, answers deterministically.
// ---------------------------------------------------------------------------

class FakeModels implements AgentExchangeModelPort {
  calls: AgentExchangeModelCallInput[] = [];
  async call(input: AgentExchangeModelCallInput): Promise<AgentExchangeModelCallResult> {
    this.calls.push(input);
    const user = input.messages.find((m) => m.role === "user")?.content ?? "";
    return {
      content: `answer-from-${input.model}-#${this.calls.length}`,
      promptTokens: Math.ceil(user.length / 4) + 10,
      completionTokens: 20,
    };
  }
  async prices() {
    return { promptPriceUsdPerMillion: 1, completionPriceUsdPerMillion: 2 };
  }
}

// ---------------------------------------------------------------------------
// Fake summary sink.
// ---------------------------------------------------------------------------

function fakeSummaries() {
  const written: Array<{ issueId: string; roomId: string; body: string }> = [];
  return {
    written,
    async putSummary(input: { issueId: string; roomId: string; title: string; body: string }): Promise<string> {
      written.push(input);
      return `exchange:${input.roomId}`;
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const PARTICIPANTS: AgentExchangeParticipantSpec[] = [
  { agentId: null, label: "agent-a", providerId: "prov-1", model: "model-a" },
  { agentId: null, label: "agent-b", providerId: "prov-1", model: "model-b" },
  { agentId: null, label: "agent-c", providerId: "prov-2", model: "model-c" },
];

describe("agent-exchange engine (myrmidon 1.7 AGENT-EXCHANGE-A)", () => {
  let store: ReturnType<typeof inMemoryStore>;
  let models: FakeModels;
  let summaries: ReturnType<typeof fakeSummaries>;
  let deps: AgentExchangeEngineDeps;

  beforeEach(() => {
    store = inMemoryStore();
    models = new FakeModels();
    summaries = fakeSummaries();
    deps = {
      store,
      models,
      summaries,
      settings: { ...DEFAULT_AGENT_EXCHANGE_SETTINGS, enabled: true },
    };
  });

  it("a room with 3 participants yields independent first answers and a summary", async () => {
    const room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "user",
      openerId: "owner-1",
      participants: PARTICIPANTS,
      prompt: "How should we ship this?",
      issueTitle: "OPE-4171",
    });

    // Round 1 dispatched one call per participant, and every round-1 prompt
    // contains the opening prompt and NO other participant's answer — the
    // independence rule.
    expect(models.calls).toHaveLength(3);
    const roundOnePrompts = models.calls.map((c) => c.messages.find((m) => m.role === "user")?.content ?? "");
    for (const prompt of roundOnePrompts) {
      expect(prompt).toContain("How should we ship this?");
      expect(prompt).not.toContain("answer-from-model");
    }

    const messages = store.messages.filter((m) => m.status === "done");
    expect(messages).toHaveLength(3);
    expect(new Set(messages.map((m) => m.content)).size).toBe(3);

    // The finisher adds the summary document with the cost line.
    const closed = await finalizeRoom(deps, room.id);
    expect(closed.status).toBe("completed");
    expect(models.calls).toHaveLength(4); // 3 participants + finisher
    expect(summaries.written).toHaveLength(1);
    expect(summaries.written[0].body).toMatch(/Room cost: \d+ tokens/);
    expect(closed.summaryDocumentKey).toBe(`exchange:${room.id}`);
  });

  it("the stop valve stops the room without new model calls", async () => {
    const room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "user",
      openerId: "owner-1",
      participants: PARTICIPANTS,
      prompt: "How should we ship this?",
      issueTitle: "OPE-4171",
    });
    const callsBeforeStop = models.calls.length;

    const stopped = await stopRoom(deps, {
      roomId: room.id,
      actorType: "user",
      actorId: "owner-1",
    });

    expect(stopped.status).toBe("stopped");
    expect(stopped.stopReason).toBe("owner_stop");
    expect(models.calls).toHaveLength(callsBeforeStop); // no finisher, nothing
    expect(summaries.written).toHaveLength(0);

    // A stopped room accepts no further rounds.
    await expect(runNextRound(deps, room.id, "Task: OPE-4171")).rejects.toMatchObject({ code: "room_closed" });
  });

  it("only the room owner may pull the stop valve", async () => {
    const room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "user",
      openerId: "owner-1",
      participants: PARTICIPANTS,
      prompt: "p",
      issueTitle: "t",
    });
    await expect(
      stopRoom(deps, { roomId: room.id, actorType: "user", actorId: "someone-else" }),
    ).rejects.toMatchObject({ code: "not_room_stopper" });
  });

  it("a disabled feature refuses to open a room before any model call", async () => {
    deps.settings = { ...deps.settings, enabled: false };
    await expect(
      openRoom(deps, {
        companyId: "company-1",
        issueId: "issue-1",
        openerType: "user",
        openerId: "owner-1",
        participants: PARTICIPANTS,
        prompt: "p",
        issueTitle: "t",
      }),
    ).rejects.toMatchObject({ code: "feature_disabled" });
    expect(models.calls).toHaveLength(0);
  });

  it("round 2 prompts quote the round-1 answers (only round 1 is independent)", async () => {
    const room = await openRoom(deps, {
      companyId: "company-1",
      issueId: "issue-1",
      openerType: "user",
      openerId: "owner-1",
      participants: PARTICIPANTS,
      prompt: "p",
      issueTitle: "t",
    });
    const callsAfterRound1 = models.calls.length;
    await runNextRound(deps, room.id, "Task: t\n\np");
    const roundTwoCalls = models.calls.slice(callsAfterRound1);
    expect(roundTwoCalls).toHaveLength(3);
    for (const call of roundTwoCalls) {
      const user = call.messages.find((m) => m.role === "user")?.content ?? "";
      expect(user).toContain("Round 1 answers:");
      expect(user).toContain("answer-from-model-a");
    }
  });
});
