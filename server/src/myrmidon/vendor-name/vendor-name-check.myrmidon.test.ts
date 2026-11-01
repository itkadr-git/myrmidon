// myrmidon(1.7-REBRAND-F): the vendor-name gate routes.
//
// The routes run over the real service with fake ports (settings row, audit
// sink, the gate's own scan), so validation, permissions, the audit record and
// the precedence between the stored setting and the environment override are
// all exercised without a database and without building the interface.

import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { errorHandler } from "../../middleware/index.js";
import { vendorNameCheckRoutes } from "./routes.js";
import {
  VENDOR_NAME_CHECK_ACTION,
  vendorNameCheckService,
  type VendorNameCheckServiceDeps,
} from "./service.js";
import type { VendorNameScanResult } from "./scan.js";

const COMPANY_ID = "22222222-2222-4222-8222-222222222222";

const member = {
  type: "board",
  source: "session",
  userId: "user-a",
  isInstanceAdmin: false,
  companyIds: [COMPANY_ID],
};
const admin = { ...member, userId: "user-b", isInstanceAdmin: true };

const SCAN: VendorNameScanResult = {
  available: true,
  root: "/repo",
  script: "scripts/myrmidon/vendor-name/check-vendor-name.mjs",
  policyPath: "scripts/myrmidon/vendor-name/vendor-name-policy.json",
  mode: "ratchet",
  modeSource: "policy",
  exitCode: 0,
  status: "ok",
  targets: [
    {
      name: "bundle",
      dir: "ui/dist",
      status: "ok",
      visible: 28,
      identifier: 936,
      baseline: 28,
      mode: "ratchet",
      modeSource: "policy",
      files: 408,
      detail: [{ file: "ui/dist/assets/index.js", visible: 3, identifier: 357, line: 1 }],
    },
  ],
  totals: { visible: 28, identifier: 936 },
};

interface HarnessOptions {
  stored?: unknown;
  env?: Record<string, string | undefined>;
  scan?: VendorNameScanResult;
  listCompanyIds?: string[];
}

function harness(options: HarnessOptions = {}) {
  const updated: Array<{ vendorNameCheck: unknown }> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = { stored: options.stored };
  const scans: string[] = [];

  const deps: Partial<VendorNameCheckServiceDeps> = {
    getGeneral: async () => ({ vendorNameCheck: current.stored }),
    updateGeneral: async (patch: { vendorNameCheck: unknown }) => {
      current.stored = patch.vendorNameCheck;
      updated.push(patch);
      return {};
    },
    listCompanyIds: async () => options.listCompanyIds ?? [COMPANY_ID],
    logActivity: async (entry) => {
      audits.push(entry as unknown as Record<string, unknown>);
    },
    scan: async () => {
      scans.push("scan");
      return options.scan ?? SCAN;
    },
    env: options.env ?? {},
  };

  const withActor = (actor: unknown) => {
    const scoped = express();
    scoped.use(express.json());
    scoped.use((req, _res, next) => {
      (req as unknown as { actor: unknown }).actor = actor;
      next();
    });
    scoped.use("/api", vendorNameCheckRoutes({} as Db, vendorNameCheckService({} as Db, deps)));
    scoped.use(errorHandler);
    return scoped;
  };
  return { app: withActor(admin), withActor, updated, audits, current, scans };
}

const URL = "/api/myrmidon/vendor-name-check";

