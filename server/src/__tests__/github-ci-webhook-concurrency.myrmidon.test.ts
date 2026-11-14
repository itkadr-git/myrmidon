// myrmidon(EMPTY-RUNS-3): deliveries of one pull request run one after another.
//
// On 13.11 a dozen jobs of one pull request finished within a second; their
// deliveries took the work-product rows of the pull request in their own order,
// Postgres killed one of each pair with `deadlock detected` (40P01), the webhook
// answered 500 and the event was lost. Pins, through the real event service:
//   - a delivery waits while another transaction holds the advisory lock of its
//     pull request, and does nothing before it gets it (on the old code it
//     did not wait and had written already);
//   - two deliveries of one pull request at once both finish with no error and
//     both are applied; the metadata of the rows is merged by Postgres, so a
//     key written by someone else is kept;
//   - a delivery of another pull request does not wait for the lock.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  connectionEventDeliveries,
  connectionGrants,
  createDb,
  externalObjects,
  issueWorkProducts,
  issues,
  toolApplications,
  toolConnections,
} from "@myrmidon/db";
import { eq, sql } from "drizzle-orm";
import { githubConnectionEventService } from "../services/github-connection-events.js";
import type { PaperclipCloudConnector } from "../services/paperclip-cloud-connector.js";
import type { CiReturnFacts } from "../myrmidon/review-return-guard/ci-failure-return.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const REPO = "paperclipai/paperclip";
const HEAD = "a".repeat(40);
const GREEN_HEAD: CiReturnFacts = { state: "ok", failed: [], finished: true, hasFinalCheck: true, finalCheckConclusion: "success" };

