import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, notInArray, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  approvals,
  assets,
  companies,
  decisionBundles,
  decisionQueueItems,
  decisionQueues,
  decisionTrainingExamples,
  decisionTriage,
  decisions,
  heartbeatRuns,
  instanceSettings,
  inboxDismissals,
  invites,
  issueApprovals,
  issueAttachments,
  issueDocuments,
  issueRecoveryActions,
  issueRelations,
  issueThreadInteractions,
  issues,
  joinRequests,
  documents,
  projects,
  projectWorkspaces,
} from "@paperclipai/db";
import { deriveProjectUrlKey } from "@paperclipai/shared";
import type {
  AttentionDecisionVerb,
  AttentionFeed,
  AttentionFeedQuery,
  AttentionDetailImage,
  AttentionItem,
  AttentionItemDetail,
  AttentionProjectRef,
  AttentionQueueRef,
  AttentionResolverAudience,
  AttentionSeverity,
  AttentionSortMode,
  AttentionSourceKind,
  AttentionSubject,
  AttentionTriageAttribution,
  AttentionWorkspaceRef,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionResolverPolicyProvenance,
  IssueReviewPolicy,
} from "@paperclipai/shared";
import { badRequest } from "../errors.js";
import { listAttentionExhaustedRuns } from "./attention-exhausted-runs.js";
import { budgetService } from "./budgets.js";
import {
  BLOCKER_ATTENTION_MAX_DEPTH,
  BLOCKER_ATTENTION_MAX_NODES,
  issueService,
} from "./issues.js";
import { executionIssueCondition } from "./issue-visibility.js";
import { parseIssueExecutionState } from "./issue-execution-policy.js";
import { isProspectiveBlockedTransition } from "./routable-blocked.js";
import { evaluateAgentInvokability, type AgentOrgRow } from "./agent-invokability.js";
import { canonicalizeStoredResolverPolicy } from "./issue-thread-interaction-resolution.js";
import { decisionQueueService } from "./decision-queues.js";
// myrmidon(AUTO-RESUME): escalates the agent error card after the board gave up resuming
import { readAutoResumeAttentionState } from "../myrmidon/auto-resume.js";
// myrmidon(SUB): upstream stack releases surface in the attention feed
import { buildStackAttentionCards } from "../myrmidon/stack-registry/attention.js";
import { readStackDocument } from "../myrmidon/stack-registry/store.js";
// myrmidon(TRACING-HEALTH): the "LLM tracing" red state raises one operator card (part D)
import { readTracingHealthAttentionSignal } from "../myrmidon/tracing-health/attention.js";
// myrmidon(BOT-RUNTIME-TUNING D): the model fallback share raises one card per agent
import { readModelFallbackSignals } from "../myrmidon/litellm-fallback-signal/attention.js";

// myrmidon(STALE-BLOCK): the lifted-block operator signal registry.
import {
  readStaleBlockSignals,
  staleBlockSignalDedupKey,
  staleBlockSignalSeverity,
  staleBlockSignalWhyNow,
} from "../myrmidon/stale-block/attention.js";
// myrmidon(1.6.1-WIP-LIMIT-A): the WIP limit cards and the settings read.
import { buildWipLimitAttentionCards } from "../myrmidon/wip-limit/attention.js";
import { buildWipLimitStatus } from "../myrmidon/wip-limit/status.js";
import {
  WIP_LIMIT_SETTINGS_KEY,
  normalizeWipLimitSettings,
} from "@paperclipai/shared";

/**
 * myrmidon(TRACING-HEALTH): a stable UUID for the synthetic "LLM tracing"
 * subject. The attention enrichment joins subject ids against uuid columns
 * (agents.id), so a readable string id breaks the feed query; a deterministic
 * uuid-shaped id (zero-prefixed, hex-safe derivation of the company id)
 * keeps the card joinable, unique per company and stable across reads.
 */
function tracingHealthSubjectId(companyId: string): string {
  const hex = companyId.replaceAll("-", "").replaceAll(/[^0-9a-f]/gi, "0").padEnd(24, "0").slice(0, 24);
  const body = `00000000${hex}`.padEnd(32, "0").slice(0, 32);
  return `${body.slice(0, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}-${body.slice(16, 20)}-${body.slice(20, 32)}`;
}
import {
  decisionRetentionService,
  DEFAULT_DECISION_SHELF_DAYS,
} from "./decision-retention.js";

const ATTENTION_SOURCE_KINDS: AttentionSourceKind[] = [
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  "productivity_review",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
  "stack_update",
  "model_fallback_alert",
  // myrmidon(STALE-BLOCK): one card per block the watchdog lifted.
  "stale_block",
  // myrmidon(1.6.1-WIP-LIMIT-A): the per-agent work-in-progress over-limit signal.
  "wip_limit",
  // myrmidon(OPE-4021): bot disk lifecycle events
  "bot_disk_lifecycle",
];

const SEVERITY_RANK: Record<AttentionSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

const SOURCE_RANK: Record<AttentionSourceKind, number> = {
  failed_run: 0,
  recovery_action: 1,
  blocker_attention: 2,
  budget_alert: 3,
  agent_error_alert: 4,
  approval: 5,
  decision: 6,
  issue_thread_interaction: 7,
  review: 8,
  productivity_review: 9,
  join_request: 10,
  stack_update: 11,
  stale_block: 12,
  model_fallback_alert: 13,
  // myrmidon(1.6.1-WIP-LIMIT-A): a workload-oversignal sits below every
  // blocking kind but above nothing else — it is advice, not a stop.
  wip_limit: 14,
  // myrmidon(OPE-4021): bot disk lifecycle events
  bot_disk_lifecycle: 15,
};

const PENDING_INTERACTION_STATUSES = ["pending"] as const;
const OPEN_RECOVERY_STATUSES = ["active", "escalated"] as const;
const HUMAN_RECOVERY_OWNER_TYPES = ["user", "board"] as const;
const DETAIL_EXCERPT_LENGTH = 160;
const DETAIL_IMAGE_LIMIT = 3;
const OPEN_DECISION_DEFAULT_LIMIT = 500;
const OPEN_DECISION_MAX_LIMIT = 1_000;
const ATTENTION_PAGE_DEFAULT_LIMIT = 50;
const ATTENTION_PAGE_MAX_LIMIT = 100;
const ATTENTION_GRAPH_QUERY_CHUNK_SIZE = 500;

function chunkValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}

type IssueSummaryRow = {
  id: string;
  companyId: string;
  identifier: string | null;
  title: string;
  status: string;
  priority: string;
  /** Who may give the `in_review` verdict; `null`/absent ≡ "anyone" (PAP-16506). */
  reviewPolicy?: IssueReviewPolicy | null;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
};

type IssueSubjectRow = Omit<IssueSubjectRow, "project" | "workspace">;

type DismissalState = {
  kind: "dismiss" | "snooze";
  dismissedAt: Date;
  snoozedUntil: Date | null;
};

type PlanDocumentSummary = {
  title: string | null;
  body: string;
};

type BlockingIssueSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
};

type AttentionListOptions = AttentionFeedQuery & {
  userId?: string | null;
  /** Internal-only escape hatch for callers that need one stable, unpaginated feed snapshot. */
  allowUnscopedAll?: boolean;
};

type AttentionServiceOptions = {
  openDecisionLimit?: number;
  now?: () => number;
};

function emptyCounts(): Record<AttentionSourceKind, number> {
  return Object.fromEntries(ATTENTION_SOURCE_KINDS.map((kind) => [kind, 0])) as Record<AttentionSourceKind, number>;
}

