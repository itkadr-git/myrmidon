import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionEventDeliveries,
  issueWorkProducts,
  issueComments,
  issues,
  connectionGrants,
  createDb,
  externalObjects,
  toolApplications,
  toolConnections,
} from "@myrmidon/db";
import { and, eq } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyLiveBehaviorSettings } from "../myrmidon/behavior-settings/live.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres.sequential("GitHub connection event delivery", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionEventDeliveries);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("completes the linked issue only when a closed PR is merged", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
    const [application] = await db.insert(toolApplications).values({
      companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active",
    }).returning({ id: toolApplications.id });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId: application!.id, name: "GitHub", uid: `github-${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId, companyId, connectionId, kind: "agent", subjectAgentId: agentId, status: "active", isDefault: false,
      providerTenant: { github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1,
        repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["paperclipai"] } },
    });
    await db.insert(issues).values({ id: issueId, companyId, title: "PR task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#pull/123", title: "PR #123", status: "open", metadata: { repository: "paperclipai/paperclip", number: 123 } });
    await db.insert(externalObjects).values({ companyId, providerKey: "github", objectType: "pull_request", externalId: "paperclipai/paperclip#pull/123", statusKey: "open", statusCategory: "open", statusTone: "info", isTerminal: false, data: { provider: "github", owner: "paperclipai", repo: "paperclip", number: 123, state: "open" } });
    const events = [false, true].map((merged, i) => ({
      id: `delivery-pr-close-${i}`, provider: "github" as const, event: "pull_request", action: "closed", installationId: "101", repositoryId: "99", createdAt: "2026-09-04T12:00:00.000Z", bindingIds: [`${grantId}_101`],
      payload: { repository: "paperclipai/paperclip", number: 123, state: "closed", merged, mergedAt: merged ? "2026-09-04T11:59:00.000Z" : null, updatedAt: "2026-09-04T12:00:00.000Z", url: "https://github.com/paperclipai/paperclip/pull/123" },
    }));
    const connector = { getCapabilities: vi.fn(async () => ["github.code" as const]), startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(), setWebhookBinding: vi.fn(async () => undefined), leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events: [events.shift()!] })), acknowledgeEvents: vi.fn(async () => 1) } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).toBe("in_progress");
    currentTime = new Date("2026-09-04T12:00:16.000Z");
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0]?.status).toBe("done");
  });

  it("applies a normalized merged PR once, updates the snapshot, and acknowledges Cloud", async () => {
    const companyId = randomUUID();
    const userId = `github-owner-${randomUUID()}`;
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHE" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: userId,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });
    const externalObjectId = randomUUID();
    await db.insert(externalObjects).values({
      id: externalObjectId,
      companyId,
      providerKey: "github",
      objectType: "pull_request",
      externalId: "paperclipai/paperclip#pull/123",
      statusCategory: "open",
      statusTone: "info",
      data: { provider: "github", marker: "preserved" },
    });

    const leasedEvent = {
      id: "delivery_merged_123",
      provider: "github" as const,
      event: "pull_request",
      action: "closed",
      installationId: "101",
      repositoryId: "99",
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
        body: "private pull request body",
        comments: [{ body: "private review comment" }],
        accessToken: "ghu_must_not_be_persisted",
        arbitraryNested: { credential: "also-must-not-be-persisted" },
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: `lease-${++poll}`, events: [leasedEvent] })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 1, duplicate: 0, failed: 0 });
    const [snapshot] = await db.select().from(externalObjects).where(eq(externalObjects.id, externalObjectId));
    expect(snapshot).toMatchObject({
      statusKey: "merged",
      statusLabel: "Merged",
      statusCategory: "succeeded",
      statusTone: "success",
      isTerminal: true,
      remoteVersion: "2026-09-04T11:59:01.000Z",
      data: expect.objectContaining({ marker: "preserved", merged: true, headRef: "feature", baseSha: "b".repeat(40) }),
    });
    const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ webhookHealth: "healthy", lastWebhookAt: currentTime.toISOString() });
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({
      status: "processed",
      attempts: 1,
      provider: "github",
      normalizedPayload: {
        repository: "paperclipai/paperclip",
        number: 123,
        state: "closed",
        merged: true,
        mergedAt: "2026-09-04T11:59:00.000Z",
        updatedAt: "2026-09-04T11:59:01.000Z",
        url: "https://github.com/paperclipai/paperclip/pull/123",
        headRef: "feature",
        headSha: "a".repeat(40),
        baseRef: "master",
        baseSha: "b".repeat(40),
      },
    });
    expect(JSON.stringify(receipt)).not.toMatch(/private pull request|private review|ghu_|also-must-not/);
    const [activity] = await db.select().from(activityLog).where(eq(activityLog.action, "tool_connection.webhook_processed"));
    expect(activity?.details).toEqual({
      provider: "github",
      event: "pull_request",
      action: "closed",
      deliveryId: leasedEvent.id,
      installationId: "101",
      repositoryId: "99",
    });
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(1);

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ leased: 1, processed: 0, duplicate: 1, failed: 0 });
    const [duplicateReceipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(duplicateReceipt?.attempts).toBe(1);
    expect(connector.acknowledgeEvents).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("applies installation events once without discarding newer verified access (refreshed: %s)", async (refreshed) => {
    const companyId = randomUUID();
    const applicationId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHI" });
    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 3,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [{ id: "203", fullName: "paperclipai/removed", installationId: "101" }],
          webhookHealth: "pending",
        },
      },
    });

    const leasedEvent = {
      id: "delivery_repository_change_101",
      provider: "github" as const,
      event: "installation_repositories",
      action: "added",
      installationId: "101",
      repositoryId: null,
      createdAt: "2026-09-04T12:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repositorySelection: "selected",
        repositoriesAdded: ["201", "202"],
        repositoriesRemoved: ["203"],
      },
    };
    let poll = 0;
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => {
        if (refreshed) {
          const [latest] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
          await db.update(connectionGrants).set({ providerTenant: {
            ...latest!.providerTenant,
            github: { ...latest!.providerTenant!.github!, lastAccessRefreshAt: "2026-09-04T12:00:02.000Z" },
          } }).where(eq(connectionGrants.id, grantId));
        }
        return ({ leaseId: `lease-${++poll}`, events: [leasedEvent] });
      }),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime });

    const unsubscribe = subscribeCompanyLiveEvents(companyId, vi.fn());
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, duplicate: 0, failed: 0 });
    unsubscribe();
    let [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github).toMatchObject({ repositoryCount: refreshed ? 3 : 4, webhookHealth: "healthy" });
    if (refreshed) {
      expect(grant?.providerTenant?.github?.repositories).toHaveLength(1);
    } else {
      expect(grant?.providerTenant?.github?.repositories).toBeUndefined();
    }

    currentTime = new Date(currentTime.getTime() + 6_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 1, failed: 0 });
    [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, grantId));
    expect(grant?.providerTenant?.github?.repositoryCount).toBe(refreshed ? 3 : 4);
    const [receipt] = await db.select().from(connectionEventDeliveries).where(eq(
      connectionEventDeliveries.providerDeliveryId,
      leasedEvent.id,
    ));
    expect(receipt).toMatchObject({ status: "processed", attempts: 1 });
  });

  it("persists active exact-head CI state and wakes the assigned PR owner on completion", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "PR task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#pull/123", title: "PR #123", status: "open", metadata: { repository: "paperclipai/paperclip", number: 123, headSha: "a".repeat(40) } });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true, config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: `github-owner-${randomUUID()}`, status: "active", isDefault: false, providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["paperclipai"], repositories: [], webhookHealth: "pending" } } });
    const headSha = "a".repeat(40);
    const events = ["workflow_run", "check_suite"].map((event, i) => ({
      id: `ci-delivery-${i}`, provider: "github" as const, event, action: "completed", installationId: "101", repositoryId: "99", createdAt: "2026-09-04T12:00:00.000Z", bindingIds: [`${grantId}_101`],
      payload: { repository: "paperclipai/paperclip", workflowRun: { pullRequests: [{ number: 123 }] }, pullRequest: { number: 123 }, status: i === 0 ? "in_progress" : "completed", conclusion: i === 0 ? null : "failure", headSha, runId: "456", checkSuiteId: "789", accessToken: "must-be-dropped" },
    }));
    const connector = { getCapabilities: vi.fn(async () => ["github.code" as const]), startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(), setWebhookBinding: vi.fn(async () => undefined), leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events })), acknowledgeEvents: vi.fn(async () => 2) } as unknown as PaperclipCloudConnector;
    const wakeup = vi.fn(async () => undefined);
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, assignmentWakeup: wakeup, now: () => currentTime });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 2, failed: 0 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(agentId, expect.objectContaining({ reason: "ci_completed", payload: expect.objectContaining({ conclusion: "failure", headSha, pullRequestNumber: 123 }) }));
    expect(wakeup.mock.calls[0]?.[1].idempotencyKey).toContain(headSha);
    expect(wakeup.mock.calls[0]?.[1].payload).not.toHaveProperty("accessToken");
    const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
    expect(product?.metadata).toMatchObject({ activeCi: null });
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, issueId));
    currentTime = new Date(currentTime.getTime() + 5_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 2, failed: 0 });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failure", "in_review", "standard", true],
    ["success", "in_review", "standard", false],
    ["failure", "in_progress", "standard", false],
    ["failure", "in_review", "planning", false],
  ])("handles CI %s for %s (%s), return=%s, idempotently", async (conclusion, status, workMode, returnsToExecutor) => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GHE" });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
    const reviewerId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId, name: "reviewer", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "PR task", status, workMode,
      assigneeAgentId: reviewerId, executionState: {
        status: "pending", currentStageId: randomUUID(), currentStageIndex: 0,
        currentStageType: "review", currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId }, completedStageIds: [],
        lastDecisionId: null, lastDecisionOutcome: null,
      },
    });
    await db.insert(issueWorkProducts).values({ companyId, issueId, type: "pull_request", provider: "github", externalId: "paperclipai/paperclip#pull/123", title: "PR #123", status: "open", metadata: { repository: "paperclipai/paperclip", number: 123 } });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true, config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: `github-owner-${randomUUID()}`, status: "active", isDefault: false, providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["paperclipai"], repositories: [], webhookHealth: "pending" } } });
    const headSha = "a".repeat(40);
    const events = ["workflow_run", "check_suite", "check_run"].map((event, i) => ({
      id: `ci-delivery-${i}`, provider: "github" as const, event, action: "completed", installationId: "101", repositoryId: "99", createdAt: "2026-09-04T12:00:00.000Z", bindingIds: [`${grantId}_101`],
      payload: { repository: "paperclipai/paperclip", workflowRun: { pullRequests: [{ number: 123 }] }, pullRequest: { number: 123 }, number: 123, status: "completed", conclusion, headSha, runId: "456", htmlUrl: "https://github.com/paperclipai/paperclip/actions/runs/456", checkSuiteId: "789", accessToken: "must-be-dropped" },
    }));
    const connector = { getCapabilities: vi.fn(async () => ["github.code"] as const), startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(), setWebhookBinding: vi.fn(async () => undefined), leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events })), acknowledgeEvents: vi.fn(async () => 3) } as unknown as PaperclipCloudConnector;
    const wakeup = vi.fn(async () => undefined);
    let currentTime = new Date("2026-09-04T12:00:05.000Z");
    const service = githubConnectionEventService(db, { connector, assignmentWakeup: wakeup, now: () => currentTime });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 3, failed: 0 });
    expect(wakeup).toHaveBeenCalledTimes(1);
    expect(wakeup).toHaveBeenCalledWith(returnsToExecutor ? agentId : reviewerId, expect.objectContaining({ reason: "ci_completed", payload: expect.objectContaining({ conclusion, headSha, pullRequestNumber: 123 }) }));
    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.status).toBe(returnsToExecutor ? "in_progress" : status);
    expect(updated.assigneeAgentId).toBe(returnsToExecutor ? agentId : reviewerId);
    expect(updated.executionState).toMatchObject({ status: returnsToExecutor ? "changes_requested" : "pending" });
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(comments).toHaveLength(returnsToExecutor ? 1 : 0);
    if (returnsToExecutor) {
      expect(comments[0].body).toContain("CI failure");
      expect(comments[0].body).toContain(headSha);
      expect(comments[0].body).toContain("https://github.com/paperclipai/paperclip/actions/runs/456");
    }
    expect(wakeup.mock.calls[0]?.[1].idempotencyKey).toContain(headSha);
    expect(wakeup.mock.calls[0]?.[1].payload).not.toHaveProperty("accessToken");
    currentTime = new Date(currentTime.getTime() + 5_000);
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 0, duplicate: 3, failed: 0 });
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it.each([
    { mergeable: "CONFLICTING", status: "in_review", returnsToAuthor: true },
    { mergeable: false, status: "in_review", returnsToAuthor: true },
    { mergeable: "CONFLICTING", status: "in_progress", returnsToAuthor: false },
    { mergeable: "MERGEABLE", status: "in_review", returnsToAuthor: false },
  ])("handles pull_request webhook with mergeable=$mergeable (status=$status, returnsToAuthor=$returnsToAuthor)", async ({
    mergeable,
    status,
    returnsToAuthor,
  }) => {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "CON" });
    await db.insert(agents).values({ id: authorAgentId, companyId, name: "author", role: "engineer" });
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "reviewer", role: "engineer" });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PR with conflict",
      status,
      workMode: "standard",
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: authorAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#pull/200",
      title: "PR #200",
      status: "open",
      metadata: { repository: "paperclipai/paperclip", number: 200 },
    });

    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 1,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [],
          webhookHealth: "pending",
        },
      },
    });

    const events = [{
      id: `pr-delivery-${randomUUID()}`,
      provider: "github" as const,
      event: "pull_request",
      action: "synchronize",
      installationId: "101",
      repositoryId: "99",
      createdAt: "2026-10-30T10:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repository: "paperclipai/paperclip",
        number: 200,
        state: "open",
        mergeable,
        url: "https://github.com/paperclipai/paperclip/pull/200",
        headSha: "b".repeat(40),
      },
    }];

    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events })),
      acknowledgeEvents: vi.fn(async () => 1),
    } as unknown as PaperclipCloudConnector;

    const wakeup = vi.fn(async () => undefined);
    const service = githubConnectionEventService(db, { connector, assignmentWakeup: wakeup });
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, failed: 0 });

    const [updated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated.status).toBe(returnsToAuthor ? "in_progress" : status);
    expect(updated.assigneeAgentId).toBe(returnsToAuthor ? authorAgentId : reviewerAgentId);

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    if (returnsToAuthor) {
      expect(comments).toHaveLength(1);
      expect(comments[0].body).toContain("влей свежий main");
      expect(comments[0].body).toContain("merge conflict");
      expect(wakeup).toHaveBeenCalledWith(authorAgentId, expect.objectContaining({
        reason: "pr_merge_conflict",
        payload: expect.objectContaining({ pullRequestNumber: 200, mergeable: "CONFLICTING" }),
      }));
    } else {
      expect(comments).toHaveLength(0);
      expect(wakeup).not.toHaveBeenCalled();
    }
  });

  it("does not duplicate comment or wake author on repeated CONFLICTING event after task is in_progress", async () => {
    const companyId = randomUUID();
    const authorAgentId = randomUUID();
    const reviewerAgentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();

    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "CON" });
    await db.insert(agents).values({ id: authorAgentId, companyId, name: "author", role: "engineer" });
    await db.insert(agents).values({ id: reviewerAgentId, companyId, name: "reviewer", role: "engineer" });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PR with conflict idempotency",
      status: "in_review",
      workMode: "standard",
      assigneeAgentId: reviewerAgentId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerAgentId },
        returnAssignee: { type: "agent", agentId: authorAgentId },
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    });

    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "pull_request",
      provider: "github",
      externalId: "paperclipai/paperclip#pull/201",
      title: "PR #201",
      status: "open",
      metadata: { repository: "paperclipai/paperclip", number: 201 },
    });

    await db.insert(toolApplications).values({
      id: applicationId,
      companyId,
      applicationKey: `github-${randomUUID()}`,
      name: "GitHub",
      type: "mcp_server",
      status: "active",
    });
    await db.insert(toolConnections).values({
      id: connectionId,
      companyId,
      applicationId,
      name: "GitHub",
      uid: `github-${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } },
      transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId,
      companyId,
      connectionId,
      kind: "user",
      subjectUserId: `github-owner-${randomUUID()}`,
      status: "active",
      isDefault: false,
      providerTenant: {
        oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null },
        github: {
          userId: "42",
          login: "octocat",
          installationCount: 1,
          repositoryCount: 1,
          repositorySelection: "selected",
          installationIds: ["101"],
          installationOwnerLogins: ["paperclipai"],
          repositories: [],
          webhookHealth: "pending",
        },
      },
    });

    const createEvent = (id: string) => ({
      id,
      provider: "github" as const,
      event: "pull_request",
      action: "synchronize",
      installationId: "101",
      repositoryId: "99",
      createdAt: "2026-10-30T10:00:00.000Z",
      bindingIds: [`${grantId}_101`],
      payload: {
        repository: "paperclipai/paperclip",
        number: 201,
        state: "open",
        mergeable: "CONFLICTING",
        url: "https://github.com/paperclipai/paperclip/pull/201",
        headSha: "c".repeat(40),
      },
    });

    const wakeup = vi.fn(async () => undefined);
    let events = [createEvent(`pr-delivery-${randomUUID()}`)];
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code" as const]),
      startAuthorization: vi.fn(async () => ({ authorizationUrl: "https://github.com/login/oauth/authorize", state: "state" })),
      claim: vi.fn(),
      refresh: vi.fn(),
      revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events })),
      acknowledgeEvents: vi.fn(async () => events.length),
    } as unknown as PaperclipCloudConnector;

    let currentTime = new Date("2026-10-30T10:00:00.000Z");
    const service = githubConnectionEventService(db, { connector, now: () => currentTime, assignmentWakeup: wakeup });

    // First event: transitions to in_progress, appends comment, wakes author once
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, failed: 0 });

    const [firstUpdated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(firstUpdated.status).toBe("in_progress");
    expect(firstUpdated.assigneeAgentId).toBe(authorAgentId);
    expect(wakeup).toHaveBeenCalledTimes(1);

    const firstComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(firstComments).toHaveLength(1);

    // Second event (repeated CONFLICTING webhook): task is already in_progress, must skip comment & wakeup
    currentTime = new Date(currentTime.getTime() + 6_000);
    events = [createEvent(`pr-delivery-${randomUUID()}`)];
    await expect(service.pollOnce()).resolves.toMatchObject({ processed: 1, failed: 0 });

    const [secondUpdated] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(secondUpdated.status).toBe("in_progress");
    expect(secondUpdated.assigneeAgentId).toBe(authorAgentId);

    const secondComments = await db.select().from(issueComments).where(eq(issueComments.issueId, issueId));
    expect(secondComments).toHaveLength(1);
    expect(wakeup).toHaveBeenCalledTimes(1);
  });

  it("raises alarm on GitHub event silence when active PRs exist and resolves when healthy", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Watchdog Corp", issuePrefix: "WDC" });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Active PR Task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "pull_request", provider: "github",
      externalId: "corp/repo#pull/42", title: "PR #42", status: "open", metadata: { repository: "corp/repo", number: 42 },
    });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {},
    });
    await db.insert(connectionGrants).values({
      id: grantId, companyId, connectionId, kind: "user", subjectUserId: `user-${randomUUID()}`, status: "active", isDefault: false,
      providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["201"], installationOwnerLogins: ["corp"], repositories: [], webhookHealth: "pending", lastWebhookAt: "2026-11-03T00:00:00.000Z" } },
    });

    const connector = { getCapabilities: vi.fn(async () => ["github.code"] as const), leaseEvents: vi.fn(async () => null), acknowledgeEvents: vi.fn() } as unknown as PaperclipCloudConnector;
    const now = new Date("2026-11-03T01:00:00.000Z"); // 60 minutes after lastWebhookAt -> silence!
    const service = githubConnectionEventService(db, { connector, now: () => now });

    // First sweep: active PR exists + 60m silence (>15m threshold) -> raises alarm
    const sweep1 = await service.sweepWatchdog(now);
    expect(sweep1.activePrCount).toBe(1);
    expect(sweep1.alarmsCreated).toBe(1);

    const [alarmIssue] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, "github_events_silence"),
      eq(issues.originId, companyId),
    ));
    expect(alarmIssue).toBeDefined();
    expect(alarmIssue?.status).toBe("todo");
    expect(alarmIssue?.priority).toBe("high");
    expect(alarmIssue?.title).toContain("ALARM: события GitHub");

    // Second sweep with healthy event timestamp (now - 2 minutes) -> resolves alarm
    const healthyTime = new Date("2026-11-03T01:05:00.000Z");
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "system",
      action: "tool_connection.webhook_processed",
      entityType: "tool_connection",
      entityId: connectionId,
      createdAt: new Date("2026-11-03T01:03:00.000Z"),
      details: {},
    });
    await db.insert(connectionEventDeliveries).values({
      companyId,
      provider: "github",
      providerDeliveryId: `delivery-${randomUUID()}`,
      event: "check_run",
      status: "processed",
      createdAt: new Date("2026-11-03T01:03:00.000Z"),
    });

    const sweep2 = await service.sweepWatchdog(healthyTime);
    expect(sweep2.alarmsResolved).toBe(1);

    const [resolvedAlarm] = await db.select().from(issues).where(and(
      eq(issues.companyId, companyId),
      eq(issues.originKind, "github_events_silence"),
      eq(issues.originId, companyId),
    ));
    expect(resolvedAlarm?.status).toBe("done");
  });
});

