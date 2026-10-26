import { and, eq, sql } from "drizzle-orm";
import {
  agentWakeupRequests,
  agents,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  issues,
  statusDecisions,
  litellmCostEvents,
  costEvents,
  type Db,
} from "@myrmidon/db";
import { estimateModelApiCostUsd, normalizeModelApiPricingSettings } from "@myrmidon/shared";
import { trackAgentTaskRun } from "@myrmidon/shared/telemetry";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getTelemetryClient } from "../telemetry.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type RunWorkProduct = { type: string };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readRunDimension(value: unknown, maxLength = 128): string | null {
  const text = readNonEmptyString(value);
  if (!text || text.length > maxLength || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) return null;
  return text;
}

function readRunEventId(value: unknown): string | null {
  return readRunDimension(value, 256);
}

function readUsageToken(source: Record<string, unknown>, ...keys: string[]): number {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  }
  return 0;
}

function readModelCallCount(value: unknown): number | null {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const usage = record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
    ? record.usage as Record<string, unknown>
    : {};
  for (const candidate of [record.modelCallCount, record.model_call_count, usage.modelCallCount, usage.model_call_count]) {
    const parsed = typeof candidate === "number" ? candidate : typeof candidate === "string" ? Number(candidate) : Number.NaN;
    if (Number.isSafeInteger(parsed) && parsed >= 0) return Math.min(parsed, 100_000);
  }
  return null;
}

