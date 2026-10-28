// MaintenanceBanner — component in ui/src/components/myrmidon.
// Distinguishes board-wide maintenance (instance/company) from scoped
// maintenance (agent or department/project). Scoped maintenance shows a
// discrete, non-intrusive banner indicating that only that specific agent/project
// is updating while the rest of the board remains operational.

import { useQuery } from "@tanstack/react-query";
import { Wrench } from "lucide-react";
import { Link, useInRouterContext } from "react-router-dom";
import { useTranslation } from "@/i18n";
import { agentsApi, type AgentListItem } from "../../api/agents";
import { queryKeys } from "../../lib/queryKeys";
import { agentUrl } from "../../lib/utils";
import {
  maintenanceApi,
  maintenanceQueryKey,
  type MaintenanceScopeType,
  type MaintenanceStatus,
  type MaintenanceWindow,
} from "./maintenanceApi";

export interface AggregatedRow {
  key: string;
  scopeType: MaintenanceScopeType;
  state: "on" | "ending" | "draining";
  reason: string;
  since: string;
  windowCount: number;
  totalQueued: number;
  drainingRuns: number;
  timedOutRuns: number;
  agentIds?: string[];
}

export interface AggregatedSummary {
  totalWindows: number;
  state: "on" | "ending" | "draining";
  uniqueKinds: number;
  activeAgents: number;
  activeCompanies: number;
  drainingRuns: number;
  timedOutRuns: number;
}

function emptySummary(): AggregatedSummary {
  return {
    totalWindows: 0,
    state: "on",
    uniqueKinds: 0,
    activeAgents: 0,
    activeCompanies: 0,
    drainingRuns: 0,
    timedOutRuns: 0,
  };
}

export function isWindowForCompany(w: MaintenanceWindow, companyId: string | null): boolean {
  if (w.scope.type === "instance") return true;
  if (!companyId) return true;
  return !w.companyId || w.companyId === companyId;
}

export function aggregateMaintenance(
  status: MaintenanceStatus | null | undefined,
  companyId: string | null,
): { active: boolean; summary: AggregatedSummary; rows: AggregatedRow[]; windows: MaintenanceWindow[] } {
  if (!status || !status.active) {
    return { active: false, summary: emptySummary(), rows: [], windows: [] };
  }
  const windows = (status.windows ?? []).filter((w) => isWindowForCompany(w, companyId));
  if (windows.length === 0) {
    return { active: false, summary: emptySummary(), rows: [], windows: [] };
  }

  const agentWindows = windows.filter((w) => w.scope.type === "agent");
  const groupedAgentRows = new Map<string, AggregatedRow>();
  for (const w of agentWindows) {
    const key = `agent:${w.state}:${w.reason}`;
    const existing = groupedAgentRows.get(key);
    const agentId = w.scope.id ?? w.id;
    if (existing) {
      existing.windowCount += 1;
      existing.totalQueued += w.queuedWakes ?? 0;
      existing.drainingRuns += w.drain?.runningRuns ?? 0;
      existing.timedOutRuns += w.drain?.timedOutRuns ?? 0;
      if (agentId && !existing.agentIds?.includes(agentId)) {
        existing.agentIds?.push(agentId);
      }
    } else {
      groupedAgentRows.set(key, {
        key,
        scopeType: "agent",
        state: w.state,
        reason: w.reason,
        since: w.enteredAt,
        windowCount: 1,
        totalQueued: w.queuedWakes ?? 0,
        drainingRuns: w.drain?.runningRuns ?? 0,
        timedOutRuns: w.drain?.timedOutRuns ?? 0,
        agentIds: agentId ? [agentId] : [],
      });
    }
  }

  const rows: AggregatedRow[] = [];
  for (const w of windows) {
    if (w.scope.type === "agent") continue;
    rows.push({
      key: `${w.scope.type}:${w.id}`,
      scopeType: w.scope.type,
      state: w.state,
      reason: w.reason,
      since: w.enteredAt,
      windowCount: 1,
      totalQueued: w.queuedWakes ?? 0,
      drainingRuns: w.drain?.runningRuns ?? 0,
      timedOutRuns: w.drain?.timedOutRuns ?? 0,
    });
  }
  rows.push(...groupedAgentRows.values());

  const summary = emptySummary();
  summary.totalWindows = windows.length;
  summary.uniqueKinds = rows.length;
  for (const w of windows) {
    if (w.scope.type === "agent") summary.activeAgents += 1;
    if (w.companyId) summary.activeCompanies += 1;
    summary.drainingRuns += w.drain?.runningRuns ?? 0;
    summary.timedOutRuns += w.drain?.timedOutRuns ?? 0;
    if (w.state === "draining") summary.state = "draining";
    else if (w.state === "ending" && summary.state !== "draining") summary.state = "ending";
  }

  return { active: true, summary, rows, windows };
}

function summaryText(summary: AggregatedSummary, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const stateLabel =
    summary.state === "draining"
      ? t(summary.timedOutRuns > 0 ? "maintenanceBanner.state.drainingTimedOut" : "maintenanceBanner.state.draining", {
          count: summary.drainingRuns,
        })
      : t(`maintenanceBanner.state.${summary.state}`);
  return t("maintenanceBanner.summary", {
    count: summary.totalWindows,
    rows: summary.uniqueKinds,
    state: stateLabel,
  });
}

