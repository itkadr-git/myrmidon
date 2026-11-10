// myrmidon(1.7 WEBHOOK-INTAKE, OPE-12041): the intake HTTP surface — HMAC
// signature verification, dedup by (source, event id), raw-payload storage and
// the settings view. The db is faked behind the store interface: this pins the
// HTTP contract, not the vendor.
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { errorHandler } from "../../../middleware/index.js";
import { webhookIntakeRoutes } from "./routes.js";
import type { IntakeDraftRow, WebhookIntakeStore } from "./store.js";

const SECRET = "intake-secret-1";
const COMPANY = "0b0b0b0b-0b0b-0b0b-0b0b0b0b0b0b";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(Buffer.from(body, "utf8")).digest("hex");
}

/** In-memory store matching the interface of the db store, with raw rows kept. */
function fakeIntakeStore(): WebhookIntakeStore & { rows: Map<string, { row: IntakeDraftRow; raw: unknown }> } {
  const rows = new Map<string, { row: IntakeDraftRow; raw: unknown }>();
  let clock = new Date("2026-11-08T12:00:00Z").getTime();
  const tick = () => {
    clock += 1000;
    return new Date(clock).toISOString();
  };
  return {
    rows,
    async insertDraft(companyId, delivery, payload) {
      const key = `${companyId}:${delivery.source}:${delivery.externalEventId}`;
      const existing = rows.get(key);
      if (existing) {
        existing.row.deliveryAttempts += 1;
        existing.row.lastDeliveryAt = tick();
        return "existing";
      }
      const at = tick();
      const row: IntakeDraftRow = {
        id: `draft-${rows.size + 1}`,
        companyId,
        source: delivery.source,
        externalEventId: delivery.externalEventId,
        status: "draft",
        eventType: delivery.eventType,
        signatureScheme: payload.signatureScheme ?? null,
        signatureHeader: payload.signatureHeader ?? null,
        signatureValue: payload.signatureValue ?? null,
        receivedAt: at,
        deliveryAttempts: 1,
        lastDeliveryAt: at,
      };
      rows.set(key, { row, raw: payload.raw });
      return "created";
    },
    async get(companyId, source, externalEventId) {
      const hit = rows.get(`${companyId}:${source}:${externalEventId}`);
      return hit?.row ?? null;
    },
  };
}

function buildApp(store: WebhookIntakeStore, env: NodeJS.ProcessEnv) {
  const app = express();
  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as unknown as { rawBody: Buffer }).rawBody = buf;
    },
  }));
  // Mount the actor the auth layer would set (alerts routes test pattern), so
  // the board-only GET views behave as they do behind the real middleware.
  app.use((req, _res, next) => {
    (req as unknown as { actor: unknown }).actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      companyIds: [COMPANY],
    };
    next();
  });
  app.use(webhookIntakeRoutes({ db: {} as never, env, intakeStore: store, auditLog: vi.fn() }));
  app.use(errorHandler);
  return app;
}

const baseEnv = {
  MYRMIDON_WEBHOOK_INTAKE_TOKEN_REF: "env:INTAKE_TEST_SECRET",
  MYRMIDON_WEBHOOK_INTAKE_COMPANY_ID: COMPANY,
  INTAKE_TEST_SECRET: SECRET,
};

describe("myrmidon webhook intake", () => {
  let store: ReturnType<typeof fakeIntakeStore>;

  beforeEach(() => {
    store = fakeIntakeStore();
  });

  it("stores a signed webhook as a draft (201, raw payload kept)", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ eventId: "evt-1", eventType: "build.finished", ok: true, nested: { n: 1 } });
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=github")
      .set("Content-Type", "application/json")
      .set("X-Myrmidon-Signature-256", sign(body))
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ status: "stored", source: "github", eventId: "evt-1", eventType: "build.finished" });
    const kept = store.rows.get(`${COMPANY}:github:evt-1`);
    expect(kept?.raw).toEqual({ eventId: "evt-1", eventType: "build.finished", ok: true, nested: { n: 1 } });
    expect(kept?.row.signatureScheme).toBe("hmac_sha256");
    expect(kept?.row.signatureValue).toBe(sign(body));
    expect(kept?.row.status).toBe("draft");
  });

  it("deduplicates a repeated event id without storing a second draft", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ eventId: "evt-dup", value: "first" });
    const first = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=stripe")
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(first.status).toBe(201);
    // Same event id, different payload bytes: still the same delivery identity.
    const retry = JSON.stringify({ eventId: "evt-dup", value: "retry" });
    const second = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=stripe")
      .set("X-Myrmidon-Signature-256", sign(retry))
      .set("Content-Type", "application/json")
      .send(retry);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: "duplicate", eventId: "evt-dup" });
    expect(store.rows.size).toBe(1);
    expect(store.rows.get(`${COMPANY}:stripe:evt-dup`)?.row.deliveryAttempts).toBe(2);
    // The raw payload of the FIRST delivery is preserved.
    expect(store.rows.get(`${COMPANY}:stripe:evt-dup`)?.raw).toEqual({ eventId: "evt-dup", value: "first" });
  });

  it("rejects an invalid signature with 401 and stores nothing", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ eventId: "evt-evil" });
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=github")
      .set("X-Myrmidon-Signature-256", "sha256=" + "0".repeat(64))
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
    expect(store.rows.size).toBe(0);
  });

  it("rejects a signature computed with a different secret (401)", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ eventId: "evt-x" });
    const wrong = "sha256=" + createHmac("sha256", "other-secret").update(Buffer.from(body)).digest("hex");
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=github")
      .set("X-Myrmidon-Signature-256", wrong)
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(401);
  });

  it("answers 503 when the intake is not configured", async () => {
    const app = buildApp(store, {});
    const body = JSON.stringify({ eventId: "evt-2" });
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook")
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(503);
  });

  it("falls back to the GitHub signature header and delivery id", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ action: "opened", pr: 7 });
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook")
      .set("Content-Type", "application/json")
      .set("X-Hub-Signature-256", sign(body))
      .set("X-Github-Delivery", "gh-delivery-42")
      .set("X-Github-Event", "pull_request")
      .send(body);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ source: "generic", eventId: "gh-delivery-42", eventType: "pull_request" });
  });

  it("content without a stored event id still dedupes by body hash", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ hello: "world" });
    const first = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=custom")
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=custom")
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(second.status).toBe(200);
    expect(second.body.status).toBe("duplicate");
    expect(store.rows.size).toBe(1);
  });

  it("rejects a malformed source (400)", async () => {
    const app = buildApp(store, baseEnv);
    const body = JSON.stringify({ eventId: "evt-3" });
    const res = await request(app)
      .post("/myrmidon/monitoring/intake/webhook?source=bad%20source!")
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body);
    expect(res.status).toBe(400);
    expect(store.rows.size).toBe(0);
  });

  it("settings view names the reference, never the secret", async () => {
    const app = buildApp(store, baseEnv);
    const res = await request(app).get("/myrmidon/monitoring/intake/settings");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, tokenRef: "env:INTAKE_TEST_SECRET", companyId: COMPANY });
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });
});