export function buildRunTelemetry(input: {
  run: Pick<HeartbeatRun, "id" | "agentId" | "invocationSource" | "triggerDetail" | "retryOfRunId" | "nativeIssueId" | "contextSnapshot" | "usageJson" | "resultJson" | "startedAt" | "finishedAt" | "modelCallCount">;
  gatewayCalls: Array<{ requestId: string | null; costCents: number }>;
  reportedCostCents: number;
  modelApiPricing?: unknown;
  workProducts: RunWorkProduct[];
  issueUpdatedAt?: Date | null;
  outcomeCategoryOverride?: "status" | "comment_only" | "nothing" | null;
  wakeup?: {
    source: string;
    triggerDetail: string | null;
    reason: string | null;
    payload: Record<string, unknown> | null;
  } | null;
}) {
  const context = parseObject(input.run.contextSnapshot);
  const usage = parseObject(input.run.usageJson);
  const result = parseObject(input.run.resultJson);
  const gatewayResultIds = Array.isArray(result.gatewayCallIds)
    ? result.gatewayCallIds.map((value) => readRunEventId(value)).filter((value): value is string => value !== null)
    : [];
  const litellmResultIds = Array.isArray(result.litellmRequestIds)
    ? result.litellmRequestIds.map((value) => readRunEventId(value)).filter((value): value is string => value !== null)
    : [];
  const spendCallIds = input.gatewayCalls.map((call) => readRunEventId(call.requestId)).filter((value): value is string => value !== null);
  const gatewayCallIds = [...new Set(gatewayResultIds)];
  const litellmRequestIds = [...new Set([...litellmResultIds, ...spendCallIds])];
  const wakePayload = input.wakeup?.payload ?? {};
  const reportedCallCount = readModelCallCount(result)
    ?? readModelCallCount({ modelCallCount: result.gatewayModelCallCount })
    ?? readModelCallCount(wakePayload)
    ?? readModelCallCount(usage);
  const explicitCallCount = reportedCallCount;
  const deduplicatedCallCount =
    gatewayCallIds.length > 0 && litellmRequestIds.length > 0
      ? Math.max(gatewayCallIds.length, litellmRequestIds.length)
      : gatewayCallIds.length + litellmRequestIds.length;
  const modelCallCount = explicitCallCount ?? (deduplicatedCallCount > 0 ? deduplicatedCallCount : null);
  const modelCallCountSource = readRunDimension(result.modelCallCountSource)
    ?? (explicitCallCount !== null ? "gateway_count" : deduplicatedCallCount > 0 ? "inferred_call_ids" : "unknown");
  const model = readNonEmptyString(usage.model) ?? readNonEmptyString(result.model);
  const billingType = readNonEmptyString(usage.billingType) ?? readNonEmptyString(usage.billing_type);
  const artifactCount = input.workProducts.filter((product) => product.type === "artifact").length;
  const documentCount = input.workProducts.filter((product) => product.type === "document").length;
  const commitCount = input.workProducts.filter((product) => product.type === "commit").length;
  const pullRequestCount = input.workProducts.filter((product) => product.type === "pull_request").length;
  const branchCount = input.workProducts.filter((product) => product.type === "branch").length;
  const otherWorkProductCount = input.workProducts.filter((product) => !["artifact", "document", "commit", "pull_request", "branch"].includes(product.type)).length;
  const outcomeCategory = input.workProducts.length > 0
    ? artifactCount > 0
      ? "artifact"
      : commitCount + pullRequestCount + branchCount > 0
        ? "commit_push"
        : "other_work_product"
    : input.outcomeCategoryOverride === "status" || input.outcomeCategoryOverride === "comment_only" || input.outcomeCategoryOverride === "nothing"
      ? input.outcomeCategoryOverride
      : null;
  const apiEquivalentCostUsd = billingType === "subscription_included" && model
    ? estimateModelApiCostUsd({
        model,
        usage: {
          inputTokens: readUsageToken(usage, "inputTokens", "input_tokens", "rawInputTokens"),
          cachedInputTokens: readUsageToken(usage, "cachedInputTokens", "cached_input_tokens", "rawCachedInputTokens"),
          outputTokens: readUsageToken(usage, "outputTokens", "output_tokens", "rawOutputTokens"),
        },
        prices: normalizeModelApiPricingSettings(input.modelApiPricing),
      })
    : null;
  const apiEquivalentCostStatus = billingType === "subscription_included"
    ? apiEquivalentCostUsd === null ? "unpriced" : "estimated"
    : "not_applicable";
  const retryOfRunId = input.run.retryOfRunId ?? readNonEmptyString(context.retryOfRunId);
  const gatewaySpendCents = input.gatewayCalls.reduce((total, call) => total + Math.max(0, Math.floor(call.costCents)), 0);
  const wakePayload = input.wakeup?.payload ?? {};
  const wakeReason = readRunDimension(input.wakeup?.reason)
    ?? readRunDimension(context.wakeReason)
    ?? readRunDimension(wakePayload.reason);
  const wakeSource = readRunDimension(input.wakeup?.source)
    ?? readRunDimension(context.wakeSource)
    ?? readRunDimension(context.source);
  const wakeTriggerDetail = readRunDimension(input.wakeup?.triggerDetail)
    ?? readRunDimension(context.wakeTriggerDetail);
  const runIssueId = readNonEmptyString(context.issueId) ?? input.run.nativeIssueId;
  const eventRevision =
    readNonEmptyString(input.wakeup?.payload?.eventRevision)
    ?? readNonEmptyString(input.wakeup?.payload?.event_revision)
    ?? readNonEmptyString(context.eventRevision)
    ?? readNonEmptyString(wakePayload.eventRevision)
    ?? readNonEmptyString(wakePayload.event_revision)
    ?? (runIssueId ? input.issueUpdatedAt?.toISOString() ?? null : null);
  const sourceEventId = readRunEventId(wakePayload.sourceEventId)
    ?? readRunEventId(wakePayload.source_event_id)
    ?? readRunEventId(wakePayload.commentId)
    ?? readRunEventId(context.wakeCommentId);
  const wakeCause = readRunDimension(wakePayload.wakeCause)
    ?? readRunDimension(wakePayload.reason)
    ?? readRunDimension(wakePayload.source)
    ?? readRunDimension(input.wakeup?.reason)
    ?? (input.wakeup?.source === "issue_comment" ? "issue_commented" : null);
  const sourceEventSeqValue = wakePayload.sourceEventSeq ?? wakePayload.sourceSeq ?? wakePayload.source_seq;
  const sourceEventSeq = typeof sourceEventSeqValue === "number" && Number.isSafeInteger(sourceEventSeqValue) && sourceEventSeqValue >= 0
    ? sourceEventSeqValue
    : null;
  const parentRunId = readRunEventId(context.parentRunId)
    ?? readRunEventId(context.sourceRunId)
    ?? readRunEventId(wakePayload.parentRunId)
    ?? retryOfRunId;

  return {
    runId: input.run.id,
    agentId: input.run.agentId,
    issueId: readNonEmptyString(context.issueId) ?? input.run.nativeIssueId,
    wakeReason: wakeCause ?? wakeReason,
    wakeSource,
    wakeTriggerDetail,
    invocationSource: input.run.invocationSource,
    triggerDetail: input.run.triggerDetail,
    eventRevision: eventRevision,
    sourceEventId,
    sourceEventSeq,
    parentRunId,
    retryOfRunId,
    model,
    billingType,
    modelCallCount,
    modelCallCountSource,
    gatewayCallIds: gatewayCallIds.slice(0, 500),
    gatewayCallIdsTruncated: gatewayCallIds.length > 500,
    litellmRequestIds: litellmRequestIds.slice(0, 500),
    litellmRequestIdsTruncated: litellmRequestIds.length > 500,
    inputTokens: readUsageToken(usage, "inputTokens", "input_tokens", "rawInputTokens"),
    cachedInputTokens: readUsageToken(usage, "cachedInputTokens", "cached_input_tokens", "rawCachedInputTokens"),
    outputTokens: readUsageToken(usage, "outputTokens", "output_tokens", "rawOutputTokens"),
    ...(apiEquivalentCostStatus === "estimated" && apiEquivalentCostUsd !== null
      ? { apiEquivalentCostMicros: Math.round(apiEquivalentCostUsd * 1_000_000) }
      : {}),
    apiEquivalentCostUsd,
    apiEquivalentCostStatus,
    gatewaySpendCents,
    reportedCostCents: Math.max(0, Math.floor(input.reportedCostCents)),
    artifactCount,
    documentCount,
    commitCount,
    pullRequestCount,
    branchCount,
    otherWorkProductCount,
    outcomeCategory,
  };
}

