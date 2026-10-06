// myrmidon(REVIEW-REWORK): the pure decision table — every transition the
// loop makes and refuses. These are the acceptance criteria of the task:
// RETURN -> rework task + blocked review; new head -> todo + reviewer wake;
// merged/closed PR -> review closed; plus the reopening and the no-wake rules.

import { describe, expect, it } from "vitest";
import {
  buildExecutorLadder,
  collectHeadAcks,
  decodeReworkFingerprint,
  decideReviewRework,
  encodeReworkFingerprint,
  outstandingReturnVerdict,
  reviewReworkPrKey,
  type ReviewReworkChildFacts,
  type ReviewReworkFacts,
  type ReviewReworkPrFact,
  type ReviewReworkTaskFacts,
} from "./domain.js";

const NOW = "2026-10-05T09:00:00.000Z";
const VERDICT_AT = "2026-10-04T16:57:32.000Z";

function task(overrides: Partial<ReviewReworkTaskFacts> = {}): ReviewReworkTaskFacts {
  return {
    id: "review-1",
    companyId: "company-1",
    identifier: "OPE-4417",
    title: "Review PR #484",
    status: "todo",
    assigneeAgentId: "reviewer-agent",
    assigneeUserId: null,
    projectId: null,
    goalId: null,
    billingCode: null,
    priority: "high",
    returnAssigneeAgentId: "author-agent",
    ...overrides,
  };
}

function pr(overrides: Partial<ReviewReworkPrFact> = {}): ReviewReworkPrFact {
  return {
    prKey: "acme/repo#484",
    repo: "acme/repo",
    number: 484,
    state: "open",
    headSha: "da3364a2973ee31f0db15e9f5d6492f91880786c",
    reviewDecision: null,
    updatedAt: null,
    ...overrides,
  };
}

function child(overrides: Partial<ReviewReworkChildFacts> = {}): ReviewReworkChildFacts {
  return {
    id: "rework-1",
    identifier: "OPE-4502",
    status: "todo",
    assigneeAgentId: "author-agent",
    prKey: "acme/repo#484",
    baselineHeadSha: "da3364a2973ee31f0db15e9f5d6492f91880786c",
    ...overrides,
  };
}

function returnComment() {
  return {
    id: "verdict-comment",
    body: `VERDICT #484: RETURN (head da3364a2973ee31f0db15e9f5d6492f91880786c)\n\nБлокеры: двойной счёт.`,
    createdAt: VERDICT_AT,
  };
}

function facts(overrides: Partial<ReviewReworkFacts> = {}): ReviewReworkFacts {
  return {
    task: task(),
    prs: [pr()],
    comments: [returnComment()],
    child: null,
    deliveringTaskAssigneeAgentId: "deliverer-agent",
    fallbackAssigneeAgentId: null,
    ...overrides,
  };
}