describeEmbeddedPostgres.sequential("deliveries of one pull request are serialized (EMPTY-RUNS-3)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-ci-webhook-concurrency-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

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

  type Seeded = { companyId: string; grantId: string; issueIds: string[] };

  /** One company, a GitHub connection, and `tasks` tasks that carry the work-product row of pull request 123. */
  async function seed(tasks = 2): Promise<Seeded> {
    const companyId = randomUUID();
    const executorId = randomUUID();
    const connectionId = randomUUID();
    const grantId = randomUUID();
    const applicationId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Paperclip", issuePrefix: "GWC" });
    await db.insert(agents).values({ id: executorId, companyId, name: "worker", role: "engineer" });
    const issueIds: string[] = [];
    for (let index = 0; index < tasks; index += 1) {
      const issueId = randomUUID();
      issueIds.push(issueId);
      await db.insert(issues).values({
        id: issueId, companyId, title: `PR task ${index}`, workMode: "standard", status: "in_progress", assigneeAgentId: executorId,
      });
      await db.insert(issueWorkProducts).values({
        companyId, issueId, type: "pull_request", provider: "github", externalId: `${REPO}#pull/123`, title: "PR #123", status: "open",
        metadata: { repository: REPO, number: 123, keptByDelivery: `row-${index}` },
      });
    }
    await db.insert(toolApplications).values({ id: applicationId, companyId, applicationKey: `github-${randomUUID()}`, name: "GitHub", type: "mcp_server", status: "active" });
    await db.insert(toolConnections).values({ id: connectionId, companyId, applicationId, name: "GitHub", uid: `github-${randomUUID()}`, transport: "mcp_remote", authKind: "oauth", credentialPolicy: "per_user", status: "active", enabled: true, config: { sourceTemplateKey: "github", oauth: { connectorProfile: "github.code" } }, transportConfig: {} });
    await db.insert(connectionGrants).values({ id: grantId, companyId, connectionId, kind: "user", subjectUserId: `github-owner-${randomUUID()}`, status: "active", isDefault: false, providerTenant: { oauth: { strategy: "paperclip_cloud_connector", accessTokenExpiresAt: null }, github: { userId: "42", login: "octocat", installationCount: 1, repositoryCount: 1, repositorySelection: "selected", installationIds: ["101"], installationOwnerLogins: ["paperclipai"], repositories: [], webhookHealth: "pending" } } });
    return { companyId, grantId, issueIds };
  }

  function ciEvent(seeded: Seeded, conclusion: string | null, checkName: string, number = 123) {
    return {
      id: `ci-delivery-${randomUUID()}`, provider: "github" as const, event: "check_run" as const, action: conclusion ? "completed" : "created", installationId: "101", repositoryId: "99",
      createdAt: "2026-09-04T12:00:00.000Z", bindingIds: [`${seeded.grantId}_101`],
      payload: {
        repository: REPO, pullRequest: { number }, number,
        status: conclusion ? "completed" : "in_progress", conclusion,
        headSha: HEAD, runId: randomUUID(), htmlUrl: "https://github.com/paperclipai/paperclip/actions/runs/456", checkSuiteId: "789", checkName,
      },
    };
  }

  type Delivery = ReturnType<typeof ciEvent>;

  /** A service that leases the one batch handed to `deliver`; several can run at once. */
  function startService() {
    let batch: Delivery[] = [];
    const connector = {
      getCapabilities: vi.fn(async () => ["github.code"] as const), startAuthorization: vi.fn(), claim: vi.fn(), refresh: vi.fn(), revoke: vi.fn(),
      setWebhookBinding: vi.fn(async () => undefined),
      leaseEvents: vi.fn(async () => ({ leaseId: randomUUID(), events: batch })),
      acknowledgeEvents: vi.fn(async () => batch.length),
    } as unknown as PaperclipCloudConnector;
    const service = githubConnectionEventService(db, {
      connector,
      assignmentWakeup: vi.fn(async () => undefined),
      now: () => new Date(),
      resolveCiReturnFacts: vi.fn(async () => GREEN_HEAD),
    });
    return {
      deliver(events: Delivery[]) {
        batch = events;
        return service.pollOnce();
      },
    };
  }

  async function productsOf(seeded: Seeded) {
    return db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, seeded.companyId));
  }

  async function receiptStatuses(seeded: Seeded) {
    const rows = await db.select().from(connectionEventDeliveries).where(eq(connectionEventDeliveries.companyId, seeded.companyId));
    return rows.map((row) => row.status);
  }

  const lockKeyOf = (seeded: Seeded, number: number) => `github-pr:${seeded.companyId}:${REPO.toLowerCase()}#${number}`;

  /** Holds the advisory lock of a pull request in a transaction of its own until `release` is called. */
  async function holdLock(key: string) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let acquired!: () => void;
    const held = new Promise<void>((resolve) => { acquired = resolve; });
    const transaction = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      acquired();
      await gate;
    });
    await held;
    return { release, done: transaction };
  }

  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  it("waits for the lock of its pull request and writes nothing before it has it", async () => {
    const seeded = await seed(1);
    const lock = await holdLock(lockKeyOf(seeded, 123));
    const service = startService();

    const finished = service.deliver([ciEvent(seeded, "success", "CI result")]);
    await pause(400);

    // The receipt is written first, outside the transaction; the pull request is untouched.
    expect(await receiptStatuses(seeded)).toEqual(["received"]);
    expect((await productsOf(seeded))[0]!.metadata).not.toHaveProperty("lastCompletedCi");

    lock.release();
    await lock.done;
    await expect(finished).resolves.toMatchObject({ processed: 1, failed: 0 });
    expect(await receiptStatuses(seeded)).toEqual(["processed"]);
    expect((await productsOf(seeded))[0]!.metadata).toMatchObject({ lastCompletedCi: { final: true, conclusion: "success" } });
  });

  it("does not make a delivery of another pull request wait", async () => {
    const seeded = await seed(1);
    const lock = await holdLock(lockKeyOf(seeded, 999));
    try {
      await expect(startService().deliver([ciEvent(seeded, "success", "CI result")])).resolves.toMatchObject({ processed: 1, failed: 0 });
    } finally {
      lock.release();
      await lock.done;
    }
  });

  it("applies two deliveries of one pull request that arrive at once, both without an error", async () => {
    const seeded = await seed(3);
    const first = startService();
    const second = startService();

    // Two reports of the final result (two runs of it): both write the same rows.
    const [one, two] = await Promise.all([
      first.deliver([ciEvent(seeded, "success", "CI result")]),
      second.deliver([ciEvent(seeded, "success", "CI result")]),
    ]);

    expect(one).toMatchObject({ failed: 0 });
    expect(two).toMatchObject({ failed: 0 });
    expect(one.processed + two.processed).toBe(2);
    expect(await receiptStatuses(seeded)).toEqual(["processed", "processed"]);
    for (const product of await productsOf(seeded)) {
      // Merged by Postgres: the key of the row survives, and every row got the same record.
      expect(product.metadata).toMatchObject({ repository: REPO, number: 123 });
      expect(product.metadata).toHaveProperty("keptByDelivery");
      expect(product.metadata).toMatchObject({ lastCompletedCi: { final: true, conclusion: "success", headSha: HEAD }, activeCi: null });
    }
  });

  it("keeps the keys of the row that the delivery does not write", async () => {
    const seeded = await seed(1);
    await db.update(issueWorkProducts).set({ metadata: sql`${issueWorkProducts.metadata} || '{"ciReturnHold":{"headSha":"x"},"other":1}'::jsonb` }).where(eq(issueWorkProducts.companyId, seeded.companyId));

    await startService().deliver([ciEvent(seeded, "success", "CI result")]);

    expect((await productsOf(seeded))[0]!.metadata).toMatchObject({ ciReturnHold: { headSha: "x" }, other: 1, lastCompletedCi: { final: true } });
  });
});
