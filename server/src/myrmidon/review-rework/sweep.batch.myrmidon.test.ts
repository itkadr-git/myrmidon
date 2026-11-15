// @vitest-environment node
//
// myrmidon(OPE-12785): the pass reads the page's comments (and rework children,
// loop-close facts) in one query each instead of one query per candidate. Fake
// seams only: no database, no network.

import { describe, expect, it } from "vitest";
import { DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC } from "@myrmidon/shared";
import { createReviewReworkSweep } from "./sweep.js";
import type { CreateReworkTaskInput, ReworkCandidateRow, ReviewReworkStore } from "./store.js";
import type { ReviewReworkChildFacts, ReviewReworkTaskFacts } from "./domain.js";

const VERDICT_AT = "2026-10-04T16:57:32.000Z";
const PR_URL = "https://github.com/acme/repo/pull/484";
const HEAD = "da3364a2973ee31f0db15e9f5d6492f91880786c";
type Comment = { id: string; body: string; createdAt: Date };

function task(id: string): ReviewReworkTaskFacts {
  return {
    id,
    companyId: "company-1",
    identifier: `OPE-${id}`,
    title: `Review PR ${PR_URL}`,
    status: "todo",
    assigneeAgentId: "reviewer-agent",
    assigneeUserId: null,
    projectId: null,
    goalId: null,
    billingCode: null,
    priority: "high",
    returnAssigneeAgentId: "author-agent",
  };
}

function row(id: string): ReworkCandidateRow {
  return {
    task: task(id),
    textParts: [`Review PR ${PR_URL}`, ""],
    products: [{ repo: "acme/repo", number: 484, url: PR_URL, status: "active" }],
  };
}

function verdict(id: string): Comment[] {
  return [{ id: `c-${id}`, body: `VERDICT #484: RETURN (head ${HEAD})`, createdAt: new Date(VERDICT_AT) }];
}

class CountingStore implements ReviewReworkStore {
  rows: ReworkCandidateRow[] = [];
  commentsByTask = new Map<string, Comment[]>();
  calls = { listComments: 0, batchComments: 0, findChild: 0, batchChildren: 0, closedIds: 0, reopened: [] as string[] };
  created: CreateReworkTaskInput[] = [];
  loopClosed = new Set<string>();
  failBatch = false;

  async listActiveCompanyIds() {
    return ["company-1"];
  }
  async listCandidateTasks() {
    return this.rows;
  }
  async listComments(issueId: string) {
    this.calls.listComments += 1;
    return this.commentsByTask.get(issueId) ?? [];
  }
  async findReworkChild() {
    this.calls.findChild += 1;
    return null;
  }
  async deliveringTaskAssignee() {
    return null;
  }
  async invokableAgentIds(_companyId: string, ids: readonly string[]) {
    return new Set(ids);
  }
  async createReworkTask(input: CreateReworkTaskInput) {
    this.created.push(input);
    return { id: `rework-${input.parentId}`, identifier: null };
  }
  async reopenReworkTask() {
    return true;
  }
  async stampReworkFingerprint() {
    return true;
  }
  async blockReviewTask() {
    return true;
  }
  async unblockReviewTask() {
    return true;
  }
  async closeReviewTask() {
    return true;
  }
  async applyGoalJudgeDecision() {
    return true;
  }
  async reopenedAfterLoopClose(_companyId: string, issueId: string) {
    this.calls.reopened.push(issueId);
    return false;
  }
  async awaitAcceptance() {
    return true;
  }
}

class BatchStore extends CountingStore {
  async listCommentsForIssues(ids: readonly string[]) {
    this.calls.batchComments += 1;
    if (this.failBatch) throw new Error("batch down");
    return new Map(ids.map((id) => [id, this.commentsByTask.get(id) ?? []] as const));
  }
  async findReworkChildren(_companyId: string, ids: readonly string[]) {
    this.calls.batchChildren += 1;
    return new Map<string, ReviewReworkChildFacts | null>(ids.map((id) => [id, null]));
  }
  async loopClosedIssueIds(_companyId: string, ids: readonly string[]) {
    this.calls.closedIds += 1;
    return new Set(ids.filter((id) => this.loopClosed.has(id)));
  }
}

function build(store: ReviewReworkStore) {
  return createReviewReworkSweep({
    store,
    resolvePr: async () => ({ state: "open", headSha: HEAD, reviewDecision: null, updatedAt: null }),
    readSettings: async () => ({
      enabled: true,
      sweepIntervalSec: DEFAULT_REVIEW_REWORK_SWEEP_INTERVAL_SEC,
      fallbackAssigneeAgentId: null,
    }),
    enqueueWake: async () => undefined,
    logActivity: async () => undefined,
    isUnderMaintenance: async () => false,
    log: { info: () => undefined, warn: () => undefined },
  });
}

function seed(store: CountingStore, ids: string[]) {
  store.rows = ids.map(row);
  for (const id of ids) store.commentsByTask.set(id, verdict(id));
}

const NOW = new Date("2026-10-04T17:00:00Z");

describe("review rework sweep: batched page reads (OPE-12785)", () => {
  it("reads the comments of the whole page in one query, not one per candidate", async () => {
    const store = new BatchStore();
    seed(store, ["r1", "r2", "r3", "r4", "r5"]);
    const result = await build(store).sweep(NOW, { force: true });
    expect(store.calls.batchComments).toBe(1);
    expect(store.calls.listComments).toBe(0);
    expect(store.calls.batchChildren).toBe(1);
    expect(store.calls.findChild).toBe(0);
    // Every candidate still got its own decision from its own comments.
    expect(result.reworkCreated).toBe(5);
    expect(store.created.map((input) => input.parentId).sort()).toEqual(["r1", "r2", "r3", "r4", "r5"]);
  });

  it("asks the loop-close veto only for tasks the loop closed", async () => {
    const store = new BatchStore();
    seed(store, ["r1", "r2", "r3"]);
    store.loopClosed = new Set(["r2"]);
    await build(store).sweep(NOW, { force: true });
    expect(store.calls.closedIds).toBe(1);
    expect(store.calls.reopened).toEqual(["r2"]);
  });

  it("does not batch-read tasks the skip-guard drops", async () => {
    const store = new BatchStore();
    seed(store, ["r1", "r2"]);
    store.rows = store.rows.map((candidate) => ({
      ...candidate,
      products: [],
      childPresent: false,
      verdictPresent: false,
    }));
    await build(store).sweep(NOW, { force: true });
    expect(store.calls.batchComments).toBe(0);
    expect(store.calls.listComments).toBe(0);
  });

  it("falls back to per-task reads when the store has no batch methods", async () => {
    const store = new CountingStore();
    seed(store, ["r1", "r2"]);
    const result = await build(store).sweep(NOW, { force: true });
    expect(store.calls.listComments).toBe(2);
    expect(result.reworkCreated).toBe(2);
  });

  it("falls back to per-task reads when the batch read fails, and the pass survives", async () => {
    const store = new BatchStore();
    store.failBatch = true;
    seed(store, ["r1", "r2"]);
    const result = await build(store).sweep(NOW, { force: true });
    expect(store.calls.batchComments).toBe(1);
    expect(store.calls.listComments).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.reworkCreated).toBe(2);
  });
});
