// server/src/myrmidon/castes/nests-api.myrmidon.test.ts
//
// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the REST API of the agent nests —
// access, request parsing and the activity row. Plain fakes: no database, no
// network. The store's own suite (castes-default-and-nests.db.myrmidon.test.ts)
// covers the tables against a real database.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { errorHandler } from "../../middleware/index.js";
import { notFound } from "../../errors.js";
import { agentNestRoutes, type AgentNestActivityEntry } from "./nests-routes.js";
import type { AgentNestService } from "./nests-service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_COMPANY = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const MISSING_AGENT = "66666666-6666-4666-8666-666666666666";
const PROJECT_ID = "55555555-5555-4555-8555-555555555555";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const outsider = {
  type: "board",
  source: "session",
  userId: "user-b",
  isInstanceAdmin: false,
  companyIds: [OTHER_COMPANY],
};
const agentActor = {
  type: "agent",
  source: "agent_key",
  agentId: "agent-a",
  companyId: COMPANY_ID,
  keyId: "key-a",
};

function app(actor: unknown) {
  const calls: Array<{ op: string; companyId: string; agentId: string; projectIds?: string[] }> = [];
  const activity: AgentNestActivityEntry[] = [];
  const service: AgentNestService = {
    async getNests(companyId, agentId) {
      calls.push({ op: "get", companyId, agentId });
      if (agentId === MISSING_AGENT) throw notFound("agent not found", { code: "agent_not_found" });
      return { companyId, agentId, projectIds: [PROJECT_ID] };
    },
    async putNests(input) {
      calls.push({
        op: "put",
        companyId: input.companyId,
        agentId: input.agentId,
        projectIds: input.projectIds,
      });
      return {
        view: { companyId: input.companyId, agentId: input.agentId, projectIds: input.projectIds },
        added: input.projectIds.length > 0 ? [PROJECT_ID] : [],
        removed: input.projectIds.length === 0 ? [PROJECT_ID] : [],
      };
    },
  };

  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = actor;
    next();
  });
  server.use(
    "/api",
    agentNestRoutes({
      service,
      recordActivity: async (entry) => {
        activity.push(entry);
      },
    }),
  );
  server.use(errorHandler);
  return { server, calls, activity };
}

const base = `/api/myrmidon/companies/${COMPANY_ID}/agents/${AGENT_ID}/nests`;

describe("myrmidon(1.6.5 F-26 T3) nests routes: access", () => {
  it("denies another company on both routes (403, no service call)", async () => {
    const { server, calls } = app(outsider);
    await request(server).get(base).expect(403);
    await request(server).put(base).send({ projectIds: [PROJECT_ID] }).expect(403);
    expect(calls).toHaveLength(0);
  });

  it("lets an agent of the company read its nests but not write them", async () => {
    const { server, calls } = app(agentActor);
    await request(server).get(base).expect(200);
    await request(server).put(base).send({ projectIds: [PROJECT_ID] }).expect(403);
    expect(calls.map((call) => call.op)).toEqual(["get"]);
  });

  it("lets a board member of the company read and write", async () => {
    const { server } = app(member);
    const read = await request(server).get(base).expect(200);
    expect(read.body).toEqual({ companyId: COMPANY_ID, agentId: AGENT_ID, projectIds: [PROJECT_ID] });
    const written = await request(server).put(base).send({ projectIds: [] }).expect(200);
    expect(written.body.projectIds).toEqual([]);
  });
});

describe("myrmidon(1.6.5 F-26 T3) nests routes: parsing", () => {
  it("passes the project list through and writes one activity row", async () => {
    const { server, calls, activity } = app(member);
    await request(server).put(base).send({ projectIds: [PROJECT_ID] }).expect(200);
    expect(calls).toEqual([
      { op: "put", companyId: COMPANY_ID, agentId: AGENT_ID, projectIds: [PROJECT_ID] },
    ]);
    expect(activity).toHaveLength(1);
    expect(activity[0]).toMatchObject({ companyId: COMPANY_ID, agentId: AGENT_ID });
  });

  it("rejects a missing or a non-array projectIds (400, no service call)", async () => {
    const first = app(member);
    await request(first.server).put(base).send({}).expect(400);
    await request(first.server).put(base).send({ projectIds: "not-an-array" }).expect(400);
    expect(first.calls).toHaveLength(0);
  });

  it("carries the service's 404 through to the client", async () => {
    const { server } = app(member);
    await request(server)
      .get(`/api/myrmidon/companies/${COMPANY_ID}/agents/${MISSING_AGENT}/nests`)
      .expect(404);
  });
});