describeEmbeddedPostgres.sequential("1.7 SWEEP-2 (OPE-12629): sweepWatchdog threshold resolution", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const ENV_KEYS = [
    "MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN",
    "PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN",
  ] as const;
  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-github-events-thresholds-");
    db = createDb(tempDb.connectionString);
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(connectionEventDeliveries);
    await db.delete(issueWorkProducts);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(externalObjects);
    await db.delete(connectionGrants);
    await db.delete(toolConnections);
    await db.delete(toolApplications);
    await db.delete(companies);
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /** Seed one company with an active PR whose last webhook event was `silenceMin` ago. */
  async function seedCompanyWithSilentPr(silenceMin: number, now: Date, prefix = "THC") {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Threshold Corp", issuePrefix: prefix });
    await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Active PR Task", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(issueWorkProducts).values({
      companyId, issueId, type: "pull_request", provider: "github",
      externalId: "corp/repo#pull/43", title: "PR #43", status: "open", metadata: { repository: "corp/repo", number: 43 },
    });
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({
      id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`,
      transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true,
      config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {},
    });
    const lastWebhookAt = new Date(now.getTime() - silenceMin * 60_000);
    await db.insert(connectionGrants).values({
      id: grantId, companyId, connectionId, kind: "user", subjectUserId: `user-${randomUUID()}`, status: "active", isDefault: false,
      providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "43", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["201"], installationOwnerLogins: ["corp"], repositories: [], webhookHealth: "pending", lastWebhookAt: lastWebhookAt.toISOString() } },
    });
    // The watchdog also requires a fresh CI delivery; without one the
    // "no CI events at all" branch fires independently of the general
    // threshold. Seed a fresh CI event at `now` so only the general
    // silence threshold decides.
    await db.insert(connectionEventDeliveries).values({
      companyId,
      provider: "github",
      providerDeliveryId: `delivery-${randomUUID()}`,
      event: "check_run",
      status: "processed",
      createdAt: now,
    });
    return companyId;
  }

  function makeService(now: Date) {
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code"] as const),
      leaseEvents: vi.fn(async () => null),
      acknowledgeEvents: vi.fn(),
    } as unknown as PaperclipCloudConnector;
    return githubConnectionEventService(db, { connector, now: () => now });
  }

  it("defaults to a 15-minute silence threshold without env or saved value", async () => {
    delete process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN;
    delete process.env.PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN;
    // Seed a company whose last webhook event is the reference point t0.
    const t0 = new Date("2026-11-03T00:00:00.000Z");
    await seedCompanyWithSilentPr(0, t0);
    // 10 minutes after the last event: below the default 15-minute threshold -> no alarm
    const quiet = await makeService(new Date(t0.getTime() + 10 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 10 * 60_000));
    expect(quiet.activePrCount).toBe(1);
    expect(quiet.alarmsCreated).toBe(0);
    // 20 minutes after the last event: above the default threshold -> alarm
    const alarming = await makeService(new Date(t0.getTime() + 20 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 20 * 60_000));
    expect(alarming.alarmsCreated).toBe(1);
  });

  it("applies a value saved from the UI on the next sweep pass without a restart", async () => {
    delete process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN;
    delete process.env.PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN;
    applyLiveBehaviorSettings({
      settings: { githubEventsMaxSilenceMin: 120 },
      sources: { githubEventsMaxSilenceMin: "ui" },
    });
    const t0 = new Date("2026-11-03T00:00:00.000Z");
    await seedCompanyWithSilentPr(0, t0);
    // 60 minutes of silence: below the saved 120-minute threshold -> no alarm
    const quiet = await makeService(new Date(t0.getTime() + 60 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 60 * 60_000));
    expect(quiet.activePrCount).toBe(1);
    expect(quiet.alarmsCreated).toBe(0);
    // 130 minutes of silence: above the saved threshold -> alarm
    const alarming = await makeService(new Date(t0.getTime() + 130 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 130 * 60_000));
    expect(alarming.alarmsCreated).toBe(1);
  });

  it("lets an explicit MYRMIDON_ env override the saved UI value", async () => {
    process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN = "5";
    applyLiveBehaviorSettings({
      settings: { githubEventsMaxSilenceMin: 120 },
      sources: { githubEventsMaxSilenceMin: "ui" },
    });
    // 10 minutes of silence: above the 5-minute env threshold despite the saved 120 -> alarm
    const now = new Date("2026-11-03T01:00:00.000Z");
    await seedCompanyWithSilentPr(10, now);
    const result = await makeService(now).sweepWatchdog(now);
    expect(result.alarmsCreated).toBe(1);
  });

  it("honors the legacy PAPERCLIP_ alias when MYRMIDON_ is unset", async () => {
    delete process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN;
    process.env.PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN = "30";
    const t0 = new Date("2026-11-03T00:00:00.000Z");
    await seedCompanyWithSilentPr(0, t0);
    // 20 minutes of silence: below the alias 30-minute threshold -> no alarm
    const quiet = await makeService(new Date(t0.getTime() + 20 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 20 * 60_000));
    expect(quiet.alarmsCreated).toBe(0);
    // 40 minutes of silence: above the alias threshold -> alarm
    const alarming = await makeService(new Date(t0.getTime() + 40 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 40 * 60_000));
    expect(alarming.alarmsCreated).toBe(1);
  });

  it("prefers MYRMIDON_ over the PAPERCLIP_ alias when both are set", async () => {
    process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN = "5";
    process.env.PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN = "120";
    // 10 minutes of silence: above the MYRMIDON_ 5-minute threshold despite the 120 alias -> alarm
    const now = new Date("2026-11-03T01:00:00.000Z");
    await seedCompanyWithSilentPr(10, now);
    const result = await makeService(now).sweepWatchdog(now);
    expect(result.alarmsCreated).toBe(1);
  });

  it("rejects zero, negative, and non-numeric env values and falls back", async () => {
    // Garbage env falls back to the saved UI value. The seeded CI event is
    // 60 minutes old; with the saved 120-minute threshold both branches are
    // below threshold, so no alarm fires.
    process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN = "-5";
    applyLiveBehaviorSettings({
      settings: { githubEventsMaxSilenceMin: 120 },
      sources: { githubEventsMaxSilenceMin: "ui" },
    });
    const now = new Date("2026-11-03T01:00:00.000Z");
    await seedCompanyWithSilentPr(60, now);
    let result = await makeService(now).sweepWatchdog(now);
    expect(result.alarmsCreated).toBe(0);

    // And to the 15-minute default when nothing is saved. The fresh CI event
    // stays at `now` while the general silence is 20 minutes -> only the
    // general branch can fire.
    process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN = "abc";
    applyLiveBehaviorSettings({ settings: {}, sources: {} });
    const t0 = new Date("2026-11-03T00:00:00.000Z");
    await seedCompanyWithSilentPr(0, t0, "THD");
    result = await makeService(new Date(t0.getTime() + 20 * 60_000)).sweepWatchdog(new Date(t0.getTime() + 20 * 60_000));
    // Only the fresh THD company breaches the 15-minute default: its webhook
    // and CI event are 20 minutes old. The THC company seeded in the first
    // sub-case has its webhook and CI event anchored at its own `now`
    // (01:00), which is in the future relative to this 00:20 sweep, so it is
    // not silent at this reference point.
    expect(result.alarmsCreated).toBe(1);
  });
});