function resolveDurationSeconds(run: HeartbeatRun, now: Date): number | undefined {
  if (!run.startedAt) return undefined;
  const startedAtMs = new Date(run.startedAt).getTime();
  const endMs = run.finishedAt ? new Date(run.finishedAt).getTime() : now.getTime();
  return Math.max(0, Math.round((endMs - startedAtMs) / 1000));
}

async function buildRunTelemetryForDb(db: Db, run: HeartbeatRun) {
  const context = parseObject(run.contextSnapshot);
  const issueId = readNonEmptyString(context.issueId) ?? run.nativeIssueId;
  const [agent, generalSettings, wakeup, issueRow, workProducts, gatewayCalls, runStatusDecision, litellmCosts, reportedCosts] = await Promise.all([
    db.select({ role: agents.role, adapterType: agents.adapterType, adapterConfig: agents.adapterConfig })
      .from(agents).where(eq(agents.id, run.agentId)).then((rows) => rows[0] ?? null),
    instanceSettingsService(db).getGeneral().catch(() => null),
    run.wakeupRequestId
      ? db.select({
          source: agentWakeupRequests.source,
          triggerDetail: agentWakeupRequests.triggerDetail,
          reason: agentWakeupRequests.reason,
          payload: agentWakeupRequests.payload,
        }).from(agentWakeupRequests)
          .where(and(eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.id, run.wakeupRequestId)))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    issueId
      ? db.select({ updatedAt: issues.updatedAt, lastStatusDecisionId: issues.lastStatusDecisionId }).from(issues)
          .where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
          .then((rows) => rows[0] ?? null)
      : Promise.resolve(null),
    db.select({ type: issueWorkProducts.type }).from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, run.companyId), eq(issueWorkProducts.createdByRunId, run.id))),
    issueId
      ? db.select({ id: statusDecisions.id }).from(statusDecisions)
          .where(and(
            eq(statusDecisions.companyId, run.companyId),
            eq(statusDecisions.issueId, issueId),
            eq(statusDecisions.runId, run.id),
            eq(statusDecisions.applicationState, "applied"),
          )).limit(1).then((rows) => rows.length > 0)
      : Promise.resolve(false),
    db.select({ requestId: litellmCostEvents.requestId, costCents: litellmCostEvents.costCents }).from(litellmCostEvents)
      .where(and(eq(litellmCostEvents.companyId, run.companyId), eq(litellmCostEvents.heartbeatRunId, run.id))),
    db.select({ costCents: costEvents.costCents }).from(costEvents)
      .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id))),
  ]);
  const issueCommentsForRun = issueId
    ? await db.select({ id: issueComments.id }).from(issueComments)
        .where(and(
          eq(issueComments.companyId, run.companyId),
          eq(issueComments.issueId, issueId),
          eq(issueComments.createdByRunId, run.id),
          eq(issueComments.deleted, false),
        )).limit(1)
    : [];
  const fallbackFinished = !!run.startedAt && !!run.finishedAt;
  const outcomeCategoryOverride = runStatusDecision
    ? "status"
    : issueCommentsForRun.length > 0
      ? "comment_only"
      : fallbackFinished
        ? "nothing"
        : undefined;
  const outcomeProducts = workProducts.length > 0 ? workProducts : [];
  return {
    agent,
    issueId,
    telemetry: buildRunTelemetry({
      run,
      gatewayCalls,
      reportedCostCents: reportedCosts.reduce((total, cost) => total + Math.max(0, cost.costCents), 0),
      modelApiPricing: generalSettings?.modelApiPricing,
      workProducts: outcomeProducts,
      outcomeCategoryOverride,
      issueUpdatedAt: issueRow?.updatedAt ?? null,
      wakeup,
    }),
  };
}

