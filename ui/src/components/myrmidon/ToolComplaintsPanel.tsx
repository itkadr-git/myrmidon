// ui/src/components/myrmidon/ToolComplaintsPanel.tsx
//
// myrmidon(1.7 TOOL-COMPLAINTS-UI, OPE-12229): the complaints triage panel on
// the company settings page. The operator sees the agents' tool complaints
// with their lifecycle statuses and the per-tool threshold warnings, moves a
// complaint to acknowledged/resolved, and — the one triage action — disables
// a tool for the complaining agent.
//
// The disable deliberately travels the agent's EXISTING permissions endpoint
// (PATCH /api/agents/:id/permissions, the same call the agent card makes):
// the payload keeps the agent's other rights untouched and lists its tools
// without the complained-about one, so the gateway's S6 agent-permission
// check refuses that tool afterwards. There is no bypass route and no
// auto-disable: the button is the operator's decision.
//
// Read model: GET /api/myrmidon/tool-complaints (the #2618 feed, now with
// thresholdWarnings) + PATCH /api/myrmidon/tool-complaints/:id for the
// lifecycle. The agent row itself is not fetched: the permission update
// echoes the flags the endpoint requires, and the operator's disable cannot
// silently rewrite rights it did not read.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, MessageSquareWarning } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { i18n, useTranslation } from "@/i18n";
import { agentsApi } from "@/api/agents";
import { readAgentToolPermissions } from "@myrmidon/shared";
import {
  toolsApi,
  type ToolComplaint,
  type ToolComplaintStatus,
  type ToolComplaintThresholdWarning,
} from "@/api/tools";

// myrmidon(OPE-8950): visible strings live in area.settings-company.tool-complaints-panel.*
type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The threshold warning card the feed travels with (one per tool). */
type ThresholdWarning = ToolComplaintThresholdWarning;

/** The complaint statuses the status filter offers, in display order. */
export const COMPLAINT_STATUS_FILTERS = ["all", "open", "acknowledged", "resolved"] as const;
export type ComplaintStatusFilter = (typeof COMPLAINT_STATUS_FILTERS)[number];

export interface ToolComplaintsPanelViewProps {
  complaints: ToolComplaint[];
  thresholdWarnings: ThresholdWarning[];
  loading: boolean;
  error: string | null;
  pendingId: string | null;
  disablingId: string | null;
  filter: ComplaintStatusFilter;
  onFilterChange: (filter: ComplaintStatusFilter) => void;
  onStatusChange: (complaint: ToolComplaint, status: ToolComplaintStatus) => void;
  onDisableTool: (complaint: ToolComplaint) => void;
}

/** i18n key of a lifecycle status. */
export function complaintStatusLabel(t: Translate, status: ToolComplaintStatus): string {
  return t(`area.settings-company.tool-complaints-panel.status.${status}`);
}

