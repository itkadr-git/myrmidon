// myrmidon(1.6-AUTONOMY): execution of a held action after approval.
//
// Covers the acceptance criteria: an approved hold runs the action once; a
// rejected (or not-yet-approved) hold runs nothing; a second approval does not
// run the action again. The database is faked so the claim rule can be observed
// directly, and the executors are injected so a "pause" is a spy, not an agent.

import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { toolActionRequests, toolInvocations } from "@paperclipai/db";
import {
  AUTONOMY_DESCRIPTOR_KEY,
  executeApprovedAutonomyAction,
  isAutonomyToolName,
  readAutonomyDescriptor,
  replayHeldAutonomyAction,
  targetAgentId,
  type AutonomyActionDescriptor,
} from "./action-execution.js";

const descriptor: AutonomyActionDescriptor = {
  actionClass: "pause_wake_agents",
  route: "/agents/agent-1/pause",
  method: "POST",
};

interface Row {
  [key: string]: unknown;
}

/** A db that answers the two chains this module uses and records updates. */
function fakeDb(request: Row, invocation: Row) {
  const state: { request: Row; invocation: Row } = {
    request: { id: "req-1", invocationId: "inv-1", status: "approved", ...request },
    invocation: { id: "inv-1", ...invocation },
  };
  const apply = (table: unknown, values: Row): Row[] => {
    if (table === toolActionRequests) state.request = { ...state.request, ...values };
    else state.invocation = { ...state.invocation, ...values };
    return [];
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => [{ ...(table === toolActionRequests ? state.request : state.invocation) }],
        }),
      }),
    }),
    update: (table: unknown) => ({
      set: (values: Row) => ({
        where: () => ({
          // The claim asks for the flipped row; a plain update is just awaited.
          returning: async () => {
            if (table === toolActionRequests && values.status === "executing") {
              if (state.request.status !== "approved") return [];
              state.request = { ...state.request, ...values };
              return [{ id: state.request.id }];
            }
            return apply(table, values);
          },
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(apply(table, values)).then(resolve, reject),
        }),
      }),
    }),
  };
  return { db: db as unknown as Db, state };
}

const heldInvocation = {
  toolName: "autonomy_action_pause_wake_agents",
  actorType: "agent",
  actorId: "agent-1",
  policyExplanation: { [AUTONOMY_DESCRIPTOR_KEY]: descriptor },
};

function executors() {
  const paused: string[] = [];
  const resumed: string[] = [];
  const woken: string[] = [];
  return {
    paused,
    resumed,
    woken,
    factory: () => ({
      pause: vi.fn(async (agentId: string) => {
        paused.push(agentId);
      }),
      resume: vi.fn(async (agentId: string) => {
        resumed.push(agentId);
      }),
      wakeup: vi.fn(async (agentId: string) => {
        woken.push(agentId);
      }),
    }),
  };
}

describe("executeApprovedAutonomyAction", () => {
  it("runs an approved held pause exactly once and settles both rows", async () => {
    const { db, state } = fakeDb({}, heldInvocation);
    const exec = executors();

    const outcome = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: exec.factory,
    });

    expect(outcome).toBe("executed");
    expect(exec.paused).toEqual(["agent-1"]);
    expect(state.request.status).toBe("executed");
    expect(state.invocation.status).toBe("succeeded");
    expect(state.request.decidedByUserId).toBe("user-1");
  });

  it("runs nothing when the hold was rejected", async () => {
    const { db, state } = fakeDb({ status: "rejected" }, heldInvocation);
    const exec = executors();

    const outcome = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: exec.factory,
    });

    expect(outcome).toBe("skipped");
    expect(exec.paused).toEqual([]);
    expect(state.request.status).toBe("rejected");
    expect(state.invocation.status).toBeUndefined();
  });

  it("does not run the action a second time on a repeated approval", async () => {
    const { db, state } = fakeDb({}, heldInvocation);
    const exec = executors();

    const first = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: exec.factory,
    });
    const second = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: exec.factory,
    });

    expect(first).toBe("executed");
    expect(second).toBe("skipped");
    expect(exec.paused).toEqual(["agent-1"]);
    expect(state.request.status).toBe("executed");
  });

  it("marks the hold failed when the action itself fails, without retrying", async () => {
    const { db, state } = fakeDb({}, heldInvocation);
    const factory = () => ({
      pause: vi.fn(async () => {
        throw new Error("pause blew up");
      }),
      resume: vi.fn(),
      wakeup: vi.fn(),
    });

    const outcome = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: factory,
    });

    expect(outcome).toBe("failed");
    expect(state.request.status).toBe("failed");
    expect(state.invocation.status).toBe("failed");
    expect(state.invocation.errorMessage).toBe("pause blew up");
  });

  it("ignores a request whose invocation is not a held autonomy action", async () => {
    const { db } = fakeDb({}, { toolName: "some_other_tool" });
    const exec = executors();

    const outcome = await executeApprovedAutonomyAction({
      db,
      actionRequestId: "req-1",
      approvedBy: { userId: "user-1" },
      executors: exec.factory,
    });

    expect(outcome).toBe("skipped");
    expect(exec.paused).toEqual([]);
  });
});

describe("replayHeldAutonomyAction", () => {
  it("runs an approved hold and reports `not_autonomy` for an ordinary tool", async () => {
    const held = fakeDb({}, heldInvocation);
    const exec = executors();
    expect(
      await replayHeldAutonomyAction({
        db: held.db,
        actionRequestId: "req-1",
        approvedBy: { userId: "user-1" },
        executors: exec.factory,
      }),
    ).toBe("executed");
    expect(exec.paused).toEqual(["agent-1"]);

    const plain = fakeDb({}, { toolName: "some_other_tool" });
    const plainExec = executors();
    expect(
      await replayHeldAutonomyAction({
        db: plain.db,
        actionRequestId: "req-1",
        approvedBy: { userId: "user-1" },
        executors: plainExec.factory,
      }),
    ).toBe("not_autonomy");
    expect(plainExec.paused).toEqual([]);
  });

  it("stays out of the way when the hold is not approved yet", async () => {
    const { db } = fakeDb({ status: "executing" }, heldInvocation);
    const exec = executors();
    expect(
      await replayHeldAutonomyAction({
        db,
        actionRequestId: "req-1",
        approvedBy: { userId: "user-1" },
        executors: exec.factory,
      }),
    ).toBe("skipped");
    expect(exec.paused).toEqual([]);
  });
});

describe("autonomy descriptor helpers", () => {
  it("recognises only autonomy action tool names", () => {
    expect(isAutonomyToolName("autonomy_action_pause_wake_agents")).toBe(true);
    expect(isAutonomyToolName("autonomy_actions")).toBe(false);
    expect(isAutonomyToolName(null)).toBe(false);
  });

  it("reads back the descriptor and the targeted agent", () => {
    const read = readAutonomyDescriptor({ [AUTONOMY_DESCRIPTOR_KEY]: descriptor });
    expect(read).toEqual({ ...descriptor, params: null, body: null });
    expect(targetAgentId(descriptor)).toBe("agent-1");
    expect(targetAgentId({ ...descriptor, params: { agentId: "explicit" } })).toBe("explicit");
    expect(readAutonomyDescriptor({})).toBeNull();
  });
});