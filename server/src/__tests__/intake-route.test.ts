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
    const app = createTestApp();
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
    const app = createTestApp();
    const res = await request(app)
      .post("/intake/zabbix")
      .send({ problem: "Host is down" })
      .expect(202);

    expect(res.body.source).toBe("zabbix");
    expect(await queue.size()).toBe(1);
  });

  it("enforces rate limits per source and responds 429 when limit exceeded", async () => {
    let mockTime = 1000;
    const rateLimiter = createIntakeRateLimiter({
      config: {
        enabled: true,
        sources: {
          limited_source: {
            rateLimit: {
              maxRequests: 2,
              windowMs: 60_000,
            },
          },
        },
        defaultRateLimit: {
          maxRequests: 10,
          windowMs: 60_000,
        },
      },
      now: () => mockTime,
    });

    const app = createTestApp({ rateLimiter });

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
    const app = createTestApp();

    await request(app)
      .post("/api/intake/srv1")
      .send({ msg: "hello" })
      .expect(202);

    // Queue listing/inspection must not be reachable on the public intake
    // router: it exposes payload, headers and clientIp of accepted webhooks.
    const listRes = await request(app).get("/api/intake/queue?source=srv1");
    expect([401, 403, 404]).toContain(listRes.status);
    expect(listRes.body.items).toBeUndefined();

    const id = (await queue.size()) > 0 ? [...(await queue.list())][0]?.id : null;
    if (id) {
      const itemRes = await request(app).get(`/api/intake/queue/${id}`);
      expect([401, 403, 404]).toContain(itemRes.status);
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
    const app = createTestApp();
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
