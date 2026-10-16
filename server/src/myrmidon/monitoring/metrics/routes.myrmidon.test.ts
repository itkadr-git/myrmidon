// myrmidon(1.7-METRICS): the endpoint contract, driven end to end through
// express with the token seams injected. The acceptance points of the ticket
// live here: 401 without/with a wrong token, the 0.0.4 content type, all
// families present, and the token precedence (company secret name over env).

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import {
  METRICS_TOKEN_ENV,
  METRICS_TOKEN_SECRET_ENV,
  myrmidonMetricsRoutes,
  resolveMetricsToken,
  tokenMatches,
  type MetricsRoutesDeps,
} from "./routes.js";
import {
  METRIC_FAMILIES,
  METRICS_CONTENT_TYPE,
  type MetricsSnapshot,
} from "./metrics.js";

const TOKEN = "scraper-token-a";
const SECRET_TOKEN = "secret-token-a";
const NOW = new Date("2026-10-03T12:00:00.000Z");

describe("metrics endpoint routes", () => {
  function appWith(input: {
    env?: Record<string, string | undefined>;
    secretToken?: string | null;
    selfCheck?: MetricsRoutesDeps["runSelfCheck"];
  } = {}) {
    const env: Record<string, string | undefined> = {
      [METRICS_TOKEN_ENV]: TOKEN,
      ...input.env,
    };
    const secretToken = input.secretToken === undefined ? null : input.secretToken;
    const app = express();
    app.use(
      myrmidonMetricsRoutes({
        // The real DB half of the collector is covered by the embedded-pg
        // suite; the route tests run the guard and the response shape.
        db: {} as never,
        env: env as NodeJS.ProcessEnv,
        now: () => NOW,
        listSecretRowsByName: async (name) =>
          name === "metrics-scraper-token" ? [{ id: "secret-id-a", companyId: "company-a" }] : [],
        readSecretValue: async () => secretToken,
        ...(input.selfCheck ? { runSelfCheck: input.selfCheck } : {}),
      }),
    );
    return app;
  }

  it("answers 401 when no token is configured (the endpoint never falls open)", async () => {
    const app = appWith({ env: { [METRICS_TOKEN_ENV]: undefined } });
    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 401 without an Authorization header", async () => {
    const res = await request(appWith()).get("/metrics");
    expect(res.status).toBe(401);
  });

  it("answers 401 on a non-bearer Authorization header", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", `Basic ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 401 on a wrong bearer token", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", "Bearer wrong-token");
    expect(res.status).toBe(401);
  });

  it("answers 401 when the named company secret exists but resolves empty", async () => {
    const app = appWith({
      env: { [METRICS_TOKEN_ENV]: undefined, [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token" },
      secretToken: null,
    });
    const res = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(401);
  });

  it("answers 200 with the 0.0.4 content type and every family for the right token", async () => {
    const res = await request(appWith()).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-type"]).toContain("version=0.0.4");
    for (const family of METRIC_FAMILIES) {
      expect(res.text, `family ${family}`).toContain(`# TYPE ${family} `);
      expect(res.text, `family ${family}`).toContain(`# HELP ${family} `);
    }
  });

  it("the company secret token wins over the env token", async () => {
    const app = appWith({
      env: { [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token" },
      secretToken: SECRET_TOKEN,
    });
    const envTokenRes = await request(app).get("/metrics").set("Authorization", `Bearer ${TOKEN}`);
    expect(envTokenRes.status).toBe(401);
    const secretTokenRes = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${SECRET_TOKEN}`);
    expect(secretTokenRes.status).toBe(200);
  });

  it("the selfcheck probe answers 401 without the bearer token", async () => {
    const res = await request(appWith()).get("/api/myrmidon/monitoring/selfcheck");
    expect(res.status).toBe(401);
  });

  it("the selfcheck probe answers 200 with the aggregate shape and no values", async () => {
    const app = appWith({
      selfCheck: async () => ({
        ok: true,
        families_ok: METRIC_FAMILIES.length,
        families_failed: [],
        scrape_ms: 7,
        checked_at: NOW.toISOString(),
      }),
    });
    const res = await request(app).get("/api/myrmidon/monitoring/selfcheck").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      families_ok: METRIC_FAMILIES.length,
      families_failed: [],
      scrape_ms: 7,
      checked_at: NOW.toISOString(),
    });
    // The probe body carries no metric value beyond family counts, no token.
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
  });

  it("the selfcheck probe answers 503 when a family failed", async () => {
    const app = appWith({
      selfCheck: async () => ({
        ok: false,
        families_ok: METRIC_FAMILIES.length - 1,
        families_failed: ["myrmidon_role_queue_tasks"],
        scrape_ms: 3,
        checked_at: NOW.toISOString(),
      }),
    });
    const res = await request(app).get("/api/myrmidon/monitoring/selfcheck").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.families_failed).toEqual(["myrmidon_role_queue_tasks"]);
  });

  it("the selfcheck probe answers 500 with a shape when it throws", async () => {
    const app = appWith({
      selfCheck: async () => {
        throw new Error("collector exploded");
      },
    });
    const res = await request(app).get("/api/myrmidon/monitoring/selfcheck").set("Authorization", `Bearer ${TOKEN}`);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain("exploded");
  });

  // myrmidon(1.6.6 OPE-6959): /internal/procs — the machine-readable process
  // list, same bearer guard as /metrics, fields per design BOARD-PROCESSES
  // этап 1: role, pid, uptime, ready.
  describe("/internal/procs", () => {
    const STARTED = new Date("2026-10-03T11:59:00.000Z");
    const LIVE_SEEN = new Date("2026-10-03T11:59:58.000Z");
    const STALE_SEEN = new Date("2026-10-03T11:00:00.000Z");

    function procsApp(input: {
      rows?: Array<{
        bootId: string;
        role: string;
        pid: number;
        hostname: string;
        container: string | null;
        version: string;
        startedAt: Date;
        lastSeenAt: Date;
        apiPort: number | null;
        eventLoopLagMs: number | null;
        rssBytes: number | null;
      }>;
      throws?: boolean;
      role?: string;
      env?: Record<string, string | undefined>;
    }) {
      const env = { [METRICS_TOKEN_ENV]: TOKEN, ...input.env } as NodeJS.ProcessEnv;
      const app = express();
      app.use(
        myrmidonMetricsRoutes({
          db: {} as never,
          env,
          now: () => NOW,
          processStore: {
            heartbeat: async () => {},
            deleteStale: async () => 0,
            listProcesses: async () => {
              if (input.throws) throw new Error("registry read exploded");
              return input.rows ?? [];
            },
          },
          ...(input.role ? { role: input.role } : {}),
        }),
      );
      return app;
    }

    function row(overrides: Record<string, unknown> = {}) {
      return {
        bootId: "boot-a",
        role: "api",
        pid: 4242,
        hostname: "host-a",
        container: null,
        version: "1.6.6",
        startedAt: STARTED,
        lastSeenAt: LIVE_SEEN,
        apiPort: 3100,
        eventLoopLagMs: 3,
        rssBytes: 1000,
        ...overrides,
      } as never;
    }

    it("answers 401 without the bearer token", async () => {
      const res = await request(procsApp({})).get("/internal/procs");
      expect(res.status).toBe(401);
    });

    it("lists the processes with role, pid, uptime and ready", async () => {
      const res = await request(
        procsApp({
          rows: [
            row({ bootId: "boot-api", role: "api", pid: 4242 }),
            row({ bootId: "boot-worker", role: "worker", pid: 4343, lastSeenAt: STALE_SEEN }),
          ],
        }),
      )
        .get("/internal/procs")
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("all");
      expect(res.body.processes).toHaveLength(2);
      expect(res.body.processes[0]).toMatchObject({
        role: "api",
        pid: 4242,
        uptimeSeconds: 60,
        ready: true,
      });
      expect(res.body.processes[0].startedAt).toBe(STARTED.toISOString());
      expect(res.body.processes[1]).toMatchObject({ role: "worker", pid: 4343, ready: false });
    });

    it("reports the process role from PAPERCLIP_PROCESS_ROLE", async () => {
      const res = await request(procsApp({ env: { PAPERCLIP_PROCESS_ROLE: "worker" } }))
        .get("/internal/procs")
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.role).toBe("worker");
    });

    it("marks the row of this very process as self", async () => {
      const res = await request(procsApp({ rows: [row()] }))
        .get("/internal/procs")
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.body.processes[0].self).toBe(false); // boot-a ≠ this test process
      expect(res.body.selfBootId).toBeTruthy();
    });

    it("answers a well-formed empty list when the registry read fails", async () => {
      const res = await request(procsApp({ throws: true }))
        .get("/internal/procs")
        .set("Authorization", `Bearer ${TOKEN}`);
      expect(res.status).toBe(200);
      expect(res.body.processes).toEqual([]);
      expect(JSON.stringify(res.body)).not.toContain("exploded");
    });
  });

  it("tokenMatches is constant-shape and length-strict", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(TOKEN, `${TOKEN}x`)).toBe(false);
    expect(tokenMatches(TOKEN, "scraper-token-b")).toBe(false);
    expect(tokenMatches("", "")).toBe(true);
  });

  it("resolveMetricsToken reads the env token when no secret name is set", async () => {
    const token = await resolveMetricsToken({
      env: { [METRICS_TOKEN_ENV]: "env-token-a" } as NodeJS.ProcessEnv,
      listSecretRowsByName: async () => {
        throw new Error("no secret lookup expected on the env path");
      },
      readSecretValue: async () => {
        throw new Error("no secret value expected on the env path");
      },
    });
    expect(token).toBe("env-token-a");
  });

  it("resolveMetricsToken: a secret-lookup error falls back to the env token", async () => {
    const token = await resolveMetricsToken({
      env: {
        [METRICS_TOKEN_SECRET_ENV]: "metrics-scraper-token",
        [METRICS_TOKEN_ENV]: "env-token-a",
      } as NodeJS.ProcessEnv,
      listSecretRowsByName: async () => {
        throw new Error("database unavailable");
      },
      readSecretValue: async () => SECRET_TOKEN,
    });
    expect(token).toBe("env-token-a");
  });

  it("the snapshot contract keeps every family field", () => {
    const snapshot: MetricsSnapshot = {
      role: "all",
      runsActive: 0,
      runsQueued: 0,
      runsFailedTotal: 0,
      runsFailedWindow: 0,
      runDurationSecondsP50: null,
      runDurationSecondsP95: null,
      roleQueueTasks: [],
      swarmClaimsActive: 0,
      swarmClaimsTotal: 0,
      agentErrorSignals: 0,
      llmCostCentsWindow: 0,
      scrapeErrors: 0,
      collectedAt: NOW.toISOString(),
    };
    expect(snapshot.collectedAt).toBe("2026-10-03T12:00:00.000Z");
  });
});
