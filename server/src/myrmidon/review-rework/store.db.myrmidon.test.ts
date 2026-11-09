// myrmidon(1.6.5 REVIEW-REWORK-F02): the database half of `deliveringTaskAssignee`'s
// url branch. On the live board the branch died with `like $n%` — a SQL syntax
// error, because the wildcard sat outside the parameter — which killed the whole
// review-return loop for tasks whose PR is only reachable through a work-product
// url. This test pins the fixed behaviour against a real Postgres: an exact PR
// number match (a trailing path segment like /files is allowed, /pull/123 must
// not answer to a search for 12) and the metadata branch left untouched.
//
// OPE-12260 extends the file with the reopen-veto probe: after the loop closes
// a review on a merged PR, any later user/agent move off a terminal status must
// veto the next automatic close.
//
// Neutral data only: agent-a, example/repo.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, createDb, issueWorkProducts, issues } from "@myrmidon/db";
import { REVIEW_REWORK_CLOSED_ACTION } from "@myrmidon/shared";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { createPgReviewReworkStore } from "./store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("myrmidon(1.6.5 REVIEW-REWORK-F02) deliveringTaskAssignee url match", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let store!: ReturnType<typeof createPgReviewReworkStore>;
  let companyId!: string;
  let delivererAgentId!: string;

  /** A task that carries no work product — used as the excluded review issue. */
  let excludeIssueId!: string;

  async function seedTaskWithTitle(title: string): Promise<string> {
    const row = await db
      .insert(issues)
      .values({ companyId, title, status: "in_progress", assigneeAgentId: delivererAgentId })
      .returning()
      .then((rows) => rows[0]!);
    return row.id;
  }

  async function attachPullRequestWorkProduct(
    issueId: string,
    url: string,
    metadata: Record<string, unknown> | null,
  ): Promise<void> {
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      title: `PR ${url}`,
      url,
      status: "active",
      metadata,
    });
  }

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-review-rework-store-");
    db = createDb(tempDb.connectionString);
    store = createPgReviewReworkStore(db);

    const company = await db
      .insert(companies)
      .values({ name: `company-a ${randomUUID()}`, issuePrefix: `RR${randomUUID().slice(0, 6).toUpperCase()}` })
      .returning()
      .then((rows) => rows[0]!);
    companyId = company.id;

    const deliverer = await db
      .insert(agents)
      .values({
        companyId,
        name: "agent-a",
        role: "engineer",
        permissions: {},
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
      })
      .returning()
      .then((rows) => rows[0]!);
    delivererAgentId = deliverer.id;

    excludeIssueId = await seedTaskWithTitle("review-task");

    // Canonical work-product url (the format the review-rework resolver writes).
    const canonicalTaskId = await seedTaskWithTitle("delivering-task-canonical");
    await attachPullRequestWorkProduct(
      canonicalTaskId,
      "https://github.com/example/repo/pull/12",
      null,
    );

    // A trailing path segment (PR files view) still identifies the same PR.
    const filesViewTaskId = await seedTaskWithTitle("delivering-task-files-view");
    await attachPullRequestWorkProduct(
      filesViewTaskId,
      "https://github.com/example/repo/pull/77/files",
      null,
    );

    // A neighbouring, longer PR number must never answer to a shorter search.
    const neighbourTaskId = await seedTaskWithTitle("delivering-task-neighbour-number");
    await attachPullRequestWorkProduct(
      neighbourTaskId,
      "https://github.com/example/repo/pull/123",
      null,
    );
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("finds the delivering task's assignee through the canonical url", async () => {
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/repo", number: 12 },
      excludeIssueId,
    );
    expect(assignee).toBe(delivererAgentId);
  });

  it("does not match a different PR number (12 is not 1)", async () => {
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/repo", number: 1 },
      excludeIssueId,
    );
    expect(assignee).toBeNull();
  });

  it("matches a url with a trailing path segment (/pull/77/files for PR 77)", async () => {
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/repo", number: 77 },
      excludeIssueId,
    );
    expect(assignee).toBe(delivererAgentId);
  });

  it("does not match a longer neighbour number (/pull/123 for a search of 12)", async () => {
    // `example/repo` PR 12 has its own canonical row, so isolate the neighbour
    // case with a repo that only owns /pull/123.
    const neighbourTaskId = await seedTaskWithTitle("delivering-task-only-neighbour");
    await attachPullRequestWorkProduct(
      neighbourTaskId,
      "https://github.com/example/other/pull/123",
      null,
    );
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/other", number: 12 },
      excludeIssueId,
    );
    expect(assignee).toBeNull();
  });

  it("ignores archived work products", async () => {
    const archivedTaskId = await seedTaskWithTitle("delivering-task-archived");
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: archivedTaskId,
      type: "pull_request",
      provider: "github",
      title: "archived PR",
      url: "https://github.com/example/archived/pull/9",
      status: "archived",
      metadata: null,
    });
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/archived", number: 9 },
      excludeIssueId,
    );
    expect(assignee).toBeNull();
  });

  it("strips query and fragment parts before matching", async () => {
    const fragTaskId = await seedTaskWithTitle("delivering-task-fragment");
    await attachPullRequestWorkProduct(
      fragTaskId,
      "https://github.com/example/frag/pull/5#discussion_r1",
      null,
    );
    const assignee = await store.deliveringTaskAssignee(
      companyId,
      { repo: "example/frag", number: 5 },
      excludeIssueId,
    );
    expect(assignee).toBe(delivererAgentId);
  });

  // OPE-12260: the veto is a historical fact. The DB must answer "yes" when
  // ANY user/agent issue.updated row moved the issue off a terminal status
  // after the loop's own close — not only when such a row happens to be the
  // newest audit entry (a later agent status move must not displace it).
  describe("reopenedAfterLoopClose (OPE-12260)", () => {
    /** The audit row the loop itself writes when it settles a review. */
    async function seedLoopCloseRow(issueId: string, at: Date) {
      await db.insert(activityLog).values({
        companyId,
        actorType: "system",
        actorId: "review_rework_sweep",
        action: REVIEW_REWORK_CLOSED_ACTION,
        entityType: "issue",
        entityId: issueId,
        details: { reason: "pr_terminal", outcome: "merged" },
        createdAt: at,
      });
    }

    /**
     * An audit row on the issue, shaped like the ones the issue routes write.
     * The update route writes `status` + `_previous` on every status move; the
     * reopen route writes `reopened` / `reopenedFrom`.
     */
    async function seedIssueUpdatedRow(
      issueId: string,
      at: Date,
      actorType: "user" | "agent" | "system",
      actorId: string,
      details: Record<string, unknown>,
    ) {
      await db.insert(activityLog).values({
        companyId,
        actorType,
        actorId,
        action: "issue.updated",
        entityType: "issue",
        entityId: issueId,
        details,
        createdAt: at,
      });
    }

    /** Details shape of a plain status move: `status` + `_previous.status`. */
    function statusMoveDetails(previous: string, next: string) {
      return {
        status: next,
        _previous: { status: previous },
      };
    }

    let vetoTaskId!: string;
    let plainTaskId!: string;

    beforeAll(async () => {
      vetoTaskId = await seedTaskWithTitle("delivering-task-reopen-veto");
      await seedLoopCloseRow(vetoTaskId, new Date("2026-11-07T10:00:00.000Z"));
      // The person/ADM reopen: off the terminal status AFTER the loop's close.
      await seedIssueUpdatedRow(
        vetoTaskId,
        new Date("2026-11-07T10:05:00.000Z"),
        "user",
        "user-alex",
        statusMoveDetails("done", "in_progress"),
      );
      // The executor's wake: a LATER agent move that must not displace the
      // historical veto (the newest-row probe lost the veto exactly this way —
      // the OPE-7290 relapse the reviewer named).
      await seedIssueUpdatedRow(
        vetoTaskId,
        new Date("2026-11-07T10:06:00.000Z"),
        "agent",
        delivererAgentId,
        statusMoveDetails("in_progress", "in_review"),
      );
    });

    beforeAll(async () => {
      plainTaskId = await seedTaskWithTitle("delivering-task-no-reopen");
      // The loop closed it; no off-terminal row ever follows — an ordinary
      // close applies, the veto must not fire.
      await seedLoopCloseRow(plainTaskId, new Date("2026-11-07T11:00:00.000Z"));
      // A later agent move that does NOT leave a terminal status (an agent
      // move between review shapes) must not veto either.
      await seedIssueUpdatedRow(
        plainTaskId,
        new Date("2026-11-07T11:01:00.000Z"),
        "agent",
        delivererAgentId,
        statusMoveDetails("in_review", "blocked"),
      );
    });

    it("vetoes when any user/agent row moved the issue off done/cancelled after the close", async () => {
      const veto = await store.reopenedAfterLoopClose(companyId, vetoTaskId);
      expect(veto).toBe(true);
    });

    it("does not veto when no reopen row follows the close (ordinary close applies)", async () => {
      const veto = await store.reopenedAfterLoopClose(companyId, plainTaskId);
      expect(veto).toBe(false);
    });

    it("does not veto a task the loop never closed", async () => {
      const taskId = await seedTaskWithTitle("delivering-task-never-closed");
      await seedIssueUpdatedRow(
        taskId,
        new Date("2026-11-07T12:00:00.000Z"),
        "user",
        "user-alex",
        statusMoveDetails("done", "in_progress"),
      );
      const veto = await store.reopenedAfterLoopClose(companyId, taskId);
      expect(veto).toBe(false);
    });

    it("does not veto when the only post-close move is by a system actor", async () => {
      const taskId = await seedTaskWithTitle("delivering-task-system-actor");
      await seedLoopCloseRow(taskId, new Date("2026-11-07T12:10:00.000Z"));
      await seedIssueUpdatedRow(
        taskId,
        new Date("2026-11-07T12:11:00.000Z"),
        "system",
        "some_service",
        statusMoveDetails("done", "in_progress"),
      );
      const veto = await store.reopenedAfterLoopClose(companyId, taskId);
      expect(veto).toBe(false);
    });

    it("does not veto when the post-close user move left a NON-terminal status", async () => {
      const taskId = await seedTaskWithTitle("delivering-task-non-terminal-move");
      await seedLoopCloseRow(taskId, new Date("2026-11-07T12:20:00.000Z"));
      await seedIssueUpdatedRow(
        taskId,
        new Date("2026-11-07T12:21:00.000Z"),
        "user",
        "user-alex",
        statusMoveDetails("in_review", "blocked"),
      );
      const veto = await store.reopenedAfterLoopClose(companyId, taskId);
      expect(veto).toBe(false);
    });

    it("vetoes on the reopen-route shape (details.reopenedFrom, no _previous block)", async () => {
      const taskId = await seedTaskWithTitle("delivering-task-reopened-from-shape");
      await seedLoopCloseRow(taskId, new Date("2026-11-07T12:30:00.000Z"));
      await seedIssueUpdatedRow(
        taskId,
        new Date("2026-11-07T12:31:00.000Z"),
        "user",
        "user-alex",
        { status: "in_progress", reopened: true, reopenedFrom: "done" },
      );
      const veto = await store.reopenedAfterLoopClose(companyId, taskId);
      expect(veto).toBe(true);
    });

    it("vetoes on the system-shaped row carrying previousStatus", async () => {
      const taskId = await seedTaskWithTitle("delivering-task-previous-status-shape");
      await seedLoopCloseRow(taskId, new Date("2026-11-07T12:40:00.000Z"));
      await seedIssueUpdatedRow(
        taskId,
        new Date("2026-11-07T12:41:00.000Z"),
        "agent",
        delivererAgentId,
        { status: "in_progress", previousStatus: "done" },
      );
      const veto = await store.reopenedAfterLoopClose(companyId, taskId);
      expect(veto).toBe(true);
    });
  });
});
