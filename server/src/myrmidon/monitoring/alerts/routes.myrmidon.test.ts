// myrmidon(1.6.6-ALERTS): the webhook routes — token auth, the disk > 90%
// flow of the parent ticket, dedup, auto-close and the settings surface. The
// issue ports, the dedup store and the db are fakes: this pins the HTTP
// surface, not the vendor.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { errorHandler } from "../../../middleware/index.js";
import { monitoringAlertsRoutes } from "./routes.js";
import type { IssuePorts } from "./service.js";
import type { AlertDedupStore, DedupEntry } from "./store.js";

const TOKEN = "webhook-token-1";
const COMPANY = "0b0b0b0b-0b0b-0b0b-0b0b-0b0b0b0b0b0b";

const zabbixDisk = {
  eventid: "101",
  name: "Free disk space is less than 10% on volume / (disk > 90%)",
  severity: "4",
  status: "PROBLEM",
  hosts: "host-a.example.com",
  url: "https://zabbix.example.com/tr_events.php?triggerid=1&eventid=101",
};

/** In-memory dedup store matching the interface of the JSON-column store. */
function fakeDedupStore(): AlertDedupStore & { entries: Map<string, DedupEntry> } {
  const entries = new Map<string, DedupEntry>();
  let clock = new Date("2026-10-03T12:00:00Z").getTime();
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  return {
    entries,
    async get(companyId, source, key) {
      const entry = entries.get(`${source}:${key}`);
      return entry && entry.companyId === companyId ? entry : null;
    },
    async upsert(companyId, source, key, issue) {
      const id = `${source}:${key}`;
      const now = tick();
      const entry: DedupEntry = {
        id,
        companyId,
        issueId: issue.issueId,
        issueIdentifier: issue.issueIdentifier,
        issueStatus: "open",
        createdAt: entries.get(id)?.createdAt ?? now,
        updatedAt: now,
        resolvedAt: null,
      };
      entries.set(id, entry);
      return entry;
    },
    async markResolved(companyId, source, key, resolvedAt) {
      const id = `${source}:${key}`;
      const entry = entries.get(id);
      if (!entry || entry.companyId !== companyId) return null;
      const updated = { ...entry, issueStatus: "resolved", updatedAt: tick(), resolvedAt };
      entries.set(id, updated);
      return updated;
    },
    async sweepClosedOlderThan(now, maxAgeMs) {
      let removed = 0;
      for (const [id, entry] of entries) {
        if (entry.issueStatus !== "open" && now.getTime() - Date.parse(entry.updatedAt) > maxAgeMs) {
          entries.delete(id);
          removed += 1;
        }
      }
      return removed;
    },
  };
}

function fakeIssuePorts() {
  const created: Array<{ id: string; title: string; description: string; priority: string; assigneeAgentId: string | null }> = [];
  const comments: Array<{ issueId: string; body: string }> = [];
  const statusUpdates: Array<{ issueId: string; status: string }> = [];
  let seq = 0;
  const issues: IssuePorts = {
    async createIssue(companyId, input) {
      expect(companyId).toBe(COMPANY);
      seq += 1;
      const id = `issue-${seq}`;
      created.push({ id, ...input });
      return { id, identifier: `ALR-${900 + seq}`, status: "todo" };
    },
    async addComment(issueId, body) {
      comments.push({ issueId, body });
      return {};
    },
    async updateStatus(issueId, status) {
      statusUpdates.push({ issueId, status });
      return {};
    },
  };
  return { issues, created, comments, statusUpdates };
}

const boardActor = { type: "board", userId: "user-1", source: "local_implicit", companyIds: [COMPANY] };
const db = {} as Db;

const fakeSettingsStore = (
  overrides: { routes?: Array<{ match: string; assignee: string }>; defaultAssignee?: string } = {},
) => ({
  async get(companyId: string) {
    return {
      companyId,
      routes: overrides.routes ?? [],
      defaultAssignee: overrides.defaultAssignee ?? "adm-devops",
      tokenSecretName: "monitoring-alerts-token",
    };
  },
  async put(companyId: string, input: { routes: Array<{ match: string; assignee: string }>; defaultAssignee?: string }) {
    return {
      companyId,
      routes: input.routes,
      defaultAssignee: input.defaultAssignee ?? "adm-devops",
      tokenSecretName: "monitoring-alerts-token",
    };
  },
});

function appFor(opts: {
  token?: string | null;
  company?: string;
  dedup?: AlertDedupStore & { entries: Map<string, DedupEntry> };
  ports?: ReturnType<typeof fakeIssuePorts>;
  settings?: ReturnType<typeof fakeSettingsStore>;
} = {}) {
  const dedup = opts.dedup ?? fakeDedupStore();
  const ports = opts.ports ?? fakeIssuePorts();
  const app = express();
  app.use(express.json());
  // Mount the actor the auth layer would set, the way the foraging routes test does.
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = boardActor;
    next();
  });
  app.use(
    "/api",
    monitoringAlertsRoutes({
      db,
      env: { MYRMIDON_ALERTS_COMPANY_ID: COMPANY } as NodeJS.ProcessEnv,
      issuePorts: ports.issues,
      assigneeResolver: { resolve: vi.fn(async (_companyId: string, name: string) => `agent-id-${name}`) },
      expectedToken: () => opts.token === undefined ? TOKEN : opts.token,
      settingsStore: opts.settings ?? fakeSettingsStore(),
      dedupStore: dedup,
      auditLog: async () => ({ id: "activity-1" }),
    }),
  );
  app.use(errorHandler);
  return { app, dedup, ports };
}

const webhook = "/api/myrmidon/monitoring/alerts/webhook";

