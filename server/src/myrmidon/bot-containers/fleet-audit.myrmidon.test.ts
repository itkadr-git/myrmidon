// myrmidon(fleet-site audit): the activity log rows of the fleet's control calls.
//
// The audit sits in front of a router and records a call when its answer is sent. The router here is
// a stand-in that answers with the status the test asks for; what is under test is which calls leave
// a row, whose row, what it says and what it never says.

import express, { Router } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import type { LogActivityInput } from "../../services/activity-log.js";
import {
  FLEET_AUDIT_READ_WINDOW_MS,
  classifyFleetCall,
  outcomeOf,
  withFleetAudit,
  type FleetAuditDeps,
} from "./fleet-audit.js";

const COMPANY_A = "22222222-2222-4222-8222-222222222222";
const COMPANY_B = "33333333-3333-4333-8333-333333333333";
const BOT_A = "44444444-4444-4444-8444-444444444444";
const BOT_B = "55555555-5555-4555-8555-555555555555";

const board = (userId: string, companyId: string, role: string) => ({
  type: "board",
  source: "session",
  userId,
  isInstanceAdmin: false,
  companyIds: [companyId],
  memberships: [{ companyId, membershipRole: role, status: "active" }],
});

const actors: Record<string, unknown> = {
  admin: board("user-a", COMPANY_A, "admin"),
  member: board("user-m", COMPANY_A, "member"),
  outsider: board("user-x", COMPANY_B, "admin"),
  agent: { type: "agent", agentId: "agent-1", companyId: COMPANY_A, keyId: "key-1", runId: "run-1", source: "agent_key" },
  local: { type: "board", source: "local_implicit" },
  none: { type: "none" },
};

function harness() {
  const logged: LogActivityInput[] = [];
  let clock = Date.parse("2026-11-01T00:00:00Z");
  const deps = {
    logActivity: vi.fn(async (input: LogActivityInput) => {
      logged.push(input);
    }),
    botCompanyId: vi.fn(async (botKey: string) => (botKey === BOT_A ? COMPANY_A : botKey === BOT_B ? COMPANY_B : null)),
    now: () => clock,
    log: { warn: vi.fn() },
  } satisfies FleetAuditDeps;

  // the router behind the audit answers with the status asked for in a header
  const inner = Router();
  inner.use((req, res) => {
    res.status(Number(req.headers["x-status"] ?? 200)).json({ ok: true });
  });

  const app = express();
  app.use((req, _res, next) => {
    const who = req.headers["x-test-actor"];
    (req as unknown as { actor: unknown }).actor = actors[typeof who === "string" ? who : "admin"];
    next();
  });
  app.use(express.json());
  app.use(withFleetAudit(inner, deps));
  return { app, deps, logged, tick: (ms: number) => (clock += ms) };
}

