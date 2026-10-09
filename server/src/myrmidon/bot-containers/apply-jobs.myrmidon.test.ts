// 1.6.5 (OPE-5403 ASYNC-BOT-APPLY): the bot_apply_jobs store against a real
// database — the partial unique index makes two racing POSTs share one job, and
// an orphaned live job (its process died mid-pass) is closed as failed instead
// of answering every later POST with a dead id.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, botApplyJobs, companies, createDb, type Db } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
  type EmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { BOT_APPLY_JOB_STALE_MS, drizzleBotApplyJobStore } from "./apply-jobs.js";

const externalTestDatabaseUrl = process.env.PAPERCLIP_TEST_DATABASE_URL;
let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;

const companyId = randomUUID();
const botRace = randomUUID();
const botStale = randomUUID();
const botWrapped = randomUUID();

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported || externalTestDatabaseUrl ? describe : describe.skip;

describeDatabase("bot apply jobs store", () => {
  beforeAll(async () => {
    if (externalTestDatabaseUrl) {
      db = createDb(externalTestDatabaseUrl);
    } else {
      tempDb = (await startEmbeddedPostgresTestDatabase("paperclip-bot-apply-jobs-")) as EmbeddedPostgresTestDatabase;
      db = createDb(tempDb.connectionString);
    }
    await db.insert(companies).values({
      id: companyId,
      name: `Apply Jobs ${companyId.slice(0, 8)}`,
      issuePrefix: `AJ${companyId.replaceAll("-", "").slice(0, 5).toUpperCase()}`,
    });
    for (const [id, name] of [
      [botRace, "apply-bot-race"],
      [botStale, "apply-bot-stale"],
      [botWrapped, "apply-bot-wrapped"],
    ] as const) {
      await db.insert(agents).values({
        id,
        companyId,
        name,
        role: "engineer",
        status: "idle",
        adapterType: "paperclip_runner",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
    }
  }, 60_000);

  afterAll(async () => {
    if (db) {
      await db.delete(botApplyJobs).where(eq(botApplyJobs.companyId, companyId));
      await db.delete(agents).where(eq(agents.companyId, companyId));
      await db.delete(companies).where(eq(companies.id, companyId));
    }
    await tempDb?.cleanup();
  }, 60_000);

  it("two racing acquires of one bot end with one job and one creator", async () => {
    const store = drizzleBotApplyJobStore(db);
    const results = await Promise.all(
      Array.from({ length: 6 }, () => store.acquireLiveJob({ companyId, botId: botRace, requestedBy: null })),
    );
    expect(new Set(results.map((job) => job.id)).size).toBe(1);
    expect(results.filter((job) => job.created)).toHaveLength(1);
  });

  it("closes an orphaned live job as failed and starts a fresh one", async () => {
    const store = drizzleBotApplyJobStore(db);
    const orphanId = randomUUID();
    await db.insert(botApplyJobs).values({
      id: orphanId,
      companyId,
      botId: botStale,
      status: "running",
      createdAt: new Date(Date.now() - BOT_APPLY_JOB_STALE_MS - 60_000),
    });

    const fresh = await store.acquireLiveJob({ companyId, botId: botStale, requestedBy: null });
    expect(fresh.created).toBe(true);
    expect(fresh.id).not.toBe(orphanId);

    const orphan = await store.getJob({ botId: botStale, jobId: orphanId });
    expect(orphan?.status).toBe("failed");
    expect(orphan?.error).toContain("abandoned");
    expect(orphan?.finishedAt).not.toBeNull();

    // A job inside the window is a live pass: it is reused, not closed.
    const again = await store.acquireLiveJob({ companyId, botId: botStale, requestedBy: null });
    expect(again.id).toBe(fresh.id);
    expect(again.created).toBe(false);
  });

  it("hands the winner's row back when the losing insert throws a drizzle-wrapped 23505", async () => {
    // Deterministic twin of the racing test above. When drizzle rejects an
    // insert on the live-job unique index it wraps the driver error in its
    // own "Failed query: ..." error: the SQLSTATE code lives on `cause`, not
    // on the thrown object. The old local isUniqueViolation read only the
    // top-level error, missed the 23505 and let it escape acquireLiveJob —
    // the flake this fix removes. A proxy over the real db throws exactly
    // that wrapped error once (after landing the winner's row for real), so
    // the loser path runs every time, not just when the race lands.
    const winnerId = randomUUID();
    let raced = false;
    const racingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === "insert") {
          return (table: unknown) => {
            if (table === botApplyJobs && !raced) {
              raced = true;
              return {
                values: () => ({
                  returning: async () => {
                    // The winner commits first — the loser's insert sees the
                    // index violation, as in the real race.
                    await target
                      .insert(botApplyJobs)
                      .values({ id: winnerId, companyId, botId: botWrapped, status: "pending", requestedBy: null });
                    throw new Error('Failed query: insert into "bot_apply_jobs" ("id", "company_id", "bot_id", "status") …', {
                      cause: Object.assign(
                        new Error('duplicate key value violates unique constraint "bot_apply_jobs_live_bot_uniq"'),
                        { code: "23505" },
                      ),
                    });
                  },
                }),
              };
            }
            return target.insert(table as never);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });

    const store = drizzleBotApplyJobStore(racingDb);
    const job = await store.acquireLiveJob({ companyId, botId: botWrapped, requestedBy: null });

    // The loser returns the winner's row — created=false, the winner's id —
    // instead of throwing the wrapped error at the caller.
    expect(job.id).toBe(winnerId);
    expect(job.created).toBe(false);

    // Exactly one live job for the bot: the rejected insert left no second row.
    const rows = await db.select().from(botApplyJobs).where(eq(botApplyJobs.botId, botWrapped));
    const live = rows.filter((row) => row.status === "pending" || row.status === "running");
    expect(live).toHaveLength(1);
    expect(live[0]?.id).toBe(winnerId);
  });
});
