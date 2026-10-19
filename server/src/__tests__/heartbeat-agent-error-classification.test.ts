import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
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

    async function seedAgent(initialStatus: "idle" | "running" = "idle") {
      const agentId = randomUUID();
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "Test Agent",
        role: "engineer",
        adapterType: "paperclip_runner",
        status: initialStatus,
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

    it("keeps agent idle on a single transient failure and increments consecutiveFailures", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);

      // Transient failure: continuation_source_context_missing
      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "continuation_source_context_missing",
        {
          errorCode: "continuation_source_context_missing",
        },
      );

      const row = await getAgentRow(agentId);
      expect(row?.status).toBe("idle");
      expect(row?.errorReason).toBeNull();
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(1);
    });

    it("keeps agent idle on stream interruption and controller lease loss", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);

      // 1st transient failure: stream interrupted
      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "stream was interrupted during model generation",
        {
          errorCode: "stream_interrupted",
        },
      );
      let row = await getAgentRow(agentId);
      expect(row?.status).toBe("idle");
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(1);

      // 2nd transient failure: controller lease lost
      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "controller lease lost",
        {
          errorCode: "controller_lease_lost",
        },
      );
      row = await getAgentRow(agentId);
      expect(row?.status).toBe("idle");
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(2);

      // 3rd failure reaches maxFailures (default 3) -> transitions to error
      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "transient_network_error",
        {
          errorCode: "transient_network_error",
        },
      );
      row = await getAgentRow(agentId);
      expect(row?.status).toBe("error");
      expect(row?.errorReason).toContain("3 consecutive runs failed");
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(3);
    });

    it("resets consecutiveFailures to 0 on subsequent successful run", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);

      // 1 transient failure
      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "network timeout",
        {
          errorCode: "timeout",
        },
      );
      let row = await getAgentRow(agentId);
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(1);

      // Successful run
      await heartbeat.finalizeAgentStatus(agentId, "succeeded", null);
      row = await getAgentRow(agentId);
      expect(row?.status).toBe("idle");
      expect(row?.errorReason).toBeNull();
      expect((row?.metadata as Record<string, unknown>)?.consecutiveFailures).toBe(0);
    });

    it("immediately transitions agent to error on permanent failure (quota, auth, config)", async () => {
      const agentId = await seedAgent();
      const heartbeat = heartbeatService(db);

      await heartbeat.finalizeAgentStatus(
        agentId,
        "failed",
        "Monthly spending limit reached",
        {
          errorCode: "provider_quota",
        },
      );

      const row = await getAgentRow(agentId);
      expect(row?.status).toBe("error");
      expect(row?.errorReason).toBe("Monthly spending limit reached");
    });
  },
);