async function persistRunTelemetrySnapshot(db: Db, run: HeartbeatRun): Promise<Record<string, unknown>> {
  const { telemetry } = await buildRunTelemetryForDb(db, run);
  const resultJson = parseObject(run.resultJson);
  await db.update(heartbeatRuns)
    .set({ resultJson: { ...resultJson, runTelemetry: telemetry }, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  return telemetry;
}

/** Emits one terminal run event and stores its prompt-free, bounded run snapshot. */
export async function emitAgentTaskRun(db: Db, run: HeartbeatRun): Promise<void> {
  try {
    const client = getTelemetryClient();
    const { agent, issueId, telemetry } = await buildRunTelemetryForDb(db, run);
    const resultJson = parseObject(run.resultJson);
    await db.update(heartbeatRuns)
      .set({ resultJson: { ...resultJson, runTelemetry: telemetry }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
    if (!client) return;

    const usage = parseObject(run.usageJson);
    const model = readNonEmptyString(usage.model)
      ?? readNonEmptyString(parseObject(agent?.adapterConfig).model)
      ?? undefined;
    trackAgentTaskRun(client, {
      agentId: run.agentId,
      state: run.status,
      ...(agent ? { adapterType: agent.adapterType, agentRole: agent.role } : {}),
      ...(model ? { model } : {}),
      ...(() => {
        const durationSeconds = resolveDurationSeconds(run, new Date());
        return durationSeconds === undefined ? {} : { durationSeconds };
      })(),
      ...(run.usageJson != null
        ? {
            inputTokens: readUsageToken(usage, "inputTokens", "input_tokens", "rawInputTokens", "raw_input_tokens"),
            outputTokens: readUsageToken(usage, "outputTokens", "output_tokens", "rawOutputTokens", "raw_output_tokens"),
            cachedTokens: readUsageToken(usage, "cachedInputTokens", "cached_input_tokens", "cacheReadInputTokens", "cache_read_input_tokens"),
          }
        : {}),
      ...(issueId ? { taskId: issueId } : {}),
    });
  } catch (err) {
    logger.warn({ err, runId: run.id }, "failed to emit agent.task_run telemetry");
  }
}

export async function refreshRunTelemetrySnapshot(db: Db, input: { runId: string; companyId: string }): Promise<void> {
  try {
    const run = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (run) await persistRunTelemetrySnapshot(db, run);
  } catch (err) {
    logger.warn({ err, runId: input.runId }, "failed to refresh run telemetry snapshot");
  }
}

/** Loads a committed run before emitting telemetry, keeping database rows out of application contracts. */
export async function emitAgentTaskRunById(db: Db, input: { runId: string; companyId: string }): Promise<void> {
  try {
    const run = await db.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)))
      .then((rows) => rows[0] ?? null);
    if (run) await emitAgentTaskRun(db, run);
  } catch (err) {
    logger.warn({ err, runId: input.runId }, "failed to load run for agent.task_run telemetry");
  }
}
