// server/src/myrmidon/billing-webhook/billing-webhook.myrmidon.test.ts
//
// myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093): the three acceptance
// criteria of the ticket, run against the real service with a fake insert
// port (no database):
//
//   1. invoice.paid and invoice.failed are stored as "received";
//   2. an unknown event type is stored as "ignored" AND answered 200;
//   3. a malformed body is rejected with 400 and stores nothing.
//
// The signature stub is asserted too: every row carries signatureStatus
// "stub" so a later PR cannot forget it was never verified.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import type { NewBillingEventRow } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { billingWebhookRoutes } from "./routes.js";
import { BILLING_WEBHOOK_KNOWN_TYPES } from "./service.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const URL = "/api/billing/webhook";

interface CapturedRow {
  row: NewBillingEventRow;
}

interface HarnessOptions {
  companyIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const stored: CapturedRow[] = [];
  const deps = {
    listCompanyIds: async () => options.companyIds ?? [COMPANY_ID],
    insertEvent: async (row: NewBillingEventRow) => {
      stored.push({ row });
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api", billingWebhookRoutes({} as Db, deps));
  app.use(errorHandler);
  return { app, stored };
}

describe("myrmidon(1.7 PAYWALL-WEBHOOK-SKELETON, OPE-12093) billing webhook", () => {
  it("stores invoice.paid as received and answers 200", async () => {
    const { app, stored } = harness();
    const res = await request(app)
      .post(URL)
      .send({ type: "invoice.paid", payload: { invoiceId: "inv-1", amountCents: 4900 } })
      .expect(200);
    expect(res.body).toEqual({ received: true, stored: "received", type: "invoice.paid" });
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "invoice.paid",
      status: "received",
      signatureStatus: "stub",
      payload: { invoiceId: "inv-1", amountCents: 4900 },
    });
  });

  it("stores invoice.failed as received", async () => {
    const { app, stored } = harness();
    await request(app)
      .post(URL)
      .send({ type: "invoice.failed", payload: { invoiceId: "inv-2", reason: "card_declined" } })
      .expect(200);
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "invoice.failed",
      status: "received",
    });
  });

  it("stores an unknown event type as ignored and still answers 200", async () => {
    const { app, stored } = harness();
    const res = await request(app)
      .post(URL)
      .send({ type: "customer.updated", payload: { id: "cus-9" } })
      .expect(200);
    expect(res.body).toEqual({ received: true, stored: "ignored", type: "customer.updated" });
    expect(stored).toHaveLength(1);
    expect(stored[0].row).toMatchObject({
      companyId: COMPANY_ID,
      eventType: "customer.updated",
      status: "ignored",
      signatureStatus: "stub",
    });
  });

  it("rejects a body without a type (400) and stores nothing", async () => {
    const { app, stored } = harness();
    await request(app).post(URL).send({ payload: {} }).expect(400);
    await request(app).post(URL).send({ type: "" }).expect(400);
    await request(app).post(URL).send({ type: 42 }).expect(400);
    await request(app).post(URL).send({ type: "invoice.paid", extra: true }).expect(400);
    expect(stored).toEqual([]);
  });

  it("answers 503 and stores nothing when the instance company is unresolved", async () => {
    const { app, stored } = harness({ companyIds: [] });
    await request(app).post(URL).send({ type: "invoice.paid" }).expect(503);
    expect(stored).toEqual([]);
  });

  it("exposes exactly the two known payment types", () => {
    expect(BILLING_WEBHOOK_KNOWN_TYPES).toEqual(["invoice.paid", "invoice.failed"]);
  });
});
