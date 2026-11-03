import { randomUUID } from "node:crypto";
import {
  activityLog,
  connectionEventDeliveries,
  connectionGrants,
  externalObjects,
  heartbeatRuns,
  issueWorkProducts,
  issueComments,
  issues,
  toolConnections,
  type Db,
} from "@myrmidon/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  logActivity,
  publishActivity,
  type ActivityPublication,
} from "./activity-log.js";
import {
  createPaperclipCloudConnector,
  paperclipCloudConnectorConfigFromEnv,
  type PaperclipCloudConnector,
  type SealedConnectorEvents,
} from "./paperclip-cloud-connector.js";
import { issueService } from "./issues.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import type { IssueAssignmentWakeupDeps } from "./issue-assignment-wakeup.js";
import { logger } from "../middleware/logger.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";

type LeasedEvent = SealedConnectorEvents["events"][number];
type GitHubBinding = {
  id: string;
  companyId: string;
  connectionId: string;
  grantId: string;
  subject: string;
  installationId: string;
  providerTenant: NonNullable<typeof connectionGrants.$inferSelect.providerTenant>;
};

export type GitHubConnectionEventPollResult = {
  leased: number;
  processed: number;
  duplicate: number;
  ignored: number;
  failed: number;
};

export type GitHubEventsWatchdogResult = {
  scannedCompanies: number;
  activePrCount: number;
  alarmsCreated: number;
  alarmsResolved: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function boundedString(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && /^[1-9][0-9]{0,30}$/.test(value) ? value : null;
}

function isoDate(value: unknown): string | null {
  const candidate = boundedString(value, 100);
  if (!candidate || Number.isNaN(Date.parse(candidate))) return null;
  return new Date(candidate).toISOString();
}

function commitSha(value: unknown): string | null {
  return typeof value === "string" && /^[0-9a-f]{40,64}$/i.test(value) ? value.toLowerCase() : null;
}

function githubUrl(value: unknown): string | null {
  const candidate = boundedString(value, 2_000);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" && url.hostname.toLowerCase() === "github.com" ? url.toString() : null;
  } catch {
    return null;
  }
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== null && value !== undefined));
}

/**
 * Treat the sealed Cloud batch as an untrusted boundary. Cloud already normalizes
 * GitHub payloads, but the instance independently allowlists and bounds the small
 * reconciliation record that it persists and processes.
 */
function normalizeLeasedPayload(event: LeasedEvent): Record<string, unknown> {
  const payload = record(event.payload);
  const base = {
    event: boundedString(payload.event, 100),
    action: boundedString(payload.action, 100),
    installationId: identifier(payload.installationId),
    repositoryId: identifier(payload.repositoryId),
    repository: boundedString(payload.repository, 300),
    senderId: identifier(payload.senderId),
    senderLogin: boundedString(payload.senderLogin, 100),
  };
  if (event.event === "pull_request") {
    const rawMergeable = payload.mergeable ?? payload.mergeableState ?? payload.mergeable_state;
    const mergeable = rawMergeable === "CONFLICTING" || rawMergeable === false || rawMergeable === "dirty"
      ? "CONFLICTING"
      : rawMergeable === "MERGEABLE" || rawMergeable === true || rawMergeable === "clean"
        ? "MERGEABLE"
        : boundedString(rawMergeable, 40);
    return compact({
      ...base,
      number: positiveInteger(payload.number),
      url: githubUrl(payload.url),
      state: boundedString(payload.state, 40),
      mergeable,
      merged: payload.merged === true,
      mergedAt: isoDate(payload.mergedAt),
      updatedAt: isoDate(payload.updatedAt),
      headRef: boundedString(payload.headRef, 300),
      headSha: commitSha(payload.headSha),
      baseRef: boundedString(payload.baseRef, 300),
      baseSha: commitSha(payload.baseSha),
    });
  }
  if (event.event === "workflow_run" || event.event === "check_suite" || event.event === "check_run") {
    const rawCheckRun = record(payload.check_run);
    const rawCheckSuite = record(payload.check_suite);
    const rawWorkflowRun = record(payload.workflow_run);
    const checkSuite = record(payload.checkSuite) ?? rawCheckSuite;
    const checkRun = record(payload.checkRun) ?? rawCheckRun;
    const workflowRun = record(payload.workflowRun) ?? rawWorkflowRun;

    const workflowPullRequests = workflowRun.pullRequests ?? workflowRun.pull_requests;
    const workflowPullRequestNumber = Array.isArray(workflowPullRequests) ? positiveInteger(record(workflowPullRequests[0]).number) : null;
    const checkPullRequests = checkSuite.pullRequests ?? checkSuite.pull_requests;
    const checkPullRequestNumber = Array.isArray(checkPullRequests) ? positiveInteger(record(checkPullRequests[0]).number) : null;
    const checkRunPullRequests = checkRun.pullRequests ?? checkRun.pull_requests;
    const checkRunPullRequestNumber = Array.isArray(checkRunPullRequests) ? positiveInteger(record(checkRunPullRequests[0]).number) : null;
    const pullRequest = record(payload.pullRequest);

    const headSha = commitSha(payload.headSha)
      ?? commitSha(checkRun.head_sha)
      ?? commitSha(checkRun.headSha)
      ?? commitSha(checkSuite.head_sha)
      ?? commitSha(checkSuite.headSha)
      ?? commitSha(workflowRun.head_sha)
      ?? commitSha(workflowRun.headSha);

    const conclusion = boundedString(payload.conclusion ?? checkRun.conclusion ?? checkSuite.conclusion ?? workflowRun.conclusion, 40);
    const status = boundedString(payload.status ?? checkRun.status ?? checkSuite.status ?? workflowRun.status, 40);
    const runId = identifier(payload.runId ?? checkRun.id ?? workflowRun.id);
    const checkSuiteId = identifier(payload.checkSuiteId ?? checkSuite.id ?? record(checkRun.check_suite ?? checkRun.checkSuite).id);
    const htmlUrl = githubUrl(payload.htmlUrl ?? checkRun.html_url ?? checkRun.htmlUrl ?? checkSuite.html_url ?? checkSuite.htmlUrl ?? workflowRun.html_url ?? workflowRun.htmlUrl);

    return compact({
      ...base,
      action: boundedString(payload.action, 100),
      repository: boundedString(payload.repository ?? record(payload.repository).full_name, 300),
      number: checkRunPullRequestNumber ?? workflowPullRequestNumber ?? checkPullRequestNumber ?? positiveInteger(payload.number),
      pullRequestNumber: positiveInteger(pullRequest.number) ?? checkRunPullRequestNumber ?? checkPullRequestNumber ?? workflowPullRequestNumber ?? positiveInteger(payload.pullRequestNumber) ?? positiveInteger(payload.number),
      headSha,
      conclusion,
      status,
      runId,
      checkSuiteId,
      htmlUrl,
    });
  }
  if (event.event === "installation_repositories") {
    const repositoryIds = (value: unknown) => Array.isArray(value)
      ? value.slice(0, 1_000).flatMap((item) => identifier(item) ?? [])
      : [];
    return compact({
      ...base,
      repositorySelection: boundedString(payload.repositorySelection, 40),
      repositoriesAdded: repositoryIds(payload.repositoriesAdded),
      repositoriesRemoved: repositoryIds(payload.repositoriesRemoved),
    });
  }
  if (event.event === "installation") {
    return compact({
      ...base,
      accountId: identifier(payload.accountId),
      accountLogin: boundedString(payload.accountLogin, 100),
      repositorySelection: boundedString(payload.repositorySelection, 40),
    });
  }
  return compact(base);
}

