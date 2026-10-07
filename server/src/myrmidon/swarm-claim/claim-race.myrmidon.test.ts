// 1.6.5 (OPE-5401 ч.A / SWARM-CLAIM-UNIQUE-INDEX): the capture path under the race.
//
// Two board processes used to pass the advisory liveness pre-check in the same
// window and both lease the same issue. The database now owns the rule — the
// partial unique index `issue_claims_issue_active_uq`
// (issue_id WHERE released_at IS NULL) — and store.insertClaim maps the losing
// SQLSTATE 23505 to the same null («занято») the pre-check returns, instead of
// letting a unique violation surface as a 500.
//
// This is the acceptance test the ticket prescribes: two parallel claims of one
// issue — exactly one success, the second «занято». Embedded Postgres, the same
// style as the telegram-notify integration suite.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { agents, companies, createDb, issueClaims, issues, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { insertClaim } from "./store.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

const companyId = randomUUID();
const issueId = randomUUID();
const agentOne = randomUUID();
const agentTwo = randomUUID();

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported || externalTestDatabaseUrl ? describe : describe.skip;

async function seedFixture() {
  await db.insert(companies).values({
    id: companyId,
    name: `Swarm Race ${companyId.slice(0, 8)}`,
    issuePrefix: `SR${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
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

describeDatabase("swarm claim capture under the race", () => {
  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = (await startEmbeddedPostgresTestDatabase(
        "paperclip-swarm-claim-race-",
      )) as EmbeddedPostgresTestDatabase;
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
    await tempDb?.cleanup();
  }, 60_000);

  it("two parallel claims of one issue — exactly one wins, the second is «занято»", async () => {
    const now = new Date();
    const [first, second] = await Promise.all([
      insertClaim(db, claimInput(agentOne, now)),
      insertClaim(db, claimInput(agentTwo, now)),
    ]);

    const winners = [first, second].filter((claim) => claim !== null);
    expect(winners).toHaveLength(1);
    expect([first, second].filter((claim) => claim === null)).toHaveLength(1);
    expect(await liveClaimCount()).toBe(1);

    // The winner is a real lease, not a stub.
    const winner = winners[0]!;
    expect(winner.issueId).toBe(issueId);
    expect([agentOne, agentTwo]).toContain(winner.agentId);

    // A release opens the door again: the same task is claimable afterwards.
    await db
      .update(issueClaims)
      .set({ releasedAt: new Date(), releaseReason: "run_finished" })
      .where(eq(issueClaims.id, winner.id));
    const afterRelease = await insertClaim(db, claimInput(agentTwo, new Date()));
    expect(afterRelease).not.toBeNull();
    expect(await liveClaimCount()).toBe(1);
  }, 30_000);

  it("maps a unique violation raised by a racing writer to «занято», not to an error", async () => {
    // Deterministic exercise of the 23505 seam: the losing side of the race is
    // the insert that collides with `issue_claims_issue_active_uq` after the
    // advisory pre-check already passed on both processes. The mock drives
    // exactly that interleaving — pre-check empty, insert rejected with the
    // driver error wrapped by drizzle (code on `cause`, as postgres.js does).
    // Before the fix this threw a raw unique_violation up the route and
    // answered 500; the contract is now the same null the pre-check returns.
    const violation = Object.assign(new Error("duplicate key value violates unique constraint"), {
      code: "23505",
      constraint_name: "issue_claims_issue_active_uq",
    });
    const wrapped = Object.assign(new Error("Failed query: insert into issue_claims …"), {
      cause: violation,
    });
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(wrapped),
        }),
      }),
    } as unknown as Db;

    const now = new Date();
    await expect(insertClaim(fakeDb, claimInput(agentTwo, now))).resolves.toBeNull();
  }, 30_000);

  it("still surfaces non-uniqueness insert failures", async () => {
    // The catch is narrow: only 23505 becomes «занято». Anything else must
    // propagate so the route's error handling stays honest.
    const boom = new Error("connection reset by peer");
    const fakeDb = {
      select: () => ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve([]) }),
        }),
      }),
      insert: () => ({
        values: () => ({
          returning: () => Promise.reject(boom),
        }),
      }),
    } as unknown as Db;

    const now = new Date();
    await expect(insertClaim(fakeDb, claimInput(agentOne, now))).rejects.toThrow(
      "connection reset by peer",
    );
  }, 30_000);
});
