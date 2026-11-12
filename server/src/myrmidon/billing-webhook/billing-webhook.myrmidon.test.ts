// server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630): HMAC-SHA256 signature verification
// and storage contract for payment webhook events.
//
// Acceptance criteria:
//   1. Valid signature + invoice.paid / invoice.failed -> 200, status "received",
//      signatureStatus "verified";
//   2. Valid signature + unknown event type -> 200, status "ignored",
//      signatureStatus "verified";
//   3. Missing signature header -> 401, stores nothing;
//   4. Signature computed with wrong secret -> 401, stores nothing;
//   5. Unset secret reference -> 503, stores nothing;
//   6. Malformed body with valid signature -> 400, stores nothing;
//   7. Ambiguous company count (0 or 2) -> 503, stores nothing;
//   8. Verifies exact raw request bytes when rawBody is available.
//   9. Repeat delivery of the same signed body (OPE-12678): 200 with
//      stored "duplicate" / duplicate=true, no second row; a different body
//      is a new row; the unsigned repeat is still 401.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createHash, createHmac } from "node:crypto";
import type { Db } from "@myrmidon/db";
import type { NewBillingEventRow } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { billingWebhookRoutes, type BillingWebhookRoutesDeps } from "./routes.js";
import { BILLING_WEBHOOK_KNOWN_TYPES } from "./service.js";

const SECRET = "test-secret";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const URL = "/api/billing/webhook";

function sign(body: string, secret: string = SECRET): string {
  return "sha256=" + createHmac("sha256", secret).update(Buffer.from(body, "utf8")).digest("hex");
}

interface CapturedRow {
  row: NewBillingEventRow;
}

interface HarnessOptions {
  companyIds?: string[];
  env?: NodeJS.ProcessEnv;
  secretRef?: string | null;
  expectedSecret?: () => string | null;
}

function harness(options: HarnessOptions = {}) {
  const stored: CapturedRow[] = [];
  const defaultEnv: NodeJS.ProcessEnv = {
    MYRMIDON_BILLING_WEBHOOK_SECRET_REF: "env:BILLING_TEST_SECRET",
    BILLING_TEST_SECRET: SECRET,
  };
  const deps: BillingWebhookRoutesDeps = {
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    // In-memory stand-in for the DB dedup index (OPE-12678): the same
    // (company, body_sha256) pair maps to the first row — exactly what the
    // partial unique index billing_events_company_body_sha256_uq enforces.
    // Distinct bodies of the same type/payload stay distinct rows.
    insertEvent: async (row: NewBillingEventRow) => {
      const key = JSON.stringify([row.companyId, row.bodySha256 ?? null]);
      if (row.bodySha256 == null) {
        // Legacy rows (NULL hash) are exempt from the index: always stored.
        stored.push({ row });
        return true;
      }
      if (stored.some((s) => JSON.stringify([s.row.companyId, s.row.bodySha256 ?? null]) === key)) {
        return false;
      }
      stored.push({ row });
      return true;
    },
    env: options.env !== undefined ? options.env : defaultEnv,
    secretRef: options.secretRef,
    expectedSecret: options.expectedSecret,
  };
  const app = express();
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use("/api", billingWebhookRoutes({} as Db, deps));
  app.use(errorHandler);
  return { app, stored };
}

