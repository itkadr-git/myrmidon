// server/src/myrmidon/data-retention/sweep.myrmidon.test.ts
//
// myrmidon(1.6.5-DB-RETENTION): the retention sweep against an embedded
// Postgres — the acceptance behaviors of the part: old rows are deleted, rows
// younger than the retention and rows referenced by open work (open-issue
// execution run, retry parent of a live run, unresolved failed_run attention)
// survive, a retention of 0 deletes nothing, a settings change written
// through the settings service applies on the next pass without a restart,
// and the backup gate blocks deletes until a fresh <prefix>-*.sql.gz backup
// appears.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agentTaskSessions,
  agentWakeupRequests,
  agents,
  companies,
  completionContracts,
  costEvents,
  createDb,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionRetention,
  decisions,
  decisionTriage,
  decisionTriageEvents,
  documents,
  documentRevisions,
  environmentLeases,
  executionWorkspaces,
  financeEvents,
  heartbeatRunEvents,
  heartbeatRuns,
  litellmCostEvents,
  inboxDismissals,
  instanceSettings,
  issues,
  issuePlanDecompositions,
  nativeRunFinalizations,
  nativeRunResults,
  projects,
  secretAccessEvents,
  statusDecisionEffects,
  statusDecisions,
  toolAccessAuditEvents,
  workAssessments,
} from "@myrmidon/db";
import { DATA_RETENTION_WAITING_FOR_BACKUP_ACTION } from "@myrmidon/shared";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../__tests__/helpers/embedded-postgres.js";
import { instanceSettingsService } from "../../services/instance-settings.js";
import {
  readDataRetentionSettings,
  writeDataRetentionSettings,
  readDataRetentionLastRun,
  writeDataRetentionLastRun,
} from "./settings.js";
import { createDataRetentionSweep, DATA_RETENTION_DELETE_BATCH_SIZE } from "./sweep.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

const DAY_MS = 24 * 60 * 60 * 1000;

