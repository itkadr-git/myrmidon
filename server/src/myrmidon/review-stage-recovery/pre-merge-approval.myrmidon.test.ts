import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues, issueComments } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { findApprovalPendingMergePullRequest } from "./pre-merge-approval.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("pre-merge approval findApprovalPendingMergePullRequest", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-pre-merge-approval-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issueWorkProducts);
    await db.delete(issueComments);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("finds linked open pull request directly", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: "TEST" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TEST-1",
      title: "Task 1",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId,
      type: "pull_request",
      status: "open",
      url: "https://github.com/itkadr-git/myrmidon/pull/100",
      title: "PR 100",
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/100");
  });

  it("finds unlinked open pull request by branch bot/<KEY>", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: "TEST" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: "TEST-2",
        title: "Task 2",
        status: "in_review",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        identifier: "TEST-3",
        title: "Task 3",
        status: "in_review",
        priority: "medium",
      },
    ]);
    // PR attached to other issue but with branch bot/TEST-2
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId: otherIssueId,
      type: "pull_request",
      status: "open",
      url: "https://github.com/itkadr-git/myrmidon/pull/102",
      title: "PR 102",
      metadata: { branch: "bot/TEST-2" },
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/102");
  });

  it("finds unlinked open pull request by 'APPROVE PR #N' in comment/verdict", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const otherIssueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: "TEST" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values([
      {
        id: issueId,
        companyId,
        identifier: "TEST-4",
        title: "Task 4",
        status: "in_review",
        priority: "medium",
      },
      {
        id: otherIssueId,
        companyId,
        identifier: "TEST-5",
        title: "Task 5",
        status: "in_review",
        priority: "medium",
      },
    ]);
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId: otherIssueId,
      type: "pull_request",
      status: "open",
      url: "https://github.com/itkadr-git/myrmidon/pull/105",
      title: "PR 105",
      metadata: { number: 105 },
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorType: "agent",
      body: "APPROVE PR #105 sha-abc",
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/105");
  });
});
