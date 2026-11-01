// myrmidon(1.6.6 P1.10): the persisted root fan-out alert limit must
// (a) roundtrip through updateGeneral/getGeneral with the real settings
// service, and (b) flow into evaluateRootFanoutAlerts — a non-default
// persisted limit changes which roots alert. Mirrors
// instance-settings-attention-window.test.ts.
import { describe, expect, it } from "vitest";
import type { Db } from "@myrmidon/db";
import { instanceSettingsService } from "../../services/instance-settings.js";
import {
  DEFAULT_ROOT_FANOUT_LIMIT,
  evaluateRootFanoutAlerts,
} from "./evaluate-alert.js";
import { blockerRootFanoutAlertLimitFromSettings } from "./fanout-limit.js";
import type { BlockerRootFanout } from "@myrmidon/shared";

function root(rootIssueId: string, dependentCount: number): BlockerRootFanout {
  return {
    rootIssueId,
    rootIdentifier: rootIssueId,
    rootStatus: "blocked",
    dependentCount,
    dependents: [],
    oldestBlockedAt: null,
    hasMissingFields: false,
  };
}

// updateGeneral reads the row through select().from().where().limit().for("update")
// inside db.transaction; one Promise with chainable no-ops covers both reads.
function stubRows<T>(values: T[]) {
  const p = Promise.resolve(values) as Promise<T[]> & {
    limit(_n?: number): Promise<T[]>;
    for(_mode?: string): Promise<T[]>;
  };
  p.limit = () => p;
  p.for = () => p;
  return p;
}

function stubDb(general: Record<string, unknown>) {
  let row: Record<string, unknown> = {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
  const db = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    select: () => ({ from: () => ({ where: () => stubRows([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        row = { ...row, ...values };
        return { where: () => ({ returning: () => Promise.resolve([row]) }) };
      },
    }),
  } as unknown as Db;
  return db;
}

describe("root fan-out alert limit from instance settings", () => {
  it("roundtrips a non-default limit through the settings service", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const updated = await svc.updateGeneral({ blockerRootFanoutAlertLimit: 25 });
    expect(updated.general.blockerRootFanoutAlertLimit).toBe(25);
    const read = await svc.getGeneral();
    expect(read.blockerRootFanoutAlertLimit).toBe(25);
  });

  it("a persisted non-default limit changes which roots alert", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    await svc.updateGeneral({ blockerRootFanoutAlertLimit: 20 });
    const read = await svc.getGeneral();
    const limit = blockerRootFanoutAlertLimitFromSettings(read);
    expect(limit).toBe(20);
    // 20 dependents: alerts at default 10, silent at the persisted 20 (strictly greater-than).
    expect(evaluateRootFanoutAlerts([root("OPE-8079", 20)], DEFAULT_ROOT_FANOUT_LIMIT)).toEqual([
      { rootIssueId: "OPE-8079", dependentCount: 20, limit: 10, severity: "warning" },
    ]);
    expect(evaluateRootFanoutAlerts([root("OPE-8079", 20)], limit)).toEqual([]);
    expect(evaluateRootFanoutAlerts([root("OPE-8079", 21)], limit)).toEqual([
      { rootIssueId: "OPE-8079", dependentCount: 21, limit: 20, severity: "warning" },
    ]);
  });

  it("an absent limit means the default 10", async () => {
    const svc = instanceSettingsService(stubDb({}), { runtimeEnv: {} });
    const read = await svc.getGeneral();
    expect(read.blockerRootFanoutAlertLimit).toBeUndefined();
    expect(blockerRootFanoutAlertLimitFromSettings(read)).toBe(DEFAULT_ROOT_FANOUT_LIMIT);
  });

  it("an unparsable or out-of-range stored row falls back to the default", () => {
    expect(blockerRootFanoutAlertLimitFromSettings(null)).toBe(DEFAULT_ROOT_FANOUT_LIMIT);
    expect(blockerRootFanoutAlertLimitFromSettings("junk")).toBe(DEFAULT_ROOT_FANOUT_LIMIT);
    expect(
      blockerRootFanoutAlertLimitFromSettings({ blockerRootFanoutAlertLimit: 0 }),
    ).toBe(DEFAULT_ROOT_FANOUT_LIMIT);
    expect(
      blockerRootFanoutAlertLimitFromSettings({ blockerRootFanoutAlertLimit: 1.5 }),
    ).toBe(DEFAULT_ROOT_FANOUT_LIMIT);
  });

  it("tolerates unrelated keys stored in instance_settings.general", () => {
    expect(
      blockerRootFanoutAlertLimitFromSettings({
        blockerRootFanoutAlertLimit: 25,
        myrmidonAlertDedup: { some: "entry" },
      }),
    ).toBe(25);
  });
});