describe("myrmidon(1.7 PAYWALL-WEBHOOK, OPE-12630) billing webhook", () => {
  it("stores invoice.paid as received and verified, answering 200", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-1", amountCents: 4900 } });
    const res = await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ received: true, stored: "received", duplicate: false, type: "invoice.paid" });
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "invoice.paid",
      status: "received",
      signatureStatus: "verified",
      payload: { invoiceId: "inv-1", amountCents: 4900 },
    });
  });

  it("stores invoice.failed as received and verified", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "invoice.failed", payload: { invoiceId: "inv-2", reason: "card_declined" } });
    const res = await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ received: true, stored: "received", duplicate: false, type: "invoice.failed" });
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "invoice.failed",
      status: "received",
      signatureStatus: "verified",
    });
  });

  it("stores an unknown event type as ignored and verified and still answers 200", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "customer.updated", payload: { id: "cus-9" } });
    const res = await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);
    expect(res.body).toEqual({ received: true, stored: "ignored", duplicate: false, type: "customer.updated" });
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "customer.updated",
      status: "ignored",
      signatureStatus: "verified",
    });
  });

  it("rejects a request without signature header (401) and stores nothing", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-1" } });
    await request(app)
      .post(URL)
      .set("Content-Type", "application/json")
      .send(body)
      .expect(401);
    expect(stored).toEqual([]);
  });

  it("rejects a signature computed with a different secret (401) and stores nothing", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-1" } });
    const wrongSignature = sign(body, "wrong-secret");
    await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", wrongSignature)
      .set("Content-Type", "application/json")
      .send(body)
      .expect(401);
    expect(stored).toEqual([]);
  });

  it("answers 503 and stores nothing when the secret reference is unset", async () => {
    const { app, stored } = harness({ env: {} });
    const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-1" } });
    await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(503);
    expect(stored).toEqual([]);
  });

  it("rejects a malformed body with valid signature (400) and stores nothing", async () => {
    const { app, stored } = harness();
    const badBodies = [
      JSON.stringify({ payload: {} }),
      JSON.stringify({ type: "" }),
      JSON.stringify({ type: 42 }),
      JSON.stringify({ type: "invoice.paid", extra: true }),
    ];
    for (const body of badBodies) {
      await request(app)
        .post(URL)
        .set("X-Myrmidon-Signature-256", sign(body))
        .set("Content-Type", "application/json")
        .send(body)
        .expect(400);
    }
    expect(stored).toEqual([]);
  });

  it("answers 503 and stores nothing when the instance company is unresolved", async () => {
    const zeroCompanies = harness({ companyIds: [] });
    const body = JSON.stringify({ type: "invoice.paid" });
    await request(zeroCompanies.app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(503);
    expect(zeroCompanies.stored).toEqual([]);

    const twoCompanies = harness({
      companyIds: [COMPANY_ID, "33333333-3333-4333-8333-333333333333"],
    });
    await request(twoCompanies.app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(503);
    expect(twoCompanies.stored).toEqual([]);
  });

  it("verifies signature over exact rawBody bytes rather than re-serialized JSON", async () => {
    const { app, stored } = harness();
    // Raw body has custom whitespace formatting; re-serialized JSON would not match this signature
    const formattedRaw = '{\n  "type": "invoice.paid",\n  "payload": {\n    "invoiceId": "inv-raw"\n  }\n}';
    await request(app)
      .post(URL)
      .set("X-Myrmidon-Signature-256", sign(formattedRaw))
      .set("Content-Type", "application/json")
      .send(formattedRaw)
      .expect(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].row.signatureStatus).toBe("verified");
  });

  it("accepts x-hub-signature-256 header as valid signature header", async () => {
    const { app, stored } = harness();
    const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-hub" } });
    await request(app)
      .post(URL)
      .set("X-Hub-Signature-256", sign(body))
      .set("Content-Type", "application/json")
      .send(body)
      .expect(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].row.signatureStatus).toBe("verified");
  });

  it("exposes exactly the two known payment types", () => {
    expect(BILLING_WEBHOOK_KNOWN_TYPES).toEqual(["invoice.paid", "invoice.failed"]);
  });

  // myrmidon(1.7 PAYWALL-WEBHOOK-DEDUP, OPE-12678): a repeated delivery of
  // the same signed body does not create a second billing_events row; the
  // dedup key is the SHA-256 of the exact signed bytes, computed after the
  // signature check.
  describe("PAYWALL-WEBHOOK-DEDUP (OPE-12678)", () => {
    it("answers the first delivery with stored received and the repeat of the same signed body with stored duplicate, keeping one row", async () => {
      const { app, stored } = harness();
      const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-1", amountCents: 4900 } });
      const post = () =>
        request(app)
          .post(URL)
          .set("X-Myrmidon-Signature-256", sign(body))
          .set("Content-Type", "application/json")
          .send(body);

      const first = await post().expect(200);
      expect(first.body).toEqual({ received: true, stored: "received", duplicate: false, type: "invoice.paid" });
      expect(stored).toHaveLength(1);

      const repeat = await post().expect(200);
      expect(repeat.body).toEqual({ received: true, stored: "duplicate", duplicate: true, type: "invoice.paid" });
      // The repeat maps to the existing row — billing_events keeps exactly one.
      expect(stored).toHaveLength(1);
      // The stored row carries the SHA-256 of the exact signed bytes.
      expect(stored[0].row.bodySha256).toBe(
        createHash("sha256").update(Buffer.from(body, "utf8")).digest("hex"),
      );
    });

    it("stores a new row when even one byte of the body differs", async () => {
      const { app, stored } = harness();
      const bodyA = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-10", amountCents: 1000 } });
      const bodyB = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-10", amountCents: 1001 } });
      await request(app)
        .post(URL)
        .set("X-Myrmidon-Signature-256", sign(bodyA))
        .set("Content-Type", "application/json")
        .send(bodyA)
        .expect(200);
      const res = await request(app)
        .post(URL)
        .set("X-Myrmidon-Signature-256", sign(bodyB))
        .set("Content-Type", "application/json")
        .send(bodyB)
        .expect(200);
      expect(res.body).toEqual({ received: true, stored: "received", duplicate: false, type: "invoice.paid" });
      expect(stored).toHaveLength(2);
    });

    it("treats a one-byte whitespace difference in the signed bytes as a distinct event", async () => {
      const { app, stored } = harness();
      const compact = '{"type":"invoice.paid","payload":{"invoiceId":"inv-13"}}';
      const spaced = '{ "type" : "invoice.paid" , "payload" : { "invoiceId" : "inv-13" } }';
      // Same parsed JSON, different bytes: distinct dedup keys.
      expect(JSON.parse(compact)).toEqual(JSON.parse(spaced));
      await request(app)
        .post(URL)
        .set("X-Myrmidon-Signature-256", sign(compact))
        .set("Content-Type", "application/json")
        .send(compact)
        .expect(200);
      await request(app)
        .post(URL)
        .set("X-Myrmidon-Signature-256", sign(spaced))
        .set("Content-Type", "application/json")
        .send(spaced)
        .expect(200);
      expect(stored).toHaveLength(2);
    });

    it("redelivers an unknown event type as duplicate without a second row, still 200", async () => {
      const { app, stored } = harness();
      const body = JSON.stringify({ type: "customer.updated", payload: { id: "cus-9" } });
      const post = () =>
        request(app)
          .post(URL)
          .set("X-Myrmidon-Signature-256", sign(body))
          .set("Content-Type", "application/json")
          .send(body);
      const first = await post().expect(200);
      expect(first.body).toEqual({ received: true, stored: "ignored", duplicate: false, type: "customer.updated" });
      const repeat = await post().expect(200);
      expect(repeat.body).toEqual({ received: true, stored: "duplicate", duplicate: true, type: "customer.updated" });
      expect(stored).toHaveLength(1);
    });

    it("answers an unsigned repeat with 401, never with a duplicate 200", async () => {
      const { app, stored } = harness();
      const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-14" } });
      const signedPost = () =>
        request(app)
          .post(URL)
          .set("X-Myrmidon-Signature-256", sign(body))
          .set("Content-Type", "application/json")
          .send(body);
      await signedPost().expect(200);
      await request(app)
        .post(URL)
        .set("Content-Type", "application/json")
        .send(body)
        .expect(401);
      expect(stored).toHaveLength(1);
    });

    it("does not fold two different companies into one dedup identity", async () => {
      const other = harness({ companyIds: ["33333333-3333-4333-8333-333333333333"] });
      const body = JSON.stringify({ type: "invoice.paid", payload: { invoiceId: "inv-12" } });
      const post = (h: ReturnType<typeof harness>) =>
        request(h.app)
          .post(URL)
          .set("X-Myrmidon-Signature-256", sign(body))
          .set("Content-Type", "application/json")
          .send(body);
      await post(harness({ companyIds: [COMPANY_ID] })).expect(200);
      await post(other).expect(200);
      expect(other.stored).toHaveLength(1);
    });
  });
});
