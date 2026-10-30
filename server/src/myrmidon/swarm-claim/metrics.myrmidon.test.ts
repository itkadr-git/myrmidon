import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, createDb, issueClaims, issues, type Db } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { insertClaim, releaseClaim } from "./store.js";

import { swarmClaimMetrics } from "./metrics.js";
import { createSwarmClaimSweeper } from "./sweep.js";
import { createSwarmSupervisorReleasePort } from "../swarm-claim-supervisor/rebalance.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
let db: Db;
let tempDb: EmbeddedPostgresTestDatabase | undefined;

const companyId = randomUUID();
const issueId = randomUUID();
const agentOne = randomUUID();
const agentTwo = randomUUID();

const support = await getEmbeddedPostgresTestSupport();
if (process.env.CI && !support.supported && !externalTestDatabaseUrl) {
  throw new Error("Claim metrics acceptance tests require PostgreSQL in CI; refusing a skipped suite.");
}
const describeDatabase = support.supported || externalTestDatabaseUrl ? describe : describe.skip;

async function seedFixture() {
  await db.insert(companies).values({
    id: companyId,
    name: `Swarm Metrics ${companyId.slice(0, 8)}`,
    issuePrefix: `SM${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
  });
  await db.insert(agents).values([
    {
      id: agentOne,
      companyId,
      name: "claim-agent-one",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
    {
      id: agentTwo,
      companyId,
      name: "claim-agent-two",
      role: "engineer",
      status: "idle",
      adapterType: "paperclip_runner",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    },
  ]);
  await db.insert(issues).values({
    id: issueId,
    companyId,
    title: "one task, two claimants",
    status: "todo",
    priority: "medium",
  });
}

function claimInput(agentId: string, now: Date) {
  return {
    companyId,
    issueId,
    agentId,
    role: "engineer",
    runId: null,
    origin: "auto_match" as const,
    claimedAt: now,
    heartbeatAt: now,
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
  };
}

async function liveClaimCount(): Promise<number> {
  const rows = await db
    .select({ id: issueClaims.id })
    .from(issueClaims)
    .where(and(eq(issueClaims.issueId, issueId), isNull(issueClaims.releasedAt)));
  return rows.length;
}

describeDatabase("swarm claim transaction metrics", () => {
  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = (await startEmbeddedPostgresTestDatabase("paperclip-claim-metrics-")) as EmbeddedPostgresTestDatabase;
      db = createDb(tempDb.connectionString);
    }
    await seedFixture();
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.delete(issueClaims).where(eq(issueClaims.issueId, issueId));
      await db.delete(issues).where(eq(issues.id, issueId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    swarmClaimMetrics.reset();
    await tempDb?.cleanup();
  }, 60_000);

  it("counts exactly one conflict for two concurrent claimants", async () => {
    swarmClaimMetrics.reset();
    const now = new Date();
    const claims = await Promise.all([
      insertClaim(db, claimInput(agentOne, now)),
      insertClaim(db, claimInput(agentTwo, now)),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect(await liveClaimCount()).toBe(1);
    expect(swarmClaimMetrics.read().conflicts).toBe(1);
    await releaseClaim(db, { claimId: claims.find(Boolean)!.id, reason: "run_finished" });
    expect(swarmClaimMetrics.read().recovered).toEqual({ lease_expired: 0, supervisor_rebalance: 0 });
  }, 30_000);

  it("counts a lease once after expiry sweep and not again on the next sweep", async () => {
    swarmClaimMetrics.reset();
    const now = new Date();
    const claim = await insertClaim(db, {
      ...claimInput(agentOne, new Date(now.getTime() - 120_000)),
      expiresAt: new Date(now.getTime() - 1_000),
    });
    expect(claim).not.toBeNull();
    const sweeper = createSwarmClaimSweeper({
      db,
      settings: { getGeneral: async () => ({ swarmClaim: {
        enabled: true, leaseTtlSec: 900, maxActiveTasks: 3,
        sweepIntervalSec: 5, p0Preemption: true, pheromone: {},
      } }) as never },
      env: {}, intervalMs: 0,
      hostMemoryGate: () => ({ state: "open" } as never),
      hostCpuGate: () => ({ state: "open" } as never),
    });
    expect((await sweeper.sweep(now)).expiredReleased).toBe(1);
    expect(swarmClaimMetrics.read().recovered.lease_expired).toBe(1);
    sweeper.resetForTest();
    expect((await sweeper.sweep(now)).expiredReleased).toBe(0);
    expect(swarmClaimMetrics.read().recovered.lease_expired).toBe(1);
    expect(await liveClaimCount()).toBe(0);
  }, 30_000);

  it("counts only the successful supervisor release, not retries or other reasons", async () => {
    swarmClaimMetrics.reset();
    const claim = await insertClaim(db, claimInput(agentOne, new Date()));
    expect(claim).not.toBeNull();
    const port = createSwarmSupervisorReleasePort(db, {});
    const release = () => port.releaseClaim(companyId, claim!.id, "supervisor_rebalance", new Date());
    const results = await Promise.all([release(), release()]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(swarmClaimMetrics.read().recovered).toEqual({ lease_expired: 0, supervisor_rebalance: 1 });
  }, 30_000);
});
