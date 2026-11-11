// myrmidon(OPE-9408): integration test for the signed git-record webhook.
//
// The ingress is mounted ONCE in app.ts, after express.json(verify: captureRawBody)
// and BEFORE board actor auth. The HMAC must verify against the exact request
// bytes: a re-serialized body (different key order/spacing) is a different
// payload and must be rejected even when semantically identical.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import request from "supertest";
import { skillGitRecordRoutes } from "../skill-git-record/routes.js";

const SECRET = "test-webhook-secret";
const REFRESH_CALLS: string[] = [];

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { (req as unknown as { rawBody?: Buffer }).rawBody = buf; } }));
app.use("/api", skillGitRecordRoutes({
  gitRecord: {
    refresh: async () => { REFRESH_CALLS.push(`refresh:${Date.now()}`); },
    listEntries: async () => [],
    recordVerified: async () => {},
  },
  secret: SECRET,
}));

let server: Server;

beforeAll(async () => {
  await new Promise<void>((resolve) => { server = app.listen(0, "127.0.0.1", () => resolve()); });
});

afterAll(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

function sign(payload: string | Buffer, secret = SECRET): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

describe("myrmidon(OPE-9408): signed git-record webhook over express.json raw bytes", () => {
  it("accepts a request whose signature covers the exact original bytes", async () => {
    const payload = JSON.stringify({ event: "push", ref: "refs/heads/main" });
    const before = REFRESH_CALLS.length;
    const response = await request(server)
      .post("/api/myrmidon/skill-git-record/webhook")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(payload))
      .send(payload);
    expect(response.status).toBe(200);
    expect(REFRESH_CALLS.length).toBe(before + 1);
  });

  it("rejects the same JSON re-serialized with different spacing (raw bytes differ)", async () => {
    const signedPayload = '{"event":"push","ref":"refs/heads/main"}';
    const sentPayload = JSON.stringify(JSON.parse(signedPayload), null, 2); // same object, different bytes
    const before = REFRESH_CALLS.length;
    const response = await request(server)
      .post("/api/myrmidon/skill-git-record/webhook")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(signedPayload)) // signature of the compact bytes
      .send(sentPayload); // but re-serialized pretty bytes on the wire
    expect(response.status).toBe(401);
    expect(REFRESH_CALLS.length).toBe(before);
  });

  it("rejects a signature made with the wrong secret", async () => {
    const payload = JSON.stringify({ event: "push" });
    const response = await request(server)
      .post("/api/myrmidon/skill-git-record/webhook")
      .set("content-type", "application/json")
      .set("x-hub-signature-256", sign(payload, "other-secret"))
      .send(payload);
    expect(response.status).toBe(401);
  });

  it("rejects a missing signature", async () => {
    const response = await request(server)
      .post("/api/myrmidon/skill-git-record/webhook")
      .set("content-type", "application/json")
      .send(JSON.stringify({ event: "push" }));
    expect(response.status).toBe(401);
  });
});
