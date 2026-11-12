// myrmidon(OPE-12808): credential acquisition by a run the stall sweep cancelled
// while its process was still alive. Fails on the old code (bare 403 always).

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues } from "@myrmidon/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { captureRunIdentity } from "../services/run-identity.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("run identity of a stall-interrupted run", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-run-identity-stall-");
    db = createDb(database.connectionString);
  }, 30_000);
  afterAll(async () => { await database?.cleanup(); }, 60_000);

  async function seed(run: { status: string; errorCode: string | null; finishedAt: Date | null }) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Stall grace", issuePrefix: companyId.slice(0, 8) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent", role: "engineer", adapterType: "codex_local" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Task", responsibleUserId: "owner" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, contextSnapshot: { issueId }, ...run });
    return { companyId, agentId, runId };
  }

  it("lets a run cancelled as stalled a minute ago still obtain its identity", async () => {
    const input = await seed({ status: "cancelled", errorCode: "run_stalled", finishedAt: new Date(Date.now() - 60_000) });
    const captured = await captureRunIdentity(db, input);
    expect(captured.run.id).toBe(input.runId);
  });

  it("refuses a run cancelled as stalled long ago, naming the stall", async () => {
    const input = await seed({ status: "cancelled", errorCode: "run_stalled", finishedAt: new Date(Date.now() - 3_600_000) });
    await expect(captureRunIdentity(db, input)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/interrupted as stalled/),
      details: expect.objectContaining({ code: "run_stalled", runId: input.runId }),
    });
  });

  it("keeps the generic refusal for a run cancelled for another reason", async () => {
    const input = await seed({ status: "cancelled", errorCode: "cancelled_by_user", finishedAt: new Date() });
    await expect(captureRunIdentity(db, input)).rejects.toMatchObject({
      status: 403,
      message: expect.stringMatching(/active run/),
    });
  });
});
