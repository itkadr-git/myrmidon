// myrmidon(DEBRAND-c): persist browser state under the Myrmidon namespace.
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { groupWarningsByStage, LOW_TRUST_REVIEW_PRESET } from "@paperclipai/shared";
import type {
  Agent,
  AskUserQuestionsAnswer,
  AskUserQuestionsInteraction,
  FeedbackVote,
  Issue,
  IssueThreadInteraction,
  IssueWorkMode,
  PipelineAutomationRetryCleanupOptions,
  PipelineAutomationRetryPlan,
  PipelineAutomationRetryScope,
  PipelineCaseAttachmentOutputItem,
  PipelineCaseDocumentOutputItem,
  PipelineCaseOutputItem,
  PipelineCaseWorkProductOutputItem,
  RequestCheckboxConfirmationInteraction,
  RequestConfirmationInteraction,
  SuggestTasksInteraction,
} from "@paperclipai/shared";
import { AlertTriangle, ArrowUpDown, ArrowUpRight, BookOpenText, Check, ChevronDown, ChevronRight, ChevronUp, CircleDot, Download, ExternalLink, FileText, GitBranch, Hexagon, Image as ImageIcon, Info, Layers, List, ListTree, Loader2, MessageSquare, MoreHorizontal, Package, Paperclip, Plus, Search, Settings, Trash2, X } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Link, useLocation, useNavigate, useParams } from "@/lib/router";
import { ApiError } from "../api/client";
import { activityApi, type RunForIssue } from "../api/activity";
import { heartbeatsApi, type ActiveRunForIssue, type LiveRunForIssue } from "../api/heartbeats";
import {
  pipelinesApi,
  type PipelineAttentionFeed,
  type PipelineBatchIngestResult,
  type PipelineCase,
  type PipelineCaseActiveWork,
  type PipelineCaseDetail,
  type PipelineCaseEvent,
  type PipelineCaseParentSummary,
  type PipelineConnectionRef,
  type PipelineConnections,
  type PipelineIntakeField,
  type PipelineIntakeForm,
  type PipelineListItem,
  type PipelineReviewDecision,
  type PipelineReviewCaseRow,
  type PipelineStage,
} from "../api/pipelines";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { instanceSettingsApi } from "../api/instanceSettings";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { EmptyState } from "../components/EmptyState";
import { AgentIcon } from "../components/AgentIconPicker";
import { IssueChatThread } from "../components/IssueChatThread";
import { MarkdownBody } from "../components/MarkdownBody";
import { PageSkeleton } from "../components/PageSkeleton";
import { PipelineHealthBar } from "../components/PipelineHealthWarnings";
import { PipelineItemBodyDocument } from "../components/PipelineItemBodyDocument";
import { PipelineLivenessBanner } from "../components/PipelineLivenessBanner";
import { PipelineWorkReferences } from "../components/PipelineWorkReferences";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import { assigneeValueFromSelection, parseAssigneeValue, suggestedCommentAssigneeValue } from "../lib/assignees";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, isAgentTaskTarget } from "../lib/company-members";
import { useStandardMarkdownMentionOptions } from "../hooks/useStandardMarkdownMentionOptions";
import {
  displayPipelineItemFields,
  formatPipelineItemEvent,
  getPendingTransitionBannerState,
  humanizePipelineItemStatus,
  changedNoticeFromEvents,
  itemHasChangedNotice,
  normalizePipelineChildRows,
  pipelineConversationStarterAssigneeValue,
  splitPipelineItemFields,
} from "../lib/pipeline-item-detail";
import { extractWorkReferences, referenceFieldKeys } from "../lib/pipeline-references";
import { pieceNounPlural, readStageBreakdown } from "../lib/pipeline-breakdown";
import { hasBlockingShortcutDialog, isKeyboardShortcutTextInputTarget } from "../lib/keyboardShortcuts";
import { formatLearningEvent, groupLearningEventsByDay } from "../lib/pipeline-learnings";
import { getPipelineStageColumnTone, pipelineStageAutomationSettingsHref } from "../lib/pipeline-stage-presentation";
import { queryKeys } from "../lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "../lib/query-placeholder-data";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { shouldDisableRerunForPermission, type LivenessRetryKind } from "../lib/pipeline-liveness";
import { cn, formatNumber, relativeTime } from "../lib/utils";
import { i18n, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import { issueStatusText, issueStatusTextDefault } from "../lib/status-colors";
import { formatBytes } from "../lib/issue-output";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "../lib/issueDetailBreadcrumb";
import { resolveIssueActiveRun, shouldTrackIssueActiveRun } from "../lib/issueActiveRun";
import { extractIssueTimelineEvents } from "../lib/issue-timeline-events";
import { applyLocalQueuedIssueCommentState, isQueuedIssueComment } from "../lib/optimistic-issue-comments";
import type { IssueChatComment } from "../lib/issue-chat-messages";
import { Badge } from "@/components/ui/badge";

type PipelineConversationActionableInteraction =
  | SuggestTasksInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction;

type PipelineBoardAutomationAgent = Pick<Agent, "id" | "name" | "icon" | "urlKey">;

export function normalizePipelineConversationComments(value: unknown): IssueChatComment[] {
  return Array.isArray(value) ? value : [];
}

interface DraftRow {
  id: string;
  expanded: boolean;
  values: Record<string, string>;
  serverError?: string | null;
}

function issueDetailPath(issue: Pick<Issue, "id" | "identifier">) {
  return createIssueDetailPath(issue.identifier ?? issue.id);
}

function resolveRunningPipelineConversationRun(
  activeRun: ActiveRunForIssue | null | undefined,
  liveRuns: readonly LiveRunForIssue[] | undefined,
) {
  return activeRun?.status === "running"
    ? activeRun
    : (liveRuns ?? []).find((run) => run.status === "running") ?? null;
}

type FieldErrors = Record<string, string>;
type RowErrors = Record<string, FieldErrors>;

let draftCounter = 0;

function newDraftRow(expanded = true): DraftRow {
  draftCounter += 1;
  return { id: `draft-${draftCounter}`, expanded, values: {}, serverError: null };
}

function isBlank(value: string | undefined) {
  return !value || value.trim().length === 0;
}

export function validateDraftRows(rows: DraftRow[], fields: PipelineIntakeField[]): RowErrors {
  const errors: RowErrors = {};
  for (const row of rows) {
    const rowErrors: FieldErrors = {};
    for (const field of fields) {
      if (field.required && isBlank(row.values[field.key])) {
        rowErrors[field.key] = i18n.t("area.pipelines-cases.pipelines.validation.required", { label: field.label });
      }
    }
    if (Object.keys(rowErrors).length > 0) {
      errors[row.id] = rowErrors;
    }
  }
  return errors;
}

export function buildBatchPayload(rows: DraftRow[], fields: PipelineIntakeField[]) {
  return rows.map((row) => {
    const title = row.values.title?.trim() ?? "";
    const itemFields: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.key === "title") continue;
      const value = row.values[field.key];
      if (value !== undefined && value.trim().length > 0) {
        itemFields[field.key] = value.trim();
      }
    }
    return { title, fields: itemFields };
  });
}

export function plainBatchError(result: Extract<PipelineBatchIngestResult, { ok: false }>) {
  const details = result.error?.details ?? {};
  if (details.code === "required_field" && typeof details.label === "string") {
    return i18n.t("area.pipelines-cases.pipelines.validation.required", { label: details.label });
  }
  if (details.code === "invalid_select_value" && typeof details.label === "string") {
    return i18n.t("area.pipelines-cases.pipelines.validation.invalidSelect", { label: details.label });
  }
  if (details.code === "duplicate_batch_key") {
    return i18n.t("area.pipelines-cases.pipelines.validation.duplicateRow");
  }
  if (details.code === "blocker_cycle") {
    return i18n.t("area.pipelines-cases.pipelines.validation.blockerCycle");
  }
  if (typeof result.error?.message === "string" && result.error.message.trim()) {
    return result.error.message.replace(/^Pipeline\s+/i, "");
  }
  return i18n.t("area.pipelines-cases.pipelines.validation.needsAttention");
}

function itemCountLabel(count: number) {
  return i18n.t("area.pipelines-cases.pipelines.itemsCount", { count });
}

function currentStageAutomation(stage: PipelineStage) {
  const onEnter = stage.config?.onEnter;
  if (!onEnter || typeof onEnter !== "object" || Array.isArray(onEnter)) return null;
  const config = onEnter as Record<string, unknown>;
  return config.type === "run_routine" && typeof config.routineId === "string" && config.routineId.trim()
    ? { routineId: config.routineId }
    : null;
}

function readNonEmptyConfigString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readPipelineStageAutomationAssigneeAgentId(stage: Pick<PipelineStage, "config">) {
  const config = stage.config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;

  const automation = config.automation;
  if (automation && typeof automation === "object" && !Array.isArray(automation)) {
    const assigneeAgentId = readNonEmptyConfigString((automation as Record<string, unknown>).assigneeAgentId);
    if (assigneeAgentId) return assigneeAgentId;
  }

  return readNonEmptyConfigString(config.assigneeAgentId);
}

function RetryMetric({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "warning";
}) {
  return (
    <div className={cn(
      "rounded-sm border px-3 py-2",
      tone === "warning"
        ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100"
        : "border-border bg-background text-foreground",
    )}>
      <div className="text-base font-semibold">{formatNumber(value)}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

type RetryCleanupId = keyof PipelineAutomationRetryCleanupOptions | "keepAuditHistory";

function retryCleanupItems(plan: PipelineAutomationRetryPlan): Array<{
  id: RetryCleanupId;
  label: string;
  description: string;
  count?: number;
  disabled?: boolean;
  required?: boolean;
}> {
  return [
    {
      id: "retireDirectChildren",
      label: i18n.t("area.pipelines-cases.pipelines.retry.retireDirectChildren.label"),
      description: i18n.t("area.pipelines-cases.pipelines.retry.retireDirectChildren.description"),
      count: plan.effectCounts.directChildren,
      disabled: plan.effectCounts.directChildren === 0,
    },
    {
      id: "retireDescendants",
      label: i18n.t("area.pipelines-cases.pipelines.retry.retireDescendants.label"),
      description: i18n.t("area.pipelines-cases.pipelines.retry.retireDescendants.description"),
      count: plan.effectCounts.descendants,
      disabled: plan.effectCounts.descendants === 0,
    },
    {
      id: "cancelLinkedAutomationIssues",
      label: i18n.t("area.pipelines-cases.pipelines.retry.cancelLinkedAutomationIssues.label"),
      description: i18n.t("area.pipelines-cases.pipelines.retry.cancelLinkedAutomationIssues.description"),
      count: plan.effectCounts.linkedAutomationIssues,
      disabled: plan.effectCounts.linkedAutomationIssues === 0,
    },
    {
      id: "keepAuditHistory",
      label: i18n.t("area.pipelines-cases.pipelines.retry.keepAuditHistory.label"),
      description: i18n.t("area.pipelines-cases.pipelines.retry.keepAuditHistory.description"),
      required: true,
      disabled: true,
    },
  ];
}

function selectedCleanupIds(plan: PipelineAutomationRetryPlan) {
  const selected = new Set<string>(["keepAuditHistory"]);
  if (plan.defaultCleanup.retireDirectChildren) selected.add("retireDirectChildren");
  if (plan.defaultCleanup.retireDescendants) selected.add("retireDescendants");
  if (plan.defaultCleanup.cancelLinkedAutomationIssues) selected.add("cancelLinkedAutomationIssues");
  return selected;
}

function retryCleanupFromIds(ids: Set<string>): PipelineAutomationRetryCleanupOptions {
  return {
    retireDirectChildren: ids.has("retireDirectChildren"),
    retireDescendants: ids.has("retireDescendants"),
    cancelLinkedAutomationIssues: ids.has("cancelLinkedAutomationIssues"),
  };
}

function retryPrimaryActionLabel(plan: PipelineAutomationRetryPlan) {
  const retiredOutputCount = plan.effectCounts.directChildren + plan.effectCounts.descendants;
  if (retiredOutputCount > 0 && (plan.defaultCleanup.retireDirectChildren || plan.defaultCleanup.retireDescendants)) {
    return i18n.t("area.pipelines-cases.pipelines.retry.retryAndRetire", { count: retiredOutputCount, formatted: formatNumber(retiredOutputCount) });
  }
  return plan.scope === "previous_stage" ? i18n.t("area.pipelines-cases.pipelines.retry.previousStep") : i18n.t("area.pipelines-cases.pipelines.retry.rerunStep");
}

export function Pipelines() {
  const params = useParams<{ pipelineId?: string }>();
  const location = useLocation();
  const pipelineId = params.pipelineId ?? null;
  const addMode = Boolean(pipelineId && location.pathname.endsWith("/add"));

  if (pipelineId && addMode) return <PipelineAddItems pipelineId={pipelineId} />;
  if (pipelineId) return <PipelineBoard pipelineId={pipelineId} />;
  return <PipelinesIndex />;
}

// ---------------------------------------------------------------------------
// Pipelines index
// ---------------------------------------------------------------------------

export type PipelineViewMode = "nested" | "flat";

export interface PipelineTableRow {
  pipeline: PipelineListItem;
  depth: number;
  parentPipelineName: string | null;
  hasChildren: boolean;
  expanded: boolean;
}

function connectionId(ref: PipelineConnectionRef | null | undefined): string | null {
  if (!ref) return null;
  if (typeof ref === "string") return ref;
  return (
    ref.pipelineId ??
    ref.downstreamPipelineId ??
    ref.feedsIntoPipelineId ??
    ref.id ??
    null
  );
}

function connectionListIds(refs: PipelineConnectionRef[] | null | undefined): string[] {
  if (!Array.isArray(refs)) return [];
  return refs.map(connectionId).filter((id): id is string => Boolean(id));
}

function downstreamPipelineIds(connections: PipelineConnections | null | undefined): string[] {
  if (!connections) return [];

  const ids = [
    connections.feedsIntoPipelineId,
    connections.downstreamPipelineId,
    ...(connections.downstreamPipelineIds ?? []),
    ...connectionListIds(connections.feedsInto),
    ...connectionListIds(connections.downstream),
  ];

  return ids.filter((id): id is string => Boolean(id));
}

function hasConnectionsField(pipeline: PipelineListItem): boolean {
  return Object.prototype.hasOwnProperty.call(pipeline, "connections");
}

function pipelineOpenItemCount(pipeline: PipelineListItem) {
  return pipeline.openCaseCount ?? 0;
}

function pipelineAttentionCount(pipeline: PipelineListItem) {
  return pipeline.attentionCount ?? 0;
}

function pipelineInMotionCount(pipeline: PipelineListItem) {
  return pipeline.inMotionCount ?? 0;
}

function descendantActiveWorkCount(value: { descendantActiveWorkCount?: number | null }) {
  return value.descendantActiveWorkCount ?? 0;
}

function formatLiveDownstream(count: number) {
  return i18n.t("area.pipelines-cases.pipelines.liveDownstream", { n: formatNumber(count) });
}

function pipelineActivityTime(pipeline: PipelineListItem) {
  return pipeline.lastActivityAt ?? pipeline.updatedAt ?? pipeline.createdAt ?? null;
}

type PipelineSortField = "name" | "activity" | "review" | "inMotion" | "openItems";
type PipelineSortDir = "asc" | "desc";

function pipelineSortOptions(): ReadonlyArray<readonly [PipelineSortField, string]> {
  return [
    ["name", i18n.t("area.pipelines-cases.pipelines.sort.name")],
    ["activity", i18n.t("area.pipelines-cases.pipelines.sort.activity")],
    ["review", i18n.t("area.pipelines-cases.pipelines.sort.review")],
    ["inMotion", i18n.t("area.pipelines-cases.pipelines.sort.inMotion")],
    ["openItems", i18n.t("area.pipelines-cases.pipelines.sort.openItems")],
  ];
}

function comparePipelinesBySort(field: PipelineSortField, dir: PipelineSortDir) {
  const factor = dir === "asc" ? 1 : -1;
  return (left: PipelineListItem, right: PipelineListItem) => {
    let cmp = 0;
    switch (field) {
      case "name":
        cmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
        break;
      case "activity": {
        const leftTime = new Date(pipelineActivityTime(left) ?? 0).getTime() || 0;
        const rightTime = new Date(pipelineActivityTime(right) ?? 0).getTime() || 0;
        cmp = leftTime - rightTime;
        break;
      }
      case "review":
        cmp = pipelineAttentionCount(left) - pipelineAttentionCount(right);
        break;
      case "inMotion":
        cmp = pipelineInMotionCount(left) - pipelineInMotionCount(right);
        break;
      case "openItems":
        cmp = pipelineOpenItemCount(left) - pipelineOpenItemCount(right);
        break;
    }
    if (cmp === 0) cmp = left.name.localeCompare(right.name, undefined, { sensitivity: "base" });
    return cmp * factor;
  };
}

function compareByInputOrder(order: Map<string, number>) {
  return (left: PipelineListItem, right: PipelineListItem) =>
    (order.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(right.id) ?? Number.MAX_SAFE_INTEGER);
}

export function pipelinesHaveConnectionData(pipelines: PipelineListItem[]) {
  return pipelines.some(hasConnectionsField);
}

export function buildPipelineTableRows(
  pipelines: PipelineListItem[],
  options: {
    viewMode: PipelineViewMode;
    collapsedPipelineIds?: Set<string>;
  },
): PipelineTableRow[] {
  if (options.viewMode === "flat") {
    return pipelines.map((pipeline) => ({
      pipeline,
      depth: 0,
      parentPipelineName: null,
      hasChildren: false,
      expanded: true,
    }));
  }

  const pipelinesById = new Map(pipelines.map((pipeline) => [pipeline.id, pipeline]));
  const inputOrder = new Map(pipelines.map((pipeline, index) => [pipeline.id, index]));
  const parentByChild = new Map<string, string>();

  for (const pipeline of pipelines) {
    const downstreamId = downstreamPipelineIds(pipeline.connections).find((id) => pipelinesById.has(id));
    if (downstreamId && downstreamId !== pipeline.id && !parentByChild.has(downstreamId)) {
      parentByChild.set(downstreamId, pipeline.id);
    }
  }

  const childrenByParent = new Map<string, PipelineListItem[]>();
  for (const [childId, parentId] of parentByChild.entries()) {
    const child = pipelinesById.get(childId);
    if (!child) continue;
    const children = childrenByParent.get(parentId) ?? [];
    children.push(child);
    childrenByParent.set(parentId, children);
  }
  for (const children of childrenByParent.values()) {
    children.sort(compareByInputOrder(inputOrder));
  }

  const rows: PipelineTableRow[] = [];
  const visited = new Set<string>();
  const collapsed = options.collapsedPipelineIds ?? new Set<string>();

  function markSubtreeVisited(pipeline: PipelineListItem) {
    for (const child of childrenByParent.get(pipeline.id) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      markSubtreeVisited(child);
    }
  }

  function visit(pipeline: PipelineListItem, depth: number, stack: Set<string>) {
    if (visited.has(pipeline.id) || stack.has(pipeline.id)) return;
    visited.add(pipeline.id);

    const children = childrenByParent.get(pipeline.id) ?? [];
    const parentId = parentByChild.get(pipeline.id);
    rows.push({
      pipeline,
      depth,
      parentPipelineName: parentId ? pipelinesById.get(parentId)?.name ?? null : null,
      hasChildren: children.length > 0,
      expanded: !collapsed.has(pipeline.id),
    });

    if (collapsed.has(pipeline.id)) {
      markSubtreeVisited(pipeline);
      return;
    }

    const nextStack = new Set(stack);
    nextStack.add(pipeline.id);
    for (const child of children) {
      visit(child, depth + 1, nextStack);
    }
  }

  const roots = pipelines
    .filter((pipeline) => !parentByChild.has(pipeline.id))
    .sort(compareByInputOrder(inputOrder));
  for (const root of roots) visit(root, 0, new Set<string>());
  for (const pipeline of pipelines) visit(pipeline, 0, new Set<string>());

  return rows;
}

function formatOpenItems(count: number) {
  return i18n.t("area.pipelines-cases.pipelines.openCount", { n: formatNumber(count) });
}

function formatPipelineActivity(value: string | Date | null) {
  if (!value) return i18n.t("area.pipelines-cases.pipelines.activity.none");
  const then = new Date(value).getTime();
  if (!Number.isFinite(then)) return i18n.t("area.pipelines-cases.pipelines.activity.none");
  const diffSeconds = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (diffSeconds < 60) return i18n.t("area.pipelines-cases.pipelines.activity.justNow");
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return i18n.t("area.pipelines-cases.pipelines.activity.minutesAgo", { n: diffMinutes });
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return diffHours === 1 ? i18n.t("area.pipelines-cases.pipelines.activity.oneHourAgo") : i18n.t("area.pipelines-cases.pipelines.activity.hoursAgo", { n: diffHours });
  const diffDays = Math.round(diffHours / 24);
  if (diffDays === 1) return i18n.t("area.pipelines-cases.pipelines.activity.yesterday");
  if (diffDays < 7) return i18n.t("area.pipelines-cases.pipelines.activity.daysAgo", { n: diffDays });
  if (diffDays < 14) return i18n.t("area.pipelines-cases.pipelines.activity.lastWeek");
  if (diffDays < 30) return i18n.t("area.pipelines-cases.pipelines.activity.weeksAgo", { n: Math.round(diffDays / 7) });
  return new Date(value).toLocaleDateString(i18n.language, { month: "short", day: "numeric" });
}

function PipelineStatusChip({ archivedAt }: { archivedAt: Date | string | null }) {
  const { t } = useTranslation();
  const paused = Boolean(archivedAt);
  return (
    <Badge variant="outline"
      className={cn(
        "font-semibold",
        paused
          ? "border-muted-foreground/20 bg-muted text-muted-foreground"
          : "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300",
      )}
    >
      {paused ? t("area.pipelines-cases.pipelines.status.paused") : t("area.pipelines-cases.pipelines.status.active")}
    </Badge>
  );
}

interface PipelinesIndexTableProps {
  pipelines: PipelineListItem[];
  viewMode: PipelineViewMode;
  onViewModeChange: (mode: PipelineViewMode) => void;
  connectionsAvailable: boolean;
  search: string;
  onSearchChange: (search: string) => void;
}

export function PipelinesIndexTable({
  pipelines,
  viewMode,
  onViewModeChange,
  connectionsAvailable,
  search,
  onSearchChange,
}: PipelinesIndexTableProps) {
  const { t } = useTranslation();
  const [collapsedPipelineIds, setCollapsedPipelineIds] = useState<Set<string>>(() => new Set());
  const [sortField, setSortField] = useState<PipelineSortField>("name");
  const [sortDir, setSortDir] = useState<PipelineSortDir>("asc");
  const filteredPipelines = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return pipelines;
    return pipelines.filter((pipeline) => pipeline.name.toLowerCase().includes(q));
  }, [pipelines, search]);
  const sortedPipelines = useMemo(
    () => [...filteredPipelines].sort(comparePipelinesBySort(sortField, sortDir)),
    [filteredPipelines, sortField, sortDir],
  );
  const effectiveViewMode = connectionsAvailable ? viewMode : "flat";
  const rows = useMemo(
    () =>
      buildPipelineTableRows(sortedPipelines, {
        viewMode: effectiveViewMode,
        collapsedPipelineIds,
      }),
    [collapsedPipelineIds, effectiveViewMode, sortedPipelines],
  );

  const selectSort = (field: PipelineSortField) => {
    if (sortField === field) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "name" ? "asc" : "desc");
    }
  };

  const togglePipeline = (pipelineId: string) => {
    setCollapsedPipelineIds((current) => {
      const next = new Set(current);
      if (next.has(pipelineId)) next.delete(pipelineId);
      else next.add(pipelineId);
      return next;
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 border-y border-border py-4 lg:flex-row lg:items-center lg:justify-between">
        <label className="relative block w-full max-w-md">
          <span className="sr-only">{t("area.pipelines-cases.pipelines.index.search")}</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder={t("area.pipelines-cases.pipelines.index.search")}
            className="h-10 pl-9"
          />
        </label>
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex items-center overflow-hidden rounded-md border border-border">
            <button
              type="button"
              className={cn(
                "p-1.5 transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                effectiveViewMode === "nested" && connectionsAvailable
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              disabled={!connectionsAvailable}
              onClick={() => onViewModeChange("nested")}
              title={t("area.pipelines-cases.pipelines.index.nestedView")}
            >
              <ListTree className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              className={cn(
                "p-1.5 transition-colors",
                effectiveViewMode === "flat"
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => onViewModeChange("flat")}
              title={t("area.pipelines-cases.pipelines.index.flatList")}
            >
              <List className="h-3.5 w-3.5" />
            </button>
          </div>

          <Popover>
            <PopoverTrigger asChild>
              <Button variant="outline" size="icon" className="h-8 w-8 shrink-0" title={t("common.sort")}>
                <ArrowUpDown className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-48 p-0">
              <div className="space-y-0.5 p-2">
                {pipelineSortOptions().map(([field, label]) => (
                  <button
                    key={field}
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm",
                      sortField === field ? "bg-accent/50 text-foreground" : "text-muted-foreground hover:bg-accent/50",
                    )}
                    onClick={() => selectSort(field)}
                  >
                    <span>{label}</span>
                    {sortField === field && (
                      <span className="text-xs text-muted-foreground">{sortDir === "asc" ? "↑" : "↓"}</span>
                    )}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        </div>
      </div>

      {rows.length === 0 ? (
        <EmptyState icon={Hexagon} message={t("area.pipelines-cases.pipelines.index.noMatch")} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-(--sz-780px) border-collapse text-sm">
            <thead>
              <tr className="border-b border-border text-left text-(length:--text-micro) font-semibold uppercase tracking-widest text-muted-foreground">
                <th className="py-2 pl-3 pr-4">{t("area.pipelines-cases.pipelines.index.colName")}</th>
                <th className="px-4 py-2">{t("area.pipelines-cases.pipelines.index.colAttention")}</th>
                <th className="px-4 py-2">{t("area.pipelines-cases.pipelines.index.colOpenItems")}</th>
                <th className="px-4 py-2">{t("area.pipelines-cases.pipelines.index.colStatus")}</th>
                <th className="px-4 py-2">{t("area.pipelines-cases.pipelines.index.colLastActivity")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const attentionCount = pipelineAttentionCount(row.pipeline);
                const inMotionCount = pipelineInMotionCount(row.pipeline);
                const liveDownstreamCount = descendantActiveWorkCount(row.pipeline);
                return (
                  <tr key={row.pipeline.id} className="h-10 border-b border-border/70">
                    <td className="pl-3 pr-4">
                      <div className="flex min-w-0 items-center gap-2" style={{ paddingLeft: row.depth * 28 }}>
                        {row.hasChildren ? (
                          <button
                            type="button"
                            className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent/60 hover:text-foreground"
                            aria-label={t(row.expanded ? "area.pipelines-cases.pipelines.index.collapse" : "area.pipelines-cases.pipelines.index.expand", { name: row.pipeline.name })}
                            onClick={() => togglePipeline(row.pipeline.id)}
                          >
                            {row.expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                          </button>
                        ) : (
                          <span className="h-6 w-6 shrink-0" aria-hidden="true" />
                        )}
                        <div className="min-w-0">
                          <Link
                            to={`/pipelines/${row.pipeline.id}`}
                            className="font-semibold text-foreground hover:underline"
                          >
                            {row.pipeline.name}
                          </Link>
                          {row.parentPipelineName ? (
                            <span className="ml-2 text-muted-foreground">{t("area.pipelines-cases.pipelines.index.under", { name: row.parentPipelineName })}</span>
                          ) : row.pipeline.description ? (
                            <span className="ml-2 text-muted-foreground">- {row.pipeline.description}</span>
                          ) : null}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 text-sm">
                      <div className="flex items-center gap-3 whitespace-nowrap">
                        {attentionCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 font-semibold text-red-700 dark:text-red-400">
                            <span className="h-2 w-2 rounded-full bg-red-600" aria-hidden="true" />
                            {t("area.pipelines-cases.pipelines.index.toReview", { n: formatNumber(attentionCount) })}
                          </span>
                        ) : null}
                        {inMotionCount > 0 ? (
                          <span className="text-muted-foreground">
                            {t("area.pipelines-cases.pipelines.index.inMotion", { n: formatNumber(inMotionCount) })}
                          </span>
                        ) : null}
                        {liveDownstreamCount > 0 ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                            {formatLiveDownstream(liveDownstreamCount)}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 text-muted-foreground">{formatOpenItems(pipelineOpenItemCount(row.pipeline))}</td>
                    <td className="px-4"><PipelineStatusChip archivedAt={row.pipeline.archivedAt} /></td>
                    <td className="px-4 text-muted-foreground">{formatPipelineActivity(pipelineActivityTime(row.pipeline))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-4 text-sm text-muted-foreground">
            {t("area.pipelines-cases.pipelines.index.showing", { shown: formatNumber(rows.length), total: formatNumber(filteredPipelines.length) })}
          </p>
        </div>
      )}
    </div>
  );
}

function NewPipelineDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
  error,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: { name: string; description: string }) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) {
      setName("");
      setDescription("");
    }
  }, [open]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedName = name.trim();
    if (!trimmedName) return;
    onSubmit({ name: trimmedName, description: description.trim() });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{t("area.pipelines-cases.pipelines.newDialog.title")}</DialogTitle>
            <DialogDescription>{t("area.pipelines-cases.pipelines.newDialog.description")}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{t("area.pipelines-cases.pipelines.newDialog.name")}</span>
              <Input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
            </label>
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{t("area.pipelines-cases.pipelines.newDialog.descriptionLabel")}</span>
              <Textarea
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                rows={3}
              />
            </label>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
              {t("common.cancel")}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? t("area.pipelines-cases.pipelines.newDialog.creating") : t("area.pipelines-cases.pipelines.newDialog.create")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function pipelineKeyFromName(name: string) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/g, "");
  return slug || "pipeline";
}

function PipelinesIndex() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState<PipelineViewMode>("nested");
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);

  useEffect(() => setBreadcrumbs([{ label: t("area.pipelines-cases.pipelines.title") }]), [setBreadcrumbs, t]);

  const pipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "missing-company"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const createPipeline = useMutation({
    mutationFn: async (data: { name: string; description: string }) => {
      const baseKey = pipelineKeyFromName(data.name);
      try {
        return await pipelinesApi.create(selectedCompanyId!, {
          key: baseKey,
          name: data.name,
          description: data.description || null,
        });
      } catch (error) {
        if (error instanceof ApiError && error.status === 409) {
          return await pipelinesApi.create(selectedCompanyId!, {
            key: `${baseKey}-${Date.now().toString(36)}`,
            name: data.name,
            description: data.description || null,
          });
        }
        throw error;
      }
    },
    onSuccess: async (pipeline) => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId!) });
      setNewPipelineOpen(false);
      navigate(`/pipelines/${pipeline.id}/settings`);
    },
  });

  if (!selectedCompanyId) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.index.selectOrg")}</div>;
  }
  if (pipelinesQuery.isLoading) return <PageSkeleton />;

  const pipelines = pipelinesQuery.data ?? [];
  const connectionsAvailable = pipelinesHaveConnectionData(pipelines);

  return (
    <div className="w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.index.eyebrow")}</p>
          <h1 className="text-2xl font-semibold text-foreground">{t("area.pipelines-cases.pipelines.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("area.pipelines-cases.pipelines.index.summary", { count: pipelines.length, formatted: formatNumber(pipelines.length) })}
          </p>
        </div>
        <Button onClick={() => setNewPipelineOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("area.pipelines-cases.pipelines.newDialog.title")}
        </Button>
      </div>

      {pipelinesQuery.error ? (
        <p className="mb-4 text-sm text-destructive">{t("area.pipelines-cases.pipelines.index.loadError")}</p>
      ) : null}

      {pipelines.length === 0 && !pipelinesQuery.error ? (
        <EmptyState
          icon={Hexagon}
          message={t("area.pipelines-cases.pipelines.index.empty")}
          action={t("area.pipelines-cases.pipelines.newDialog.title")}
          onAction={() => setNewPipelineOpen(true)}
        />
      ) : (
        <PipelinesIndexTable
          pipelines={pipelines}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          connectionsAvailable={connectionsAvailable}
          search={search}
          onSearchChange={setSearch}
        />
      )}

      <NewPipelineDialog
        open={newPipelineOpen}
        onOpenChange={(open) => {
          setNewPipelineOpen(open);
          if (!open) createPipeline.reset();
        }}
        onSubmit={(data) => createPipeline.mutate(data)}
        pending={createPipeline.isPending}
        error={createPipeline.error ? t("area.pipelines-cases.pipelines.newDialog.createError") : null}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pipeline board
// ---------------------------------------------------------------------------

const UNASSIGNED_STAGE_ID = "__pipeline_unassigned_stage";
function unassignedStageName() {
  return i18n.t("area.pipelines-cases.pipelines.board.unassigned");
}

type BoardCase = PipelineCase & {
  activeWork?: PipelineCaseActiveWork | null;
  descendantActiveWorkCount?: number | null;
  parentCase?: PipelineCaseParentSummary | null;
};

type PipelineTransitionEdge = { fromStageId: string; toStageId: string; label?: string | null };
type PipelineBoardGroupBy = "none" | "builtFor";

const PIPELINE_BOARD_UNGROUPED_KEY = "__ungrouped";
const PIPELINE_BOARD_GROUP_BY_STORAGE_PREFIX = "myrmidon.pipelineBoard.groupBy.";

function asText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  return next.length === 0 ? null : next;
}

function asBoardBoolean(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value > 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
  }
  return false;
}

function asPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return null;
}

export function getCaseTitle(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  const candidateKeys = [
    "title",
    "name",
    "summary",
    "subject",
    "item_title",
    "itemTitle",
    "issueTitle",
    "ticketTitle",
  ] as const;

  const direct = asText(caseItem.title);
  if (direct) return direct;
  for (const key of candidateKeys) {
    const value = asText(fields[key]);
    if (value) return value;
  }
  return i18n.t("area.pipelines-cases.pipelines.board.untitledItem");
}

export function isWorkingCase(caseItem: BoardCase) {
  if (caseItem.activeWork && typeof caseItem.activeWork === "object") return true;
  const fields = caseItem.fields ?? {};
  return (
    asBoardBoolean(fields.activeWork) ||
    asBoardBoolean(fields.active_work) ||
    asBoardBoolean(fields.isActiveWork) ||
    asBoardBoolean(fields.working) ||
    asBoardBoolean(fields.isWorking)
  );
}

export function getOpenBlockerCount(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  return asPositiveInteger(fields.openBlockers) ?? 0;
}

export function hasThisChanged(caseItem: BoardCase) {
  const fields = caseItem.fields ?? {};
  if (fields.changeAcknowledgedAt) return false;
  return (
    asBoardBoolean(fields.thisChanged) ||
    asBoardBoolean(fields["this changed"]) ||
    asBoardBoolean(fields.this_changed) ||
    asBoardBoolean(fields.hasThisChanged) ||
    Boolean(fields.upstreamChanged) ||
    Boolean(fields.upstreamDrift)
  );
}

export function getChildrenSummaryCount(caseItem: BoardCase) {
  if (typeof caseItem.childCount === "number" && caseItem.childCount > 0) {
    return Math.floor(caseItem.childCount);
  }
  const fields = caseItem.fields ?? {};
  const fromFields = asPositiveInteger(fields.childrenSummary);
  if (fromFields != null && fromFields > 0) return fromFields;
  return null;
}

export function createUnassignedStage(pipelineId: string): PipelineStage {
  return {
    id: UNASSIGNED_STAGE_ID,
    pipelineId,
    key: "__unassigned",
    name: unassignedStageName(),
    kind: "working",
    position: Number.MAX_SAFE_INTEGER,
    config: {},
  };
}

export function isGuardedTransitionAllowed(
  transitions: PipelineTransitionEdge[],
  sourceStageId: string | null,
  targetStageId: string,
) {
  if (!transitions.length) return true;
  if (!sourceStageId) return false;
  if (sourceStageId === targetStageId) return true;

  for (const transition of transitions) {
    if (transition.fromStageId === sourceStageId && transition.toStageId === targetStageId) {
      return true;
    }
  }
  return false;
}

export function resolvePipelineTargetStageId(
  overId: string,
  columns: Set<string>,
  caseToColumnId: Map<string, string>,
) {
  if (columns.has(overId)) return overId;
  return caseToColumnId.get(overId) ?? null;
}

export function parsePipelineBoardGroupBy(value: unknown): PipelineBoardGroupBy {
  return value === "builtFor" ? "builtFor" : "none";
}

export function pipelineBoardGroupByStorageKey(pipelineId: string) {
  return `${PIPELINE_BOARD_GROUP_BY_STORAGE_PREFIX}${pipelineId}`;
}

function browserStorage() {
  if (typeof window === "undefined") return null;
  return window.localStorage;
}

export function readStoredPipelineBoardGroupBy(
  pipelineId: string,
  storage: Pick<Storage, "getItem"> | null = browserStorage(),
) {
  if (!storage) return "none";
  try {
    return parsePipelineBoardGroupBy(storage.getItem(pipelineBoardGroupByStorageKey(pipelineId)));
  } catch {
    return "none";
  }
}

export function writeStoredPipelineBoardGroupBy(
  pipelineId: string,
  groupBy: PipelineBoardGroupBy,
  storage: Pick<Storage, "setItem"> | null = browserStorage(),
) {
  try {
    storage?.setItem(pipelineBoardGroupByStorageKey(pipelineId), groupBy);
  } catch {
    // Client-side preference only; storage failures should not block the board.
  }
}

export function groupCasesByBuiltFor(cases: BoardCase[]) {
  const groups = new Map<string, {
    key: string;
    label: string;
    href: string | null;
    cases: BoardCase[];
  }>();

  for (const caseItem of cases) {
    const parent = caseItem.parentCase;
    const key = parent?.case.id ?? PIPELINE_BOARD_UNGROUPED_KEY;
    const group = groups.get(key) ?? {
      key,
      label: parent ? `${parent.pipeline.name}: ${parent.case.title}` : i18n.t("area.pipelines-cases.pipelines.board.noBuiltFor"),
      href: parent ? `/pipelines/${parent.case.pipelineId}/items/${parent.case.id}` : null,
      cases: [],
    };
    group.cases.push(caseItem);
    groups.set(key, group);
  }

  return [...groups.values()];
}

function PipelineCaseCard({
  caseItem,
  isOverlay = false,
}: {
  caseItem: BoardCase;
  isOverlay?: boolean;
}) {
  const { t } = useTranslation();
  const title = getCaseTitle(caseItem);
  const isWorking = isWorkingCase(caseItem);
  const blockerCount = getOpenBlockerCount(caseItem);
  const hasNeedsAttention = blockerCount > 0;
  const hasChangedNotice = hasThisChanged(caseItem);
  const childrenSummary = getChildrenSummaryCount(caseItem);
  const liveDownstreamCount = descendantActiveWorkCount(caseItem);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: caseItem.id, data: { caseItem } });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <Card
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`block px-3 py-2 text-sm ${
        isDragging && !isOverlay ? "opacity-40" : ""
      } ${isOverlay ? "shadow-lg ring-1 ring-primary/20" : "hover:shadow-sm"}`}
    >
      <Link
        to={`/pipelines/${caseItem.pipelineId}/items/${caseItem.id}`}
        onClick={(event) => {
          if (isDragging) event.preventDefault();
        }}
        className="block text-inherit no-underline"
      >
        <p className="font-medium leading-snug text-foreground">{title}</p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {isWorking ? (
            <Badge variant="outline" className="relative border-emerald-400/40 bg-emerald-50 text-(length:--text-nano) text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-900/30 dark:text-emerald-300">
              <span className="absolute -left-1 -top-1 h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
              {t("area.pipelines-cases.pipelines.board.working")}
            </Badge>
          ) : null}
          {hasNeedsAttention ? (
            <Badge variant="outline" className="border-amber-400/40 bg-amber-50 text-(length:--text-nano) text-amber-700 dark:border-amber-300/30 dark:bg-amber-900/25 dark:text-amber-300">
              {t("area.pipelines-cases.pipelines.board.needsAttention")}
            </Badge>
          ) : null}
          {hasChangedNotice ? (
            <Badge variant="outline" className="border-indigo-400/40 bg-indigo-50 text-(length:--text-nano) text-indigo-700 dark:border-indigo-300/30 dark:bg-indigo-900/25 dark:text-indigo-300">
              {t("area.pipelines-cases.pipelines.board.thisChanged")}
            </Badge>
          ) : null}
          {liveDownstreamCount > 0 ? (
            <Badge variant="outline" className="border-emerald-400/35 bg-emerald-50 text-(length:--text-nano) text-emerald-700 dark:border-emerald-300/30 dark:bg-emerald-900/25 dark:text-emerald-300">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              {formatLiveDownstream(liveDownstreamCount)}
            </Badge>
          ) : null}
        </div>
        {childrenSummary != null ? (
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t("area.pipelines-cases.pipelines.board.builtFrom", { count: childrenSummary, formatted: formatNumber(childrenSummary) })}
          </p>
        ) : null}
      </Link>
    </Card>
  );
}

function PipelineBoardColumn({
  stage,
  cases,
  groupBy,
  settingsHref,
  warningCount,
  breakdownTarget,
  automationAgent,
  automationHref,
  onColumnEmpty,
  isDragTargeted,
  isDragBlocked,
}: {
  stage: PipelineStage;
  cases: BoardCase[];
  groupBy: PipelineBoardGroupBy;
  settingsHref?: string | null;
  warningCount?: number;
  breakdownTarget?: { pipelineId: string; name: string } | null;
  automationAgent?: PipelineBoardAutomationAgent | null;
  automationHref?: string | null;
  onColumnEmpty?: (stage: PipelineStage) => string;
  isDragTargeted?: boolean;
  isDragBlocked?: boolean;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id: stage.id });

  const tone = getPipelineStageColumnTone(stage.kind);
  const isBlockedDropTarget = !!isDragTargeted && !!isDragBlocked;
  const caseGroups = groupBy === "builtFor"
    ? groupCasesByBuiltFor(cases)
    : [{ key: "all", label: "", href: null, cases }];
  const sortableCaseIds = caseGroups.flatMap((group) => group.cases.map((entry) => entry.id));

  return (
    <div
      key={stage.id}
      aria-label={t("area.pipelines-cases.pipelines.board.columnAria", { name: stage.name })}
      className={cn(
        "flex min-w-(--sz-260px) max-w-(--sz-320px) shrink-0 flex-col rounded-md border",
        tone.outer,
        isBlockedDropTarget && "ring-1 ring-red-500/45",
      )}
    >
      <div className={cn("group/stage-header flex items-center justify-between border-b px-3 py-2 text-sm font-semibold", tone.header)}>
        <div className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate">{stage.name}</span>
          {settingsHref ? (
            <Link
              to={settingsHref}
              aria-label={t("area.pipelines-cases.pipelines.board.editStage", { name: stage.name })}
              title={t("area.pipelines-cases.pipelines.board.editStage", { name: stage.name })}
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring group-hover/stage-header:opacity-100"
            >
              <Settings className="h-3.5 w-3.5" />
            </Link>
          ) : null}
        </div>
        <span className="ml-2 flex shrink-0 items-center gap-2 text-xs">
          <span>{itemCountLabel(cases.length)}</span>
          {warningCount ? (
            <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-300">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("area.pipelines-cases.pipelines.board.warningsCount", { count: warningCount })}
            </span>
          ) : null}
        </span>
      </div>
      {breakdownTarget || automationAgent ? (
        <div className={cn("flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5", tone.meta)}>
          {automationAgent && automationHref ? (
            <Link
              to={automationHref}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              title={t("area.pipelines-cases.pipelines.board.editAutomation", { name: stage.name })}
            >
              <AgentIcon icon={automationAgent.icon} className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{automationAgent.name}</span>
            </Link>
          ) : null}
          {breakdownTarget ? (
            <Link
              to={`/pipelines/${breakdownTarget.pipelineId}`}
              className="inline-flex max-w-full items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
              title={t("area.pipelines-cases.pipelines.board.breaksInto", { name: breakdownTarget.name })}
            >
              <span className="shrink-0">→</span>
              <span className="truncate">{t("area.pipelines-cases.pipelines.board.breaksInto", { name: breakdownTarget.name })}</span>
            </Link>
          ) : null}
        </div>
      ) : null}
      <div
        ref={setNodeRef}
        className={cn(
          "min-h-(--sz-160px) flex-1 space-y-2 rounded-b-md px-2 py-2 transition-colors",
          isBlockedDropTarget ? "bg-red-50 dark:bg-red-950/30" : isOver ? tone.bodyOver : tone.body,
        )}
      >
        {isBlockedDropTarget ? (
          <p className="rounded border border-red-200 bg-red-50 px-3 py-2 text-(length:--text-micro) text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-200">
            {t("area.pipelines-cases.pipelines.board.skipsFlow")}
          </p>
        ) : null}
        <SortableContext items={sortableCaseIds} strategy={verticalListSortingStrategy}>
          {cases.length > 0 ? (
            caseGroups.map((group) => (
              <div key={group.key} className="space-y-2">
                {groupBy === "builtFor" ? (
                  <div className="flex items-center justify-between gap-2 px-1 pt-1 text-(length:--text-micro) font-medium text-muted-foreground">
                    {group.href ? (
                      <Link to={group.href} className="min-w-0 truncate hover:text-foreground hover:underline">
                        {group.label}
                      </Link>
                    ) : (
                      <span className="min-w-0 truncate">{group.label}</span>
                    )}
                    <span className="shrink-0">{itemCountLabel(group.cases.length)}</span>
                  </div>
                ) : null}
                {group.cases.map((item) => <PipelineCaseCard key={item.id} caseItem={item} />)}
              </div>
            ))
          ) : (
            <div className="rounded-md border border-dashed border-border px-3 py-8 text-center text-xs text-muted-foreground">
              {onColumnEmpty ? onColumnEmpty(stage) : t("area.pipelines-cases.pipelines.board.empty")}
            </div>
          )}
        </SortableContext>
      </div>
    </div>
  );
}

