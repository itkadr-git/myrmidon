import { agents, issues, issueWorkProducts, issueComments, activityLog, connectionEventDeliveries, instanceSettings, type Db } from "@myrmidon/db";
import { and, eq, inArray, isNull, or, ilike, sql } from "drizzle-orm";
import { approvedPrSince, buildDevflowSignals, redCiSince, type DevflowSample, type DevflowSignal } from "./signals.js";

/** Read only persisted sources; no GitHub polling, model call, or wakeup. */
export async function collectDevflowHealth(db: Db, companyId: string, now = new Date()): Promise<DevflowSignal[]> {
  const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
  const general = settings?.general as Record<string, unknown> | undefined;
  const stored = general?.devflowHealth as Record<string, unknown> | undefined;
  const thresholds: Record<string, unknown> = { ...stored };
  for (const [metric, envKey] of Object.entries({
    engineerIdleMs: "MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS",
    reviewQueueAgeMs: "MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS",
    redCiMs: "MYRMIDON_DEVFLOW_RED_CI_MS",
    approvedNotMergedMs: "MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS",
  })) {
    if (process.env[envKey]?.trim()) thresholds[metric] = Number(process.env[envKey]);
  }
  if (!stored && Object.keys(thresholds).length === 0) {
    return [];
  }

  const samples: DevflowSample[] = [];
  const engineers = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "engineer"), eq(agents.status, "idle")));
  for (const agent of engineers) {
    // Paused/running/retired agents are not idle engineers. New agents age from creation.
    samples.push({ companyId, subjectId: agent.id, subjectKind: "agent", title: agent.name,
      metric: "engineerIdleMs", since: (agent.lastHeartbeatAt ?? agent.createdAt).toISOString() });
  }
  const reviews = await db.select({ id: issues.id, title: issues.title,
    since: sql<Date>`coalesce((select max(a.created_at) from ${activityLog} a where a.company_id = ${issues.companyId} and a.entity_type = 'issue' and a.entity_id = ${issues.id}::text and a.action = 'issue.updated' and a.details->>'status' = 'in_review' and a.details->'_previous'->>'status' is distinct from 'in_review'), ${issues.createdAt})` })
    .from(issues).where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), isNull(issues.hiddenAt)));
  for (const issue of reviews) samples.push({ companyId, subjectId: issue.id, subjectKind: "issue", title: issue.title,
    metric: "reviewQueueAgeMs", since: new Date(issue.since).toISOString() });

  const products = await db.select({ product: issueWorkProducts, issue: issues }).from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(eq(issueWorkProducts.companyId, companyId), eq(issues.companyId, companyId),
      eq(issueWorkProducts.type, "pull_request"), eq(issueWorkProducts.provider, "github"),
      inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]), isNull(issues.hiddenAt)));

  const activeIssueIds = [...new Set(products.map(({ issue }) => issue.id))];
  const verdictComments = activeIssueIds.length > 0
    ? await db.select({ issueId: issueComments.issueId, body: issueComments.body, createdAt: issueComments.createdAt })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, companyId),
        inArray(issueComments.issueId, activeIssueIds),
        or(
          ilike(issueComments.body, "%verdict%"),
          ilike(issueComments.body, "%вердикт%"),
        ),
      ))
    : [];

  const commentsByIssueId = new Map<string, Array<{ body: string; createdAt: Date }>>();
  for (const comment of verdictComments) {
    const list = commentsByIssueId.get(comment.issueId) ?? [];
    list.push(comment);
    commentsByIssueId.set(comment.issueId, list);
  }

  for (const { product, issue } of products) {
    if (["merged", "closed"].includes(product.status)) continue;
    const meta = product.metadata ?? {};
    const repo = typeof meta.repo === "string" ? meta.repo : typeof meta.repository === "string" ? meta.repository : null;
    const number = Number(meta.number ?? product.externalId);
    if (!repo || !Number.isInteger(number) || number <= 0) continue;

    // Red CI sample
    const events = await db.select({ payload: connectionEventDeliveries.normalizedPayload, at: connectionEventDeliveries.providerCreatedAt, receivedAt: connectionEventDeliveries.createdAt })
      .from(connectionEventDeliveries).where(and(eq(connectionEventDeliveries.companyId, companyId),
        inArray(connectionEventDeliveries.event, ["workflow_run", "check_suite"]),
        sql`lower(${connectionEventDeliveries.normalizedPayload}->>'repository') = lower(${repo})`,
        sql`coalesce(${connectionEventDeliveries.normalizedPayload}->>'pullRequestNumber', ${connectionEventDeliveries.normalizedPayload}->>'number') = ${String(number)}`));
    const redSince = redCiSince(events.map(({ payload, at, receivedAt }) => ({
      conclusion: typeof payload.conclusion === "string" && (!payload.status || payload.status === "completed") ? payload.conclusion : null,
      at: (at ?? receivedAt).toISOString(),
    })));
    if (redSince) samples.push({ companyId, subjectId: issue.id, subjectKind: "issue", title: issue.title, metric: "redCiMs", since: redSince });

    // Approved not merged sample
    const issueCommentsList = commentsByIssueId.get(issue.id) ?? [];
    const approvedSince = approvedPrSince(product, issueCommentsList);
    if (approvedSince) {
      samples.push({ companyId, subjectId: issue.id, subjectKind: "issue", title: issue.title, metric: "approvedNotMergedMs", since: approvedSince });
    }
  }

  // One card per subject/metric even when a PR has multiple registered products.
  const signals = buildDevflowSignals(samples, thresholds, now);
  return [...new Map(signals.map((s) => [s.dedupKey, s])).values()];
}
