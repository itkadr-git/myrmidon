// myrmidon(EMPTY-RUNS-1): a run that only hands its task back to the queue is
// not progress. The 13.11 loop of the service bots: a bot took its own `todo`
// task (the checkout moved it to `in_progress`), wrote "no new data, leaving it
// in todo" and PATCHed the task back to `todo`. The PATCH and the note both
// counted as issue-visible progress, so the no-progress streak never started:
// 176 such pickups on ten tasks in eight hours.
import { describe, expect, it } from "vitest";
import {
  collectRunIdsWithIssueProgress,
  evaluateIssueRewakeThrottle,
  isIssueProgressActivity,
  isReturnToQueue,
} from "../services/issue-rewake-throttle.ts";

const AGENT = "agent-dba";
const OTHER = "agent-other";
const NOW = new Date("2026-11-13T08:00:00.000Z");

/** The `changes` of the PATCH a run writes when it puts its task back: field set as logged on the live board. */
function handBackChanges(runId: string, extra: Record<string, unknown> = {}) {
  return {
    status: { from: "in_progress", to: "todo" },
    statusVersion: { from: 133, to: 134 },
    checkoutRunId: { from: runId, to: null },
    executionRunId: { from: runId, to: null },
    executionLockedAt: { from: "2026-11-13T07:22:23.472Z", to: null },
    executionAgentNameKey: { from: "adm-dba", to: null },
    ...extra,
  };
}

const handBack = (runId: string, extra: Record<string, unknown> = {}) => ({
  runId,
  action: "issue.updated",
  source: "comment",
  changes: handBackChanges(runId, extra),
});
const parkingNote = (runId: string) => ({ runId, action: "issue.comment_added", source: null });
const echo = (runId: string) => ({
  runId,
  action: "issue.comment_added",
  source: "run_presentation_resolver",
});

function succeededRuns(ids: string[]) {
  // Newest first, two minutes apart; the newest finished a minute ago.
  return ids.map((id, i) => ({
    id,
    status: "succeeded",
    errorCode: null,
    finishedAt: new Date(NOW.getTime() - (60 + i * 120) * 1000),
  }));
}

describe("isReturnToQueue", () => {
  it("recognises the hand-back PATCH: in_progress -> todo with only the execution lock and assignment bookkeeping", () => {
    expect(isReturnToQueue(handBack("r1"), AGENT)).toBe(true);
    expect(isReturnToQueue(handBack("r1", { responsibleUserId: { from: "u1", to: null } }), AGENT)).toBe(true);
    // re-assigning the task to itself in the same PATCH is still bookkeeping
    expect(isReturnToQueue(handBack("r1", { assigneeAgentId: { from: null, to: AGENT } }), AGENT)).toBe(true);
    // the driver may hand the json path back as text
    expect(
      isReturnToQueue({ action: "issue.updated", changes: JSON.stringify(handBackChanges("r1")) }, AGENT),
    ).toBe(true);
  });

  it("does not cover any other status move", () => {
    const move = (from: string, to: string) => ({
      action: "issue.updated",
      changes: { status: { from, to }, statusVersion: { from: 1, to: 2 } },
    });
    expect(isReturnToQueue(move("blocked", "todo"), AGENT)).toBe(false);
    expect(isReturnToQueue(move("backlog", "todo"), AGENT)).toBe(false);
    expect(isReturnToQueue(move("in_review", "todo"), AGENT)).toBe(false);
    expect(isReturnToQueue(move("in_progress", "in_review"), AGENT)).toBe(false);
    expect(isReturnToQueue(move("in_progress", "blocked"), AGENT)).toBe(false);
    expect(isReturnToQueue(move("todo", "in_progress"), AGENT)).toBe(false);
  });

  it("does not cover a hand-back that changes anything real with it", () => {
    // a hand-over to another agent
    expect(isReturnToQueue(handBack("r1", { assigneeAgentId: { from: AGENT, to: OTHER } }), AGENT)).toBe(false);
    // giving the task up to the pool is not this rule's business either
    expect(isReturnToQueue(handBack("r1", { assigneeAgentId: { from: AGENT, to: null } }), AGENT)).toBe(false);
    // any other field next to the status
    expect(isReturnToQueue(handBack("r1", { title: { from: "a", to: "b" } }), AGENT)).toBe(false);
    expect(isReturnToQueue(handBack("r1", { executionState: { from: null, to: { status: "pending" } } }), AGENT)).toBe(false);
    expect(isReturnToQueue(handBack("r1", { blockedByIssueIds: { from: [], to: ["i-2"] } }), AGENT)).toBe(false);
  });

  it("reads nothing into rows it cannot read", () => {
    expect(isReturnToQueue({ action: "issue.updated" }, AGENT)).toBe(false);
    expect(isReturnToQueue({ action: "issue.updated", changes: "not json" }, AGENT)).toBe(false);
    expect(isReturnToQueue({ action: "issue.updated", changes: { status: "todo" } }, AGENT)).toBe(false);
    expect(isReturnToQueue({ action: "issue.comment_added", changes: handBackChanges("r1") }, AGENT)).toBe(false);
  });
});

describe("isIssueProgressActivity and the hand-back", () => {
  it("does not count the hand-back PATCH as progress", () => {
    expect(isIssueProgressActivity(handBack("r1"), AGENT)).toBe(false);
  });

  it("still counts the status moves that change the task", () => {
    expect(isIssueProgressActivity({
      action: "issue.updated", changes: { status: { from: "in_progress", to: "in_review" } },
    }, AGENT)).toBe(true);
    expect(isIssueProgressActivity({
      action: "issue.updated", changes: { status: { from: "blocked", to: "todo" } },
    }, AGENT)).toBe(true);
    expect(isIssueProgressActivity(handBack("r1", { assigneeAgentId: { from: AGENT, to: OTHER } }), AGENT)).toBe(true);
    expect(isIssueProgressActivity(handBack("r1", { title: { from: "a", to: "b" } }), AGENT)).toBe(true);
  });
});