function PipelineBoard({ pipelineId }: { pipelineId: string }) {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [activeCaseId, setActiveCaseId] = useState<string | null>(null);
  const [activeOverId, setActiveOverId] = useState<string | null>(null);
  const [groupByState, setGroupByState] = useState<{ pipelineId: string; value: PipelineBoardGroupBy }>(() => ({
    pipelineId,
    value: readStoredPipelineBoardGroupBy(pipelineId),
  }));
  const [pendingMove, setPendingMove] = useState<{
    caseId: string;
    caseVersion: number;
    itemTitle: string;
    sourceName: string;
    targetStageId: string;
    targetStageKey: string;
    targetName: string;
    allowed: boolean;
  } | null>(null);
  const [overrideReason, setOverrideReason] = useState("");

  const pipelineQuery = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });

  const casesQuery = useQuery({
    queryKey: queryKeys.pipelines.cases(pipelineId),
    queryFn: () => pipelinesApi.listCases(pipelineId),
  });

  const healthQuery = useQuery({
    queryKey: queryKeys.pipelines.health(pipelineId),
    queryFn: () => pipelinesApi.getHealth(pipelineId),
  });

  // The workspace pipeline list lets us resolve "Break into pieces" connector
  // chips by name — which pipeline this board feeds, and which feed into it.
  const allPipelinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.list(selectedCompanyId) : ["pipelines", "missing-company"],
    queryFn: () => pipelinesApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "pipeline-board", "missing-company"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const pipeline = pipelineQuery.data;
  const cases = useMemo<BoardCase[]>(
    () => (casesQuery.data ?? []).map((row) => ({
      ...row.case,
      parentCase: row.parentCase ?? null,
      activeWork: row.activeWork ?? null,
      descendantActiveWorkCount: row.descendantActiveWorkCount ?? 0,
    })),
    [casesQuery.data],
  );

  const orderedStages = useMemo(() => {
    if (!pipeline?.stages) return [] as PipelineStage[];
    return [...pipeline.stages].sort((left, right) => left.position - right.position);
  }, [pipeline?.stages]);
  const healthWarningsByStage = useMemo(
    () => groupWarningsByStage(healthQuery.data?.warnings ?? []),
    [healthQuery.data?.warnings],
  );

  const stageIds = useMemo(() => new Set(orderedStages.map((stage) => stage.id)), [orderedStages]);

  const boardColumns = useMemo(() => {
    const byStage = new Map<string, BoardCase[]>();
    const caseToColumn = new Map<string, string>();
    const caseById = new Map<string, BoardCase>();

    for (const stage of orderedStages) {
      byStage.set(stage.id, []);
    }

    const unassigned: BoardCase[] = [];
    for (const caseItem of cases) {
      const stageId = caseItem.stageId && stageIds.has(caseItem.stageId) ? caseItem.stageId : UNASSIGNED_STAGE_ID;
      if (stageId === UNASSIGNED_STAGE_ID) {
        unassigned.push(caseItem);
      } else {
        byStage.get(stageId)!.push(caseItem);
      }
      caseToColumn.set(caseItem.id, stageId);
      caseById.set(caseItem.id, caseItem);
    }

    const columns = [...orderedStages];
    if (unassigned.length > 0) {
      byStage.set(UNASSIGNED_STAGE_ID, unassigned);
      columns.push(createUnassignedStage(pipelineId));
    }

    return { columns, byStage, caseToColumn, caseById };
  }, [orderedStages, cases, stageIds, pipelineId]);

  const transitions = useMemo<PipelineTransitionEdge[]>(
    () => pipeline?.transitions ?? [],
    [pipeline?.transitions],
  );
  const guardrailsActive = Boolean(pipeline?.enforceTransitions);
  const columnsById = useMemo(() => new Set(boardColumns.columns.map((stage) => stage.id)), [boardColumns.columns]);

  const stageNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of boardColumns.columns) {
      map.set(stage.id, stage.name);
    }
    return map;
  }, [boardColumns.columns]);

  const stageKeyById = useMemo(() => {
    const map = new Map<string, string>();
    for (const stage of orderedStages) {
      map.set(stage.id, stage.key);
    }
    return map;
  }, [orderedStages]);

  const pipelineNameById = useMemo(
    () => new Map((allPipelinesQuery.data ?? []).map((entry) => [entry.id, entry.name])),
    [allPipelinesQuery.data],
  );

  const agentById = useMemo(
    () => new Map((agentsQuery.data ?? []).map((agent) => [agent.id, agent])),
    [agentsQuery.data],
  );

  // Per-stage outbound chip: "Breaks into <target>" on any stage configured to
  // break work into another pipeline.
  const breakdownTargetByStageId = useMemo(() => {
    const map = new Map<string, { pipelineId: string; name: string }>();
    for (const stage of orderedStages) {
      const breakdown = readStageBreakdown(stage);
      if (breakdown?.targetPipelineId) {
        map.set(stage.id, {
          pipelineId: breakdown.targetPipelineId,
          name: pipelineNameById.get(breakdown.targetPipelineId) ?? t("area.pipelines-cases.pipelines.board.anotherPipeline"),
        });
      }
    }
    return map;
  }, [orderedStages, pipelineNameById, t]);

  // Inbound chip on the board title bar: which other pipelines break into this
  // one, derived from their stage configs.
  const fedByPipelines = useMemo(() => {
    const seen = new Map<string, string>();
    for (const candidate of allPipelinesQuery.data ?? []) {
      if (candidate.id === pipelineId) continue;
      for (const stage of candidate.stages ?? []) {
        const breakdown = readStageBreakdown(stage);
        if (breakdown?.targetPipelineId === pipelineId) {
          seen.set(candidate.id, candidate.name);
          break;
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [allPipelinesQuery.data, pipelineId]);

  const moveAllowed = useCallback(
    (sourceStageId: string | null, targetStageId: string) => {
      if (!guardrailsActive) return true;
      return transitions.length > 0 && isGuardedTransitionAllowed(transitions, sourceStageId, targetStageId);
    },
    [guardrailsActive, transitions],
  );
  const groupBy = groupByState.pipelineId === pipelineId ? groupByState.value : "none";
  const handleGroupByChange = useCallback((value: string) => {
    const next = parsePipelineBoardGroupBy(value);
    writeStoredPipelineBoardGroupBy(pipelineId, next);
    setGroupByState({ pipelineId, value: next });
  }, [pipelineId]);

  const transitionCase = useMutation({
    mutationFn: ({
      caseId,
      toStageKey,
      expectedVersion,
      reason,
      force,
    }: {
      caseId: string;
      toStageKey: string;
      expectedVersion: number;
      reason?: string | null;
      force?: boolean;
    }) => pipelinesApi.transitionCase(caseId, { toStageKey, expectedVersion, reason, force }),
    onSuccess: async () => {
      setPendingMove(null);
      setOverrideReason("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      ]);
    },
    onError: (error) => {
      pushToast({
        title: t("area.pipelines-cases.pipelines.board.moveBlocked"),
        body:
          error instanceof ApiError && error.status === 409
            ? t("area.pipelines-cases.pipelines.board.moveConflict")
            : t("area.pipelines-cases.pipelines.board.moveFailed"),
        tone: "error",
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) });
    },
  });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  function handleDragStart(event: DragStartEvent) {
    setActiveCaseId(event.active.id as string);
    setActiveOverId(null);
  }

  function handleDragOver(event: DragOverEvent) {
    setActiveOverId(event.over ? String(event.over.id) : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveCaseId(null);
    setActiveOverId(null);
    const { active, over } = event;
    if (!over) return;

    const activeCaseIdValue = active.id as string;
    const activeCase = boardColumns.caseById.get(activeCaseIdValue);
    if (!activeCase) return;

    const sourceStageId = boardColumns.caseToColumn.get(activeCaseIdValue) ?? null;
    const targetStageId = resolvePipelineTargetStageId(
      over.id as string,
      columnsById,
      boardColumns.caseToColumn,
    );

    if (!targetStageId || sourceStageId === targetStageId) return;
    if (targetStageId === UNASSIGNED_STAGE_ID) return;
    const targetStageKey = stageKeyById.get(targetStageId);
    if (!targetStageKey) return;

    const sourceName = stageNameById.get(sourceStageId ?? "") ?? unassignedStageName();
    const targetName = stageNameById.get(targetStageId) ?? unassignedStageName();
    setPendingMove({
      caseId: activeCase.id,
      caseVersion: activeCase.version ?? 1,
      itemTitle: getCaseTitle(activeCase),
      sourceName,
      targetStageId,
      targetStageKey,
      targetName,
      allowed: moveAllowed(sourceStageId, targetStageId),
    });
  }

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.pipelines-cases.pipelines.title"), href: "/pipelines" },
      { label: pipeline?.name ?? t("area.pipelines-cases.pipelines.board.pipeline") },
    ]);
  }, [pipeline?.name, setBreadcrumbs, t]);

  useEffect(() => {
    setGroupByState({ pipelineId, value: readStoredPipelineBoardGroupBy(pipelineId) });
  }, [pipelineId]);

  if (pipelineQuery.isLoading || casesQuery.isLoading) return <PageSkeleton />;
  if (!pipeline) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.board.notFound")}</div>;
  }

  if (orderedStages.length === 0) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-8">
        <div>
          <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.board.pipeline")}</p>
          <h1 className="text-2xl font-semibold text-foreground">{pipeline.name}</h1>
          <p className="text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.board.noStages")}</p>
        </div>
        <EmptyState
          icon={Hexagon}
          message={t("area.pipelines-cases.pipelines.board.addStages")}
          action={t("area.pipelines-cases.pipelines.board.openSettings")}
          onAction={() => navigate(`/pipelines/${pipelineId}/settings`)}
        />
      </div>
    );
  }

  const activeCase = activeCaseId ? boardColumns.caseById.get(activeCaseId) ?? null : null;

  return (
    <div className="w-full space-y-4 px-6 py-8">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.board.pipeline")}</p>
          <h1 className="text-2xl font-semibold text-foreground">{pipeline.name}</h1>
          {pipeline.description ? <p className="mt-1 text-sm text-muted-foreground">{pipeline.description}</p> : null}
          <p className="mt-1 text-xs text-muted-foreground">{t("area.pipelines-cases.pipelines.board.totalItems", { count: cases.length })}</p>
          {fedByPipelines.length > 0 ? (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {fedByPipelines.map((source) => (
                <Link
                  key={source.id}
                  to={`/pipelines/${source.id}`}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground hover:text-foreground"
                  title={t("area.pipelines-cases.pipelines.board.fedBy", { name: source.name })}
                >
                  <span className="shrink-0">←</span>
                  <span className="truncate">{t("area.pipelines-cases.pipelines.board.fedBy", { name: source.name })}</span>
                </Link>
              ))}
            </div>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
          <Select value={groupBy} onValueChange={handleGroupByChange}>
            <SelectTrigger className="h-9 w-(--sz-148px)" aria-label={t("area.pipelines-cases.pipelines.board.groupBy")} title={t("area.pipelines-cases.pipelines.board.groupBy")}>
              <Layers className="h-4 w-4 text-muted-foreground" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">{t("common.none")}</SelectItem>
              <SelectItem value="builtFor">{t("area.pipelines-cases.pipelines.board.builtForOption")}</SelectItem>
            </SelectContent>
          </Select>
          <Button asChild>
            <Link to={`/pipelines/${pipelineId}/add`}>
              <Plus className="mr-2 h-4 w-4" />
              {t("area.pipelines-cases.pipelines.board.addItems")}
            </Link>
          </Button>
          <Button variant="outline" size="icon" asChild>
            <Link to={`/pipelines/${pipelineId}/settings`} aria-label={t("area.pipelines-cases.pipelines.board.settings")} title={t("area.pipelines-cases.pipelines.board.settings")}>
              <Settings className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <PipelineHealthBar
        warnings={healthQuery.data?.warnings ?? []}
        onSelectStage={(stageId) => navigate(`/pipelines/${pipelineId}/settings?stage=${stageId}`)}
      />

      <DndContext
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        sensors={sensors}
      >
        <div className="overflow-x-auto">
          <div className="flex items-start gap-3 pb-3">
            {boardColumns.columns.map((stage) => {
              const items = boardColumns.byStage.get(stage.id) ?? [];
              const activeSourceStageId = activeCaseId ? boardColumns.caseToColumn.get(activeCaseId) ?? null : null;
              const activeTargetStageId = activeOverId
                ? resolvePipelineTargetStageId(activeOverId, columnsById, boardColumns.caseToColumn)
                : null;
              const automationAssigneeAgentId = readPipelineStageAutomationAssigneeAgentId(stage);
              const automationAgent = automationAssigneeAgentId
                ? agentById.get(automationAssigneeAgentId) ?? {
                    id: automationAssigneeAgentId,
                    name: t("area.pipelines-cases.pipelines.board.agentFallback", { id: automationAssigneeAgentId.slice(0, 8) }),
                    icon: null,
                    urlKey: automationAssigneeAgentId,
                  }
                : null;
              const isDragTargeted = activeCaseId != null && activeTargetStageId === stage.id;
              const isDragBlocked = isDragTargeted
                ? stage.id === UNASSIGNED_STAGE_ID || !moveAllowed(activeSourceStageId, stage.id)
                : false;
              return (
                <PipelineBoardColumn
                  key={stage.id}
                  stage={stage}
                  cases={items}
                  groupBy={groupBy}
                  settingsHref={
                    stage.id === UNASSIGNED_STAGE_ID ? null : `/pipelines/${pipelineId}/settings?stage=${stage.id}`
                  }
                  warningCount={healthWarningsByStage[stage.id]?.length ?? 0}
                  breakdownTarget={breakdownTargetByStageId.get(stage.id) ?? null}
                  automationAgent={automationAgent}
                  automationHref={
                    stage.id === UNASSIGNED_STAGE_ID ? null : pipelineStageAutomationSettingsHref(pipelineId, stage.id)
                  }
                  isDragTargeted={isDragTargeted}
                  isDragBlocked={isDragBlocked}
                  onColumnEmpty={(columnStage) =>
                    columnStage.id === UNASSIGNED_STAGE_ID ? t("area.pipelines-cases.pipelines.board.unassignedItems") : t("area.pipelines-cases.pipelines.board.dropHere")
                  }
                />
              );
            })}
          </div>
        </div>

        <DragOverlay>
          {activeCase ? <PipelineCaseCard caseItem={activeCase} isOverlay /> : null}
        </DragOverlay>
      </DndContext>

      <Dialog
        open={Boolean(pendingMove)}
        onOpenChange={(open) => {
          if (!open) {
            setPendingMove(null);
            setOverrideReason("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingMove?.allowed ? t("area.pipelines-cases.pipelines.board.moveTitle", { title: pendingMove.itemTitle }) : t("area.pipelines-cases.pipelines.board.skipsFlowTitle")}
            </DialogTitle>
            <DialogDescription>
              {pendingMove?.allowed
                ? t("area.pipelines-cases.pipelines.board.moveDescription", { title: pendingMove.itemTitle, target: pendingMove.targetName })
                : pendingMove
                  ? t("area.pipelines-cases.pipelines.board.overrideDescription", { title: pendingMove.itemTitle, source: pendingMove.sourceName, target: pendingMove.targetName })
                  : t("area.pipelines-cases.pipelines.board.reviewMove")}
            </DialogDescription>
          </DialogHeader>
          {pendingMove && !pendingMove.allowed ? (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{t("area.pipelines-cases.pipelines.board.reason")}</span>
              <Textarea
                value={overrideReason}
                onChange={(event) => setOverrideReason(event.target.value)}
                rows={3}
                placeholder={t("area.pipelines-cases.pipelines.board.reasonPlaceholder")}
                autoFocus
              />
            </label>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={transitionCase.isPending}
              onClick={() => {
                setPendingMove(null);
                setOverrideReason("");
              }}
            >
              {t("common.cancel")}
            </Button>
            {pendingMove?.allowed ? (
              <Button
                type="button"
                disabled={transitionCase.isPending}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageKey: pendingMove.targetStageKey,
                    expectedVersion: pendingMove.caseVersion,
                  })
                }
              >
                {t("area.pipelines-cases.pipelines.board.moveIt")}
              </Button>
            ) : pendingMove ? (
              <Button
                type="button"
                variant="destructive"
                disabled={transitionCase.isPending || !overrideReason.trim()}
                onClick={() =>
                  transitionCase.mutate({
                    caseId: pendingMove.caseId,
                    toStageKey: pendingMove.targetStageKey,
                    expectedVersion: pendingMove.caseVersion,
                    reason: overrideReason.trim(),
                    force: true,
                  })
                }
              >
                {t("area.pipelines-cases.pipelines.board.overrideAndMove")}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function PipelineItemLegacyRedirect() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <NavigateToItem pipelineId={params.pipelineId} caseId={params.caseId} />;
}

function NavigateToItem({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  return <LinkRedirect to={`/pipelines/${pipelineId}/items/${caseId}`} />;
}

function NavigateMissingItem() {
  const { t } = useTranslation();
  return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.board.itemNotFound")}</div>;
}

function LinkRedirect({ to }: { to: string }) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace: true });
  }, [navigate, to]);
  return null;
}

export function PipelineItemDetail() {
  const params = useParams<{ pipelineId?: string; caseId?: string }>();
  if (!params.pipelineId || !params.caseId) return <NavigateMissingItem />;
  return <PipelineItemDetailView pipelineId={params.pipelineId} caseId={params.caseId} />;
}

export function PipelineItemDetailView({ pipelineId, caseId }: { pipelineId: string; caseId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId } = useCompany();
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false);
  const [moveDialogOpen, setMoveDialogOpen] = useState(false);
  const [moveStageKey, setMoveStageKey] = useState("");
  const [reviewDecisionNote, setReviewDecisionNote] = useState("");
  const [livenessRetryError, setLivenessRetryError] = useState<string | null>(null);
  const [retryDialogScope, setRetryDialogScope] = useState<PipelineAutomationRetryScope | null>(null);
  const [retryTargetStageId, setRetryTargetStageId] = useState<string | null>(null);
  const [selectedRetryCleanupIds, setSelectedRetryCleanupIds] = useState<Set<string>>(() => new Set());
  const [retryDialogError, setRetryDialogError] = useState<string | null>(null);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const item = useQuery({
    queryKey: queryKeys.pipelines.caseDetail(caseId),
    queryFn: () => pipelinesApi.getCase(caseId),
  });
  const children = useQuery({
    queryKey: queryKeys.pipelines.caseChildren(caseId),
    queryFn: () => pipelinesApi.getCaseChildren(caseId),
  });
  const events = useQuery({
    queryKey: queryKeys.pipelines.caseEvents(caseId),
    queryFn: () => pipelinesApi.getCaseEvents(caseId, { order: "asc", limit: 100 }),
  });
  const issueLinks = useQuery({
    queryKey: queryKeys.pipelines.caseIssueLinks(caseId),
    queryFn: () => pipelinesApi.getCaseIssueLinks(caseId),
  });

  const detail = item.data;
  const reviewQueueItems = useQuery({
    queryKey: selectedCompanyId
      ? ["pipelines", "review-cases", selectedCompanyId, "pipeline", pipelineId]
      : ["pipelines", "review-cases", "__none__", "pipeline", pipelineId],
    queryFn: () => pipelinesApi.listReviewCases(selectedCompanyId!, { pipelineId }),
    enabled: Boolean(selectedCompanyId && detail?.stage.kind === "review"),
  });
  const stages = pipeline.data?.stages ?? detail?.allowedNextStages ?? [];
  const stageLookup = useMemo(() => {
    const lookup = new Map<string, string>();
    for (const stage of stages) {
      lookup.set(stage.id, stage.name);
      lookup.set(stage.key, stage.name);
    }
    return lookup;
  }, [stages]);
  const conversationLink = useMemo(() => {
    const links = issueLinks.data ?? [];
    return links.find((link) => link.link.role === "conversation")
      ?? links.find((link) => link.link.role === "work")
      ?? null;
  }, [issueLinks.data]);
  const activeConversationSource = detail?.conversationSource?.isActive === false
    ? null
    : detail?.conversationSource ?? null;
  const conversationIssue = activeConversationSource?.issue
    ?? (detail?.conversationSource ? null : conversationLink?.issue)
    ?? null;
  const outputs = useQuery({
    queryKey: queryKeys.pipelines.caseOutputs(caseId),
    queryFn: () => pipelinesApi.getCaseOutputs(caseId),
  });
  const conversationIssueId = conversationIssue?.id ?? null;
  const conversationIssueDetail = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.detail(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-detail"],
    queryFn: () => issuesApi.get(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
  });
  const activeConversationIssue = conversationIssueDetail.data ?? conversationIssue;
  const conversationCompanyId = activeConversationIssue?.companyId ?? selectedCompanyId ?? null;
  const [locallyQueuedConversationCommentRunIds, setLocallyQueuedConversationCommentRunIds] = useState<Map<string, string>>(() => new Map());
  const comments = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.commentsList(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation"],
    queryFn: () => issuesApi.listComments(conversationIssueId!, { order: "asc", limit: 50 }),
    enabled: Boolean(conversationIssueId),
  });
  const conversationComments = useMemo<IssueChatComment[]>(
    () => normalizePipelineConversationComments(comments.data),
    [comments.data],
  );
  const { data: conversationActivity } = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.activity(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-activity"],
    queryFn: () => activityApi.forIssue(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
    placeholderData: conversationIssueId
      ? keepPreviousDataForSameQueryTail(conversationIssueId)
      : undefined,
  });
  const { data: conversationLiveRuns } = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.liveRuns(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-live-runs"],
    queryFn: () => heartbeatsApi.liveRunsForIssue(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
    refetchInterval: 3000,
    placeholderData: conversationIssueId
      ? keepPreviousDataForSameQueryTail<LiveRunForIssue[]>(conversationIssueId)
      : undefined,
  });
  const resolvedConversationLiveRuns = conversationLiveRuns ?? [];
  const conversationLiveRunCount = resolvedConversationLiveRuns.length;
  const { data: rawConversationActiveRun = null } = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.activeRun(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-active-run"],
    queryFn: () => heartbeatsApi.activeRunForIssue(conversationIssueId!),
    enabled: Boolean(conversationIssueId && activeConversationIssue && shouldTrackIssueActiveRun(activeConversationIssue)),
    refetchInterval: conversationLiveRunCount > 0 ? false : 3000,
    placeholderData: conversationIssueId
      ? keepPreviousDataForSameQueryTail<ActiveRunForIssue | null>(conversationIssueId)
      : undefined,
  });
  const resolvedConversationActiveRun = useMemo(
    () => resolveIssueActiveRun(activeConversationIssue, rawConversationActiveRun),
    [activeConversationIssue, rawConversationActiveRun],
  );
  const conversationHasLiveRuns = conversationLiveRunCount > 0 || Boolean(resolvedConversationActiveRun);
  const { data: conversationLinkedRuns } = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.runs(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-runs"],
    queryFn: () => activityApi.runsForIssue(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
    refetchInterval: conversationHasLiveRuns ? 5000 : false,
    placeholderData: conversationIssueId
      ? keepPreviousDataForSameQueryTail<RunForIssue[]>(conversationIssueId)
      : undefined,
  });
  const interactions = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.interactions(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-interactions"],
    queryFn: () => issuesApi.listInteractions(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
  });
  const { data: agents } = useQuery({
    queryKey: conversationCompanyId ? queryKeys.agents.list(conversationCompanyId) : ["agents", "pipeline-item", "none"],
    queryFn: () => agentsApi.list(conversationCompanyId!),
    enabled: Boolean(conversationCompanyId),
  });
  const { data: companyMembers } = useQuery({
    queryKey: conversationCompanyId ? queryKeys.access.companyUserDirectory(conversationCompanyId) : ["access", "pipeline-item", "users", "none"],
    queryFn: () => accessApi.listUserDirectory(conversationCompanyId!),
    enabled: Boolean(conversationCompanyId),
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: projects } = useQuery({
    queryKey: conversationCompanyId ? queryKeys.projects.list(conversationCompanyId) : ["projects", "pipeline-item", "none"],
    queryFn: () => projectsApi.list(conversationCompanyId!),
    enabled: Boolean(conversationCompanyId),
  });
  const { data: feedbackVotes } = useQuery({
    queryKey: conversationIssueId ? queryKeys.issues.feedbackVotes(conversationIssueId) : ["pipeline-item", caseId, "missing-conversation-feedback"],
    queryFn: () => issuesApi.listFeedbackVotes(conversationIssueId!),
    enabled: Boolean(conversationIssueId),
  });
  const { data: instanceGeneralSettings } = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    enabled: Boolean(conversationIssueId),
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const feedbackDataSharingPreference = instanceGeneralSettings?.feedbackDataSharingPreference ?? "prompt";
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
    companyId: conversationCompanyId,
    userId: currentUserId,
  });
  const agentMap = useMemo(() => {
    const map = new Map<string, NonNullable<typeof agents>[number]>();
    for (const agent of agents ?? []) map.set(agent.id, agent);
    return map;
  }, [agents]);
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const mentionOptions = useStandardMarkdownMentionOptions({
    companyId: conversationCompanyId,
    agents,
    projects: orderedProjects,
    members: companyMembers?.users,
  });
  const commentReassignOptions = useMemo(() => {
    const options: Array<{ id: string; label: string; searchText?: string }> = [];
    options.push(...buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] }));
    const activeAgents = [...(agents ?? [])]
      .filter(isAgentTaskTarget)
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({ id: `agent:${agent.id}`, label: agent.name });
    }
    if (currentUserId) {
      options.push({ id: `user:${currentUserId}`, label: t("common.me") });
    }
    return options;
  }, [agents, companyMembers?.users, currentUserId, t]);
  const actualAssigneeValue = useMemo(
    () => assigneeValueFromSelection(activeConversationIssue ?? {}),
    [activeConversationIssue],
  );
  const starterAssigneeValue = useMemo(
    () =>
      pipelineConversationStarterAssigneeValue({
        conversationIssue: activeConversationIssue ?? null,
        conversationSource: activeConversationSource,
        issueLinks: issueLinks.data ?? [],
      }),
    [activeConversationIssue, activeConversationSource, issueLinks.data],
  );
  const suggestedAssigneeValue = useMemo(
    () =>
      suggestedCommentAssigneeValue(
        starterAssigneeValue ? parseAssigneeValue(starterAssigneeValue) : activeConversationIssue ?? {},
        conversationComments,
        currentUserId,
      ),
    [activeConversationIssue, conversationComments, currentUserId, starterAssigneeValue],
  );
  const conversationRunningRun = useMemo(
    () => resolveRunningPipelineConversationRun(resolvedConversationActiveRun, resolvedConversationLiveRuns),
    [resolvedConversationActiveRun, resolvedConversationLiveRuns],
  );
  const conversationLiveRunIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of resolvedConversationLiveRuns) ids.add(run.id);
    if (resolvedConversationActiveRun) ids.add(resolvedConversationActiveRun.id);
    return ids;
  }, [resolvedConversationActiveRun, resolvedConversationLiveRuns]);
  const conversationTimelineRuns = useMemo(() => {
    const historicalRuns = conversationLiveRunIds.size === 0
      ? conversationLinkedRuns ?? []
      : (conversationLinkedRuns ?? []).filter((run) => !conversationLiveRunIds.has(run.runId));
    return historicalRuns.map((run) => ({
      ...run,
      adapterType: run.adapterType,
      hasStoredOutput: (run.logBytes ?? 0) > 0,
    }));
  }, [conversationLinkedRuns, conversationLiveRunIds]);
  const conversationTimelineEvents = useMemo(
    () => extractIssueTimelineEvents(conversationActivity ?? []),
    [conversationActivity],
  );
  const conversationThreadComments = useMemo<IssueChatComment[]>(() => {
    const activeRunStartedAt = conversationRunningRun?.startedAt ?? conversationRunningRun?.createdAt ?? null;
    const runMetaByCommentId = new Map<string, { runId: string; runAgentId: string | null; interruptedRunId: string | null }>();
    const followUpCommentIds = new Set<string>();
    const agentIdByRunId = new Map<string, string>();

    for (const run of conversationLinkedRuns ?? []) {
      agentIdByRunId.set(run.runId, run.agentId);
    }
    for (const evt of conversationActivity ?? []) {
      if (evt.action !== "issue.comment_added" || !evt.runId) continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId || runMetaByCommentId.has(commentId)) continue;
      runMetaByCommentId.set(commentId, {
        runId: evt.runId,
        runAgentId: evt.agentId ?? agentIdByRunId.get(evt.runId) ?? null,
        interruptedRunId: typeof details["interruptedRunId"] === "string" ? details["interruptedRunId"] : null,
      });
    }
    for (const evt of conversationActivity ?? []) {
      if (evt.action !== "issue.comment_added") continue;
      const details = evt.details ?? {};
      const commentId = typeof details["commentId"] === "string" ? details["commentId"] : null;
      if (!commentId) continue;
      if (details["followUpRequested"] === true || details["resumeIntent"] === true) {
        followUpCommentIds.add(commentId);
      }
    }

    return conversationComments.map((comment) => {
      const meta = runMetaByCommentId.get(comment.id);
      const nextComment: IssueChatComment = meta ? { ...comment, ...meta } : { ...comment };
      if (followUpCommentIds.has(comment.id)) {
        nextComment.followUpRequested = true;
      }
      const queuedTargetRunId = locallyQueuedConversationCommentRunIds.get(comment.id) ?? null;
      const locallyQueuedComment = applyLocalQueuedIssueCommentState(nextComment, {
        queuedTargetRunId,
        targetRunIsLive: queuedTargetRunId ? conversationLiveRunIds.has(queuedTargetRunId) : false,
        runningRunId: conversationRunningRun?.id ?? null,
      });
      if (locallyQueuedComment !== nextComment) {
        return locallyQueuedComment;
      }
      if (
        isQueuedIssueComment({
          comment: nextComment,
          activeRunStartedAt,
          activeRunAgentId: conversationRunningRun?.agentId ?? null,
          activeRunCommentId: conversationRunningRun?.contextCommentId ?? null,
          activeRunWakeCommentId: conversationRunningRun?.contextWakeCommentId ?? null,
          runId: meta?.runId ?? nextComment.runId ?? null,
          interruptedRunId: meta?.interruptedRunId ?? nextComment.interruptedRunId ?? null,
        })
      ) {
        return {
          ...nextComment,
          queueState: "queued",
          queueTargetRunId: conversationRunningRun?.id ?? nextComment.queueTargetRunId ?? null,
          queueReason: "active_run",
        };
      }
      return nextComment;
    });
  }, [
    conversationComments,
    conversationActivity,
    conversationLinkedRuns,
    conversationLiveRunIds,
    conversationRunningRun,
    locallyQueuedConversationCommentRunIds,
  ]);

  useEffect(() => {
    if (!conversationHasLiveRuns && locallyQueuedConversationCommentRunIds.size > 0) {
      setLocallyQueuedConversationCommentRunIds(new Map());
    }
  }, [conversationHasLiveRuns, locallyQueuedConversationCommentRunIds.size]);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.pipelines-cases.pipelines.title"), href: "/pipelines" },
      { label: pipeline.data?.name ?? detail?.pipeline.name ?? t("area.pipelines-cases.pipelines.board.pipeline"), href: `/pipelines/${pipelineId}` },
      { label: detail?.case.title ?? t("area.pipelines-cases.pipelines.item.breadcrumbItem") },
    ]);
  }, [detail?.case.title, detail?.pipeline.name, pipeline.data?.name, pipelineId, setBreadcrumbs, t]);

  const invalidateItem = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseDetail(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseEvents(caseId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseIssueLinks(caseId) }),
    ]);
  }, [caseId, pipelineId, queryClient]);

  const startConversation = useMutation({
    mutationFn: async () => {
      await pipelinesApi.createIssueLink(caseId, { role: "conversation" });
    },
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.conversationStarted"), tone: "success" });
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.conversationStartFailed"), tone: "error" }),
  });

  // Body-document selection → "Start conversation & comment": returns the created issue so the
  // body block can mirror the document onto it and re-open the composer with the held anchor.
  const startConversationForBody = useCallback(async () => {
    try {
      const result = await pipelinesApi.createIssueLink(caseId, { role: "conversation" });
      await invalidateItem();
      return ("issue" in result ? result.issue : null) ?? null;
    } catch {
      pushToast({ title: t("area.pipelines-cases.pipelines.item.conversationStartFailed"), tone: "error" });
      return null;
    }
  }, [caseId, invalidateItem, pushToast, t]);

  const invalidateConversation = useCallback(async () => {
    if (!conversationIssueId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activity(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.feedbackVotes(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.runs(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.liveRuns(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.activeRun(conversationIssueId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseIssueLinks(caseId) }),
    ]);
  }, [caseId, conversationIssueId, queryClient]);

  const addConversationComment = useCallback(async (
    body: string,
    reopen?: boolean,
    reassignment?: { assigneeAgentId: string | null; assigneeUserId: string | null },
  ) => {
    if (!conversationIssueId) return;
    if (reassignment) {
      await issuesApi.update(conversationIssueId, {
        comment: body,
        assigneeAgentId: reassignment.assigneeAgentId,
        assigneeUserId: reassignment.assigneeUserId,
        ...(reopen ? { status: "todo" } : {}),
      });
    } else {
      const queuedRunId = conversationRunningRun?.id ?? null;
      const comment = await issuesApi.addComment(conversationIssueId, body, reopen);
      if (queuedRunId) {
        setLocallyQueuedConversationCommentRunIds((current) => {
          const next = new Map(current);
          next.set(comment.id, queuedRunId);
          return next;
        });
      }
    }
    await invalidateConversation();
  }, [conversationIssueId, conversationRunningRun?.id, invalidateConversation]);

  const updateConversationWorkMode = useCallback(async (workMode: IssueWorkMode) => {
    if (!conversationIssueId) return;
    await issuesApi.update(conversationIssueId, { workMode });
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const handleConversationVote = useCallback(async (
    commentId: string,
    vote: "up" | "down",
    options?: { allowSharing?: boolean; reason?: string },
  ) => {
    if (!conversationIssueId) return;
    await issuesApi.upsertFeedbackVote(conversationIssueId, {
      targetType: "issue_comment",
      targetId: commentId,
      vote,
      reason: options?.reason,
      allowSharing: options?.allowSharing,
    });
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.feedbackVotes(conversationIssueId) });
  }, [conversationIssueId, queryClient]);

  const handleConversationImageUpload = useCallback(async (file: File) => {
    if (!conversationIssueId || !conversationCompanyId) {
      throw new Error(t("area.pipelines-cases.pipelines.item.noIssueUpload"));
    }
    const attachment = await issuesApi.uploadAttachment(conversationCompanyId, conversationIssueId, file);
    return attachment.contentPath;
  }, [conversationCompanyId, conversationIssueId, t]);

  const handleConversationAttachImage = useCallback(async (file: File) => {
    if (!conversationIssueId || !conversationCompanyId) {
      throw new Error(t("area.pipelines-cases.pipelines.item.noIssueAttach"));
    }
    return issuesApi.uploadAttachment(conversationCompanyId, conversationIssueId, file);
  }, [conversationCompanyId, conversationIssueId, t]);

  const handleDeleteConversationComment = useCallback(async (commentId: string) => {
    if (!conversationIssueId) return;
    await issuesApi.deleteComment(conversationIssueId, commentId);
    await queryClient.invalidateQueries({ queryKey: queryKeys.issues.comments(conversationIssueId) });
  }, [conversationIssueId, queryClient]);

  const handleInterruptConversationQueuedRun = useCallback(async (runId: string | null) => {
    if (!conversationIssueId) return;
    try {
      await issuesApi.interruptLatestQueuedComments(conversationIssueId, runId);
      pushToast({ title: t("area.pipelines-cases.pipelines.item.interruptRequested"), body: t("area.pipelines-cases.pipelines.item.interruptRequestedBody"), tone: "success" });
    } catch (error) {
      pushToast({ title: t("area.pipelines-cases.pipelines.item.interruptFailed"), body: error instanceof Error ? error.message : t("area.pipelines-cases.pipelines.item.interruptFailedBody"), tone: "error" });
    } finally {
      await invalidateConversation();
    }
  }, [conversationIssueId, invalidateConversation, pushToast, t]);

  const handleCancelConversationQueuedComment = useCallback(async (commentId: string) => {
    if (!conversationIssueId) return;
    await issuesApi.cancelComment(conversationIssueId, commentId);
    setLocallyQueuedConversationCommentRunIds((current) => {
      if (!current.has(commentId)) return current;
      const next = new Map(current);
      next.delete(commentId);
      return next;
    });
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const handleAcceptConversationInteraction = useCallback(async (
    interaction: PipelineConversationActionableInteraction,
    selectedClientKeys?: string[],
    selectedOptionIds?: string[],
    rememberAction?: boolean,
  ) => {
    if (!conversationIssueId) return;
    await issuesApi.acceptInteraction(conversationIssueId, interaction.id, { selectedClientKeys, selectedOptionIds, rememberAction });
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const handleRejectConversationInteraction = useCallback(async (
    interaction: PipelineConversationActionableInteraction,
    reason?: string,
  ) => {
    if (!conversationIssueId) return;
    await issuesApi.rejectInteraction(conversationIssueId, interaction.id, reason);
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const handleSubmitConversationInteractionAnswers = useCallback(async (
    interaction: IssueThreadInteraction,
    answers: AskUserQuestionsAnswer[],
  ) => {
    if (!conversationIssueId) return;
    await issuesApi.respondToInteraction(conversationIssueId, interaction.id, { answers });
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const handleCancelConversationInteraction = useCallback(async (interaction: AskUserQuestionsInteraction) => {
    if (!conversationIssueId) return;
    await issuesApi.cancelInteraction(conversationIssueId, interaction.id);
    await invalidateConversation();
  }, [conversationIssueId, invalidateConversation]);

  const resolveSuggestion = useMutation({
    mutationFn: ({ resolution, suggestionId }: { resolution: "accept" | "dismiss"; suggestionId: string }) =>
      pipelinesApi.resolveSuggestion(caseId, {
        suggestionId,
        resolution,
        expectedVersion: detail?.case.version,
      }),
    onSuccess: async (_result, variables) => {
      await invalidateItem();
      pushToast({
        title: variables.resolution === "accept" ? t("area.pipelines-cases.pipelines.item.moveApproved") : t("area.pipelines-cases.pipelines.item.suggestionDismissed"),
        tone: "success",
      });
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.suggestionFailed"), tone: "error" }),
  });

  const acknowledgeChange = useMutation({
    mutationFn: () => pipelinesApi.acknowledgeDrift(caseId, { expectedVersion: detail?.case.version }),
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.changeAcknowledged"), tone: "success" });
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.changeAckFailed"), tone: "error" }),
  });

  const previousRetryAvailability = useQuery({
    queryKey: ["pipelines", "item", caseId, "automation-retry-plan", "previous_stage"],
    queryFn: () => pipelinesApi.getAutomationRetryPlan(caseId, "previous_stage"),
    enabled: Boolean(caseId),
    retry: false,
  });

  // For previous_stage retries the operator can pick any eligible upstream stage.
  // The selected target id is part of the query key so changing it refetches the
  // whole preflight (routine/effects/blockers/cleanup/label). Current-stage reruns
  // ignore the target. keepPreviousData keeps the dialog (and its dropdown) mounted
  // and interactive while the new target's plan is in flight.
  const retryPlan = useQuery({
    queryKey: ["pipelines", "item", caseId, "automation-retry-plan", retryDialogScope, retryTargetStageId],
    queryFn: () =>
      pipelinesApi.getAutomationRetryPlan(
        caseId,
        retryDialogScope!,
        retryDialogScope === "previous_stage" ? retryTargetStageId : null,
      ),
    enabled: Boolean(retryDialogScope),
    retry: false,
    placeholderData: (previousData, previousQuery) => {
      const previousKey = previousQuery?.queryKey;
      if (!Array.isArray(previousKey)) return undefined;
      // Only carry the plan over when the same dialog stays open and just the
      // target changed (same case + scope) — never across cases or scopes.
      return previousKey[2] === caseId && previousKey[4] === retryDialogScope ? previousData : undefined;
    },
  });

  useEffect(() => {
    if (!retryPlan.data) return;
    setRetryDialogError(null);
    setSelectedRetryCleanupIds(selectedCleanupIds(retryPlan.data));
  }, [retryPlan.data]);

  const rerunCurrentStageAutomation = useMutation({
    mutationFn: () => pipelinesApi.retryStageAutomation(caseId, {
      scope: "current_stage",
      expectedVersion: retryPlan.data?.caseVersion ?? detail?.case.version ?? 1,
      cleanup: retryCleanupFromIds(selectedRetryCleanupIds),
    }),
    onSuccess: async () => {
      setRetryDialogScope(null);
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.rerunStarted"), tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message ? error.message : t("area.pipelines-cases.pipelines.item.rerunFailed");
      setRetryDialogError(message);
      pushToast({ title: t("area.pipelines-cases.pipelines.item.rerunFailed"), tone: "error" });
    },
  });

  const retryStageAutomation = useMutation({
    mutationFn: (plan: PipelineAutomationRetryPlan) => pipelinesApi.retryStageAutomation(caseId, {
      scope: plan.scope,
      targetStageId: plan.targetStage?.id ?? null,
      expectedVersion: plan.caseVersion,
      cleanup: retryCleanupFromIds(selectedRetryCleanupIds),
    }),
    onSuccess: async () => {
      setRetryDialogScope(null);
      setRetryDialogError(null);
      await Promise.all([
        invalidateItem(),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: ["pipelines", "item", caseId, "automation-retry-plan"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.caseChildren(caseId) }),
      ]);
      pushToast({ title: t("area.pipelines-cases.pipelines.item.retryStarted"), tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message ? error.message : t("area.pipelines-cases.pipelines.item.retryFailed");
      setRetryDialogError(message);
      pushToast({ title: t("area.pipelines-cases.pipelines.item.retryFailed"), tone: "error" });
    },
  });

  // Derived retry-dialog state for the upstream-step selector. The dropdown only
  // appears for previous_stage retries with more than one eligible target; with a
  // single target we keep the read-only "Runs at" text. The selected id falls back
  // to the plan's resolved target (immediate previous by default).
  const retryPlanData = retryPlan.data ?? null;
  const retryAvailableTargets = retryPlanData?.availableTargetStages ?? [];
  const retryShowTargetDropdown = retryDialogScope === "previous_stage" && retryAvailableTargets.length > 1;
  const retrySelectedTargetId = retryTargetStageId ?? retryPlanData?.targetStage?.id ?? "";
  const retryIsNonImmediateTarget =
    retryDialogScope === "previous_stage" &&
    retryAvailableTargets.length > 0 &&
    Boolean(retrySelectedTargetId) &&
    retrySelectedTargetId !== retryAvailableTargets[0]?.id;
  // isFetching-without-isLoading means a target change is refreshing the preflight;
  // keepPreviousData keeps the dialog mounted so we scope the spinner to the
  // metrics/blocker/cleanup region rather than flashing the whole dialog.
  const retryPreflightRefreshing = retryPlan.isFetching && !retryPlan.isLoading;

  // Liveness banner retry. Targets the specific failed automation ledger when we
  // know its id (e.g. permission-restored recovery), otherwise falls back to
  // re-running the current stage's entry automation. Surfaces the API error
  // inline so a 403/409 is never silently dropped.
  const retryLiveness = useMutation({
    mutationFn: (kind: LivenessRetryKind) => {
      const automationId = detail?.liveness?.automation?.automationId ?? null;
      if (kind === "automation" && automationId) {
        return pipelinesApi.retryAutomation(caseId, automationId);
      }
      return pipelinesApi.rerunCurrentStageAutomation(caseId);
    },
    onMutate: () => setLivenessRetryError(null),
    onSuccess: async () => {
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.retryStarted"), tone: "success" });
    },
    onError: (error: unknown) => {
      const message = error instanceof ApiError && error.message
        ? error.message
        : t("area.pipelines-cases.pipelines.item.retryTryAgain");
      setLivenessRetryError(message);
      pushToast({ title: t("area.pipelines-cases.pipelines.item.retryAutomationFailed"), tone: "error" });
    },
  });

  const removeStage = useMemo(
    () => stages.find((stage) => stage.kind === "cancelled") ?? stages.find((stage) => stage.key === "cancelled") ?? null,
    [stages],
  );
  const moveStageOptions = useMemo(
    () => stages
      .filter((stage) => stage.id !== detail?.stage.id)
      .sort((left, right) => left.position - right.position),
    [detail?.stage.id, stages],
  );
  const selectedMoveStage = useMemo(
    () => moveStageOptions.find((stage) => stage.key === moveStageKey) ?? null,
    [moveStageKey, moveStageOptions],
  );
  const moveItemToStage = useMutation({
    mutationFn: () => {
      if (!selectedMoveStage || !detail?.case.version) throw new Error("Missing target stage");
      return pipelinesApi.transitionCase(caseId, {
        toStageKey: selectedMoveStage.key,
        expectedVersion: detail.case.version,
        reason: `Manual board override from item page: moved from ${detail.stage.name} to ${selectedMoveStage.name}.`,
        force: true,
      });
    },
    onSuccess: async () => {
      setMoveDialogOpen(false);
      setMoveStageKey("");
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.itemMoved"), tone: "success" });
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.itemMoveFailed"), tone: "error" }),
  });
  const removeItem = useMutation({
    mutationFn: () => {
      if (!removeStage || !detail?.case.version) throw new Error("Missing removal stage");
      return pipelinesApi.transitionCase(caseId, {
        toStageKey: removeStage.key,
        expectedVersion: detail.case.version,
        reason: "Removed from the item detail page.",
      });
    },
    onSuccess: async () => {
      setRemoveDialogOpen(false);
      await invalidateItem();
      pushToast({ title: t("area.pipelines-cases.pipelines.item.itemRemoved"), tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.itemRemoveFailed"), tone: "error" }),
  });

  const reviewConfig = useMemo(
    () => detail ? reviewDecisionConfig(detail.stage, stages) : null,
    [detail, stages],
  );
  const reviewActions = useMemo(
    () => reviewConfig ? reviewDecisionActions(reviewConfig, stageLookup) : [],
    [reviewConfig, stageLookup],
  );
  const nextReviewItem = useMemo(() => {
    const rows = reviewQueueItems.data ?? [];
    if (rows.length === 0) return null;
    const currentIndex = rows.findIndex((row) => row.case.id === caseId);
    if (currentIndex >= 0) {
      const laterRow = rows.slice(currentIndex + 1).find((row) => row.case.id !== caseId);
      if (laterRow) return laterRow;
    }
    return rows.find((row) => row.case.id !== caseId) ?? null;
  }, [caseId, reviewQueueItems.data]);
  const decideReview = useMutation({
    mutationFn: ({ decision }: { decision: PipelineReviewDecision }) => {
      if (!detail?.case.version) throw new Error("Missing item version");
      return pipelinesApi.reviewCase(caseId, {
        decision,
        reason: reviewDecisionNote.trim() || null,
        expectedVersion: detail.case.version,
      });
    },
    onSuccess: async (_result, variables) => {
      let nextHref = nextReviewItem
        ? `/pipelines/${nextReviewItem.pipeline.id}/items/${nextReviewItem.case.id}`
        : null;
      if (!nextHref && selectedCompanyId) {
        try {
          const latestReviewItems = await pipelinesApi.listReviewCases(selectedCompanyId, { pipelineId });
          const latestNextItem = latestReviewItems.find((row) => row.case.id !== caseId) ?? null;
          nextHref = latestNextItem
            ? `/pipelines/${latestNextItem.pipeline.id}/items/${latestNextItem.case.id}`
            : null;
        } catch {
          nextHref = null;
        }
      }
      setReviewDecisionNote("");
      await Promise.all([
        invalidateItem(),
        selectedCompanyId
          ? queryClient.invalidateQueries({ queryKey: ["pipelines", "review-cases", selectedCompanyId] })
          : Promise.resolve(),
      ]);
      pushToast({
        title: reviewDecisionToastTitle(variables.decision, Boolean(nextHref)),
        tone: "success",
      });
      if (nextHref) navigate(nextHref);
    },
    onError: () => pushToast({ title: t("area.pipelines-cases.pipelines.item.reviewUpdateFailed"), tone: "error" }),
  });

  if (pipeline.isLoading || item.isLoading) return <PageSkeleton />;
  if (!detail || !pipeline.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.board.itemNotFound")}</div>;
  }

  const workReferences = extractWorkReferences(detail.case);
  const referenceKeys = referenceFieldKeys(detail.case.fields);
  const { shortFields: itemFields, longFields: mainPaneFields } = splitPipelineItemFields(
    displayPipelineItemFields(detail.case.fields).filter((field) => !referenceKeys.has(field.key)),
  );
  const banner = getPendingTransitionBannerState(detail.case, stageLookup);
  const statusLabel = humanizePipelineItemStatus(detail.case.terminalKind ?? detail.stage.kind);
  const stageAutomation = currentStageAutomation(detail.stage);
  const previousRetryPlan = previousRetryAvailability.data;
  // Don't let the operator re-run automation into the same 403 — they must get
  // the grant first. The banner's "Request access" path is the way out.
  const rerunBlockedByPermission = shouldDisableRerunForPermission(detail.liveness);
  const childRows = normalizePipelineChildRows(children.data);
  const eventRows = events.data?.items ?? [];
  const activeWork = detail.activeWork ?? null;
  const conversationIssueForLink = activeConversationIssue ?? conversationIssue;
  const conversationIssuePath = conversationIssueForLink ? issueDetailPath(conversationIssueForLink) : null;
  const conversationIssueState = conversationIssueForLink
    ? withIssueDetailHeaderSeed(null, conversationIssueForLink)
    : undefined;
  const waitingChildren = getWaitingChildren(childRows);
  const childrenGate = hasChildrenGate(detail.stage);
  // "Break into pieces" rollup: the configured piece noun drives every count
  // string when this case's stage breaks work into another pipeline.
  const breakdown = readStageBreakdown(detail.stage);
  const pieceCountTotal = childRows.length;
  const pieceCountDone = childRows.filter((row) =>
    (row.case.terminalKind ?? row.stage.kind)?.trim().toLowerCase() === "done"
  ).length;
  const pieceNoun = breakdown?.pieceNoun ?? t("area.pipelines-cases.pipelines.item.pieceDefault");
  const pieceNounPluralLabel = breakdown?.pieceNoun ? pieceNounPlural(pieceNoun) : t("area.pipelines-cases.pipelines.item.pieceDefaultPlural");
  const pieceLabel = (count: number) => (count === 1 ? pieceNoun : pieceNounPluralLabel);
  const changedNotice = itemHasChangedNotice(detail.case) ?? changedNoticeFromEvents(eventRows);
  const primaryAction = conversationIssue
    ? (
        <Button asChild>
          <Link to={conversationIssuePath!} state={conversationIssueState} issuePrefetch={conversationIssueDetail.data ?? null}>
            <MessageSquare className="mr-2 h-4 w-4" />
            {t("area.pipelines-cases.pipelines.item.openConversation")}
          </Link>
        </Button>
      )
    : (
        <Button onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
          <MessageSquare className="mr-2 h-4 w-4" />
          {startConversation.isPending ? t("area.pipelines-cases.pipelines.item.starting") : t("area.pipelines-cases.pipelines.item.startConversation")}
        </Button>
      );
  const reviewPanel = detail.stage.kind === "review" && reviewConfig ? (
    <ReviewDecisionPanel
      actions={reviewActions}
      note={reviewDecisionNote}
      requireReason={reviewActions.some((action) => action.requireReason)}
      pendingDecision={decideReview.variables?.decision ?? null}
      pending={decideReview.isPending}
      nextItemTitle={nextReviewItem?.case.title ?? null}
      onNoteChange={setReviewDecisionNote}
      onDecide={(decision) => decideReview.mutate({ decision })}
    />
  ) : null;

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 grid gap-5 lg:grid-cols-(--gtc-45) lg:items-start lg:gap-8">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <Link to="/pipelines" className="hover:text-foreground">{t("area.pipelines-cases.pipelines.title")}</Link>
            <ChevronRight className="h-3.5 w-3.5" />
            <Link to={`/pipelines/${pipelineId}`} className="hover:text-foreground">{pipeline.data.name}</Link>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="min-w-0 text-2xl font-semibold text-foreground">{detail.case.title}</h1>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs font-medium text-muted-foreground">
              {statusLabel}
            </span>
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              {t("area.pipelines-cases.pipelines.item.stageLabel")} <span className="font-medium text-foreground">{detail.stage.name}</span>
            </div>
          </div>
          {detail.parentCase ? (
            <p className="mt-2 text-sm text-muted-foreground">
              {t("area.pipelines-cases.pipelines.board.builtForOption")}{" "}
              <Link
                to={`/pipelines/${detail.parentCase.case.pipelineId}/items/${detail.parentCase.case.id}`}
                className="font-medium text-foreground hover:underline"
              >
                {detail.parentCase.pipeline.name}: {detail.parentCase.case.title}
              </Link>
            </p>
          ) : null}
          {detail.builtFromAutomation ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t("area.pipelines-cases.pipelines.item.builtFrom")}{" "}
              <Link
                to={detail.builtFromAutomation.stage
                  ? pipelineStageAutomationSettingsHref(
                      detail.builtFromAutomation.pipeline.id,
                      detail.builtFromAutomation.stage.id,
                    )
                  : `/pipelines/${detail.builtFromAutomation.pipeline.id}/settings`}
                className="font-medium text-foreground hover:underline"
                title={detail.builtFromAutomation.routine.title}
              >
                {detail.builtFromAutomation.stage
                  ? t("area.pipelines-cases.pipelines.item.automationOfStage", { pipeline: detail.builtFromAutomation.pipeline.name, stage: detail.builtFromAutomation.stage.name })
                  : t("area.pipelines-cases.pipelines.item.automationOfPipeline", { pipeline: detail.builtFromAutomation.pipeline.name })}
              </Link>
            </p>
          ) : null}
        </div>
        <div className="flex w-full flex-col gap-5">
          <div className="flex items-center gap-2 lg:justify-end">
            {primaryAction}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon" aria-label={t("area.pipelines-cases.pipelines.item.actions")}>
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  disabled={!stageAutomation || rerunCurrentStageAutomation.isPending || rerunBlockedByPermission}
                  title={rerunBlockedByPermission ? t("area.pipelines-cases.pipelines.item.permissionMissing") : undefined}
                  onSelect={(event) => {
                    event.preventDefault();
                    setRetryTargetStageId(null);
                    setRetryDialogScope("current_stage");
                  }}
                >
                  {rerunCurrentStageAutomation.isPending && retryDialogScope === "current_stage" ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <CircleDot className="h-4 w-4" />
                  )}
                  {t("area.pipelines-cases.pipelines.retry.rerunStep")}
                </DropdownMenuItem>
                {previousRetryPlan?.allowed ? (
                  <DropdownMenuItem
                    disabled={retryStageAutomation.isPending}
                    onSelect={(event) => {
                      event.preventDefault();
                      setRetryTargetStageId(null);
                      setRetryDialogScope("previous_stage");
                    }}
                  >
                    {retryStageAutomation.isPending && retryDialogScope === "previous_stage" ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUpDown className="h-4 w-4" />
                    )}
                    {t("area.pipelines-cases.pipelines.item.retryPreviousMenu")}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  disabled={moveStageOptions.length === 0 || moveItemToStage.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    setMoveStageKey(moveStageOptions[0]?.key ?? "");
                    setMoveDialogOpen(true);
                  }}
                >
                  <ArrowUpDown className="h-4 w-4" />
                  {t("area.pipelines-cases.pipelines.item.moveToStageMenu")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  disabled={!removeStage || removeItem.isPending}
                  onSelect={(event) => {
                    event.preventDefault();
                    setRemoveDialogOpen(true);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                  {t("area.pipelines-cases.pipelines.item.removeItem")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      <Dialog open={moveDialogOpen} onOpenChange={setMoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("area.pipelines-cases.pipelines.item.moveDialog.title")}</DialogTitle>
            <DialogDescription>
              {t("area.pipelines-cases.pipelines.item.moveDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="rounded-sm border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100">
              <div className="flex gap-2">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  {t("area.pipelines-cases.pipelines.item.moveDialog.warning")}
                </p>
              </div>
            </div>
            <label className="block space-y-2">
              <span className="text-sm font-medium text-foreground">{t("area.pipelines-cases.pipelines.item.moveDialog.stage")}</span>
              <Select value={moveStageKey} onValueChange={setMoveStageKey}>
                <SelectTrigger>
                  <SelectValue placeholder={t("area.pipelines-cases.pipelines.item.moveDialog.chooseStage")} />
                </SelectTrigger>
                <SelectContent>
                  {moveStageOptions.map((stage) => (
                    <SelectItem key={stage.id} value={stage.key}>
                      {stage.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setMoveDialogOpen(false)}
              disabled={moveItemToStage.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              onClick={() => moveItemToStage.mutate()}
              disabled={!selectedMoveStage || moveItemToStage.isPending}
            >
              {moveItemToStage.isPending ? t("area.pipelines-cases.pipelines.item.moveDialog.moving") : t("area.pipelines-cases.pipelines.item.moveDialog.moveTo", { name: selectedMoveStage?.name ?? t("area.pipelines-cases.pipelines.item.moveDialog.stageFallback") })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(retryDialogScope)} onOpenChange={(open) => {
        if (!open) {
          setRetryDialogScope(null);
          setRetryDialogError(null);
        }
      }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{retryDialogScope === "previous_stage" ? t("area.pipelines-cases.pipelines.retry.previousStep") : t("area.pipelines-cases.pipelines.retry.rerunStep")}</DialogTitle>
            <DialogDescription>
              {t("area.pipelines-cases.pipelines.item.retryDialog.description")}
            </DialogDescription>
          </DialogHeader>
          {retryPlan.isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("area.pipelines-cases.pipelines.item.retryDialog.checking")}
            </div>
          ) : retryPlan.error ? (
            <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
              {retryPlan.error instanceof ApiError && retryPlan.error.message
                ? retryPlan.error.message
                : t("area.pipelines-cases.pipelines.item.retryDialog.checkFailed")}
            </div>
          ) : retryPlan.data ? (
            <div className="space-y-4 py-2">
              <div className="grid gap-3 text-sm sm:grid-cols-2">
                <div>
                  <div className="text-xs font-medium uppercase text-muted-foreground">{t("area.pipelines-cases.pipelines.item.retryDialog.from")}</div>
                  <div className="mt-1 font-medium text-foreground">{retryPlan.data.currentStage.name}</div>
                </div>
                <div>
                  <div id="retry-runs-at-label" className="text-xs font-medium uppercase text-muted-foreground">{t("area.pipelines-cases.pipelines.item.retryDialog.runsAt")}</div>
                  {retryShowTargetDropdown ? (
                    <Select
                      value={retrySelectedTargetId}
                      onValueChange={(value) => setRetryTargetStageId(value)}
                    >
                      <SelectTrigger className="mt-1 w-full" aria-labelledby="retry-runs-at-label">
                        <SelectValue placeholder={t("area.pipelines-cases.pipelines.item.retryDialog.chooseStep")} />
                      </SelectTrigger>
                      <SelectContent>
                        {retryAvailableTargets.map((stage) => (
                          <SelectItem key={stage.id} value={stage.id}>
                            {stage.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <div className="mt-1 font-medium text-foreground">{retryPlan.data.targetStage?.name ?? t("area.pipelines-cases.pipelines.item.retryDialog.noRetryableStep")}</div>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <div className="text-xs font-medium uppercase text-muted-foreground">{t("area.pipelines-cases.pipelines.item.retryDialog.automation")}</div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-1 text-foreground">
                    {retryPlan.data.routine ? (
                      <>
                        <Link
                          to={`/routines/${retryPlan.data.routine.id}`}
                          className="font-medium underline-offset-2 hover:underline"
                        >
                          {retryPlan.data.routine.title}
                        </Link>
                        <span className="text-muted-foreground">{t("area.pipelines-cases.pipelines.item.retryDialog.assignedTo")}</span>
                        {retryPlan.data.routine.assigneeAgent ? (
                          <Link
                            to={`/agents/${retryPlan.data.routine.assigneeAgent.id}`}
                            className="font-medium underline-offset-2 hover:underline"
                          >
                            {retryPlan.data.routine.assigneeAgent.name}
                          </Link>
                        ) : (
                          <span className="font-medium text-muted-foreground">{t("area.pipelines-cases.pipelines.item.retryDialog.noResponsible")}</span>
                        )}
                      </>
                    ) : (
                      t("area.pipelines-cases.pipelines.item.retryDialog.noRoutine")
                    )}
                  </div>
                </div>
              </div>

              <div className="relative space-y-4" aria-live="polite" aria-busy={retryPreflightRefreshing}>
                {retryPreflightRefreshing ? (
                  <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-sm bg-background/70 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t("area.pipelines-cases.pipelines.item.retryDialog.checking")}
                  </div>
                ) : null}
                <div className={cn("space-y-4", retryPreflightRefreshing && "opacity-50")}>
                  <div className="grid gap-2 text-sm sm:grid-cols-4">
                    <RetryMetric label={t("area.pipelines-cases.pipelines.item.retryDialog.metricChildren")} value={retryPlan.data.effectCounts.directChildren} />
                    <RetryMetric label={t("area.pipelines-cases.pipelines.item.retryDialog.metricDescendants")} value={retryPlan.data.effectCounts.descendants} />
                    <RetryMetric label={t("area.pipelines-cases.pipelines.item.retryDialog.metricLinkedTasks")} value={retryPlan.data.effectCounts.linkedAutomationIssues} />
                    <RetryMetric label={t("area.pipelines-cases.pipelines.item.retryDialog.metricActiveWork")} value={retryPlan.data.effectCounts.activeDescendants} tone={retryPlan.data.effectCounts.activeDescendants > 0 ? "warning" : "default"} />
                  </div>

                  {retryPlan.data.blockers.length > 0 ? (
                    <div className="space-y-2">
                      {retryPlan.data.blockers.map((blocker) => (
                        <div
                          key={blocker.kind}
                          className={cn(
                            "flex gap-2 rounded-sm border p-3 text-sm",
                            "border-destructive/30 bg-destructive/5 text-destructive",
                          )}
                        >
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                          <span>{blocker.message}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  {retryIsNonImmediateTarget ? (
                    <p className="text-xs text-muted-foreground">
                      {t("area.pipelines-cases.pipelines.item.retryDialog.earlierStep")}
                    </p>
                  ) : null}

                  <div className="space-y-2">
                    {retryCleanupItems(retryPlan.data).map((option) => {
                      const checked = selectedRetryCleanupIds.has(option.id);
                      return (
                        <label
                          key={option.id}
                          className={cn(
                            "grid grid-cols-(--gtc-46) gap-3 py-1.5 text-sm",
                            option.disabled && !option.required ? "text-muted-foreground" : "text-foreground",
                          )}
                        >
                          <Checkbox
                            checked={checked}
                            disabled={option.disabled || option.required}
                            onCheckedChange={(value) => {
                              setSelectedRetryCleanupIds((current) => {
                                const next = new Set(current);
                                if (value) next.add(option.id);
                                else next.delete(option.id);
                                return next;
                              });
                            }}
                          />
                          <span>
                            <span className="block font-medium">
                              {option.label}{typeof option.count === "number" ? ` (${formatNumber(option.count)})` : ""}
                            </span>
                            <span className="block text-xs text-muted-foreground">{option.description}</span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </div>

              {retryDialogError ? (
                <div className="rounded-sm border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
                  {retryDialogError}
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setRetryDialogScope(null)}
              disabled={rerunCurrentStageAutomation.isPending || retryStageAutomation.isPending}
            >
              {t("common.cancel")}
            </Button>
            <Button
              type="button"
              disabled={
                !retryPlan.data?.allowed ||
                rerunCurrentStageAutomation.isPending ||
                retryStageAutomation.isPending
              }
              onClick={() => {
                const plan = retryPlan.data;
                if (!plan) return;
                if (plan.scope === "current_stage") rerunCurrentStageAutomation.mutate();
                else retryStageAutomation.mutate(plan);
              }}
            >
              {(rerunCurrentStageAutomation.isPending || retryStageAutomation.isPending)
                ? t("area.pipelines-cases.pipelines.item.starting")
                : retryPlan.data ? retryPrimaryActionLabel(retryPlan.data) : t("area.pipelines-cases.pipelines.item.retryDialog.retry")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {activeWork ? (
        <ActivePipelineWorkBanner activeWork={activeWork} />
      ) : (
        <PipelineLivenessBanner
          liveness={detail.liveness}
          onRetry={(kind) => retryLiveness.mutate(kind)}
          retryPending={retryLiveness.isPending}
          retryError={livenessRetryError}
        />
      )}

      {banner.visible ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-border bg-muted/20 py-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="text-sm font-semibold text-foreground">{t("area.pipelines-cases.pipelines.item.readyToMove", { stage: banner.stageName })}</h2>
            {banner.rationale ? <p className="mt-1 text-sm text-muted-foreground">{banner.rationale}</p> : null}
          </div>
          {banner.suggestionId ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                onClick={() => resolveSuggestion.mutate({ resolution: "accept", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <Check className="mr-2 h-4 w-4" />
                {t("area.pipelines-cases.pipelines.review.approve")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => resolveSuggestion.mutate({ resolution: "dismiss", suggestionId: banner.suggestionId! })}
                disabled={resolveSuggestion.isPending}
              >
                <X className="mr-2 h-4 w-4" />
                {t("area.pipelines-cases.pipelines.review.notYet")}
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {changedNotice ? (
        <section className="mb-5 flex flex-col gap-3 border-y border-amber-300 bg-amber-50 py-4 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 md:flex-row md:items-center md:justify-between">
          <div className="flex gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div>
              <h2 className="text-sm font-semibold">{changedNotice.title}</h2>
              <p className="mt-1 text-sm opacity-85">{changedNotice.body}</p>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => acknowledgeChange.mutate()}
            disabled={acknowledgeChange.isPending}
          >
            {t("area.pipelines-cases.pipelines.item.acknowledge")}
          </Button>
        </section>
      ) : null}

      {(childrenGate || (breakdown?.waitForPieces ?? false)) && waitingChildren.length > 0 ? (
        <section aria-label={t("area.pipelines-cases.pipelines.item.waitingAria")} className="mb-5 border-y border-border px-4 py-4">
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground">
              <ListTree className="h-4 w-4 text-muted-foreground" />
              {breakdown
                ? t("area.pipelines-cases.pipelines.item.waitingOnPieces", { waiting: waitingChildren.length, total: pieceCountTotal, piece: pieceLabel(pieceCountTotal), done: pieceCountDone })
                : t("area.pipelines-cases.pipelines.item.waitingOnChildren", { count: pieceCountTotal, waiting: waitingChildren.length, total: pieceCountTotal })}
            </div>
            <ul className="divide-y divide-border">
              {waitingChildren.map((row) => (
                <WaitingChildRow key={row.case.id} row={row} />
              ))}
            </ul>
          </div>
        </section>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-(--gtc-45)">
        <main className="min-w-0 space-y-8">
          <PipelineItemBodyDocument
            caseId={caseId}
            legacySummary={detail.case.summary ?? null}
            hasLegacyLongFields={mainPaneFields.length > 0}
            conversationIssueId={conversationIssueId}
            conversationIssue={activeConversationIssue ?? null}
            agentMap={agentMap}
            userProfileMap={userProfileMap}
            mentions={mentionOptions}
            imageUploadHandler={conversationIssueId ? handleConversationImageUpload : undefined}
            locationHash={location.hash}
            onStartConversation={startConversationForBody}
            onAfterChange={invalidateItem}
          />

          {mainPaneFields.length > 0 ? (
            <details className="group rounded-md border border-border">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
                {t("area.pipelines-cases.pipelines.item.moreDetails")}
                <span className="text-(length:--text-micro) font-normal text-muted-foreground">
                  {t("area.pipelines-cases.pipelines.item.fieldsCount", { count: mainPaneFields.length })}
                </span>
              </summary>
              <div className="space-y-5 border-t border-border px-3 py-3">
                {mainPaneFields.map((field) => (
                  <div key={field.key} className="min-w-0">
                    <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {field.label}
                    </h3>
                    <MarkdownBody className="text-sm leading-7 text-foreground">
                      {field.value}
                    </MarkdownBody>
                  </div>
                ))}
              </div>
            </details>
          ) : null}

          <ItemOutputsSection
            items={outputs.data?.items ?? []}
            loading={outputs.isLoading}
            error={outputs.isError}
            onRetry={() => outputs.refetch()}
          />

          <DetailSection title={t("area.pipelines-cases.pipelines.item.sectionConversation")}>
            {activeConversationIssue ? (
              <div className="py-3">
                <IssueChatThread
                  comments={conversationThreadComments}
                  interactions={interactions.data ?? []}
                  feedbackVotes={feedbackVotes ?? []}
                  feedbackDataSharingPreference={feedbackDataSharingPreference}
                  feedbackTermsUrl={null}
                  linkedRuns={conversationTimelineRuns}
                  timelineEvents={conversationTimelineEvents}
                  liveRuns={resolvedConversationLiveRuns}
                  activeRun={resolvedConversationActiveRun}
                  issueId={activeConversationIssue.id}
                  blockedBy={activeConversationIssue.blockedBy ?? []}
                  blockerAttention={activeConversationIssue.blockerAttention ?? null}
                  successfulRunHandoff={activeConversationIssue.successfulRunHandoff ?? null}
                  scheduledRetry={activeConversationIssue.scheduledRetry ?? null}
                  recoveryAction={activeConversationIssue.activeRecoveryAction ?? null}
                  companyId={activeConversationIssue.companyId}
                  projectId={activeConversationIssue.projectId}
                  issueStatus={activeConversationIssue.status}
                  agentMap={agentMap}
                  currentUserId={currentUserId}
                  userLabelMap={userLabelMap}
                  userProfileMap={userProfileMap}
                  draftKey={`myrmidon:pipeline-item-conversation-draft:${activeConversationIssue.id}`}
                  autoScrollToLatestOnInitialLoad={false}
                  enableReassign
                  reassignOptions={commentReassignOptions}
                  currentAssigneeValue={actualAssigneeValue}
                  suggestedAssigneeValue={suggestedAssigneeValue}
                  mentions={mentionOptions}
                  onAdd={addConversationComment}
                  onVote={handleConversationVote}
                  imageUploadHandler={handleConversationImageUpload}
                  onAttachImage={handleConversationAttachImage}
                  onDeleteComment={handleDeleteConversationComment}
                  onInterruptQueued={handleInterruptConversationQueuedRun}
                  onCancelQueued={handleCancelConversationQueuedComment}
                  issueWorkMode={activeConversationIssue.workMode ?? "standard"}
                  onWorkModeChange={(nextMode) => {
                    const currentMode: IssueWorkMode = activeConversationIssue.workMode ?? "standard";
                    if (currentMode === nextMode) return;
                    return updateConversationWorkMode(nextMode);
                  }}
                  onAcceptInteraction={handleAcceptConversationInteraction}
                  onRejectInteraction={handleRejectConversationInteraction}
                  onSubmitInteractionAnswers={handleSubmitConversationInteractionAnswers}
                  onCancelInteraction={handleCancelConversationInteraction}
                  assigneeUserId={activeConversationIssue.assigneeUserId ?? null}
                />
              </div>
            ) : (
              <div className="flex flex-col items-start gap-3 py-3 text-sm text-muted-foreground">
                <p>{t("area.pipelines-cases.pipelines.item.noConversation")}</p>
                <Button size="sm" variant="outline" onClick={() => startConversation.mutate()} disabled={startConversation.isPending}>
                  <MessageSquare className="mr-2 h-4 w-4" />
                  {startConversation.isPending ? t("area.pipelines-cases.pipelines.item.starting") : t("area.pipelines-cases.pipelines.item.startConversation")}
                </Button>
              </div>
            )}
          </DetailSection>
        </main>

        <aside className="min-w-0 space-y-8">
          {reviewPanel}

          <DetailSection title={t("area.pipelines-cases.pipelines.item.sectionLinkedWork")}>
            <PipelineWorkReferences references={workReferences} />
          </DetailSection>

          <DetailSection
            title={
              breakdown
                ? pieceCountTotal > 0
                  ? t("area.pipelines-cases.pipelines.item.builtFromPieces", { count: pieceCountTotal, piece: pieceLabel(pieceCountTotal) })
                  : t("area.pipelines-cases.pipelines.item.noPiecesNeeded", { piece: pieceNounPluralLabel })
                : t("area.pipelines-cases.pipelines.board.builtFrom", { count: pieceCountTotal, formatted: pieceCountTotal })
            }
          >
            {breakdown && pieceCountTotal > 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                {t("area.pipelines-cases.pipelines.item.piecesFinished", { done: pieceCountDone, total: pieceCountTotal, piece: pieceLabel(pieceCountTotal) })}
              </p>
            ) : null}
            {breakdown && pieceCountTotal === 0 ? (
              <p className="py-2 text-sm text-muted-foreground">
                {t("area.pipelines-cases.pipelines.item.nothingSplit", { piece: pieceNounPluralLabel })}
              </p>
            ) : (
              <BuiltFromTree rows={childRows} />
            )}
            {breakdown && breakdown.targetPipelineId && pieceCountTotal > 0 ? (
              <Link
                to={`/pipelines/${breakdown.targetPipelineId}`}
                className="mt-2 inline-block text-sm font-medium text-foreground hover:underline"
              >
                {t("area.pipelines-cases.pipelines.item.openAllPieces", { piece: pieceNounPluralLabel })}
              </Link>
            ) : null}
          </DetailSection>

          <DetailSection title={t("area.pipelines-cases.pipelines.item.sectionDetails")}>
            {itemFields.length > 0 ? (
              <dl className="divide-y divide-border">
                {itemFields.map((field) => (
                  <div key={field.key} className="grid grid-cols-(--gtc-47) gap-3 py-2 text-sm">
                    <dt className="text-muted-foreground">{field.label}</dt>
                    <dd className="min-w-0 text-foreground [overflow-wrap:anywhere]">{field.value}</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.item.noDetails")}</p>
            )}
          </DetailSection>

          <DetailSection title={t("area.pipelines-cases.pipelines.item.sectionActivity")}>
            {eventRows.length > 0 ? (
              <ol className="divide-y divide-border">
                {eventRows.map((event) => (
                  <li key={event.id} className="py-2 text-sm">
                    <p className="text-foreground">
                      <PipelineEventText event={event} pipelineId={pipelineId} stages={stageLookup} />
                    </p>
                    <time className="text-xs text-muted-foreground">{formatShortDate(event.createdAt)}</time>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="py-3 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.item.noActivity")}</p>
            )}
          </DetailSection>
        </aside>
      </div>

      <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("area.pipelines-cases.pipelines.item.removeItem")}</DialogTitle>
            <DialogDescription>
              {t("area.pipelines-cases.pipelines.item.removeDialog.description")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>{t("area.pipelines-cases.pipelines.item.removeDialog.keep")}</Button>
            <Button variant="destructive" onClick={() => removeItem.mutate()} disabled={removeItem.isPending || !removeStage}>
              {removeItem.isPending ? t("area.pipelines-cases.pipelines.item.removeDialog.removing") : t("area.pipelines-cases.pipelines.item.removeItem")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ActivePipelineWorkBanner({ activeWork }: { activeWork: PipelineCaseActiveWork }) {
  const { t } = useTranslation();
  const isAutomation = activeWork.issueRole === "automation";
  const title = isAutomation ? t("area.pipelines-cases.pipelines.banner.automationRunning") : t("area.pipelines-cases.pipelines.banner.linkedRunning");
  const issueLabel = activeWork.issueIdentifier ?? activeWork.issueTitle;
  const issuePath = createIssueDetailPath(activeWork.issueIdentifier ?? activeWork.issueId);
  const startedLabel = activeWork.startedAt ? t("area.pipelines-cases.pipelines.banner.started", { time: relativeTime(activeWork.startedAt) }) : null;

  return (
    <section
      aria-label={title}
      className="mb-5 flex flex-col gap-3 rounded-lg border border-blue-300 bg-blue-50 px-4 py-4 text-blue-950 dark:border-blue-900/70 dark:bg-blue-950/25 dark:text-blue-100 md:flex-row md:items-center md:justify-between"
    >
      <div className="flex min-w-0 gap-3">
        <CircleDot className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" />
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-500" aria-hidden="true" />
            {title}
          </h2>
          <p className="mt-1 text-sm opacity-85">
            <Trans
              i18nKey="area.pipelines-cases.pipelines.banner.activeWith"
              values={{ issue: issueLabel, agent: activeWork.agentName, started: startedLabel ? ` · ${startedLabel}` : "" }}
              components={[<Link key="0" to={issuePath} className="font-medium underline-offset-2 hover:underline" />]}
            />
          </p>
        </div>
      </div>
      <Button
        asChild
        size="sm"
        variant="outline"
        className="border-blue-300 bg-transparent hover:bg-blue-100 dark:border-blue-900/70 dark:hover:bg-blue-950/40"
      >
        <Link to={issuePath}>
          <ExternalLink className="mr-2 h-4 w-4" />
          {t("area.pipelines-cases.pipelines.banner.openTask")}
        </Link>
      </Button>
    </section>
  );
}

function hasChildrenGate(stage: PipelineStage) {
  const config = stage.config ?? {};
  return config.requireChildrenTerminal === true ||
    (typeof config.autoAdvanceOnChildrenTerminal === "string" && config.autoAdvanceOnChildrenTerminal.trim().length > 0);
}

function isTerminalChild(row: { case: PipelineCase; stage: PipelineStage }) {
  return Boolean(row.case.terminalKind) || row.stage.kind === "done" || row.stage.kind === "cancelled";
}

function getWaitingChildren<T extends { case: PipelineCase; stage: PipelineStage }>(rows: T[]) {
  return rows.filter((row) => !isTerminalChild(row));
}

function WaitingChildRow({
  row,
}: {
  row: {
    case: PipelineCase;
    stage: PipelineStage;
    activeWork?: PipelineCaseActiveWork | null;
    descendantActiveWorkCount?: number | null;
  };
}) {
  const { t } = useTranslation();
  const liveDownstreamCount = descendantActiveWorkCount(row);

  return (
    <li>
      <Link
        to={`/pipelines/${row.case.pipelineId}/items/${row.case.id}`}
        className="grid grid-cols-(--gtc-48) items-start gap-3 py-2 text-sm"
      >
        <GitBranch className="h-4 w-4 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block font-medium text-foreground [overflow-wrap:anywhere]">{row.case.title}</span>
          {row.activeWork || liveDownstreamCount > 0 ? (
            <span className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
              {row.activeWork ? (
                <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden="true" />
                  {t("area.pipelines-cases.pipelines.banner.liveWith", { agent: row.activeWork.agentName })}
                </span>
              ) : null}
              {liveDownstreamCount > 0 ? (
                <span>{formatLiveDownstream(liveDownstreamCount)}</span>
              ) : null}
            </span>
          ) : null}
        </span>
        <span className="shrink-0 rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">
          {humanizePipelineItemStatus(row.case.terminalKind ?? row.stage.kind)}
        </span>
      </Link>
    </li>
  );
}

interface ReviewDecisionConfig {
  approveToStageKey: string | null;
  rejectToStageKey: string | null;
  requestChangesToStageKey: string | null;
  requireRejectReason: boolean;
  requireRequestChangesReason: boolean;
}

interface ReviewDecisionAction {
  decision: PipelineReviewDecision;
  label: string;
  targetStageName: string;
  targetStageKey: string;
  requireReason: boolean;
  variant: "default" | "outline" | "destructive";
}

function configString(config: Record<string, unknown> | null | undefined, key: string) {
  const value = config?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function stageKeyForKind(stages: PipelineStage[], kind: string) {
  return stages.find((stage) => stage.kind === kind)?.key ?? stages.find((stage) => stage.key === kind)?.key ?? null;
}

function reviewDecisionConfig(stage: PipelineStage, stages: PipelineStage[]): ReviewDecisionConfig | null {
  if (stage.kind !== "review") return null;
  const config = stage.config ?? {};
  return {
    approveToStageKey: configString(config, "approveToStageKey") ?? stageKeyForKind(stages, "done"),
    rejectToStageKey: configString(config, "rejectToStageKey") ?? stageKeyForKind(stages, "cancelled"),
    requestChangesToStageKey: configString(config, "requestChangesToStageKey"),
    requireRejectReason: config.requireRejectReason !== false,
    requireRequestChangesReason: config.requireRequestChangesReason !== false,
  };
}

function reviewDecisionActions(
  config: ReviewDecisionConfig,
  stageLookup: Map<string, string>,
): ReviewDecisionAction[] {
  const actions: ReviewDecisionAction[] = [];
  if (config.approveToStageKey) {
    actions.push({
      decision: "approve",
      label: i18n.t("area.pipelines-cases.pipelines.review.approve"),
      targetStageKey: config.approveToStageKey,
      targetStageName: stageLookup.get(config.approveToStageKey) ?? humanizePipelineItemStatus(config.approveToStageKey),
      requireReason: false,
      variant: "default",
    });
  }
  if (config.requestChangesToStageKey) {
    actions.push({
      decision: "request_changes",
      label: i18n.t("area.pipelines-cases.pipelines.review.requestChanges"),
      targetStageKey: config.requestChangesToStageKey,
      targetStageName: stageLookup.get(config.requestChangesToStageKey) ?? humanizePipelineItemStatus(config.requestChangesToStageKey),
      requireReason: config.requireRequestChangesReason,
      variant: "outline",
    });
  }
  if (config.rejectToStageKey) {
    actions.push({
      decision: "reject",
      label: i18n.t("area.pipelines-cases.pipelines.review.reject"),
      targetStageKey: config.rejectToStageKey,
      targetStageName: stageLookup.get(config.rejectToStageKey) ?? humanizePipelineItemStatus(config.rejectToStageKey),
      requireReason: config.requireRejectReason,
      variant: "destructive",
    });
  }
  return actions;
}

function reviewDecisionToastTitle(decision: PipelineReviewDecision, movedToNextItem: boolean) {
  if (decision === "approve") {
    return movedToNextItem ? i18n.t("area.pipelines-cases.pipelines.review.toast.approvedNext") : i18n.t("area.pipelines-cases.pipelines.review.toast.approved");
  }
  if (decision === "request_changes") {
    return movedToNextItem ? i18n.t("area.pipelines-cases.pipelines.review.toast.changesRequestedNext") : i18n.t("area.pipelines-cases.pipelines.review.toast.changesRequested");
  }
  return movedToNextItem ? i18n.t("area.pipelines-cases.pipelines.review.toast.rejectedNext") : i18n.t("area.pipelines-cases.pipelines.review.toast.rejected");
}

function ReviewDecisionPanel({
  actions,
  note,
  requireReason,
  pending,
  pendingDecision,
  nextItemTitle,
  onNoteChange,
  onDecide,
}: {
  actions: ReviewDecisionAction[];
  note: string;
  requireReason: boolean;
  pending: boolean;
  pendingDecision: PipelineReviewDecision | null;
  nextItemTitle: string | null;
  onNoteChange: (value: string) => void;
  onDecide: (decision: PipelineReviewDecision) => void;
}) {
  const { t } = useTranslation();
  const trimmedNote = note.trim();

  return (
    <section>
      <h2 className="mb-3 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.review.title")}</h2>
      <div className="border-y border-amber-300 bg-amber-50/70 p-5 text-amber-950 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-100 sm:p-6">
        <div className="space-y-5">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-1 h-5 w-5 shrink-0" />
            <div>
              <p className="text-2xl font-semibold leading-tight">{t("area.pipelines-cases.pipelines.review.inReview")}</p>
              <p className="mt-1 text-sm opacity-80">
                {t("area.pipelines-cases.pipelines.review.decide")}
              </p>
            </div>
          </div>

          <label className="block space-y-1.5 text-sm font-medium">
            <span>{t("area.pipelines-cases.pipelines.board.reason")}</span>
            <Textarea
              value={note}
              onChange={(event) => onNoteChange(event.target.value)}
              rows={4}
              placeholder={requireReason ? t("area.pipelines-cases.pipelines.review.reasonRequired") : t("area.pipelines-cases.pipelines.review.reasonOptional")}
              className="bg-background/90 text-foreground"
            />
          </label>

          <div className="space-y-2">
            {actions.map((action) => {
              const reasonMissing = action.requireReason && trimmedNote.length === 0;
              const isPendingAction = pending && pendingDecision === action.decision;
              return (
                <Button
                  key={action.decision}
                  type="button"
                  variant={action.variant}
                  className="h-auto min-h-14 w-full justify-start px-4 py-3 text-left"
                  aria-label={t("area.pipelines-cases.pipelines.review.actionAria", { label: action.label, target: action.targetStageName })}
                  disabled={pending || reasonMissing}
                  onClick={() => onDecide(action.decision)}
                >
                  {isPendingAction ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : action.decision === "approve" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <X className="h-4 w-4" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block">{action.label}</span>
                    <span className="block truncate text-xs font-normal opacity-75">
                      {t("area.pipelines-cases.pipelines.review.moveTo", { target: action.targetStageName })}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>

          {nextItemTitle ? (
            <p className="text-xs opacity-75">
              {t("area.pipelines-cases.pipelines.review.nextInQueue")} <span className="font-medium">{nextItemTitle}</span>
            </p>
          ) : (
            <p className="text-xs opacity-75">{t("area.pipelines-cases.pipelines.review.queueEmpty")}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function PipelineEventText({
  event,
  pipelineId,
  stages,
}: {
  event: PipelineCaseEvent;
  pipelineId: string;
  stages: Map<string, string>;
}) {
  const { t } = useTranslation();
  const kind = event.type.startsWith("case.") ? event.type.slice("case.".length) : event.type;
  if (kind === "automation_executed" && event.automation) {
    const routineName = event.automation.routine?.title ?? t("area.pipelines-cases.pipelines.event.theAutomation");
    const issue = event.automation.issue;
    return (
      <>
        <Trans
          i18nKey="area.pipelines-cases.pipelines.event.automationCompleted"
          values={{ routine: routineName }}
          components={[<span key="0" className="font-medium" />]}
        />
        {issue ? (
          <>
            {" -> "}
            <Link
              to={issueDetailPath(issue)}
              className="font-medium text-foreground hover:underline"
            >
              {issue.identifier ?? issue.title}
            </Link>
          </>
        ) : null}
        .
      </>
    );
  }
  if (kind === "automation_failed") {
    const stageId = event.automation?.stage?.id ?? event.toStageId ?? null;
    return (
      <>
        {formatPipelineItemEvent(event, stages)}
        {stageId ? (
          <>
            {" "}
            <Link to={pipelineStageAutomationSettingsHref(pipelineId, stageId)} className="font-medium text-foreground hover:underline">
              {t("area.pipelines-cases.pipelines.event.fixStageSettings")}
            </Link>
          </>
        ) : null}
      </>
    );
  }
  return <>{formatPipelineItemEvent(event, stages)}</>;
}

function DetailSection({
  title,
  trailing,
  children,
}: {
  title: string;
  trailing?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
        <span>{title}</span>
        {trailing}
      </h2>
      <div className="border-y border-border">{children}</div>
    </section>
  );
}

function deliverableOutputPatterns(): Array<[RegExp, string]> {
  return [
    [/brief/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.brief")],
    [/spec/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.spec")],
    [/report/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.report")],
    [/design/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.design")],
    [/summary/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.summary")],
    [/plan/i, i18n.t("area.pipelines-cases.pipelines.outputs.deliverable.plan")],
  ];
}

function outputSourceRoleLabels(): Record<string, string> {
  return {
    origin: i18n.t("area.pipelines-cases.pipelines.outputs.role.origin"),
    conversation: i18n.t("area.pipelines-cases.pipelines.outputs.role.conversation"),
    work: i18n.t("area.pipelines-cases.pipelines.outputs.role.work"),
    automation: i18n.t("area.pipelines-cases.pipelines.outputs.role.automation"),
  };
}

function deliverableDocumentLabel(item: PipelineCaseDocumentOutputItem): string | null {
  const haystack = `${item.title} ${item.documentKey}`;
  for (const [pattern, label] of deliverableOutputPatterns()) {
    if (pattern.test(haystack)) return label;
  }
  return null;
}

function humanizeOutputStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  if (!normalized) return i18n.t("area.pipelines-cases.pipelines.outputs.unknown");
  return normalized.charAt(0).toUpperCase() + normalized.slice(1).replace(/_/g, " ");
}

function isLowTrustOutput(item: PipelineCaseOutputItem) {
  const trust = item.sourceTrust;
  return trust?.preset === LOW_TRUST_REVIEW_PRESET && trust.disposition === "quarantined";
}

function documentAnchorPath(item: PipelineCaseDocumentOutputItem) {
  return `${issueDetailPath({ id: item.sourceIssueId, identifier: item.sourceIssueIdentifier })}#document-${encodeURIComponent(item.documentKey)}`;
}

/** Renders an internal SPA link for app routes and a new-tab anchor for external URLs. */
function OutputLink({
  to,
  className,
  title,
  ariaLabel,
  children,
}: {
  to: string;
  className?: string;
  title?: string;
  ariaLabel?: string;
  children: ReactNode;
}) {
  if (/^https?:\/\//i.test(to)) {
    return (
      <a href={to} target="_blank" rel="noreferrer" className={className} title={title} aria-label={ariaLabel}>
        {children}
      </a>
    );
  }
  return (
    <Link to={to} className={className} title={title} aria-label={ariaLabel}>
      {children}
    </Link>
  );
}

function OutputMetaDot() {
  return <span className="inline-block h-(--sz-3px) w-(--sz-3px) shrink-0 rounded-full bg-muted-foreground/60" aria-hidden />;
}

function OutputDeliverableTag({ label }: { label: string }) {
  return (
    <Badge variant="outline" className="border-green-600 px-1.5 text-(length:--text-nano) font-semibold uppercase text-green-600 dark:border-green-400 dark:text-green-400">
      {label}
    </Badge>
  );
}

function OutputUnverifiedTag() {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="border-border px-1.5 text-(length:--text-nano) font-semibold uppercase text-muted-foreground">
      {t("area.pipelines-cases.pipelines.outputs.unverified")}
    </Badge>
  );
}

function OutputPreview({ text, dimmed }: { text: string; dimmed: boolean }) {
  return (
    <p className={cn("mt-0.5 text-xs text-muted-foreground line-clamp-2 sm:line-clamp-1", dimmed && "opacity-70")}>
      {text}
    </p>
  );
}

function ItemOutputMeta({ item, children }: { item: PipelineCaseOutputItem; children?: ReactNode }) {
  const { t } = useTranslation();
  const statusClass = issueStatusText[item.sourceIssueStatus] ?? issueStatusTextDefault;
  const roleLabel = outputSourceRoleLabels()[item.sourceRole] ?? humanizeOutputStatus(item.sourceRole);
  return (
    <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-(length:--text-micro) text-muted-foreground">
      <Link
        to={issueDetailPath({ id: item.sourceIssueId, identifier: item.sourceIssueIdentifier })}
        className="font-mono text-(length:--text-micro) text-muted-foreground hover:text-foreground hover:underline"
        title={item.sourceIssueTitle}
      >
        {item.sourceIssueIdentifier ?? t("area.pipelines-cases.pipelines.outputs.sourceTask")}
      </Link>
      <OutputMetaDot />
      <span>{roleLabel}</span>
      <OutputMetaDot />
      <span className={cn("inline-flex items-center gap-1", statusClass)}>
        <span className="inline-block h-1.5 w-1.5 rounded-full bg-current" />
        {humanizeOutputStatus(item.sourceIssueStatus)}
      </span>
      <OutputMetaDot />
      <span>{relativeTime(item.updatedAt)}</span>
      {children}
    </div>
  );
}

function ItemOutputDocumentRow({ item }: { item: PipelineCaseDocumentOutputItem }) {
  const { t } = useTranslation();
  const deliverable = deliverableDocumentLabel(item);
  const lowTrust = isLowTrustOutput(item);
  const href = documentAnchorPath(item);
  return (
    <div className="group flex items-start gap-(--sz-11px) py-2.5 hover:bg-accent/50">
      <FileText
        className={cn("mt-0.5 h-4 w-4 shrink-0", deliverable ? "text-green-600 dark:text-green-400" : "text-muted-foreground")}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Link to={href} className="truncate text-(length:--text-compact) font-medium text-foreground hover:underline" title={item.title}>
            {item.title}
          </Link>
          {deliverable ? <OutputDeliverableTag label={deliverable} /> : null}
          {lowTrust ? <OutputUnverifiedTag /> : null}
        </div>
        <ItemOutputMeta item={item} />
        {item.preview ? <OutputPreview text={item.preview} dimmed={lowTrust} /> : null}
      </div>
      <Link
        to={href}
        className="inline-flex h-(--sz-30px) w-(--sz-30px) shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t("area.pipelines-cases.pipelines.outputs.openTitle", { title: item.title })}
        title={t("area.pipelines-cases.pipelines.outputs.openDocument")}
      >
        <ArrowUpRight className="h-4 w-4" />
      </Link>
    </div>
  );
}

function ItemOutputWorkProductRow({ item }: { item: PipelineCaseWorkProductOutputItem }) {
  const { t } = useTranslation();
  const lowTrust = isLowTrustOutput(item);
  const href = item.url ?? issueDetailPath({ id: item.sourceIssueId, identifier: item.sourceIssueIdentifier });
  return (
    <div className="group flex items-start gap-(--sz-11px) py-2.5 hover:bg-accent/50">
      <Package className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <OutputLink to={href} className="truncate text-(length:--text-compact) font-medium text-foreground hover:underline" title={item.title}>
            {item.title}
          </OutputLink>
          {lowTrust ? <OutputUnverifiedTag /> : null}
        </div>
        <ItemOutputMeta item={item} />
        {item.preview ? <OutputPreview text={item.preview} dimmed={lowTrust} /> : null}
      </div>
      <OutputLink
        to={href}
        className="inline-flex h-(--sz-30px) w-(--sz-30px) shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        ariaLabel={t("area.pipelines-cases.pipelines.outputs.openTitle", { title: item.title })}
        title={t("area.pipelines-cases.pipelines.outputs.openWorkProduct")}
      >
        <ArrowUpRight className="h-4 w-4" />
      </OutputLink>
    </div>
  );
}

function ItemOutputAttachmentRow({ item }: { item: PipelineCaseAttachmentOutputItem }) {
  const { t } = useTranslation();
  const filename = item.filename ?? item.title ?? t("area.pipelines-cases.pipelines.outputs.attachment");
  const isImage = item.contentType?.startsWith("image/");
  return (
    <div
      id={`linked-attachment-${item.attachmentId}`}
      className="group flex items-start gap-(--sz-11px) py-2.5 hover:bg-accent/50"
    >
      {isImage ? (
        <a
          href={item.openPath}
          target="_blank"
          rel="noreferrer"
          className="mt-0.5 block h-(--sz-30px) w-10 shrink-0 overflow-hidden rounded-sm border border-border bg-accent/10"
          aria-label={t("area.pipelines-cases.pipelines.outputs.openTitle", { title: filename })}
        >
          <img src={item.contentPath} alt={filename} className="h-full w-full object-cover" loading="lazy" />
        </a>
      ) : (
        <Paperclip className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <a
            href={item.openPath}
            target="_blank"
            rel="noreferrer"
            className="truncate text-(length:--text-compact) font-medium text-foreground hover:underline"
            title={filename}
          >
            {filename}
          </a>
        </div>
        <ItemOutputMeta item={item}>
          <OutputMetaDot />
          <span>{item.contentType} · {formatBytes(item.byteSize)}</span>
        </ItemOutputMeta>
      </div>
      <div className="flex shrink-0 items-center">
        <a
          href={item.openPath}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-(--sz-30px) w-(--sz-30px) items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("area.pipelines-cases.pipelines.outputs.openTitle", { title: filename })}
          title={t("area.pipelines-cases.pipelines.outputs.open")}
        >
          <ArrowUpRight className="h-4 w-4" />
        </a>
        <a
          href={item.downloadPath}
          className="inline-flex h-(--sz-30px) w-(--sz-30px) items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t("area.pipelines-cases.pipelines.outputs.downloadTitle", { title: filename })}
          title={t("area.pipelines-cases.pipelines.outputs.download")}
        >
          <Download className="h-4 w-4" />
        </a>
      </div>
    </div>
  );
}

function ItemOutputsSection({
  items,
  loading,
  error,
  onRetry,
}: {
  items: PipelineCaseOutputItem[];
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  if (!loading && !error && items.length === 0) return null;

  const documents = items.filter((item): item is PipelineCaseDocumentOutputItem => item.kind === "document");
  const workProducts = items.filter((item): item is PipelineCaseWorkProductOutputItem => item.kind === "work_product");
  const attachments = items.filter((item): item is PipelineCaseAttachmentOutputItem => item.kind === "attachment");

  const groups: Array<{ key: string; label: string; icon: ReactNode; rows: ReactNode[] }> = [];
  if (documents.length > 0) {
    groups.push({
      key: "document",
      label: t("area.pipelines-cases.pipelines.outputs.groupDocuments"),
      icon: <FileText className="h-4 w-4 text-muted-foreground" />,
      rows: documents.map((item) => <ItemOutputDocumentRow key={item.id} item={item} />),
    });
  }
  if (workProducts.length > 0) {
    groups.push({
      key: "work_product",
      label: t("area.pipelines-cases.pipelines.outputs.groupWorkProducts"),
      icon: <Package className="h-4 w-4 text-muted-foreground" />,
      rows: workProducts.map((item) => <ItemOutputWorkProductRow key={item.id} item={item} />),
    });
  }
  if (attachments.length > 0) {
    groups.push({
      key: "attachment",
      label: t("area.pipelines-cases.pipelines.outputs.groupAttachments"),
      icon: <Paperclip className="h-4 w-4 text-muted-foreground" />,
      rows: attachments.map((item) => <ItemOutputAttachmentRow key={item.id} item={item} />),
    });
  }

  return (
    <DetailSection
      title={t("area.pipelines-cases.pipelines.outputs.title")}
      trailing={
        loading ? null : (
          <Badge variant="ghost" className="bg-muted text-(length:--text-micro) normal-case tracking-normal text-muted-foreground">
            {items.length}
          </Badge>
        )
      }
    >
      {loading ? (
        <div className="divide-y divide-border">
          {[0, 1, 2].map((index) => (
            <div key={index} className="py-2.5">
              <div className="h-(--sz-11px) w-1/2 rounded bg-muted" />
              <div className="mt-1.5 h-(--sz-9px) w-1/4 rounded bg-muted opacity-70" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 py-2.5 text-xs text-destructive">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>{t("area.pipelines-cases.pipelines.outputs.loadError")}</span>
          <button
            type="button"
            onClick={onRetry}
            className="ml-auto rounded-sm border border-border px-2 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {t("area.pipelines-cases.pipelines.outputs.retry")}
          </button>
        </div>
      ) : (
        <div>
          {groups.map((group, index) => (
            <div key={group.key} className={index > 0 ? "border-t border-border" : undefined}>
              <div className="flex items-center gap-1.5 pb-1.5 pt-2 text-(length:--text-micro) font-semibold uppercase tracking-wide text-muted-foreground">
                {group.icon}
                <span>{group.label}</span>
                <span>· {group.rows.length}</span>
              </div>
              <div className="divide-y divide-border">{group.rows}</div>
            </div>
          ))}
        </div>
      )}
    </DetailSection>
  );
}

function BuiltFromTree({
  rows,
}: {
  rows: Array<{ case: PipelineCase; stage: PipelineStage }>;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) {
    return <p className="py-3 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.builtFromTree.empty")}</p>;
  }
  return (
    <ul className="divide-y divide-border">
      {rows.map((row) => (
        <li key={row.case.id}>
          <Link
            to={`/pipelines/${row.case.pipelineId}/items/${row.case.id}`}
            className="grid grid-cols-(--gtc-49) items-center gap-3 py-3 text-sm hover:bg-muted/40"
          >
            <GitBranch className="h-4 w-4 text-muted-foreground" />
            <span className="min-w-0">
              <span className="block truncate font-medium text-foreground">{row.case.title}</span>
              {(row.case.childCount ?? 0) > 0 ? (
                <span className="block text-xs text-muted-foreground">
                  {t("area.pipelines-cases.pipelines.builtFromTree.nestedHidden", { count: row.case.childCount ?? 0 })}
                </span>
              ) : null}
            </span>
            <span className="rounded-sm border border-border px-2 py-0.5 text-xs text-muted-foreground">
              {humanizePipelineItemStatus(row.case.terminalKind ?? row.stage.kind)}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function formatShortDate(value: Date | string) {
  return new Intl.DateTimeFormat(i18n.language, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function PipelineAddItems({ pipelineId }: { pipelineId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [rows, setRows] = useState<DraftRow[]>(() => [newDraftRow(true)]);

  const pipeline = useQuery({
    queryKey: queryKeys.pipelines.detail(pipelineId),
    queryFn: () => pipelinesApi.get(pipelineId),
  });
  const intake = useQuery({
    queryKey: queryKeys.pipelines.intakeForm(pipelineId),
    queryFn: () => pipelinesApi.getIntakeForm(pipelineId),
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.pipelines-cases.pipelines.title"), href: "/pipelines" },
      { label: pipeline.data?.name ?? t("area.pipelines-cases.pipelines.board.pipeline"), href: `/pipelines/${pipelineId}` },
      { label: t("area.pipelines-cases.pipelines.board.addItems") },
    ]);
  }, [pipeline.data?.name, pipelineId, setBreadcrumbs, t]);

  const fields = intake.data?.fields ?? [];
  const errors = useMemo(() => validateDraftRows(rows, fields), [fields, rows]);
  const invalid = rows.length === 0 || Object.keys(errors).length > 0;

  const submit = useMutation({
    mutationFn: () => pipelinesApi.ingestCasesBatch(pipelineId, { items: buildBatchPayload(rows, fields) }),
    onSuccess: async (results) => {
      const failedByIndex = new Map<number, string>();
      results.forEach((result, index) => {
        if (!result.ok) failedByIndex.set(index, plainBatchError(result));
      });
      if (failedByIndex.size > 0) {
        setRows((current) =>
          current.map((row, index) => ({
            ...row,
            expanded: failedByIndex.has(index) ? true : row.expanded,
            serverError: failedByIndex.get(index) ?? null,
          })),
        );
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.detail(pipelineId) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.cases(pipelineId) }),
      ]);
      pushToast({ title: t("area.pipelines-cases.pipelines.addItems.submitted", { items: itemCountLabel(rows.length) }), tone: "success" });
      navigate(`/pipelines/${pipelineId}`);
    },
  });

  if (pipeline.isLoading || intake.isLoading) return <PageSkeleton />;
  if (!pipeline.data || !intake.data) {
    return <div className="mx-auto max-w-3xl py-10 text-sm text-muted-foreground">{t("area.pipelines-cases.pipelines.board.notFound")}</div>;
  }

  const firstStageName = intake.data.stageName ?? pipeline.data.stages[0]?.name ?? t("area.pipelines-cases.pipelines.addItems.firstStageFallback");

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">
          {t("area.pipelines-cases.pipelines.addItems.addTo", { name: pipeline.data.name })}
        </p>
        <h1 className="text-2xl font-semibold text-foreground">{t("area.pipelines-cases.pipelines.addItems.heading")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("area.pipelines-cases.pipelines.addItems.firstStageNote", { stage: firstStageName })}
        </p>
      </div>

      <div className="mb-5 flex items-center gap-2 border border-border bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
        <Info className="h-4 w-4 shrink-0" />
        <span>
          <Trans
            i18nKey="area.pipelines-cases.pipelines.addItems.fieldsSource"
            values={{ stage: firstStageName }}
            components={[<span key="0" className="font-medium text-foreground" />]}
          />
        </span>
      </div>

      <div className="space-y-3">
        {rows.map((row, index) => (
          <DraftItemRow
            key={row.id}
            row={row}
            index={index}
            fields={fields}
            intake={intake.data}
            errors={errors[row.id] ?? {}}
            onToggle={() =>
              setRows((current) => current.map((candidate) => candidate.id === row.id ? { ...candidate, expanded: !candidate.expanded } : candidate))
            }
            onRemove={() => setRows((current) => current.filter((candidate) => candidate.id !== row.id))}
            onChange={(fieldKey, value) =>
              setRows((current) =>
                current.map((candidate) =>
                  candidate.id === row.id
                    ? { ...candidate, values: { ...candidate.values, [fieldKey]: value }, serverError: null }
                    : candidate,
                ),
              )
            }
          />
        ))}

        <button
          type="button"
          className="flex h-14 w-full items-center justify-center border border-dashed border-border text-sm font-semibold text-foreground hover:bg-muted/40"
          onClick={() => setRows((current) => [...current, newDraftRow(false)])}
        >
          <Plus className="mr-2 h-4 w-4" />
          {t("area.pipelines-cases.pipelines.addItems.addAnother")}
        </button>
      </div>

      <div className="mt-10 flex items-center justify-between border-t border-border pt-5">
        <Button variant="outline" onClick={() => navigate(`/pipelines/${pipelineId}`)}>
          {t("common.cancel")}
        </Button>
        <div className="flex items-center gap-4">
          <span className="text-sm text-muted-foreground">
            {rows.length === 0 ? t("area.pipelines-cases.pipelines.addItems.addAtLeastOne") : t("area.pipelines-cases.pipelines.addItems.countLive")}
          </span>
          <Button disabled={invalid || submit.isPending} onClick={() => submit.mutate()}>
            {submit.isPending ? t("area.pipelines-cases.pipelines.addItems.submitting") : t("area.pipelines-cases.pipelines.addItems.submit", { items: itemCountLabel(rows.length) })}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DraftItemRow({
  row,
  index,
  fields,
  intake,
  errors,
  onToggle,
  onRemove,
  onChange,
}: {
  row: DraftRow;
  index: number;
  fields: PipelineIntakeField[];
  intake: PipelineIntakeForm;
  errors: FieldErrors;
  onToggle: () => void;
  onRemove: () => void;
  onChange: (fieldKey: string, value: string) => void;
}) {
  const { t } = useTranslation();
  const title = row.values.title?.trim() || t("area.pipelines-cases.pipelines.addItems.itemN", { n: index + 1 });
  const preview = fields
    .filter((field) => field.key !== "title")
    .map((field) => row.values[field.key])
    .filter((value): value is string => Boolean(value && value.trim()))
    .slice(0, 2)
    .join(" · ");

  return (
    <section className={cn("border border-border bg-background", row.expanded && "border-primary")}>
      <div className="grid grid-cols-(--gtc-17) items-center gap-3 px-4 py-3">
        <button type="button" className="min-w-0 text-left" onClick={onToggle}>
          <span className="block text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.addItems.itemN", { n: index + 1 })}</span>
          <span className="block truncate text-sm font-semibold text-foreground">{title}</span>
          {!row.expanded && preview ? <span className="block truncate text-xs text-muted-foreground">{preview}</span> : null}
          {!row.expanded && row.serverError ? <span className="block text-xs text-destructive">{row.serverError}</span> : null}
        </button>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" onClick={onToggle} aria-label={row.expanded ? t("area.pipelines-cases.pipelines.addItems.collapseItem") : t("area.pipelines-cases.pipelines.addItems.expandItem")}>
            {row.expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </Button>
          <Button variant="outline" size="icon" onClick={onRemove} aria-label={t("area.pipelines-cases.pipelines.item.removeItem")}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {row.expanded ? (
        <div className="grid gap-5 border-t border-border px-4 py-4 lg:grid-cols-(--gtc-50)">
          <div className="grid gap-4 md:grid-cols-2">
            {fields.map((field) => (
              <GeneratedField
                key={field.key}
                field={field}
                value={row.values[field.key] ?? ""}
                error={errors[field.key]}
                onChange={(value) => onChange(field.key, value)}
              />
            ))}
            {row.serverError ? <p className="md:col-span-2 text-sm text-destructive">{row.serverError}</p> : null}
          </div>
          <aside className="border border-border p-4 text-sm">
            <p className="mb-3 text-xs font-semibold uppercase tracking-(--tracking-eyebrow) text-muted-foreground">{t("area.pipelines-cases.pipelines.addItems.preview")}</p>
            <p className="font-semibold text-foreground">{title}</p>
            <p className="mt-3 text-xs text-muted-foreground">{t("area.pipelines-cases.pipelines.addItems.firstStageOnSubmit")}</p>
            <p className="font-semibold text-foreground">{intake.stageName ?? t("area.pipelines-cases.pipelines.addItems.firstStage")}</p>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

export function GeneratedField({
  field,
  value,
  error,
  onChange,
}: {
  field: PipelineIntakeField;
  value: string;
  error?: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation();
  const inputId = `pipeline-intake-${field.key}`;
  return (
    <label className={cn("block space-y-1", field.type === "multiline" && "md:col-span-2")}>
      <span className="text-sm font-medium text-foreground">
        {field.label}
        {field.required ? <span className="ml-1 font-normal text-destructive">{t("area.pipelines-cases.pipelines.addItems.required")}</span> : null}
      </span>
      {field.type === "select" ? (
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger id={inputId} aria-invalid={Boolean(error)} className="w-full">
            <SelectValue placeholder={t("area.pipelines-cases.pipelines.addItems.choose")} />
          </SelectTrigger>
          <SelectContent>
            {(field.options ?? []).map((option) => (
              <SelectItem key={option} value={option}>{option}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : field.type === "multiline" ? (
        <Textarea id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      ) : (
        <Input id={inputId} value={value} aria-invalid={Boolean(error)} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Review queue
// ---------------------------------------------------------------------------

type ReviewQueueKind = "suggestion" | "review" | "headsUp";

export interface ReviewQueueRow {
  id: string;
  caseId: string;
  pipelineId: string;
  pipelineName: string;
  title: string;
  prompt: string;
  kind: ReviewQueueKind;
  createdAt: string | Date | null;
  expectedVersion: number | null;
  suggestionId: string | null;
  requireRejectReason: boolean;
  requireRequestChangesReason: boolean;
  fields: Record<string, unknown> | null;
}

function reviewQueueSectionLabels(): Record<ReviewQueueKind, string> {
  return {
    suggestion: i18n.t("area.pipelines-cases.pipelines.queue.sectionSuggestion"),
    review: i18n.t("area.pipelines-cases.pipelines.queue.sectionReview"),
    headsUp: i18n.t("area.pipelines-cases.pipelines.queue.sectionHeadsUp"),
  };
}

const REVIEW_QUEUE_SECTION_ORDER: ReviewQueueKind[] = ["suggestion", "review", "headsUp"];

function humanizeFieldLabel(key: string) {
  return key
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function buildReviewQueueRows({
  attention,
  reviewCases,
}: {
  attention: PipelineAttentionFeed | null | undefined;
  reviewCases: PipelineReviewCaseRow[];
}): ReviewQueueRow[] {
  const rows = new Map<string, ReviewQueueRow>();
  const reviewStageCaseIds = new Set<string>([
    ...(attention?.reviews ?? []).map((entry) => entry.case.id),
    ...reviewCases.map((entry) => entry.case.id),
  ]);

  for (const entry of attention?.suggestions ?? []) {
    if (reviewStageCaseIds.has(entry.case.id)) continue;
    const id = `suggestion:${entry.case.id}`;
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt:
        entry.suggestion.rationale?.trim() ||
        i18n.t("area.pipelines-cases.pipelines.queue.promptThinksReady", { pipeline: entry.case.pipeline.name, title: entry.case.title }),
      kind: "suggestion",
      createdAt: entry.suggestion.createdAt ?? entry.case.updatedAt ?? null,
      expectedVersion: entry.case.version ?? null,
      suggestionId: entry.suggestion.id,
      requireRejectReason: false,
      requireRequestChangesReason: true,
      fields: null,
    });
  }

  for (const entry of attention?.reviews ?? []) {
    const id = `review:${entry.case.id}`;
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt:
        entry.case.summary?.trim() ||
        i18n.t("area.pipelines-cases.pipelines.queue.promptDecide", { title: entry.case.title }),
      kind: "review",
      createdAt: entry.case.updatedAt ?? entry.case.createdAt ?? null,
      expectedVersion: entry.review.expectedVersion ?? entry.case.version ?? null,
      suggestionId: null,
      requireRejectReason: entry.review.requireRejectReason !== false,
      requireRequestChangesReason: entry.review.requireRequestChangesReason !== false,
      fields: null,
    });
  }

  for (const entry of attention?.headsUp ?? []) {
    const id = `headsUp:${entry.case.id}`;
    const upstreamTitle = entry.drift.upstream?.title?.trim();
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.case.pipeline.id,
      pipelineName: entry.case.pipeline.name,
      title: entry.case.title,
      prompt: upstreamTitle
        ? i18n.t("area.pipelines-cases.pipelines.queue.promptUpstreamChanged", { upstream: upstreamTitle })
        : i18n.t("area.pipelines-cases.pipelines.queue.promptQuickLook", { title: entry.case.title }),
      kind: "headsUp",
      createdAt: entry.drift.createdAt ?? entry.case.updatedAt ?? null,
      expectedVersion: entry.case.version ?? null,
      suggestionId: null,
      requireRejectReason: false,
      requireRequestChangesReason: false,
      fields: null,
    });
  }

  for (const entry of reviewCases) {
    const id = `review:${entry.case.id}`;
    const pendingSuggestion = entry.pendingSuggestion ?? entry.case.pendingSuggestion ?? null;
    const existing = rows.get(id);
    if (existing) {
      existing.fields = entry.case.fields ?? null;
      if (existing.expectedVersion === null && typeof entry.case.version === "number") {
        existing.expectedVersion = entry.case.version;
      }
      continue;
    }
    rows.set(id, {
      id,
      caseId: entry.case.id,
      pipelineId: entry.pipeline.id,
      pipelineName: entry.pipeline.name,
      title: entry.case.title,
      prompt:
        pendingSuggestion?.rationale?.trim() ||
        entry.case.summary?.trim() ||
        i18n.t("area.pipelines-cases.pipelines.queue.promptDecide", { title: entry.case.title }),
      kind: "review",
      createdAt: entry.case.updatedAt ?? entry.case.createdAt ?? null,
      expectedVersion: typeof entry.case.version === "number" ? entry.case.version : null,
      suggestionId: null,
      requireRejectReason: entry.reviewConfig?.requireRejectReason !== false,
      requireRequestChangesReason: entry.reviewConfig?.requireRequestChangesReason !== false,
      fields: entry.case.fields ?? null,
    });
  }

  return [...rows.values()].sort((left, right) => {
    const leftTime = left.createdAt ? new Date(left.createdAt).getTime() : 0;
    const rightTime = right.createdAt ? new Date(right.createdAt).getTime() : 0;
    return rightTime - leftTime;
  });
}

function ReviewQueueStatusChip({ failed }: { failed: boolean }) {
  const { t } = useTranslation();
  if (!failed) return null;
  return (
    <Badge variant="outline" className="border-amber-200 bg-amber-50 font-semibold text-amber-800 dark:border-amber-900/70 dark:bg-amber-950/30 dark:text-amber-300">
      <AlertTriangle className="h-3 w-3" />
      {t("area.pipelines-cases.pipelines.board.needsAttention")}
    </Badge>
  );
}

function reviewQueueFieldEntries(fields: Record<string, unknown> | null | undefined) {
  const hidden = new Set(["review"]);
  return Object.entries(fields ?? {})
    .filter(([key, value]) => !hidden.has(key) && ["string", "number", "boolean"].includes(typeof value))
    .slice(0, 6);
}

function ReviewQueueDetailDialog({
  row,
  open,
  pending,
  onOpenChange,
  onApprove,
  onRequestChanges,
}: {
  row: ReviewQueueRow | null;
  open: boolean;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onApprove: (note: string) => void;
  onRequestChanges: (note: string) => void;
}) {
  const { t } = useTranslation();
  const [note, setNote] = useState("");

  useEffect(() => {
    if (!open) setNote("");
  }, [open]);

  const fields = reviewQueueFieldEntries(row?.fields);
  const trimmedNote = note.trim();
  const canDecide = row ? row.kind !== "headsUp" : false;
  const requestChangesRequiresNote = row?.kind === "review" ? row.requireRequestChangesReason : true;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row?.title ?? t("area.pipelines-cases.pipelines.queue.reviewItem")}</DialogTitle>
          <DialogDescription>
            {row ? t("area.pipelines-cases.pipelines.queue.waitingForYou", { pipeline: row.pipelineName }) : t("area.pipelines-cases.pipelines.queue.reviewAndDecide")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("area.pipelines-cases.pipelines.queue.whatDecided")}</p>
            <p className="text-sm text-foreground">{row?.prompt}</p>
          </section>

          <section className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">{t("area.pipelines-cases.pipelines.queue.itemPreview")}</p>
            {fields.length > 0 ? (
              <div className="divide-y divide-border rounded-md border border-border">
                {fields.map(([key, value]) => (
                  <div key={key} className="grid grid-cols-(--gtc-51) gap-3 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">{humanizeFieldLabel(key)}</span>
                    <span className="text-foreground">{String(value)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="rounded-md border border-border px-3 py-3 text-sm text-muted-foreground">
                {t("area.pipelines-cases.pipelines.queue.noPreview")}
              </p>
            )}
          </section>

          {row ? (
            <Link
              to={`/pipelines/${row.pipelineId}/items/${row.caseId}`}
              className="inline-block text-sm font-medium text-primary hover:underline"
              onClick={() => onOpenChange(false)}
            >
              {t("area.pipelines-cases.pipelines.queue.openFull")}
            </Link>
          ) : null}

          {canDecide ? (
            <label className="block space-y-1.5 text-sm font-medium">
              <span>{t("area.pipelines-cases.pipelines.queue.note")}</span>
              <Textarea
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder={requestChangesRequiresNote ? t("area.pipelines-cases.pipelines.queue.noteRequired") : t("area.pipelines-cases.pipelines.queue.noteOptional")}
              />
            </label>
          ) : null}
        </div>

        <DialogFooter className="gap-2 sm:gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common.cancel")}
          </Button>
          {canDecide ? (
            <>
              <Button
                type="button"
                variant="outline"
                onClick={() => onRequestChanges(trimmedNote)}
                disabled={pending || (requestChangesRequiresNote && !trimmedNote)}
              >
                {row?.kind === "suggestion" ? t("area.pipelines-cases.pipelines.review.notYet") : t("area.pipelines-cases.pipelines.review.requestChanges")}
              </Button>
              <Button type="button" onClick={() => onApprove(trimmedNote)} disabled={pending}>
                {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {t("area.pipelines-cases.pipelines.review.approve")}
              </Button>
            </>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReviewQueueSection({
  title,
  rows,
  activeRowId,
  failedRowIds,
  selectedRowIds,
  pendingRowIds,
  showSelection,
  onActivate,
  onToggleSelected,
  onApprove,
  onDecline,
  onRequestChanges,
  onOpenItem,
}: {
  title: string;
  rows: ReviewQueueRow[];
  activeRowId: string | null;
  failedRowIds: Set<string>;
  selectedRowIds: Set<string>;
  pendingRowIds: Set<string>;
  showSelection: boolean;
  onActivate: (rowId: string) => void;
  onToggleSelected: (rowId: string) => void;
  onApprove: (row: ReviewQueueRow) => void;
  onDecline: (row: ReviewQueueRow) => void;
  onRequestChanges: (row: ReviewQueueRow) => void;
  onOpenItem: (row: ReviewQueueRow) => void;
}) {
  const { t } = useTranslation();
  if (rows.length === 0) return null;

  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between border-b border-border pb-2">
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        <span className="text-xs text-muted-foreground">{itemCountLabel(rows.length)}</span>
      </div>
      <div className="divide-y divide-border">
        {rows.map((row) => {
          const pending = pendingRowIds.has(row.id);
          const failed = failedRowIds.has(row.id);
          const selected = selectedRowIds.has(row.id);
          const active = activeRowId === row.id;
          const selectable = row.kind !== "headsUp";

          return (
            <div
              key={row.id}
              role="link"
              tabIndex={0}
              aria-current={active ? "true" : undefined}
              className={cn(
                "grid min-h-10 grid-cols-(--gtc-13) items-center gap-3 px-2 py-2 text-sm outline-none transition-colors",
                active ? "bg-accent/60" : "hover:bg-accent/40",
              )}
              onMouseEnter={() => onActivate(row.id)}
              onFocus={() => onActivate(row.id)}
              onClick={() => onOpenItem(row)}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenItem(row);
                }
              }}
            >
              <div className="flex min-w-0 items-center gap-3">
                {showSelection ? (
                  <input
                    type="checkbox"
                    aria-label={t("area.pipelines-cases.pipelines.queue.selectRow", { title: row.title })}
                    checked={selected}
                    disabled={!selectable || pending}
                    onClick={(event) => event.stopPropagation()}
                    onChange={() => onToggleSelected(row.id)}
                    className="h-4 w-4 rounded border-border"
                  />
                ) : null}
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    <p className="truncate font-semibold text-foreground">{row.title}</p>
                    <Badge variant="outline" className="border-border text-(length:--text-micro) font-semibold text-muted-foreground">
                      {row.pipelineName}
                    </Badge>
                    <ReviewQueueStatusChip failed={failed} />
                  </div>
                  <p className="truncate text-muted-foreground">{row.prompt}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="hidden whitespace-nowrap text-xs text-muted-foreground sm:inline">
                  {row.createdAt ? relativeTime(row.createdAt) : t("area.pipelines-cases.pipelines.queue.recently")}
                </span>
                {row.kind === "suggestion" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }>
                      {t("area.pipelines-cases.pipelines.review.approve")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onDecline(row);
                    }}>
                      {t("area.pipelines-cases.pipelines.review.notYet")}
                    </Button>
                  </>
                ) : row.kind === "review" ? (
                  <>
                    <Button type="button" size="sm" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onApprove(row);
                    }>
                      {t("area.pipelines-cases.pipelines.review.approve")}
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={pending} onClick={(event) => {
                      event.stopPropagation();
                      onRequestChanges(row);
                    }}>
                      {t("area.pipelines-cases.pipelines.review.requestChanges")}
                    </Button>
                  </>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

export function ReviewQueue() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [selectedRowIds, setSelectedRowIds] = useState<Set<string>>(() => new Set());
  const [hiddenRowIds, setHiddenRowIds] = useState<Set<string>>(() => new Set());
  const [failedRowIds, setFailedRowIds] = useState<Set<string>>(() => new Set());
  const [pendingRowIds, setPendingRowIds] = useState<Set<string>>(() => new Set());
  const [activeRowId, setActiveRowId] = useState<string | null>(null);
  const [detailRow, setDetailRow] = useState<ReviewQueueRow | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("area.pipelines-cases.pipelines.queue.title") }]);
  }, [setBreadcrumbs, t]);

  const attentionQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.attention(selectedCompanyId) : ["pipelines", "attention", "none"],
    queryFn: () => pipelinesApi.listAttention(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const reviewCasesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.pipelines.reviewCases(selectedCompanyId) : ["pipelines", "review-cases", "none"],
    queryFn: () => pipelinesApi.listReviewCases(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const rows = useMemo(
    () =>
      buildReviewQueueRows({
        attention: attentionQuery.data,
        reviewCases: reviewCasesQuery.data ?? [],
      }),
    [attentionQuery.data, reviewCasesQuery.data],
  );

  const visibleRows = rows.filter((row) => !hiddenRowIds.has(row.id));
  const actionableRows = visibleRows.filter((row) => row.kind !== "headsUp");
  const selectedRows = visibleRows.filter((row) => selectedRowIds.has(row.id) && row.kind !== "headsUp");
  const groupedRows = REVIEW_QUEUE_SECTION_ORDER.map((kind) => ({
    kind,
    rows: visibleRows.filter((row) => row.kind === kind),
  }));
  const openItem = useCallback((row: ReviewQueueRow) => {
    navigate(`/pipelines/${row.pipelineId}/items/${row.caseId}`);
  }, [navigate]);

  useEffect(() => {
    if (visibleRows.length === 0) {
      setActiveRowId(null);
      return;
    }
    if (!activeRowId || !visibleRows.some((row) => row.id === activeRowId)) {
      setActiveRowId(visibleRows[0].id);
    }
  }, [activeRowId, visibleRows]);

  const invalidateReviewQueue = async () => {
    if (!selectedCompanyId) return;
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.attention(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.reviewCases(selectedCompanyId) }),
      queryClient.invalidateQueries({ queryKey: queryKeys.pipelines.list(selectedCompanyId) }),
    ]);
  };

  const decideRow = useMutation({
    mutationFn: async ({ row, decision, note }: { row: ReviewQueueRow; decision: "approve" | "decline" | "request_changes"; note?: string }) => {
      if (row.kind === "suggestion") {
        if (!row.suggestionId) throw new Error("This item is not ready for a decision.");
        await pipelinesApi.resolveSuggestion(row.caseId, {
          suggestionId: row.suggestionId,
          resolution: decision === "approve" ? "accept" : "dismiss",
          expectedVersion: row.expectedVersion ?? undefined,
          reason: note || null,
        });
        return;
      }
      if (row.expectedVersion === null) throw new Error("This item is not ready for a decision.");
      await pipelinesApi.reviewCase(row.caseId, {
        decision: decision === "request_changes" ? "request_changes" : "approve",
        reason: note || null,
        expectedVersion: row.expectedVersion,
      });
    },
    onMutate: ({ row }) => {
      setPendingRowIds((current) => new Set(current).add(row.id));
      setHiddenRowIds((current) => new Set(current).add(row.id));
      setFailedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setSelectedRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
    },
    onError: (_error, { row }) => {
      setHiddenRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      setFailedRowIds((current) => new Set(current).add(row.id));
    },
    onSettled: async (_data, _error, { row }) => {
      setPendingRowIds((current) => {
        const next = new Set(current);
        next.delete(row.id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  const bulkApprove = useMutation({
    mutationFn: async (targetRows: ReviewQueueRow[]) => {
      if (!selectedCompanyId) throw new Error("Select an organization first.");
      const reviewRows = targetRows.filter((row) => row.kind === "review");
      const suggestionRows = targetRows.filter((row) => row.kind === "suggestion" && row.suggestionId);
      const tasks: Promise<unknown>[] = [];
      if (reviewRows.length > 0) {
        const items = reviewRows.map((row) => {
          if (row.expectedVersion === null) throw new Error("This item is not ready for a decision.");
          return { caseId: row.caseId, decision: "approve" as const, expectedVersion: row.expectedVersion };
        });
        tasks.push(
          pipelinesApi.bulkReviewCases(selectedCompanyId, { items }).then((response) => {
            const failures = (response.results ?? []).filter((result) => !result.ok);
            if (failures.length > 0) {
              throw new Error("Some items could not be approved.");
            }
          }),
        );
      }
      tasks.push(
        ...suggestionRows.map((row) =>
          pipelinesApi.resolveSuggestion(row.caseId, {
            suggestionId: row.suggestionId!,
            resolution: "accept",
            expectedVersion: row.expectedVersion ?? undefined,
          }),
        ),
      );
      await Promise.all(tasks);
    },
    onMutate: (targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => new Set([...current, ...ids]));
      setHiddenRowIds((current) => new Set([...current, ...ids]));
      setSelectedRowIds(new Set());
      setFailedRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
    },
    onError: (_error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setHiddenRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      setFailedRowIds((current) => new Set([...current, ...ids]));
    },
    onSettled: async (_data, _error, targetRows) => {
      const ids = targetRows.map((row) => row.id);
      setPendingRowIds((current) => {
        const next = new Set(current);
        for (const id of ids) next.delete(id);
        return next;
      });
      await invalidateReviewQueue();
    },
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        hasBlockingShortcutDialog() ||
        isKeyboardShortcutTextInputTarget(event.target) ||
        visibleRows.length === 0
      ) {
        return;
      }

      const currentIndex = Math.max(0, visibleRows.findIndex((row) => row.id === activeRowId));
      const key = event.key.toLowerCase();
      if (event.key === "ArrowDown" || key === "j") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.min(visibleRows.length - 1, currentIndex + 1)].id);
        return;
      }
      if (event.key === "ArrowUp" || key === "k") {
        event.preventDefault();
        setActiveRowId(visibleRows[Math.max(0, currentIndex - 1)].id);
        return;
      }

      const activeRow = visibleRows[currentIndex];
      if (!activeRow) return;
      if (event.key === "Enter") {
        event.preventDefault();
        openItem(activeRow);
        return;
      }
      if (key === "a" && activeRow.kind !== "headsUp") {
        event.preventDefault();
        decideRow.mutate({ row: activeRow, decision: "approve" });
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [activeRowId, decideRow, openItem, visibleRows]);

  if (!selectedCompanyId) {
    return <EmptyState icon={Hexagon} message={t("area.pipelines-cases.pipelines.queue.selectOrg")} />;
  }

  if (attentionQuery.isLoading || reviewCasesQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  const selectedCount = selectedRows.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("area.pipelines-cases.pipelines.queue.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("area.pipelines-cases.pipelines.queue.needsYou", { n: formatNumber(visibleRows.length) })}
          </p>
        </div>
        <Button
          type="button"
          disabled={selectedCount === 0 || bulkApprove.isPending}
          onClick={() => bulkApprove.mutate(selectedRows)}
        >
          {bulkApprove.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          {t("area.pipelines-cases.pipelines.queue.approveSelected", { count: selectedCount, formatted: formatNumber(selectedCount) })}
        </Button>
      </div>

      {attentionQuery.error || reviewCasesQuery.error ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">{t("area.pipelines-cases.pipelines.queue.someNeedAttention")}</p>
      ) : null}

      {visibleRows.length === 0 ? (
        <EmptyState icon={Check} message={t("area.pipelines-cases.pipelines.queue.nothing")} />
      ) : (
        <div className="space-y-6">
          {groupedRows.map((group) => (
            <ReviewQueueSection
              key={group.kind}
              title={reviewQueueSectionLabels()[group.kind]}
              rows={group.rows}
              activeRowId={activeRowId}
              failedRowIds={failedRowIds}
              selectedRowIds={selectedRowIds}
              pendingRowIds={pendingRowIds}
              showSelection={actionableRows.length > 1}
              onActivate={setActiveRowId}
              onToggleSelected={(rowId) => {
                setSelectedRowIds((current) => {
                  const next = new Set(current);
                  if (next.has(rowId)) next.delete(rowId);
                  else next.add(rowId);
                  return next;
                });
              }}
              onApprove={(row) => decideRow.mutate({ row, decision: "approve" })}
              onDecline={(row) => decideRow.mutate({ row, decision: "decline" })}
              onRequestChanges={(row) => setDetailRow(row)}
              onOpenItem={openItem}
            />
          ))}
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        <Trans
          i18nKey="area.pipelines-cases.pipelines.queue.shortcuts"
          components={[
            <span key="0" className="font-semibold" />,
            <span key="1" className="font-semibold" />,
            <span key="2" className="font-semibold" />,
            <span key="3" className="font-semibold" />,
          ]}
        />
      </p>

      <ReviewQueueDetailDialog
        row={detailRow}
        open={Boolean(detailRow)}
        pending={decideRow.isPending}
        onOpenChange={(open) => {
          if (!open) setDetailRow(null);
        }}
        onApprove={(note) => {
          if (!detailRow) return;
          decideRow.mutate({ row: detailRow, decision: "approve", note });
          setDetailRow(null);
        }}
        onRequestChanges={(note) => {
          if (!detailRow) return;
          decideRow.mutate({
            row: detailRow,
            decision: detailRow.kind === "suggestion" ? "decline" : "request_changes",
            note,
          });
          setDetailRow(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Learnings
// ---------------------------------------------------------------------------

const LEARNINGS_PAGE_SIZE = 100;
const LEARNING_EVENT_TYPES = "review_decided,transition_forced";

export function Learnings() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    setBreadcrumbs([{ label: t("area.pipelines-cases.pipelines.learnings.title") }]);
  }, [setBreadcrumbs, t]);

  const learningsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.pipelines.learnings(selectedCompanyId, offset)
      : ["pipelines", "learnings", "none"],
    queryFn: () =>
      pipelinesApi.listCompanyCaseEvents(selectedCompanyId!, {
        types: LEARNING_EVENT_TYPES,
        limit: LEARNINGS_PAGE_SIZE,
        offset,
      }),
    enabled: !!selectedCompanyId,
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={BookOpenText} message={t("area.pipelines-cases.pipelines.learnings.selectOrg")} />;
  }

  if (learningsQuery.isLoading && !learningsQuery.data) {
    return <PageSkeleton variant="list" />;
  }

  const events = learningsQuery.data?.items ?? [];
  const pagination = learningsQuery.data?.pagination;
  const groups = groupLearningEventsByDay(events);
  const firstVisible = events.length === 0 ? 0 : offset + 1;
  const lastVisible = offset + events.length;
  const canGoPrevious = offset > 0;
  const canGoNext = Boolean(pagination?.hasMore);

  return (
    <div className="space-y-6">
      <div className="border-b border-border pb-5">
        <h1 className="text-2xl font-semibold tracking-normal text-foreground">{t("area.pipelines-cases.pipelines.learnings.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("area.pipelines-cases.pipelines.learnings.subtitle")}
        </p>
      </div>

      <div className="flex items-center justify-end">
        <p className="text-sm text-muted-foreground">
          {learningsQuery.isFetching
            ? t("area.pipelines-cases.pipelines.learnings.refreshing")
            : events.length > 0
              ? `${formatNumber(firstVisible)}-${formatNumber(lastVisible)}`
              : t("area.pipelines-cases.pipelines.learnings.noRows")}
        </p>
      </div>

      {learningsQuery.error ? (
        <p className="text-sm text-destructive">{t("area.pipelines-cases.pipelines.learnings.loadError")}</p>
      ) : groups.length === 0 ? (
        <EmptyState icon={BookOpenText} message={t("area.pipelines-cases.pipelines.learnings.empty")} />
      ) : (
        <div className="space-y-6">
          {groups.map((group) => (
            <section key={group.key} className="space-y-2">
              <h2 className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">
                {group.label}
              </h2>
              <div className="overflow-hidden rounded-md border border-border">
                {group.events.map((event) => {
                  const presentation = formatLearningEvent(event);
                  const forcedMove = presentation.kind === "forced_move";
                  return (
                    <div
                      key={event.id}
                      className={cn(
                        "grid min-h-11 grid-cols-(--gtc-15) items-center gap-3 border-b border-border/70 px-3 py-2 text-sm last:border-b-0",
                        forcedMove && "border-l-2 border-l-amber-400 bg-amber-50/50 dark:bg-amber-400/10",
                      )}
                    >
                      <span className="text-xs text-muted-foreground" title={new Date(event.createdAt).toLocaleString(i18n.language)}>
                        {relativeTime(event.createdAt)}
                      </span>
                      <div className="min-w-0">
                        <Link
                          to={`/pipelines/${event.pipeline.id}/items/${event.caseId}`}
                          className="font-medium text-foreground hover:underline"
                        >
                          {presentation.sentence}
                        </Link>
                        <span className="ml-2 text-muted-foreground">{event.pipeline.name}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button
          type="button"
          variant="outline"
          disabled={!canGoPrevious}
          onClick={() => setOffset((current) => Math.max(0, current - LEARNINGS_PAGE_SIZE))}
        >
          {t("area.pipelines-cases.pipelines.learnings.previous")}
        </Button>
        <span className="text-sm text-muted-foreground">
          {events.length > 0 ? `${formatNumber(firstVisible)}-${formatNumber(lastVisible)}` : t("area.pipelines-cases.pipelines.learnings.noRows")}
        </span>
        <Button
          type="button"
          variant="outline"
          disabled={!canGoNext}
          onClick={() => setOffset((current) => pagination?.nextOffset ?? current + LEARNINGS_PAGE_SIZE)}
        >
          {t("area.pipelines-cases.pipelines.learnings.next")}
        </Button>
      </div>
    </div>
  );
}
