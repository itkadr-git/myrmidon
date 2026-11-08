// server/src/myrmidon/agent-exchange/exchange-room.myrmidon.test.ts
//
// myrmidon(1.7 AGENT-EXCHANGE, OPE-12078): unit tests for exchange room
// domain types, schema validation, and lifecycle state operations.
//
// Acceptance criteria:
//  - Room with 2 to 4 participants creates successfully;
//  - Attempting to add a 5th participant throws an error;
//  - Stop valve flag immediately transitions status/state to "closed";
//  - CI green.

import { describe, expect, it } from "vitest";
import {
  addExchangeMessage,
  addParticipant,
  closeExchangeRoom,
  createExchangeRoom,
  ExchangeRoomError,
  ExchangeSchemaValidationError,
  finalizeExchangeRoom,
  MAX_EXCHANGE_PARTICIPANTS,
  MIN_EXCHANGE_PARTICIPANTS,
  pullStopValve,
  safeValidateExchangeMessage,
  safeValidateExchangeRoom,
  validateExchangeMessage,
  validateExchangeRoom,
  validateParticipants,
  type CreateExchangeRoomInput,
  type ExchangeRoom,
} from "./index.js";

const NOW = new Date("2026-11-07T12:00:00.000Z");
const fixedClock = () => NOW;

function baseRoomInput(overrides: Partial<CreateExchangeRoomInput> = {}): CreateExchangeRoomInput {
  return {
    id: "room-test-1",
    topic: "Best practices for multi-agent cache invalidation",
    participants: ["agent-alpha", "agent-beta"],
    cost_limit_cents: 500,
    ...overrides,
  };
}

describe("ExchangeRoom creation and participant count bounds", () => {
  it("creates a room with 2 participants (minimum bound)", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );

    expect(room.id).toBe("room-test-1");
    expect(room.topic).toBe("Best practices for multi-agent cache invalidation");
    expect(room.participants).toHaveLength(2);
    expect(room.participants.map((p) => p.agent_id)).toEqual(["agent-1", "agent-2"]);
    expect(room.cost_limit_cents).toBe(500);
    expect(room.state).toBe("open");
    expect(room.status).toBe("open");
    expect(room.stop_valve).toBe(false);
    expect(room.stop_reason).toBeNull();
    expect(room.closed_at).toBeNull();
  });

  it("creates a room with 3 participants", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2", "agent-3"] }),
      { clock: fixedClock },
    );

    expect(room.participants).toHaveLength(3);
    expect(room.participants.map((p) => p.agent_id)).toEqual(["agent-1", "agent-2", "agent-3"]);
    expect(room.state).toBe("open");
  });

  it("creates a room with 4 participants (maximum bound)", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2", "agent-3", "agent-4"] }),
      { clock: fixedClock },
    );

    expect(room.participants).toHaveLength(4);
    expect(room.participants.map((p) => p.agent_id)).toEqual([
      "agent-1",
      "agent-2",
      "agent-3",
      "agent-4",
    ]);
    expect(room.state).toBe("open");
  });

  it("fails when attempting to create a room with 5 participants", () => {
    expect(() =>
      createExchangeRoom(
        baseRoomInput({
          participants: ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"],
        }),
        { clock: fixedClock },
      ),
    ).toThrowError(ExchangeRoomError);

    try {
      createExchangeRoom(
        baseRoomInput({
          participants: ["agent-1", "agent-2", "agent-3", "agent-4", "agent-5"],
        }),
        { clock: fixedClock },
      );
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("too_many_participants");
      expect(error.message).toContain("maximum allowed is 4");
    }
  });

  it("fails when attempting to create a room with fewer than 2 participants", () => {
    expect(() =>
      createExchangeRoom(
        baseRoomInput({ participants: ["agent-1"] }),
        { clock: fixedClock },
      ),
    ).toThrowError(ExchangeRoomError);

    try {
      createExchangeRoom(
        baseRoomInput({ participants: ["agent-1"] }),
        { clock: fixedClock },
      );
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("too_few_participants");
      expect(error.message).toContain("at least 2 participants");
    }
  });

  it("rejects duplicate participants at creation", () => {
    expect(() =>
      createExchangeRoom(
        baseRoomInput({ participants: ["agent-1", "agent-1"] }),
        { clock: fixedClock },
      ),
    ).toThrowError(ExchangeRoomError);

    try {
      createExchangeRoom(
        baseRoomInput({ participants: ["agent-1", "agent-1"] }),
        { clock: fixedClock },
      );
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("duplicate_participant");
    }
  });

  it("supports participant objects with model and role labels", () => {
    const room = createExchangeRoom(
      baseRoomInput({
        participants: [
          { agent_id: "agent-1", model: "claude-3-5-sonnet", name: "Architect" },
          { agent_id: "agent-2", model: "gpt-4o", name: "Reviewer" },
        ],
      }),
      { clock: fixedClock },
    );

    expect(room.participants[0].model).toBe("claude-3-5-sonnet");
    expect(room.participants[0].name).toBe("Architect");
    expect(room.participants[1].model).toBe("gpt-4o");
    expect(room.participants[1].name).toBe("Reviewer");
  });
});

