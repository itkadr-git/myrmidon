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
  agentWakeupRequests,
  knowledgeItems,
  knowledgeRevisions,
  knowledgeSources,
  issueWorkProducts,
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
import { issueRecoveryActionService } from "../../../services/issue-recovery-actions.js";
import { createRecoveryFactoryMetrics } from "@myrmidon/shared";
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
    await db.delete(agentWakeupRequests);
    await db.delete(litellmCostEvents);
    await db.delete(knowledgeSources);
    await db.delete(knowledgeRevisions);
    await db.delete(knowledgeItems);
    await db.delete(issueWorkProducts);
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
      createdAt?: Date;
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
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    });
    return runId;
  }

  it("counts deferred issue executions older than thirty minutes", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    await db.insert(agentWakeupRequests).values([
      { companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "cancelled", requestedAt: new Date(NOW.getTime() - 40 * 60_000) },
      { companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedAt: new Date(NOW.getTime() - 31 * 60_000), createdAt: new Date(NOW.getTime() - 31 * 60_000), runId: randomUUID() },
      { companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedAt: new Date(NOW.getTime() - 31 * 60_000), createdAt: new Date(NOW.getTime() - 31 * 60_000) },
      { companyId, agentId, source: "automation", reason: "issue_execution_deferred", status: "deferred_issue_execution", requestedAt: new Date(NOW.getTime() - 29 * 60_000), createdAt: new Date(NOW.getTime() - 29 * 60_000) },
    ]);
    const snapshot = await collectMetricsSnapshot({ db, now: () => NOW, errorWindowSec: 3600, latencyWindowSec: 3600 });
    expect(snapshot.deferredIssueExecutionOver30m).toBe(1);
  });

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

  it("reports recovery factory production behavior and addressless row in /metrics", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    const sourceIssueId = randomUUID();
    await db.insert(issues).values({ id: sourceIssueId, companyId, title: "Recovery source", status: "todo", priority: "normal", createdAt: NOW, updatedAt: NOW });

    const metricsPort = createRecoveryFactoryMetrics();
    const factory = issueRecoveryActionService(db, metricsPort);

    // 1. Production created
    const created = await factory.ensureRecoveryIssue({
      sourceIssueId,
      kind: "ci_restart",
      dedupeKey: `recovery-factory-ci-${sourceIssueId}`,
      owner: { agentId },
      slaMinutes: 30,
      nextCheckAt: new Date(NOW.getTime() + 60_000).toISOString(),
      evidence: {},
    });
    expect(created.outcome).toBe("created");

    // 2. Production deduped
    const deduped = await factory.ensureRecoveryIssue({
      sourceIssueId,
      kind: "ci_restart",
      dedupeKey: `recovery-factory-ci-${sourceIssueId}`,
      owner: { agentId },
      slaMinutes: 30,
      nextCheckAt: new Date(NOW.getTime() + 60_000).toISOString(),
      evidence: {},
    });
    expect(deduped.outcome).toBe("deduped");

    // 3. Production succeeded via resolveActiveForIssue
    const resolved = await factory.resolveActiveForIssue({
      companyId,
      sourceIssueId,
      actionId: created.recoveryActionId,
      status: "resolved",
      outcome: "restored",
      resolutionNote: "CI green on retry",
    });
    expect(resolved?.status).toBe("resolved");

    const actionId = randomUUID();
    try {
      await db.execute(sql`ALTER TABLE "issue_recovery_actions" DROP CONSTRAINT IF EXISTS "issue_recovery_actions_dedupe_owner_sla_check"`);
      // Active addressless legacy row with createdAt 45 seconds ago (tests addressless count + DB collector age calculation)
      await db.insert(issueRecoveryActions).values({
        id: actionId,
        companyId,
        sourceIssueId,
        kind: "operator_action",
        status: "active",
        ownerType: "agent",
        ownerAgentId: null,
        ownerUserId: null,
        ownerQueue: null,
        cause: "operator_intervention",
        fingerprint: "recovery-metrics-addressless",
        dedupeKey: "recovery-metrics-addressless",
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
        recoveryFactoryMetrics: metricsPort,
      });
      const text = renderMetricsText(snapshot);

      expect(text).toContain('myrmidon_recovery_created_total{role="all",kind="ci_restart"} 1');
      expect(text).toContain('myrmidon_recovery_deduped_total{role="all",kind="ci_restart"} 1');
      expect(text).toContain('myrmidon_recovery_success_total{role="all",kind="ci_restart"} 1');
      expect(text).toContain('myrmidon_recovery_age_seconds{role="all",kind="operator_action"} 45');
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
    await seedRun(companyId, agentId, { status: "queued", createdAt: new Date(NOW.getTime() - 31 * 60 * 1000) });
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
    expect(snapshot.runsQueued).toBe(3);
    expect(snapshot.runsQueuedOver30m).toBe(1);
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

  it("counts queued runs older than 30 minutes separately", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    await seedRun(companyId, agentId, { status: "queued", createdAt: new Date(NOW.getTime() - 31 * 60 * 1000) });
    await seedRun(companyId, agentId, { status: "queued", createdAt: new Date(NOW.getTime() - 5 * 60 * 1000) });
    const snapshot = await collectMetricsSnapshot({ db, now: () => NOW, errorWindowSec: 3600, latencyWindowSec: 3600 });
    expect(snapshot.runsQueued).toBe(2);
    expect(snapshot.runsQueuedOver30m).toBe(1);
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

  it("knowledge-on-change share counts only closed tasks with a system change, with and without a wiki revision", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent(companyId, "engineer");
    const closedAt = new Date(NOW.getTime() - 24 * 3600 * 1000);

    // A knowledge item + revision, created a day after the merge.
    const itemId = randomUUID();
    await db.insert(knowledgeItems).values({
      id: itemId,
      companyId,
      nestId: companyId,
      kind: "note",
      slug: "device-overview",
      title: "Device overview",
    });
    const revisionId = randomUUID();
    await db.insert(knowledgeRevisions).values({
      id: revisionId,
      companyId,
      nestId: companyId,
      itemId,
      revisionNumber: 1,
      content: "# Device overview",
      createdAt: new Date(NOW.getTime() - 12 * 3600 * 1000),
    });

    // Task 1: closed with a merged PR (a system change) AND a task-linked
    // knowledge source — counts in both numerator and denominator.
    const changedCoveredId = randomUUID();
    const changedCoveredIdentifier = `OPE-AAA${randomUUID().slice(0, 4).toUpperCase()}`;
    await db.insert(issues).values({
      id: changedCoveredId,
      companyId,
      identifier: changedCoveredIdentifier,
      title: "Task 1",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: closedAt,
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId: changedCoveredId,
      type: "pull_request",
      provider: "github",
      externalId: "pr-1",
      title: "PR 1",
      status: "merged",
      updatedAt: closedAt,
    });
    await db.insert(knowledgeSources).values({
      id: randomUUID(),
      companyId,
      nestId: companyId,
      revisionId,
      kind: "task",
      ref: changedCoveredIdentifier,
    });
    // The same revision is also linked to the merged PR for the delay half.
    await db.insert(knowledgeSources).values({
      id: randomUUID(),
      companyId,
      nestId: companyId,
      revisionId,
      kind: "pr",
      ref: "pr-1",
    });

    // Task 2: closed with a merged PR but WITHOUT any knowledge source —
    // denominator only, the gap the metric must expose.
    const changedBareId = randomUUID();
    await db.insert(issues).values({
      id: changedBareId,
      companyId,
      identifier: `OPE-BBB${randomUUID().slice(0, 4).toUpperCase()}`,
      title: "Task 2",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: closedAt,
    });
    await db.insert(issueWorkProducts).values({
      id: randomUUID(),
      companyId,
      issueId: changedBareId,
      type: "pull_request",
      provider: "github",
      externalId: "pr-2",
      title: "PR 2",
      status: "merged",
    });

    // Task 3: closed WITHOUT any merged PR — not a system change, so it must
    // stay out of the denominator entirely.
    const unchangedId = randomUUID();
    const unchangedIdentifier = `OPE-CCC${randomUUID().slice(0, 4).toUpperCase()}`;
    await db.insert(issues).values({
      id: unchangedId,
      companyId,
      identifier: unchangedIdentifier,
      title: "Task 3",
      status: "done",
      priority: "medium",
      assigneeAgentId: agentId,
      completedAt: closedAt,
    });
    // A task-linked source on the unchanged task must NOT lift the share.
    await db.insert(knowledgeSources).values({
      id: randomUUID(),
      companyId,
      nestId: companyId,
      revisionId,
      kind: "task",
      ref: unchangedIdentifier,
    });

    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    // 1 of 2 changed tasks is covered; the unchanged task is excluded.
    expect(snapshot.knowledgeOnChangeShare).toBe(0.5);
    // The revision landed 12h after the PR row's updatedAt (seeded NOW),
    // so the delay p50/p95 sample the same single delay.
    expect(snapshot.knowledgeRevisionDelaySecondsP50).toBe(12 * 3600);
    expect(snapshot.knowledgeRevisionDelaySecondsP95).toBe(12 * 3600);
  });

  it("knowledge-on-change share renders no sample when no changed tasks closed in the window", async () => {
    const companyId = await seedCompany();
    // A closed task without any work product: denominator empty.
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      identifier: `OPE-DDD${randomUUID().slice(0, 4).toUpperCase()}`,
      title: "Task 4",
      status: "done",
      priority: "medium",
      completedAt: new Date(NOW.getTime() - 24 * 3600 * 1000),
    });
    const snapshot = await collectMetricsSnapshot({
      db,
      now: () => NOW,
      errorWindowSec: 3600,
      latencyWindowSec: 3600,
    });
    expect(snapshot.knowledgeOnChangeShare).toBeNull();
    const text = renderMetricsText(snapshot);
    expect(text).toContain("# HELP myrmidon_knowledge_on_change_share ");
    expect(text).not.toContain("myrmidon_knowledge_on_change_share{");
  });
});