describe("myrmidon(1.6.6-ALERTS) webhook", () => {
  it("creates a role issue synchronously for a Zabbix disk > 90% alert", async () => {
    const { app, ports, dedup } = appFor();
    const res = await request(app)
      .post(webhook)
      .set("authorization", `Bearer ${TOKEN}`)
      .send(zabbixDisk)
      .expect(200);
    expect(res.body.processed).toBe(1);
    expect(res.body.results[0]).toMatchObject({ action: "create", issueId: "issue-1", issueIdentifier: "ALR-901" });
    expect(ports.created).toHaveLength(1);
    expect(ports.created[0].title).toContain("[zabbix]");
    expect(ports.created[0].title).toContain("disk");
    expect(ports.created[0].priority).toBe("critical");
    expect(ports.created[0].description).toContain(zabbixDisk.url);
    expect(dedup.entries.get("zabbix:101")).toMatchObject({ issueId: "issue-1" });
  });

  it("maps the assignee from the alert-type route map and defaults to adm-devops", async () => {
    const { app, ports } = appFor();
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixDisk).expect(200);
    expect(ports.created[0].assigneeAgentId).toBe("agent-id-adm-devops");

    const other = await request(app)
      .post(webhook)
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ eventid: "202", name: "TLS certificate expires soon", severity: "3", status: "PROBLEM", hosts: "host-a.example.com" })
      .expect(200);
    void other;
    expect(ports.created[1].assigneeAgentId).toBe("agent-id-adm-devops");
  });

  it("does not duplicate an issue for a repeated firing alert and comments instead", async () => {
    const { app, ports, dedup } = appFor();
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixDisk).expect(200);
    const res = await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixDisk).expect(200);
    expect(res.body.results[0]).toMatchObject({ action: "update", issueId: "issue-1" });
    expect(ports.created).toHaveLength(1);
    expect(ports.comments).toHaveLength(1);
    expect(ports.comments[0].body).toContain("still firing");
    expect(dedup.entries).toHaveLength(1);
  });

  it("auto-closes the issue with a recovery comment when the alert resolves", async () => {
    const { app, ports, dedup } = appFor();
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixDisk).expect(200);
    const res = await request(app)
      .post(webhook)
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ ...zabbixDisk, status: "Resolved" })
      .expect(200);
    expect(res.body.results[0]).toMatchObject({ action: "resolve", issueId: "issue-1" });
    expect(ports.statusUpdates).toEqual([{ issueId: "issue-1", status: "done" }]);
    expect(ports.comments).toHaveLength(1);
    expect(ports.comments[0].body).toContain("Recovered");
    expect(dedup.entries.get("zabbix:101")).toMatchObject({ issueStatus: "resolved" });
  });

  it("answers 401 for a wrong token and 401 without a token", async () => {
    const { app } = appFor();
    await request(app).post(webhook).set("authorization", "Bearer wrong-token").send(zabbixDisk).expect(401);
    await request(app).post(webhook).send(zabbixDisk).expect(401);
  });

  it("answers 503 when the token reference is not configured", async () => {
    const { app } = appFor({ token: null });
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(zabbixDisk).expect(503);
  });

  it("answers 400 for an unrecognized payload", async () => {
    const { app } = appFor();
    await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send({ hello: "world" }).expect(400);
  });

  it("processes an Alertmanager batch and dedups by fingerprint", async () => {
    const { app, ports } = appFor();
    const payload = {
      status: "firing",
      alerts: [
        {
          status: "firing",
          fingerprint: "abc123",
          startsAt: "2026-10-03T10:00:00Z",
          endsAt: null,
          labels: { alertname: "HighDiskUsage", severity: "critical", instance: "192.0.2.1:9100" },
        },
        {
          status: "firing",
          fingerprint: "def456",
          startsAt: "2026-10-03T10:01:00Z",
          endsAt: null,
          labels: { alertname: "ServiceDown", severity: "warning" },
        },
      ],
    };
    const res = await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(payload).expect(200);
    expect(res.body.processed).toBe(2);
    expect(ports.created).toHaveLength(2);

    const again = await request(app).post(webhook).set("authorization", `Bearer ${TOKEN}`).send(payload).expect(200);
    expect(again.body.processed).toBe(2);
    expect(again.body.results.every((r: { action: string }) => r.action === "update")).toBe(true);
    expect(ports.created).toHaveLength(2);

    const resolvedBatch = await request(app)
      .post(webhook)
      .set("authorization", `Bearer ${TOKEN}`)
      .send({
        status: "resolved",
        alerts: [
          {
            status: "resolved",
            fingerprint: "abc123",
            startsAt: "2026-10-03T10:00:00Z",
            endsAt: "2026-10-03T11:00:00Z",
            labels: { alertname: "HighDiskUsage", severity: "critical" },
          },
        ],
      })
      .expect(200);
    expect(resolvedBatch.body.results[0]).toMatchObject({ action: "resolve", issueId: "issue-1" });
  });
});

describe("myrmidon(1.6.6-ALERTS) settings routes", () => {
  it("returns the route map for the configured company, defaulting to adm-devops", async () => {
    const { app } = appFor();
    const res = await request(app)
      .get("/api/myrmidon/monitoring/alerts/settings")
      .expect(200);
    expect(res.body).toMatchObject({ companyId: COMPANY, defaultAssignee: "adm-devops", tokenSecretName: "monitoring-alerts-token" });
  });

  it("answers 503 on a settings read when the company is not configured", async () => {
    const app = express();
    app.use(express.json());
    app.use("/api", monitoringAlertsRoutes({ db, env: {} as NodeJS.ProcessEnv, settingsStore: fakeSettingsStore() }));
    app.use(errorHandler);
    await request(app).get("/api/myrmidon/monitoring/alerts/settings").expect(503);
  });
});
