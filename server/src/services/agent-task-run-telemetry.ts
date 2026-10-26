import { and, eq, sql } from "drizzle-orm";
import {
  activityLog,
  agentWakeupRequests,
  agents,
  costEvents,
  documentRevisions,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueWorkProducts,
  litellmCostEvents,
  type Db,
} from "@myrmidon/db";
import { estimateModelApiCostUsd, normalizeModelApiPricingSettings } from "@myrmidon/shared";
import { trackAgentTaskRun } from "@myrmidon/shared/telemetry";
import { parseObject } from "../adapters/utils.js";
import { logger } from "../middleware/logger.js";
import { instanceSettingsService } from "./instance-settings.js";
import { getTelemetryClient } from "../telemetry.js";

type HeartbeatRun = typeof heartbeatRuns.$inferSelect;
type RunActivity = { action: string; details: Record<string, unknown> | null };
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

function isStatusChange(activity: RunActivity): boolean {
  if (activity.action !== "issue.updated") return false;
  const details = activity.details ?? {};
  const status = readNonEmptyString(details.status);
  const previousStatus = readNonEmptyString(details.previousStatus)
    ?? readNonEmptyString(details.fromStatus)
    ?? readNonEmptyString(parseObject(details._previous).status)
    ?? readNonEmptyString(parseObject(parseObject(details.changes).status).from);
  const nextStatus = readNonEmptyString(details.toStatus) ?? status;
  return Boolean(nextStatus && previousStatus && nextStatus !== previousStatus);
}