describe("collectRunIdsWithIssueProgress", () => {
  const sameAgent = () => AGENT;

  it("a run that handed the task back and left only its note made no progress", () => {
    const rows = [handBack("r1"), parkingNote("r1")];
    expect(collectRunIdsWithIssueProgress(rows, sameAgent).size).toBe(0);
    // whatever the order the rows come back in
    expect(collectRunIdsWithIssueProgress([parkingNote("r1"), handBack("r1")], sameAgent).size).toBe(0);
  });

  it("a comment of a run that did not hand the task back is progress, as before", () => {
    expect([...collectRunIdsWithIssueProgress([parkingNote("r1")], sameAgent)]).toEqual(["r1"]);
    // the note of one run does not lose its weight because another run handed the task back
    expect(
      [...collectRunIdsWithIssueProgress([parkingNote("r1"), handBack("r2"), parkingNote("r2")], sameAgent)],
    ).toEqual(["r1"]);
  });

  it("a run that handed the task back but left something durable made progress", () => {
    for (const action of [
      "issue.document_updated",
      "issue.work_product_created",
      "issue.child_created",
      "issue.blockers_updated",
      "issue.thread_interaction_created",
      "issue.monitor_scheduled",
    ]) {
      const rows = [handBack("r1"), parkingNote("r1"), { runId: "r1", action }];
      expect([...collectRunIdsWithIssueProgress(rows, sameAgent)]).toEqual(["r1"]);
    }
    // a real status move in the same run (sent to review, then nothing else)
    const reviewed = [
      { runId: "r1", action: "issue.updated", changes: { status: { from: "in_progress", to: "in_review" } } },
      parkingNote("r1"),
    ];
    expect([...collectRunIdsWithIssueProgress(reviewed, sameAgent)]).toEqual(["r1"]);
  });

  it("keeps the earlier own-bookkeeping rules: echo, release, self re-assignment", () => {
    const rows = [
      echo("r1"),
      { runId: "r1", action: "issue.released" },
      {
        runId: "r1",
        action: "issue.updated",
        changes: { assigneeAgentId: { from: null, to: AGENT } },
      },
    ];
    expect(collectRunIdsWithIssueProgress(rows, sameAgent).size).toBe(0);
  });

  it("resolves the agent per run and ignores rows without a run", () => {
    const selfAssign = (runId: string | null, to: string) => ({
      runId,
      action: "issue.updated",
      changes: { assigneeAgentId: { from: null, to } },
    });
    const byRun = (runId: string) => (runId === "r1" ? AGENT : OTHER);
    // r1 belongs to AGENT: assigning to AGENT is self-bookkeeping; r2 belongs
    // to OTHER: the same assignment is a hand-over to somebody else.
    expect(
      [...collectRunIdsWithIssueProgress([selfAssign("r1", AGENT), selfAssign("r2", AGENT)], byRun)],
    ).toEqual(["r2"]);
    expect(collectRunIdsWithIssueProgress([selfAssign(null, OTHER), { runId: null, action: "issue.comment_added" }], byRun).size).toBe(0);
  });
});

describe("rewake throttle on the parked-task loop", () => {
  it("starts the streak on runs that only handed the task back with a note", () => {
    const ids = ["r0", "r1", "r2"];
    const rows = ids.flatMap((id) => [handBack(id), parkingNote(id), echo(id)]);
    const withProgress = collectRunIdsWithIssueProgress(rows, () => AGENT);
    expect(withProgress.size).toBe(0);
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: succeededRuns(ids),
      runIdsWithIssueProgress: withProgress,
      hasNewIssueInputSinceLastRun: false,
    })).toMatchObject({ blocked: true, frozen: false, noProgressStreak: 3 });
  });

  it("freezes the task after six such runs in a row", () => {
    const ids = ["r0", "r1", "r2", "r3", "r4", "r5"];
    const rows = ids.flatMap((id) => [handBack(id), parkingNote(id)]);
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: succeededRuns(ids),
      runIdsWithIssueProgress: collectRunIdsWithIssueProgress(rows, () => AGENT),
      hasNewIssueInputSinceLastRun: false,
    })).toMatchObject({ blocked: true, frozen: true, noProgressStreak: 6 });
  });

  it("a run with real progress in front of the parked ones ends the streak", () => {
    const ids = ["r0", "r1", "r2"];
    const rows = [
      { runId: "r0", action: "issue.updated", changes: { status: { from: "in_progress", to: "in_review" } } },
      handBack("r1"), parkingNote("r1"),
      handBack("r2"), parkingNote("r2"),
    ];
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: succeededRuns(ids),
      runIdsWithIssueProgress: collectRunIdsWithIssueProgress(rows, () => AGENT),
      hasNewIssueInputSinceLastRun: false,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("new input after the last run still lifts the throttle", () => {
    const ids = ["r0", "r1", "r2"];
    const rows = ids.flatMap((id) => [handBack(id), parkingNote(id)]);
    expect(evaluateIssueRewakeThrottle({
      now: NOW,
      recentTerminalRuns: succeededRuns(ids),
      runIdsWithIssueProgress: collectRunIdsWithIssueProgress(rows, () => AGENT),
      hasNewIssueInputSinceLastRun: true,
    })).toEqual({ blocked: false, noProgressStreak: 0 });
  });
});
