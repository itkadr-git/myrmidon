// server/src/myrmidon/monitoring/zabbix-sink/routes.myrmidon.test.ts
// myrmidon(1.7-ZABBIX-SINK / OPE-12126): the webhook route — the three
// acceptance cases (valid payload creates the draft, a repeated eventid dedups,
// an invalid payload answers 400) plus the auth/config boundary. The issue
// ports, the dedup store, the db and the audit log are fakes: this pins the
// HTTP surface of the sink, not the vendor.
import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../../../middleware/index.js";
import type { logActivity } from "../../../services/activity-log.js";
import { zabbixSinkRoutes } from "./routes.js";
import type { SinkIssuePorts } from "./service.js";
import type { ZabbixSinkDedupStore, SinkDedupEntry } from "./store.js";

const TOKEN = "zabbix-sink-token-1";
const COMPANY = "0b0b0b0b-0b0b-0b0b-0b0b0b0b0b0b";

const zabbixEvent = {
  eventid: "101",
  triggerid: "7001",
  name: "Free disk space is less than 10% on volume / (disk > 90%)",
  severity: "4",
  status: "PROBLEM",
  hosts: "host-a.example.com",
  url: "https://zabbix.example.com/tr_events.php?triggerid=7001&eventid=101",
};

/** In-memory dedup store matching the interface of the JSON-column store. */
function fakeDedupStore(): ZabbixSinkDedupStore & { entries: Map<string, SinkDedupEntry> } {
  const entries = new Map<string, SinkDedupEntry>();
  let clock = new Date("2026-11-08T12:00:00Z").getTime();
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  return {
    entries,
    async get(companyId, eventId) {
      const entry = entries.get(`zabbix-sink:${eventId}`);
      return entry && entry.companyId === companyId ? entry : null;
    },
    async upsert(companyId, eventId, issue) {
      const id = `zabbix-sink:${eventId}`;
      const now = tick();
      const entry: SinkDedupEntry = {
        id,
        companyId,
        issueId: issue.issueId,
        issueIdentifier: issue.issueIdentifier,
        issueStatus: "todo",
        createdAt: entries.get(id)?.createdAt ?? now,
        updatedAt: now,
      };
      entries.set(id, entry);
      return entry;
    },
  };
}

function appFor(opts: {
  token?: string | null;
  company?: string;
  dedup?: ZabbixSinkDedupStore & { entries: Map<string, SinkDedupEntry> };
} = {}) {
  const dedup = opts.dedup ?? fakeDedupStore();
  const created: Array<{ title: string; description: string; priority: string; assigneeAgentId: string | null }> = [];
  let seq = 0;
  const issues: SinkIssuePorts = {
    async createIssue(_companyId, input) {
      seq += 1;
      created.push(input);
      return { id: `issue-${seq}`, identifier: `ZBX-${900 + seq}`, status: "todo" };
    },
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zabbixSinkRoutes({
      db: {} as Db,
      env: { MYRMIDON_ALERTS_COMPANY_ID: opts.company ?? COMPANY } as NodeJS.ProcessEnv,
      issuePorts: issues,
      expectedToken: () => (opts.token === undefined ? TOKEN : opts.token),
      dedupStore: dedup,
      auditLog: async () => ({}) as Awaited<ReturnType<typeof logActivity>>,
    }),
  );
  app.use(errorHandler);
  return { app, dedup, created, seq: () => seq };
}

const webhook = "/api/monitoring/zabbix-webhook";

describe("myrmidon(1.7-ZABBIX-SINK) webhook", () => {
  it("creates a role-task draft from a valid Zabbix event", async () => {
    const { app, dedup, created, seq } = appFor();
    const res = await request(app)
      .post(webhook)
      .set("authorization", `Bearer ${TOKEN}`)
      .send(zabbixEvent)
      .expect(200);
    expect(res.body).toMatchObject({
      eventid: "101",
      action: "create",
      issue_id: "issue-1",
      issue_identifier: "ZBX-901",
    });
    expect(seq()).toBe(1);
    expect(created[0].title).toBe("Free disk space is less than 10% on volume / (disk > 90%)");
    expect(created[0].priority).toBe("critical"); // severity 4 -> critical
    expect(created[0].description).toContain(zabbixEvent.url);
    expect(created[0].description).toContain("Event: 101");
    expect(created[0].assigneeAgentId).toBeNull();
    expect(dedup.entries.get("zabbix-sink:101")).toMatchObject({ issueId: "issue-1" });
  });

  it("dedups a repeated eventid into the same draft (no second task)", async () => {
    const { app, dedup, created, seq } = appFor();
    const first = await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent).expect(200);
    expect(first.body.action).toBe("create");
    const repeat = await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent).expect(200);
    expect(repeat.body).toMatchObject({ eventid: "101", action: "dedup", issue_id: "issue-1" });
    expect(seq()).toBe(1); // the vendor issue service was hit exactly once
    expect(created).toHaveLength(1);
    expect(dedup.entries.size).toBe(1);
  });

  it("answers 400 for an invalid payload", async () => {
    const { app, created, seq } = appFor();
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send({ hello: "world" }).expect(400);
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send({ name: "no eventid" }).expect(400);
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send({ eventid: "102" }).expect(400);
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send("not an object").expect(400);
    expect(seq()).toBe(0);
    expect(created).toHaveLength(0);
  });

  it("answers 401 for a wrong or missing token", async () => {
    const { app } = appFor();
    await request(app).post(webhook).set("authorization", "Bearer wrong-token").send(zabbixEvent).expect(401);
    await request(app).post(webhook).send(zabbixEvent).expect(401);
  });

  it("answers 503 when the token reference is not configured", async () => {
    const { app } = appFor({ token: null });
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent).expect(503);
  });

  it("answers 503 when the target company is not configured", async () => {
    const { app } = appFor({ company: "" });
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent).expect(503);
  });

  it("serializes concurrent first deliveries of the same eventid into one draft", async () => {
    const { app, dedup, seq } = appFor();
    const [first, second] = await Promise.all([
      request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent),
      request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixEvent),
    ]);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(seq()).toBe(1);
    expect(dedup.entries.size).toBe(1);
  });
});
