import { describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { redactText, restoreText, type RedactionStore } from "./redaction.js";
import { myrmidonGuardrailsRoutes } from "../routes.js";

function store(): RedactionStore & { rows: Map<string, { token: string; original: string; expiresAt: Date }> } {
  const rows = new Map<string, { token: string; original: string; expiresAt: Date }>();
  return {
    rows,
    async save(id, pairs, expiresAt) { for (const pair of pairs) rows.set(`${id}:${pair.token}`, { ...pair, expiresAt }); },
    async restore(id, text) {
      let result = text;
      for (const row of rows.values()) if (row.expiresAt > new Date() && [...rows.keys()].some((key) => key.startsWith(`${id}:`) && key.endsWith(row.token))) result = result.split(row.token).join(row.original);
      return result;
    },
    async cleanup(now = new Date()) { let count = 0; for (const [key, row] of rows) if (row.expiresAt <= now) { rows.delete(key); count++; } return count; },
  };
}

describe("entity redaction modes", () => {
  it("round-trips reversible masking", async () => {
    const db = store();
    const result = await redactText("Call Anna at anna@example.com", [
      { type: "person", value: "Anna", start: 5, end: 9 },
      { type: "email", value: "anna@example.com", start: 13, end: 29 },
    ], "reversible", db, { id: "r1" });
    expect(result.text).toBe("Call [PERSON_1] at [EMAIL_1]");
    expect(await restoreText(db, "r1", result.text)).toBe("Call Anna at anna@example.com");
  });

  it("cleans expired substitutions", async () => {
    const db = store();
    const now = new Date("2026-01-01T00:00:00Z");
    await redactText("Anna", [{ type: "person", value: "Anna", start: 0, end: 4 }], "reversible", db, { id: "r1", now, ttlMs: 1000 });
    expect(await db.cleanup(new Date(now.getTime() + 1001))).toBe(1);
  });

  it("does not persist irreversible or flag modes, and flag preserves text", async () => {
    const db = store();
    const entity = [{ type: "person", value: "Anna", start: 0, end: 4 }];
    expect((await redactText("Anna", entity, "irreversible", db)).text).toBe("[PERSON_1]");
    expect(db.rows.size).toBe(0);
    expect((await redactText("Anna", entity, "flag", db)).text).toBe("Anna");
    expect(db.rows.size).toBe(0);
  });

  describe("HTTP routes (redact & restore)", () => {
    function setupApp(customStore?: RedactionStore) {
      const s = customStore ?? store();
      const app = express();
      app.use(express.json());
      app.use("/api", myrmidonGuardrailsRoutes({} as any, { store: s }));
      return { app, store: s };
    }

    it("handles round-trip via POST /api/myrmidon/guardrails/redact and restore", async () => {
      const { app } = setupApp();
      const redactRes = await request(app)
        .post("/api/myrmidon/guardrails/redact")
        .send({
          text: "Secret agent Alice visited Berlin",
          entities: [
            { type: "person", value: "Alice", start: 13, end: 18 },
            { type: "location", value: "Berlin", start: 27, end: 33 },
          ],
          mode: "reversible",
          ttlMs: 60000,
        });

      expect(redactRes.status).toBe(200);
      expect(redactRes.body.text).toBe("Secret agent [PERSON_1] visited [LOCATION_1]");
      expect(redactRes.body.redactionId).toBeDefined();

      const restoreRes = await request(app)
        .post("/api/myrmidon/guardrails/restore")
        .send({
          redactionId: redactRes.body.redactionId,
          text: redactRes.body.text,
        });

      expect(restoreRes.status).toBe(200);
      expect(restoreRes.body.text).toBe("Secret agent Alice visited Berlin");
    });

    it("validates inputs and returns 400 on bad requests", async () => {
      const { app } = setupApp();

      const badMode = await request(app)
        .post("/api/myrmidon/guardrails/redact")
        .send({ text: "Hello", entities: [], mode: "invalid" });
      expect(badMode.status).toBe(400);

      const badTtl = await request(app)
        .post("/api/myrmidon/guardrails/redact")
        .send({ text: "Hello", entities: [], mode: "reversible", ttlMs: -10 });
      expect(badTtl.status).toBe(400);

      const badRestore = await request(app)
        .post("/api/myrmidon/guardrails/restore")
        .send({ text: "Hello" });
      expect(badRestore.status).toBe(400);
    });
  });
});
