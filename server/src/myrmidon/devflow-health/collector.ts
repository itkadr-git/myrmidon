import {
  activityLog,
  agents,
  connectionEventDeliveries,
  instanceSettings,
  issueComments,
  issueExecutionDecisions,
  issues,
  issueWorkProducts,
  projects,
  type Db,
} from "@myrmidon/db";
import { parseReviewReworkVerdictMarkers } from "@myrmidon/shared";
import { and, eq, ilike, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { issueNeedsReviewer } from "../review-routing/policy.js";
import { isDevProjectCodeIssue } from "../guard-return/domain.js";
import {
  approvedPrSince,
  buildDevflowSignals,
  extractPrNumber,
  redCiSince,
  staleMarkerSince,
  stalledMergeSince,
  stalledRouterSince,
  type DevflowSample,
  type DevflowSignal,
  type PrMarkerState,
  type ReviewVerdict,
} from "./signals.js";

export function extractPrMarker(
  meta: Record<string, unknown>,
  events: { event: string; payload: any; at: Date | null; receivedAt: Date }[],
): PrMarkerState {
  if (meta.reviewApproved === true) {
    return {
      hasMarker: true,
      markedAt: typeof meta.reviewApprovedAt === "string" ? meta.reviewApprovedAt : null,
      markerHeadSha: typeof meta.reviewApprovedHeadSha === "string" ? meta.reviewApprovedHeadSha : null,
    };
  }
  if (typeof meta.marker === "string" && meta.marker.toLowerCase() === "review-approved") {
    return { hasMarker: true };
  }
  const labels: string[] = Array.isArray(meta.labels)
    ? meta.labels.map((l) => (typeof l === "string" ? l : (l as any)?.name ?? "")).filter(Boolean)
    : typeof meta.labels === "string"
      ? [meta.labels]
      : [];
  if (labels.some((l) => l.toLowerCase() === "review-approved")) {
    return { hasMarker: true };
  }

  for (const e of events) {
    if (e.event === "pull_request" && e.payload) {
      const payload = e.payload as Record<string, unknown>;
      const action = payload.action;
      const labelName = (payload.label as any)?.name;
      if (action === "labeled" && typeof labelName === "string" && labelName.toLowerCase() === "review-approved") {
        return { hasMarker: true, markedAt: (e.at ?? e.receivedAt).toISOString() };
      }
      const prLabels = (payload.pull_request as any)?.labels;
      if (Array.isArray(prLabels) && prLabels.some((l: any) => l?.name?.toLowerCase() === "review-approved")) {
        return { hasMarker: true, markedAt: (e.at ?? e.receivedAt).toISOString() };
      }
    }
  }

  return { hasMarker: false };
}

export function extractReviewVerdict(
  issueId: string,
  prNumber: number,
  decisions: (typeof issueExecutionDecisions.$inferSelect)[],
  comments: { id: string; issueId: string; body: string; createdAt: Date }[],
): ReviewVerdict | null {
  const issueDecisions = decisions
    .filter((d) => d.issueId === issueId && d.stageType === "review")
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  if (issueDecisions.length > 0) {
    const latest = issueDecisions[0]!;
    const outcome = latest.outcome.toLowerCase();
    if (outcome === "approved" || outcome === "approve") {
      return { outcome: "approve", at: latest.createdAt.toISOString() };
    }
    return { outcome: "return", at: latest.createdAt.toISOString() };
  }

  const issueCommentsList = comments.filter((c) => c.issueId === issueId);
  const markers = issueCommentsList
    .flatMap((c) => parseReviewReworkVerdictMarkers({ ...c, createdAt: c.createdAt.toISOString() }))
    .filter((m) => !m.prNumber || m.prNumber === prNumber)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  if (markers.length > 0) {
    const latest = markers[0]!;
    return { outcome: latest.outcome, at: latest.at, headSha: latest.headSha };
  }

  return null;
}

/** Read only persisted sources; no GitHub polling, model call, or wakeup. */
export async function collectDevflowHealth(db: Db, companyId: string, now = new Date()): Promise<DevflowSignal[]> {
  const [settings] = await db.select({ general: instanceSettings.general }).from(instanceSettings).limit(1);
  const general = settings?.general as Record<string, unknown> | undefined;
  const stored = general?.devflowHealth as Record<string, unknown> | undefined;
  if (stored && (stored as { enabled?: boolean }).enabled === false) {
    return [];
  }
  const thresholds: Record<string, unknown> = { ...stored };

  for (const [metric, envKeys] of [
    ["engineerIdleMs", ["MYRMIDON_DEVFLOW_ENGINEER_IDLE_MS"]],
    ["reviewQueueAgeMs", ["MYRMIDON_DEVFLOW_REVIEW_QUEUE_MS"]],
    ["redCiMs", ["MYRMIDON_DEVFLOW_RED_CI_MS"]],
    ["codeTasksOnNoncodingRolesMs", ["MYRMIDON_DEVFLOW_CODE_TASKS_NONCODING_MS"]],
    ["staleMarkerMs", ["MYRMIDON_DEVFLOW_STALE_MARKER_MS", "MYRMIDON_DEVFLOW_APPROVAL_MARKER_MS"]],
    ["stalledMergeMs", ["MYRMIDON_DEVFLOW_STALLED_MERGE_MS", "MYRMIDON_DEVFLOW_AUTO_MERGE_MS"]],
    ["stalledRouterMs", ["MYRMIDON_DEVFLOW_STALLED_ROUTER_MS", "MYRMIDON_DEVFLOW_REVIEW_ROUTER_MS"]],
    ["approvedNotMergedMs", ["MYRMIDON_DEVFLOW_APPROVED_NOT_MERGED_MS"]],
    ["noMergesMs", ["MYRMIDON_DEVFLOW_NO_MERGES_MS"]],
  ] as const) {
    for (const envKey of envKeys) {
      if (process.env[envKey]?.trim()) {
        thresholds[metric] = Number(process.env[envKey]);
        break;
      }
    }
  }

  const samples: DevflowSample[] = [];

  // 1. Engineer idle
  const engineers = await db
    .select()
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.role, "engineer"), eq(agents.status, "idle")));
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

  // 2. Review queue age
  const reviews = await db
    .select({
      id: issues.id,
      title: issues.title,
      since: sql<Date>`coalesce((select max(a.created_at) from ${activityLog} a where a.company_id = "issues"."company_id" and a.entity_type = 'issue' and a.entity_id = "issues"."id"::text and a.action = 'issue.updated' and a.details->>'status' = 'in_review' and a.details->'_previous'->>'status' is distinct from 'in_review'), ${issues.createdAt})`,
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

  // 3. Stalled review router queue
  const inReviewIssues = await db
    .select({
      id: issues.id,
      title: issues.title,
      status: issues.status,
      executionPolicy: issues.executionPolicy,
      executionState: issues.executionState,
      reviewPolicy: issues.reviewPolicy,
      since: sql<Date>`coalesce((select max(a.created_at) from ${activityLog} a where a.company_id = "issues"."company_id" and a.entity_type = 'issue' and a.entity_id = "issues"."id"::text and a.action = 'issue.updated' and a.details->>'status' = 'in_review' and a.details->'_previous'->>'status' is distinct from 'in_review'), ${issues.createdAt})`,
    })
    .from(issues)
    .where(
      and(
        eq(issues.companyId, companyId),
        eq(issues.status, "in_review"),
        isNull(issues.hiddenAt),
        isNull(issues.conversationAgentId),
        isNull(issues.conversationUserId),
      ),
    );

  for (const issue of inReviewIssues) {
    const needsReviewer = issueNeedsReviewer(issue as any);
    const routerSince = stalledRouterSince({
      status: issue.status,
      needsReviewer,
      inReviewSince: new Date(issue.since).toISOString(),
    });
    if (routerSince) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "stalledRouterMs",
        since: routerSince,
      });
    }
  }

  // Decisions and comments for verdict extraction
  const decisions = await db
    .select()
    .from(issueExecutionDecisions)
    .where(and(eq(issueExecutionDecisions.companyId, companyId), eq(issueExecutionDecisions.stageType, "review")));

  const verdictComments = await db
    .select({
      id: issueComments.id,
      issueId: issueComments.issueId,
      body: issueComments.body,
      createdAt: issueComments.createdAt,
      authorAgentId: issueComments.authorAgentId,
      authorUserId: issueComments.authorUserId,
      authorType: issueComments.authorType,
    })
    .from(issueComments)
    .where(
      and(
        eq(issueComments.companyId, companyId),
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
      ),
    );

  const commentsByIssueId = new Map<string, Array<{
    id: string;
    issueId: string;
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

  // 4. Products: redCiMs, staleMarkerMs, stalledMergeMs, approvedNotMergedMs
  const products = await db
    .select({ product: issueWorkProducts, issue: issues })
    .from(issueWorkProducts)
    .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
    .where(
      and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issues.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
        inArray(issues.status, ["todo", "in_progress", "in_review", "blocked"]),
        isNull(issues.hiddenAt),
      ),
    );

  const activePrProducts = products.filter(({ product }) => !["merged", "closed"].includes(product.status));

  for (const { product, issue } of activePrProducts) {
    const meta = (product.metadata ?? {}) as Record<string, unknown>;
    const prNumber = extractPrNumber(product) ?? Number(meta.number ?? product.externalId);
    const repo =
      typeof meta.repo === "string"
        ? meta.repo
        : typeof meta.repository === "string"
          ? meta.repository
          : null;
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

    // approvedNotMergedMs
    const approvedSince = approvedPrSince(product, issueCommentsList, {
      prNumber: Number.isInteger(prNumber) && prNumber > 0 ? prNumber : null,
      currentHeadSha: headSha,
      reviewerAgentIds: reviewerAgentIds.length > 0 ? reviewerAgentIds : undefined,
      authorAgentId: issue.createdByAgentId ?? undefined,
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

    if (!repo || typeof prNumber !== "number" || !Number.isInteger(prNumber) || prNumber <= 0) continue;

    const events = await db
      .select({
        event: connectionEventDeliveries.event,
        payload: connectionEventDeliveries.normalizedPayload,
        at: connectionEventDeliveries.providerCreatedAt,
        receivedAt: connectionEventDeliveries.createdAt,
      })
      .from(connectionEventDeliveries)
      .where(
        and(
          eq(connectionEventDeliveries.companyId, companyId),
          inArray(connectionEventDeliveries.event, ["workflow_run", "check_suite", "pull_request"]),
          sql`lower(${connectionEventDeliveries.normalizedPayload}->>'repository') = lower(${repo})`,
          sql`coalesce(${connectionEventDeliveries.normalizedPayload}->>'pullRequestNumber', ${connectionEventDeliveries.normalizedPayload}->>'number') = ${String(prNumber)}`,
        ),
      );

    // redCiMs
    const ciSince = redCiSince(
      events
        .filter((e) => ["workflow_run", "check_suite"].includes(e.event))
        .map(({ payload, at, receivedAt }) => ({
          conclusion:
            typeof payload?.conclusion === "string" && (!payload?.status || payload.status === "completed")
              ? payload.conclusion
              : null,
          at: (at ?? receivedAt).toISOString(),
        })),
    );
    if (ciSince) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "redCiMs",
        since: ciSince,
      });
    }

    // staleMarkerMs
    const verdict = extractReviewVerdict(issue.id, prNumber, decisions, verdictComments);
    const marker = extractPrMarker(meta, events);

    const markerSince = staleMarkerSince({
      verdict,
      marker,
      prStatus: product.status,
      currentHeadSha: headSha,
    });
    if (markerSince) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "staleMarkerMs",
        since: markerSince,
      });
    }

    // stalledMergeMs
    if (verdict?.outcome === "approve" || marker.hasMarker) {
      const approvedAt =
        verdict?.at ??
        marker.markedAt ??
        (product.createdAt instanceof Date ? product.createdAt.toISOString() : String(product.createdAt));
      const mergeSince = stalledMergeSince({
        approvedAt,
        prStatus: product.status,
        isMerged: product.status === "merged",
      });
      if (mergeSince) {
        samples.push({
          companyId,
          subjectId: issue.id,
          subjectKind: "issue",
          title: issue.title,
          metric: "stalledMergeMs",
          since: mergeSince,
        });
      }
    }
  }

  // 5. noMergesMs: 0 merges in 6 hours with non-empty active queue
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

  const candidateIssues = await db
    .select({
      id: issues.id,
      title: issues.title,
      casteKey: issues.casteKey,
      harnessKind: issues.harnessKind,
      executionWorkspacePreference: issues.executionWorkspacePreference,
      executionState: issues.executionState,
      since: sql<Date>`coalesce((select max(a.created_at) from ${activityLog} a where a.company_id = "issues"."company_id" and a.entity_type = 'issue' and a.entity_id = "issues"."id"::text and a.action = 'issue.updated' and a.details->>'assigneeAgentId' = ${issues.assigneeAgentId}::text), ${issues.updatedAt}, ${issues.createdAt})`,
      updatedAt: issues.updatedAt,
      projectDefaultCasteKey: projects.defaultCasteKey,
      projectName: projects.name,
    })
    .from(issues)
    .innerJoin(agents, eq(agents.id, issues.assigneeAgentId))
    .leftJoin(projects, eq(projects.id, issues.projectId))
    .where(
      and(
        eq(issues.companyId, companyId),
        isNull(issues.hiddenAt),
        inArray(issues.status, ["in_progress", "in_review"]),
        ne(agents.role, "engineer"),
      ),
    );

  for (const issue of candidateIssues) {
    const prs = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(eq(issueWorkProducts.issueId, issue.id), eq(issueWorkProducts.type, "pull_request")))
      .limit(1);

    if (
      isDevProjectCodeIssue({
        casteKey: issue.casteKey,
        projectDefaultCasteKey: issue.projectDefaultCasteKey,
        projectName: issue.projectName,
        harnessKind: issue.harnessKind,
        executionWorkspacePreference: issue.executionWorkspacePreference,
        hasEngineerPr: prs.length > 0,
        hasReviewState: Boolean(issue.executionState && (issue.executionState as any).stages),
      })
    ) {
      samples.push({
        companyId,
        subjectId: issue.id,
        subjectKind: "issue",
        title: issue.title,
        metric: "codeTasksOnNoncodingRolesMs",
        since: new Date((issue as any).since ?? issue.updatedAt).toISOString(),
      });
    }
  }
  // One card per subject/metric even when a PR has multiple registered products.
  const signals = buildDevflowSignals(samples, thresholds, now);
  return [...new Map(signals.map((s) => [s.dedupKey, s])).values()];
}
