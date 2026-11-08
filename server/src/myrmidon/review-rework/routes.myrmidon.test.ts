// myrmidon(REVIEW-REWORK-SETTINGS-500): the settings routes over the real
// service with fake ports — no database, no postgres. Regression pins:
//
//   1. PATCH returns 200 and the settings change lands (the 08.11 defect was
//      a 500 with the setting saved anyway);
//   2. the audit writes one `instance.review_rework.updated` row per company
//      over real ids — never an empty company_id, the NOT NULL uuid that used
//      to kill persistActivity;
//   3. the journal entry rides in the same settings row as the change (one
//      updateGeneral write: both or neither);
//   4. a non-admin board member gets 403 before any write happens;
//   5. an empty patch is a 400.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { REVIEW_REWORK_SETTINGS_UPDATED_ACTION } from "@myrmidon/shared";
import { errorHandler } from "../../middleware/index.js";
import { reviewReworkRoutes } from "./routes.js";
import { reviewReworkSettingsService, type ReviewReworkSettingsPorts } from "./settings.js";

const COMPANY_A = "11111111-1111-4111-8111-111111111111";
const COMPANY_B = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_A],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };

interface HarnessOptions {
  companyIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const updated: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  let stored: Record<string, unknown> = {
    reviewRework: { enabled: true, fallbackAssigneeAgentId: null },
  };

  const ports: ReviewReworkSettingsPorts = {
    settings: {
      getGeneral: async () => stored,
      updateGeneral: async (patch) => {
        stored = { ...stored, ...patch };
        updated.push(patch as Record<string, unknown>);
        return {};
      },
    },
    activity: {
      listCompanyIds: async () => options.companyIds ?? [COMPANY_A, COMPANY_B],
      logActivity: async (entry) => {
        audits.push(entry as unknown as Record<string, unknown>);
        return {};
      },
    },
  };
  const service = reviewReworkSettingsService({} as Db, ports);

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", reviewReworkRoutes({} as Db, service));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(admin), withActor, updated, audits, stored: () => stored };
}

const URL = "/api/myrmidon/review-rework";

describe("PATCH /api/myrmidon/review-rework (REVIEW-REWORK-SETTINGS-500)", () => {
  it("answers 200, saves the setting, and writes one audit row per company", async () => {
    const h = harness();
    const res = await request(h.app).patch(URL).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.enabled).toBe(false);

    // The settings save itself: the stored row carries the change and the
    // journal entry in the same updateGeneral write.
    expect(h.updated).toHaveLength(1);
    const written = h.updated[0] as {
      reviewRework: { enabled: boolean };
      reviewReworkJournal: Array<{ patch: { enabled: boolean } }>;
    };
    expect(written.reviewRework.enabled).toBe(false);
    expect(written.reviewReworkJournal[0].patch.enabled).toBe(false);

    // The audit: one row per company, action `instance.review_rework.updated`,
    // never an empty company id.
    expect(h.audits.map((row) => row.companyId)).toEqual([COMPANY_A, COMPANY_B]);
    for (const row of h.audits) {
      expect(row.action).toBe(REVIEW_REWORK_SETTINGS_UPDATED_ACTION);
      expect(String(row.companyId).length).toBeGreaterThan(0);
      expect(row.entityType).toBe("instance_settings");
      expect(row.entityId).toBe("reviewRework");
      expect(row.actorType).toBe("user");
    }
  });

  it("GET returns the saved settings and the journal", async () => {
    const h = harness();
    await request(h.app).patch(URL).send({ enabled: false });
    const res = await request(h.app).get(URL);
    expect(res.status).toBe(200);
    expect(res.body.settings.enabled).toBe(false);
    expect(res.body.journal).toHaveLength(1);
    expect(res.body.journal[0].patch.enabled).toBe(false);
    expect(res.body.journal[0].actorId).toBe("user-b");
  });

  it("rejects a non-admin board member with 403 before any write", async () => {
    const h = harness();
    const res = await request(h.withActor(member)).patch(URL).send({ enabled: false });
    expect(res.status).toBe(403);
    expect(h.updated).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("rejects an empty patch with 400", async () => {
    const h = harness();
    const res = await request(h.app).patch(URL).send({});
    expect(res.status).toBe(400);
    expect(h.updated).toHaveLength(0);
    expect(h.audits).toHaveLength(0);
  });

  it("writes no audit row when the instance has no companies (still 200)", async () => {
    const h = harness({ companyIds: [] });
    const res = await request(h.app).patch(URL).send({ enabled: false });
    expect(res.status).toBe(200);
    expect(res.body.settings.enabled).toBe(false);
    expect(h.audits).toHaveLength(0);
    expect((h.stored() as { reviewRework: { enabled: boolean } }).reviewRework.enabled).toBe(false);
  });
});