describe("myrmidon(1.7-REBRAND-F) vendor name check: reading", () => {
  it("defaults to the ratchet mode against zero and reports the gate's own counts", async () => {
    const { app } = harness();
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({ mode: "ratchet", baseline: 0 });
    expect(res.body.sources).toEqual({ mode: "default", baseline: "default" });
    expect(res.body.scan.available).toBe(true);
    expect(res.body.scan.totals).toEqual({ visible: 28, identifier: 936 });
    expect(res.body.scan.targets[0].name).toBe("bundle");
  });

  it("reports the stored setting as the source once an operator saved one", async () => {
    const { app } = harness({ stored: { mode: "strict", baseline: 4 } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({ mode: "strict", baseline: 4 });
    expect(res.body.sources).toEqual({ mode: "settings", baseline: "settings" });
  });

  it("reports the environment override as the source when it parsed", async () => {
    const { app } = harness({ env: { MYRMIDON_VENDOR_NAME_CHECK_MODE: "strict" } });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.settings).toEqual({ mode: "strict", baseline: 0 });
    expect(res.body.sources).toEqual({ mode: "env", baseline: "default" });
  });

  it("passes the outcome of a gate that cannot run through, instead of inventing a count", async () => {
    const { app } = harness({
      scan: {
        available: false,
        reason: "no_repository",
        detail: "no repository",
        script: "scripts/myrmidon/vendor-name/check-vendor-name.mjs",
      },
    });
    const res = await request(app).get(URL).expect(200);
    expect(res.body.scan).toEqual({
      available: false,
      reason: "no_repository",
      detail: "no repository",
      script: "scripts/myrmidon/vendor-name/check-vendor-name.mjs",
    });
  });

  it("refuses a board member who is not in the company", async () => {
    const { withActor } = harness();
    const outsider = { ...member, userId: "user-c", companyIds: [] };
    await request(withActor(outsider)).get(URL).expect(403);
  });
});

describe("myrmidon(1.7-REBRAND-F) vendor name check: saving", () => {
  it("saves the mode and the baseline and audits the change", async () => {
    const { app, updated, audits } = harness({ stored: { mode: "ratchet", baseline: 0 } });
    const res = await request(app).patch(URL).send({ mode: "strict", baseline: 12 }).expect(200);
    expect(updated).toEqual([{ vendorNameCheck: { mode: "strict", baseline: 12 } }]);
    expect(res.body.settings).toEqual({ mode: "strict", baseline: 12 });
    expect(res.body.sources).toEqual({ mode: "settings", baseline: "settings" });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      companyId: COMPANY_ID,
      action: VENDOR_NAME_CHECK_ACTION,
      entityType: "instance_settings",
      entityId: "vendorNameCheck",
      details: { mode: "strict", baseline: 12 },
    });
  });

  it("keeps the key a patch does not carry", async () => {
    const { app, updated } = harness({ stored: { mode: "strict", baseline: 4 } });
    await request(app).patch(URL).send({ baseline: 9 }).expect(200);
    expect(updated).toEqual([{ vendorNameCheck: { mode: "strict", baseline: 9 } }]);
  });

  it("never bakes an active environment override into the database", async () => {
    const { app, updated, current } = harness({
      stored: { mode: "ratchet", baseline: 0 },
      env: { MYRMIDON_VENDOR_NAME_CHECK_MODE: "strict" },
    });
    const res = await request(app).patch(URL).send({ baseline: 5 }).expect(200);
    // The stored row keeps what an operator chose, not what the environment forces.
    expect(updated).toEqual([{ vendorNameCheck: { mode: "ratchet", baseline: 5 } }]);
    expect(current.stored).toEqual({ mode: "ratchet", baseline: 5 });
    // The answer still reports the forced mode, with its source.
    expect(res.body.settings).toEqual({ mode: "strict", baseline: 5 });
    expect(res.body.sources).toEqual({ mode: "env", baseline: "settings" });
  });

  it("refuses a body the validator does not accept, and writes nothing", async () => {
    const { app, updated } = harness();
    await request(app).patch(URL).send({ mode: "maybe" }).expect(400);
    await request(app).patch(URL).send({ baseline: -3 }).expect(400);
    await request(app).patch(URL).send({ nope: true }).expect(400);
    expect(updated).toEqual([]);
  });

  it("is instance-admin only", async () => {
    const { withActor, updated } = harness();
    await request(withActor(member)).patch(URL).send({ mode: "strict" }).expect(403);
    expect(updated).toEqual([]);
  });

  it("writes one audit row per company when the instance has several", async () => {
    const { app, audits } = harness({
      stored: { mode: "ratchet", baseline: 0 },
      listCompanyIds: [COMPANY_ID, "33333333-3333-4333-8333-333333333333"],
    });
    await request(app).patch(URL).send({ mode: "strict" }).expect(200);
    expect(audits).toHaveLength(2);
    expect(audits.map((entry) => entry.companyId)).toEqual([
      COMPANY_ID,
      "33333333-3333-4333-8333-333333333333",
    ]);
  });
});