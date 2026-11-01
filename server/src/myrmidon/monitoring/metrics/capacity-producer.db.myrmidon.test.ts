// server/src/myrmidon/monitoring/metrics/capacity-producer.db.myrmidon.test.ts
//
// myrmidon(1.6.6 OPE-9565): integration test against real database and Express routes.
//
// Acceptance Criteria:
// - Production provider is invoked by the real monitoring endpoint and uses real DB/claim sources;
//   CI integration test passes this path.
// - CI verifies population composition of readiness, max age, active share, and absence of source
//   without fake zeroes.
// - CI verifies deduplication of starvation episodes, exactly one rejection event per final rejection,
//   bounded reasons, and counter resets.

import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueClaims,
  issues,
  projects,
  type Db,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import {
  myrmidonMetricsRoutes,
  METRICS_TOKEN_ENV,
} from "./routes.js";
import {
  recordCapacityClaimRejection,
  resetCapacityMetrics,
  produceCapacityMetrics,
} from "./capacity-producer.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-31T12:00:00.000Z");
const TEST_TOKEN = "test-metrics-bearer-token-secret";

describeEmbeddedPostgres("capacity dashboard producer integration (db + routes)", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-cap-metrics-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    resetCapacityMetrics();
    await db.delete(issueClaims);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const id = randomUUID();
    await db.insert(companies).values({
      id,
      name: "capacity-test-co",
      issuePrefix: id.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    return id;
  }

  async function seedAgent(companyId: string, role = "general"): Promise<string> {
    const id = randomUUID();
    await db.insert(agents).values({
      id,
      companyId,
      name: `agent-${id.slice(0, 4)}`,
      role,
      status: "idle",
    });
    return id;
  }

  it("exposes real capacity metrics over GET /metrics with default production provider", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId);

    const projectId = randomUUID();
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Capacity project",
    });

    // 1. Ready issue (todo, unassigned/assigned to active agent, no blockers)
    const [readyIssue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId,
        title: "Ready task",
        status: "todo",
        unresolvedBlockerCount: 0,
        unresolvedInteractionCount: 0,
        createdAt: new Date("2026-10-31T11:58:00.000Z"), // 120s ago
        updatedAt: new Date("2026-10-31T11:58:00.000Z"),
      })
      .returning();

    // 2. Blocked issue (blocked, unresolvedBlockerCount=1)
    await db.insert(issues).values({
      companyId,
      projectId,
      title: "Blocked task",
      status: "blocked",
      unresolvedBlockerCount: 1,
      unresolvedInteractionCount: 0,
    });

    // 3. Active claim on another issue (makes that issue not ready, but adds active slot)
    const [claimedIssue] = await db
      .insert(issues)
      .values({
        companyId,
        projectId,
        title: "Claimed task",
        status: "in_progress",
        unresolvedBlockerCount: 0,
        unresolvedInteractionCount: 0,
      })
      .returning();

    await db.insert(issueClaims).values({
      companyId,
      issueId: claimedIssue.id,
      agentId,
      expiresAt: new Date("2026-10-31T12:05:00.000Z"), // valid lease
    });

    // Record some claim rejections
    recordCapacityClaimRejection("capacity_limit", "attempt-1");
    recordCapacityClaimRejection("project_scope");

    // Mount real router with default production capacity provider (no capacityDashboard override)
    const app = express();
    app.use(myrmidonMetricsRoutes({
      db,
      now: () => NOW,
      env: { [METRICS_TOKEN_ENV]: TEST_TOKEN },
      processMetrics: null,
    }));

    const res = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);

    expect(res.status).toBe(200);
    const text = res.text;

    // Verify all 5 metrics are rendered with correct values
    // open = 3 (ready, blocked, in_progress), ready = 1 -> readiness_ratio = 1/3 ≈ 0.3333333333333333
    expect(text).toContain("# HELP myrmidon_readiness_ratio");
    expect(text).toContain("# TYPE myrmidon_readiness_ratio gauge");
    expect(text).toMatch(/myrmidon_readiness_ratio 0\.3333/);

    // readyIssue updatedAt is 120s before NOW -> queue_age_seconds = 120
    expect(text).toContain("# HELP myrmidon_queue_age_seconds");
    expect(text).toContain("# TYPE myrmidon_queue_age_seconds gauge");
    expect(text).toContain("myrmidon_queue_age_seconds 120");

    // project_share: 1 active slot in projectId -> share = 1
    expect(text).toContain("# HELP myrmidon_project_share");
    expect(text).toContain("# TYPE myrmidon_project_share gauge");
    expect(text).toContain(`myrmidon_project_share{company="${companyId}",project="${projectId}"} 1`);

    // starvation_total: 0
    expect(text).toContain("# HELP myrmidon_starvation_total");
    expect(text).toContain("# TYPE myrmidon_starvation_total counter");
    expect(text).toContain("myrmidon_starvation_total 0");

    // claim_rejection_total: capacity_limit=1, project_scope=1, others=0
    expect(text).toContain("# HELP myrmidon_claim_rejection_total");
    expect(text).toContain("# TYPE myrmidon_claim_rejection_total counter");
    expect(text).toContain('myrmidon_claim_rejection_total{reason="capacity_limit"} 1');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="project_scope"} 1');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="caste_scope"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="assignment_conflict"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="dependency_blocked"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="interaction_pending"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="already_claimed"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="not_ready"} 0');
    expect(text).toContain('myrmidon_claim_rejection_total{reason="other"} 0');
  });

  it("suppresses capacity samples without emitting fake zeroes when provider returns null", async () => {
    const app = express();
    app.use(myrmidonMetricsRoutes({
      db,
      now: () => NOW,
      env: { [METRICS_TOKEN_ENV]: TEST_TOKEN },
      capacityDashboard: null, // explicitly disabled / unavailable
      processMetrics: null,
    }));

    const res = await request(app)
      .get("/metrics")
      .set("Authorization", `Bearer ${TEST_TOKEN}`);

    expect(res.status).toBe(200);
    const text = res.text;

    // Must NOT contain any capacity samples or fake zeroes
    expect(text).not.toContain("myrmidon_readiness_ratio");
    expect(text).not.toContain("myrmidon_queue_age_seconds");
    expect(text).not.toContain("myrmidon_project_share");
    expect(text).not.toContain("myrmidon_starvation_total");
    expect(text).not.toContain("myrmidon_claim_rejection_total");
  });
});
