// myrmidon(1.7-METRICS): the collector against an embedded Postgres. The
// counters, the role/status breakdown, the claim counters, the cost window
// and the latency percentiles are all read from the tables the board already
// writes — this suite proves those reads land on real rows.

import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import {
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueClaims,
  issueRecoveryActions,
  issues,
  litellmCostEvents,
} from "@myrmidon/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { collectMetricsSnapshot, runMetricsSelfCheck, METRIC_FAMILIES, renderMetricsText } from "./metrics.js";
import type { IssueRecoveryActionKind, RecoveryFactoryMetrics as RecoveryFactoryMetricsPort } from "@myrmidon/shared";
import { recordSwarmClaimSignal, resetSwarmClaimSignals } from "./swarm-signals.js";
import { resetStaleBlockSignals, recordStaleBlockSignal } from "../../stale-block/attention.js";
import { resetTracingHealthSignals } from "../../tracing-health/attention.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const NOW = new Date("2026-10-03T12:00:00.000Z");

describeEmbeddedPostgres("metrics collector", () => {
  vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-metrics-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    resetSwarmClaimSignals();
    resetStaleBlockSignals();
    resetTracingHealthSignals();
    await db.delete(litellmCostEvents);
    await db.delete(issueClaims);
    await db.delete(issueRecoveryActions);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: companyId.replace(/-/g, "").slice(0, 8).toUpperCase(),
    });
    return companyId;
  }

  async function seedAgent(companyId: string, role: string) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `agent-${role}`,
      role,
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return agentId;
  }

  async function seedRun(
    companyId: string,
    agentId: string,
    input: {
      status: string;
      startedAt?: Date;
      finishedAt?: Date;
    },
  ) {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: input.status,
      startedAt: input.startedAt ?? null,
      finishedAt: input.finishedAt ?? null,
    });
    return runId;
  }

  it("reads active recovery age and counts manually seeded addressless actions", async () => {
    const companyId = await seedCompany();
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({
      id: sourceIssueId,
      companyId,
      title: "Recovery source",
      status: "todo",
      priority: "normal",
      createdAt: NOW,
      updatedAt: NOW,
    });
    const recoveryActionId = randomUUID();
    try {
      await db.execute(sql`ALTER TABLE "issue_recovery_actions" DROP CONSTRAINT IF EXISTS "issue_recovery_actions_dedupe_owner_sla_check"`);
      await db.insert(issueRecoveryActions).values({
        id: recoveryActionId,
        companyId,
        sourceIssueId,
        kind: "ci_restart",
        status: "active",
        ownerType: "agent",
        ownerAgentId: null,
        ownerUserId: null,
        ownerQueue: null,
        cause: "ci_failure",
        fingerprint: "fingerprint-a",
        dedupeKey: "dedupe-a",
        slaDueAt: new Date(NOW.getTime() + 60_000),
        nextCheckAt: new Date(NOW.getTime() + 30_000),
        nextAction: "inspect",
        createdAt: new Date(NOW.getTime() - 45_000),
        updatedAt: NOW,
      });
      const snapshot = await collectMetricsSnapshot({
        db,
        now: () => NOW,
        errorWindowSec: 3600,
        latencyWindowSec: 3600,
      });
      expect(snapshot.recoveryAddresslessActive).toBe(1);
      expect(snapshot.recoveryAgeSeconds).toEqual([{ kind: "ci_restart", seconds: 45 }]);
    } finally {
      await db.delete(issueRecoveryActions);
      await db.execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_dedupe_owner_sla_check') THEN
            ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_dedupe_owner_sla_check"
              CHECK ("dedupe_key" IS NULL OR (
                (CASE WHEN "owner_agent_id" IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN "owner_user_id" IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN "owner_queue" IS NOT NULL THEN 1 ELSE 0 END) = 1
                AND "sla_due_at" IS NOT NULL
                AND "next_check_at" IS NOT NULL
              ));
          END IF;
        END $$;
      `);
    }
  });

  it("reports recovery factory counters and the manually inserted addressless row in /metrics", async () => {
    const companyId = await seedCompany();
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Recovery source", status: "todo", priority: "normal", createdAt: NOW, updatedAt: NOW });
    const actionId = randomUUID();
    try {
      await db.execute(sql`ALTER TABLE "issue_recovery_actions" DROP CONSTRAINT IF EXISTS "issue_recovery_actions_dedupe_owner_sla_check"`);
      await db.insert(issueRecoveryActions).values({
        id: actionId, companyId, sourceIssueId, kind: "ci_restart", status: "active", ownerType: "agent",
        ownerAgentId: null, ownerUserId: null, ownerQueue: null, cause: "ci_failure", fingerprint: "recovery-metrics-test",
        dedupeKey: "recovery-metrics-addressless", slaDueAt: new Date(NOW.getTime() + 60_000),
        nextCheckAt: new Date(NOW.getTime() + 30_000), nextAction: "inspect",
        createdAt: new Date(NOW.getTime() - 45_000), updatedAt: NOW,
      });
      const counters = {
        created: new Map<IssueRecoveryActionKind, number>(),
        deduped: new Map<IssueRecoveryActionKind, number>(),
        succeeded: new Map<IssueRecoveryActionKind, number>(),
      };
      const ages = new Map<IssueRecoveryActionKind, number>();
      const metrics: RecoveryFactoryMetricsPort = {
        created: (kind) => counters.created.set(kind, (counters.created.get(kind) ?? 0) + 1),
        deduped: (kind) => counters.deduped.set(kind, (counters.deduped.get(kind) ?? 0) + 1),
        succeeded: (kind) => counters.succeeded.set(kind, (counters.succeeded.get(kind) ?? 0) + 1),
        age: (kind, seconds) => ages.set(kind, Math.max(ages.get(kind) ?? 0, seconds)),
      };
      metrics.created("ci_restart");
      metrics.deduped("github_access");
      metrics.succeeded("workspace_myr_ws");
      metrics.age("operator_action", 20);
      metrics.age("operator_action", 42);
      const text = renderMetricsText(await collectMetricsSnapshot({
        db, now: () => NOW, errorWindowSec: 3600, latencyWindowSec: 3600,
        recoveryFactoryMetrics: metrics,
      }));
      expect(text).toContain('myrmidon_recovery_created_total{role="all",kind="ci_restart"} 1');
      expect(text).toContain('myrmidon_recovery_deduped_total{role="all",kind="github_access"} 1');
      expect(text).toContain('myrmidon_recovery_success_total{role="all",kind="workspace_myr_ws"} 1');
      expect(text).toContain('myrmidon_recovery_age_seconds{role="all",kind="operator_action"} 42');
      expect(text).toContain('myrmidon_recovery_age_seconds{role="all",kind="ci_restart"} 45');
      expect(text).toContain('myrmidon_recovery_addressless_active{role="all"} 1');
    } finally {
      await db.delete(issueRecoveryActions);
      await db.execute(sql`
        DO $$ BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'issue_recovery_actions_dedupe_owner_sla_check') THEN
            ALTER TABLE "issue_recovery_actions" ADD CONSTRAINT "issue_recovery_actions_dedupe_owner_sla_check"
              CHECK ("dedupe_key" IS NULL OR (
                (CASE WHEN "owner_agent_id" IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN "owner_user_id" IS NOT NULL THEN 1 ELSE 0 END +
                 CASE WHEN "owner_queue" IS NOT NULL THEN 1 ELSE 0 END) = 1
                AND "sla_due_at" IS NOT NULL
                AND "next_check_at" IS NOT NULL
              ));
          END IF;
        END $$;
      `);
    }
  });

  it("counts active, queued and failed runs", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    await seedRun(companyId, agentId, { status: "running", startedAt: NOW });
    await seedRun(companyId, agentId, { status: "claimed", startedAt: NOW });
    await seedRun(companyId, agentId, { status: "queued" });
    await seedRun(companyId, agentId, { status: "retrying" });
    await seedRun(companyId, agentId, {
      status: "failed",
      startedAt: new Date(NOW.getTime() - 1000),
      finishedAt: NOW,
    });

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.runsActive).toBe(2);
    expect(snapshot.runsQueued).toBe(2);
    expect(snapshot.runsFailedTotal).toBe(1);
    expect(snapshot.runsFailedWindow).toBe(1);
    expect(snapshot.scrapeErrors).toBe(0);
  });

  it("counts failed runs only inside the error window", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    const old = new Date(NOW.getTime() - 10 * 3600 * 1000);
    await seedRun(companyId, agentId, {
      status: "failed",
      startedAt: new Date(old.getTime() - 1000),
      finishedAt: old,
    });
    await seedRun(companyId, agentId, {
      status: "failed",
      startedAt: new Date(NOW.getTime() - 1000),
      finishedAt: NOW,
    });

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.runsFailedTotal).toBe(2);
    expect(snapshot.runsFailedWindow).toBe(1);
  });

  it("computes p50/p95 run durations over finished runs", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    for (const seconds of [10, 20, 30, 40, 50]) {
      await seedRun(companyId, agentId, {
        status: "succeeded",
        startedAt: new Date(NOW.getTime() - seconds * 1000),
        finishedAt: NOW,
      });
    }

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.runDurationSecondsP50).toBe(30);
    expect(snapshot.runDurationSecondsP95).toBe(48);
  });

  it("breaks issue queues down by assignee role and status", async () => {
    const companyId = await seedCompany();
    const engineerId = await seedAgent(companyId, "engineer");
    const reviewerId = await seedAgent(companyId, "reviewer");
    for (const [agentId, status, count] of [
      [engineerId, "todo", 2],
      [engineerId, "in_progress", 1],
      [reviewerId, "in_review", 3],
    ] as Array<[string, string, number]>) {
      for (let i = 0; i < count; i += 1) {
        await db.insert(issues).values({
          id: randomUUID(),
          companyId,
          identifier: `M${randomUUID().slice(0, 6).toUpperCase()}`,
          title: "Task a",
          status,
          priority: "medium",
          assigneeAgentId: agentId,
        });
      }
    }

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    const byRole = new Map(snapshot.roleQueueTasks.map((row) => [`${row.role}:${row.status}`, row.count]));
    expect(byRole.get("engineer:todo")).toBe(2);
    expect(byRole.get("engineer:in_progress")).toBe(1);
    expect(byRole.get("reviewer:in_review")).toBe(3);
  });

  it("counts SWARM claims (active live, total rows)", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    const agentId2 = await seedAgent(companyId, "engineer");
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: `M${randomUUID().slice(0, 6).toUpperCase()}`,
      title: "Task a",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    // One live, un-expired claim.
    await db.insert(issueClaims).values({
      id: randomUUID(),
      companyId,
      issueId,
      agentId: agentId2,
      role: "engineer",
      claimedAt: new Date(NOW.getTime() - 60_000),
      heartbeatAt: new Date(NOW.getTime() - 60_000),
      expiresAt: new Date(NOW.getTime() + 600_000),
    });
    // One released historical claim.
    await db.insert(issueClaims).values({
      id: randomUUID(),
      companyId,
      issueId,
      agentId: agentId2,
      role: "engineer",
      claimedAt: new Date(NOW.getTime() - 3_600_000),
      heartbeatAt: new Date(NOW.getTime() - 3_600_000),
      expiresAt: new Date(NOW.getTime() - 1_800_000),
      releasedAt: new Date(NOW.getTime() - 1_800_000),
      releaseReason: "finished",
    });

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.swarmClaimsActive).toBe(1);
    expect(snapshot.swarmClaimsTotal).toBe(2);
  });

  it("sums the litellm cost window in cents", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    const recent = [100, 200];
    const old = 999;
    for (const cents of recent) {
      await db.insert(litellmCostEvents).values({
        id: randomUUID(),
        companyId,
        agentId,
        provider: "provider-a",
        model: "model-a",
        inputTokens: 10,
        outputTokens: 20,
        costCents: cents,
        occurredAt: NOW,
        requestId: randomUUID(),
      });
    }
    await db.insert(litellmCostEvents).values({
      id: randomUUID(),
      companyId,
      agentId,
      provider: "provider-a",
      model: "model-a",
      inputTokens: 10,
      outputTokens: 20,
      costCents: old,
      occurredAt: new Date(NOW.getTime() - 10 * 3600 * 1000),
      requestId: randomUUID(),
    });

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.llmCostCentsWindow).toBe(300);
  });

  it("counts agent error signals from the attention registries", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    recordSwarmClaimSignal(companyId, "claim-expired", {
      companyId,
      reason: "lease expired",
      recordedAt: NOW.toISOString(),
    });
    recordStaleBlockSignal({
      issueId: randomUUID(),
      companyId,
      identifier: null,
      title: null,
      reasonTexts: ["blocker done"],
      liftedAt: NOW.toISOString(),
    });
    void agentId;

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.agentErrorSignals).toBe(2);
  });

  it("a failing family read counts as a scrape error, not a crash", async () => {
    // A db stub that throws on every select: every family falls back, and
    // the scrape itself must stay green with scrapeErrors counted.
    const failingDb = {
      select: () => {
        throw new Error("database unavailable");
      },
    } as never;

    const snapshot = await collectMetricsSnapshot({
      db: failingDb,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.scrapeErrors).toBeGreaterThan(0);
    expect(snapshot.runsActive).toBe(0);
    expect(snapshot.roleQueueTasks).toEqual([]);
  });

  it("the self-check probe is green over real rows — the runbook link", async () => {
    // 1.6.6 annex: every link self-checks. The probe scrapes every family
    // once against the real tables; the failures it names are exactly what
    // myrmidon_scrape_errors exposes in /metrics, and the alerting half
    // opens a task for the owning role from that counter (runbook link:
    // visible scrape errors in /metrics -> alerting maps them -> role task).
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    await seedRun(companyId, agentId, { status: "running", startedAt: NOW });

    const result = await runMetricsSelfCheck({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(result.ok).toBe(true);
    expect(result.families_failed).toEqual([]);
    expect(result.families_ok).toBe(METRIC_FAMILIES.length);
    expect(result.scrape_ms).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(result)).not.toContain("company-a");
  });
});
