import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@myrmidon/db";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { secretService } from "../services/secrets.js";
import { buildAgentUpdatePatch } from "../../../ui/src/lib/agent-config-patch.js";

describe("pool model selection persistence", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("pool-model-selection");
    db = createDb(database.connectionString);
  }, 90_000);

  afterAll(async () => { await database?.cleanup(); });

  it("saves the UI model selection without changing hidden or unknown configuration", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pool selection", issuePrefix: `P${companyId.slice(0, 7)}` });
    const secret = await secretService(db).create(companyId, {
      name: `fixture-${randomUUID()}`, provider: "local_encrypted", value: "fixture-value",
    });
    const original = {
      model: "chatgpt-pool/old",
      env: {
        PLAIN: { type: "plain", value: "private-fixture-value" },
        REF: { type: "secret_ref", secretId: secret.id, version: "latest" },
      },
      unknown: { nested: [1, { enabled: true }] },
      password: "private-fixture-password",
    };
    await db.insert(agents).values({ id: agentId, companyId, name: "Pool agent", role: "engineer", adapterType: "hermes_gateway", adapterConfig: original });

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "owner", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);

    const detail = await request(app).get(`/api/agents/${agentId}`);
    expect(detail.status, JSON.stringify(detail.body)).toBe(200);
    expect(JSON.stringify(detail.body)).not.toContain("private-fixture-password");
    const patch = buildAgentUpdatePatch(detail.body, {
      identity: {}, adapterConfig: { model: "chatgpt-pool/new" }, heartbeat: {}, debug: {}, runtime: {},
    });
    const saved = await request(app).patch(`/api/agents/${agentId}`).send(patch);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const [row] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(row.adapterConfig).toEqual({ ...original, model: "chatgpt-pool/new" });
    const nextRunAgent = await agentService(db).getById(agentId);
    expect(nextRunAgent?.adapterConfig.model).toBe("chatgpt-pool/new");
  }, 60_000);
});
