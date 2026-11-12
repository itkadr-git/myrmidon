// myrmidon(GITHUB-APP-WEBHOOK): CI and pull-request events from our own GitHub
// App reach the board — the signed public receiver, the shared event service
// and the operator endpoint that points the App's webhook at the board.
//
// Pins:
//   - pure: the HMAC check (constant-time, `sha256=<hex>` over the exact
//     bytes) and the translation of a raw GitHub body into the flat record
//     the connector path processes;
//   - a delivery signed with the entry's webhook secret is recorded in
//     connection_event_deliveries and a failed check_run goes through the
//     CI-completion path (issue back to the executor, executor woken);
//   - a bad, missing or foreign signature answers 401 and records nothing;
//     an App id that is not configured (or has no webhook secret) answers 204;
//   - a repository outside `allowedRepos`, a delivery without a repository,
//     rules that are off and companies that no longer exist are ignored; one
//     delivery id is processed once; every allowing company gets its receipt;
//   - webhook-sync creates the webhook secret once, sets the App's webhook with
//     the App JWT, answers what GitHub reports (never the secret), and a board
//     save that omits the secret id keeps it.

import express from "express";
import request from "supertest";
import { createHmac, generateKeyPairSync, randomInt, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  connectionEventDeliveries,
  createDb,
  issueWorkProducts,
  issues,
} from "@myrmidon/db";
import { errorHandler } from "../middleware/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { secretService } from "../services/secrets.js";
import {
  connectorPayloadFromGitHubWebhook,
  githubConnectionEventService,
} from "../services/github-connection-events.js";
import {
  GITHUB_APP_WEBHOOK_PATH,
  myrmidonGitHubAppWebhookRoutes,
  verifyGitHubWebhookSignature,
  type GitHubAppWebhookIngest,
} from "../myrmidon/github-app-webhook/index.js";
import { myrmidonGitHubSharedIdentityRoutes } from "../myrmidon/github-shared-identity/index.js";
import {
  defaultGitHubSharedIdentitySettings,
  normalizeGitHubAppPermissions,
  type GitHubAppEntry,
} from "../myrmidon/github-shared-identity/settings.js";
import {
  readGitHubSharedIdentitySettings,
  writeGitHubSharedIdentitySettings,
} from "../myrmidon/github-shared-identity/store.js";
import {
  forgetGitHubAppWebhookDisabledSignals,
  hasGitHubAppWebhookDisabledSignal,
} from "../myrmidon/github-shared-identity/webhook-disabled-signal.js";
import { attentionService } from "../services/attention.js";

// Made at run time: a literal looks like a real key to the secret scanner.
const WEBHOOK_SECRET = `test-${randomUUID()}`;
const REPO = "paperclipai/paperclip";
const HEAD_SHA = "a".repeat(40);
const NOW = new Date("2026-09-04T12:00:05.000Z");