function toIso(value: Date | string | null | undefined): string {
  if (!value) return new Date(0).toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function timestamp(value: Date | string | null | undefined): number {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function activeDismissalState(
  dismissalByKey: ReadonlyMap<string, DismissalState>,
  dismissalKey: string,
  activityAt: string,
  now: number,
) {
  const dismissal = dismissalByKey.get(dismissalKey);
  if (!dismissal) return null;

  const dismissedAt = toIso(dismissal.dismissedAt);
  const snoozedUntil = dismissal.snoozedUntil ? toIso(dismissal.snoozedUntil) : null;
  const isActive = dismissal.kind === "snooze"
    ? dismissal.snoozedUntil != null && timestamp(dismissal.snoozedUntil) > now
    : timestamp(dismissal.dismissedAt) >= timestamp(activityAt);

  return {
    kind: dismissal.kind,
    dismissedAt,
    snoozedUntil,
    isActive,
  };
}

function stripMarkdown(value: string) {
  return value
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[>*_~#-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function excerpt(value: unknown, maxLength = DETAIL_EXCERPT_LENGTH) {
  if (typeof value !== "string") return null;
  const cleaned = stripMarkdown(value);
  if (!cleaned) return null;
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isPlanDocumentTarget(payload: Record<string, unknown>) {
  const target = readRecord(payload.target);
  return target.type === "issue_document" && target.key === "plan";
}

function issueContext(issue: IssueSummaryRow | IssueSubjectRow | null | undefined) {
  const summary = issue && "project" in issue ? issue : null;
  return {
    project: summary?.project ?? null,
    workspace: summary?.workspace ?? null,
  };
}

function issueImages(imageMap: ReadonlyMap<string, AttentionDetailImage[]>, issueId: string | null | undefined) {
  return issueId ? imageMap.get(issueId) ?? [] : [];
}

function genericDetail(summary: unknown, images: AttentionDetailImage[]): AttentionItemDetail {
  return { kind: "generic", summaryExcerpt: excerpt(summary), images };
}

function approvalDetail(type: string, payload: Record<string, unknown>): AttentionItemDetail {
  return {
    kind: "approval",
    approvalType: type,
    summaryExcerpt: excerpt(payload.summary ?? payload.title ?? payload.recommendedAction),
    images: [],
  };
}

function interactionDetail(input: {
  kind: string;
  payload: Record<string, unknown>;
  issue: IssueSummaryRow | null;
  planDocument: PlanDocumentSummary | null;
  images: AttentionDetailImage[];
}): AttentionItemDetail {
  if (input.kind === "request_confirmation" && isPlanDocumentTarget(input.payload)) {
    return {
      kind: "plan_approval",
      issueTitle: input.issue?.title ?? null,
      planTitle: input.planDocument?.title ?? "Plan",
      summaryExcerpt: excerpt(input.planDocument?.body ?? input.payload.detailsMarkdown ?? input.payload.prompt),
      images: input.images,
    };
  }

  if (input.kind === "ask_user_questions") {
    const questions = readArray(input.payload.questions).map(readRecord);
    return {
      kind: "questions",
      questionCount: questions.length,
      firstQuestionText: readString(questions[0]?.prompt),
      images: input.images,
    };
  }

  if (input.kind === "suggest_tasks") {
    const tasks = readArray(input.payload.tasks).map(readRecord);
    return {
      kind: "suggested_tasks",
      taskCount: tasks.length,
      firstTaskTitle: readString(tasks[0]?.title),
      images: input.images,
    };
  }

  if (input.kind === "request_checkbox_confirmation") {
    return {
      kind: "checkbox_confirmation",
      optionCount: readArray(input.payload.options).length,
      promptExcerpt: excerpt(input.payload.prompt),
      images: input.images,
    };
  }

  if (input.kind === "request_item_verdicts") {
    return {
      kind: "item_verdicts",
      itemCount: readArray(input.payload.items).length,
      promptExcerpt: excerpt(input.payload.prompt),
      images: input.images,
    };
  }

  return {
    kind: "confirmation",
    promptExcerpt: excerpt(input.payload.prompt ?? input.payload.detailsMarkdown),
    isPlanTarget: false,
    images: input.images,
  };
}

function issueHref(prefix: string, issue: Pick<IssueSubjectRow, "id" | "identifier">) {
  return `/${prefix}/issues/${issue.identifier ?? issue.id}`;
}

function issueSubject(prefix: string, issue: IssueSubjectRow): AttentionSubject {
  return {
    kind: "issue",
    id: issue.id,
    companyId: issue.companyId,
    title: issue.title,
    identifier: issue.identifier,
    status: issue.status,
    href: issueHref(prefix, issue),
    metadata: {
      priority: issue.priority,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      // Only present when the row was selected with the column, so subjects
      // built from narrower selects do not claim a policy they never read.
      ...(issue.reviewPolicy !== undefined ? { reviewPolicy: issue.reviewPolicy } : {}),
    },
  };
}

function itemId(sourceKind: AttentionSourceKind, dedupKey: string) {
  return `${sourceKind}:${dedupKey}`;
}

function decisionVerbs(...verbs: AttentionDecisionVerb[]): AttentionDecisionVerb[] {
  return verbs;
}

type CreateAttentionItemInput = Omit<AttentionItem,
  | "id"
  | "dismissalKey"
  | "rank"
  | "dismissal"
  | "project"
  | "workspace"
  | "expiresAt"
  | "ruleKey"
  | "originAgentName"
  | "queues"
  | "shelf"
  | "retentionDays"
  | "keep"
  | "archivedAt"
  | "retentionVersion"
  | "decideBy"
  | "decideByAttribution"
  | "snoozedUntil"
  | "detail"
  | "trainingExampleId"
> & {
  project?: AttentionProjectRef | null;
  workspace?: AttentionWorkspaceRef | null;
  expiresAt?: string | null;
  ruleKey?: string | null;
  originAgentName?: string | null;
  detail?: AttentionItemDetail | null;
};

function createItem(input: CreateAttentionItemInput): AttentionItem {
  return {
    ...input,
    id: itemId(input.sourceKind, input.dedupKey),
    dismissalKey: `attention:${input.dedupKey}`,
    dismissal: null,
    project: input.project ?? null,
    workspace: input.workspace ?? null,
    expiresAt: input.expiresAt ?? null,
    ruleKey: input.ruleKey ?? null,
    originAgentName: input.originAgentName ?? null,
    queues: [],
    shelf: false,
    retentionDays: DEFAULT_DECISION_SHELF_DAYS,
    keep: false,
    archivedAt: null,
    retentionVersion: 0,
    decideBy: null,
    decideByAttribution: null,
    snoozedUntil: null,
    detail: input.detail ?? null,
    trainingExampleId: null,
    resolverAudience: input.resolverAudience ?? null,
    rank: 0,
  };
}

function compareAttentionItems(left: AttentionItem, right: AttentionItem) {
  const timeDiff = timestamp(right.activityAt) - timestamp(left.activityAt);
  if (timeDiff !== 0) return timeDiff;
  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  const sourceDiff = SOURCE_RANK[left.sourceKind] - SOURCE_RANK[right.sourceKind];
  if (sourceDiff !== 0) return sourceDiff;
  return left.dedupKey.localeCompare(right.dedupKey);
}

function blockedTaskCount(item: AttentionItem) {
  return item.sourceKind === "blocker_attention"
    && item.detail?.kind === "blocker"
    && typeof item.detail.blockedTaskCount === "number"
    ? item.detail.blockedTaskCount
    : null;
}

/** Preserve the selected desk sort for every row slot while ordering blocker
 * rows by the amount of work they hold up. */
function orderBlockedAttentionByWeight(
  items: AttentionItem[],
  fallback: (left: AttentionItem, right: AttentionItem) => number,
) {
  const blockers = items
    .filter((item) => blockedTaskCount(item) !== null)
    .sort((left, right) => {
      const weightDiff = (blockedTaskCount(right) ?? 0) - (blockedTaskCount(left) ?? 0);
      return weightDiff !== 0 ? weightDiff : fallback(left, right);
    });
  if (blockers.length < 2) return items;

  let blockerIndex = 0;
  return items.map((item) => blockedTaskCount(item) === null ? item : blockers[blockerIndex++]!);
}

function sourceKey(sourceKind: AttentionSourceKind, sourceId: string) {
  return `${sourceKind}:${sourceId}`;
}

function itemSourceKey(item: AttentionItem) {
  return sourceKey(item.sourceKind, item.subject.id);
}

function readMetadataAgentId(item: AttentionItem) {
  const metadata = item.subject.metadata;
  const value = metadata?.originAgentId ?? metadata?.createdByAgentId ?? metadata?.requestedByAgentId
    ?? metadata?.agentId ?? (item.subject.kind === "agent" ? item.subject.id : null);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function startOfUtcDay(now: number) {
  const value = new Date(now);
  return Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate());
}

function endOfUtcDay(now: number) {
  return startOfUtcDay(now) + 24 * 60 * 60 * 1_000 - 1;
}

function endOfUtcWeek(now: number) {
  const start = startOfUtcDay(now);
  const weekday = new Date(start).getUTCDay();
  // Use an ISO-style Monday-Sunday week. Sunday (0) is already the last
  // day of the current week; every other day advances only to that Sunday.
  const daysUntilSunday = weekday === 0 ? 0 : 7 - weekday;
  return start + (daysUntilSunday + 1) * 24 * 60 * 60 * 1_000 - 1;
}

function decideOrder(item: AttentionItem, now: number): [number, number] {
  if (item.decideBy === "today") return [0, endOfUtcDay(now)];
  if (item.decideBy === "this_week") return [0, endOfUtcWeek(now)];
  if (item.decideBy && /^\d{4}-\d{2}-\d{2}$/.test(item.decideBy)) {
    const deadline = Date.parse(`${item.decideBy}T23:59:59.999Z`);
    if (Number.isFinite(deadline)) return [0, deadline];
  }
  if (item.decideBy === "whenever") return [1, Number.MAX_SAFE_INTEGER];
  return [2, Number.MAX_SAFE_INTEGER];
}

function isDecideNow(item: AttentionItem, now: number) {
  const [bucket, deadline] = decideOrder(item, now);
  return bucket === 0 && deadline <= endOfUtcDay(now);
}

/** Surfaced today (arrival). Mirrors `attentionIsNewToday` in `ui/src/lib/attention.ts`. */
function isNewToday(item: AttentionItem, now: number) {
  const ts = timestamp(item.createdAt);
  return ts > 0 && ts >= startOfUtcDay(now);
}

function compareDecideItems(left: AttentionItem, right: AttentionItem, now: number) {
  const [leftBucket, leftDeadline] = decideOrder(left, now);
  const [rightBucket, rightDeadline] = decideOrder(right, now);
  if (leftBucket !== rightBucket) return leftBucket - rightBucket;
  if (leftDeadline !== rightDeadline) return leftDeadline - rightDeadline;

  const leftExpiry = left.expiresAt ? timestamp(left.expiresAt) : Number.MAX_SAFE_INTEGER;
  const rightExpiry = right.expiresAt ? timestamp(right.expiresAt) : Number.MAX_SAFE_INTEGER;
  if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;

  const severityDiff = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
  if (severityDiff !== 0) return severityDiff;
  return compareAttentionItems(left, right);
}

function encodeCursor(sort: AttentionSortMode, item: AttentionItem) {
  return Buffer.from(JSON.stringify({ v: 1, sort, id: item.id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, sort: AttentionSortMode) {
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<string, unknown>;
    if (decoded.v !== 1 || decoded.sort !== sort || typeof decoded.id !== "string" || !decoded.id) {
      throw new Error("invalid cursor shape");
    }
    return decoded.id;
  } catch {
    throw badRequest("Invalid attention cursor");
  }
}

function parseActivityBoundary(value: string | undefined, field: "activitySince" | "activityUntil") {
  if (value === undefined) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    throw badRequest(`${field} must be an ISO timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw badRequest(`${field} must be an ISO timestamp`);
  return parsed;
}

async function attentionService(db: Db, options: AttentionServiceOptions = {}) {
  const now = options.now?.() ?? Date.now();
  const openDecisionLimit = options.openDecisionLimit ?? OPEN_DECISION_DEFAULT_LIMIT;

  return {
    async list(companyId: string, prefix: string, options: AttentionListOptions = {}) {
      const includeDismissed = options.includeDismissed ?? false;
      const collected: AttentionItem[] = [];
      const add = (item: AttentionItem) => collected.push(item);

      const [dismissalRows, agentRows, openIssueRows, openDecisionRows, openApprovalRows, openRecoveryRows, openInteractionRows, reviewIssueIds, reviewRows] = await Promise.all([
        db.select({ key: inboxDismissals.key, kind: inboxDismissals.kind, dismissedAt: inboxDismissals.dismissedAt, snoozedUntil: inboxDismissals.snoozedUntil }).from(inboxDismissals).where(eq(inboxDismissals.companyId, companyId)),
        db.select({ id: agents.id, name: agents.name, companyId: agents.companyId, role: agents.role, status: agents.status, errorReason: agents.errorReason, createdAt: agents.createdAt, updatedAt: agents.updatedAt, metadata: agents.metadata }).from(agents).where(eq(agents.companyId, companyId)).orderBy(desc(agents.updatedAt), desc(agents.id)),
        db.select({ id: issues.id, companyId: issues.companyId, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority, reviewPolicy: issues.reviewPolicy, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt, updatedAt: issues.updatedAt }).from(issues).where(and(eq(issues.companyId, companyId), executionIssueCondition({ status: "open" }))).orderBy(desc(issues.updatedAt), desc(issues.id)),
        db.select({ id: decisions.id, issueId: decisions.issueId, bundleId: decisions.bundleId, status: decisions.status, createdAt: decisions.createdAt, updatedAt: decisions.updatedAt, contextJson: decisions.contextJson, resultJson: decisions.resultJson }).from(decisions).where(and(eq(decisions.companyId, companyId), inArray(decisions.status, PENDING_INTERACTION_STATUSES))).orderBy(asc(decisions.createdAt)).limit(openDecisionLimit),
        db.select({ id: approvals.id, issueId: approvals.issueId, status: approvals.status, createdAt: approvals.createdAt, updatedAt: approvals.updatedAt, contextJson: approvals.contextJson, resultJson: approvals.resultJson, type: approvals.type }).from(approvals).where(and(eq(approvals.companyId, companyId), inArray(approvals.status, PENDING_INTERACTION_STATUSES))).orderBy(asc(approvals.createdAt)),
        db.select({ id: issueRecoveryActions.id, issueId: issueRecoveryActions.issueId, status: issueRecoveryActions.status, ownerType: issueRecoveryActions.ownerType, ownerId: issueRecoveryActions.ownerId, createdAt: issueRecoveryActions.createdAt, updatedAt: issueRecoveryActions.updatedAt }).from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, companyId), inArray(issueRecoveryActions.status, OPEN_RECOVERY_STATUSES), inArray(issueRecoveryActions.ownerType, HUMAN_RECOVERY_OWNER_TYPES))).orderBy(asc(issueRecoveryActions.createdAt)),
        db.select({ id: issueThreadInteractions.id, issueId: issueThreadInteractions.issueId, kind: issueThreadInteractions.kind, status: issueThreadInteractions.status, resolverPolicy: issueThreadInteractions.resolverPolicy, createdAt: issueThreadInteractions.createdAt, updatedAt: issueThreadInteractions.updatedAt, payloadJson: issueThreadInteractions.payloadJson }).from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), inArray(issueThreadInteractions.status, PENDING_INTERACTION_STATUSES))).orderBy(asc(issueThreadInteractions.createdAt)),
        db.select({ issueId: issueRelations.targetIssueId }).from(issueRelations).where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "blocks"), inArray(issueRelations.sourceIssueId, db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review")))))).then((rows) => rows.map((row) => row.issueId)),
        db.select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt, updatedAt: issues.updatedAt, executionState: issues.executionState }).from(issues).where(and(eq(issues.companyId, companyId), eq(issues.status, "in_review"))).orderBy(desc(issues.updatedAt), desc(issues.id)),
      ]);

      const dismissalByKey = new Map(dismissalRows.map((row) => [row.key, { kind: row.kind, dismissedAt: row.dismissedAt, snoozedUntil: row.snoozedUntil } as const]));
      const agentMap = new Map(agentRows.map((row) => [row.id, row]));
      const issueMap = new Map(openIssueRows.map((row) => [row.id, row]));
      const issueByIdentifier = new Map(openIssueRows.filter((row) => row.identifier).map((row) => [row.identifier!, row]));

      const openIssueIds = openIssueRows.map((row) => row.id);
      const openIssueAgentIds = [...new Set(openIssueRows.map((row) => row.assigneeAgentId).filter(Boolean))];
      const decisionIssueIds = openDecisionRows.map((row) => row.issueId).filter(Boolean);
      const approvalIssueIds = openApprovalRows.map((row) => row.issueId).filter(Boolean);
      const recoveryIssueIds = openRecoveryRows.map((row) => row.issueId);
      const interactionIssueIds = openInteractionRows.map((row) => row.issueId);
      const allIssueIds = [...new Set([...openIssueIds, ...decisionIssueIds, ...approvalIssueIds, ...recoveryIssueIds, ...interactionIssueIds])];

      const [issueProjects, issueWorkspaces, issueDocuments, issueAttachments, issueImages] = await Promise.all([
        allIssueIds.length === 0
          ? Promise.resolve([])
          : db.select({ issueId: issueRelations.sourceIssueId, projectId: issueRelations.targetIssueId }).from(issueRelations).where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "documents"), inArray(issueRelations.sourceIssueId, allIssueIds), inArray(issueRelations.targetIssueId, db.select({ id: projects.id }).from(projects).where(eq(projects.companyId, companyId))))),
        allIssueIds.length === 0
          ? Promise.resolve([])
          : db.select({ issueId: issueRelations.sourceIssueId, workspaceId: projectWorkspaces.workspaceId }).from(issueRelations).innerJoin(projectWorkspaces, eq(issueRelations.targetIssueId, projectWorkspaces.projectId)).where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.type, "documents"), inArray(issueRelations.sourceIssueId, allIssueIds))),
        allIssueIds.length === 0
          ? Promise.resolve(new Map())
          : (async () => {
            const rows = await db.select({ issueId: issueDocuments.issueId, key: issueDocuments.key, title: issueDocuments.title, body: issueDocuments.body }).from(issueDocuments).where(and(eq(issueDocuments.companyId, companyId), inArray(issueDocuments.issueId, allIssueIds), eq(issueDocuments.key, "plan")));
            return new Map(rows.map((row) => [row.issueId, { title: row.title, body: row.body }]));
          })(),
        allIssueIds.length === 0
          ? Promise.resolve([])
          : db.select({ issueId: issueAttachments.issueId, assetId: assets.id, alt: assets.alt }).from(issueAttachments).innerJoin(assets, eq(issueAttachments.assetId, assets.id)).where(and(eq(issueAttachments.companyId, companyId), inArray(issueAttachments.issueId, allIssueIds))).orderBy(asc(assets.createdAt)).limit(DETAIL_IMAGE_LIMIT * 5),
        allIssueIds.length === 0
          ? Promise.resolve(new Map())
          : (async () => {
            const rows = await db.select({ issueId: issueAttachments.issueId, assetId: assets.id, alt: assets.alt }).from(issueAttachments).innerJoin(assets, eq(issueAttachments.assetId, assets.id)).where(and(eq(issueAttachments.companyId, companyId), inArray(issueAttachments.issueId, allIssueIds))).orderBy(asc(assets.createdAt)).limit(DETAIL_IMAGE_LIMIT * 5);
            const map = new Map<string, AttentionDetailImage[]>();
            for (const row of rows) {
              const images = map.get(row.issueId) ?? [];
              if (images.length < DETAIL_IMAGE_LIMIT) {
                images.push({ assetId: row.assetId, alt: row.alt });
                map.set(row.issueId, images);
              }
            }
            return map;
          })(),
      ]);

      const projectMap = allIssueIds.length === 0
        ? new Map()
        : new Map(await db.select({ id: projects.id, name: projects.name, urlKey: projects.urlKey, color: projects.color, icon: projects.icon }).from(projects).where(eq(projects.companyId, companyId)).then((rows) => rows.map((row) => [row.id, row])));
      const workspaceMap = allIssueIds.length === 0
        ? new Map()
        : new Map(await db.select({ id: projectWorkspaces.workspaceId, name: projectWorkspaces.name }).from(projectWorkspaces).where(eq(projectWorkspaces.companyId, companyId)).then((rows) => rows.map((row) => [row.workspaceId, row])));

      const issueProjectMap = new Map(issueProjects.map((row) => [row.issueId, projectMap.get(row.projectId) ?? null]));
      const issueWorkspaceMap = new Map(issueWorkspaces.map((row) => [row.issueId, workspaceMap.get(row.workspaceId) ?? null]));

      const agentName = (id: string | null | undefined) => id ? agentMap.get(id)?.name ?? "Unknown agent" : null;
      const agentRole = (id: string | null | undefined) => id ? agentMap.get(id)?.role ?? "unknown" : null;

      for (const decision of openDecisionRows) {
        const issue = decision.issueId ? issueMap.get(decision.issueId) : null;
        const project = issue ? issueProjectMap.get(issue.id) : null;
        const workspace = issue ? issueWorkspaceMap.get(issue.id) : null;
        const images = issue ? (issueImages.get(issue.id) ?? []) : [];

        add(createItem({
          companyId,
          sourceKind: "decision",
          subject: {
            kind: "decision",
            id: decision.id,
            companyId,
            title: decision.contextJson?.title ?? decision.contextJson?.prompt ?? "Decision",
            identifier: null,
            status: decision.status,
            href: decision.issueId ? issueHref(prefix, { id: decision.issueId, identifier: issue?.identifier ?? null }) : null,
            metadata: decision.contextJson,
          },
          whyNow: "A decision is awaiting your input.",
          decisionVerbs: decision.contextJson?.verdicts?.length
            ? decision.contextJson.verdicts.map((verb: { id: string; label: string; description: string | null }) => ({ id: verb.id, label: verb.label, description: verb.description }))
            : decisionVerbs(
              { id: "approve", label: "Approve", description: "Approve the decision." },
              { id: "reject", label: "Reject", description: "Reject the decision." },
            ),
          inlineResolvable: true,
          entryRule: "decisions.status = 'pending'",
          exitRule: "Decision is approved, rejected, or cancelled.",
          dedupKey: `decision:${decision.id}`,
          severity: "medium",
          activityAt: toIso(decision.updatedAt),
          createdAt: toIso(decision.createdAt),
          updatedAt: toIso(decision.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          project,
          workspace,
          detail: genericDetail(decision.contextJson?.prompt ?? decision.contextJson?.detailsMarkdown, images),
        }));
      }

      for (const approval of openApprovalRows) {
        const issue = approval.issueId ? issueMap.get(approval.issueId) : null;
        const project = issue ? issueProjectMap.get(issue.id) : null;
        const workspace = issue ? issueWorkspaceMap.get(issue.id) : null;
        const images = issue ? (issueImages.get(issue.id) ?? []) : [];

        add(createItem({
          companyId,
          sourceKind: "approval",
          subject: {
            kind: "approval",
            id: approval.id,
            companyId,
            title: approval.type,
            identifier: null,
            status: approval.status,
            href: approval.issueId ? issueHref(prefix, { id: approval.issueId, identifier: issue?.identifier ?? null }) : null,
            metadata: approval.contextJson,
          },
          whyNow: "An approval is awaiting your input.",
          decisionVerbs: decisionVerbs(
            { id: "approve", label: "Approve", description: "Approve the request." },
            { id: "reject", label: "Reject", description: "Reject the request." },
          ),
          inlineResolvable: true,
          entryRule: "approvals.status = 'pending'",
          exitRule: "Approval is granted or denied.",
          dedupKey: `approval:${approval.id}`,
          severity: "medium",
          activityAt: toIso(approval.updatedAt),
          createdAt: toIso(approval.createdAt),
          updatedAt: toIso(approval.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          project,
          workspace,
          detail: approvalDetail(approval.type, approval.contextJson ?? {}),
        }));
      }

      for (const recovery of openRecoveryRows) {
        const issue = issueMap.get(recovery.issueId);
        const project = issue ? issueProjectMap.get(issue.id) : null;
        const workspace = issue ? issueWorkspaceMap.get(issue.id) : null;
        const images = issue ? (issueImages.get(issue.id) ?? []) : [];

        add(createItem({
          companyId,
          sourceKind: "recovery_action",
          subject: {
            kind: "recovery_action",
            id: recovery.id,
            companyId,
            title: recovery.status,
            identifier: null,
            status: recovery.status,
            href: issue ? issueHref(prefix, issue) : null,
            metadata: {
              ownerType: recovery.ownerType,
              ownerId: recovery.ownerId,
              agentName: agentName(recovery.ownerId),
              agentRole: agentRole(recovery.ownerId),
            },
          },
          whyNow: "A recovery action requires attention.",
          decisionVerbs: decisionVerbs(
            { id: "resolve", label: "Resolve", description: "Mark the recovery action as resolved." },
            { id: "escalate", label: "Escalate", description: "Escalate the recovery action to the board." },
          ),
          inlineResolvable: true,
          entryRule: "issue_recovery_actions.status IN ('active', 'escalated') AND issue_recovery_actions.owner_type IN ('user', 'board')",
          exitRule: "Recovery action is resolved or escalated.",
          dedupKey: `recovery:${recovery.id}`,
          severity: recovery.ownerType === "board" ? "high" : "medium",
          activityAt: toIso(recovery.updatedAt),
          createdAt: toIso(recovery.createdAt),
          updatedAt: toIso(recovery.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          project,
          workspace,
          detail: genericDetail("A recovery action requires attention", images),
        }));
      }

      for (const interaction of openInteractionRows) {
        const issue = issueMap.get(interaction.issueId);
        const project = issue ? issueProjectMap.get(issue.id) : null;
        const workspace = issue ? issueWorkspaceMap.get(issue.id) : null;
        const planDocument = issue ? issueDocuments.get(issue.id) ?? null : null;
        const images = issue ? (issueImages.get(issue.id) ?? []) : [];

        add(createItem({
          companyId,
          sourceKind: "issue_thread_interaction",
          subject: {
            kind: "interaction",
            id: interaction.id,
            companyId,
            title: interaction.kind,
            identifier: null,
            status: interaction.status,
            href: issue ? issueHref(prefix, issue) : null,
            metadata: {
              kind: interaction.kind,
              resolverPolicy: interaction.resolverPolicy,
              requestedByAgentId: interaction.payloadJson?.requestedByAgentId ?? null,
              addresseeAgentId: interaction.payloadJson?.addresseeAgentId ?? null,
              addresseeUserId: interaction.payloadJson?.addresseeUserId ?? null,
            },
          },
          whyNow: "An interaction requires your attention.",
          decisionVerbs: decisionVerbs(
            { id: "respond", label: "Respond", description: "Respond to the interaction." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this interaction." },
          ),
          inlineResolvable: false, // These require fetching the full interaction to respond
          entryRule: "issue_thread_interactions.status = 'pending'",
          exitRule: "Interaction is responded to or dismissed.",
          dedupKey: `interaction:${interaction.id}`,
          severity: "medium",
          activityAt: toIso(interaction.updatedAt),
          createdAt: toIso(interaction.createdAt),
          updatedAt: toIso(interaction.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          project,
          workspace,
          detail: interactionDetail({
            kind: interaction.kind,
            payload: interaction.payloadJson ?? {},
            issue,
            planDocument,
            images,
          }),
          resolverAudience: interaction.resolverPolicy
            ? {
              requestedResolverPolicy: interaction.resolverPolicy,
              effectiveResolverPolicy: interaction.resolverPolicy,
              effectiveResolverPolicySource: "explicit_policy",
              resolverPolicyProvenance: "current_schema",
              addresseeAgentId: interaction.payloadJson?.addresseeAgentId ?? null,
              addresseeUserId: interaction.payloadJson?.addresseeUserId ?? null,
              addresseeName: interaction.payloadJson?.addresseeAgentId
                ? agentMap.get(interaction.payloadJson.addresseeAgentId)?.name ?? null
                : null,
              createdByAgentId: interaction.payloadJson?.requestedByAgentId ?? null,
              createdByAgentName: interaction.payloadJson?.requestedByAgentId
                ? agentMap.get(interaction.payloadJson.requestedByAgentId)?.name ?? null
                : null,
            }
            : null,
        }));
      }

      const joinRequestRows = await db
        .select({ id: invites.id, email: invites.email, requestedByUserId: invites.requestedByUserId, createdAt: invites.createdAt, updatedAt: invites.updatedAt })
        .from(invites)
        .where(and(
          eq(invites.companyId, companyId),
          eq(invites.status, "pending"),
          isNotNull(invites.requestedByUserId),
        ));

      for (const request of joinRequestRows) {
        add(createItem({
          companyId,
          sourceKind: "join_request",
          subject: {
            kind: "join_request",
            id: request.id,
            companyId,
            title: request.email,
            identifier: null,
            status: "pending",
            href: `/${prefix}/settings/members`,
            metadata: { email: request.email, requestedByUserId: request.requestedByUserId },
          },
          whyNow: "A user has requested to join the company.",
          decisionVerbs: decisionVerbs(
            { id: "accept", label: "Accept", description: "Accept the join request." },
            { id: "reject", label: "Reject", description: "Reject the join request." },
          ),
          inlineResolvable: true,
          entryRule: "invites.status = 'pending' AND invites.requested_by_user_id IS NOT NULL",
          exitRule: "Join request is accepted or rejected.",
          dedupKey: `join_request:${request.id}`,
          severity: "low",
          activityAt: toIso(request.updatedAt),
          createdAt: toIso(request.createdAt),
          updatedAt: toIso(request.updatedAt),
          relatedIssue: null,
          detail: genericDetail(`User ${request.email} has requested to join`, []),
        }));
      }

      // myrmidon(PRODUCTIVITY-REVIEW): the monthly/weekly review cycles surface as
      // attention items with sourceKind "productivity_review". The sweep creates
      // them (sweeps.ts) with a stable dedupKey per cycle per agent, so they
      // appear once per cycle. The rule keys (entry/exit) reference the design doc.
      // Resolution happens through the attention UI verbs (not the decision engine).
      const reviewCycles = await db
        .select({ id: decisionTriage.id, key: decisionTriage.key, title: decisionTriage.title, cycleType: decisionTriage.cycleType, createdAt: decisionTriage.createdAt, updatedAt: decisionTriage.updatedAt })
        .from(decisionTriage)
        .where(and(
          eq(decisionTriage.companyId, companyId),
          eq(decisionTriage.kind, "productivity_review"),
          isNull(decisionTriage.completedAt),
        ));

      for (const cycle of reviewCycles) {
        add(createItem({
          companyId,
          sourceKind: "productivity_review",
          subject: {
            kind: "decision",
            id: cycle.id,
            companyId,
            title: cycle.title ?? `${cycle.cycleType} productivity review`,
            identifier: null,
            status: "pending",
            href: `/${prefix}/reviews/${cycle.id}`,
            metadata: { cycleType: cycle.cycleType, key: cycle.key },
          },
          whyNow: `Your ${cycle.cycleType} productivity review is ready to complete.`,
          decisionVerbs: decisionVerbs(
            { id: "start_review", label: "Start review", description: "Begin the productivity review." },
            { id: "skip", label: "Skip", description: "Skip this review cycle." },
          ),
          inlineResolvable: true,
          entryRule: "decision_triage.kind = 'productivity_review' AND decision_triage.completed_at IS NULL",
          exitRule: "Productivity review is completed or skipped.",
          dedupKey: `productivity_review:${cycle.key}`,
          severity: "medium",
          activityAt: toIso(cycle.updatedAt),
          createdAt: toIso(cycle.createdAt),
          updatedAt: toIso(cycle.updatedAt),
          relatedIssue: null,
          detail: genericDetail(`Complete your ${cycle.cycleType} productivity review`, []),
        }));
      }

      // Blocker attention: when an issue is blocked, show an item for each
      // issue that is blocked and the issues that are blocking it, up to the
      // limits. This helps users understand and resolve blockers quickly.
      const blockerRows = await db
        .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt, updatedAt: issues.updatedAt, executionState: issues.executionState })
        .from(issues)
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, db
            .select({ sourceIssueId: issueRelations.sourceIssueId })
            .from(issueRelations)
            .where(and(
              eq(issueRelations.companyId, companyId),
              eq(issueRelations.type, "blocks"),
              inArray(issueRelations.targetIssueId, openIssueIds),
            ))),
        ))
        .limit(BLOCKER_ATTENTION_MAX_NODES);

      // Group blocker relationships to avoid duplicate items
      const blockerGroups = new Map<string, { blocking: IssueSummaryRow[]; blocked: IssueSummaryRow[] }>();
      for (const blocker of blockerRows) {
        const targetIds = await db
          .select({ targetIssueId: issueRelations.targetIssueId })
          .from(issueRelations)
          .where(and(
            eq(issueRelations.companyId, companyId),
            eq(issueRelations.sourceIssueId, blocker.id),
            eq(issueRelations.type, "blocks"),
            inArray(issueRelations.targetIssueId, openIssueIds),
          ))
          .limit(BLOCKER_ATTENTION_MAX_DEPTH);

        if (targetIds.length > 0) {
          const blockedIssues = await Promise.all(
            targetIds.map(({ targetIssueId }) => db
              .select({ id: issues.id, identifier: issues.identifier, title: issues.title, status: issues.status, priority: issues.priority, assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId, createdAt: issues.createdAt, updatedAt: issues.updatedAt })
              .from(issues)
              .where(and(eq(issues.companyId, companyId), eq(issues.id, targetIssueId)))
              .limit(1)
              .then((rows) => rows[0] ?? null))
          );

          const validBlockedIssues = blockedIssues.filter(Boolean) as IssueSummaryRow[];
          if (validBlockedIssues.length > 0) {
            blockerGroups.set(blocker.id, {
              blocking: [blocker],
              blocked: validBlockedIssues,
            });
          }
        }
      }

      for (const [blockerId, { blocking, blocked }] of blockerGroups) {
        const primaryBlocker = blocking[0]!;
        const primaryBlocked = blocked[0]!;

        add(createItem({
          companyId,
          sourceKind: "blocker_attention",
          subject: issueSubject(prefix, primaryBlocked),
          whyNow: "This issue is blocked by another issue.",
          decisionVerbs: decisionVerbs(
            { id: "resolve_blocker", label: "Resolve blocker", description: "Go to the blocking issue and resolve it." },
            { id: "unblock", label: "Unblock", description: "Remove the block relationship." },
          ),
          inlineResolvable: true,
          entryRule: "issue_relations.type = 'blocks' AND issues.status = 'blocked'",
          exitRule: "Block relationship is removed or blocking issue is resolved.",
          dedupKey: `blocker:${blockerId}->${primaryBlocked.id}`,
          severity: "high",
          activityAt: toIso(primaryBlocker.updatedAt),
          createdAt: toIso(primaryBlocker.createdAt),
          updatedAt: toIso(primaryBlocker.updatedAt),
          relatedIssue: issueSubject(prefix, primaryBlocker),
          ...issueContext(primaryBlocked),
          detail: {
            kind: "blocker",
            blockingIssue: {
              id: primaryBlocker.id,
              identifier: primaryBlocker.identifier,
              title: primaryBlocker.title,
            },
            blockedTaskCount: blocked.length,
            images: issueImages.get(primaryBlocked.id) ?? [],
          },
        }));
      }

      // Reviews: issues in the "in_review" status may need attention based
      // on their review state and participants
      const reviewIssueIds = Array.from(new Set([
        ...openIssueIds.filter((id) => issueMap.get(id)?.status === "in_review"),
        ...blockerRows.filter((row) => row.status === "in_review").map((row) => row.id),
      ])).slice(0, 100); // Limit to prevent huge queries

      const pendingReviewApprovalRows = reviewIssueIds.length === 0
        ? []
        : await db
          .select({ issueId: issueApprovals.issueId, approvalId: approvals.id })
          .from(issueApprovals)
          .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
          .where(and(
            eq(issueApprovals.companyId, companyId),
            eq(approvals.companyId, companyId),
            inArray(issueApprovals.issueId, reviewIssueIds),
            eq(approvals.status, "pending"),
          ));
      const pendingApprovalByIssueId = new Map(pendingReviewApprovalRows.map((row) => [row.issueId, row.approvalId]));
      const [reviewAttentionByIssueId, reviewIssueMap, reviewImageMap] = await Promise.all([
        issueService(db).listReviewAttention(companyId, reviewRows),
        issueSummaryMap(db, companyId, reviewIssueIds),
        issueImageMap(db, companyId, reviewIssueIds),
      ]);

      for (const review of reviewRows) {
        const state = parseIssueExecutionState(review.executionState);
        const currentParticipant = state?.status === "pending" ? state.currentParticipant : null;
        const hasHumanParticipant = currentParticipant?.type === "user";
        const pendingApprovalId = pendingApprovalByIssueId.get(review.id) ?? null;
        const reviewAttention = reviewAttentionByIssueId.get(review.id);
        const stalled = reviewAttention?.state === "stalled";
        if (!hasHumanParticipant && !review.assigneeUserId && !pendingApprovalId && !stalled) continue;
        const issue = reviewIssueMap.get(review.id);
        if (!issue) continue;
        const dedupKey = `review:${review.id}`;
        // A stalled review carries no interaction/approval/monitor to open, so
        // it is resolved in-row with the three review verbs (PAP-16080 §4.4).
        // Covered reviews still deep-link — their real action lives elsewhere
        // (the pending interaction/approval card, a monitor, a live run).
        const reviewSubject = issueSubject(prefix, issue);
        add(createItem({
          companyId,
          sourceKind: "review",
          subject: stalled
            ? { ...reviewSubject, metadata: { ...reviewSubject.metadata, reviewAttentionState: "stalled" } }
            : reviewSubject,
          whyNow: stalled
            ? "Issue is in review without a maintained reviewer, interaction, approval, monitor, run, wake, or recovery path."
            : pendingApprovalId
            ? "Issue is in review with a linked pending approval."
            : hasHumanParticipant
              ? "Issue is in review and the current execution participant is a user."
              : "Issue is in review and assigned to a user.",
          decisionVerbs: stalled
            ? decisionVerbs(
                { id: "choose_review_path", label: "Choose review path", description: "Add a reviewer or waiting path, return the issue to work, or accept it." },
                { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
              )
            : decisionVerbs(
                { id: "approve", label: "Approve", description: "Approve the review and advance the issue." },
                { id: "request_changes", label: "Request changes", description: "Return the issue to the assignee with changes requested." },
              ),
          inlineResolvable: stalled,
          entryRule: stalled
            ? "issues.status = 'in_review' and reviewAttention.state = 'stalled'."
            : "issues.status = 'in_review' and human reviewer, user assignee, or linked pending approval exists.",
          exitRule: "Issue leaves in_review or the human review path resolves.",
          dedupKey,
          severity: stalled ? "high" : "medium",
          activityAt: toIso(review.updatedAt),
          createdAt: toIso(review.createdAt),
          updatedAt: toIso(review.updatedAt),
          relatedIssue: null,
          ...issueContext(issue),
          detail: genericDetail(review.title, issueImages.get(review.id) ?? []),
        }));
      }

      const failedRows = await listAttentionExhaustedRuns(db, companyId);
      const failedIssueIds = failedRows.map((row) => readRunIssueId(row.contextSnapshot));
      const failedAgentIds = [...new Set(failedRows.map((row) => row.agentId))];
      const oldestFailedRunCreatedAt = failedRows.reduce<Date | null>((oldest, row) => {
        if (!oldest || row.createdAt < oldest) return row.createdAt;
        return oldest;
      }, null);
      const [failedIssueMap, failedImageMap, newerRuns] = await Promise.all([
        issueSummaryMap(
          db,
          companyId,
          failedIssueIds,
        ),
        issueImageMap(db, companyId, failedIssueIds),
        oldestFailedRunCreatedAt && failedAgentIds.length > 0
          ? db
            .select({
              agentId: heartbeatRuns.agentId,
              createdAt: heartbeatRuns.createdAt,
              // Project just the ids readRunIssueId needs; pulling the whole
              // context_snapshot detoasts megabytes per feed build.
              runIssueId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'issueId'`,
              runTaskId: sql<string | null>`${heartbeatRuns.contextSnapshot} ->> 'taskId'`,
            })
            .from(heartbeatRuns)
            .where(and(
              eq(heartbeatRuns.companyId, companyId),
              inArray(heartbeatRuns.agentId, failedAgentIds),
              gt(heartbeatRuns.createdAt, oldestFailedRunCreatedAt),
            ))
          : Promise.resolve([]),
      ]);
      const latestRunCreatedAtByKey = new Map<string, Date>();
      for (const newerRun of newerRuns) {
        const newerRunIssueId = readRunIssueId({ issueId: newerRun.runIssueId, taskId: newerRun.runTaskId });
        const newerRunKey = `${newerRun.agentId}:${newerRunIssueId ?? ""}`;
        const latestCreatedAt = latestRunCreatedAtByKey.get(newerRunKey);
        if (!latestCreatedAt || newerRun.createdAt > latestCreatedAt) {
          latestRunCreatedAtByKey.set(newerRunKey, newerRun.createdAt);
        }
      }
      for (const run of failedRows) {
        const issueId = readRunIssueId(run.contextSnapshot);
        const runKey = `${run.agentId}:${issueId ?? ""}`;
        const hasNewerRun = (latestRunCreatedAtByKey.get(runKey)?.getTime() ?? 0) > run.createdAt.getTime();
        if (hasNewerRun) continue;

        const issue = issueId ? failedIssueMap.get(issueId) ?? null : null;
        const dedupKey = `run:${run.id}`;
        add(createItem({
          companyId,
          sourceKind: "failed_run",
          subject: {
            kind: "run",
            id: run.id,
            companyId,
            title: `${run.agentName} run ${run.status}`,
            identifier: null,
            status: run.status,
            href: `/${prefix}/agents/${run.agentId}/runs/${run.id}`,
            metadata: {
              agentId: run.agentId,
              agentName: run.agentName,
              issueId,
              errorCode: run.errorCode,
              error: run.error,
              retryExhaustedReason: run.exhaustionMessage,
            },
          },
          whyNow: "Run failed after automatic retries were exhausted.",
          decisionVerbs: decisionVerbs(
            { id: "retry", label: "Retry", description: "Retry the failed run or issue." },
            { id: "reassign", label: "Reassign", description: "Move the work to another owner." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this failed-run attention row." },
          ),
          inlineResolvable: true,
          entryRule: "latest failed/timed_out run has a Bounded retry exhausted lifecycle event.",
          exitRule: "A newer run exists for the same issue/agent pair or the row is dismissed.",
          dedupKey,
          severity: "high",
          activityAt: toIso(run.finishedAt ?? run.updatedAt ?? run.createdAt),
          createdAt: toIso(run.createdAt),
          updatedAt: toIso(run.updatedAt),
          relatedIssue: issue ? issueSubject(prefix, issue) : null,
          ...issueContext(issue),
          detail: {
            kind: "failed_run",
            agentName: run.agentName,
            failureReasonExcerpt: excerpt(run.error ?? run.exhaustionMessage ?? run.errorCode),
            images: issueImages.get(issueId) ?? [],
          },
        }));
      }

      const budgetOverview = await budgetService(db).overview(companyId);
      for (const incident of budgetOverview.activeIncidents) {
        const observedPercent = budgetObservedPercent(incident.amountObserved, incident.amountLimit);
        if (incident.thresholdType !== "hard" && observedPercent < 85) continue;
        const dedupKey = `budget:${incident.policyId}:${toIso(incident.windowStart)}:${incident.thresholdType}`;
        add(createItem({
          companyId,
          sourceKind: "budget_alert",
          subject: {
            kind: "budget_incident",
            id: incident.id,
            companyId,
            title: `${incident.scopeName} budget ${incident.thresholdType === "hard" ? "hard stop" : "warning"}`,
            identifier: null,
            status: incident.status,
            href: `/${prefix}/costs`,
            metadata: {
              policyId: incident.policyId,
              scopeType: incident.scopeType,
              scopeId: incident.scopeId,
              thresholdType: incident.thresholdType,
              amountObserved: incident.amountObserved,
              amountLimit: incident.amountLimit,
              observedPercent,
              approvalId: incident.approvalId,
              approvalStatus: incident.approvalStatus,
            },
          },
          whyNow: incident.thresholdType === "hard"
            ? "Budget hard stop was reached."
            : "Budget crossed the 85% warning threshold.",
          decisionVerbs: decisionVerbs(
            { id: "raise_budget_and_resume", label: "Raise budget", description: "Raise the budget and resume paused work." },
            { id: "keep_paused", label: "Keep paused", description: "Dismiss or keep the budget stop in place." },
          ),
          inlineResolvable: true,
          entryRule: "open budget incident is hard, or soft with observed spend >= 85% of limit.",
          exitRule: "Budget incident is resolved or dismissed.",
          dedupKey,
          severity: incident.thresholdType === "hard" ? "high" : "medium",
          activityAt: toIso(incident.updatedAt),
          createdAt: toIso(incident.createdAt),
          updatedAt: toIso(incident.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "budget",
            observedPercent,
            amountObserved: incident.amountObserved,
            amountLimit: incident.amountLimit,
            images: [],
          },
        }));
      }

      const erroredAgents = await db
        .select({
          id: agents.id,
          companyId: agents.companyId,
          name: agents.name,
          role: agents.role,
          status: agents.status,
          errorReason: agents.errorReason,
          createdAt: agents.createdAt,
          updatedAt: agents.updatedAt,
          metadata: agents.metadata,
        })
        .from(agents)
        .where(and(eq(agents.companyId, companyId), eq(agents.status, "error")))
        .orderBy(desc(agents.updatedAt), desc(agents.id));

      for (const agent of erroredAgents) {
        const dedupKey = `agent_error:${agent.id}`;
        // myrmidon(AUTO-RESUME): the board tries to resume an errored agent on
        // its own with a 1/5/15 min backoff. Once it gave up (the attempt cap
        // is reached and recorded in the agent's metadata), the card escalates
        // from "the agent is in error" to "the board stopped retrying and an
        // operator must intervene". It stays the same card per agent (same
        // dedupKey), so the desk never shows two rows for one agent.
        const autoResume = readAutoResumeAttentionState(agent.metadata);
        const autoResumeExhausted = autoResume?.exhausted === true;
        add(createItem({
          companyId,
          sourceKind: "agent_error_alert",
          subject: {
            kind: "agent",
            id: agent.id,
            companyId,
            title: agent.name,
            identifier: null,
            status: agent.status,
            href: `/${prefix}/agents/${agent.id}`,
            metadata: {
              role: agent.role,
              errorReason: agent.errorReason,
              ...(autoResumeExhausted
                ? { autoResumeExhausted: true, autoResumeAttempts: autoResume?.failures ?? 0 }
                : {}),
            },
          },
          whyNow: autoResumeExhausted
            ? `Automatic resume gave up after ${autoResume?.failures ?? 0} attempt(s); an operator must intervene.`
            : "Agent is in error status and needs operator action or dismissal.",
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the agent error." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this alert." },
          ),
          inlineResolvable: true,
          entryRule: "agents.status = 'error'",
          exitRule: "Agent leaves error status or the row is dismissed.",
          dedupKey,
          severity: autoResumeExhausted ? "critical" : "high",
          activityAt: toIso(agent.updatedAt),
          createdAt: toIso(agent.createdAt),
          updatedAt: toIso(agent.updatedAt),
          relatedIssue: null,
          detail: {
            kind: "agent_error",
            agentName: agent.name,
            failureReasonExcerpt: excerpt(agent.errorReason),
            images: [],
          },
        }));
      }

      // myrmidon(SUB): the scheduled stack release check writes its result into
      // the stack cache; a component that lags behind upstream (or got a new
      // release) surfaces here. The feed recomputes on every list, so the data
      // stays in the registry cache and never in an attention table.
      const stackDocument = await readStackDocument(db);
      for (const card of buildStackAttentionCards(stackDocument)) {
        add(createItem({
          companyId,
          sourceKind: "stack_update",
          subject: {
            kind: "stack_component",
            id: card.component,
            companyId,
            title: card.title,
            identifier: null,
            status: null,
            href: null,
            metadata: card.metadata,
          },
          whyNow: card.whyNow,
          decisionVerbs: decisionVerbs(
            { id: "review", label: "Review update", description: "Open the stack update and plan the upgrade." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this stack update until the next release." },
          ),
          inlineResolvable: true,
          entryRule: "an upstream release is newer than the cached local version, or a new release appeared since the last check.",
          exitRule: "the component is updated to the latest release, the local version catches up, or the row is dismissed.",
          dedupKey: card.dedupKey,
          severity: card.severity,
          activityAt: card.activityAt,
          createdAt: card.activityAt,
          updatedAt: card.activityAt,
          relatedIssue: null,
          detail: {
            kind: "generic",
            summaryExcerpt: card.summaryExcerpt,
            images: [],
          },
        }));
      }

      // myrmidon(STALE-BLOCK): one card per block the stale-block watchdog
      // lifted. The sweep records the signal into a process-level registry
      // (myrmidon/stale-block/attention.ts) — the feed computes the items on
      // the fly, no notification store. Dedup is stable per task and lift;
      // the card disappears when the TTL expires or the operator dismisses.
      for (const signal of readStaleBlockSignals(companyId)) {
        add(createItem({
          companyId,
          sourceKind: "stale_block",
          subject: {
            kind: "issue",
            id: signal.issueId,
            companyId,
            title: signal.title ?? "Task",
            identifier: signal.identifier,
            status: "in_progress",
            href: signal.identifier ? `/${prefix}/issues/${signal.identifier}` : null,
            metadata: {
              liftedAt: signal.liftedAt,
              reasonTexts: signal.reasonTexts,
            },
          },
          whyNow: staleBlockSignalWhyNow(signal),
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Open the task and check the unblock." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this notice." },
          ),
          inlineResolvable: true,
          entryRule: "the stale-block watchdog lifted the task's dead block",
          exitRule: "The TTL expires or the row is dismissed.",
          dedupKey: staleBlockSignalDedupKey(signal),
          severity: staleBlockSignalSeverity(),
          activityAt: signal.liftedAt,
          createdAt: signal.liftedAt,
          updatedAt: signal.liftedAt,
          relatedIssue: null,
          detail: {
            kind: "generic",
            summaryExcerpt: excerpt(signal.reasonTexts.join("; ")),
            images: [],
          },
        }));
      }

      // myrmidon(TRACING-HEALTH): the "LLM tracing" non-ok state raises ONE
      // card on the operator desk, deduped by state — the parent ticket's
      // rule is "signal to the operator role, never the owner", and the
      // attention desk is the operator surface (the same delivery the
      // AUTO-RESUME escalation uses). The signal comes from the process-level
      // registry the tracing signal sweep records (attention-sweep.ts); the
      // feed never calls the probes itself.
      const tracingSignal = readTracingHealthAttentionSignal(companyId);
      if (tracingSignal) {
        add(createItem({
          companyId,
          sourceKind: "agent_error_alert",
          subject: {
            kind: "agent",
            id: tracingHealthSubjectId(companyId),
            companyId,
            title: tracingSignal.title,
            identifier: null,
            status: tracingSignal.state,
            href: `/${prefix}/settings`,
            metadata: {
              tracingHealth: true,
              state: tracingSignal.state,
              severity: tracingSignal.severity,
            },
          },
          whyNow: tracingSignal.whyNow,
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Inspect the tracing pipeline." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this alert." },
          ),
          inlineResolvable: true,
          entryRule: "the LLM tracing health check reports degraded or unknown",
          exitRule: "the check reports ok or idle (the signal registry clears) or the row is dismissed.",
          dedupKey: tracingSignal.dedupKey,
          severity: tracingSignal.severity,
          activityAt: tracingSignal.activityAt,
          createdAt: tracingSignal.activityAt,
          updatedAt: tracingSignal.activityAt,
          relatedIssue: null,
          detail: {
            kind: "generic",
            summaryExcerpt: excerpt(tracingSignal.whyNow),
            images: [],
          },
        }));
      }

      // myrmidon(1.6.1-WIP-LIMIT-A): an agent whose in-flight task count
      // (in_progress + in_review) is over its resolved WIP limit raises one
      // card; a lead holding implementation work raises the same card with
      // the lead wording (the implementation limit of a lead is 0). The feed
      // recomputes on every list, so the card lives exactly as long as the
      // over-limit state does — nothing is persisted for it. A missing limit
      // means "count only", so the block emits nothing.
      const wipSettingsRow = await db
        .select({ general: instanceSettings.general })
        .from(instanceSettings)
        .limit(1)
        .then((rows) => rows[0] ?? null);
      const wipSettings = normalizeWipLimitSettings(wipSettingsRow?.general?.[WIP_LIMIT_SETTINGS_KEY]);
      const wipStatuses = await buildWipLimitStatus(db, companyId, wipSettings);
      const wipAgentNameById = new Map(
        await db
          .select({ id: agents.id, name: agents.name })
          .from(agents)
          .where(eq(agents.companyId, companyId))
          .then((rows) => rows.map((row) => [row.id, row.name] as const)),
      );
      for (const card of buildWipLimitAttentionCards(wipStatuses, wipAgentNameById)) {
        add(createItem({
          companyId,
          sourceKind: "wip_limit",
          subject: {
            kind: "agent",
            id: card.agentId,
            companyId,
            title: card.title,
            identifier: null,
            status: null,
            href: `/${prefix}/agents/${card.agentId}`,
            metadata: card.metadata,
          },
          whyNow: card.whyNow,
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Open the agent's tasks and rebalance the workload." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this signal until the limit is met again." },
          ),
          inlineResolvable: false,
          entryRule: "the agent's in-flight task count is over its WIP limit, or a lead holds implementation work.",
          exitRule: "the count is back within the limit (or the lead holds no implementation task), or the row is dismissed.",
          dedupKey: card.dedupKey,
          severity: card.severity,
          activityAt: toIso(new Date(now)),
          createdAt: toIso(new Date(now)),
          updatedAt: toIso(new Date(now)),
          relatedIssue: null,
          detail: {
            kind: "generic",
            summaryExcerpt: card.summaryExcerpt,
            images: [],
          },
        }));
      }
      // myrmidon(BOT-RUNTIME-TUNING D): the periodic fallback sweep records
      // one signal per agent whose gateway calls were served by a model
      // outside its card above the configured share; the feed just turns the
      // recorded signals into cards (subject = the agent, one dedupKey per
      // agent, severity medium). The signal clears when the share drops
      // below half the threshold — no dismissal bookkeeping, the same
      // registry pattern tracing-health uses.
      for (const fallback of readModelFallbackSignals(companyId)) {
        add(createItem({
          companyId,
          sourceKind: "model_fallback_alert",
          subject: {
            kind: "agent",
            id: fallback.agentId,
            companyId,
            title: fallback.title,
            identifier: null,
            status: null,
            href: `/${prefix}/agents/${fallback.agentId}`,
            metadata: {
              sharePct: fallback.sharePct,
              fallbacks: fallback.fallbacks,
              total: fallback.total,
              servedModels: fallback.servedModels,
            },
          },
          whyNow: fallback.whyNow,
          decisionVerbs: decisionVerbs(
            { id: "inspect", label: "Inspect", description: "Open the agent card and the gateway routing." },
            { id: "dismiss", label: "Dismiss", description: "Dismiss this fallback alert." },
          ),
          inlineResolvable: true,
          entryRule: "the agent's fallback share over the window is at or above the threshold with enough calls.",
          exitRule: "the share drops below half the threshold, the window empties below min calls, or the row is dismissed.",
          dedupKey: fallback.dedupKey,
          severity: fallback.severity,
          activityAt: fallback.activityAt,
          createdAt: fallback.activityAt,
          updatedAt: fallback.activityAt,
          relatedIssue: null,
          detail: {
            kind: "generic",
            summaryExcerpt: excerpt(fallback.summaryExcerpt),
            images: [],
          },
        }));
      }

      const deduped = new Map<string, AttentionItem>();
      for (const item of collected) {
        const current = deduped.get(item.dedupKey);
        deduped.set(item.dedupKey, current ? betterDuplicate(current, item) : item);
      }

      const collectedItems = [...deduped.values()].sort(compareAttentionItems);
      await decisionQueueService(db).materializeSeededQueues(companyId, collectedItems);
      const enrichedItems = await enrichAttentionItems(db, companyId, collectedItems, now);

      const activitySince = parseActivityBoundary(options.activitySince, "activitySince");
      const activityUntil = parseActivityBoundary(options.activityUntil, "activityUntil");
      if (activitySince != null && activityUntil != null && activitySince > activityUntil) {
        throw badRequest("activitySince must be before or equal to activityUntil");
      }
      const queueKey = options.queue?.trim() || null;
      const visibleItems = enrichedItems.filter((item) => {
        if (options.archived === true ? !item.archivedAt : Boolean(item.archivedAt)) return false;
        if (!includeDismissed && item.snoozedUntil && timestamp(item.snoozedUntil) > now) return false;
        const activity = timestamp(item.activityAt);
        if (activitySince != null && activity < activitySince) return false;
        if (activityUntil != null && activity > activityUntil) return false;
        if (queueKey && !item.queues.some((queue) => queue.key === queueKey)) return false;
        return true;
      });

      const sort = options.sort ?? "activity";
      if (sort !== "activity" && sort !== "decide") throw badRequest("sort must be 'activity' or 'decide'");
      const selectedComparator = sort === "decide"
        ? (left: AttentionItem, right: AttentionItem) => compareDecideItems(left, right, now)
        : compareAttentionItems;
      const rankedItems = orderBlockedAttentionByWeight(
        visibleItems.sort(selectedComparator),
        selectedComparator,
      )
        .map((item, index) => ({ ...item, rank: index + 1 }));
      let items: AttentionItem[];
      let nextCursor: string | null;
      if (options.all) {
        if (options.cursor || options.limit !== undefined) {
          throw badRequest("all cannot be combined with cursor or limit");
        }
        items = rankedItems;
        nextCursor = null;
      } else {
        const limit = options.limit ?? ATTENTION_PAGE_DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > ATTENTION_PAGE_MAX_LIMIT) {
          throw badRequest(`limit must be an integer between 1 and ${ATTENTION_PAGE_MAX_LIMIT}`);
        }
        let pageStart = 0;
        if (options.cursor) {
          const cursorItemId = decodeCursor(options.cursor, sort);
          const cursorIndex = rankedItems.findIndex((item) => item.id === cursorItemId);
          if (cursorIndex < 0) throw badRequest("Attention cursor no longer matches the filtered feed");
          pageStart = cursorIndex + 1;
        }
        items = rankedItems.slice(pageStart, pageStart + limit);
        const hasNextPage = pageStart + items.length < rankedItems.length;
        nextCursor = hasNextPage && items.length > 0 ? encodeCursor(sort, items[items.length - 1]!) : null;
      }

      if (options.userId) {
        const trainable: Array<{ sourceKind: "approval" | "interaction"; sourceId: string }> = [];
        for (const item of items) {
          if (item.sourceKind === "approval") {
            trainable.push({ sourceKind: "approval", sourceId: item.subject.id });
          }
          if (item.sourceKind === "issue_thread_interaction") {
            trainable.push({ sourceKind: "interaction", sourceId: item.subject.id });
          }
        }
        if (trainable.length > 0) {
          const examples = await db
            .select({
              id: decisionTrainingExamples.id,
              sourceKind: decisionTrainingExamples.sourceKind,
              sourceId: decisionTrainingExamples.sourceId,
            })
            .from(decisionTrainingExamples)
            .where(and(
              eq(decisionTrainingExamples.companyId, companyId),
              eq(decisionTrainingExamples.createdByUserId, options.userId),
              inArray(decisionTrainingExamples.sourceId, trainable.map((item) => item.sourceId)),
            ));
          const exampleBySource = new Map(examples.map((row) => [`${row.sourceKind}:${row.sourceId}`, row.id]));
          for (const item of items) {
            const sourceKind = item.sourceKind === "approval"
              ? "approval"
              : item.sourceKind === "issue_thread_interaction"
                ? "interaction"
                : null;
            item.trainingExampleId = sourceKind
              ? exampleBySource.get(`${sourceKind}:${item.subject.id}`) ?? null
              : null;
          }
        }
      }
      const countsBySourceKind = emptyCounts();
      for (const item of rankedItems) countsBySourceKind[item.sourceKind] += 1;

      return {
        companyId,
        generatedAt: new Date().toISOString(),
        totalCount: rankedItems.length,
        // Desk badge: distinct items that surfaced
        // today OR carry an explicit decide-by deadline due today/past. Counted
        // over the full ranked set (pre-pagination) so the sidebar badge stays
        // company-wide accurate even on a small first page.
        deskBadgeCount: rankedItems.filter((item) => isNewToday(item, now) || isDecideNow(item, now)).length,
        nextCursor,
        countsBySourceKind,
        items,
      };
    },
  };
}