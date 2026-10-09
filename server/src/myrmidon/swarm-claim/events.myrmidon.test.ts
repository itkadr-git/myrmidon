// myrmidon(1.6.5 OPE-6608, review items 2 and 10): the event hooks of the board
// matcher — what counts as "a task became available", that a failing matcher
// never reaches the caller, that a resume frees the agent for the matcher, and
// that turning the swarm off stops matching at once (no restart).

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueEventMakesTaskAvailable,
  notifySwarmAgentEvent,
  notifySwarmIssueEvent,
  setSwarmEventSink,
} from "./events.js";
import { buildSwarmMatcher } from "./matcher-factory.js";

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

afterEach(() => setSwarmEventSink(null));

describe("issueEventMakesTaskAvailable", () => {
  it("a created ready ownerless task is available", () => {
    expect(issueEventMakesTaskAvailable({ issueId: "i", status: "todo", assigneeAgentId: null, created: true })).toBe(true);
  });
  it("an owned or not-ready task is not", () => {
    expect(issueEventMakesTaskAvailable({ issueId: "i", status: "todo", assigneeAgentId: "a", created: true })).toBe(false);
    expect(issueEventMakesTaskAvailable({ issueId: "i", status: "backlog", assigneeAgentId: null, created: true })).toBe(false);
    expect(issueEventMakesTaskAvailable({ issueId: "i", status: "in_progress", assigneeAgentId: null, created: true })).toBe(false);
  });
  it("an update counts only when it touched an availability field", () => {
    const base = { issueId: "i", status: "todo", assigneeAgentId: null } as const;
    expect(issueEventMakesTaskAvailable({ ...base, touched: ["title", "description"] })).toBe(false);
    expect(issueEventMakesTaskAvailable({ ...base, touched: ["assigneeAgentId"] })).toBe(true);
    expect(issueEventMakesTaskAvailable({ ...base, touched: ["status"] })).toBe(true);
    expect(issueEventMakesTaskAvailable({ ...base, touched: ["labelIds"] })).toBe(true);
    expect(issueEventMakesTaskAvailable({ ...base, touched: ["blockedByIssueIds"] })).toBe(true);
  });
});

describe("notify hooks", () => {
  it("an available task reaches forIssue; an unavailable one does not", async () => {
    const forIssue = vi.fn(async () => null);
    setSwarmEventSink({ forIssue, forAgent: vi.fn(async () => null) });
    notifySwarmIssueEvent({ issueId: "i-1", status: "todo", assigneeAgentId: null, created: true });
    notifySwarmIssueEvent({ issueId: "i-2", status: "todo", assigneeAgentId: "a", created: true });
    await flush();
    expect(forIssue.mock.calls).toEqual([["i-1"]]);
  });

  it("a lifted pause reaches forAgent", async () => {
    const forAgent = vi.fn(async () => null);
    setSwarmEventSink({ forIssue: vi.fn(async () => null), forAgent });
    notifySwarmAgentEvent("agent-1");
    await flush();
    expect(forAgent.mock.calls).toEqual([["agent-1"]]);
  });

  it("a matcher that throws or rejects never reaches the caller", async () => {
    setSwarmEventSink({
      forIssue: () => {
        throw new Error("sync boom");
      },
      forAgent: async () => {
        throw new Error("async boom");
      },
    });
    expect(() =>
      notifySwarmIssueEvent({ issueId: "i", status: "todo", assigneeAgentId: null, created: true }),
    ).not.toThrow();
    expect(() => notifySwarmAgentEvent("a")).not.toThrow();
    await flush();
  });

  it("a write inside the caller's transaction is paired after the deferral, not before", async () => {
    vi.useFakeTimers();
    try {
      const forIssue = vi.fn(async () => null);
      setSwarmEventSink({ forIssue, forAgent: vi.fn(async () => null) });
      notifySwarmIssueEvent(
        { issueId: "i", status: "todo", assigneeAgentId: null, created: true },
        { deferMs: 1000 },
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(forIssue).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(600);
      expect(forIssue).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("with no sink the hooks do nothing", async () => {
    setSwarmEventSink(null);
    expect(() => notifySwarmIssueEvent({ issueId: "i", status: "todo", assigneeAgentId: null, created: true })).not.toThrow();
    expect(() => notifySwarmAgentEvent("a")).not.toThrow();
  });
});

describe("the switch is read per event (no restart)", () => {
  // A db that fails the test on any access: a swarm that is off must not even read.
  const untouchedDb = new Proxy(
    {},
    {
      get() {
        throw new Error("the matcher touched the database while the swarm was off");
      },
    },
  ) as never;

  it("the matcher disappears the moment the setting flips, and comes back with it", async () => {
    let enabled = true;
    const ports = {
      db: untouchedDb,
      settings: { getGeneral: async () => ({ swarm: { enabled } }) as never },
      env: {},
    };
    expect(await buildSwarmMatcher(ports)).not.toBeNull();
    enabled = false; // the operator's PATCH
    expect(await buildSwarmMatcher(ports)).toBeNull();
    enabled = true;
    expect(await buildSwarmMatcher(ports)).not.toBeNull();
  });

  it("an event path built on that switch pairs nothing and reads nothing while it is off", async () => {
    let enabled = true;
    const ports = {
      db: untouchedDb,
      settings: { getGeneral: async () => ({ swarm: { enabled } }) as never },
      env: {},
    };
    const sink = {
      forIssue: async (issueId: string) => (await buildSwarmMatcher(ports))?.forIssue(issueId) ?? null,
      forAgent: async (agentId: string) => (await buildSwarmMatcher(ports))?.forAgent(agentId) ?? null,
    };
    enabled = false;
    await expect(sink.forIssue("i")).resolves.toBeNull();
    await expect(sink.forAgent("a")).resolves.toBeNull();
  });
});