function bindingRows(rows: Array<{
  grant: typeof connectionGrants.$inferSelect;
  connection: typeof toolConnections.$inferSelect;
}>): GitHubBinding[] {
  return rows.flatMap(({ grant, connection }) => {
    const config = record(connection.config);
    const oauth = record(config.oauth);
    if (config.sourceTemplateKey !== "github" || oauth.connectorProfile !== "github.code") return [];
    const github = grant.providerTenant?.github;
    if (!github || grant.status !== "active") return [];
    const subject = grant.kind === "agent" && grant.subjectAgentId
      ? `agent:${grant.subjectAgentId}`
      : grant.kind === "user" && grant.subjectUserId
        ? grant.subjectUserId
        : typeof oauth.connectorSubjectUserId === "string" && oauth.connectorSubjectUserId.length > 0
          ? oauth.connectorSubjectUserId
          : typeof oauth.connectorSubjectAgentId === "string" && oauth.connectorSubjectAgentId.length > 0
            ? `agent:${oauth.connectorSubjectAgentId}`
            : grant.createdByUserId ?? (grant.kind === "organization" ? `company:${grant.companyId}` : null);
    if (!subject) return [];
    const rawInstallationIds = github.installationIds;
    const installationIds = Array.isArray(rawInstallationIds)
      ? rawInstallationIds.map((id) => String(id)).filter(Boolean)
      : [];
    return installationIds.map((installationId) => ({
      id: `${grant.id}_${installationId}`,
      companyId: grant.companyId,
      connectionId: connection.id,
      grantId: grant.id,
      subject,
      installationId,
      providerTenant: grant.providerTenant!,
    }));
  });
}

function githubSnapshotUpdate(payload: Record<string, unknown>) {
  const repository = stringValue(payload.repository);
  const number = positiveInteger(payload.number);
  if (!repository || !number) return null;
  const state = stringValue(payload.state) ?? "unknown";
  const merged = payload.merged === true;
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) return null;
  return {
    repository,
    owner,
    repo,
    number,
    externalId: `${repository}#pull/${number}`,
    state,
    merged,
    statusKey: merged ? "merged" : state === "closed" ? "closed" : "open",
    statusLabel: merged ? "Merged" : state === "closed" ? "Closed" : "Open",
    statusCategory: merged ? "succeeded" : state === "closed" ? "closed" : "open",
    statusTone: merged ? "success" : state === "closed" ? "muted" : "info",
    statusIconKey: merged ? "git-merge" : state === "closed" ? "x-circle" : "git-pull-request",
    data: {
      provider: "github",
      owner,
      repo,
      number,
      state,
      merged,
      ...(stringValue(payload.mergeable) ? { mergeable: stringValue(payload.mergeable) } : {}),
      ...(stringValue(payload.url) ? { url: stringValue(payload.url) } : {}),
      ...(stringValue(payload.mergedAt) ? { mergedAt: stringValue(payload.mergedAt) } : {}),
      ...(stringValue(payload.headRef) ? { headRef: stringValue(payload.headRef) } : {}),
      ...(stringValue(payload.headSha) ? { headSha: stringValue(payload.headSha) } : {}),
      ...(stringValue(payload.baseRef) ? { baseRef: stringValue(payload.baseRef) } : {}),
      ...(stringValue(payload.baseSha) ? { baseSha: stringValue(payload.baseSha) } : {}),
    },
    remoteVersion: stringValue(payload.updatedAt),
  } as const;
}

