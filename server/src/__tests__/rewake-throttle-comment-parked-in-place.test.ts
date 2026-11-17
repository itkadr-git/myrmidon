// myrmidon(OPE-14746): a run that parks its task in place with nothing but its
// own comment is not progress for the rewake throttle. The 17.11 loop of the
// engineers: an engineer run answered a review/continuation wake with "CI red
// on an unrelated check, asked ADM to restart", wrote that as the task comment
// and changed nothing else. The comment counted as issue-visible progress, so
// the no-progress streak never started: automatic `issue_continuation_needed`
// wakes re-ran the same parked task every minute, and 32 of 38 empty engineer
// runs in two hours sat in such repeat series (rc.13 window).
import { describe, expect, it } from "vitest";
import {
  collectRunIdsWithIssueProgress,
  evaluateIssueRewakeThrottle,
} from "../services/issue-rewake-throttle.ts";

const AGENT = "agent-eng";
const NOW = new Date("2026-11-17T03:00:00.000Z");

const note = (runId: string) => ({ runId, action: "issue.comment_added", source: null });

function succeededRuns(ids: string[]) {
  // Newest first, one minute apart; the newest finished a minute ago.
  return ids.map((id, i) => ({
    id,
    status: "succeeded",
    errorCode: null,
    finishedAt: new Date(NOW.getTime() - (60 + i * 60) * 1000),
  }));
}

function throttle(
  ids: string[],
  rows: ReturnType<typeof note>[],
  nonComment?: Set<string>,
) {
  return evaluateIssueRewakeThrottle({
    now: NOW,
    recentTerminalRuns: succeededRuns(ids),
    runIdsWithIssueProgress: collectRunIdsWithIssueProgress(rows, () => AGENT),
    runIdsWithNonCommentProgress: nonComment,
    hasNewIssueInputSinceLastRun: false,
  });
}

describe("rewake throttle on comment-only parked runs (OPE-14746)", () => {
  it("without the non-comment set the legacy behaviour still counts a lone comment as progress", () => {
    const decision = throttle(["r0", "r1"], [note("r0"), note("r1")]);
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("comment-only runs build a no-progress streak once the non-comment set is given", () => {
    const rows = [note("r0"), note("r1"), note("r2")];
    const nonComment = collectRunIdsWithIssueProgress(
      rows.filter((row) => row.action !== "issue.comment_added"),
      () => AGENT,
    );
    const decision = throttle(["r0", "r1", "r2"], rows, nonComment);
    expect(decision).toMatchObject({ blocked: true, frozen: false, noProgressStreak: 3 });
  });

  it("a run that left something durable next to its note still ends the streak", () => {
    const rows = [
      { runId: "r0", action: "issue.document_updated" },
      note("r0"),
      note("r1"),
      note("r2"),
    ];
    const nonComment = collectRunIdsWithIssueProgress(
      rows.filter((row) => row.action !== "issue.comment_added"),
      () => AGENT,
    );
    const decision = throttle(["r0", "r1", "r2"], rows, nonComment);
    expect(decision).toEqual({ blocked: false, noProgressStreak: 0 });
  });

  it("a lone comment run is still full progress for other readers", () => {
    // The cooling guard and the rest of the board keep the EMPTY-RUNS-1
    // contract: a comment of a run that did not hand the task back is progress.
    expect([...collectRunIdsWithIssueProgress([note("r1")], () => AGENT)]).toEqual(["r1"]);
  });
});
