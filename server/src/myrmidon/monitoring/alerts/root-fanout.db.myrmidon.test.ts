import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, instanceSettings, issueComments, issueRelations, issues } from "@myrmidon/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "../../../__tests__/helpers/embedded-postgres.js";
import { ALERT_DEDUP_GENERAL_KEY } from "./store.js";
import { createRootFanoutAlertCollector, ROOT_FANOUT_ALERT } from "./root-fanout.js";

describe("root fan-out monitoring with real B3 loader and alert persistence", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
  let db: ReturnType<typeof createDb>;
  let postgres: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    // Intentionally no skip: unavailable Postgres must fail this acceptance test.
    postgres = await startEmbeddedPostgresTestDatabase("root-fanout-alert-");
    db = createDb(postgres.connectionString);
  }, 120_000);

  afterAll(async () => { await postgres?.cleanup(); });

  it("opens once for OPE-8079's twenty dependents, dedups concurrent periods, closes and reopens", async () => {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "fan-out acceptance", issuePrefix: "FAN", issueCounter: 30 });
    const rootIssueId = randomUUID();
    await db.insert(issues).values({ id: rootIssueId, companyId, title: "OPE-8079 root", identifier: "OPE-8079", status: "blocked", issueNumber: 1 });
    const dependents = Array.from({ length: 20 }, (_, index) => ({
      id: randomUUID(), companyId, title: `held ${index}`, status: "blocked", issueNumber: index + 2,
    }));
    await db.insert(issues).values(dependents);
    await db.insert(issueRelations).values(dependents.map((dependent) => ({
      companyId, issueId: rootIssueId, relatedIssueId: dependent.id, type: "blocks" as const,
    })));
    const collect = createRootFanoutAlertCollector(db);
    const [created] = await collect(companyId);
    expect(created.action).toBe("create");
    const [alert] = await db.select().from(issues).where(eq(issues.id, created.issueId!));
    expect(alert.title).toContain(ROOT_FANOUT_ALERT);
    expect(alert.title).toContain("OPE-8079");
    expect(alert.title).toContain("20 tasks");
    const repeats = await Promise.all([collect(companyId), collect(companyId)]);
    expect(repeats.map((outcomes) => outcomes[0].action)).toEqual(["ignore", "ignore"]);
    expect((await db.select().from(issues).where(eq(issues.companyId, companyId)))
      .filter((row) => row.title.includes(ROOT_FANOUT_ALERT))).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, alert.id))).toHaveLength(0);

    await db.update(issues).set({ status: "done" }).where(eq(issues.id, rootIssueId));
    expect((await collect(companyId))[0]).toMatchObject({ action: "resolve", issueId: alert.id });
    expect((await db.select().from(issues).where(eq(issues.id, alert.id)))[0].status).toBe("done");
    const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default"));
    const registry = settings.general[ALERT_DEDUP_GENERAL_KEY] as Record<string, { issueStatus: string }>;
    expect(registry[`alertmanager:${ROOT_FANOUT_ALERT}:${rootIssueId}`].issueStatus).toBe("resolved");
    expect(await collect(companyId)).toEqual([]);

    await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, rootIssueId));
    const [reopened] = await collect(companyId);
    expect(reopened.action).toBe("create");
    expect(reopened.issueId).not.toBe(alert.id);

    await db.update(instanceSettings).set({
      general: { ...(await db.select().from(instanceSettings))[0].general, blockerRootFanoutAlertLimit: 20 },
    }).where(eq(instanceSettings.singletonKey, "default"));
    expect((await collect(companyId))[0]).toMatchObject({ action: "resolve", issueId: reopened.issueId });
  });
});