describe("addParticipant: 5th participant prevention and duplicates", () => {
  it("allows adding participants up to the ceiling of 4", () => {
    let room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );
    expect(room.participants).toHaveLength(2);

    room = addParticipant(room, "agent-3");
    expect(room.participants).toHaveLength(3);

    room = addParticipant(room, { agent_id: "agent-4", model: "test-model" });
    expect(room.participants).toHaveLength(4);
  });

  it("throws error when attempting to add a 5th participant to a 4-agent room", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2", "agent-3", "agent-4"] }),
      { clock: fixedClock },
    );
    expect(room.participants).toHaveLength(4);

    expect(() => addParticipant(room, "agent-5")).toThrowError(ExchangeRoomError);

    try {
      addParticipant(room, "agent-5");
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("too_many_participants");
      expect(error.message).toContain("maximum of 4 participants");
    }
  });

  it("rejects adding an agent that is already in the room", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );

    expect(() => addParticipant(room, "agent-1")).toThrowError(ExchangeRoomError);

    try {
      addParticipant(room, "agent-1");
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("duplicate_participant");
    }
  });

  it("rejects adding a participant when the room is already closed", () => {
    let room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );
    room = pullStopValve(room, "emergency stop test", { clock: fixedClock });

    expect(() => addParticipant(room, "agent-3")).toThrowError(ExchangeRoomError);

    try {
      addParticipant(room, "agent-3");
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("room_closed");
    }
  });
});

describe("Stop-valve (стоп-кран) flag and immediate transition to closed", () => {
  it("pulling stop valve immediately transitions open room to closed state", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );
    expect(room.state).toBe("open");
    expect(room.stop_valve).toBe(false);

    const stopped = pullStopValve(room, "cost threshold reached", { clock: fixedClock });

    expect(stopped.state).toBe("closed");
    expect(stopped.status).toBe("closed");
    expect(stopped.stop_valve).toBe(true);
    expect(stopped.stop_reason).toBe("cost threshold reached");
    expect(stopped.closed_at).toBe(NOW.toISOString());
  });

  it("pulling stop valve immediately transitions finalizing room to closed state", () => {
    let room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );
    room = finalizeExchangeRoom(room);
    expect(room.state).toBe("finalizing");

    const stopped = pullStopValve(room, "operator interrupted", { clock: fixedClock });

    expect(stopped.state).toBe("closed");
    expect(stopped.status).toBe("closed");
    expect(stopped.stop_valve).toBe(true);
    expect(stopped.stop_reason).toBe("operator interrupted");
  });

  it("creating a room with stop_valve=true immediately yields closed state", () => {
    const room = createExchangeRoom(
      baseRoomInput({
        participants: ["agent-1", "agent-2"],
        stop_valve: true,
        stop_reason: "pre_stopped",
      }),
      { clock: fixedClock },
    );

    expect(room.state).toBe("closed");
    expect(room.status).toBe("closed");
    expect(room.stop_valve).toBe(true);
    expect(room.stop_reason).toBe("pre_stopped");
    expect(room.closed_at).toBe(NOW.toISOString());
  });

  it("schema rejects a room where stop_valve is true but state is not closed", () => {
    const invalidRoom: ExchangeRoom = {
      id: "invalid-room",
      topic: "Invalid state room",
      participants: [{ agent_id: "agent-1" }, { agent_id: "agent-2" }],
      cost_limit_cents: 100,
      state: "open", // contradiction: stop_valve is true but state is open
      stop_valve: true,
      finisher: null,
      created_at: NOW.toISOString(),
    };

    expect(() => validateExchangeRoom(invalidRoom)).toThrowError(
      ExchangeSchemaValidationError,
    );

    const safeResult = safeValidateExchangeRoom(invalidRoom);
    expect(safeResult.success).toBe(false);
  });
});

