import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRecoveryJournal, agents, companies, createDb } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { errorHandler } from "../middleware/index.js";
import { agentRoutes } from "../routes/agents.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = support.supported ? describe : describe.skip;

describeEmbeddedPostgres("agent recovery journal route", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let companyId: string;
  let agentId: string;
  let app: express.Express;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-agent-recovery-journal-route-");
    db = createDb(temporary.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Recovery Journal", issuePrefix: "RJ" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Recovery agent", role: "engineer", status: "idle",
      adapterType: "process", adapterConfig: {}, runtimeConfig: {},
    });
    await db.insert(agentRecoveryJournal).values({
      companyId, agentId, step: "retry", cause: "stalled_run", dedupKey: "agent-recovery:test",
      payload: { source: "test" },
    });
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = {
        type: "board", source: "local_implicit", userId: "local", companyIds: [companyId],
        memberships: [], isInstanceAdmin: true,
      };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
  }, 90_000);

  afterAll(async () => {
    await db?.delete(agentRecoveryJournal);
    await db?.delete(agents);
    await db?.delete(companies);
    await temporary?.cleanup();
  });

  it("returns entries with the requested limit and cursor", async () => {
    const response = await request(app).get(`/api/agents/${agentId}/recovery-journal?limit=1`);
    expect(response.status).toBe(200);
    expect(response.body.entries).toHaveLength(1);
    expect(response.body.entries[0]).toMatchObject({ agentId, step: "retry", suppressedReason: null });
    expect(response.body.nextBefore).toBeNull();
  });
});