describe("review rework decision table", () => {
  it("RETURN with no rework task opens one and the ladder puts the PR author first", () => {
    const decision = decideReviewRework(facts());
    expect(decision.kind).toBe("create_rework");
    if (decision.kind !== "create_rework") return;
    expect(decision.prKey).toBe("acme/repo#484");
    expect(decision.headSha).toBe("da3364a2973ee31f0db15e9f5d6492f91880786c");
    expect(decision.verdict.commentId).toBe("verdict-comment");
    expect(decision.executorLadder.map((entry) => entry.source)).toEqual([
      "return_assignee",
      "delivering_task",
    ]);
    expect(decision.executorLadder[0]!.agentId).toBe("author-agent");
  });

  it("an empty ladder (nobody named) still creates — the role queue claims it", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ returnAssigneeAgentId: null }),
        deliveringTaskAssigneeAgentId: null,
      }),
    );
    expect(decision.kind).toBe("create_rework");
    if (decision.kind !== "create_rework") return;
    expect(decision.executorLadder).toEqual([]);
  });

  it("the GitHub CHANGES_REQUESTED decision opens the loop without any comment", () => {
    const decision = decideReviewRework(
      facts({
        comments: [],
        prs: [pr({ reviewDecision: "CHANGES_REQUESTED", updatedAt: VERDICT_AT })],
      }),
    );
    expect(decision.kind).toBe("create_rework");
    if (decision.kind !== "create_rework") return;
    expect(decision.verdict.source).toBe("github_review");
  });

  it("an active rework task with a todo review re-asserts the block, never a second task", () => {
    const decision = decideReviewRework(facts({ child: child() }));
    expect(decision.kind).toBe("ensure_blocked");
    if (decision.kind === "ensure_blocked") expect(decision.child.id).toBe("rework-1");
  });

  it("a blocked review with an active rework and an unchanged head sleeps", () => {
    const decision = decideReviewRework(
      facts({ task: task({ status: "blocked" }), child: child() }),
    );
    expect(decision).toEqual({ kind: "noop", reason: "head_unchanged" });
  });

  it("a blocked review whose rework delivered a new head releases it and wakes the reviewer", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ status: "blocked" }),
        child: child(),
        prs: [pr({ headSha: "b01958f1e6d4a3c9d7b2f8a1e6d4a3c9d7b2f8a1" })],
      }),
    );
    expect(decision.kind).toBe("unblock_review");
    if (decision.kind !== "unblock_review") return;
    expect(decision.previousHeadSha).toBe("da3364a2973ee31f0db15e9f5d6492f91880786c");
    expect(decision.headSha).toBe("b01958f1e6d4a3c9d7b2f8a1e6d4a3c9d7b2f8a1");
  });

  it("a verdict that named no head stores the baseline on the first sight of the head", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ status: "blocked" }),
        child: child({ baselineHeadSha: null }),
        comments: [{ id: "verdict-comment", body: "VERDICT #484: RETURN", createdAt: VERDICT_AT }],
      }),
    );
    expect(decision.kind).toBe("record_baseline");
    if (decision.kind === "record_baseline") expect(decision.headSha).toBe(pr().headSha);
  });

  it("a settled rework with a newer outstanding RETURN reopens the same task", () => {
    const settled = child({ status: "done" });
    const newerVerdict = { ...returnComment(), id: "verdict-comment-2", createdAt: NOW };
    const decision = decideReviewRework(
      facts({ child: settled, comments: [returnComment(), newerVerdict] }),
    );
    expect(decision.kind).toBe("reopen_rework");
    if (decision.kind === "reopen_rework") expect(decision.child.id).toBe("rework-1");
  });

  it("an APPROVE clears an outstanding return — no new task", () => {
    const decision = decideReviewRework(
      facts({
        comments: [
          returnComment(),
          { id: "approve-comment", body: "VERDICT #484: APPROVE", createdAt: NOW },
        ],
      }),
    );
    expect(decision).toEqual({ kind: "noop", reason: "verdict_cleared_by_approve" });
  });

  it("a head-ack newer than the verdict means the return was already answered", () => {
    const decision = decideReviewRework(
      facts({
        comments: [
          returnComment(),
          {
            id: "ack-comment",
            body: "HEAD-ACK acme/repo#484: b01958f1e6d4a3c9d7b2f8a1e6d4a3c9d7b2f8a1",
            createdAt: NOW,
          },
        ],
      }),
    );
    expect(decision.kind).toBe("noop");
  });

  it("a merged PR closes the review task whatever the verdict said", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ status: "in_review" }),
        prs: [pr({ state: "merged" })],
      }),
    );
    expect(decision).toEqual({
      kind: "close_review",
      prRefs: ["acme/repo#484"],
      outcome: "merged",
    });
  });

  it("a closed-without-merge PR closes the review as closed", () => {
    const decision = decideReviewRework(
      facts({ task: task({ status: "in_review" }), prs: [pr({ state: "closed" })] }),
    );
    if (decision.kind !== "close_review") throw new Error("expected close_review");
    expect(decision.outcome).toBe("closed");
  });

  it("a merged PR with an open sibling keeps the review alive", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ status: "in_review" }),
        prs: [pr({ state: "merged" }), pr({ prKey: "acme/repo#485", number: 485, state: "open" })],
      }),
    );
    expect(decision.kind).not.toBe("close_review");
  });

  it("an unresolvable PR never moves the task", () => {
    const decision = decideReviewRework(facts({ prs: [pr({ state: "unknown", headSha: null })] }));
    expect(decision).toEqual({ kind: "noop", reason: "pr_state_unknown" });
  });

  it("a blocked review whose PR cannot be resolved stays blocked", () => {
    const decision = decideReviewRework(
      facts({
        task: task({ status: "blocked" }),
        child: child(),
        prs: [pr({ state: "unknown", headSha: null })],
      }),
    );
    expect(decision).toEqual({ kind: "noop", reason: "pr_state_unknown" });
  });

  it("an in_progress task is owned by its run and never touched", () => {
    const decision = decideReviewRework(facts({ task: task({ status: "in_progress" }) }));
    expect(decision).toEqual({ kind: "noop", reason: "task_state_not_review" });
  });

  it("a task with no PR coordinates is not a candidate", () => {
    const decision = decideReviewRework(
      facts({ comments: [{ id: "c", body: "no links here", createdAt: VERDICT_AT }] , prs: [] }),
    );
    expect(decision).toEqual({ kind: "noop", reason: "no_linked_pr" });
  });

  it("a marker pinned to a different head is answered, not outstanding", () => {
    const decision = outstandingReturnVerdict(
      pr({ headSha: "aaaa111" }),
      [
        {
          prNumber: 484,
          outcome: "return" as const,
          at: VERDICT_AT,
          commentId: "c",
          headSha: "bbbb222",
        },
      ],
      new Map(),
    );
    expect(decision).toBeNull();
  });
});

describe("review rework ladder and fingerprint helpers", () => {
  it("dedupes a ladder where one agent fills two rungs", () => {
    const ladder = buildExecutorLadder({
      task: task({ returnAssigneeAgentId: "same-agent" }),
      deliveringTaskAssigneeAgentId: "same-agent",
      fallbackAssigneeAgentId: "fallback-agent",
    });
    expect(ladder.map((entry) => entry.agentId)).toEqual(["same-agent", "fallback-agent"]);
  });

  it("fingerprint round-trips both shapes", () => {
    expect(decodeReworkFingerprint(encodeReworkFingerprint("acme/repo#484", null))).toEqual({
      prKey: "acme/repo#484",
      baselineHeadSha: null,
    });
    expect(decodeReworkFingerprint(encodeReworkFingerprint("acme/repo#484", "deadbeef"))).toEqual({
      prKey: "acme/repo#484",
      baselineHeadSha: "deadbeef",
    });
    expect(decodeReworkFingerprint("")).toEqual({ prKey: null, baselineHeadSha: null });
  });

  it("prKey is case-insensitive", () => {
    expect(reviewReworkPrKey({ repo: "Acme/Repo", number: 7 })).toBe("acme/repo#7");
  });

  it("collectHeadAcks keeps the newest ack per PR", () => {
    const acks = collectHeadAcks([
      { id: "a1", body: "HEAD-ACK acme/repo#484: aaaaaaa", createdAt: "2026-10-01T00:00:00Z" },
      { id: "a2", body: "HEAD-ACK acme/repo#484: bbbbbbb", createdAt: "2026-10-02T00:00:00Z" },
    ]);
    expect(acks.get("acme/repo#484")?.headSha).toBe("bbbbbbb");
  });
});
