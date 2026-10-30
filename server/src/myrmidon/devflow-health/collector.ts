import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import type { Db } from "@myrmidon/db";
import { activityLog, agents, connectionEventDeliveries, instanceSettings, issueComments, issues, issueWorkProducts } from "@myrmidon/db";
import {
  buildDevflowSignals,
  redCiSince,
  approvedPrSince,
  extractPrNumber,
  type DevflowSample,
  type DevflowSignal,
} from "./signals.js";
import { DEVFLOW_HEALTH_SETTINGS_KEY } from "./thresholds.js";

export async function collectDevflowHealth(db: Db, companyId: string, now = new Date()): Promise<DevflowSignal[]> {
  const settingsRows = await db
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .limit(1);
  const general = (settingsRows[0]?.general as Record<string, unknown> | undefined) ?? {};
  const thresholds = general[DEVFLOW_HEALTH_SETTINGS_KEY];
  if (thresholds && typeof thresholds === "object" && (thresholds as { enabled?: boolean }).enabled === false) {
    return [];
  }

  const samples: DevflowSample[] = [];

  // 1. engineerIdleMs
  const engineers = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.role, "engineer"), eq(agents.status, "idle")));
  for (const agent of engineers) {
    samples.push({
      companyId,
      subjectId: agent.id,
      subjectKind: "agent",
      title: agent.name,
      metric: "engineerIdleMs",
      since: (agent.lastHeartbeatAt ?? agent.createdAt).toISOString(),
    });
  }

  // 2. reviewQueueAgeMs
  const reviews = await db.select({
    id: issues.id,
    title: issues.title,
    since: sql<Date>`coalesce((select max(a.created_at) from ${activityLog} a where a.company_id = ${issues.companyId} and a.entity_type = 'issue' and a.entity_id = ${issues.id}::text and a.action = 'issue.updated' and a.details->>'status' = 'in_review' and a.details->'_previous'->>'status' is distinct from 'in_review'), ${issues.createdAt})`,
  })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"), isNull(issues.hiddenAt)));

  for (const issue of reviews) {
    samples.push({
      companyId,
      subjectId: issue.id,
      subjectKind: "issue",
      title: issue.title,
      metric: "reviewQueueAgeMs",
      since: new Date(issue.since).toISOString(),
    });
  }

  // 3. Active products query for pull requests
  const products = await db.select({
    product: issueWorkProducts,
    issue: issues,
    issueInReviewSince: sql<Date | null>`(
      select max(a.created_at) from ${activityLog} a
      where a.company_id = ${issues.companyId}
        and a.entity_type = 'issue'
        and a.entity_id = ${issues.id}::text
        and a.action = 'issue.updated'
        and a.details->>'status' = 'in_review'
        and a.details->'_previous'->>'status' is distinct from 'in_review'
    )`,
  })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issues.companyId, companyId),
      eq(issueWorkProducts.type, "pull_request"),
      eq(issueWorkProducts.provider, "github"),
      inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
      isNull(issues.hiddenAt),
    ));

  const activeIssueIds = [...new Set(products.map(({ issue }) => issue.id))];

  // SQL prefilter for review comments on active issues
  const verdictComments = activeIssueIds.length > 0
    ? await db.select({
        issueId: issueComments.issueId,
        body: issueComments.body,
        createdAt: issueComments.createdAt,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        authorType: issueComments.authorType,
      })
      .from(issueComments)
      .where(and(
        eq(issueComments.companyId, companyId),
        inArray(issueComments.issueId, activeIssueIds),
        or(
          ilike(issueComments.body, "%verdict%"),
          ilike(issueComments.body, "%вердикт%"),
          ilike(issueComments.body, "%approve%"),
          ilike(issueComments.body, "%одобр%"),
          ilike(issueComments.body, "%request changes%"),
          ilike(issueComments.body, "%changes requested%"),
          ilike(issueComments.body, "%rework%"),
          ilike(issueComments.body, "%доработк%"),
        ),
      ))
    : [];

  const commentsByIssueId = new Map<string, Array<{
    body: string;
    createdAt: Date;
    authorAgentId?: string | null;
    authorUserId?: string | null;
    authorType?: string | null;
  }>>();
  for (const comment of verdictComments) {
    const list = commentsByIssueId.get(comment.issueId) ?? [];
    list.push(comment);
    commentsByIssueId.set(comment.issueId, list);
  }

  // Active PR products (not merged, not closed)
  const activePrProducts = products.filter(({ product }) => !["merged", "closed"].includes(product.status));

  // Process approvedNotMergedMs (BEFORE repo/number guard!)
  for (const { product, issue, issueInReviewSince } of activePrProducts) {
    const prNumber = extractPrNumber(product);
    const meta = (product.metadata ?? {}) as Record<string, unknown>;
    const headSha = typeof meta.headSha === "string" ? meta.headSha : typeof meta.sha === "string" ? meta.sha : null;

    // Reviewer agent IDs from assignee (if in_review) or executionPolicy review stage
    const reviewerAgentIds: string[] = [];
    if (issue.assigneeAgentId && issue.status === "in_review") {
      reviewerAgentIds.push(issue.assigneeAgentId);
    }
    const executionPolicy = issue.executionPolicy as {
      stages?: Array<{ type: string; participants?: Array<{ type: string; agentId?: string }> }>;
    } | null;
    if (executionPolicy?.stages) {
      for (const stage of executionPolicy.stages) {
        if (stage.type === "review" && Array.isArray(stage.participants)) {
          for (const p of stage.participants) {
            if (p.agentId) reviewerAgentIds.push(p.agentId);
          }
        }
      }
    }

    const issueCommentsList = commentsByIssueId.get(issue.id) ?? [];
    const approvedSince = approvedPrSince(product, issueCommentsList, {
      prNumber,
      currentHeadSha: headSha,
      reviewerAgentIds: reviewerAgentIds.length > 0 ? reviewerAgentIds : undefined,
      authorAgentId: issue.createdByAgentId ?? undefined,
      fallbackApprovedAt: issueInReviewSince ? new Date(issueInReviewSince) : (product.createdAt ? new Date(product.createdAt) : null),
    });

    if (approvedSince) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "approvedNotMergedMs",
        since: approvedSince,
      });
    }

    // Red CI sample - guarded by repo and valid number
    const repo = typeof meta.repo === "string" ? meta.repo : typeof meta.repository === "string" ? meta.repository : null;
    const number = prNumber;
    if (!repo || typeof number !== "number" || !Number.isInteger(number) || number <= 0) continue;

    const events = await db.select({
      payload: connectionEventDeliveries.normalizedPayload,
      at: connectionEventDeliveries.providerCreatedAt,
      receivedAt: connectionEventDeliveries.createdAt,
    })
      .from(connectionEventDeliveries)
      .where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        inArray(connectionEventDeliveries.event, ["workflow_run", "check_suite"]),
        sql`lower(${connectionEventDeliveries.normalizedPayload}->>'repository') = lower(${repo})`,
        sql`coalesce(${connectionEventDeliveries.normalizedPayload}->>'pullRequestNumber', ${connectionEventDeliveries.normalizedPayload}->>'number') = ${String(number)}`,
      ));

    const redSince = redCiSince(events.map(({ payload, at, receivedAt }) => ({
      conclusion: typeof payload.conclusion === "string" && (!payload.status || payload.status === "completed") ? payload.conclusion : null,
      at: (at ?? receivedAt).toISOString(),
    })));

    if (redSince) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "redCiMs",
        since: redSince,
      });
    }
  }

  // 4. noMergesMs: 0 merges in 6 hours with non-empty active queue
  if (activePrProducts.length > 0) {
    const [latestMerged] = await db
      .select({
        mergedAt: sql<Date | null>`max(coalesce(${issueWorkProducts.updatedAt}, ${issueWorkProducts.createdAt}))`,
      })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.status, "merged"),
      ));

    let lastMergeSince: Date;
    if (latestMerged?.mergedAt) {
      lastMergeSince = new Date(latestMerged.mergedAt);
    } else {
      // If no PR was ever merged, age from the oldest active PR creation time
      const oldestProduct = activePrProducts.reduce((oldest, item) => {
        const itemTime = item.product.createdAt ? new Date(item.product.createdAt).getTime() : now.getTime();
        const oldestTime = oldest.product.createdAt ? new Date(oldest.product.createdAt).getTime() : now.getTime();
        return itemTime < oldestTime ? item : oldest;
      }, activePrProducts[0]);
      lastMergeSince = oldestProduct.product.createdAt ? new Date(oldestProduct.product.createdAt) : now;
    }

    const oldestIssue = activePrProducts[0].issue;
    samples.push({
      companyId,
      subjectId: oldestIssue.id,
      subjectKind: "issue",
      title: `Devflow merge queue stalled: 0 merges in 6h (${activePrProducts.length} active PR${activePrProducts.length > 1 ? "s" : ""})`,
      metric: "noMergesMs",
      since: lastMergeSince.toISOString(),
    });
  }

  // Deduplicate signals by dedupKey
  const signals = buildDevflowSignals(samples, thresholds, now);
  return [...new Map(signals.map((s) => [s.dedupKey, s])).values()];
}
