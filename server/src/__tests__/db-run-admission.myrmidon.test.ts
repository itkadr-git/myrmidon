import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { dbAdmissionAllowsClaim, usesDatabaseAdmission } from "../myrmidon/db-run-admission.js";

describe("usesDatabaseAdmission", () => {
  it("is on only for admissionStore=db", () => {
    expect(usesDatabaseAdmission({ processes: { admissionStore: "db" } })).toBe(true);
  });

  it("keeps memory mode, missing and malformed settings off the database path", () => {
    expect(usesDatabaseAdmission({ processes: { admissionStore: "memory" } })).toBe(false);
    expect(usesDatabaseAdmission({ processes: {} })).toBe(false);
    expect(usesDatabaseAdmission({ processes: null })).toBe(false);
    expect(usesDatabaseAdmission({})).toBe(false);
    expect(usesDatabaseAdmission(null)).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("dbAdmissionAllowsClaim", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("db-run-admission-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(queuedAgents: number) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    const out: Array<{ agentId: string; runId: string }> = [];
    for (let i = 0; i < queuedAgents; i += 1) {
      const agentId = randomUUID();
      const runId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: `Admission Agent ${i}`,
        role: "engineer",
        status: "idle",
        adapterType: "process",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        invocationSource: "assignment",
        triggerDetail: "system",
        status: "queued",
      });
      out.push({ agentId, runId });
    }
    return { companyId, runs: out };
  }

  async function claim(
    run: { agentId: string; runId: string },
    limits: { agentLimit: number; globalLimit: number | null },
  ) {
    return db.transaction(async (tx) => {
      if (!(await dbAdmissionAllowsClaim(tx, { agentId: run.agentId, ...limits }))) return null;
      // Widen the race window: without the advisory lock both would pass the count.
      await new Promise((resolve) => setTimeout(resolve, 50));
      const rows = await tx
        .update(heartbeatRuns)
        .set({ status: "running", startedAt: new Date() })
        .where(eq(heartbeatRuns.id, run.runId))
        .returning();
      return rows[0] ?? null;
    });
  }

  it("lets exactly one of two parallel claims take the last global slot", async () => {
    const { runs } = await seed(2);
    const results = await Promise.all(
      runs.map((run) => claim(run, { agentLimit: 5, globalLimit: 1 })),
    );
    expect(results.filter((row) => row !== null)).toHaveLength(1);
    expect(results.filter((row) => row === null)).toHaveLength(1);
    const running = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.status, "running"));
    expect(running).toHaveLength(1);
  });

  it("enforces the per-agent limit inside the same transaction", async () => {
    const { runs } = await seed(1);
    const first = await claim(runs[0]!, { agentLimit: 1, globalLimit: null });
    expect(first).not.toBeNull();
    const second = await db.transaction((tx) =>
      dbAdmissionAllowsClaim(tx, { agentId: runs[0]!.agentId, agentLimit: 1, globalLimit: null }),
    );
    expect(second).toBe(false);
  });

  it("admits claims while both limits have room", async () => {
    const { runs } = await seed(2);
    const results = await Promise.all(
      runs.map((run) => claim(run, { agentLimit: 1, globalLimit: 2 })),
    );
    expect(results.every((row) => row !== null)).toBe(true);
  });
});