export function buildRunTelemetry(input: {
  run: Pick<HeartbeatRun, "id" | "agentId" | "invocationSource" | "triggerDetail" | "retryOfRunId" | "nativeIssueId" | "contextSnapshot" | "usageJson" | "resultJson">;
  gatewayCalls: Array<{ requestId: string | null; costCents: number }>;
  reportedCostCents: number;
  modelApiPricing?: unknown;
  activity: RunActivity[];
  workProducts: RunWorkProduct[];
  commentCount: number;
  documentRevisionCount: number;
  eventSequence?: number | null;
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
  const spendCallIds = input.gatewayCalls.map((call) => readRunEventId(call.requestId)).filter((value): value is string => value !== null);
  const gatewayCallIds = [...new Set(gatewayResultIds)];
  const litellmRequestIds = [...new Set(spendCallIds)];
  const declaredCallCount = readModelCallCount(result);
  const modelCallCount = declaredCallCount
    ?? (gatewayCallIds.length > 0 ? gatewayCallIds.length : litellmRequestIds.length > 0 ? litellmRequestIds.length : null);
  const modelCallCountSource = readRunDimension(result.modelCallCountSource)
    ?? (declaredCallCount !== null
      ? "gateway_count"
      : gatewayCallIds.length > 0 ? "gateway_call_ids" : litellmRequestIds.length > 0 ? "litellm_request_ids" : "unknown");
  const model = readNonEmptyString(usage.model) ?? readNonEmptyString(result.model);
  const billingType = readNonEmptyString(usage.billingType) ?? readNonEmptyString(usage.billing_type);
  const statusChangeCount = input.activity.filter(isStatusChange).length;
  const artifactCount = input.workProducts.filter((product) => product.type === "artifact").length;
  const documentRevisionCount = input.documentRevisionCount;
  const commitCount = input.workProducts.filter((product) => product.type === "commit").length;
  const pullRequestCount = input.workProducts.filter((product) => product.type === "pull_request").length;
  const outcomeCategory = artifactCount + documentRevisionCount > 0
    ? "artifact"
    : statusChangeCount > 0
      ? "status"
      : commitCount + pullRequestCount > 0
        ? "commit_push"
        : input.commentCount > 0
          ? "comment_only"
          : "nothing";
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
  const eventRevision = readRunEventId(context.eventRevision)
    ?? readRunEventId(context.eventRevisionId)
    ?? readRunEventId(context.event_revision);
  const wakePayload = input.wakeup?.payload ?? {};
  const wakeReason = readRunDimension(input.wakeup?.reason)
    ?? readRunDimension(context.wakeReason)
    ?? readRunDimension(wakePayload.reason);
  const wakeSource = readRunDimension(input.wakeup?.source)
    ?? readRunDimension(context.wakeSource)
    ?? readRunDimension(context.source);
  const wakeTriggerDetail = readRunDimension(input.wakeup?.triggerDetail)
    ?? readRunDimension(context.wakeTriggerDetail);
  const eventRevisionId = eventRevision
    ?? readRunEventId(wakePayload.eventRevisionId)
    ?? readRunEventId(wakePayload.event_revision_id);
  const sourceEventId = readRunEventId(wakePayload.sourceEventId)
    ?? readRunEventId(wakePayload.source_event_id)
    ?? readRunEventId(wakePayload.commentId)
    ?? readRunEventId(context.wakeCommentId);
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
    wakeReason,
    wakeSource,
    wakeTriggerDetail,
    invocationSource: input.run.invocationSource,
    triggerDetail: input.run.triggerDetail,
    eventRevision,
    eventRevisionId,
    sourceEventId,
    sourceEventSeq,
    runEventSequence: typeof input.eventSequence === "number" && Number.isFinite(input.eventSequence) ? input.eventSequence : null,
    parentRunId,
    retryOfRunId,
    model,
    billingType,
    modelCallCount,
    modelCallCountSource,
    gatewayCallIds: gatewayCallIds.slice(0, 80),
    gatewayCallIdsTruncated: gatewayCallIds.length > 80,
    litellmRequestIds: litellmRequestIds.slice(0, 80),
    litellmRequestIdsTruncated: litellmRequestIds.length > 80,
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
    statusChangeCount,
    artifactCount,
    documentRevisionCount,
    commitCount,
    pullRequestCount,
    commentCount: Math.max(0, Math.floor(input.commentCount)),
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
  const [agent, generalSettings, wakeup, activity, workProducts, commentCount, documentRevisionCount, gatewayCalls, reportedCosts, latestEvent] = await Promise.all([
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
    db.select({ action: activityLog.action, details: activityLog.details }).from(activityLog)
      .where(and(eq(activityLog.companyId, run.companyId), eq(activityLog.runId, run.id))),
    db.select({ type: issueWorkProducts.type }).from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.companyId, run.companyId), eq(issueWorkProducts.createdByRunId, run.id))),
    db.select({ count: sql<number>`count(*)::int` }).from(issueComments)
      .where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.createdByRunId, run.id)))
      .then((rows) => rows[0]?.count ?? 0),
    db.select({ count: sql<number>`count(*)::int` }).from(documentRevisions)
      .where(and(eq(documentRevisions.companyId, run.companyId), eq(documentRevisions.createdByRunId, run.id)))
      .then((rows) => rows[0]?.count ?? 0),
    db.select({ requestId: litellmCostEvents.requestId, costCents: litellmCostEvents.costCents }).from(litellmCostEvents)
      .where(and(eq(litellmCostEvents.companyId, run.companyId), eq(litellmCostEvents.heartbeatRunId, run.id))),
    db.select({ costCents: costEvents.costCents }).from(costEvents)
      .where(and(eq(costEvents.companyId, run.companyId), eq(costEvents.heartbeatRunId, run.id))),
    db.select({ seq: heartbeatRunEvents.seq }).from(heartbeatRunEvents)
      .where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id)))
      .orderBy(sql`${heartbeatRunEvents.seq} desc`).limit(1).then((rows) => rows[0] ?? null),
  ]);
  return {
    agent,
    issueId,
    telemetry: buildRunTelemetry({
      run,
      gatewayCalls,
      reportedCostCents: reportedCosts.reduce((total, cost) => total + Math.max(0, cost.costCents), 0),
      modelApiPricing: generalSettings?.modelApiPricing,
      activity,
      workProducts,
      commentCount,
      documentRevisionCount,
      eventSequence: latestEvent ? Number(latestEvent.seq) : null,
      wakeup,
    }),
  };
}

async function persistRunTelemetrySnapshot(db: Db, run: HeartbeatRun): Promise<Record<string, unknown>> {
  const { telemetry } = await buildRunTelemetryForDb(db, run);
  await db.update(heartbeatRuns)
    .set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ runTelemetry: telemetry })}::jsonb`, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  return telemetry;
}

/** Emits one terminal run event and stores its prompt-free, bounded run snapshot. */
export async function emitAgentTaskRun(db: Db, run: HeartbeatRun): Promise<void> {
  try {
    const client = getTelemetryClient();
    const { agent, issueId, telemetry } = await buildRunTelemetryForDb(db, run);
    await db.update(heartbeatRuns)
      .set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ runTelemetry: telemetry })}::jsonb`, updatedAt: new Date() })
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
