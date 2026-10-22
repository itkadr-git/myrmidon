// myrmidon(DB-PERF-C-P5): regression test on a real PostgreSQL. The mock-based
// gate tests never reach the driver, so a `Date` bound inside a raw `sql`
// template ("The "string" argument must be of type string ... Received an
// instance of Date") passed them and failed on every production tick.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import {
  createChatReconciliationWorkGates,
  hasDeliveryWork,
  hasPublicationWork,
  hasRunMilestoneWork,
  hasSlackFileReceiptWork,
  hasSlackSessionSyncWork,
} from "./work-gates.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describeEmbeddedPostgres("chat reconciliation work gates on PostgreSQL", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-chat-work-gates-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterAll(async () => {
    if (tempDb) await tempDb.cleanup();
  });

  it("runs every standalone gate with Date inputs without throwing", async () => {
    await expect(hasPublicationWork(db, { now: new Date() })).resolves.toBe(false);
    await expect(hasDeliveryWork(db)).resolves.toBe(false);
    await expect(hasSlackFileReceiptWork(db)).resolves.toBe(false);
    await expect(hasSlackSessionSyncWork(db)).resolves.toBe(false);
    await expect(hasRunMilestoneWork(db, { since: new Date() })).resolves.toBe(false);
    await expect(hasRunMilestoneWork(db, { since: null })).resolves.toBe(true);
  });

  it("runs the coordinator gates past their safety windows (the probe path)", async () => {
    const gates = createChatReconciliationWorkGates({ db });
    // The first call of each lane is a forced pass; record a pass so the next
    // call goes through the SQL probe that binds the timestamp.
    expect(await gates.hasPublicationWork()).toBe(true);
    gates.notePublicationPassCompleted(new Date());
    await expect(gates.hasPublicationWork()).resolves.toBe(false);
    expect(await gates.hasMilestoneWork()).toBe(true);
    gates.noteMilestonePassCompleted(new Date(), 0);
    await expect(gates.hasMilestoneWork()).resolves.toBe(false);
  });
});