export function githubConnectionEventService(
  db: Db,
  options: {
    connector?: PaperclipCloudConnector;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    wakeup?: NonNullable<Parameters<typeof issueThreadInteractionService>[1]>["wakeup"];
    assignmentWakeup?: IssueAssignmentWakeupDeps["wakeup"];
  } = {},
) {
  const now = options.now ?? (() => new Date());
  let nextPollAt = 0;
  let emptyPolls = 0;

  async function activeBindings() {
    const rows = await db.select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(toolConnections, and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ))
      .where(and(
        eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
      ));
    return bindingRows(rows);
  }

  async function applyCiCompletionEvent(companyId: string, event: LeasedEvent, database: Db = db) {
    if (event.event !== "workflow_run" && event.event !== "check_suite" && event.event !== "check_run") return;
    const payload = event.payload;
    const status = stringValue(payload.status) ?? (stringValue(payload.conclusion) ? "completed" : null);
    const conclusion = stringValue(payload.conclusion);
    if (!status || !["queued", "in_progress", "completed"].includes(status)) return;
    const repositoryValue = payload.repository;
    const repository = stringValue(repositoryValue) ?? stringValue(record(repositoryValue).full_name);
    const pullRequestNumber = positiveInteger(payload.pullRequestNumber) ?? positiveInteger(payload.number) ?? positiveInteger(payload.checkSuitePullRequestNumber);
    const headSha = commitSha(payload.headSha);
    const runId = identifier(payload.runId) ?? identifier(payload.checkSuiteId) ?? event.id;
    if (!repository || !pullRequestNumber || !headSha) return;

    const active = status === "queued" || status === "in_progress";
    if (!active && !conclusion) return;
    const currentTime = now();
    const products = await database.select().from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
      ));

    const matchingProduct = products.find((product) => {
      const metadata = record(product.metadata);
      const productRepository = stringValue(metadata.repository) ?? stringValue(metadata.repo);
      const productNumber = positiveInteger(metadata.number)
        ?? (product.externalId ? Number(product.externalId.match(/#pull\/(\d+)$/)?.[1]) : null);
      return productRepository?.toLowerCase() === repository.toLowerCase() && productNumber === pullRequestNumber;
    });

    if (!active && matchingProduct) {
      const metadata = record(matchingProduct.metadata);
      const lastCompleted = record(metadata.lastCompletedCi);
      if (lastCompleted && lastCompleted.headSha === headSha && lastCompleted.conclusion === conclusion) {
        return;
      }
    }

    for (const product of products) {
      const metadata = record(product.metadata);
      const productRepository = stringValue(metadata.repository) ?? stringValue(metadata.repo);
      const productNumber = positiveInteger(metadata.number)
        ?? (product.externalId ? Number(product.externalId.match(/#pull\/(\d+)$/)?.[1]) : null);
      if (productRepository?.toLowerCase() !== repository.toLowerCase() || productNumber !== pullRequestNumber) continue;
      await database.update(issueWorkProducts).set({
        metadata: {
          ...metadata,
          activeCi: active ? { repository, number: pullRequestNumber, headSha, runId, status, observedAt: currentTime.toISOString() } : null,
          ...(active ? { lastCompletedCi: null } : {
            lastCompletedCi: {
              repository,
              number: pullRequestNumber,
              headSha,
              conclusion,
              runId,
              completedAt: currentTime.toISOString(),
            },
          }),
        },
        updatedAt: currentTime,
      }).where(eq(issueWorkProducts.id, product.id));
    }

    if (!options.assignmentWakeup || !conclusion || active) return;

    const completionProducts = await database.select({ product: issueWorkProducts, issue: issues })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
      ));
    const matching = completionProducts.find(({ product }: { product: typeof issueWorkProducts.$inferSelect }) => {
      const metadata = record(product.metadata);
      const repo = stringValue(metadata.repo) ?? stringValue(metadata.repository);
      const number = positiveInteger(metadata.number)
        ?? (product.externalId ? Number(product.externalId.match(/#pull\/(\d+)$/)?.[1]) : null);
      return repo?.toLowerCase() === repository.toLowerCase() && number === pullRequestNumber;
    });
    if (!matching?.issue.assigneeAgentId) return;

    // A PR work product is the opt-in boundary: unrelated task types keep their
    // existing routing. Never let an old head failure undo a newer PR review.
    const metadata = record(matching.product.metadata);
    const expectedHead = commitSha(metadata.headSha) ?? commitSha(metadata.sha);
    let assigneeAgentId = matching.issue.assigneeAgentId;
    const htmlUrl = githubUrl(payload.htmlUrl);
    if (["failure", "timed_out", "action_required", "startup_failure"].includes(conclusion)
      && (!expectedHead || expectedHead === headSha)) {
      const publications: ActivityPublication[] = [];
      await db.transaction(async (tx) => {
        const [current] = await tx.select().from(issues).where(and(
          eq(issues.id, matching.issue.id), eq(issues.companyId, companyId),
        )).for("update");
        if (!current || current.status !== "in_review" || current.workMode !== "standard") return;
        const state = parseIssueExecutionState(current.executionState);
        if (state && (state.status !== "pending" || state.currentStageType !== "review")) return;
        const executor = state?.returnAssignee;
        if (executor && executor.type !== "agent") return;
        const executorId = executor?.agentId ?? current.assigneeAgentId;
        if (!executorId) return;
        assigneeAgentId = executorId;
        const reason = `CI ${conclusion}: ${repository}#${pullRequestNumber}, head ${headSha}, ${event.event} ${runId}${htmlUrl ? ` — ${htmlUrl}` : ""}`;
        await tx.update(issues).set({
          status: "in_progress",
          statusVersion: sql`${issues.statusVersion} + 1`,
          assigneeAgentId: executorId,
          assigneeUserId: null,
          ...(state ? { executionState: {
            ...state, status: "changes_requested", reviewRequest: null,
            lastDecisionOutcome: "changes_requested",
          } } : {}),
          updatedAt: now(),
        }).where(and(eq(issues.id, current.id), eq(issues.companyId, companyId)));
        await tx.insert(issueComments).values({
          companyId, issueId: current.id, authorType: "system", body: reason,
        });
        await logActivity(tx as unknown as Db, {
          companyId, actorType: "system", actorId: "system:github-ci",
          action: "issue.ci_failed", entityType: "issue", entityId: current.id,
          details: { previousStatus: "in_review", status: "in_progress", conclusion,
            repository, pullRequestNumber, headSha, runId, htmlUrl, deliveryId: event.id },
        }, publications);
      });
      for (const publication of publications) {
        try { publishActivity(publication); }
        catch (error) { logger.warn({ err: error, companyId }, "CI return activity publication failed after commit"); }
      }
    }

    if (matching.issue.monitorNextCheckAt) {
      await database.update(issues).set({
        monitorNextCheckAt: null,
        monitorWakeRequestedAt: null,
        monitorLastTriggeredAt: currentTime,
        executionPolicy: sql`jsonb_set(coalesce(${issues.executionPolicy}, '{}'::jsonb), '{monitor}', 'null'::jsonb)`,
        executionState: sql`case when ${issues.executionState} is not null then jsonb_set(${issues.executionState}, '{monitor,status}', '"cleared"'::jsonb) else null end`,
        updatedAt: currentTime,
      }).where(eq(issues.id, matching.issue.id));
    }

    const idempotencyKey = `ci_completed:${repository}:${pullRequestNumber}:${headSha}`;
    await options.assignmentWakeup(assigneeAgentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "ci_completed",
      payload: {
        issueId: matching.issue.id,
        repository,
        pullRequestNumber,
        headSha,
        conclusion,
        runId,
        htmlUrl,
        event: event.event,
        deliveryId: event.id,
      },
      idempotencyKey,
      requestedByActorType: "system",
      requestedByActorId: "system:github-ci",
      contextSnapshot: {
        issueId: matching.issue.id,
        source: "github_ci_completion",
        repository,
        pullRequestNumber,
        headSha,
        conclusion,
        runId,
      },
    });
  }

  async function applyPullRequestEvent(database: Db, companyId: string, event: LeasedEvent) {
    const snapshot = githubSnapshotUpdate(event.payload);
    if (!snapshot) return;
    const appliedAt = now();
    await database.update(externalObjects).set({
      statusKey: snapshot.statusKey,
      statusLabel: snapshot.statusLabel,
      statusCategory: snapshot.statusCategory,
      statusTone: snapshot.statusTone,
      statusIconKey: snapshot.statusIconKey,
      isTerminal: snapshot.merged || snapshot.state === "closed",
      data: sql`${externalObjects.data} || ${JSON.stringify(snapshot.data)}::jsonb`,
      remoteVersion: snapshot.remoteVersion,
      lastResolvedAt: appliedAt,
      lastChangedAt: appliedAt,
      nextRefreshAt: appliedAt,
      updatedAt: appliedAt,
    }).where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, "github"),
      eq(externalObjects.objectType, "pull_request"),
      sql`lower(${externalObjects.externalId}) = lower(${snapshot.externalId})`,
    ));
    await db.update(issueWorkProducts).set({ metadata: sql`(${issueWorkProducts.metadata} - 'activeCi') || ${JSON.stringify({ repository: snapshot.repository, number: snapshot.number, headSha: snapshot.data.headSha })}::jsonb`, updatedAt: appliedAt })
      .where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.type, "pull_request"), eq(issueWorkProducts.provider, "github"), eq(issueWorkProducts.externalId, snapshot.externalId)));
    if (snapshot.merged && event.action === "closed") {
      const products = await database.select({ product: issueWorkProducts, issue: issues })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.provider, "github"),
        ));
      const matching = products.find(({ product }) => {
        const metadata = record(product.metadata);
        const repository = stringValue(metadata.repository) ?? stringValue(metadata.repo);
        const externalId = product.externalId;
        const number = positiveInteger(metadata.number)
          ?? (externalId ? Number(externalId.match(/#pull\/(\d+)$/i)?.[1]) : NaN);
        return repository?.toLowerCase() === `${snapshot.owner}/${snapshot.repo}`.toLowerCase()
          && (number === snapshot.number || externalId?.toLowerCase() === snapshot.externalId.toLowerCase());
      });
      if (matching && matching.issue.status !== "done" && matching.issue.status !== "cancelled") {
        await database.update(issueWorkProducts).set({
          status: "merged",
          updatedAt: appliedAt,
        }).where(and(
          eq(issueWorkProducts.id, matching.product.id),
          eq(issueWorkProducts.companyId, companyId),
        ));
        await issueService(db).update(matching.issue.id, {
          status: "done",
          completedAt: now(),
          actorAgentId: null,
          actorUserId: null,
          companyGuard: companyId,
        }, database);
      }
      await issueThreadInteractionService(database, { wakeup: options.wakeup })
        .sweepMergedPullRequestConfirmations([{
          companyId,
          owner: snapshot.owner,
          repo: snapshot.repo,
          number: snapshot.number,
        }]);
    }

    const isConflicting = (
      stringValue(event.payload.mergeable) === "CONFLICTING" ||
      event.payload.mergeable === false ||
      stringValue(event.payload.mergeableState) === "CONFLICTING" ||
      stringValue(event.payload.mergeable_state) === "dirty" ||
      snapshot.data.mergeable === "CONFLICTING"
    );

    if (isConflicting && snapshot.state !== "closed" && !snapshot.merged) {
      const products = await database.select({ product: issueWorkProducts, issue: issues })
        .from(issueWorkProducts)
        .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          eq(issueWorkProducts.type, "pull_request"),
          eq(issueWorkProducts.provider, "github"),
        ));
      const matching = products.find(({ product }) => {
        const metadata = record(product.metadata);
        const repository = stringValue(metadata.repository) ?? stringValue(metadata.repo);
        const externalId = product.externalId;
        const number = positiveInteger(metadata.number)
          ?? (externalId ? Number(externalId.match(/#pull\/(\d+)$/i)?.[1]) : NaN);
        return repository?.toLowerCase() === `${snapshot.owner}/${snapshot.repo}`.toLowerCase()
          && (number === snapshot.number || externalId?.toLowerCase() === snapshot.externalId.toLowerCase());
      });

      if (matching) {
        let transitioned = false;
        let returnedAssigneeId: string | null = null;
        const publications: ActivityPublication[] = [];
        await database.transaction(async (tx) => {
          const [current] = await tx.select().from(issues).where(and(
            eq(issues.id, matching.issue.id), eq(issues.companyId, companyId),
          )).for("update");
          if (!current || current.status !== "in_review" || current.workMode !== "standard") return;
          const state = parseIssueExecutionState(current.executionState);
          if (state && (state.status !== "pending" || state.currentStageType !== "review")) return;
          const executor = state?.returnAssignee;
          if (executor && executor.type !== "agent") return;
          let executorId = executor?.agentId ?? null;
          if (!executorId && matching.product.createdByRunId) {
            const [run] = await tx.select({ agentId: heartbeatRuns.agentId })
              .from(heartbeatRuns)
              .where(eq(heartbeatRuns.id, matching.product.createdByRunId))
              .limit(1);
            if (run?.agentId) executorId = run.agentId;
          }
          if (!executorId) executorId = current.assigneeAgentId;
          if (!executorId) return;

          const commentBody = `PR ${snapshot.owner}/${snapshot.repo}#${snapshot.number}: merge conflict (mergeable=CONFLICTING), влей свежий main.`;
          await tx.update(issues).set({
            status: "in_progress",
            statusVersion: sql`${issues.statusVersion} + 1`,
            assigneeAgentId: executorId,
            assigneeUserId: null,
            ...(state ? { executionState: {
              ...state, status: "changes_requested", reviewRequest: null,
              lastDecisionOutcome: "changes_requested",
            } } : {}),
            updatedAt: appliedAt,
          }).where(and(eq(issues.id, current.id), eq(issues.companyId, companyId)));
          await tx.insert(issueComments).values({
            companyId, issueId: current.id, authorType: "system", body: commentBody,
          });
          await logActivity(tx as unknown as Db, {
            companyId, actorType: "system", actorId: "system:github-conflict",
            action: "issue.merge_conflict", entityType: "issue", entityId: current.id,
            details: { previousStatus: "in_review", status: "in_progress", mergeable: "CONFLICTING",
              repository: snapshot.repository, pullRequestNumber: snapshot.number, deliveryId: event.id },
          }, publications);
          transitioned = true;
          returnedAssigneeId = executorId;
        });
        if (transitioned) {
          for (const publication of publications) {
            try { publishActivity(publication); }
            catch (error) { logger.warn({ err: error, companyId }, "Conflict return activity publication failed after commit"); }
          }
          if (options.assignmentWakeup && returnedAssigneeId) {
            await options.assignmentWakeup(returnedAssigneeId, {
              source: "automation",
              triggerDetail: "system",
              reason: "pr_merge_conflict",
              payload: {
                issueId: matching.issue.id,
                repository: snapshot.repository,
                pullRequestNumber: snapshot.number,
                mergeable: "CONFLICTING",
                event: event.event,
                deliveryId: event.id,
              },
              idempotencyKey: `pr_merge_conflict:${snapshot.repository}#${snapshot.number}:${matching.issue.id}`,
              requestedByActorType: "system",
              requestedByActorId: "system:github-conflict",
              contextSnapshot: {
                issueId: matching.issue.id,
                source: "github_pr_conflict",
                repository: snapshot.repository,
                pullRequestNumber: snapshot.number,
              },
            });
          }
        }
      }
    }
  }

  async function applyInstallationEvent(database: Db, binding: GitHubBinding, event: LeasedEvent) {
    // Bindings are loaded before the Cloud request. Lock and read the grant
    // again so a refresh completed during that request cannot be overwritten.
    const [currentGrant] = await database.select().from(connectionGrants).where(and(
      eq(connectionGrants.id, binding.grantId),
      eq(connectionGrants.companyId, binding.companyId),
      eq(connectionGrants.status, "active"),
    )).for("update").limit(1);
    const currentProviderTenant = currentGrant?.providerTenant;
    const github = currentProviderTenant?.github;
    if (!github) return;
    // A newly bound instance can receive installation events from before OAuth
    // verified its repository list. Those events must not erase newer access.
    if (Date.parse(github.lastAccessRefreshAt ?? "") > Date.parse(event.createdAt)) {
      await database.update(connectionGrants).set({
        providerTenant: {
          ...currentProviderTenant,
          github: { ...github, lastWebhookAt: now().toISOString(), webhookHealth: "healthy" },
        },
        updatedAt: now(),
      }).where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, binding.companyId)));
      return;
    }
    const unavailable = event.event === "installation" && (event.action === "deleted" || event.action === "suspend");
    const installationIds = unavailable
      ? github.installationIds.filter((id) => id !== binding.installationId)
      : [...new Set([...github.installationIds, binding.installationId])];
    const added = Array.isArray(event.payload.repositoriesAdded) ? event.payload.repositoriesAdded.length : 0;
    const removed = Array.isArray(event.payload.repositoriesRemoved) ? event.payload.repositoriesRemoved.length : 0;
    const repositoryCount = Math.max(
      0,
      unavailable && installationIds.length === 0
        ? 0
        : unavailable
          ? github.repositoryCount
          : github.repositoryCount + added - removed,
    );
    const providerTenant = {
      ...currentProviderTenant,
      github: {
        ...github,
        // Lifecycle webhooks carry IDs, not the user token’s complete repository view.
        // Discard the snapshot until Refresh access verifies it again.
        accessRevision: randomUUID(),
        repositories: undefined,
        installationIds,
        installationCount: installationIds.length,
        repositoryCount,
        repositorySelection: repositoryCount === 0 ? "none" as const : github.repositorySelection,
        lastWebhookAt: now().toISOString(),
        webhookHealth: unavailable ? "unhealthy" as const : "healthy" as const,
      },
    };
    await database.update(connectionGrants).set({ providerTenant, updatedAt: now() })
      .where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, binding.companyId)));
    await database.update(toolConnections).set({
      healthStatus: unavailable ? "failed" : "ok",
      healthMessage: unavailable
        ? "GitHub installation access was removed or suspended. Manage repository access on GitHub."
        : "GitHub installation and repository access are available.",
      healthCheckedAt: now(),
      lastHealthAt: now(),
      lastError: unavailable ? "GitHub installation unavailable" : null,
      updatedAt: now(),
    }).where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, binding.companyId)));
  }

  async function processForCompany(companyId: string, bindings: GitHubBinding[], event: LeasedEvent) {
    const receiptAt = now();
    const normalizedEvent = { ...event, payload: normalizeLeasedPayload(event) };
    const [receipt] = await db.insert(connectionEventDeliveries).values({
      companyId,
      provider: event.provider,
      providerDeliveryId: event.id,
      event: event.event,
      action: event.action,
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      normalizedPayload: normalizedEvent.payload,
      providerCreatedAt: new Date(event.createdAt),
      status: "received",
      attempts: 1,
      updatedAt: receiptAt,
    }).onConflictDoNothing().returning();
    if (!receipt) {
      const [existing] = await db.select().from(connectionEventDeliveries).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      )).limit(1);
      if (existing?.status === "processed") return "duplicate" as const;
      await db.update(connectionEventDeliveries).set({
        status: "received",
        attempts: sql`${connectionEventDeliveries.attempts} + 1`,
        lastError: null,
        updatedAt: receiptAt,
      }).where(eq(connectionEventDeliveries.id, existing!.id));
    }
    const postCommitPublications: ActivityPublication[] = [];
    try {
      const applyAndFinalize = async (database: Db) => {
        if (event.event === "pull_request") await applyPullRequestEvent(database, companyId, normalizedEvent);
        await applyCiCompletionEvent(companyId, normalizedEvent, database);
        if (event.event === "installation" || event.event === "installation_repositories") {
          for (const binding of bindings) await applyInstallationEvent(database, binding, normalizedEvent);
        } else {
          const touchedAt = now();
          for (const binding of bindings) {
            const github = binding.providerTenant.github;
            if (!github) continue;
            await database.update(connectionGrants).set({
              // Update only webhook fields; a concurrent access/token refresh
              // owns the remaining metadata and must not be replaced here.
              providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{github}',
                (${connectionGrants.providerTenant}->'github') || ${JSON.stringify({
                  lastWebhookAt: touchedAt.toISOString(), webhookHealth: "healthy",
                })}::jsonb)`,
              updatedAt: touchedAt,
            }).where(and(
              eq(connectionGrants.id, binding.grantId),
              eq(connectionGrants.companyId, companyId),
              eq(connectionGrants.status, "active"),
              sql`${connectionGrants.providerTenant}->'github' is not null`,
            ));
          }
        }
        const finishedAt = now();
        await database.update(connectionEventDeliveries).set({
          status: "processed",
          processedAt: finishedAt,
          lastError: null,
          updatedAt: finishedAt,
        }).where(and(
          eq(connectionEventDeliveries.companyId, companyId),
          eq(connectionEventDeliveries.provider, event.provider),
          eq(connectionEventDeliveries.providerDeliveryId, event.id),
        ));
        await logActivity(database, {
          companyId,
          actorType: "system",
          actorId: "system:github-webhook",
          action: "tool_connection.webhook_processed",
          entityType: "tool_connection",
          entityId: bindings[0]!.connectionId,
          details: {
            provider: "github",
            event: event.event,
            action: event.action,
            deliveryId: event.id,
            installationId: event.installationId,
            repositoryId: event.repositoryId,
          },
        }, postCommitPublications);
      };
      if (event.event === "pull_request" || event.event === "workflow_run" || event.event === "check_suite" || event.event === "check_run" || event.event === "installation" || event.event === "installation_repositories") {
        await db.transaction(async (tx) => applyAndFinalize(tx as unknown as Db));
      } else {
        await applyAndFinalize(db);
      }
    } catch (error) {
      await db.update(connectionEventDeliveries).set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 500) : "GitHub event processing failed",
        updatedAt: now(),
      }).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      ));
      throw error;
    }
    // Persistence is complete at this point (and installation deltas have
    // committed). A synchronous live-event subscriber must not turn that
    // durable success back into a retryable receipt and replay the delta.
    for (const publication of postCommitPublications) {
      try {
        publishActivity(publication);
      } catch (error) {
        logger.warn({
          err: error,
          companyId,
          providerDeliveryId: event.id,
        }, "GitHub webhook activity publication failed after commit");
      }
    }
    return "processed" as const;
  }

  return {
    async pollOnce(): Promise<GitHubConnectionEventPollResult> {
      if (now().getTime() < nextPollAt) {
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const bindings = await activeBindings();
      if (bindings.length === 0) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const config = options.connector ? null : paperclipCloudConnectorConfigFromEnv(options.env);
      const connector = options.connector ?? (config ? createPaperclipCloudConnector({ config }) : null);
      if (!connector) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }

      const targetMap = new Map<string, { subject: string; companyId: string }>();
      for (const binding of bindings) {
        const key = `${binding.companyId}:${binding.subject}`;
        if (!targetMap.has(key)) {
          targetMap.set(key, { subject: binding.subject, companyId: binding.companyId });
        }
      }

      const totalResult: GitHubConnectionEventPollResult = {
        leased: 0,
        processed: 0,
        duplicate: 0,
        ignored: 0,
        failed: 0,
      };

      let anyLeased = false;

      for (const target of targetMap.values()) {
        let lease;
        try {
          lease = await connector.leaseEvents({ subject: target.subject, companyId: target.companyId });
        } catch {
          totalResult.failed += 1;
          continue;
        }
        if (!lease || !Array.isArray(lease.events) || lease.events.length === 0) {
          continue;
        }
        anyLeased = true;
        totalResult.leased += lease.events.length;
        const acknowledge: string[] = [];
        for (const event of lease.events) {
          const matched = bindings.filter((binding) => event.bindingIds.includes(binding.id));
          if (matched.length === 0) {
            totalResult.ignored += 1;
            acknowledge.push(event.id);
            continue;
          }
          try {
            const companies = new Map<string, GitHubBinding[]>();
            for (const binding of matched) companies.set(binding.companyId, [...(companies.get(binding.companyId) ?? []), binding]);
            for (const [companyId, companyBindings] of companies) {
              const status = await processForCompany(companyId, companyBindings, event);
              totalResult[status] += 1;
            }
            acknowledge.push(event.id);
            if (event.event === "installation" && (event.action === "deleted" || event.action === "suspend")) {
              await Promise.all(matched.map((binding) => connector.setWebhookBinding({
                subject: binding.subject,
                companyId: binding.companyId,
                id: binding.id,
                installationId: binding.installationId,
                connectionId: binding.connectionId,
                grantId: binding.grantId,
                active: false,
              })));
            }
          } catch {
            totalResult.failed += 1;
          }
        }
        if (acknowledge.length > 0) {
          try {
            await connector.acknowledgeEvents({
              subject: target.subject,
              companyId: target.companyId,
              leaseId: lease.leaseId,
              deliveryIds: acknowledge,
            });
          } catch {
            totalResult.failed += 1;
          }
        }
      }

      if (!anyLeased) {
        emptyPolls += 1;
        nextPollAt = now().getTime() + Math.min(5 * 60_000, 5_000 * (2 ** Math.min(emptyPolls, 6)));
      } else {
        emptyPolls = 0;
        nextPollAt = now().getTime() + 5_000;
      }

      return totalResult;
    },

    async sweepWatchdog(currentTime: Date = now()): Promise<GitHubEventsWatchdogResult> {
      const bindings = await activeBindings();
      const companyIds = Array.from(new Set(bindings.map((b) => b.companyId)));
      const rawThreshold = Number(process.env.MYRMIDON_GITHUB_EVENTS_MAX_SILENCE_MIN ?? process.env.PAPERCLIP_GITHUB_EVENTS_MAX_SILENCE_MIN);
      const thresholdMin = Number.isFinite(rawThreshold) && rawThreshold > 0 ? rawThreshold : 15;
      const staleThresholdMs = thresholdMin * 60 * 1000;

      const result: GitHubEventsWatchdogResult = {
        scannedCompanies: companyIds.length,
        activePrCount: 0,
        alarmsCreated: 0,
        alarmsResolved: 0,
      };

      for (const companyId of companyIds) {
        const activePrs = await db.select({
          product: issueWorkProducts,
          issue: issues,
        })
          .from(issueWorkProducts)
          .innerJoin(issues, eq(issues.id, issueWorkProducts.issueId))
          .where(and(
            eq(issueWorkProducts.companyId, companyId),
            eq(issueWorkProducts.type, "pull_request"),
            eq(issueWorkProducts.provider, "github"),
            inArray(issues.status, ["in_progress", "in_review"]),
          ));

        const nonClosedPrs = activePrs.filter(({ product }) => product.status !== "closed" && product.status !== "merged");
        result.activePrCount += nonClosedPrs.length;

        const alarmKey = `github-events-silence:${companyId}`;
        const existingAlarms = await db.select().from(issues).where(and(
          eq(issues.companyId, companyId),
          eq(issues.originKind, "github_events_silence"),
          eq(issues.originId, companyId),
        ));
        const existingAlarm = existingAlarms[0] ?? null;

        if (nonClosedPrs.length === 0) {
          if (existingAlarm && existingAlarm.status !== "done" && existingAlarm.status !== "cancelled") {
            await db.update(issues).set({
              status: "done",
              updatedAt: currentTime,
            }).where(eq(issues.id, existingAlarm.id));
            await db.insert(issueComments).values({
              companyId,
              issueId: existingAlarm.id,
              authorType: "system",
              body: "Все активные PR закрыты или влиты. Тревога по тишине событий GitHub снята.",
              createdAt: currentTime,
              updatedAt: currentTime,
            });
            result.alarmsResolved += 1;
          }
          continue;
        }

        const [lastActivity] = await db.select({ createdAt: activityLog.createdAt })
          .from(activityLog)
          .where(and(
            eq(activityLog.companyId, companyId),
            eq(activityLog.action, "tool_connection.webhook_processed"),
          ))
          .orderBy(desc(activityLog.createdAt))
          .limit(1);

        let lastEventAtMs: number | null = lastActivity?.createdAt ? new Date(lastActivity.createdAt).getTime() : null;

        for (const binding of bindings.filter((b) => b.companyId === companyId)) {
          const lastWebhookAt = binding.providerTenant?.github?.lastWebhookAt;
          if (lastWebhookAt) {
            const ms = new Date(lastWebhookAt).getTime();
            if (!Number.isNaN(ms) && (!lastEventAtMs || ms > lastEventAtMs)) {
              lastEventAtMs = ms;
            }
          }
        }

        const isSilent = !lastEventAtMs || (currentTime.getTime() - lastEventAtMs > staleThresholdMs);

        if (isSilent) {
          const silenceMin = lastEventAtMs
            ? Math.max(thresholdMin, Math.round((currentTime.getTime() - lastEventAtMs) / 60000))
            : thresholdMin;
          const description = [
            "## Тревога: события GitHub не поступают на доску",
            "",
            `- Активных PR в работе: ${nonClosedPrs.length}`,
            `- Последнее обработанное событие: ${lastEventAtMs ? new Date(lastEventAtMs).toISOString() : "никогда"} (${silenceMin} мин назад)`,
            `- Порог тишины: ${thresholdMin} мин`,
            "",
            "События GitHub необходимы для автоматического возврата задач при красном CI и обновления PR.",
            "",
            "### Что проверить:",
            "1. Статус webhook в GitHub App и облачного коннектора.",
            "2. Ответы leaseEvents коннектора и логи сервера.",
            "3. Значение webhookHealth в подключениях компании.",
            "",
            "_Сторож закроет эту задачу автоматически, когда события GitHub снова начнут обрабатываться доской._",
          ].join("\n");

          if (!existingAlarm) {
            await db.insert(issues).values({
              companyId,
              title: `1.6.6 P1 ALARM: события GitHub не поступают ${silenceMin} мин при открытых PR`,
              description,
              status: "todo",
              priority: "high",
              originKind: "github_events_silence",
              originId: companyId,
              createdAt: currentTime,
              updatedAt: currentTime,
            });
            result.alarmsCreated += 1;
          } else if (existingAlarm.status === "done" || existingAlarm.status === "cancelled") {
            await db.update(issues).set({
              status: "todo",
              description,
              updatedAt: currentTime,
            }).where(eq(issues.id, existingAlarm.id));
            await db.insert(issueComments).values({
              companyId,
              issueId: existingAlarm.id,
              authorType: "system",
              body: `Тревога возобновлена: события GitHub по-прежнему не поступают (${silenceMin} мин тишины при ${nonClosedPrs.length} активных PR).`,
              createdAt: currentTime,
              updatedAt: currentTime,
            });
            result.alarmsCreated += 1;
          }
        } else {
          if (existingAlarm && existingAlarm.status !== "done" && existingAlarm.status !== "cancelled") {
            await db.update(issues).set({
              status: "done",
              updatedAt: currentTime,
            }).where(eq(issues.id, existingAlarm.id));
            await db.insert(issueComments).values({
              companyId,
              issueId: existingAlarm.id,
              authorType: "system",
              body: `События GitHub снова поступают. Последнее событие: ${new Date(lastEventAtMs).toISOString()}. Тревога снята.`,
              createdAt: currentTime,
              updatedAt: currentTime,
            });
            result.alarmsResolved += 1;
          }
        }
      }

      return result;
    },
  };
}