describe("Finisher and exchange messages", () => {
  it("configures a dedicated finisher synthesizer", () => {
    const room = createExchangeRoom(
      baseRoomInput({
        participants: ["agent-1", "agent-2"],
        finisher: {
          agent_id: "finisher-agent",
          model: "gpt-4o",
          prompt: "Synthesize consensus and extract actionable rules.",
        },
      }),
      { clock: fixedClock },
    );

    expect(room.finisher).not.toBeNull();
    expect(room.finisher?.agent_id).toBe("finisher-agent");
    expect(room.finisher?.model).toBe("gpt-4o");
    expect(room.finisher?.prompt).toContain("Synthesize consensus");
  });

  it("records messages from registered participants and accumulates tokens", () => {
    let room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );

    const step1 = addExchangeMessage(
      room,
      {
        agent_id: "agent-1",
        content: "Here is my perspective on the distributed cache invalidation pattern.",
        tokens_used: 150,
        round: 0,
      },
      { clock: fixedClock },
    );
    room = step1.room;

    expect(step1.message.agent_id).toBe("agent-1");
    expect(step1.message.tokens_used).toBe(150);
    expect(room.total_tokens).toBe(150);
    expect(room.messages).toHaveLength(1);

    const step2 = addExchangeMessage(
      room,
      {
        agent_id: "agent-2",
        content: "I agree with step 1, but we must account for network partitions.",
        tokens_used: 200,
        round: 0,
      },
      { clock: fixedClock },
    );
    room = step2.room;

    expect(room.total_tokens).toBe(350);
    expect(room.messages).toHaveLength(2);
  });

  it("rejects message from an unregistered agent", () => {
    const room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );

    expect(() =>
      addExchangeMessage(room, {
        agent_id: "intruder-agent",
        content: "Spam content",
        tokens_used: 50,
      }),
    ).toThrowError(ExchangeRoomError);

    try {
      addExchangeMessage(room, {
        agent_id: "intruder-agent",
        content: "Spam content",
        tokens_used: 50,
      });
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("unknown_participant");
    }
  });

  it("rejects message addition when room is closed", () => {
    let room = createExchangeRoom(
      baseRoomInput({ participants: ["agent-1", "agent-2"] }),
      { clock: fixedClock },
    );
    room = closeExchangeRoom(room, "discussion finished", { clock: fixedClock });

    expect(() =>
      addExchangeMessage(room, {
        agent_id: "agent-1",
        content: "Too late",
        tokens_used: 10,
      }),
    ).toThrowError(ExchangeRoomError);

    try {
      addExchangeMessage(room, {
        agent_id: "agent-1",
        content: "Too late",
        tokens_used: 10,
      });
    } catch (err: unknown) {
      const error = err as ExchangeRoomError;
      expect(error.code).toBe("room_closed");
    }
  });

  it("auto-triggers stop valve when cost exceeds cost_limit_cents", () => {
    const room = createExchangeRoom(
      baseRoomInput({
        participants: ["agent-1", "agent-2"],
        cost_limit_cents: 100,
      }),
      { clock: fixedClock },
    );

    const step = addExchangeMessage(
      room,
      {
        agent_id: "agent-1",
        content: "A very costly reply",
        tokens_used: 5000,
        cost_cents: 120, // exceeds 100 cents limit
      },
      { clock: fixedClock },
    );

    expect(step.room.state).toBe("closed");
    expect(step.room.stop_valve).toBe(true);
    expect(step.room.stop_reason).toBe("cost_limit_exceeded");
  });
});

describe("Schema parsing and validation helpers", () => {
  it("validates valid message shapes and rejects invalid ones", () => {
    const valid = validateExchangeMessage({
      agent_id: "agent-alpha",
      content: "Valid insight",
      tokens_used: 42,
    });
    expect(valid.agent_id).toBe("agent-alpha");
    expect(valid.tokens_used).toBe(42);

    expect(() =>
      validateExchangeMessage({
        content: "Missing agent_id",
        tokens_used: 10,
      }),
    ).toThrowError(ExchangeSchemaValidationError);

    expect(() =>
      validateExchangeMessage({
        agent_id: "agent-1",
        content: "Negative tokens",
        tokens_used: -5,
      }),
    ).toThrowError(ExchangeSchemaValidationError);

    const safeFail = safeValidateExchangeMessage({
      content: "Missing agent_id",
    });
    expect(safeFail.success).toBe(false);
  });

  it("validateParticipants helper checks bounds", () => {
    const ok2 = validateParticipants(["agent-1", "agent-2"]);
    expect(ok2.problem).toBeNull();
    expect(ok2.participants).toHaveLength(2);

    const ok4 = validateParticipants(["agent-1", "agent-2", "agent-3", "agent-4"]);
    expect(ok4.problem).toBeNull();
    expect(ok4.participants).toHaveLength(4);

    const tooFew = validateParticipants(["agent-1"]);
    expect(tooFew.participants).toBeNull();
    expect(tooFew.problem).toContain("at least 2");

    const tooMany = validateParticipants(["a1", "a2", "a3", "a4", "a5"]);
    expect(tooMany.participants).toBeNull();
    expect(tooMany.problem).toContain("cannot have more than 4");

    const dupes = validateParticipants(["a1", "a1"]);
    expect(dupes.participants).toBeNull();
    expect(dupes.problem).toContain("unique");
  });
});
