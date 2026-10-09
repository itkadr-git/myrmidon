// myrmidon(1.6.5 REVIEW-REWORK-F02): the database half of `deliveringTaskAssignee`'s
// url branch. On the live board the branch died with `like $n%` — a SQL syntax
// error, because the wildcard sat outside the parameter — which killed the whole
// review-return loop for tasks whose PR is only reachable through a work-product
// url. This test pins the fixed behaviour against a real Postgres: an exact PR
// number match (a trailing path segment like /files is allowed, /pull/123 must
// not answer to a search for 12) and the metadata branch left untouched.
//
// Neutral data only: agent-a, example/repo.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues } from "@paperclipai/db";
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
});