function rowText(row: AggregatedRow, t: (key: string, opts?: Record<string, unknown>) => string): string {
  const since = new Date(row.since).toLocaleTimeString();
  const stateLabel =
    row.state === "draining"
      ? t(row.timedOutRuns > 0 ? "maintenanceBanner.state.drainingTimedOut" : "maintenanceBanner.state.draining", {
          count: row.drainingRuns,
        })
      : t(`maintenanceBanner.state.${row.state}`);

  if (row.scopeType === "agent") {
    return t("maintenanceBanner.group", {
      state: stateLabel,
      since,
      reason: row.reason,
      count: row.windowCount,
      queued: row.totalQueued,
    });
  }

  const scopeLabel = t(`maintenanceBanner.scope.${row.scopeType}`);
  return t("maintenanceBanner.row", {
    scope: scopeLabel,
    state: stateLabel,
    since,
    reason: row.reason,
    count: row.windowCount,
    queued: row.totalQueued,
  });
}

function resolveAgent(
  agentRef: string,
  agents?: AgentListItem[] | null,
): { name: string; href: string } {
  const matched = agents?.find(
    (a) => a.id === agentRef || a.name === agentRef || a.urlKey === agentRef,
  );
  if (matched) {
    return {
      name: matched.name,
      href: agentUrl(matched),
    };
  }
  return {
    name: agentRef,
    href: `/agents/${agentRef}`,
  };
}

function AgentLink({ href, children }: { href: string; children: React.ReactNode }) {
  const inRouter = useInRouterContext();
  if (inRouter) {
    return (
      <Link to={href} className="font-medium text-foreground underline hover:opacity-80">
        {children}
      </Link>
    );
  }
  return (
    <a href={href} className="font-medium text-foreground underline hover:opacity-80">
      {children}
    </a>
  );
}

export function MaintenanceBannerView({
  status,
  companyId,
  agents,
}: {
  status: MaintenanceStatus | null | undefined;
  companyId: string | null;
  agents?: AgentListItem[] | null;
}) {
  const { t } = useTranslation();
  const { active, summary, rows, windows } = aggregateMaintenance(status, companyId);
  if (!active || windows.length === 0) {
    return null;
  }

  const isBoardWide = windows.some(
    (w) => w.scope.type === "instance" || w.scope.type === "company",
  );

  if (!isBoardWide) {
    // Scoped maintenance (agent or department/project) -> discrete row
    const agentWindows = windows.filter((w) => w.scope.type === "agent");
    const deptWindows = windows.filter((w) => w.scope.type === "department");

    let scopedContent: React.ReactNode;

    if (agentWindows.length === 1 && deptWindows.length === 0) {
      const w = agentWindows[0];
      const agentRef = w.scope.id ?? w.id;
      const { name: agentName, href: agentHref } = resolveAgent(agentRef, agents);
      const isContainer = /container/i.test(w.reason);
      const prefixKey = isContainer
        ? "maintenanceBanner.scopedBotContainerPrefix"
        : "maintenanceBanner.scopedBotGeneralPrefix";

      scopedContent = (
        <span>
          {t(prefixKey)}
          <AgentLink href={agentHref}>{agentName}</AgentLink>
          {t("maintenanceBanner.scopedRestOfBoardWorking")}
        </span>
      );
    } else if (agentWindows.length > 1 && deptWindows.length === 0) {
      const allContainer = agentWindows.every((w) => /container/i.test(w.reason));
      const pluralKey = allContainer
        ? "maintenanceBanner.scopedBotContainersPlural"
        : "maintenanceBanner.scopedBotsGeneralPlural";
      scopedContent = <span>{t(pluralKey, { count: agentWindows.length })}</span>;
    } else {
      scopedContent = <span>{t("maintenanceBanner.scopedDepartment")}</span>;
    }

    return (
      <div
        role="status"
        data-testid="myrmidon-maintenance-scoped-banner"
        className="border-b border-border/40 bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
      >
        <p data-testid="myrmidon-maintenance-scoped-text">{scopedContent}</p>
      </div>
    );
  }

  // Board-wide maintenance (instance or company) -> full banner
  return (
    <div
      role="status"
      data-testid="myrmidon-maintenance-banner"
      className="border-b border-red-300/70 bg-red-50 text-red-950 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-100"
    >
      <div className="px-3 py-2 text-sm">
        <details data-testid="myrmidon-maintenance-details">
          <summary
            data-testid="myrmidon-maintenance-summary"
            className="flex cursor-pointer select-none items-center gap-2 font-medium"
          >
            <Wrench className="h-4 w-4 shrink-0 text-red-600 dark:text-red-400" />
            <span className="font-semibold uppercase tracking-wide">
              {t("maintenanceBanner.title")}
            </span>
            <span>—</span>
            <span>{summaryText(summary, t)}</span>
          </summary>
          <ul className="mt-2 space-y-1 pl-6 text-xs text-red-900/90 dark:text-red-200/90">
            {rows.map((row) => (
              <li key={row.key} data-testid="myrmidon-maintenance-row">
                {rowText(row, t)}
              </li>
            ))}
          </ul>
        </details>
      </div>
    </div>
  );
}

export function MaintenanceBanner({ companyId }: { companyId: string | null }) {
  const { data } = useQuery({
    queryKey: maintenanceQueryKey,
    queryFn: () => maintenanceApi.get(),
    refetchInterval: 30_000,
    retry: false,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId ?? ""),
    queryFn: () => agentsApi.list(companyId!),
    enabled: Boolean(companyId),
  });

  return <MaintenanceBannerView status={data} companyId={companyId} agents={agents} />;
}
