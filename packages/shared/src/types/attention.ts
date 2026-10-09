import type {
  IssueThreadInteractionCanonicalResolverPolicy,
  IssueThreadInteractionEffectiveResolverPolicySource,
  IssueThreadInteractionResolverPolicyProvenance,
} from "../constants.js";
import type { InboxDismissalKind } from "./inbox-dismissal.js";

export const ATTENTION_SOURCE_KINDS = [
  "approval",
  "decision",
  "issue_thread_interaction",
  "join_request",
  "recovery_action",
  // Legacy persisted decision sources remain readable; no feed items are generated.
  "productivity_review",
  "blocker_attention",
  "review",
  "failed_run",
  "budget_alert",
  "agent_error_alert",
  // myrmidon(SUB): an upstream release of a tracked stack component is newer
  // than the running version, or appeared since the previous release check.
  "stack_update",
  // myrmidon(BOT-RUNTIME-TUNING D): a bot's gateway calls were served by a
  // model outside its card more than the configured share of the window.
  "model_fallback_alert",
  // myrmidon(1.6.5-F11-A): the bot has no issued media token, so its profile
  // carries no media MCP block; media reads «not connected» instead of HTTP 401.
  "bot_media_mcp",
  // myrmidon(STALE-BLOCK): the watchdog lifted a dead block off a task; the
  // lead and operator must see the routing change the machine made.
  "stale_block",
  // myrmidon(BOT-DISK E): the host disk fill level crossed the saved threshold.
  "host_disk_alert",
  // myrmidon(1.6.1-WIP-LIMIT-A): an agent's in-flight task count (in_progress
  // + in_review) is over its resolved WIP limit, or a lead holds a
  // implementation task (lead limit = 0).
  "wip_limit",
  // myrmidon(1.6.3 PROMPT-BUDGET B): an agent's last run prompt crossed the
  // warn/crit threshold (percent of the model window) of the live settings.
  "prompt_budget_alert",
  // myrmidon(REVIEW-ROUTING): a task in review has no reviewer available, or
  // its review has had no verdict for longer than the configured hours.
  "review_routing",
  // myrmidon(PAUSE-GUARD): a pass resumed its ceiling's worth of forgotten
  // operator pauses and left the rest for the following passes.
  "pause_guard",
  // myrmidon(BOT-DISK-A): bot disk lifecycle events.
  "bot_disk_lifecycle",
  // myrmidon(1.6.1-BOT-DISK-C): a bot volume is approaching (>=80%) or over its
  // disk quota; the over-quota state also makes new workspace clones refuse.
  "bot_disk_quota",
  // myrmidon(1.6.5 BOT-DISK-H4c): unpushed work of a closed task was archived
  // (shown on the task), and a bot on a non-current image generation.
  "bot_disk_archive",
  "bot_image_stale",
  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the learning sweep hit a spend limit
  // (or the cost-per-task threshold switched it off); the owner decides.
  "foraging_limit",
  // myrmidon(OPE-6011): a task's wakes are held by a settled
  // execution-reconciliation hold ("execution_reconciliation_required") until
  // a person confirms the failed run left no external action.
  "execution_hold",
  // myrmidon(1.6.5-F-23): agents read their own secret metadata outside an
  // active run (grant secrets:read_off_run); the item counts the reads of the
  // last 24h, and a per-agent variant warns three days before a grant expires.
  "secret_off_run_reads",
  "secret_off_run_grant_expiring",
  // myrmidon(1.6.5-F-18): the gateway spend sweep completed but the model
  // catalog (/v1/model/info) is empty — the accounting key is misconfigured.
  "empty_model_catalog",
  // myrmidon(1.6.5 F-09): a queued run older than the instance's stall
  // threshold (default 1 h) still waits without a waitReason.
  "queue_stall",
] as const;

export type AttentionSourceKind = (typeof ATTENTION_SOURCE_KINDS)[number];

export type AttentionSubjectKind =
  | "approval"
  | "decision"
  | "issue"
  | "interaction"
  | "join_request"
  | "recovery_action"
  | "run"
  | "budget_incident"
  | "agent"
  // myrmidon(SUB): a component of the tracked stack registry.
  | "stack_component"
  // myrmidon(1.6.1-FORAGING-LIMITS-UI): the learning sweep of the company.
  | "foraging_sweep"
  // myrmidon(1.6.5-F-23): a company-scope signal with no narrower subject
  // (e.g. the 24h counter of off-run secret reads).
  | "company";

export type AttentionSeverity = "critical" | "high" | "medium" | "low";

export interface AttentionSubject {
  kind: AttentionSubjectKind;
  id: string;
  companyId: string;
  title: string | null;
  identifier: string | null;
  status: string | null;
  href: string | null;
  metadata?: Record<string, unknown>;
}

export interface AttentionDecisionVerb {
  id: string;
  label: string;
  description: string | null;
}

export interface AttentionProjectRef {
  id: string;
  name: string;
  urlKey: string;
  color: string | null;
  icon: string | null;
}

export interface AttentionWorkspaceRef {
  id: string;
  name: string;
}

export interface AttentionQueueRef {
  key: string;
  title: string;
}

export interface AttentionTriageAttribution {
  type: "agent" | "user";
  agentId: string | null;
  agentName: string | null;
  userId: string | null;
  runId: string | null;
  responsibleUserId: string | null;
  updatedAt: string;
}

export type AttentionSortMode = "activity" | "decide";

export interface AttentionFeedQuery {
  includeDismissed?: boolean;
  archived?: boolean;
  /** Return the complete filtered snapshot in one response. */
  all?: boolean;
  activitySince?: string;
  activityUntil?: string;
  queue?: string;
  sort?: AttentionSortMode;
  cursor?: string;
  limit?: number;
}

