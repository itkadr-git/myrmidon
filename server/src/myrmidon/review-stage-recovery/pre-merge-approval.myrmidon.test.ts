import { randomUUID } from "node:crypto";
import { describe, expect, it, beforeAll, afterAll, afterEach } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues, issueComments, externalObjects } from "@myrmidon/db";
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
    await db.delete(externalObjects);
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

  it("finds unlinked open pull request from externalObjects by title issue key", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "company-title", issuePrefix: "TEST" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-title",
      role: "reviewer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TEST-98",
      title: "Task 98",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(externalObjects).values({
      id: randomUUID(),
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "itkadr-git/myrmidon#pull/2612",
      sanitizedCanonicalUrl: "https://github.com/itkadr-git/myrmidon/pull/2612",
      isTerminal: false,
      data: {
        number: 2612,
        headRef: "feature/unrelated",
        title: "TEST-98: protect the done gate",
        url: "https://github.com/itkadr-git/myrmidon/pull/2612",
      },
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/2612");
  });

  it("finds unlinked open pull request from externalObjects by branch bot/<KEY>", async () => {
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
      identifier: "TEST-99",
      title: "Task 99",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(externalObjects).values({
      id: randomUUID(),
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "itkadr-git/myrmidon#pull/2613",
      sanitizedCanonicalUrl: "https://github.com/itkadr-git/myrmidon/pull/2613",
      isTerminal: false,
      data: {
        number: 2613,
        headRef: "bot/TEST-99",
        url: "https://github.com/itkadr-git/myrmidon/pull/2613",
      },
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/2613");
  });

  it("finds unlinked open pull request from externalObjects by APPROVE PR #N comment", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "company-b", issuePrefix: "TEST" });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-b",
      role: "reviewer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "TEST-100",
      title: "Task 100",
      status: "in_review",
      priority: "medium",
    });
    await db.insert(issueComments).values({
      id: randomUUID(),
      companyId,
      issueId,
      authorAgentId: agentId,
      body: "APPROVE PR #3344 abcdef12345",
    });
    await db.insert(externalObjects).values({
      id: randomUUID(),
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "itkadr-git/myrmidon#pull/3344",
      sanitizedCanonicalUrl: "https://github.com/itkadr-git/myrmidon/pull/3344",
      isTerminal: false,
      data: {
        number: 3344,
        headRef: "feature/test",
        url: "https://github.com/itkadr-git/myrmidon/pull/3344",
      },
    });

    const result = await findApprovalPendingMergePullRequest(db, companyId, issueId);
    expect(result).not.toBeNull();
    expect(result?.url).toBe("https://github.com/itkadr-git/myrmidon/pull/3344");
  });
});
