// myrmidon(1.6.6 C-MEM): the database half of the memory sync journal against an embedded Postgres:
// the claim of a site's running slot, the closing of an abandoned attempt, and the last ok sync.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, myrmidonFleetMemorySyncs } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { fleetMemorySyncStore } from "./fleet-memory-sync-store.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("fleet memory sync journal against a database", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-memory-sync-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(myrmidonFleetMemorySyncs);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "company-a", issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase() });
    return companyId;
  }

  const base = { siteName: "myr-vm1", kind: "nightly" as const, targetBank: "fleet-work-replica", staleAfterMs: 3_600_000 };

  it("gives the running slot of a site to one attempt at a time", async () => {
    const companyId = await seedCompany();
    const store = fleetMemorySyncStore(db);

    const first = await store.begin({ ...base, companyId, botKey: "work-qa" });
    expect(first).toMatchObject({ status: "running", siteName: "myr-vm1", botKey: "work-qa" });
    expect(await store.begin({ ...base, companyId, kind: "forced" })).toBeNull();
    // Another site is independent.
    expect(await store.begin({ ...base, companyId, siteName: "myr-vm2" })).not.toBeNull();

    await store.finish(first!.id, { status: "ok", archiveBytes: 123, documentsImported: 2, documentsSkipped: 1 });
    const second = await store.begin({ ...base, companyId, kind: "forced" });
    expect(second).not.toBeNull();

    const rows = await store.list(companyId, { siteName: "myr-vm1" });
    expect(rows.map((r) => [r.kind, r.status])).toEqual([["forced", "running"], ["nightly", "ok"]]);
    expect(rows[1]).toMatchObject({ archiveBytes: 123, documentsImported: 2, documentsSkipped: 1 });
  });

  it("closes an attempt left running past the stale limit and takes its slot", async () => {
    const companyId = await seedCompany();
    const store = fleetMemorySyncStore(db);
    const old = await store.begin({ ...base, companyId, now: new Date(Date.now() - 2 * 3_600_000) });
    expect(old).not.toBeNull();

    const next = await store.begin({ ...base, companyId });

    expect(next).not.toBeNull();
    const rows = await store.list(companyId);
    const abandoned = rows.find((r) => r.id === old!.id)!;
    expect(abandoned.status).toBe("failed");
    expect(abandoned.error).toMatch(/abandoned/);
  });

  it("reports the last ok sync only, and not a failed or a running one", async () => {
    const companyId = await seedCompany();
    const store = fleetMemorySyncStore(db);
    expect(await store.lastOkAt(companyId, "myr-vm1")).toBeNull();

    const failed = await store.begin({ ...base, companyId });
    await store.finish(failed!.id, { status: "failed", error: "link is down" });
    expect(await store.lastOkAt(companyId, "myr-vm1")).toBeNull();

    const ok = await store.begin({ ...base, companyId });
    const at = new Date("2026-10-24T21:00:00Z");
    await store.finish(ok!.id, { status: "ok" }, at);
    expect((await store.lastOkAt(companyId, "myr-vm1"))?.toISOString()).toBe(at.toISOString());
    expect(await store.lastOkAt(companyId, "myr-vm2")).toBeNull();
  });
});
