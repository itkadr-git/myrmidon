import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns } from "@myrmidonai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService } from "../services/heartbeat.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported
  ? describe
  : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat agent error tests on this host: ${
      embeddedPostgresSupport.reason ?? "unsupported environment"
    }`,
  );
}

describeEmbeddedPostgres(
  "agent status finalization: transient vs permanent error classification",
  () => {
    let db!: ReturnType<typeof createDb>;
    let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null =
      null;
    const companyId = randomUUID();

    beforeAll(async () => {
      tempDb = await startEmbeddedPostgresTestDatabase(
        "heartbeat-agent-error-test-",
      );
      db = createDb(tempDb.connectionString);
      await db.insert(companies).values({
        id: companyId,
        name: "Heartbeat Agent Error Classification",
        issuePrefix: "HAEC",
      });
    }, 60_000);

    afterAll(async () => {
      await tempDb?.cleanup();
    });

    async function seedAgent() {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Test Agent",
        role: "engineer",
        adapterType: "paperclip_runner",
        status: "idle",
      });
      return agentId;
    }

    async function getAgentRow(agentId: string) {
      const rows = await db
        .select({
          status: agents.status,
          errorReason: agents.errorReason,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(eq(agents.id, agentId));
      return rows[0] ?? null;
    }

    it("keeps agent idle on a single transient process loss failure and increments consecutiveFailures", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);
      const runId = randomUUID();

      await db.insert(heartbeatRuns).values({
        id: runId,
        companyId,
        agentId,
        status: "running",
        processPid: 99999999,
        contextSnapshot: {},
      });

      await heartbeat.reapOrphanedRuns();

      const row = await getAgentRow(agentId);
      expect(row?.status).toBe("idle");
      expect(row?.errorReason).toBeNull();
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(1);
    });

    it("transitions agent to error after 3 consecutive failures", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);

      for (let i = 1; i <= 3; i++) {
        const runId = randomUUID();
        await db.insert(heartbeatRuns).values({
          id: runId,
          companyId,
          agentId,
          status: "running",
          processPid: 99999990 + i,
          contextSnapshot: {},
        });
        await heartbeat.reapOrphanedRuns();

        const row = await getAgentRow(agentId);
        if (i < 3) {
          expect(row?.status).toBe("idle");
          expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(i);
        } else {
          expect(row?.status).toBe("error");
          expect(row?.errorReason).toContain("3 consecutive runs failed");
          expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(3);
        }
      }
    });
  },
);