export function ToolComplaintsPanelView({
  complaints,
  thresholdWarnings,
  loading,
  error,
  pendingId,
  disablingId,
  filter,
  onFilterChange,
  onStatusChange,
  onDisableTool,
}: ToolComplaintsPanelViewProps) {
  const { t } = useTranslation();
  const warningsByTool = new Map(thresholdWarnings.map((warning) => [warning.tool, warning]));
  const visible =
    filter === "all" ? complaints : complaints.filter((complaint) => complaint.status === filter);
  return (
    <section
      className="rounded-lg border border-border bg-background"
      data-testid="myrmidon-tool-complaints-panel"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 pt-5 pb-2">
        <div className="flex items-center gap-2">
          <MessageSquareWarning className="h-4 w-4 text-muted-foreground" />
          <span className="text-base font-medium">
            {t("area.settings-company.tool-complaints-panel.title")}
          </span>
        </div>
        <div className="flex gap-1" data-testid="myrmidon-tool-complaints-filter">
          {COMPLAINT_STATUS_FILTERS.map((value) => (
            <button
              key={value}
              type="button"
              disabled={filter === value}
              onClick={() => onFilterChange(value)}
              className={
                filter === value
                  ? "rounded-md border border-border px-2 py-1 text-xs font-medium"
                  : "rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
              }
            >
              {t(`area.settings-company.tool-complaints-panel.filter.${value}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="px-5 pb-5 pt-1 space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground" data-testid="myrmidon-tool-complaints-loading">
            {t("area.settings-company.tool-complaints-panel.loading")}
          </p>
        ) : error ? (
          <p className="text-sm text-destructive" data-testid="myrmidon-tool-complaints-error">
            {error}
          </p>
        ) : (
          <>
            {thresholdWarnings.filter((warning) => warning.warning).length > 0 ? (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                data-testid="myrmidon-tool-complaints-warnings"
              >
                {thresholdWarnings
                  .filter((warning) => warning.warning)
                  .map((warning) => (
                    <div
                      key={warning.tool}
                      className="flex items-center gap-2"
                      data-testid={`myrmidon-tool-complaints-warning-${warning.tool}`}
                    >
                      <AlertTriangle className="h-4 w-4 text-amber-500" />
                      <span>
                        {t("area.settings-company.tool-complaints-panel.thresholdWarning", {
                          tool: warning.tool,
                          count: warning.openCount,
                          threshold: warning.threshold,
                        })}
                      </span>
                    </div>
                  ))}
              </div>
            ) : null}
            {visible.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="myrmidon-tool-complaints-empty">
                {t("area.settings-company.tool-complaints-panel.empty")}
              </p>
            ) : (
              <ul className="space-y-2" data-testid="myrmidon-tool-complaints-list">
                {visible.map((complaint) => {
                  const warning = warningsByTool.get(complaint.tool);
                  return (
                    <li
                      key={complaint.id}
                      className="rounded-md border border-border px-3 py-2 space-y-2"
                      data-testid={`myrmidon-tool-complaint-${complaint.id}`}
                    >
                      <div className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="font-medium">{complaint.tool}</span>
                        <span className="text-xs text-muted-foreground">
                          {complaintStatusBadge(complaint.status, t)}
                        </span>
                        {warning?.warning ? (
                          <AlertTriangle
                            className="h-4 w-4 text-amber-500"
                            aria-label={t("area.settings-company.tool-complaints-panel.thresholdWarning", {
                              tool: complaint.tool,
                              count: warning.openCount,
                              threshold: warning.threshold,
                            })}
                          />
                        ) : null}
                        <span className="text-xs text-muted-foreground">
                          {t("area.settings-company.tool-complaints-panel.agentLabel", {
                            agent: complaint.agentId,
                          })}
                        </span>
                      </div>
                      <p className="text-sm text-foreground/90">{complaint.issue}</p>
                      <div className="flex flex-wrap gap-2">
                        {complaint.status !== "acknowledged" && complaint.status !== "resolved" ? (
                          <button
                            type="button"
                            disabled={pendingId === complaint.id || disablingId === complaint.id}
                            onClick={() => onStatusChange(complaint, "acknowledged")}
                            className="rounded-md border border-border px-2 py-1 text-xs"
                            data-testid={`myrmidon-tool-complaint-acknowledge-${complaint.id}`}
                          >
                            {t("area.settings-company.tool-complaints-panel.acknowledge")}
                          </button>
                        ) : null}
                        {complaint.status !== "resolved" ? (
                          <button
                            type="button"
                            disabled={pendingId === complaint.id || disablingId === complaint.id}
                            onClick={() => onStatusChange(complaint, "resolved")}
                            className="rounded-md border border-border px-2 py-1 text-xs"
                            data-testid={`myrmidon-tool-complaint-resolve-${complaint.id}`}
                          >
                            {t("area.settings-company.tool-complaints-panel.resolve")}
                          </button>
                        ) : null}
                        <button
                          type="button"
                          disabled={pendingId === complaint.id || disablingId === complaint.id}
                          onClick={() => onDisableTool(complaint)}
                          className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive"
                          data-testid={`myrmidon-tool-complaint-disable-${complaint.id}`}
                        >
                          {t("area.settings-company.tool-complaints-panel.disableTool")}
                        </button>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function complaintStatusBadge(status: ToolComplaintStatus, t: Translate): string {
  return t(`area.settings-company.tool-complaints-panel.status.${status}`);
}

/**
 * The permissions update for "disable tool for agent" (OPE-12229): the
 * agent's EXISTING toolAccess, mode "listed", with the tool removed. The
 * three boolean flags the permissions endpoint requires travel as stored —
 * reading them off the agent's permissions the same way the agent card does.
 * No side path, no other rights touched.
 */
export function toolComplaintDisableUpdate(
  storedPermissions: unknown,
  storedAccess: { canAssignTasks?: boolean } | undefined,
  tool: string,
): {
  canCreateAgents: boolean;
  canCreateSkills: boolean;
  canAssignTasks: boolean;
  toolAccess: { mode: "listed"; tools: string[]; connections: string[] };
} {
  const permissions = (storedPermissions ?? {}) as Record<string, unknown>;
  const toolAccess = readAgentToolPermissions(permissions);
  return {
    canCreateAgents: permissions.canCreateAgents === true,
    canCreateSkills: permissions.canCreateSkills !== false,
    // canAssignTasks lives in the access summary of the detail read (it can
    // come from the CEO role or a grant, not only the permissions object).
    canAssignTasks: storedAccess?.canAssignTasks === true,
    toolAccess: {
      mode: "listed",
      tools: toolAccess.tools.filter((name) => name !== tool),
      connections: toolAccess.connections,
    },
  };
}

export function ToolComplaintsPanel() {
  const { t } = useTranslation() as { t: Translate };
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [filter, setFilter] = useState<ComplaintStatusFilter>("all");
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [disablingId, setDisablingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const feedQuery = useQuery({
    queryKey: ["myrmidon", "tool-complaints", companyId],
    queryFn: () => toolsApi.listComplaints(companyId),
    enabled: companyId.length > 0,
    refetchInterval: 60_000,
    retry: false,
  });

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ["myrmidon", "tool-complaints", companyId] });

  const statusMutation = useMutation({
    mutationFn: ({ complaint, status }: { complaint: ToolComplaint; status: ToolComplaintStatus }) =>
      toolsApi.updateComplaint(companyId, complaint.id, status),
    onMutate: ({ complaint }) => {
      setActionError(null);
      setPendingId(complaint.id);
    },
    onSuccess: () => {
      setPendingId(null);
      void refresh();
    },
    onError: (err) => {
      setPendingId(null);
      setActionError(
        err instanceof Error
          ? err.message
          : i18n.t("area.settings-company.tool-complaints-panel.requestFailed"),
      );
    },
  });

  const disableMutation = useMutation({
    mutationFn: async ({ complaint }: { complaint: ToolComplaint }) => {
      const detail = await agentsApi.get(complaint.agentId, companyId);
      return agentsApi.updatePermissions(
        complaint.agentId,
        toolComplaintDisableUpdate(detail.permissions, detail.access, complaint.tool),
        companyId,
      );
    },
    onMutate: ({ complaint }) => {
      setActionError(null);
      setDisablingId(complaint.id);
    },
    onSuccess: () => {
      setDisablingId(null);
      void refresh();
    },
    onError: (err) => {
      setDisablingId(null);
      setActionError(
        err instanceof Error
          ? err.message
          : i18n.t("area.settings-company.tool-complaints-panel.requestFailed"),
      );
    },
  });

  return (
    <>
      {actionError ? (
        <p className="text-sm text-destructive" data-testid="myrmidon-tool-complaints-action-error">
          {actionError}
        </p>
      ) : null}
      <ToolComplaintsPanelView
        complaints={feedQuery.data?.complaints ?? []}
        thresholdWarnings={feedQuery.data?.thresholdWarnings ?? []}
        loading={feedQuery.isLoading}
        error={feedQuery.error instanceof Error ? feedQuery.error.message : null}
        pendingId={pendingId}
        disablingId={disablingId}
        filter={filter}
        onFilterChange={setFilter}
        onStatusChange={(complaint, status) => statusMutation.mutate({ complaint, status })}
        onDisableTool={(complaint) => disableMutation.mutate({ complaint })}
      />
    </>
  );
}
