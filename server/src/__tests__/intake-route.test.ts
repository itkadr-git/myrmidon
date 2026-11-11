// server/src/__tests__/intake-route.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import { intakeRoutes } from "../routes/intake.js";
import { createInMemoryIntakeQueue } from "../services/intake-queue.js";
import { createIntakeRateLimiter } from "../services/intake-rate-limit.js";
import { readIntakeConfig } from "../services/intake-config.js";

describe("Webhook Intake Route (/api/intake/:source)", () => {
  let queue: ReturnType<typeof createInMemoryIntakeQueue>;

  beforeEach(() => {
    queue = createInMemoryIntakeQueue();
  });

  function createTestApp(options: Parameters<typeof intakeRoutes>[0] = {}) {
    const app = express();
    app.use(express.json());
    app.use(intakeRoutes({ queue, ...options }));
    return app;
  }

  it("accepts a valid webhook with 202 and enqueues it", async () => {
    const config = {
      enabled: true,
      sources: {
        github: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });
    const payload = { event: "push", ref: "refs/heads/main", repository: "repo1" };

    const res = await request(app)
      .post("/api/intake/github")
      .send(payload)
      .set("x-github-delivery", "deliv-123")
      .expect(202);

    expect(res.body).toMatchObject({
      status: "accepted",
      source: "github",
    });
    expect(res.body.id).toBeDefined();

    // Verify it was enqueued in queue
    const queuedItem = await queue.get(res.body.id);
    expect(queuedItem).not.toBeNull();
    expect(queuedItem?.source).toBe("github");
    expect(queuedItem?.payload).toEqual(payload);
    expect(queuedItem?.eventId).toBe("deliv-123");
    expect(queuedItem?.status).toBe("pending");
  });

  it("works with /intake/:source without /api prefix", async () => {
    const config = {
      enabled: true,
      sources: {
        zabbix: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });
    const res = await request(app)
      .post("/intake/zabbix")
      .send({ problem: "Host is down" })
      .expect(202);

    expect(res.body.source).toBe("zabbix");
    expect(await queue.size()).toBe(1);
  });

  it("enforces rate limits per source and responds 429 when limit exceeded", async () => {
    let mockTime = 1000;
    const config = {
      enabled: true,
      sources: {
        limited_source: {
          rateLimit: {
            maxRequests: 2,
            windowMs: 60_000,
          },
        },
        other_source: {},
      },
      defaultRateLimit: {
        maxRequests: 10,
        windowMs: 60_000,
      },
    };
    const rateLimiter = createIntakeRateLimiter({
      config,
      now: () => mockTime,
    });

    const app = createTestApp({ config, rateLimiter });

    // Request 1: OK
    await request(app)
      .post("/api/intake/limited_source")
      .send({ seq: 1 })
      .expect(202);

    // Request 2: OK
    await request(app)
      .post("/api/intake/limited_source")
      .send({ seq: 2 })
      .expect(202);

    // Request 3: 429 Too Many Requests
    const res429 = await request(app)
      .post("/api/intake/limited_source")
      .send({ seq: 3 })
      .expect(429);

    expect(typeof res429.headers["retry-after"]).toBe("string");
    expect(Number.parseInt(res429.headers["retry-after"], 10)).toBeGreaterThan(0);
    expect(res429.body.error).toContain("Rate limit exceeded");

    // Other source still works fine
    await request(app)
      .post("/api/intake/other_source")
      .send({ ok: true })
      .expect(202);

    // After time window advances, limited_source accepts requests again
    mockTime += 65_000;
    await request(app)
      .post("/api/intake/limited_source")
      .send({ seq: 4 })
      .expect(202);
  });

  it("does not expose queue inspection endpoints on the public router", async () => {
    const config = {
      enabled: true,
      sources: {
        srv1: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });

    await request(app)
      .post("/api/intake/srv1")
      .send({ msg: "hello" })
      .expect(202);

    // Queue listing/inspection must not be reachable on the public intake
    // router: it exposes payload, headers and clientIp of accepted webhooks.
    // Unknown source (not in config.sources) — GET falls through to a 404
    // rendered by the central error handler; queue payloads stay unreachable.
    const listRes = await request(app).get("/api/intake/queue?source=srv1");
    expect(listRes.status).toBe(404);
    expect(listRes.body.items).toBeUndefined();

    const id = (await queue.size()) > 0 ? [...(await queue.list())][0]?.id : null;
    if (id) {
      const itemRes = await request(app).get(`/api/intake/queue/${id}`);
      expect(itemRes.status).toBe(404);
      expect(itemRes.body.payload).toBeUndefined();
    }
  });

  it("returns 400 on invalid source names", async () => {
    const app = createTestApp();
    await request(app)
      .post("/api/intake/invalid%20source%20name!")
      .send({ foo: "bar" })
      .expect(400);
  });

  it("returns 403 when global intake or specific source is disabled", async () => {
    const disabledConfig = {
      enabled: false,
      sources: {},
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const appDisabled = createTestApp({ config: disabledConfig });
    await request(appDisabled)
      .post("/api/intake/any")
      .send({ data: 1 })
      .expect(403);

    const sourceDisabledConfig = {
      enabled: true,
      sources: {
        bad_source: { enabled: false },
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const appSourceDisabled = createTestApp({ config: sourceDisabledConfig });
    await request(appSourceDisabled)
      .post("/api/intake/bad_source")
      .send({ data: 1 })
      .expect(403);
  });

  it("verifies token authentication when tokenRef is configured", async () => {
    const customEnv: NodeJS.ProcessEnv = {
      MYRMIDON_INTAKE_SECRET_TOKEN: "secret-12345",
    };
    const tokenConfig = {
      enabled: true,
      sources: {
        secure_src: {
          tokenRef: "env:MYRMIDON_INTAKE_SECRET_TOKEN",
        },
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config: tokenConfig, env: customEnv });

    // Unauthorized with wrong or missing token
    await request(app)
      .post("/api/intake/secure_src")
      .send({ data: 1 })
      .expect(401);

    await request(app)
      .post("/api/intake/secure_src")
      .set("Authorization", "Bearer wrong-token")
      .send({ data: 1 })
      .expect(401);

    // Authorized with Bearer
    await request(app)
      .post("/api/intake/secure_src")
      .set("Authorization", "Bearer secret-12345")
      .send({ data: 1 })
      .expect(202);

    // Authorized with x-webhook-secret
    await request(app)
      .post("/api/intake/secure_src")
      .set("x-webhook-secret", "secret-12345")
      .send({ data: 2 })
      .expect(202);
  });

  it("enqueues and updates items in the queue", async () => {
    const config = {
      enabled: true,
      sources: {
        srv1: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });
    const res = await request(app)
      .post("/api/intake/srv1")
      .send({ msg: "hello" })
      .expect(202);

    const id = res.body.id;
    const queuedItem = await queue.get(id);
    expect(queuedItem).not.toBeNull();
    expect(queuedItem?.payload).toEqual({ msg: "hello" });
    expect(queuedItem?.source).toBe("srv1");
    expect(await queue.size()).toBe(1);

    await queue.updateStatus(id, "processed");
    const updated = await queue.get(id);
    expect(updated?.status).toBe("processed");
  });
});

// myrmidon(1.6.8 INTAKE-AUTH): the public intake is closed by default.
// Source names are case-normalized (env-derived configs are lowercase), an
// unknown source answers 404, a configured tokenRef whose secret did not
// resolve answers 503 without enqueueing, and the token comparison is
// constant-time (SHA-256 digests through crypto.timingSafeEqual).
describe("Webhook Intake Route auth hardening (1.6.8 INTAKE-AUTH)", () => {
  let queue: ReturnType<typeof createInMemoryIntakeQueue>;

  beforeEach(() => {
    queue = createInMemoryIntakeQueue();
  });

  function createTestApp(options: Parameters<typeof intakeRoutes>[0] = {}) {
    const app = express();
    app.use(express.json());
    app.use(intakeRoutes({ queue, ...options }));
    return app;
  }

  it("accepts a configured open source in any name case (zabbix, Zabbix, ZABBIX)", async () => {
    const config = {
      enabled: true,
      sources: {
        zabbix: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });

    for (const name of ["zabbix", "Zabbix", "ZABBIX"]) {
      const res = await request(app)
        .post(`/api/intake/${name}`)
        .send({ seq: name })
        .expect(202);
      expect(res.body.source).toBe("zabbix");
    }

    expect(await queue.size()).toBe(3);
    for (const item of await queue.list()) {
      expect(item.source).toBe("zabbix");
    }
  });

  it("enforces token authentication for uppercase source names like for lowercase", async () => {
    const customEnv: NodeJS.ProcessEnv = {
      MYRMIDON_INTAKE_CASE_TOKEN: "case-secret",
    };
    const config = {
      enabled: true,
      sources: {
        zabbix: {
          tokenRef: "env:MYRMIDON_INTAKE_CASE_TOKEN",
        },
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config, env: customEnv });

    // Missing token: uppercase behaves exactly like lowercase.
    await request(app)
      .post("/api/intake/zabbix")
      .send({ data: 1 })
      .expect(401);
    await request(app)
      .post("/api/intake/Zabbix")
      .send({ data: 2 })
      .expect(401);
    await request(app)
      .post("/api/intake/ZABBIX")
      .send({ data: 3 })
      .expect(401);

    // Wrong token: same 401 for every case variant.
    for (const name of ["zabbix", "ZABBIX"]) {
      await request(app)
        .post(`/api/intake/${name}`)
        .set("Authorization", "Bearer wrong")
        .send({ data: 4 })
        .expect(401);
    }

    // Correct token accepted through every case variant.
    await request(app)
      .post("/api/intake/ZABBIX")
      .set("Authorization", "Bearer case-secret")
      .send({ data: 5 })
      .expect(202);
    await request(app)
      .post("/api/intake/Zabbix")
      .set("x-webhook-secret", "case-secret")
      .send({ data: 6 })
      .expect(202);

    // Only the two authorized events reached the queue, both normalized.
    expect(await queue.size()).toBe(2);
    for (const item of await queue.list()) {
      expect(item.source).toBe("zabbix");
    }
  });

  it("answers 401 with identical responses for wrong tokens of different lengths (no early exit)", async () => {
    const customEnv: NodeJS.ProcessEnv = {
      MYRMIDON_INTAKE_CT_TOKEN: "constant-time-secret",
    };
    const config = {
      enabled: true,
      sources: {
        ct_src: {
          tokenRef: "env:MYRMIDON_INTAKE_CT_TOKEN",
        },
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config, env: customEnv });

    const shortWrong = await request(app)
      .post("/api/intake/ct_src")
      .set("Authorization", "Bearer x")
      .send({ data: 1 })
      .expect(401);
    const longWrong = await request(app)
      .post("/api/intake/ct_src")
      .set("Authorization", "Bearer x".repeat(64))
      .send({ data: 2 })
      .expect(401);
    const prefixWrong = await request(app)
      .post("/api/intake/ct_src")
      .set("Authorization", "Bearer constant-time-secre")
      .send({ data: 3 })
      .expect(401);
    const correct = await request(app)
      .post("/api/intake/ct_src")
      .set("Authorization", "Bearer constant-time-secret")
      .send({ data: 4 })
      .expect(202);

    // Every rejected comparison produced the same observable outcome — the
    // comparison itself runs over fixed-size SHA-256 digests in the route.
    expect(shortWrong.body).toEqual(longWrong.body);
    expect(shortWrong.body).toEqual(prefixWrong.body);
    expect(await queue.size()).toBe(1);
    expect((await queue.list())[0]?.source).toBe("ct_src");
  });

  it("answers 503 and does not enqueue when the tokenRef secret did not resolve", async () => {
    const config = {
      enabled: true,
      sources: {
        broken_src: {
          tokenRef: "env:MYRMIDON_INTAKE_UNRESOLVED_SECRET",
        },
        empty_env_src: {
          tokenRef: "env:MYRMIDON_INTAKE_EMPTY_SECRET",
        },
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };

    // Variable not set at all.
    const appUnset = createTestApp({ config, env: {} });
    await request(appUnset)
      .post("/api/intake/broken_src")
      .send({ data: 1 })
      .expect(503);
    await request(appUnset)
      .post("/api/intake/BROKEN_SRC")
      .send({ data: 2 })
      .expect(503);

    // Variable set to an empty/blank string.
    const appEmpty = createTestApp({ config, env: { MYRMIDON_INTAKE_EMPTY_SECRET: "   " } });
    await request(appEmpty)
      .post("/api/intake/empty_env_src")
      .send({ data: 3 })
      .expect(503);

    // Nothing reached the queue on any failed-resolution path.
    expect(await queue.size()).toBe(0);
  });

  it("answers 404 and does not enqueue for a source missing from config.sources", async () => {
    const config = {
      enabled: true,
      sources: {
        known_src: {},
      },
      defaultRateLimit: { maxRequests: 60, windowMs: 60000 },
    };
    const app = createTestApp({ config });

    await request(app)
      .post("/api/intake/unknown_src")
      .send({ data: 1 })
      .expect(404);
    await request(app)
      .post("/api/intake/UNKNOWN_SRC")
      .send({ data: 2 })
      .expect(404);

    expect(await queue.size()).toBe(0);

    // The configured source still accepts events (open by design).
    await request(app)
      .post("/api/intake/known_src")
      .send({ data: 3 })
      .expect(202);
    expect(await queue.size()).toBe(1);
  });
});