export interface AttentionDetailImage {
  assetId: string;
  alt?: string | null;
}

export interface AttentionItemDismissal {
  kind: InboxDismissalKind;
  dismissedAt: string;
  snoozedUntil: string | null;
  isActive: boolean;
}

export type AttentionItemDetail =
  | {
      kind: "approval";
      approvalType: string;
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "plan_approval";
      issueTitle: string | null;
      planTitle: string | null;
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "confirmation";
      promptExcerpt: string | null;
      isPlanTarget: false;
      images: AttentionDetailImage[];
    }
  | {
      kind: "questions";
      questionCount: number;
      firstQuestionText: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "suggested_tasks";
      taskCount: number;
      firstTaskTitle: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "checkbox_confirmation";
      optionCount: number;
      promptExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "item_verdicts";
      itemCount: number;
      promptExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "failed_run";
      agentName: string | null;
      failureReasonExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "blocker";
      blockingIssue: {
        id: string | null;
        identifier: string | null;
        title: string | null;
      } | null;
      blockedTaskCount?: number;
      images: AttentionDetailImage[];
    }
  | {
      kind: "budget";
      observedPercent: number;
      amountObserved: number;
      amountLimit: number;
      images: AttentionDetailImage[];
    }
  | {
      kind: "host_disk";
      usedPercent: number;
      thresholdPercent: number;
      usedGb: number;
      totalGb: number;
      freeGb: number;
      growthBytesPerHour: number | null;
      mountPoint: string | null;
      consumers: Array<{ path: string; sizeGb: number }>;
      images: AttentionDetailImage[];
    }
  | {
      kind: "agent_error";
      agentName: string | null;
      failureReasonExcerpt: string | null;
      images: AttentionDetailImage[];
    }
  | {
      kind: "generic";
      summaryExcerpt: string | null;
      images: AttentionDetailImage[];
    };

/**
 * Who may resolve an issue-thread interaction, as the server evaluated it
 * (PAP-17287). A collapsed attention row carries decision buttons before the
 * full interaction is ever fetched, so the audience has to travel with the feed
 * item — otherwise the queue asks for a decision without saying whose it is.
 *
 * These are *facts*, not copy: the canonical policy the resolution evaluator
 * will apply plus the identities it will compare against. Presentation layers
 * turn them into a sentence; nothing here grants or withholds capability, which
 * the server re-checks at use time.
 */
export interface AttentionResolverAudience {
  /** Canonical policy the creator asked for, before caps and clamps. */
  requestedResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Canonical policy the server will actually enforce. */
  effectiveResolverPolicy: IssueThreadInteractionCanonicalResolverPolicy;
  /** Why the effective policy differs from the requested one, if it does. */
  effectiveResolverPolicySource: IssueThreadInteractionEffectiveResolverPolicySource;
  /** Whether the requested policy was explicit, inherited, or pre-migration. */
  resolverPolicyProvenance: IssueThreadInteractionResolverPolicyProvenance;
  /** Agent the card is addressed to, when it names one. */
  addresseeAgentId: string | null;
  /** User the card is addressed to, when it names one. */
  addresseeUserId?: string | null;
  /** Display name of the agent addressee, resolved server-side. */
  addresseeName: string | null;
  /** Agent that created the card, excluded when the policy is `not_creator`. */
  createdByAgentId: string | null;
  /** Display name of {@link createdByAgentId}, resolved server-side. */
  createdByAgentName: string | null;
}

export interface AttentionItem {
  id: string;
  companyId: string;
  sourceKind: AttentionSourceKind;
  subject: AttentionSubject;
  whyNow: string;
  decisionVerbs: AttentionDecisionVerb[];
  inlineResolvable: boolean;
  entryRule: string;
  exitRule: string;
  dedupKey: string;
  dismissalKey: string;
  dismissal: AttentionItemDismissal | null;
  severity: AttentionSeverity;
  rank: number;
  activityAt: string;
  createdAt: string;
  updatedAt: string;
  relatedIssue: AttentionSubject | null;
  project: AttentionProjectRef | null;
  workspace: AttentionWorkspaceRef | null;
  expiresAt: string | null;
  ruleKey: string | null;
  originAgentName: string | null;
  queues: AttentionQueueRef[];
  shelf: boolean;
  retentionDays: number;
  keep: boolean;
  archivedAt: string | null;
  retentionVersion: number;
  decideBy: string | null;
  decideByAttribution: AttentionTriageAttribution | null;
  snoozedUntil: string | null;
  detail: AttentionItemDetail | null;
  trainingExampleId: string | null;
  /**
   * Set for `issue_thread_interaction` rows only. Absent on every other source
   * kind, whose decisions are not governed by a resolver policy.
   */
  resolverAudience?: AttentionResolverAudience | null;
}

export interface AttentionFeed {
  companyId: string;
  /**
   * ISO timestamp of the snapshot this feed was built from. A read served from
   * a cached snapshot keeps that snapshot's build time, so the value can trail
   * the response by up to the attention feed cache windows — it is not the
   * request time.
   */
  generatedAt: string;
  totalCount: number;
  /**
   * The sidebar badge: distinct items that either surfaced today ("new today")
   * or carry an explicit decide-by deadline that is due today/past ("overdue").
   * Computed before pagination so a small first page still reflects the
   * company-wide load. The desk no longer editorializes about what "can wait".
   */
  deskBadgeCount: number;
  nextCursor: string | null;
  countsBySourceKind: Record<AttentionSourceKind, number>;
  items: AttentionItem[];
}