function sign(body: string, secret = WEBHOOK_SECRET) {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const repositoryPart = { id: 99, full_name: REPO };

function checkRunBody(conclusion: string | null, status = "completed") {
  return {
    action: status === "completed" ? "completed" : "created",
    check_run: {
      id: 456,
      head_sha: HEAD_SHA,
      status,
      conclusion,
      html_url: "https://github.com/paperclipai/paperclip/runs/456",
      check_suite: { id: 789 },
      pull_requests: [{ number: 123 }],
    },
    repository: repositoryPart,
    installation: { id: 101 },
    sender: { id: 5, login: "octocat" },
  };
}

describe("GitHub App webhook: pure parts", () => {
  it("accepts only the HMAC-SHA256 of the exact bytes under the secret", () => {
    const body = Buffer.from('{"zen":"Design for failure."}');
    const good = sign(body.toString());
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, good)).toBe(true);
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, Buffer.from('{"zen":"Design for failure!"}'), good)).toBe(false);
    expect(verifyGitHubWebhookSignature("another-secret", body, good)).toBe(false);
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, undefined)).toBe(false);
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, good.replace("sha256=", "sha1="))).toBe(false);
    expect(verifyGitHubWebhookSignature(WEBHOOK_SECRET, body, good.slice(0, -2))).toBe(false);
    expect(verifyGitHubWebhookSignature("", body, sign(body.toString(), ""))).toBe(false);
  });

  it("translates a raw check_run, check_suite and workflow_run into the connector record", () => {
    expect(connectorPayloadFromGitHubWebhook("check_run", checkRunBody("failure"))).toEqual({
      event: "check_run",
      action: "completed",
      installationId: "101",
      repositoryId: "99",
      repository: REPO,
      senderId: "5",
      senderLogin: "octocat",
      number: 123,
      pullRequestNumber: 123,
      headSha: HEAD_SHA,
      status: "completed",
      conclusion: "failure",
      runId: "456",
      checkSuiteId: "789",
      htmlUrl: "https://github.com/paperclipai/paperclip/runs/456",
    });
    const suite = connectorPayloadFromGitHubWebhook("check_suite", {
      action: "completed",
      check_suite: { id: 789, head_sha: HEAD_SHA, status: "completed", conclusion: "success", pull_requests: [{ number: 123 }] },
      repository: repositoryPart,
    });
    expect(suite).toMatchObject({ checkSuiteId: "789", headSha: HEAD_SHA, conclusion: "success", pullRequestNumber: 123 });
    expect(suite).not.toHaveProperty("runId");
    expect(
      connectorPayloadFromGitHubWebhook("workflow_run", {
        action: "requested",
        workflow_run: {
          id: 1001,
          check_suite_id: 789,
          head_sha: HEAD_SHA,
          status: "queued",
          conclusion: null,
          html_url: "https://github.com/paperclipai/paperclip/actions/runs/1001",
          pull_requests: [{ number: 123 }],
        },
        repository: repositoryPart,
      }),
    ).toMatchObject({ runId: "1001", checkSuiteId: "789", status: "queued", pullRequestNumber: 123 });
  });

  it("translates a raw pull_request, marking a dirty merge state as CONFLICTING", () => {
    const body = (pullRequest: Record<string, unknown>) => ({
      action: "synchronize",
      number: 7,
      pull_request: {
        number: 7,
        state: "open",
        merged: false,
        title: "OPE-1 change",
        html_url: "https://github.com/paperclipai/paperclip/pull/7",
        updated_at: "2026-09-04T12:00:00Z",
        head: { ref: "bot/OPE-1", sha: HEAD_SHA },
        base: { ref: "main", sha: "c".repeat(40) },
        ...pullRequest,
      },
      repository: repositoryPart,
    });
    expect(connectorPayloadFromGitHubWebhook("pull_request", body({ mergeable: null, mergeable_state: "dirty" }))).toMatchObject({
      repository: REPO,
      number: 7,
      state: "open",
      merged: false,
      mergeable: "CONFLICTING",
      headRef: "bot/OPE-1",
      headSha: HEAD_SHA,
      baseRef: "main",
      url: "https://github.com/paperclipai/paperclip/pull/7",
    });
    expect(connectorPayloadFromGitHubWebhook("pull_request", body({ mergeable: true, mergeable_state: "clean" }))).toMatchObject({ mergeable: "MERGEABLE" });
    // GitHub computes it lazily: null is "unknown", not a verdict.
    expect(connectorPayloadFromGitHubWebhook("pull_request", body({ mergeable: null, mergeable_state: "unknown" }))).not.toHaveProperty("mergeable");
  });

  it("is public ingress ahead of the /api router, bound to the very service the server polls with", () => {
    const app = readFileSync(new URL("../app.ts", import.meta.url), "utf8");
    const receiver = app.indexOf("myrmidonGitHubAppWebhookRoutes(db");
    expect(receiver).toBeGreaterThan(app.indexOf("chatWebhookRoutes(chatChannels)"));
    expect(receiver).toBeLessThan(app.indexOf('app.use("/api", api)'));
    expect(app).toContain("ingest: () => app.locals.githubConnectionEvents ?? null");
    const server = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
    expect(server).toContain("app.locals.githubConnectionEvents = githubConnectionEvents;");
    expect(server.indexOf("const githubConnectionEvents = githubConnectionEventService(")).toBeLessThan(
      server.indexOf("app.locals.githubConnectionEvents = githubConnectionEvents;"),
    );
  });

  it("keeps a repository-less delivery repository-less", () => {
    expect(connectorPayloadFromGitHubWebhook("ping", { zen: "x", hook_id: 1 })).toEqual({ event: "ping" });
  });
});

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip).sequential("GitHub App webhook: receiver, ingest and sync", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-github-app-webhook-");
    db = createDb(database.connectionString);
  }, 30_000);

  afterAll(async () => {
    await database?.cleanup();
  }, 60_000);

  /** A GitHub App id of its own per test: the rules of every test live in one settings row. */
  function newAppId() {
    return String(randomInt(1_000_000, 900_000_000));
  }

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: companyId, issuePrefix: companyId.slice(0, 8) });
    return companyId;
  }

  async function vaultSecret(companyId: string, name: string, value: string) {
    return secretService(db).create(companyId, { name, provider: "local_encrypted", value }, {});
  }

  function appEntry(overrides: Partial<GitHubAppEntry> & Pick<GitHubAppEntry, "appId" | "privateKeySecretId">): GitHubAppEntry {
    return {
      id: randomUUID(),
      name: "Myrmidon — test",
      installationId: null,
      slug: null,
      roles: [],
      agentIds: [],
      allowedRepos: [REPO],
      permissions: normalizeGitHubAppPermissions(undefined),
      ...overrides,
    };
  }

  async function saveRules(companyId: string, entries: GitHubAppEntry[], enabled = true) {
    await writeGitHubSharedIdentitySettings(db, companyId, { ...defaultGitHubSharedIdentitySettings(), enabled, apps: entries });
  }

  /** A company whose App entry has a webhook secret in the vault. */
  async function seedReceivingCompany(appId: string, overrides: Partial<GitHubAppEntry> = {}, enabled = true) {
    const companyId = await seedCompany();
    const keySecretId = randomUUID();
    await db.insert(companySecrets).values({ id: keySecretId, companyId, key: keySecretId, name: `App key ${keySecretId}`, scope: "company" });
    const webhookSecret = await vaultSecret(companyId, `webhook-${appId}`, WEBHOOK_SECRET);
    const entry = appEntry({ appId, privateKeySecretId: keySecretId, webhookSecretId: webhookSecret.id, ...overrides });
    await saveRules(companyId, [entry], enabled);
    return { companyId, entry };
  }

  /** An in-review task whose pull request #123 is being checked, executor + reviewer. */
  async function seedReviewTask(companyId: string, status: "in_review" | "in_progress" = "in_review") {
    const executorId = randomUUID();
    const reviewerId = randomUUID();
    const issueId = randomUUID();
    await db.insert(agents).values({ id: executorId, companyId, name: "worker", role: "engineer" });
    await db.insert(agents).values({ id: reviewerId, companyId, name: "reviewer", role: "engineer" });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PR task",
      status,
      workMode: "standard",
      assigneeAgentId: reviewerId,
      executionState: {
        status: "pending",
        currentStageId: randomUUID(),
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: reviewerId },
        returnAssignee: { type: "agent", agentId: executorId },
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
      externalId: `${REPO}#pull/123`,
      title: "PR #123",
      status: "open",
      metadata: { repository: REPO, number: 123, headSha: HEAD_SHA },
    });
    return { executorId, reviewerId, issueId };
  }

  function receiver(ingest: () => GitHubAppWebhookIngest | null) {
    const app = express();
    app.use(
      express.json({
        verify: (req, _res, buf) => {
          (req as unknown as { rawBody: Buffer }).rawBody = buf;
        },
      }),
    );
    app.use(myrmidonGitHubAppWebhookRoutes(db, { ingest }));
    app.use(errorHandler);
    return app;
  }

  function deliver(
    app: express.Express,
    appId: string,
    payload: Record<string, unknown>,
    options: { event?: string; deliveryId?: string; signature?: string | null; secret?: string } = {},
  ) {
    const body = JSON.stringify(payload);
    const call = request(app)
      .post(GITHUB_APP_WEBHOOK_PATH)
      .set("content-type", "application/json")
      .set("x-github-hook-installation-target-id", appId)
      .set("x-github-event", options.event ?? "check_run")
      .set("x-github-delivery", options.deliveryId ?? randomUUID());
    if (options.signature !== null) call.set("x-hub-signature-256", options.signature ?? sign(body, options.secret));
    return call.send(body);
  }

  const deliveriesOf = (companyId: string) =>
    db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.companyId, companyId));

  describe("public receiver", () => {
    it("records a signed delivery and returns the task to its executor on a failed check_run", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      const { executorId, issueId } = await seedReviewTask(companyId);
      const wakeup = vi.fn(async () => undefined);
      const service = githubConnectionEventService(db, { assignmentWakeup: wakeup, now: () => NOW });
      const deliveryId = randomUUID();

      const res = await deliver(receiver(() => service), appId, checkRunBody("failure"), { deliveryId });

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ companies: 1, processed: 1, duplicate: 0, ignored: 0 });
      const [receipt] = await deliveriesOf(companyId);
      expect(receipt).toMatchObject({
        provider: "github",
        providerDeliveryId: deliveryId,
        event: "check_run",
        action: "completed",
        installationId: "101",
        repositoryId: "99",
        status: "processed",
        attempts: 1,
      });
      expect(receipt?.normalizedPayload).toMatchObject({
        repository: REPO,
        headSha: HEAD_SHA,
        conclusion: "failure",
        status: "completed",
        runId: "456",
        checkSuiteId: "789",
        pullRequestNumber: 123,
      });
      // The CI-completion path ran: the task is back with its executor, who is woken.
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task).toMatchObject({ status: "in_progress", assigneeAgentId: executorId });
      expect(wakeup).toHaveBeenCalledTimes(1);
      expect(wakeup).toHaveBeenCalledWith(
        executorId,
        expect.objectContaining({
          reason: "ci_completed",
          payload: expect.objectContaining({ conclusion: "failure", headSha: HEAD_SHA, pullRequestNumber: 123, deliveryId }),
        }),
      );
      const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
      expect(product?.metadata).toMatchObject({ activeCi: null, lastCompletedCi: { headSha: HEAD_SHA, conclusion: "failure", runId: "456" } });
      // No connector binding exists: the activity entry names the App instead.
      const [activity] = await db
        .select()
        .from(activityLog)
        .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "tool_connection.webhook_processed")));
      expect(activity).toMatchObject({ entityType: "tool_connection", entityId: `github-app:${appId}` });
    });

    it("tracks a running check_run as the active CI of the exact head", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      const { issueId } = await seedReviewTask(companyId, "in_progress");
      const service = githubConnectionEventService(db, { assignmentWakeup: vi.fn(async () => undefined), now: () => NOW });

      const res = await deliver(receiver(() => service), appId, checkRunBody(null, "in_progress"));

      expect(res.status).toBe(202);
      const [product] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, issueId));
      expect(product?.metadata).toMatchObject({ activeCi: { repository: REPO, number: 123, headSha: HEAD_SHA, status: "in_progress", runId: "456" } });
    });

    it("applies a raw merged pull_request to the linked task", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      const agentId = randomUUID();
      const issueId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "worker", role: "engineer" });
      await db.insert(issues).values({ id: issueId, companyId, title: "PR task", status: "in_progress", assigneeAgentId: agentId });
      await db.insert(issueWorkProducts).values({
        companyId,
        issueId,
        type: "pull_request",
        provider: "github",
        externalId: `${REPO}#pull/123`,
        title: "PR #123",
        status: "open",
        metadata: { repository: REPO, number: 123 },
      });
      const service = githubConnectionEventService(db, { now: () => NOW });

      const res = await deliver(
        receiver(() => service),
        appId,
        {
          action: "closed",
          number: 123,
          pull_request: {
            number: 123,
            state: "closed",
            merged: true,
            merged_at: "2026-09-04T11:59:00Z",
            updated_at: "2026-09-04T12:00:00Z",
            html_url: "https://github.com/paperclipai/paperclip/pull/123",
            title: "PR #123",
            head: { ref: "bot/GHE-1", sha: HEAD_SHA },
            base: { ref: "main", sha: "c".repeat(40) },
            mergeable: null,
            mergeable_state: "unknown",
          },
          repository: repositoryPart,
          installation: { id: 101 },
        },
        { event: "pull_request" },
      );

      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({ processed: 1 });
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task?.status).toBe("done");
    });

    it("answers 401 and records nothing for a bad, missing or foreign signature", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      const { issueId } = await seedReviewTask(companyId);
      const wakeup = vi.fn(async () => undefined);
      const service = githubConnectionEventService(db, { assignmentWakeup: wakeup, now: () => NOW });
      const app = receiver(() => service);
      const payload = checkRunBody("failure");

      const wrongSecret = await deliver(app, appId, payload, { secret: "another-secret" });
      const missing = await deliver(app, appId, payload, { signature: null });
      const malformed = await deliver(app, appId, payload, { signature: "sha256=not-hex" });
      // A signature of different bytes than the ones sent.
      const otherBytes = await deliver(app, appId, payload, { signature: sign(JSON.stringify({ ...payload, action: "created" })) });

      for (const res of [wrongSecret, missing, malformed, otherBytes]) {
        expect(res.status).toBe(401);
        expect(JSON.stringify(res.body)).not.toContain(WEBHOOK_SECRET);
      }
      expect(await deliveriesOf(companyId)).toEqual([]);
      expect(wakeup).not.toHaveBeenCalled();
      const [task] = await db.select().from(issues).where(eq(issues.id, issueId));
      expect(task?.status).toBe("in_review");
    });

    it("answers 204 for an App id that is not configured or has no webhook secret", async () => {
      const appId = newAppId();
      const ingest = vi.fn();
      const app = receiver(() => ({ ingestAppWebhook: ingest }));
      const unknown = await deliver(app, newAppId(), checkRunBody("failure"));
      expect(unknown.status).toBe(204);

      const companyId = await seedCompany();
      const keySecretId = randomUUID();
      await db.insert(companySecrets).values({ id: keySecretId, companyId, key: keySecretId, name: `App key ${keySecretId}`, scope: "company" });
      await saveRules(companyId, [appEntry({ appId, privateKeySecretId: keySecretId })]);
      const noSecret = await deliver(app, appId, checkRunBody("failure"));
      expect(noSecret.status).toBe(204);

      const noHeader = await request(app).post(GITHUB_APP_WEBHOOK_PATH).set("content-type", "application/json").send("{}");
      expect(noHeader.status).toBe(204);
      expect(ingest).not.toHaveBeenCalled();
      expect(await deliveriesOf(companyId)).toEqual([]);
    });

    it("answers 400 for a verified delivery without an event name, and 503 while the service is not up", async () => {
      const appId = newAppId();
      await seedReceivingCompany(appId);
      const payload = checkRunBody("failure");

      const body = JSON.stringify(payload);
      const noEvent = await request(receiver(() => ({ ingestAppWebhook: vi.fn() })))
        .post(GITHUB_APP_WEBHOOK_PATH)
        .set("content-type", "application/json")
        .set("x-github-hook-installation-target-id", appId)
        .set("x-github-delivery", randomUUID())
        .set("x-hub-signature-256", sign(body))
        .send(body);
      expect(noEvent.status).toBe(400);

      const notReady = await deliver(receiver(() => null), appId, payload);
      expect(notReady.status).toBe(503);
    });

    it("processes a delivery id once: a redelivery is a duplicate and wakes nobody", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      await seedReviewTask(companyId);
      const wakeup = vi.fn(async () => undefined);
      const service = githubConnectionEventService(db, { assignmentWakeup: wakeup, now: () => NOW });
      const app = receiver(() => service);
      const deliveryId = randomUUID();

      const first = await deliver(app, appId, checkRunBody("failure"), { deliveryId });
      const second = await deliver(app, appId, checkRunBody("failure"), { deliveryId });

      expect(first.body).toEqual({ companies: 1, processed: 1, duplicate: 0, ignored: 0 });
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ companies: 1, processed: 0, duplicate: 1, ignored: 0 });
      expect(await deliveriesOf(companyId)).toHaveLength(1);
      expect(wakeup).toHaveBeenCalledTimes(1);
    });
  });

  describe("ingestAppWebhook", () => {
    const input = (appId: string, payload: Record<string, unknown>, eventName = "check_run") => ({
      appId,
      deliveryId: randomUUID(),
      eventName,
      payload,
    });

    it("ignores a repository outside allowedRepos and records nothing", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId, { allowedRepos: ["paperclipai/other"] });
      const service = githubConnectionEventService(db, { now: () => NOW });

      await expect(service.ingestAppWebhook(input(appId, checkRunBody("failure")))).resolves.toEqual({
        companies: 0,
        processed: 0,
        duplicate: 0,
        ignored: 1,
      });
      expect(await deliveriesOf(companyId)).toEqual([]);
    });

    it("matches the repository case-insensitively and by pattern", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId, { allowedRepos: ["PaperclipAI/*"] });
      const service = githubConnectionEventService(db, { now: () => NOW });
      const payload = { ...checkRunBody("success"), repository: { id: 99, full_name: "paperclipai/Paperclip" } };

      await expect(service.ingestAppWebhook(input(appId, payload))).resolves.toMatchObject({ companies: 1, processed: 1 });
      expect(await deliveriesOf(companyId)).toHaveLength(1);
    });

    it("ignores a delivery that names no repository (installation, ping)", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId);
      const service = githubConnectionEventService(db, { now: () => NOW });

      await expect(
        service.ingestAppWebhook(input(appId, { action: "created", installation: { id: 101 } }, "installation")),
      ).resolves.toEqual({ companies: 0, processed: 0, duplicate: 0, ignored: 1 });
      expect(await deliveriesOf(companyId)).toEqual([]);
    });

    it("ignores companies whose rules are off", async () => {
      const appId = newAppId();
      const { companyId } = await seedReceivingCompany(appId, {}, false);
      const service = githubConnectionEventService(db, { now: () => NOW });

      await expect(service.ingestAppWebhook(input(appId, checkRunBody("failure")))).resolves.toMatchObject({ companies: 0, ignored: 1 });
      expect(await deliveriesOf(companyId)).toEqual([]);
    });

    it("gives every allowing company its own receipt and skips a company that no longer exists", async () => {
      const appId = newAppId();
      const first = await seedReceivingCompany(appId);
      const second = await seedReceivingCompany(appId);
      const deleted = await seedCompany();
      await saveRules(deleted, [appEntry({ appId, privateKeySecretId: randomUUID() })]);
      await db.delete(companies).where(eq(companies.id, deleted));
      const service = githubConnectionEventService(db, { now: () => NOW });

      await expect(service.ingestAppWebhook(input(appId, checkRunBody("success")))).resolves.toEqual({
        companies: 2,
        processed: 2,
        duplicate: 0,
        ignored: 0,
      });
      expect(await deliveriesOf(first.companyId)).toHaveLength(1);
      expect(await deliveriesOf(second.companyId)).toHaveLength(1);
    });
  });

  describe("webhook-sync", () => {
    const PUBLIC_URL = "https://board.example.com/api/myrmidon/github-app/webhook";
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const operator = { type: "board", source: "local_implicit", userId: "local-board", isInstanceAdmin: true };

    type HookCall = { method: string; authorization: string; body: Record<string, unknown> | null };
    const hook = { calls: [] as HookCall[], config: null as Record<string, unknown> | null, patchStatus: 200 };
    const fakeFetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (String(url) !== "https://api.github.com/app/hook/config") return new Response("{}", { status: 404 });
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
      hook.calls.push({ method, authorization: String((init?.headers as Record<string, string>).authorization), body });
      if (method === "PATCH") {
        if (hook.patchStatus !== 200) return new Response('{"message":"nope"}', { status: hook.patchStatus });
        // GitHub echoes the secret masked.
        hook.config = { url: body!.url, content_type: body!.content_type, insecure_ssl: body!.insecure_ssl, secret: "********" };
      }
      return Response.json(hook.config ?? { url: "https://old.example.com/hook", content_type: "json", insecure_ssl: "0" });
    });

    beforeEach(() => {
      vi.stubGlobal("fetch", fakeFetch);
      hook.calls = [];
      hook.config = null;
      hook.patchStatus = 200;
      fakeFetch.mockClear();
      forgetGitHubAppWebhookDisabledSignals();
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function server(actor: Record<string, unknown> = operator) {
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => {
        (req as unknown as { actor: unknown }).actor = actor;
        next();
      });
      app.use("/api", myrmidonGitHubSharedIdentityRoutes(db));
      app.use(errorHandler);
      return app;
    }

    const rulesPath = (companyId: string) => `/api/myrmidon/companies/${companyId}/github-shared-identity`;
    const syncPath = (companyId: string, entryId: string) => `${rulesPath(companyId)}/apps/${entryId}/webhook-sync`;

    /** A company with an App entry that has a real private key and no webhook secret yet. */
    async function seedEntry() {
      const companyId = await seedCompany();
      const appId = newAppId();
      const key = await vaultSecret(companyId, `key-${appId}`, KEY_PEM);
      const entry = appEntry({ appId, privateKeySecretId: key.id });
      await saveRules(companyId, [entry]);
      return { companyId, appId, entry, keySecretId: key.id };
    }

    const webhookSecretsOf = async (companyId: string, keySecretId: string) =>
      (await db.select().from(companySecrets).where(eq(companySecrets.companyId, companyId))).filter((row) => row.id !== keySecretId);

    it("creates the webhook secret once, sets the App's webhook with the App JWT and answers what GitHub reports", async () => {
      const { companyId, entry, keySecretId } = await seedEntry();

      const res = await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ url: PUBLIC_URL, contentType: "json" });
      const [patch, readback] = hook.calls;
      expect(patch).toMatchObject({ method: "PATCH", body: { url: PUBLIC_URL, content_type: "json", insecure_ssl: "0" } });
      expect(patch?.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
      expect(readback).toMatchObject({ method: "GET" });

      // The secret GitHub received is the one the entry now references — and only there.
      const stored = (await readGitHubSharedIdentitySettings(db, companyId)).apps[0]!;
      expect(stored.webhookSecretId).toEqual(expect.any(String));
      const sentSecret = String(patch!.body!.secret);
      expect(sentSecret).toMatch(/^[0-9a-f]{64}$/);
      await expect(secretService(db).resolveSecretValue(companyId, stored.webhookSecretId!, "latest")).resolves.toBe(sentSecret);
      expect(JSON.stringify(res.body) + res.text).not.toContain(sentSecret);
      expect(await webhookSecretsOf(companyId, keySecretId)).toHaveLength(1);
    });

    it("reuses the stored secret on a second sync and creates no second one", async () => {
      const { companyId, entry, keySecretId } = await seedEntry();
      const app = server();

      await request(app).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL }).expect(200);
      await request(app).post(syncPath(companyId, entry.id)).send({ webhookUrl: "https://board2.example.com/api/myrmidon/github-app/webhook" }).expect(200);

      const patches = hook.calls.filter((call) => call.method === "PATCH");
      expect(patches).toHaveLength(2);
      expect(patches[1]!.body!.secret).toBe(patches[0]!.body!.secret);
      expect(patches[1]!.body!.url).toBe("https://board2.example.com/api/myrmidon/github-app/webhook");
      expect(await webhookSecretsOf(companyId, keySecretId)).toHaveLength(1);
    });

    it("keeps the secret and answers 502 when GitHub refuses, so the retry reuses it", async () => {
      const { companyId, entry, keySecretId } = await seedEntry();
      hook.patchStatus = 403;

      const refused = await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL });
      expect(refused.status).toBe(502);
      expect(refused.text).not.toContain("nope");

      hook.patchStatus = 200;
      await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL }).expect(200);
      expect(await webhookSecretsOf(companyId, keySecretId)).toHaveLength(1);
    });

    it("myrmidon(OPE-12868): raises a critical attention card on HTTP 404 from GitHub on webhook-sync, and clears it on recovery", async () => {
      const { companyId, entry, keySecretId } = await seedEntry();
      hook.patchStatus = 404;

      // 1. GitHub returns 404 on the PATCH (webhook not Active in App settings).
      const refused = await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL });
      expect(refused.status).toBe(502);
      expect(refused.body).toMatchObject({ code: "github_webhook_sync_failed" });
      expect(refused.text).toContain("404");

      // 2. The signal latch is tripped.
      expect(hasGitHubAppWebhookDisabledSignal(companyId, entry.id)).toBe(true);

      // 3. The attention feed surfaces the card with critical severity and operator guidance.
      const feed = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
      const card = feed.items.find((item) => item.sourceKind === "github_app_webhook_disabled");
      expect(card).toBeDefined();
      expect(card!.severity).toBe("critical");
      expect(card!.subject.title).toContain("GitHub App webhook disabled");
      expect(card!.whyNow).toContain("Webhook → Active");
      expect(card!.whyNow).toContain("Settings → Developer settings → GitHub Apps");
      expect(card!.detail).toMatchObject({ kind: "generic" });
      expect((card!.detail as { summaryExcerpt: string }).summaryExcerpt).toContain("not Active");

      // 4. Operator flips the switch in GitHub App settings -> webhook-sync is re-run and succeeds (200).
      hook.patchStatus = 200;
      const recovered = await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL });
      expect(recovered.status).toBe(200);

      // 5. The latch is cleared immediately.
      expect(hasGitHubAppWebhookDisabledSignal(companyId, entry.id)).toBe(false);

      // 6. The attention feed automatically drops the card.
      const feedAfter = await attentionService(db, { feedCacheTtlMs: 0 }).list(companyId);
      const cardAfter = feedAfter.items.find((item) => item.sourceKind === "github_app_webhook_disabled");
      expect(cardAfter).toBeUndefined();

      // Secret was preserved throughout.
      expect(await webhookSecretsOf(companyId, keySecretId)).toHaveLength(1);
    });

    it("refuses a URL that is not a plain https URL before touching GitHub", async () => {
      const { companyId, entry, keySecretId } = await seedEntry();
      for (const webhookUrl of [
        "http://board.example.com/api/myrmidon/github-app/webhook",
        "https://board.example.com/api/myrmidon/github-app/webhook?token=x",
        "https://user:pw@board.example.com/api/myrmidon/github-app/webhook",
      ]) {
        const res = await request(server()).post(syncPath(companyId, entry.id)).send({ webhookUrl });
        expect(res.status).toBe(422);
      }
      expect((await request(server()).post(syncPath(companyId, entry.id)).send({})).status).toBe(400);
      expect(fakeFetch).not.toHaveBeenCalled();
      expect(await webhookSecretsOf(companyId, keySecretId)).toEqual([]);
    });

    it("answers 404 for an unknown entry and 403 for an agent or a board user outside the company", async () => {
      const { companyId, entry } = await seedEntry();
      expect((await request(server()).post(syncPath(companyId, randomUUID())).send({ webhookUrl: PUBLIC_URL })).status).toBe(404);

      const agent = { type: "agent", agentId: randomUUID(), companyId, source: "agent_key" };
      expect((await request(server(agent)).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL })).status).toBe(403);
      const outsider = { type: "board", source: "session", userId: "someone", isInstanceAdmin: false, companyIds: [], memberships: [] };
      expect((await request(server(outsider)).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL })).status).toBe(403);
      expect(fakeFetch).not.toHaveBeenCalled();
    });

    it("keeps the webhook secret id over a board save that omits it, and clears it on an explicit null", async () => {
      const { companyId, entry } = await seedEntry();
      const app = server();
      await request(app).post(syncPath(companyId, entry.id)).send({ webhookUrl: PUBLIC_URL }).expect(200);
      const secretId = (await readGitHubSharedIdentitySettings(db, companyId)).apps[0]!.webhookSecretId;
      expect(secretId).toEqual(expect.any(String));

      // What the board UI sends: the entry without the server-owned field.
      const view = await request(app).get(rulesPath(companyId)).expect(200);
      const { version: _version, ...settings } = view.body.settings;
      const withoutField = {
        ...settings,
        apps: settings.apps.map(({ webhookSecretId: _omitted, ...rest }: Record<string, unknown>) => rest),
      };
      await request(app).put(rulesPath(companyId)).send(withoutField).expect(200);
      expect((await readGitHubSharedIdentitySettings(db, companyId)).apps[0]!.webhookSecretId).toBe(secretId);

      const cleared = {
        ...withoutField,
        apps: withoutField.apps.map((rest: Record<string, unknown>) => ({ ...rest, webhookSecretId: null })),
      };
      await request(app).put(rulesPath(companyId)).send(cleared).expect(200);
      expect((await readGitHubSharedIdentitySettings(db, companyId)).apps[0]!.webhookSecretId ?? null).toBeNull();
    });

    it("refuses a webhook secret id that is not a secret of the company", async () => {
      const { companyId } = await seedEntry();
      const app = server();
      const view = await request(app).get(rulesPath(companyId)).expect(200);
      const { version: _version, ...settings } = view.body.settings;
      const res = await request(app)
        .put(rulesPath(companyId))
        .send({ ...settings, apps: settings.apps.map((rest: Record<string, unknown>) => ({ ...rest, webhookSecretId: randomUUID() })) });
      expect(res.status).toBe(422);
    });
  });
});