/** The audit writes after the answer is sent; give it the time to finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 15));

describe("which calls are audited", () => {
  const ok = [
    ["POST", `/api/companies/${COMPANY_A}/fleet/sites`, "fleet.site.enroll"],
    ["DELETE", `/api/companies/${COMPANY_A}/fleet/sites/site-a`, "fleet.site.delete"],
    ["PATCH", `/api/myrmidon/fleet/sites/site-a?companyId=${COMPANY_A}`, "fleet.site.patch"],
    ["POST", `/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`, "fleet.site.drain"],
    ["POST", `/api/myrmidon/fleet/sites/site-a/resume?companyId=${COMPANY_A}`, "fleet.site.resume"],
    ["POST", `/api/myrmidon/fleet/bots/${BOT_A}/restart`, "fleet.bot.restart"],
    ["POST", `/api/myrmidon/fleet/bots/${BOT_A}/stop`, "fleet.bot.stop"],
    ["POST", `/api/fleet/bots/${BOT_A}/move`, "fleet.bot.move"],
    ["POST", `/api/myrmidon/fleet/bots/${BOT_A}/move`, "fleet.bot.move"],
    ["GET", `/api/myrmidon/fleet/bots/${BOT_A}/logs`, "fleet.bot.logs"],
    ["GET", `/api/fleet/bots/${BOT_A}/logs?site=site-a&tail=5`, "fleet.bot.logs"],
  ] as const;

  for (const [method, url, action] of ok) {
    it(`${method} ${url.split("?")[0].replace(BOT_A, ":key").replace(COMPANY_A, ":companyId")} is ${action}`, () => {
      const call = classifyFleetCall(method, url.split("?")[0]);
      expect(call?.action).toBe(action);
    });
  }

  it("does not audit reads of lists, the move status, other methods or other paths", () => {
    for (const [method, url] of [
      ["GET", `/api/myrmidon/fleet/sites/overview`],
      ["GET", `/api/myrmidon/fleet/sites/site-a/bots`],
      ["GET", `/api/companies/${COMPANY_A}/fleet/sites`],
      ["GET", `/api/fleet/bots/${BOT_A}/move`],
      ["GET", `/api/myrmidon/fleet/bots/${BOT_A}/restart`],
      ["POST", `/api/myrmidon/fleet/bots/${BOT_A}/logs`],
      ["PUT", `/api/myrmidon/fleet/sites/site-a`],
      ["POST", `/api/myrmidon/fleet/sites/site-a/other`],
      ["POST", `/api/myrmidon/fleet/bots/${BOT_A}/restart/extra`],
      ["POST", `/api/companies/${COMPANY_A}/fleet/sites/site-a/x`],
      ["POST", `/api/agents/${BOT_A}/restart`],
      ["POST", `/api/issues`],
      ["POST", `/other/api/myrmidon/fleet/bots/${BOT_A}/restart`],
    ] as const) {
      expect(classifyFleetCall(method, url)).toBeNull();
    }
  });

  it("reads names from the path with their encoding", () => {
    expect(classifyFleetCall("DELETE", `/api/companies/${COMPANY_A}/fleet/sites/my%2Fsite`)?.entityId).toBe("my/site");
    expect(classifyFleetCall("DELETE", `/api/companies/${COMPANY_A}/fleet/sites/%E0%A4%A`)).toBeNull();
  });

  it("answers map to outcomes", () => {
    expect(outcomeOf(200)).toBe("ok");
    expect(outcomeOf(204)).toBe("ok");
    expect(outcomeOf(401)).toBe("denied");
    expect(outcomeOf(403)).toBe("denied");
    expect(outcomeOf(400)).toBe("rejected");
    expect(outcomeOf(404)).toBe("rejected");
    expect(outcomeOf(409)).toBe("rejected");
    expect(outcomeOf(500)).toBe("failed");
    expect(outcomeOf(502)).toBe("failed");
  });
});

describe("what a row says", () => {
  it("enroll: the site, its address without credentials, the network flags, and no secret name", async () => {
    const { app, logged } = harness();
    await request(app)
      .post(`/api/companies/${COMPANY_A}/fleet/sites`)
      .send({
        name: "site-a",
        url: "https://op:hunter2@10.0.0.5:9100/v1?token=abc",
        tokenSecret: "site-a-token-secret-name",
        caCert: "-----BEGIN CERTIFICATE-----fake",
        privateNetwork: true,
        tunnel: false,
        labels: { zone: "a" },
      })
      .expect(200);
    await settle();
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      companyId: COMPANY_A,
      actorType: "user",
      actorId: "user-a",
      action: "fleet.site.enroll",
      entityType: "fleet_site",
      entityId: "site-a",
      details: { outcome: "ok", status: 200, site: "site-a", url: "https://10.0.0.5:9100", privateNetwork: true, tunnel: false },
    });
    const text = JSON.stringify(logged[0]);
    for (const secret of ["hunter2", "op:", "token=abc", "site-a-token-secret-name", "BEGIN CERTIFICATE", "zone"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("patch: the names of the fields, the address and the flags, not the other values", async () => {
    const { app, logged } = harness();
    await request(app)
      .patch(`/api/myrmidon/fleet/sites/site-a?companyId=${COMPANY_A}`)
      .send({ labels: { owner: "someone" }, capacity: { maxCpus: 2, maxMemoryMb: 100 }, url: "https://10.0.0.6:9100", privateNetwork: true, gatewayPortStart: 18700, gatewayPortEnd: 18799 })
      .expect(200);
    await settle();
    expect(logged[0]).toMatchObject({
      action: "fleet.site.patch",
      entityId: "site-a",
      details: {
        outcome: "ok",
        fields: ["capacity", "gatewayPortEnd", "gatewayPortStart", "labels", "privateNetwork", "url"],
        url: "https://10.0.0.6:9100",
        privateNetwork: true,
        gatewayPortStart: 18700,
        gatewayPortEnd: 18799,
      },
    });
    expect(JSON.stringify(logged[0])).not.toContain("someone");
  });

  it("a patch the rules refuse is recorded with its outcome", async () => {
    const { app, logged } = harness();
    await request(app)
      .patch(`/api/myrmidon/fleet/sites/site-a?companyId=${COMPANY_A}`)
      .set("x-status", "400")
      .send({ privateNetwork: true })
      .expect(400);
    await settle();
    expect(logged[0]).toMatchObject({ action: "fleet.site.patch", details: { outcome: "rejected", status: 400, privateNetwork: true } });
  });

  it("drain and resume: the site", async () => {
    const { app, logged } = harness();
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`).expect(200);
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/resume?companyId=${COMPANY_A}`).expect(200);
    await settle();
    expect(logged.map((l) => [l.action, l.entityType, l.entityId, l.companyId])).toEqual([
      ["fleet.site.drain", "fleet_site", "site-a", COMPANY_A],
      ["fleet.site.resume", "fleet_site", "site-a", COMPANY_A],
    ]);
  });

  it("restart, stop and move: the bot, in the company of its card", async () => {
    const { app, logged, deps } = harness();
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`).expect(200);
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/stop`).expect(200);
    await request(app).post(`/api/fleet/bots/${BOT_A}/move`).send({ to: "site-b" }).expect(200);
    await settle();
    expect(logged.map((l) => [l.action, l.entityType, l.entityId, l.companyId])).toEqual([
      ["fleet.bot.restart", "agent", BOT_A, COMPANY_A],
      ["fleet.bot.stop", "agent", BOT_A, COMPANY_A],
      ["fleet.bot.move", "agent", BOT_A, COMPANY_A],
    ]);
    expect(logged[2].details).toMatchObject({ outcome: "ok", toSite: "site-b" });
    expect(deps.botCompanyId).toHaveBeenCalledWith(BOT_A);
  });

  it("logs: the bot, the site and the number of lines asked for, never the log", async () => {
    const { app, logged } = harness();
    await request(app).get(`/api/fleet/bots/${BOT_A}/logs?site=site-a&tail=5`).expect(200);
    await settle();
    expect(logged[0]).toMatchObject({ action: "fleet.bot.logs", entityId: BOT_A, details: { site: "site-a", tail: "5", outcome: "ok" } });
  });

  it("a failure on the site is recorded as failed, a refusal by the rules as rejected, a denial as denied", async () => {
    const { app, logged } = harness();
    for (const [status, member] of [[502, "admin"], [409, "admin"], [403, "member"]] as const) {
      await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`).set("x-status", String(status)).set("x-test-actor", member);
    }
    await settle();
    expect(logged.map((l) => (l.details as { outcome: string }).outcome)).toEqual(["failed", "rejected", "denied"]);
    expect(logged.map((l) => l.actorId)).toEqual(["user-a", "user-a", "user-m"]);
  });

  it("an agent key or a local operator is an actor too", async () => {
    const { app, logged } = harness();
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/stop`).set("x-test-actor", "agent").set("x-status", "403");
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_B}`).set("x-test-actor", "local");
    await settle();
    expect(logged[0]).toMatchObject({ actorType: "agent", actorId: "agent-1", agentId: "agent-1", runId: "run-1", agentApiKeyId: "key-1", details: { outcome: "denied" } });
    expect(logged[1]).toMatchObject({ actorType: "user", companyId: COMPANY_B });
  });
});

describe("whose trail a row goes into", () => {
  it("not into the trail of a company the actor does not belong to", async () => {
    const { app, logged, deps } = harness();
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`).set("x-test-actor", "outsider").set("x-status", "403");
    await request(app).post(`/api/companies/${COMPANY_A}/fleet/sites`).set("x-test-actor", "outsider").set("x-status", "403").send({ name: "x" });
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`).set("x-test-actor", "outsider").set("x-status", "403");
    await request(app).post(`/api/fleet/bots/${BOT_A}/move`).set("x-test-actor", "outsider").set("x-status", "400").send({});
    await settle();
    expect(logged).toEqual([]);
    expect(deps.logActivity).not.toHaveBeenCalled();
    // the outsider's own company is another matter
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_B}/restart`).set("x-test-actor", "outsider");
    await settle();
    expect(logged.map((l) => l.companyId)).toEqual([COMPANY_B]);
  });

  it("not for an anonymous call, an unknown bot, a bot id that is not an id, or a missing company", async () => {
    const { app, logged, deps } = harness();
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`).set("x-test-actor", "none").set("x-status", "401");
    await request(app).post(`/api/myrmidon/fleet/bots/66666666-6666-4666-8666-666666666666/restart`).set("x-status", "404");
    expect(deps.botCompanyId).toHaveBeenCalledTimes(1); // the anonymous call did not reach the card lookup for its actor
    await request(app).post(`/api/myrmidon/fleet/bots/not-an-id/restart`).set("x-status", "404");
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain`).set("x-status", "400");
    await settle();
    expect(logged).toEqual([]);
  });

  it("a call that passes two audited routers is recorded once", async () => {
    const first = harness();
    const secondRows: LogActivityInput[] = [];
    const second = {
      logActivity: vi.fn(async (input: LogActivityInput) => {
        secondRows.push(input);
      }),
      botCompanyId: vi.fn(async () => COMPANY_A),
    } satisfies FleetAuditDeps;
    const app = express();
    app.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actors.admin;
      next();
    });
    app.use(withFleetAudit(Router(), second)); // another fleet router in front, which does not answer
    app.use(withFleetAudit(Router().use((_req, res) => void res.json({ ok: true })), first.deps));
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`).expect(200);
    await settle();
    expect(secondRows.length + first.logged.length).toBe(1);
  });
});

describe("reading logs is recorded once a minute", () => {
  it("one row per actor and bot in the window, a new row after it", async () => {
    const { app, logged, tick } = harness();
    const read = (who = "admin") => request(app).get(`/api/myrmidon/fleet/bots/${BOT_A}/logs`).set("x-test-actor", who);
    await read();
    await read();
    await read("member");
    tick(FLEET_AUDIT_READ_WINDOW_MS - 1);
    await read();
    await settle();
    expect(logged.map((l) => l.actorId)).toEqual(["user-a", "user-m"]);
    tick(2);
    await read();
    await settle();
    expect(logged.map((l) => l.actorId)).toEqual(["user-a", "user-m", "user-a"]);
  });

  it("other calls are never merged", async () => {
    const { app, logged } = harness();
    for (let i = 0; i < 3; i += 1) await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`);
    await settle();
    expect(logged).toHaveLength(3);
  });
});

describe("a failing audit does not touch the call", () => {
  it("answers as usual and says in the log that the row was not written", async () => {
    const { app, deps } = harness();
    deps.logActivity.mockRejectedValueOnce(new Error("db down"));
    const res = await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`).expect(200);
    expect(res.body).toEqual({ ok: true });
    await settle();
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
    expect(deps.log.warn).toHaveBeenCalledWith(expect.objectContaining({ action: "fleet.site.drain" }), "fleet audit entry was not written");
    // and the next call is recorded again
    await request(app).post(`/api/myrmidon/fleet/sites/site-a/drain?companyId=${COMPANY_A}`).expect(200);
    await settle();
    expect(deps.logActivity).toHaveBeenCalledTimes(2);
  });

  it("a card lookup that fails is the same", async () => {
    const { app, deps, logged } = harness();
    deps.botCompanyId.mockRejectedValueOnce(new Error("db down"));
    await request(app).post(`/api/myrmidon/fleet/bots/${BOT_A}/restart`).expect(200);
    await settle();
    expect(logged).toEqual([]);
    expect(deps.log.warn).toHaveBeenCalledTimes(1);
  });
});
