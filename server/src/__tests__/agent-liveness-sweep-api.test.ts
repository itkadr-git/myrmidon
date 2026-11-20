import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentRuntimeState, agents, companies, createDb } from "@myrmidon/db";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { sweepAgentLivenessProbes } from "../myrmidon/agent-liveness/probe-sweep.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("agent liveness sweep and list API", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("agent-liveness-api");
    db = createDb(database.connectionString);
  }, 90_000);
  afterAll(async () => { await database?.cleanup(); });

  it("rotates beyond a full batch including invalid URLs, and persists outcomes exposed by the API", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Liveness", issuePrefix: `L${companyId.slice(0, 7)}` });
    const ids = Array.from({ length: 52 }, () => randomUUID()).sort();
    await db.insert(agents).values(ids.map((id, index) => ({
      id, companyId, name: `Agent ${index}`, role: "engineer", status: "idle",
      adapterType: "hermes_gateway", adapterConfig: index === 0 ? {} : { apiBaseUrl: `https://agent-${index}.example.com/api` },
    })));
    const app = express();
    app.use((req, _res, next) => {
      req.actor = { type: "board", userId: "owner", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true };
      next();
    });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    const path = `/api/companies/${companyId}/agents`;
    const before = await request(app).get(path);
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.find((a: { id: string }) => a.id === ids[1])).toMatchObject({
      lastProbeAt: null, lastProbeOutcome: null, probeOutcome: null, lastResponseAt: null, derivedStatus: null,
    });
    const at = new Date();
    const port = { probe: async ({ url }: { url: string }) => ({ status: url.includes("agent-51.") ? 503 : 200 }) };
    await sweepAgentLivenessProbes(db, port, { now: at });
    await sweepAgentLivenessProbes(db, port, { now: new Date(at.getTime() + 1000) });
    const rows = await db.select().from(agentRuntimeState).where(eq(agentRuntimeState.companyId, companyId));
    expect(rows).toHaveLength(51);
    expect(rows.find((r) => r.agentId === ids[51])).toMatchObject({ lastProbeOutcome: "unreachable", lastProbeAt: new Date(at.getTime() + 1000) });
    const after = await request(app).get(path).set("If-None-Match", before.headers.etag);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.headers.etag).not.toBe(before.headers.etag);
    expect(after.body.find((a: { id: string }) => a.id === ids[0])).toMatchObject({ lastProbeAt: null, lastProbeOutcome: null, probeOutcome: null, lastResponseAt: null, derivedStatus: null });
    expect(after.body.find((a: { id: string }) => a.id === ids[1])).toMatchObject({ lastProbeAt: at.toISOString(), lastProbeOutcome: "ok", probeOutcome: "ok", lastResponseAt: null, derivedStatus: "alive_but_not_answering" });
    expect(after.body.find((a: { id: string }) => a.id === ids[51])).toMatchObject({ lastProbeAt: new Date(at.getTime() + 1000).toISOString(), lastProbeOutcome: "unreachable", probeOutcome: "unreachable", lastResponseAt: null, derivedStatus: "unreachable" });
  }, 60_000);
});
