import { randomUUID } from "node:crypto";
import {
  activityLog,
  companies,
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
import { notifyBoardMergeTrigger } from "../myrmidon/review-routing/merge-trigger.js";
// myrmidon(EMPTY-RUNS-3): a CI delivery is handled by the final result of the head.
import {
  CI_INFRA_RETRY_NEEDED_ACTION,
  readReviewInfraCheckNames,
  readReviewReturnGuardEnabled,
} from "../myrmidon/review-return-guard/policy.js";
import {
  CI_FINAL_CHECK_SEEN_METADATA_KEY,
  CI_RETURN_HOLD_METADATA_KEY,
  CI_VERDICT_HANDLED_METADATA_KEY,
  buildCiReturnHoldNote,
  buildCiReturnNote,
  ciVerdictOfHead,
  classifyCiDelivery,
  decideCiFailureReturn,
  isCiVerdictConclusion,
  isFailedCiConclusion,
  readCiFinalOnlyEnabled,
  readCiReturnHoldMark,
  type CiReturnFactsResolver,
  type CiReturnHeadFacts,
  type CiReturnHoldMark,
  type CiReturnHoldReason,
} from "../myrmidon/review-return-guard/ci-failure-return.js";
import { isRepositoryAllowed } from "../myrmidon/github-shared-identity/settings.js";
import { listGitHubAppEntriesByAppId } from "../myrmidon/github-shared-identity/store.js";
import {
  extractPullRequestIssueIdentifier,
  pullRequestWorkProductData,
} from "../myrmidon/task-pr-sync/linking.js";
import { workProductService } from "./work-products.js";
import { lockObjectInTransaction, postgresErrorInfo, runTransactionWithRetry } from "./postgres-transaction-retry.js";

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

/** myrmidon(GITHUB-APP-WEBHOOK): what one App webhook delivery did, per matched company. */
export type GitHubAppWebhookIngestResult = {
  companies: number;
  processed: number;
  duplicate: number;
  ignored: number;
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
      title: boundedString(payload.title, 1_000),
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
    // myrmidon(EMPTY-RUNS-3): the name of one check (`check_run` only), so a
    // finished lane can be told from the final `CI result` of the head.
    const checkName = event.event === "check_run" ? boundedString(payload.checkName ?? checkRun.name ?? rawCheckRun.name, 200) : null;

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
      checkName,
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

function githubIdString(value: unknown): string | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? String(value) : identifier(value);
}

/**
 * myrmidon(GITHUB-APP-WEBHOOK): a raw GitHub webhook body -> the flat record
 * the Cloud connector leases (`normalizeLeasedPayload` is written for that
 * shape: string ids, `repository` as `owner/repo`, camelCase pull-request and
 * head fields). A raw body would be dropped by it, so the translation is done
 * once here and everything downstream is the unchanged connector path.
 */
export function connectorPayloadFromGitHubWebhook(
  eventName: string,
  raw: Record<string, unknown>,
): Record<string, unknown> {
  const repository = record(raw.repository);
  const sender = record(raw.sender);
  const base = {
    event: eventName,
    action: stringValue(raw.action),
    installationId: githubIdString(record(raw.installation).id),
    repositoryId: githubIdString(repository.id),
    repository: stringValue(repository.full_name),
    senderId: githubIdString(sender.id),
    senderLogin: stringValue(sender.login),
  };
  if (eventName === "pull_request") {
    const pullRequest = record(raw.pull_request);
    const head = record(pullRequest.head);
    const baseBranch = record(pullRequest.base);
    return compact({
      ...base,
      number: positiveInteger(raw.number) ?? positiveInteger(pullRequest.number),
      url: stringValue(pullRequest.html_url),
      state: stringValue(pullRequest.state),
      // GitHub computes `mergeable` lazily: null means "not known yet".
      mergeable: pullRequest.mergeable === false || pullRequest.mergeable_state === "dirty"
        ? "CONFLICTING"
        : pullRequest.mergeable === true
          ? "MERGEABLE"
          : null,
      merged: pullRequest.merged === true,
      mergedAt: stringValue(pullRequest.merged_at),
      updatedAt: stringValue(pullRequest.updated_at),
      title: stringValue(pullRequest.title),
      headRef: stringValue(head.ref),
      headSha: stringValue(head.sha),
      baseRef: stringValue(baseBranch.ref),
      baseSha: stringValue(baseBranch.sha),
    });
  }
  if (eventName === "check_run" || eventName === "check_suite" || eventName === "workflow_run") {
    const object = record(raw[eventName]);
    const pullRequests = Array.isArray(object.pull_requests) ? object.pull_requests : [];
    const pullRequestNumber = positiveInteger(record(pullRequests[0]).number);
    return compact({
      ...base,
      number: pullRequestNumber,
      pullRequestNumber,
      headSha: stringValue(object.head_sha),
      status: stringValue(object.status),
      conclusion: stringValue(object.conclusion),
      // A suite is identified by its own id; a run and a check carry theirs.
      runId: eventName === "check_suite" ? null : githubIdString(object.id),
      checkSuiteId: eventName === "check_suite"
        ? githubIdString(object.id)
        : githubIdString(object.check_suite_id ?? record(object.check_suite).id),
      htmlUrl: stringValue(object.html_url),
      // myrmidon(EMPTY-RUNS-3): a check has a name of its own; a suite has none
      // and the name of a workflow run is the workflow, not a check.
      checkName: eventName === "check_run" ? stringValue(object.name) : null,
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

/**
 * The key that serializes the deliveries of one pull request, or null when the
 * delivery names none (an installation event, a check run on no pull request).
 */
function githubPullRequestLockKey(companyId: string, payload: Record<string, unknown>): string | null {
  const repository = stringValue(payload.repository);
  const number = positiveInteger(payload.pullRequestNumber) ?? positiveInteger(payload.number);
  if (!repository || !number) return null;
  return `github-pr:${companyId}:${repository.toLowerCase()}#${number}`;
}

/**
 * myrmidon(EMPTY-RUNS-3): `metadata || patch` evaluated by Postgres on the row
 * as it is when the update gets the row lock, not an object put together from a
 * copy read earlier: two writers of different keys keep each other's keys. A
 * key with a null value is set to null, as the spread of an object did.
 */
function mergeWorkProductMetadata(patch: Record<string, unknown>) {
  return sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || ${JSON.stringify(patch)}::jsonb`;
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
      ...(stringValue(payload.title) ? { title: stringValue(payload.title) } : {}),
      ...(stringValue(payload.headRef) ? { headRef: stringValue(payload.headRef) } : {}),
      ...(stringValue(payload.headSha) ? { headSha: stringValue(payload.headSha) } : {}),
      ...(stringValue(payload.baseRef) ? { baseRef: stringValue(payload.baseRef) } : {}),
      ...(stringValue(payload.baseSha) ? { baseSha: stringValue(payload.baseSha) } : {}),
    },
    remoteVersion: stringValue(payload.updatedAt),
  } as const;
}

/**
 * myrmidon(OPE-12483): the bot opens PRs through the GitHub API with a branch
 * `bot/<KEY>` (see docker/bot-runtime/botd/lib/archive.js) and records no
 * work-product row on the board, so the done gate sees an unlinked task as
 * "no code" and closes it while the PR is still open. Extract the task key from
 * the PR's branch or title and persist the pull_request work product as part of
 * webhook application, so `task-pr-sync`, the done gate, and the review-routing
 * merge path all observe the delivery through the normal linked surface.
 */
export async function linkPullRequestToIssue(
  database: Db,
  companyId: string,
  snapshot: ReturnType<typeof githubSnapshotUpdate>,
): Promise<{ linked: boolean; issueId: string | null; workProductId: string | null }> {
  if (!snapshot) return { linked: false, issueId: null, workProductId: null };
  const existing = await database
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, companyId),
      eq(issueWorkProducts.type, "pull_request"),
      eq(issueWorkProducts.provider, "github"),
      sql`lower(${issueWorkProducts.externalId}) = lower(${snapshot.externalId})`,
    ))
    .limit(1);
  if (existing.length > 0) return { linked: true, issueId: null, workProductId: existing[0]!.id };

  const key = extractPullRequestIssueIdentifier({
    headRef: snapshot.data.headRef,
    title: snapshot.data.title ?? null,
  });
  if (!key) return { linked: false, issueId: null, workProductId: null };

  const [issueRow] = await database
    .select({ id: issues.id, identifier: issues.identifier })
    .from(issues)
    .where(and(eq(issues.companyId, companyId), eq(issues.identifier, key)))
    .limit(1);
  if (!issueRow) return { linked: false, issueId: null, workProductId: null };

  const created = await workProductService(database).createForIssue(issueRow.id, companyId, pullRequestWorkProductData({
    repository: snapshot.repository,
    number: snapshot.number,
    url: snapshot.data.url ?? null,
    title: snapshot.data.title ?? null,
    headRef: snapshot.data.headRef ?? null,
    headSha: snapshot.data.headSha ?? null,
    state: snapshot.state,
    merged: snapshot.merged,
  }));
  if (!created) return { linked: false, issueId: issueRow.id, workProductId: null };
  return { linked: true, issueId: issueRow.id, workProductId: created.id };
}

/**
 * myrmidon(EMPTY-RUNS-3): the check runs of a head are read from GitHub inside
 * the delivery of one webhook. A read that takes longer than this is treated
 * as unreadable.
 */
const CI_RETURN_FACTS_TIMEOUT_MS = 10_000;

export function githubConnectionEventService(
  db: Db,
  options: {
    connector?: PaperclipCloudConnector;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    wakeup?: NonNullable<Parameters<typeof issueThreadInteractionService>[1]>["wakeup"];
    assignmentWakeup?: IssueAssignmentWakeupDeps["wakeup"];
    /**
     * myrmidon(EMPTY-RUNS-3): reads the check runs of a pull request head. With
     * it a CI delivery is handled by the final result of the head
     * (`applyCiDeliveryByVerdict`); without it every completed delivery is
     * handled as a finished CI, as before.
     */
    resolveCiReturnFacts?: CiReturnFactsResolver;
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

  /**
   * myrmidon(EMPTY-RUNS-3): the wakes one delivery asked for. They are sent
   * after the transaction of the delivery commits: the admission of a wake
   * locks the task row (`select ... for update` in the wake's own transaction),
   * and the delivery has just written that very row — the return from review,
   * the disarmed monitor. Sent from inside the transaction, a real wake waits
   * for a lock its own caller holds until the caller ends, and the caller waits
   * for the wake. A failed wake is logged; the delivery itself is committed.
   */
  type DeliveryWakes = Array<() => Promise<unknown>>;

  async function sendOrDeferWake(afterCommit: DeliveryWakes | undefined, wake: () => Promise<unknown>) {
    if (afterCommit) afterCommit.push(wake);
    else await wake();
  }

  /**
   * myrmidon(EMPTY-RUNS-3): what must happen once, after the delivery commits —
   * the activity publications and the merge notice of the board. A delivery run
   * again after a rollback (40P01) clears the queue, so none of it is sent twice
   * and nothing is sent for a transaction that did not commit. A failure is
   * logged with its reason and does not stop the rest.
   */
  async function sendOrDeferAction(
    afterCommit: DeliveryWakes | undefined,
    companyId: string,
    what: string,
    action: () => unknown,
  ) {
    const run = async () => {
      try { await action(); }
      catch (error) { logger.warn({ err: error, companyId }, `${what} failed after commit`); }
    };
    if (afterCommit) afterCommit.push(run);
    else await run();
  }

  /** The interaction wake of the merged-PR sweep, deferred the same way. */
  function deferInteractionWakeup(afterCommit: DeliveryWakes | undefined): typeof options.wakeup {
    const send = options.wakeup;
    if (!send || !afterCommit) return send;
    const queue: DeliveryWakes = afterCommit;
    return async (agentId, wakeOptions) => {
      queue.push(() => send(agentId, wakeOptions));
    };
  }

  // ---------------------------------------------------------------------------
  // myrmidon(EMPTY-RUNS-3): a CI delivery handled by the final result of the
  // head. The decisions are pure (review-return-guard/ci-failure-return.ts);
  // what follows reads the rows, asks GitHub when it has to and writes.
  // ---------------------------------------------------------------------------

  /** The check runs of a head read from GitHub now; null when they cannot be read in time. */
  async function readHeadCheckRuns(
    resolveFacts: CiReturnFactsResolver,
    input: { companyId: string; repository: string; pullRequestNumber: number; headSha: string },
  ): Promise<CiReturnHeadFacts | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reason = "read_timeout";
    try {
      const facts = await Promise.race([
        resolveFacts(input),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), CI_RETURN_FACTS_TIMEOUT_MS);
        }),
      ]);
      if (facts && facts.state === "ok") return facts;
      if (facts) reason = facts.reason;
    } catch {
      reason = "read_failed";
    } finally {
      if (timer) clearTimeout(timer);
    }
    // A short code only: the reason of a failed read never carries a token.
    logger.info(
      { companyId: input.companyId, repository: input.repository, pullRequestNumber: input.pullRequestNumber, headSha: input.headSha, reason },
      "CI delivery: the check runs of the head could not be read",
    );
    return null;
  }

  /**
   * Returns a task from its pending review stage to the executor for a failed
   * CI of the head: the status, the stage decision, a system comment and the
   * `issue.ci_failed` row, all or nothing under the lock of the task. Answers
   * the executor, or null when the task is not in a pending review stage any
   * more.
   */
  async function returnTaskFromReviewForFailedCi(database: Db, afterCommit: DeliveryWakes | undefined, input: {
    companyId: string;
    issueId: string;
    event: LeasedEvent;
    repository: string;
    pullRequestNumber: number;
    headSha: string;
    runId: string;
    htmlUrl: string | null;
    conclusion: string;
    failedChecks: string[] | null;
    releasedHold: CiReturnHoldReason | null;
  }): Promise<string | null> {
    const { companyId, repository, pullRequestNumber, headSha, runId, htmlUrl, conclusion } = input;
    const note = input.failedChecks
      ? buildCiReturnNote({ failedChecks: input.failedChecks, releasedHold: input.releasedHold })
      : "";
    const returned: { executorId: string | null } = { executorId: null };
    const publications: ActivityPublication[] = [];
    // The transaction of the delivery (a savepoint inside it): a rollback and a
    // re-run of the delivery take the comment, the row and the return with them.
    await database.transaction(async (tx) => {
      const [current] = await tx.select().from(issues).where(and(
        eq(issues.id, input.issueId), eq(issues.companyId, companyId),
      )).for("update");
      if (!current || current.status !== "in_review" || current.workMode !== "standard") return;
      const state = parseIssueExecutionState(current.executionState);
      if (state && (state.status !== "pending" || state.currentStageType !== "review")) return;
      const executor = state?.returnAssignee;
      if (executor && executor.type !== "agent") return;
      const executorId = executor?.agentId ?? current.assigneeAgentId;
      if (!executorId) return;
      const reason = `CI ${conclusion}: ${repository}#${pullRequestNumber}, head ${headSha}, ${input.event.event} ${runId}${htmlUrl ? ` — ${htmlUrl}` : ""}${note}`;
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
          repository, pullRequestNumber, headSha, runId, htmlUrl, deliveryId: input.event.id,
          ...(input.failedChecks ? { failedChecks: input.failedChecks, releasedHold: input.releasedHold } : {}) },
      }, publications);
      returned.executorId = executorId;
    });
    for (const publication of publications) {
      await sendOrDeferAction(afterCommit, companyId, "CI return activity publication", () => publishActivity(publication));
    }
    return returned.executorId;
  }

  /**
   * The trace of a failed CI that did not return the task — once per head: the
   * mark on the pull request work product, a system note in the thread (it
   * wakes nobody) and the `ci_infra_retry_needed` row the reviewer's return
   * guard writes for the same situation.
   */
  async function recordCiReturnHold(
    database: Db,
    afterCommit: DeliveryWakes | undefined,
    companyId: string,
    target: { issueId: string; identifier: string | null; productId: string; pullRequestUrl: string | null },
    input: {
      reason: CiReturnHoldReason;
      failedChecks: string[];
      repository: string;
      pullRequestNumber: number;
      headSha: string;
      deliveryId: string;
    },
  ) {
    const heldAt = now();
    const mark: CiReturnHoldMark = {
      headSha: input.headSha,
      reason: input.reason,
      failedChecks: input.failedChecks,
      heldAt: heldAt.toISOString(),
    };
    await database.update(issueWorkProducts).set({
      metadata: sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || ${JSON.stringify({ [CI_RETURN_HOLD_METADATA_KEY]: mark })}::jsonb`,
      updatedAt: heldAt,
    }).where(and(eq(issueWorkProducts.id, target.productId), eq(issueWorkProducts.companyId, companyId)));
    const publications: ActivityPublication[] = [];
    await database.transaction(async (tx) => {
      await tx.insert(issueComments).values({
        companyId,
        issueId: target.issueId,
        authorType: "system",
        body: buildCiReturnHoldNote({ reason: input.reason, headSha: input.headSha, failedChecks: input.failedChecks }),
      });
      await logActivity(tx as unknown as Db, {
        companyId, actorType: "system", actorId: "system:github-ci",
        action: CI_INFRA_RETRY_NEEDED_ACTION, entityType: "issue", entityId: target.issueId,
        details: {
          issueId: target.issueId,
          identifier: target.identifier,
          headSha: input.headSha,
          reason: input.reason,
          failedChecks: input.failedChecks,
          pullRequestUrl: target.pullRequestUrl,
          repository: input.repository,
          pullRequestNumber: input.pullRequestNumber,
          source: "github_ci_completion",
          deliveryId: input.deliveryId,
        },
      }, publications);
    });
    for (const publication of publications) {
      await sendOrDeferAction(afterCommit, companyId, "CI hold activity publication", () => publishActivity(publication));
    }
  }

  /** Writes one key into the metadata of the given work product rows, or removes it (`value` undefined). */
  async function patchWorkProductMetadataKey(
    database: Db,
    companyId: string,
    productIds: string[],
    key: string,
    value: unknown,
  ) {
    if (productIds.length === 0) return;
    await database.update(issueWorkProducts).set({
      metadata: value === undefined
        ? sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) - ${key}::text`
        : sql`coalesce(${issueWorkProducts.metadata}, '{}'::jsonb) || ${JSON.stringify({ [key]: value })}::jsonb`,
      updatedAt: now(),
    }).where(and(inArray(issueWorkProducts.id, productIds), eq(issueWorkProducts.companyId, companyId)));
  }

  /**
   * myrmidon(EMPTY-RUNS-3): one CI delivery of a pull request, handled by the
   * final result of the head.
   *
   *   - a job that starts marks the CI of the head as running, unless the head
   *     already has its result (the re-run of a gate, an auxiliary workflow);
   *   - a job that ends changes nothing: the monitor of the task stays armed
   *     and nobody is woken. Only a held head is looked at again;
   *   - the final result of the current head — the finished `CI result` check,
   *     or, where a pull request has none, the moment GitHub shows every check
   *     finished — is recorded as `lastCompletedCi`, announces a possible
   *     merge when green, returns a task from review when red (unless the base
   *     branch is red or only infrastructure failed: the task is held), disarms
   *     the monitor and wakes the assignee, once per result.
   */
  async function applyCiDeliveryByVerdict(
    database: Db,
    companyId: string,
    event: LeasedEvent,
    delivery: {
      status: string;
      conclusion: string | null;
      active: boolean;
      repository: string;
      pullRequestNumber: number;
      headSha: string;
      runId: string;
    },
    resolveFacts: CiReturnFactsResolver,
    env: NodeJS.ProcessEnv,
    afterCommit: DeliveryWakes | undefined,
  ) {
    const { repository, pullRequestNumber, headSha, runId } = delivery;
    const payload = event.payload;
    const currentTime = now();
    const kind = classifyCiDelivery({ eventName: event.event, checkName: stringValue(payload.checkName) });
    const candidates = await database.select().from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, companyId),
        eq(issueWorkProducts.type, "pull_request"),
        eq(issueWorkProducts.provider, "github"),
      ));
    // Every row of this pull request, always in the same order: two deliveries
    // of one pull request then take the rows in the same order as well.
    const rows = candidates.filter((product) => {
      const metadata = record(product.metadata);
      const productRepository = stringValue(metadata.repository) ?? stringValue(metadata.repo);
      const productNumber = positiveInteger(metadata.number)
        ?? (product.externalId ? Number(product.externalId.match(/#pull\/(\d+)$/)?.[1]) : null);
      return productRepository?.toLowerCase() === repository.toLowerCase() && productNumber === pullRequestNumber;
    }).sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    const primary = rows[0];
    if (!primary) return;
    const rowIds = rows.map((row) => row.id);
    // The rows of the pull request are locked in one order (by id) before any is
    // written; the delivery's advisory lock keeps its own siblings out, this keeps
    // out the other writers of these rows (the review-return mark, task sync).
    await database.select({ id: issueWorkProducts.id }).from(issueWorkProducts)
      .where(inArray(issueWorkProducts.id, rowIds)).orderBy(issueWorkProducts.id).for("update");
    const finalCheckSeen = rows.some((row) => record(row.metadata)[CI_FINAL_CHECK_SEEN_METADATA_KEY] === true);

    if (delivery.active) {
      for (const row of rows) {
        const metadata = record(row.metadata);
        const recorded = record(metadata.lastCompletedCi);
        // A job that starts after the result of this head — the re-run of a
        // gate, an auxiliary workflow — does not reopen it; the final check does.
        if (kind !== "final_check" && recorded.final === true && recorded.headSha === headSha) continue;
        await database.update(issueWorkProducts).set({
          metadata: mergeWorkProductMetadata({
            activeCi: { repository, number: pullRequestNumber, headSha, runId, status: delivery.status, observedAt: currentTime.toISOString() },
            lastCompletedCi: null,
            ...(kind === "final_check" ? { [CI_FINAL_CHECK_SEEN_METADATA_KEY]: true } : {}),
          }),
          updatedAt: currentTime,
        }).where(eq(issueWorkProducts.id, row.id));
      }
      return;
    }

    const conclusion = delivery.conclusion;
    if (!conclusion) return;
    // A result of an older head decides nothing for the current one.
    const knownHeads = rows
      .map((row) => {
        const metadata = record(row.metadata);
        return commitSha(metadata.headSha) ?? commitSha(metadata.sha);
      })
      .filter((head): head is string => head !== null);
    if (knownHeads.length > 0 && !knownHeads.includes(headSha)) return;

    const hold = rows
      .map((row) => readCiReturnHoldMark(row.metadata))
      .find((mark) => mark !== null && mark.headSha === headSha) ?? null;
    const factsInput = { companyId, repository, pullRequestNumber, headSha };

    // The result of the head this delivery carries, if it carries one.
    let verdict: string | null = null;
    let facts: CiReturnHeadFacts | null = null;
    let markFinalCheckSeen = false;
    if (kind === "final_check") {
      markFinalCheckSeen = !finalCheckSeen;
      if (isCiVerdictConclusion(conclusion)) verdict = conclusion;
    } else if (kind === "whole_run" && !finalCheckSeen) {
      // No final check was ever delivered for this pull request: a repository
      // without the aggregate check, or the first run before the aggregate job
      // exists. GitHub says which, and whether every check has finished.
      facts = await readHeadCheckRuns(resolveFacts, factsInput);
      if (facts) {
        markFinalCheckSeen = facts.hasFinalCheck;
        // myrmidon(EMPTY-RUNS-3B): the fallback "every check has finished" is for
        // a head that has no `CI result` at all. A head that has one (finished,
        // running, skipped or cancelled in a partial run) is decided by that
        // check alone, whatever else GitHub shows finished.
        verdict = facts.hasFinalCheck
          ? (isCiVerdictConclusion(facts.finalCheckConclusion) ? facts.finalCheckConclusion : null)
          : ciVerdictOfHead(facts);
      }
    }

    if (verdict === null && !hold) {
      // One finished job, or a run that did not finish the CI: the task is left
      // alone — its monitor stays armed and nobody is woken.
      if (markFinalCheckSeen) {
        await patchWorkProductMetadataKey(database, companyId, rowIds, CI_FINAL_CHECK_SEEN_METADATA_KEY, true);
      }
      return;
    }

    const [issue] = await database
      .select({
        id: issues.id,
        identifier: issues.identifier,
        status: issues.status,
        workMode: issues.workMode,
        executionState: issues.executionState,
        assigneeAgentId: issues.assigneeAgentId,
        monitorNextCheckAt: issues.monitorNextCheckAt,
      })
      .from(issues)
      .where(and(eq(issues.id, primary.issueId), eq(issues.companyId, companyId)))
      .limit(1);
    const reviewStagePending = (() => {
      if (!issue || issue.status !== "in_review" || issue.workMode !== "standard") return false;
      const state = parseIssueExecutionState(issue.executionState);
      return !state || (state.status === "pending" && state.currentStageType === "review");
    })();
    const htmlUrl = githubUrl(payload.htmlUrl);
    // With the return guard switched off no check is infrastructure: every
    // failed final result returns the task.
    const infraCheckNames = readReviewReturnGuardEnabled(env) ? readReviewInfraCheckNames(env) : [];
    const assignmentWakeup = options.assignmentWakeup;

    /**
     * Disarms the monitor of the task and wakes `agentId` for the result of the
     * head. The result is news for a task that is being worked on or reviewed,
     * and for one whose agent armed a monitor for it; a parked task without a
     * monitor and a closed task are not woken.
     */
    const finishWithWake = async (agentId: string, wakeConclusion: string, releasedHold: boolean) => {
      if (!issue || !assignmentWakeup) return;
      const closed = issue.status === "done" || issue.status === "cancelled";
      const awaitsResult = issue.status === "in_progress" || issue.status === "in_review"
        || (issue.monitorNextCheckAt !== null && !closed);
      if (!awaitsResult) return;
      if (issue.monitorNextCheckAt) {
        await database.update(issues).set({
          monitorNextCheckAt: null,
          monitorWakeRequestedAt: null,
          monitorLastTriggeredAt: currentTime,
          executionPolicy: sql`jsonb_set(coalesce(${issues.executionPolicy}, '{}'::jsonb), '{monitor}', 'null'::jsonb)`,
          executionState: sql`case when ${issues.executionState} is not null then jsonb_set(${issues.executionState}, '{monitor,status}', '"cleared"'::jsonb) else null end`,
          updatedAt: currentTime,
        }).where(eq(issues.id, issue.id));
      }
      const issueId = issue.id;
      await sendOrDeferWake(afterCommit, () => assignmentWakeup(agentId, {
        source: "automation",
        triggerDetail: "system",
        reason: "ci_completed",
        payload: {
          issueId,
          repository,
          pullRequestNumber,
          headSha,
          conclusion: wakeConclusion,
          runId,
          htmlUrl,
          event: event.event,
          deliveryId: event.id,
        },
        idempotencyKey: `ci_completed:${repository}:${pullRequestNumber}:${headSha}${releasedHold ? ":hold-released" : ""}`,
        requestedByActorType: "system",
        requestedByActorId: "system:github-ci",
        contextSnapshot: {
          issueId,
          source: "github_ci_completion",
          repository,
          pullRequestNumber,
          headSha,
          conclusion: wakeConclusion,
          runId,
        },
      }));
    };

    if (verdict === null) {
      // Not the result of the head, but the head is held: it is looked at
      // again — the re-run of `main-green` is delivered as such a job.
      if (markFinalCheckSeen) {
        await patchWorkProductMetadataKey(database, companyId, rowIds, CI_FINAL_CHECK_SEEN_METADATA_KEY, true);
      }
      if (!hold || !issue || !assignmentWakeup || !reviewStagePending) return;
      const head = facts ?? await readHeadCheckRuns(resolveFacts, factsInput);
      if (!head) return;
      const decision = decideCiFailureReturn({ head, infraCheckNames });
      if (decision.action === "none") {
        await patchWorkProductMetadataKey(database, companyId, rowIds, CI_RETURN_HOLD_METADATA_KEY, undefined);
        return;
      }
      if (decision.action !== "return") return;
      const executorId = await returnTaskFromReviewForFailedCi(database, afterCommit, {
        companyId, issueId: issue.id, event, repository, pullRequestNumber, headSha, runId, htmlUrl,
        conclusion: "failure", failedChecks: decision.failedChecks, releasedHold: hold.reason,
      });
      if (!executorId) return;
      await patchWorkProductMetadataKey(database, companyId, rowIds, CI_RETURN_HOLD_METADATA_KEY, undefined);
      await finishWithWake(executorId, "failure", true);
      return;
    }

    // The final result of the current head. `final` tells a result recorded
    // here from the mark the old handling left for any finished job.
    const recorded = record(record(primary.metadata).lastCompletedCi);
    // myrmidon(EMPTY-RUNS-3B): the record above is cleared whenever a job of the
    // head starts (a partial run, the re-run of a gate), and the next delivery
    // of any kind then took the same result for a new one. The result a wake was
    // sent for is also kept apart (`ciVerdictHandled`) and survives that; it is
    // keyed by head and verdict only, so `check_run`, `check_suite` and
    // `workflow_run` of one result wake once. A failed verdict is not kept: a
    // red head returns the task each time it is delivered with the task in review.
    const handled = rows
      .map((row) => record(record(row.metadata)[CI_VERDICT_HANDLED_METADATA_KEY]))
      .find((mark) => mark.headSha === headSha && mark.conclusion === verdict) ?? null;
    const recordedRepeat = recorded.final === true && recorded.headSha === headSha && recorded.conclusion === verdict;
    const repeated = recordedRepeat || (!isFailedCiConclusion(verdict) && handled !== null);
    // The same result of the same head was handled already: nothing is written
    // and nobody is woken a second time. A held head is still looked at.
    // A result handled earlier whose record a started job cleared is written
    // back, so the head does not look like it is still running; nobody is woken.
    if (!recordedRepeat) {
      const seen = kind === "final_check" || markFinalCheckSeen;
      for (const row of rows) {
        await database.update(issueWorkProducts).set({
          metadata: mergeWorkProductMetadata({
            activeCi: null,
            lastCompletedCi: {
              repository,
              number: pullRequestNumber,
              headSha,
              conclusion: verdict,
              runId,
              completedAt: currentTime.toISOString(),
              final: true,
            },
            ...(seen ? { [CI_FINAL_CHECK_SEEN_METADATA_KEY]: true } : {}),
            // A failed result of the head ends the earlier green one: a later green
            // result after a re-run is news again.
            [CI_VERDICT_HANDLED_METADATA_KEY]: !isFailedCiConclusion(verdict)
              ? { headSha, conclusion: verdict, at: currentTime.toISOString() }
              : null,
          }),
          updatedAt: currentTime,
        }).where(eq(issueWorkProducts.id, row.id));
      }
      // myrmidon(OPE-11767): a green result may be the moment an approved pull
      // request becomes mergeable; the board's merge re-reads the checks itself.
      if (verdict === "success" && !repeated) {
        await sendOrDeferAction(afterCommit, companyId, "board merge notice", () =>
          notifyBoardMergeTrigger({ companyId, repository, number: pullRequestNumber, headSha, source: "ci_completed" }));
      }
    }
    if (repeated && !hold) return;
    if (!assignmentWakeup || !issue || !issue.assigneeAgentId) return;

    let wakeAgentId = issue.assigneeAgentId;
    let returned = false;
    if (!isFailedCiConclusion(verdict)) {
      // A head that is green needs no hold.
      if (hold) await patchWorkProductMetadataKey(database, companyId, rowIds, CI_RETURN_HOLD_METADATA_KEY, undefined);
    } else if (reviewStagePending) {
      const head = facts ?? await readHeadCheckRuns(resolveFacts, factsInput);
      const decision = head ? decideCiFailureReturn({ head, infraCheckNames }) : null;
      if (decision && decision.action === "hold") {
        if (!hold) {
          await recordCiReturnHold(database, afterCommit, companyId, {
            issueId: issue.id,
            identifier: issue.identifier ?? null,
            productId: primary.id,
            pullRequestUrl: primary.url ?? null,
          }, {
            reason: decision.reason,
            failedChecks: decision.failedChecks,
            repository,
            pullRequestNumber,
            headSha,
            deliveryId: event.id,
          });
        }
        // The task stays in review: its monitor stays armed, nobody is woken.
        return;
      }
      if (decision && decision.action === "none") {
        // GitHub shows nothing failed on the head any more: no return.
        if (hold) await patchWorkProductMetadataKey(database, companyId, rowIds, CI_RETURN_HOLD_METADATA_KEY, undefined);
      } else {
        // A real failure of the head. The same holds when the check runs
        // cannot be read, or GitHub has not caught up with the delivery of the
        // final check yet: the delivery itself is the result.
        const executorId = await returnTaskFromReviewForFailedCi(database, afterCommit, {
          companyId, issueId: issue.id, event, repository, pullRequestNumber, headSha, runId, htmlUrl,
          conclusion: verdict,
          failedChecks: decision && decision.action === "return" ? decision.failedChecks : null,
          releasedHold: hold ? hold.reason : null,
        });
        if (executorId) {
          wakeAgentId = executorId;
          returned = true;
          if (hold) await patchWorkProductMetadataKey(database, companyId, rowIds, CI_RETURN_HOLD_METADATA_KEY, undefined);
        }
      }
    }
    if (repeated && !returned) return;
    // myrmidon(EMPTY-RUNS-3B): the result of a task that is in review is news
    // for the participant of its pending review stage, not for whoever is the
    // assignee: another agent (or nobody, when the task has no stage) cannot
    // decide anything and the run it would start is empty.
    if (!returned && issue.status === "in_review") {
      const state = parseIssueExecutionState(issue.executionState);
      const participant = state?.status === "pending" && state.currentStageType === "review"
        ? state.currentParticipant
        : null;
      if (!participant || participant.type !== "agent" || !participant.agentId) return;
      wakeAgentId = participant.agentId;
    }
    await finishWithWake(wakeAgentId, verdict, returned && Boolean(hold));
  }

  async function applyCiCompletionEvent(companyId: string, event: LeasedEvent, database: Db = db, afterCommit?: DeliveryWakes) {
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
    // myrmidon(EMPTY-RUNS-3): with a reader of the check runs wired, one finished
    // job is not a finished CI — the delivery is handled by the final result of
    // the head. Without the reader, and with the handling switched off
    // (MYRMIDON_GITHUB_CI_FINAL_ONLY_ENABLED), everything below works as before.
    const guardEnv = options.env ?? process.env;
    if (options.resolveCiReturnFacts && readCiFinalOnlyEnabled(guardEnv)) {
      await applyCiDeliveryByVerdict(database, companyId, event, {
        status, conclusion, active, repository, pullRequestNumber, headSha, runId,
      }, options.resolveCiReturnFacts, guardEnv, afterCommit);
      return;
    }
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
        metadata: mergeWorkProductMetadata({
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
        }),
        updatedAt: currentTime,
      }).where(eq(issueWorkProducts.id, product.id));
    }

    // myrmidon(OPE-11767): a successful CI run may be the moment an approved
    // pull request becomes mergeable; the board's merge re-reads the required
    // checks itself, so this only announces where to look.
    if (!active && conclusion === "success") {
      await sendOrDeferAction(afterCommit, companyId, "board merge notice", () =>
        notifyBoardMergeTrigger({ companyId, repository, number: pullRequestNumber, headSha, source: "ci_completed" }));
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
      await database.transaction(async (tx) => {
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
        await sendOrDeferAction(afterCommit, companyId, "CI return activity publication", () => publishActivity(publication));
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
    // myrmidon(EMPTY-RUNS-3): sent after the delivery commits (see DeliveryWakes).
    const sendCiWake = options.assignmentWakeup;
    await sendOrDeferWake(afterCommit, () => sendCiWake(assigneeAgentId, {
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
    }));
  }

  async function applyPullRequestEvent(database: Db, companyId: string, event: LeasedEvent, afterCommit?: DeliveryWakes) {
    const snapshot = githubSnapshotUpdate(event.payload);
    if (!snapshot) return;
    // myrmidon(OPE-12483): bind bot-opened PRs (branch `bot/<KEY>` or the task
    // key in the title) to their task before any consumer reads work products;
    // an existing product short-circuits, so this is one cheap select per event.
    try {
      await linkPullRequestToIssue(database, companyId, snapshot);
    } catch (err) {
      logger.warn({ errorKind: "task_pr_link_failed", errorName: err instanceof Error ? err.name : typeof err, deliveryId: event.id }, "could not link a pull request to its task");
    }
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
      // myrmidon(EMPTY-RUNS-3): the wake is sent after the delivery commits (see DeliveryWakes).
      await issueThreadInteractionService(database, { wakeup: deferInteractionWakeup(afterCommit) })
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
            // myrmidon(EMPTY-RUNS-3): sent after the delivery commits (see DeliveryWakes).
            const sendConflictWake = options.assignmentWakeup;
            const conflictAssigneeId: string = returnedAssigneeId;
            await sendOrDeferWake(afterCommit, () => sendConflictWake(conflictAssigneeId, {
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
            }));
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

  // myrmidon(GITHUB-APP-WEBHOOK): `appId` is set only for deliveries that arrive
  // through our own GitHub App's webhook: such a delivery has no connector
  // binding to name as the activity entity.
  async function processForCompany(companyId: string, bindings: GitHubBinding[], event: LeasedEvent, appId?: string) {
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
    // myrmidon(EMPTY-RUNS-3): the wakes of this delivery, sent after it commits.
    const postCommitWakes: DeliveryWakes = [];
    try {
      const applyAndFinalize = async (database: Db) => {
        if (event.event === "pull_request") await applyPullRequestEvent(database, companyId, normalizedEvent, postCommitWakes);
        await applyCiCompletionEvent(companyId, normalizedEvent, database, postCommitWakes);
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
          entityId: bindings[0]?.connectionId ?? `github-app:${appId ?? "unknown"}`,
          details: {
            provider: "github",
            event: event.event,
            action: event.action,
            deliveryId: event.id,
            installationId: event.installationId,
            repositoryId: event.repositoryId,
            ...(appId ? { appId } : {}),
          },
        }, postCommitPublications);
      };
      if (event.event === "pull_request" || event.event === "workflow_run" || event.event === "check_suite" || event.event === "check_run" || event.event === "installation" || event.event === "installation_repositories") {
        // myrmidon(EMPTY-RUNS-3): deliveries of one pull request (a dozen jobs
        // finish within a second) used to take its work-product rows in their
        // own order and killed each other with `deadlock detected` (40P01),
        // the webhook answered 500 and the event was lost. They now run one
        // after another (advisory lock of the pull request, taken first), and
        // a transaction Postgres rolled back for a deadlock or a serialization
        // failure runs again, a bounded number of times, from a clean slate.
        const lockKey = githubPullRequestLockKey(companyId, normalizedEvent.payload);
        await runTransactionWithRetry(async () => {
          postCommitWakes.length = 0;
          postCommitPublications.length = 0;
          await db.transaction(async (tx) => {
            if (lockKey) await lockObjectInTransaction(tx, lockKey);
            await applyAndFinalize(tx as unknown as Db);
          });
        }, {
          onRetry: ({ attempt, error }) => {
            logger.warn({
              companyId,
              providerDeliveryId: event.id,
              attempt,
              pgCode: error.code,
              pgMessage: error.message,
            }, "GitHub delivery transaction rolled back by Postgres, running it again");
          },
        });
      } else {
        await applyAndFinalize(db);
      }
    } catch (error) {
      await db.update(connectionEventDeliveries).set({
        status: "failed",
        // The wrapper of the query builder says only "Failed query"; the
        // reason is the Postgres code and text behind it.
        lastError: (() => {
          const pg = postgresErrorInfo(error);
          if (pg) return `postgres ${pg.code}: ${pg.message}`.slice(0, 500);
          return error instanceof Error ? error.message.slice(0, 500) : "GitHub event processing failed";
        })(),
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
    // myrmidon(EMPTY-RUNS-3): the delivery is committed and holds no lock any
    // more: now its wakes can be admitted. A wake that fails is not a failure of
    // the delivery; only the kind of the error is logged, never its text.
    for (const wake of postCommitWakes) {
      try {
        await wake();
      } catch (error) {
        logger.warn({
          errorKind: "delivery_wake_failed",
          errorName: error instanceof Error ? error.name : typeof error,
          companyId,
          providerDeliveryId: event.id,
        }, "GitHub delivery wake failed after commit");
      }
    }
    return "processed" as const;
  }

  return {
    /**
     * myrmidon(GITHUB-APP-WEBHOOK): one delivery of our own GitHub App's
     * webhook (signature already verified by the route). The companies are the
     * ones whose App entry carries this App id and allows the delivery's
     * repository; each goes through the same `processForCompany` the connector
     * poll uses, with no bindings. A delivery that names no repository, or
     * that no company serves, is ignored and nothing is recorded.
     */
    async ingestAppWebhook(input: {
      appId: string;
      deliveryId: string;
      eventName: string;
      payload: Record<string, unknown>;
    }): Promise<GitHubAppWebhookIngestResult> {
      const result: GitHubAppWebhookIngestResult = { companies: 0, processed: 0, duplicate: 0, ignored: 0 };
      const repository = stringValue(record(input.payload.repository).full_name);
      const candidateIds = repository
        ? [...new Set(
            (await listGitHubAppEntriesByAppId(db, input.appId))
              .filter(({ entry }) => isRepositoryAllowed(entry.allowedRepos, repository))
              .map(({ companyId }) => companyId),
          )]
        : [];
      // The rules of a deleted company can outlive it; a receipt for it would
      // fail on the company key and fail the delivery for everybody else.
      const companyIds = candidateIds.length === 0
        ? []
        : (await db.select({ id: companies.id }).from(companies).where(inArray(companies.id, candidateIds))).map((row) => row.id);
      if (companyIds.length === 0) {
        result.ignored = 1;
        return result;
      }
      result.companies = companyIds.length;
      const event: LeasedEvent = {
        id: input.deliveryId,
        provider: "github",
        event: input.eventName,
        action: stringValue(input.payload.action),
        installationId: githubIdString(record(input.payload.installation).id),
        repositoryId: githubIdString(record(input.payload.repository).id),
        createdAt: now().toISOString(),
        payload: connectorPayloadFromGitHubWebhook(input.eventName, input.payload),
        bindingIds: [],
      };
      // One company failing must not keep the others from their delivery; the
      // failure is raised after all were tried, and a GitHub redelivery then
      // replays only what did not finish (processed receipts answer duplicate).
      let failure: unknown;
      for (const companyId of companyIds) {
        try {
          result[await processForCompany(companyId, [], event, input.appId)] += 1;
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure !== undefined) throw failure;
      return result;
    },

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
      const ciStaleThresholdMs = Math.max(staleThresholdMs, 30 * 60 * 1000);

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

        const [lastCiDelivery] = await db.select({ createdAt: connectionEventDeliveries.createdAt })
          .from(connectionEventDeliveries)
          .where(and(
            eq(connectionEventDeliveries.companyId, companyId),
            eq(connectionEventDeliveries.provider, "github"),
            inArray(connectionEventDeliveries.event, ["check_run", "check_suite", "workflow_run", "status"]),
          ))
          .orderBy(desc(connectionEventDeliveries.createdAt))
          .limit(1);

        const lastCiEventAtMs: number | null = lastCiDelivery?.createdAt
          ? new Date(lastCiDelivery.createdAt).getTime()
          : null;

        const isGeneralSilent = !lastEventAtMs || (currentTime.getTime() - lastEventAtMs > staleThresholdMs);
        const isCiSilent = !lastCiEventAtMs || (currentTime.getTime() - lastCiEventAtMs > ciStaleThresholdMs);
        const isSilent = isGeneralSilent || isCiSilent;

        if (isSilent) {
          const silenceMin = lastEventAtMs
            ? Math.max(thresholdMin, Math.round((currentTime.getTime() - lastEventAtMs) / 60000))
            : thresholdMin;
          const ciSilenceMin = lastCiEventAtMs
            ? Math.round((currentTime.getTime() - lastCiEventAtMs) / 60000)
            : null;
          const silenceReason = isGeneralSilent
            ? `события GitHub не поступают ${silenceMin} мин`
            : `события CI (check_run/workflow_run) не поступают ${ciSilenceMin ?? "∞"} мин`;
          const description = [
            `## Тревога: ${silenceReason} на доску`,
            "",
            `- Активных PR в работе: ${nonClosedPrs.length}`,
            `- Последнее общее событие: ${lastEventAtMs ? new Date(lastEventAtMs).toISOString() : "никогда"} (${silenceMin} мин назад)`,
            `- Последнее событие CI: ${lastCiEventAtMs ? new Date(lastCiEventAtMs).toISOString() : "никогда"} (${ciSilenceMin !== null ? `${ciSilenceMin} мин назад` : "события CI отсутствуют"})`,
            `- Порог тишины общих событий: ${thresholdMin} мин`,
            `- Порог тишины событий CI: ${Math.round(ciStaleThresholdMs / 60000)} мин`,
            "",
            "События GitHub CI необходимы для автоматического снятия гейта Review CI wait и возврата задач инженерам при сбоях.",
            "",
            "### Что проверить:",
            "1. Подписку GitHub App на события check_run, check_suite, workflow_run, status.",
            "2. Статус webhook в GitHub App и облачного коннектора.",
            "3. Ответы leaseEvents коннектора и логи сервера.",
            "4. Значение webhookHealth в подключениях компании.",
            "",
            "_Сторож закроет эту задачу автоматически, когда события GitHub и CI снова начнут обрабатываться доской._",
          ].join("\n");

          if (!existingAlarm) {
            // The alarm is a first-class task: mint the company issue number and
            // identifier exactly like every other creation path, so the alarm is
            // addressable by its OPE-N key (github-events-silence watchdog).
            await db.transaction(async (tx) => {
              const [maxRow] = await tx
                .select({ maxNum: sql<number>`coalesce(max(${issues.issueNumber}), 0)` })
                .from(issues)
                .where(eq(issues.companyId, companyId));
              const [company] = await tx
                .update(companies)
                .set({
                  issueCounter: sql`greatest(${companies.issueCounter}, ${maxRow.maxNum}) + 1`,
                })
                .where(eq(companies.id, companyId))
                .returning({
                  issueCounter: companies.issueCounter,
                  issuePrefix: companies.issuePrefix,
                });
              await tx.insert(issues).values({
                companyId,
                title: `1.6.6 P1 ALARM: ${silenceReason} при открытых PR`,
                description,
                status: "todo",
                priority: "high",
                originKind: "github_events_silence",
                originId: companyId,
                issueNumber: company.issueCounter,
                identifier: `${company.issuePrefix}-${company.issueCounter}`,
                createdAt: currentTime,
                updatedAt: currentTime,
              });
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
              body: `Тревога возобновлена: ${silenceReason} при ${nonClosedPrs.length} активных PR.`,
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
              body: `События GitHub и CI снова поступают. Последнее общее событие: ${lastEventAtMs ? new Date(lastEventAtMs).toISOString() : "неизвестно"}, последнее событие CI: ${lastCiEventAtMs ? new Date(lastCiEventAtMs).toISOString() : "неизвестно"}. Тревога снята.`,
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