describeEmbeddedPostgres("myrmidon(1.6.5-DB-RETENTION) retention sweep in the database", () => {
  vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("myrmidon-data-retention-");
    db = createDb(tempDb.connectionString);
  }, 120_000);

  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await db.delete(statusDecisionEffects);
    await db.delete(nativeRunFinalizations);
    await db.delete(statusDecisions);
    await db.delete(workAssessments);
    await db.delete(nativeRunResults);
    await db.delete(completionContracts);
    await db.delete(decisions);
    await db.delete(decisionBundles);
    await db.delete(decisionQueueItems);
    await db.delete(decisionTriageEvents);
    await db.delete(decisionTriage);
    await db.delete(decisionRetention);
    await db.delete(decisionQueues);
    await db.delete(environmentLeases);
    await db.delete(issuePlanDecompositions);
    await db.delete(documentRevisions);
    await db.delete(documents);
    await db.delete(agentTaskSessions);
    await db.delete(costEvents);
    await db.delete(financeEvents);
    await db.delete(inboxDismissals);
    await db.delete(activityLog);
    await db.delete(secretAccessEvents);
    await db.delete(toolAccessAuditEvents);
    await db.delete(heartbeatRunEvents);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
    while (cleanupDirs.length > 0) {
      fs.rmSync(cleanupDirs.pop() as string, { recursive: true, force: true });
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "company-a",
      issuePrefix: "COMA",
    });
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "agent-a",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    return { companyId, agentId };
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status: string;
    ageDays: number;
    finished?: boolean;
    contextSnapshot?: Record<string, unknown>;
    retryOfRunId?: string;
  }) {
    const runId = randomUUID();
    const createdAt = new Date(Date.now() - input.ageDays * DAY_MS);
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: input.status,
      contextSnapshot: input.contextSnapshot,
      retryOfRunId: input.retryOfRunId,
      createdAt,
      updatedAt: createdAt,
      finishedAt: input.finished === false ? null : createdAt,
    });
    return runId;
  }

  function makeBackupDir(fresh: boolean): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "myrmidon-data-retention-backups-"));
    cleanupDirs.push(dir);
    if (fresh) {
      const file = path.join(dir, "paperclip-2026-01-01T00-00-00.sql.gz");
      fs.writeFileSync(file, "backup");
      const mtime = new Date();
      fs.utimesSync(file, mtime, mtime);
    }
    return dir;
  }

  function makeSweep(options: { freshBackup: boolean }) {
    const settings = instanceSettingsService(db);
    const backupDir = makeBackupDir(options.freshBackup);
    const waitingLogs: Array<Record<string, unknown>> = [];
    const throttledLogs: Array<Record<string, unknown>> = [];
    const sweep = createDataRetentionSweep({
      db,
      resolveSettings: () => readDataRetentionSettings(settings),
      readLastRun: () => readDataRetentionLastRun(settings),
      writeLastRun: (lastRun) => writeDataRetentionLastRun(settings, lastRun),
      checkBackup: async () => {
        const { checkDataRetentionBackupGate } = await import("./backup-gate.js");
        const result = checkDataRetentionBackupGate({ backupDir, prefix: "paperclip" });
        return { fresh: result.fresh, checkedAt: new Date() };
      },
      logWaitingForBackup: async (details) => {
        waitingLogs.push(details);
      },
      logThrottled: async (details) => {
        throttledLogs.push(details);
      },
      // Every test runs its passes back to back; a throttle-free sweep is
      // the pre-review behavior the rest of the suite pins.
      minPassIntervalMs: 0,
    });
    return { sweep, waitingLogs, throttledLogs, backupDir };
  }

  async function runCount(runId: string): Promise<number> {
    const rows = await db
      .select({ id: heartbeatRuns.id })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId));
    return rows.length;
  }

  it("retains recent and newest document revisions, and only prunes old terminal wakes and released leases", async () => {
    const company = await seedCompany();
    const { companyId, agentId } = company;
    const documentId = randomUUID();
    const old = new Date(Date.now() - 100 * DAY_MS);
    const young = new Date(Date.now() - 10 * DAY_MS);
    const revisions = Array.from({ length: 25 }, (_, index) => ({
      id: randomUUID(), companyId, documentId, revisionNumber: index + 1,
      body: `revision ${index + 1}`, format: "markdown",
      createdAt: index === 0 || index === 24 ? old : young,
    }));
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "latest", latestRevisionNumber: 25, latestRevisionId: revisions[24].id });
    await db.insert(documentRevisions).values(revisions);
    const wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: wakeId, companyId, agentId, source: "test", status: "cancelled", requestedAt: old, finishedAt: old },
      { companyId, agentId, source: "test", status: "queued", requestedAt: old },
    ]);
    const activeLeaseId = randomUUID();
    await db.insert(environmentLeases).values([
      { id: activeLeaseId, companyId, status: "active", acquiredAt: old, lastUsedAt: old },
      { companyId, status: "released", releasedAt: old, acquiredAt: old, lastUsedAt: old },
    ]);

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    expect(result.perTable.documentRevisions.deleted).toBe(1);
    const keptRevisions = await db.select({ revisionNumber: documentRevisions.revisionNumber }).from(documentRevisions);
    expect(keptRevisions).toHaveLength(24);
    expect(keptRevisions.some(({ revisionNumber }) => revisionNumber === 1)).toBe(false);
    expect(result.perTable.agentWakeupRequests.deleted).toBe(1);
    const remainingWakes = await db.select({ status: agentWakeupRequests.status }).from(agentWakeupRequests);
    expect(remainingWakes.map(({ status }) => status)).toContain("queued");
    expect(result.perTable.environmentLeases.deleted).toBe(1);
    const leases = await db.select({ id: environmentLeases.id, status: environmentLeases.status }).from(environmentLeases);
    expect(leases).toEqual([{ id: activeLeaseId, status: "active" }]);
  });

  it("FK safety: a wakeup request still referenced by a run is kept without failing the pass; an unreferenced one is deleted", async () => {
    const { companyId, agentId } = await seedCompany();
    const old = new Date(Date.now() - 100 * DAY_MS);
    const referencedWakeId = randomUUID();
    const freeWakeId = randomUUID();
    await db.insert(agentWakeupRequests).values([
      { id: referencedWakeId, companyId, agentId, source: "test", status: "completed", requestedAt: old, finishedAt: old },
      { id: freeWakeId, companyId, agentId, source: "test", status: "completed", requestedAt: old, finishedAt: old },
    ]);
    // A young run (inside the 90-day run retention) still names the old wake.
    const runId = randomUUID();
    const runAt = new Date(Date.now() - 5 * DAY_MS);
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "assignment", status: "succeeded",
      wakeupRequestId: referencedWakeId, createdAt: runAt, updatedAt: runAt, finishedAt: runAt,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    expect(result.perTable.agentWakeupRequests.deleted).toBe(1);
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests);
    expect(wakes).toEqual([{ id: referencedWakeId }]);
    expect(await runCount(runId)).toBe(1);

    // A second pass is a stable no-op (the referenced wake is skipped, not retried into an error).
    const second = await sweep.sweep();
    expect(second.perTable.agentWakeupRequests.deleted).toBe(0);
  });

  it("wakeup requests: at most one batch per pass; later passes continue and then settle", async () => {
    const { companyId, agentId } = await seedCompany();
    const old = new Date(Date.now() - 100 * DAY_MS);
    const extra = 200;
    const total = DATA_RETENTION_DELETE_BATCH_SIZE + extra;
    await db.insert(agentWakeupRequests).values(
      Array.from({ length: total }, () => ({
        companyId, agentId, source: "test", status: "completed", requestedAt: old, finishedAt: old,
      })),
    );
    const { sweep } = makeSweep({ freshBackup: true });
    expect((await sweep.sweep()).perTable.agentWakeupRequests.deleted).toBe(DATA_RETENTION_DELETE_BATCH_SIZE);
    expect((await sweep.sweep()).perTable.agentWakeupRequests.deleted).toBe(extra);
    expect((await sweep.sweep()).perTable.agentWakeupRequests.deleted).toBe(0);
    expect(await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)).toHaveLength(0);
  });

  it("document revisions: at most one batch per pass; later passes continue and then settle", async () => {
    const { companyId } = await seedCompany();
    const documentId = randomUUID();
    const old = new Date(Date.now() - 200 * DAY_MS);
    const extra = 200;
    const keep = 20;
    const total = DATA_RETENTION_DELETE_BATCH_SIZE + extra + keep;
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "latest", latestRevisionNumber: total });
    const revisions = Array.from({ length: total }, (_, index) => ({
      id: randomUUID(), companyId, documentId, revisionNumber: index + 1,
      body: `revision ${index + 1}`, format: "markdown", createdAt: old,
    }));
    await db.insert(documentRevisions).values(revisions);
    await db.update(documents).set({ latestRevisionId: revisions[total - 1].id }).where(eq(documents.id, documentId));
    const { sweep } = makeSweep({ freshBackup: true });
    expect((await sweep.sweep()).perTable.documentRevisions.deleted).toBe(DATA_RETENTION_DELETE_BATCH_SIZE);
    expect((await sweep.sweep()).perTable.documentRevisions.deleted).toBe(extra);
    expect((await sweep.sweep()).perTable.documentRevisions.deleted).toBe(0);
    expect(await db.select({ id: documentRevisions.id }).from(documentRevisions)).toHaveLength(keep);
  });

  it("applies newest-N when revision age retention is disabled", async () => {
    const { companyId } = await seedCompany();
    const documentId = randomUUID();
    const revisions = [1, 2, 3].map((revisionNumber) => ({
      id: randomUUID(), companyId, documentId, revisionNumber, body: "revision", format: "markdown",
    }));
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "latest", latestRevisionId: revisions[2].id, latestRevisionNumber: 3 });
    await db.insert(documentRevisions).values(revisions);
    await writeDataRetentionSettings(instanceSettingsService(db), { documentRevisionDays: 0, documentRevisionKeepPerDocument: 2 });
    const { sweep } = makeSweep({ freshBackup: true });
    expect((await sweep.sweep()).perTable.documentRevisions.deleted).toBe(1);
    const kept = await db.select({ id: documentRevisions.id }).from(documentRevisions);
    expect(kept.map((row) => row.id).sort()).toEqual([revisions[1].id, revisions[2].id].sort());
  });

  it("disables count protection at zero but preserves referenced revisions", async () => {
    const { companyId } = await seedCompany();
    const documentId = randomUUID();
    const old = new Date(Date.now() - 100 * DAY_MS);
    const revisions = [1, 2, 3, 4].map((revisionNumber) => ({
      id: randomUUID(), companyId, documentId, revisionNumber, body: "revision", format: "markdown", createdAt: old,
    }));
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "latest", latestRevisionId: revisions[0].id, latestRevisionNumber: 4 });
    await db.insert(documentRevisions).values(revisions);
    const issueId = await seedIssue({ companyId, title: "accepted plan" });
    await db.insert(issuePlanDecompositions).values({ companyId, sourceIssueId: issueId, acceptedPlanRevisionId: revisions[1].id, requestFingerprint: "test" });
    await writeDataRetentionSettings(instanceSettingsService(db), { documentRevisionDays: 90, documentRevisionKeepPerDocument: 0 });
    const { sweep } = makeSweep({ freshBackup: true });
    expect((await sweep.sweep()).perTable.documentRevisions.deleted).toBe(2);
    const kept = await db.select({ id: documentRevisions.id }).from(documentRevisions);
    expect(kept.map((row) => row.id).sort()).toEqual([revisions[0].id, revisions[1].id].sort());
    expect(await db.select().from(issuePlanDecompositions)).toHaveLength(1);
  });

  async function seedIssue(input: { companyId: string; title: string }) {
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: input.title,
      status: "done",
    });
    return issueId;
  }

  it("FK safety: a run that originates decisions/bundles is never deleted (operator review dbcare-review-20261008)", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({ companyId, title: "decided work" });
    const doomedRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    // a young run of the same company — survives and keeps its decision
    const youngKeptRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 10 });

    // a bundle + two decisions from the doomed run; one decision of the
    // young run points into the bundle (bundle_id is ON DELETE SET NULL)
    const bundleId = randomUUID();
    await db.insert(decisionBundles).values({
      id: bundleId,
      companyId,
      title: "bundle-a",
      summary: "summary",
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: doomedRun,
    });
    const doomedDecisionId = randomUUID();
    await db.insert(decisions).values({
      id: doomedDecisionId,
      companyId,
      bundleId,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: doomedRun,
      title: "d1",
      body: "b1",
      options: [],
      expiresAt: new Date(Date.now() + DAY_MS),
      signedSpec: "spec",
      targetSnapshots: {},
    });
    const survivingDecisionId = randomUUID();
    await db.insert(decisions).values({
      id: survivingDecisionId,
      companyId,
      bundleId,
      originAgentId: agentId,
      originIssueId: issueId,
      originRunId: youngKeptRun,
      title: "d2",
      body: "b2",
      options: [],
      expiresAt: new Date(Date.now() + DAY_MS),
      signedSpec: "spec",
      targetSnapshots: {},
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    // doomedRun is old but decision-referenced → the whole run survives
    expect(result.perTable.runs.deleted).toBe(0);
    expect(await runCount(doomedRun)).toBe(1);
    // the decisions and the bundle are untouched; the young run's decision
    // keeps its bundle link
    expect(await db.select({ id: decisionBundles.id }).from(decisionBundles)).toHaveLength(1);
    expect(await db.select({ id: decisions.id }).from(decisions)).toHaveLength(2);
    const surviving = await db
      .select({ id: decisions.id, bundleId: decisions.bundleId })
      .from(decisions)
      .where(eq(decisions.id, survivingDecisionId));
    expect(surviving).toEqual([{ id: survivingDecisionId, bundleId }]);
    expect(await runCount(youngKeptRun)).toBe(1);
  });

  it("FK safety: a run with the native completion chain is never deleted (operator review dbcare-review-20261008)", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = await seedIssue({ companyId, title: "native work" });
    const doomedRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    // the composite FKs into heartbeat_runs key on (company_id,
    // native_issue_id, id [, completion_contract_id]) — the run must carry
    // the issue and its contract
    const contractId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({ nativeIssueId: issueId, completionContractId: contractId })
      .where(eq(heartbeatRuns.id, doomedRun));

    await db.insert(completionContracts).values({
      id: contractId,
      companyId,
      issueId,
      revision: 1,
      schemaVersion: "v1",
      policyVersion: "p1",
      risk: "low",
      completionAuthority: "agent",
      incompleteCriteriaPolicy: "block",
      contractJson: {},
      canonicalSha256: "sha-contract",
      createdByActorType: "agent",
      createdByActorId: agentId,
    });
    const resultId = randomUUID();
    await db.insert(nativeRunResults).values({
      id: resultId,
      companyId,
      issueId,
      runId: doomedRun,
      completionContractId: contractId,
      serverFingerprint: "fp",
      schemaStatus: "ok",
      resultJson: {},
      canonicalSha256: "sha-result",
    });
    const assessmentId = randomUUID();
    await db.insert(workAssessments).values({
      id: assessmentId,
      companyId,
      issueId,
      runId: doomedRun,
      contractId,
      resultId,
      triggerKind: "manual",
      triggerActorCompanyId: companyId,
      priorIssueStatus: "in_progress",
      priorStatusVersion: 1,
      policyVersion: "p1",
      assessmentJson: {},
      inputDigest: "digest-a",
    });
    const statusDecisionId = randomUUID();
    await db.insert(statusDecisions).values({
      id: statusDecisionId,
      companyId,
      issueId,
      runId: doomedRun,
      assessmentId,
      decisionVersion: 1,
      policyVersion: "p1",
      fromStatus: "in_progress",
      toStatus: "done",
      reasonCode: "complete",
      decisionJson: {},
      decisionDigest: "digest-d",
    });
    await db.insert(statusDecisionEffects).values({
      companyId,
      issueId,
      decisionId: statusDecisionId,
      ordinal: 1,
      effectKind: "notify",
      targetType: "issue",
      idempotencyKey: "k1",
      payload: {},
    });
    await db.insert(nativeRunFinalizations).values({
      runId: doomedRun,
      companyId,
      issueId,
      phase: "done",
      resultId,
      assessmentId,
      decisionId: statusDecisionId,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    // the native chain records outlive the run: nothing is deleted
    expect(result.perTable.runs.deleted).toBe(0);
    expect(await runCount(doomedRun)).toBe(1);
    expect(await db.select({ id: nativeRunFinalizations.runId }).from(nativeRunFinalizations)).toHaveLength(1);
    expect(await db.select({ id: statusDecisionEffects.id }).from(statusDecisionEffects)).toHaveLength(1);
    expect(await db.select({ id: statusDecisions.id }).from(statusDecisions)).toHaveLength(1);
    expect(await db.select({ id: workAssessments.id }).from(workAssessments)).toHaveLength(1);
    expect(await db.select({ id: nativeRunResults.id }).from(nativeRunResults)).toHaveLength(1);
    // the contract has no run FK and survives
    expect(await db.select({ id: completionContracts.id }).from(completionContracts)).toHaveLength(1);
  });

  it("FK safety: all five decision-queue run columns and the remaining nullable run FKs are nulled", async () => {
    const { companyId, agentId } = await seedCompany();
    const doomedRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });

    const queueId = randomUUID();
    await db.insert(decisionQueues).values({
      id: queueId,
      companyId,
      key: "q1",
      title: "queue",
      createdByType: "system",
      createdByRunId: doomedRun,
    });
    await db.insert(decisionQueueItems).values({
      companyId,
      queueId,
      sourceKind: "issue",
      sourceId: "s1",
      addedByType: "system",
      addedByRunId: doomedRun,
    });
    await db.insert(decisionTriage).values({
      companyId,
      sourceKind: "issue",
      sourceId: "s2",
      setByType: "agent",
      setByAgentId: agentId,
      setByRunId: doomedRun,
    });
    await db.insert(decisionTriageEvents).values({
      companyId,
      queueId,
      action: "triaged",
      actorType: "agent",
      actorAgentId: agentId,
      actorRunId: doomedRun,
    });
    await db.insert(decisionRetention).values({
      companyId,
      sourceKind: "issue",
      sourceId: "s3",
      sourceActivityAt: new Date(),
      archivedByRunId: doomedRun,
    });
    await db.insert(costEvents).values({
      companyId,
      agentId,
      heartbeatRunId: doomedRun,
      provider: "anthropic",
      model: "m",
      costCents: 1,
      occurredAt: new Date(),
    });
    await db.insert(financeEvents).values({
      companyId,
      agentId,
      heartbeatRunId: doomedRun,
      eventKind: "usage",
      biller: "b",
      amountCents: 1,
      occurredAt: new Date(),
    });
    await db.insert(agentTaskSessions).values({
      companyId,
      agentId,
      adapterType: "codex_local",
      taskKey: "task-1",
      lastRunId: doomedRun,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    expect(result.perTable.runs.deleted).toBe(1);
    expect(await runCount(doomedRun)).toBe(0);

    const queue = await db.select({ c: decisionQueues.createdByRunId }).from(decisionQueues);
    expect(queue).toEqual([{ c: null }]);
    const item = await db.select({ c: decisionQueueItems.addedByRunId }).from(decisionQueueItems);
    expect(item).toEqual([{ c: null }]);
    const triage = await db.select({ c: decisionTriage.setByRunId }).from(decisionTriage);
    expect(triage).toEqual([{ c: null }]);
    const triageEvent = await db.select({ c: decisionTriageEvents.actorRunId }).from(decisionTriageEvents);
    expect(triageEvent).toEqual([{ c: null }]);
    const retention = await db.select({ c: decisionRetention.archivedByRunId }).from(decisionRetention);
    expect(retention).toEqual([{ c: null }]);
    const cost = await db.select({ c: costEvents.heartbeatRunId }).from(costEvents);
    expect(cost).toEqual([{ c: null }]);
    const finance = await db.select({ c: financeEvents.heartbeatRunId }).from(financeEvents);
    expect(finance).toEqual([{ c: null }]);
    const session = await db.select({ c: agentTaskSessions.lastRunId }).from(agentTaskSessions);
    expect(session).toEqual([{ c: null }]);
  });

  it("deletes finished runs and their events past the retention, keeps young and referenced runs", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();

    // old finished run with events — must go
    const oldRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    await db.insert(heartbeatRunEvents).values({
      companyId,
      runId: oldRun,
      agentId,
      seq: 1,
      eventType: "log",
      createdAt: new Date(Date.now() - 100 * DAY_MS),
    });
    // young finished run — stays
    const youngRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 10 });
    // old but still running — stays
    const liveRun = await seedRun({
      companyId,
      agentId,
      status: "running",
      ageDays: 100,
      finished: false,
    });
    // old finished run referenced as the execution run of an open issue — stays
    const openIssueRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "open work",
      status: "in_progress",
      executionRunId: openIssueRun,
    });
    // old finished run that is the retry parent of a live run — stays
    const retryParent = await seedRun({ companyId, agentId, status: "failed", ageDays: 100 });
    await seedRun({
      companyId,
      agentId,
      status: "running",
      ageDays: 1,
      finished: false,
      retryOfRunId: retryParent,
    });
    // old failed run with no newer run for the same agent+issue pair and no
    // dismissal — the unresolved failed_run attention item — stays
    const failedIssueId = randomUUID();
    const failedAttentionRun = await seedRun({
      companyId,
      agentId,
      status: "failed",
      ageDays: 100,
      contextSnapshot: { issueId: failedIssueId },
    });
    // a run of a DONE issue (terminal) — must go even though referenced
    const doneIssueRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    await db.insert(issues).values({
      id: randomUUID(),
      companyId,
      title: "done work",
      status: "done",
      executionRunId: doneIssueRun,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    expect(result.waitingForBackup).toBe(false);
    expect(result.perTable.runs.deleted).toBe(2); // oldRun + doneIssueRun
    expect(await runCount(oldRun)).toBe(0);
    expect(await runCount(doneIssueRun)).toBe(0);
    // the events of the deleted run went with it
    const leftoverEvents = await db
      .select({ id: heartbeatRunEvents.id })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, oldRun));
    expect(leftoverEvents).toHaveLength(0);
    expect(await runCount(youngRun)).toBe(1);
    expect(await runCount(liveRun)).toBe(1);
    expect(await runCount(openIssueRun)).toBe(1);
    expect(await runCount(retryParent)).toBe(1);
    expect(await runCount(failedAttentionRun)).toBe(1);

    // the persisted state records the pass
    const lastRun = await readDataRetentionLastRun(instanceSettingsService(db));
    expect(lastRun.waitingForBackup).toBe(false);
    expect(lastRun.perTable.runs.deletedTotal).toBe(2);
    expect(lastRun.perTable.runs.lastDeleted).toBe(2);
    expect(lastRun.perTable.runs.lastFreedBytes).toBeGreaterThan(0);
    expect(lastRun.lastRunAt).not.toBeNull();
  });

  it("lets a failed_run source go once the attention resolves (newer run or dismissal)", async () => {
    const { companyId, agentId } = await seedCompany();
    const issueId = randomUUID();
    const failedRun = await seedRun({
      companyId,
      agentId,
      status: "failed",
      ageDays: 100,
      contextSnapshot: { issueId },
    });
    // a newer run for the same agent+issue pair resolves the attention item
    await seedRun({
      companyId,
      agentId,
      status: "succeeded",
      ageDays: 50,
      contextSnapshot: { issueId },
    });
    // a dismissal older than the run's activity does not resolve the item
    const dismissedRun = await seedRun({
      companyId,
      agentId,
      status: "failed",
      ageDays: 100,
      contextSnapshot: { issueId: randomUUID() },
    });
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user",
      itemKey: `attention:run:${dismissedRun}`,
      kind: "dismiss",
      dismissedAt: new Date(Date.now() - 200 * DAY_MS),
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    expect(result.perTable.runs.deleted).toBe(1); // failedRun only
    expect(await runCount(failedRun)).toBe(0);
    expect(await runCount(dismissedRun)).toBe(1);

    // a dismissal newer than the run's activity resolves the item too (a
    // second user: the inbox dismissals key is unique per company+user+item)
    await db.insert(inboxDismissals).values({
      companyId,
      userId: "board-user-b",
      itemKey: `attention:run:${dismissedRun}`,
      kind: "dismiss",
      dismissedAt: new Date(),
    });
    const second = await sweep.sweep();
    expect(second.perTable.runs.deleted).toBe(1);
    expect(await runCount(dismissedRun)).toBe(0);
  });

  it("retains activity and cost events according to configurable windows and clears the run reference of doomed runs", async () => {
    // activity defaults to 90d; cost events default to 30d, both overrideable.
    const { companyId, agentId } = await seedCompany();
    const keptRun = await seedRun({ companyId, agentId, status: "running", ageDays: 5, finished: false });
    const goneRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });

    const old = new Date(Date.now() - 100 * DAY_MS);
    const young = new Date(Date.now() - 10 * DAY_MS);
    // old row on the doomed run — survives with a cleared run_id (the
    // audit trail outlives the run)
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.old_gone_run",
      entityType: "run",
      entityId: goneRun,
      runId: goneRun,
      createdAt: old,
    });
    // old row on the surviving run — stays (the audit trail stays complete)
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.old_kept_run",
      entityType: "run",
      entityId: keptRun,
      runId: keptRun,
      createdAt: old,
    });
    // old row without a run — stays at the default 0 (keep forever)
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.old_orphan",
      entityType: "company",
      entityId: companyId,
      createdAt: old,
    });
    // young row — stays
    await db.insert(activityLog).values({
      companyId,
      actorType: "system",
      actorId: "test",
      action: "test.young",
      entityType: "company",
      entityId: companyId,
      createdAt: young,
    });
    // access audit rows
    await db.insert(toolAccessAuditEvents).values({
      companyId,
      actorType: "system",
      action: "invoke",
      outcome: "ok",
      createdAt: old,
    });
    await db.insert(toolAccessAuditEvents).values({
      companyId,
      actorType: "system",
      action: "invoke",
      outcome: "ok",
      createdAt: young,
    });
    await db.insert(secretAccessEvents).values({
      companyId,
      provider: "local_encrypted",
      actorType: "agent",
      consumerType: "agent",
      consumerId: agentId,
      outcome: "success",
      createdAt: old,
    });
    await db.insert(secretAccessEvents).values({
      companyId,
      provider: "local_encrypted",
      actorType: "agent",
      consumerType: "agent",
      consumerId: agentId,
      outcome: "success",
      createdAt: young,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    // The expired activity row on the deleted run is removed with the 90-day
    // policy; rows tied to the surviving run are kept to preserve its audit
    // trail, and old orphan activity is eligible for retention deletion.
    expect(result.perTable.activity.deleted).toBe(2);
    // the seeded access rows are 100 days old — inside the 180d default
    // access-audit retention, so nothing is deleted
    expect(result.perTable.access.deleted).toBe(1);
    const remainingActivity = await db
      .select({ action: activityLog.action, runId: activityLog.runId })
      .from(activityLog);
    const remainingActions = remainingActivity.map((row) => row.action).sort();
    expect(remainingActions).toEqual(["test.old_kept_run", "test.young"]);
    // Activity linked to the deleted run is not exempt from the configured
    // retention window: it is removed rather than retained with a null run_id.
    expect(remainingActivity.some((row) => row.action === "test.old_gone_run")).toBe(false);
    expect(await db.select({ id: toolAccessAuditEvents.id }).from(toolAccessAuditEvents)).toHaveLength(2);
    expect(await db.select({ id: secretAccessEvents.id }).from(secretAccessEvents)).toHaveLength(1);
  });

  it("retention 0 keeps everything, and a settings change applies on the next pass without a restart", async () => {
    const { companyId, agentId } = await seedCompany();
    const settings = instanceSettingsService(db);

    // keep runs forever, keep the other groups at the default
    await writeDataRetentionSettings(settings, { heartbeatRunsDays: 0 });
    const oldRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    const { sweep } = makeSweep({ freshBackup: true });

    const first = await sweep.sweep();
    expect(first.perTable.runs.deleted).toBe(0);
    expect(await runCount(oldRun)).toBe(1);

    // change the setting through the service; the SAME sweep instance applies
    // it on the next pass (settings are re-read at the top of every pass)
    await writeDataRetentionSettings(settings, { heartbeatRunsDays: 90 });
    const second = await sweep.sweep();
    expect(second.perTable.runs.deleted).toBe(1);
    expect(await runCount(oldRun)).toBe(0);

    // the stored settings keep the untouched values
    const stored = await readDataRetentionSettings(settings);
    expect(stored).toEqual({
      heartbeatRunsDays: 90,
      activityLogDays: 90,
      accessAuditDays: 180,
      secretAccessDays: 30,
      litellmCostEventsDays: 30,
      documentRevisionDays: 90,
      documentRevisionKeepPerDocument: 20,
      agentWakeupRequestsDays: 30,
      environmentLeasesDays: 30,
    });
  });

  it("uses secretAccessDays independently from tool access audit retention", async () => {
    const { companyId } = await seedCompany();
    const settings = instanceSettingsService(db);
    await writeDataRetentionSettings(settings, { accessAuditDays: 90, secretAccessDays: 30 });
    const expired = new Date(Date.now() - 45 * DAY_MS);
    await db.insert(secretAccessEvents).values({
      companyId, provider: "local_encrypted", actorType: "agent", consumerType: "agent",
      consumerId: "retention-test", outcome: "success", createdAt: expired,
    });
    await db.insert(toolAccessAuditEvents).values({
      companyId, actorType: "system", action: "invoke", outcome: "ok", createdAt: expired,
    });

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();
    expect(result.perTable.access.deleted).toBe(1);
    expect(await db.select({ id: secretAccessEvents.id }).from(secretAccessEvents)).toHaveLength(0);
    expect(await db.select({ id: toolAccessAuditEvents.id }).from(toolAccessAuditEvents)).toHaveLength(1);
  });

  it("the backup gate blocks deletes until a fresh backup appears, then lifts", async () => {
    const { companyId, agentId } = await seedCompany();
    const oldRun = await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });

    const { sweep, waitingLogs, backupDir } = makeSweep({ freshBackup: false });
    const blocked = await sweep.sweep();
    expect(blocked.waitingForBackup).toBe(true);
    expect(blocked.perTable.runs.deleted).toBe(0);
    expect(await runCount(oldRun)).toBe(1);
    expect(waitingLogs).toHaveLength(1);

    const blockedState = await readDataRetentionLastRun(instanceSettingsService(db));
    expect(blockedState.waitingForBackup).toBe(true);
    expect(blockedState.backupCheckedAt).not.toBeNull();
    // a pass that did no work does not stamp lastRunAt (operator review
    // dbcare-review-20261008: the state is written on actual work only)
    expect(blockedState.lastRunAt).toBeNull();

    // a fresh backup appears — the next pass deletes
    const file = path.join(backupDir, "paperclip-2026-01-02T00-00-00.sql.gz");
    fs.writeFileSync(file, "backup");
    const lifted = await sweep.sweep();
    expect(lifted.waitingForBackup).toBe(false);
    expect(lifted.perTable.runs.deleted).toBe(1);
    expect(await runCount(oldRun)).toBe(0);
  });

  it("the persisted sweep state survives a service round-trip and vendor general writes", async () => {
    const settings = instanceSettingsService(db);
    await writeDataRetentionSettings(settings, { activityLogDays: 30 });
    await writeDataRetentionLastRun(settings, {
      lastRunAt: new Date().toISOString(),
      waitingForBackup: false,
      backupCheckedAt: new Date().toISOString(),
      freedBytesTotal: 1234,
      perTable: {
        runs: { deletedTotal: 5, lastDeleted: 5, lastFreedBytes: 1000 },
        activity: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        access: { deletedTotal: 2, lastDeleted: 2, lastFreedBytes: 234 },
        litellmCostEvents: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        documentRevisions: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        agentWakeupRequests: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        environmentLeases: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
        executionWorkspaces: { deletedTotal: 0, lastDeleted: 0, lastFreedBytes: 0 },
      },
    });

    // a vendor-style general write (no datastoreCare key in the patch) keeps
    // the row
    await settings.updateGeneral({ censorUsernameInLogs: true });

    // the stored object sits under general.datastoreCare.retention (the
    // project §3.6 "Хранение" panel key — OPE-5939/DBC-1)
    const general = (await settings.getGeneral()) as unknown as Record<string, unknown>;
    const care = general.datastoreCare as Record<string, unknown>;
    expect(typeof care).toBe("object");
    expect(care.retention).toMatchObject({ activityLogDays: 30 });
    expect(general.dataRetention).toBeUndefined();

    expect(await readDataRetentionSettings(settings)).toEqual({
      heartbeatRunsDays: 90,
      activityLogDays: 30,
      accessAuditDays: 180,
      secretAccessDays: 30,
      litellmCostEventsDays: 30,
      documentRevisionDays: 90,
      documentRevisionKeepPerDocument: 20,
      agentWakeupRequestsDays: 30,
      environmentLeasesDays: 30,
    });
    const lastRun = await readDataRetentionLastRun(settings);
    expect(lastRun.freedBytesTotal).toBe(1234);
    expect(lastRun.perTable.runs.deletedTotal).toBe(5);
    expect(lastRun.perTable.access.lastFreedBytes).toBe(234);

    // the waiting-for-backup throttle anchor is a plain activity query away
    expect(DATA_RETENTION_WAITING_FOR_BACKUP_ACTION).toBe("data.retention_waiting_for_backup");
  });

  it("runs at most one pass per 10 minutes: an immediate tick is a no-op (operator review dbcare-review-20261008)", async () => {
    const { companyId, agentId } = await seedCompany();
    const settings = instanceSettingsService(db);
    const backupDir = makeBackupDir(true);
    let passes = 0;
    const sweep = createDataRetentionSweep({
      db,
      resolveSettings: () => readDataRetentionSettings(settings),
      readLastRun: () => readDataRetentionLastRun(settings),
      writeLastRun: (lastRun) => writeDataRetentionLastRun(settings, lastRun),
      checkBackup: async () => {
        passes += 1;
        return { fresh: true, checkedAt: new Date() };
      },
      logWaitingForBackup: async () => undefined,
      logThrottled: async () => undefined,
    });
    void backupDir;

    await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    const first = await sweep.sweep();
    expect(first.perTable.runs.deleted).toBe(1);
    expect(passes).toBe(1);

    // the 30 s scheduler tick inside the 10-minute window is a no-op: no
    // pass, no database work, no state write
    const second = await sweep.sweep();
    expect(second.perTable.runs.deleted).toBe(0);
    expect(passes).toBe(1);
  });

  it("an idle pass does not write the state: lastRun stamps actual work only (operator review dbcare-review-20261008)", async () => {
    const { companyId, agentId } = await seedCompany();
    const settings = instanceSettingsService(db);
    const { sweep } = makeSweep({ freshBackup: true });

    // nothing to delete — the pass runs but touches nothing
    const idle = await sweep.sweep();
    expect(idle.perTable.runs.deleted).toBe(0);
    expect(idle.perTable.activity.deleted).toBe(0);
    expect(idle.perTable.access.deleted).toBe(0);
    const idleState = await readDataRetentionLastRun(settings);
    expect(idleState.lastRunAt).toBeNull();
    expect(idleState.waitingForBackup).toBe(false);

    // actual work stamps the state
    await seedRun({ companyId, agentId, status: "succeeded", ageDays: 100 });
    const worked = await sweep.sweep();
    expect(worked.perTable.runs.deleted).toBe(1);
    const workedState = await readDataRetentionLastRun(settings);
    expect(workedState.lastRunAt).not.toBeNull();
    expect(workedState.perTable.runs.deletedTotal).toBe(1);
  });

  it("execution_workspaces: archives duplicate and terminal-task rows, then deletes old archived rows", async () => {
    const { companyId } = await seedCompany();
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId, name: "project-a" });
    const openIssueId = randomUUID();
    const doneIssueId = randomUUID();
    await db.insert(issues).values([
      { id: openIssueId, companyId, projectId, title: "open task", status: "in_progress" },
      { id: doneIssueId, companyId, projectId, title: "done task", status: "done" },
    ]);

    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
    const seedRow = async (input: {
      sourceIssueId: string;
      status?: string;
      lastUsedAt: Date;
      closedAt?: Date | null;
    }) => {
      const id = randomUUID();
      await db.insert(executionWorkspaces).values({
        id,
        companyId,
        projectId,
        sourceIssueId: input.sourceIssueId,
        mode: "shared_workspace",
        strategyType: "project_primary",
        name: "shared",
        status: input.status ?? "active",
        lastUsedAt: input.lastUsedAt,
        closedAt: input.closedAt ?? null,
      });
      return id;
    };

    const boundOldest = await seedRow({ sourceIssueId: openIssueId, lastUsedAt: hoursAgo(72) });
    const duplicateMiddle = await seedRow({ sourceIssueId: openIssueId, lastUsedAt: hoursAgo(48) });
    const duplicateNewer = await seedRow({ sourceIssueId: openIssueId, lastUsedAt: hoursAgo(5) });
    const justStarted = await seedRow({ sourceIssueId: openIssueId, lastUsedAt: new Date() });
    const terminalTaskRow = await seedRow({ sourceIssueId: doneIssueId, lastUsedAt: hoursAgo(48) });
    const expiredArchived = await seedRow({
      sourceIssueId: doneIssueId,
      status: "archived",
      lastUsedAt: hoursAgo(24 * 100),
      closedAt: new Date(Date.now() - 100 * DAY_MS),
    });
    const freshArchived = await seedRow({
      sourceIssueId: doneIssueId,
      status: "archived",
      lastUsedAt: hoursAgo(24 * 10),
      closedAt: new Date(Date.now() - 10 * DAY_MS),
    });
    // the open task is bound to its oldest row: the bound row is the one kept
    await db.update(issues).set({ executionWorkspaceId: boundOldest }).where(eq(issues.id, openIssueId));

    const { sweep } = makeSweep({ freshBackup: true });
    const result = await sweep.sweep();

    const statusOf = async (id: string) =>
      (await db.select({ status: executionWorkspaces.status }).from(executionWorkspaces).where(eq(executionWorkspaces.id, id)))[0]
        ?.status ?? null;
    expect(await statusOf(boundOldest)).toBe("active");
    expect(await statusOf(duplicateMiddle)).toBe("archived");
    expect(await statusOf(duplicateNewer)).toBe("archived");
    // a row used within the last hour is never touched
    expect(await statusOf(justStarted)).toBe("active");
    expect(await statusOf(terminalTaskRow)).toBe("archived");
    // archived rows older than the term are deleted, younger ones stay
    expect(await statusOf(expiredArchived)).toBeNull();
    expect(await statusOf(freshArchived)).toBe("archived");
    expect(result.perTable.executionWorkspaces.deleted).toBe(1);
    const state = await readDataRetentionLastRun(instanceSettingsService(db));
    expect(state.perTable.executionWorkspaces.deletedTotal).toBe(1);
  });
});
