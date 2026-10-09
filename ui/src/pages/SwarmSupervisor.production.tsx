// myrmidon(1.6-SWARM-CLAIM-B): the production entry of the "Swarm supervisor"
// page — the same component as the dev tree's SwarmSupervisor.tsx; kept as a
// separate file so the prebuilt-assets pipeline picks it up exactly like
// Quality.production. Server side (part A): GET/POST under
// /api/myrmidon/companies/:id/swarm-claim/supervisor.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  Clock,
  ListChecks,
  RotateCw,
  ShieldCheck,
  TriangleAlert,
  Users,
} from "lucide-react";
import { EmptyState } from "@/components/EmptyState";
import { PageSkeleton } from "@/components/PageSkeleton";
import { PriorityIcon } from "@/components/PriorityIcon";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
// myrmidon(UI-RU): page strings through the fork i18n catalog.
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { formatDateTime, formatNumber } from "@/lib/utils";
import {
  swarmSupervisorApi,
  swarmSupervisorOverviewKey,
  type SwarmSupervisorClaim,
  type SwarmSupervisorCooldown,
  type SwarmSupervisorIdleAgent,
  type SwarmSupervisorMatch,
  type SwarmSupervisorOverview,
  type SwarmSupervisorQueueItem,
  type SwarmSupervisorRole,
  type SwarmSupervisorWarning,
} from "@/api/swarmSupervisor";

const NO_COMPANY = "__none__";

/**
 * myrmidon(1.6.1 SWARM-SETTINGS-UI): the human label of a setting source —
 * where the effective value came from (the settings UI, the environment
 * override, or the built-in default). The supervisor meta strip shows it
 * next to each value so the operator can tell at a glance which side is
 * in charge.
 */
function swarmSourceLabel(source: string | undefined): string {
  switch (source) {
    case "settings":
      return "from settings UI";
    case "env":
      return "from environment override";
    case "default":
      return "default";
    default:
      return "unknown";
  }
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): Roles tab vs the activity tab —
 * recent matches and tasks cooling down.
 */
type SwarmSection = "roles" | "activity";

/** Remaining lease time as a compact countdown; a non-positive value is expired. */
export function formatCountdown(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "expired";
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  if (hours > 0) return `${hours} h ${minutes} m`;
  if (minutes > 0) return `${minutes} m ${secs} s`;
  return `${secs} s`;
}

/** A lease holder's identity, tolerating a missing identifier/name. */
export function claimHolderLabel(claim: SwarmSupervisorClaim): string {
  return claim.agentName || claim.agentId;
}

/** A queue row's task handle: identifier when present, else the raw id. */
export function queueItemLabel(item: SwarmSupervisorQueueItem): string {
  return item.identifier ?? item.issueId;
}



/** Totals strip: one compact cell per overview total. */
function TotalsStrip({ overview }: { overview: SwarmSupervisorOverview }) {
  const { t } = useTranslation();
  const cells: Array<{ label: string; value: number }> = [
    { label: t("swarm.totals.queuedTasks"), value: overview.totals.queued },
    { label: t("swarm.totals.activeLeases"), value: overview.totals.activeClaims },
    { label: t("swarm.totals.expiredLeases"), value: overview.totals.expiredClaims },
    { label: t("swarm.totals.agentsWithLeases"), value: overview.totals.agentsWithClaims },
    { label: t("swarm.totals.idleAgentsWithQueue"), value: overview.totals.idleAgentsWithQueue },
    // myrmidon(1.6.5 SWARM-T4, design §5.3): the free-agents cell of the
    // status line (idle, below the ceiling, waiting for the queue).
    { label: t("swarm.totals.freeAgentsWithQueue"), value: overview.totals.freeAgentsWithQueue },
  ];
  return (
    // The status line of design §5.3: one row of live numbers the owner
    // glances at ("включает рой одним переключателем, видит живые цифры").
    <Card data-testid="swarm-totals">
      <CardContent
        className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 py-4 sm:grid-cols-3 lg:grid-cols-6"
        data-testid="swarm-status-line"
      >
        {cells.map((cell) => (
          <div key={cell.label}>
            <p className="text-2xl font-semibold tracking-tight tabular-nums">{formatNumber(cell.value)}</p>
            <p className="mt-1 text-xs font-medium text-muted-foreground">{cell.label}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

interface TableShellProps {
  title: string;
  description: string;
  emptyMessage: string;
  rowCount: number;
  testId: string;
  children: React.ReactNode;
}

function TableShell({ title, description, emptyMessage, rowCount, testId, children }: TableShellProps) {
  return (
    <div className="space-y-2" data-testid={testId}>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {rowCount === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyMessage}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">{children}</table>
        </div>
      )}
    </div>
  );
}

const HEAD_CELL = "px-3 py-2 text-left font-medium text-muted-foreground";

function QueueTable({ role }: { role: SwarmSupervisorRole }) {
  const { t } = useTranslation();
  return (
    <TableShell
      title={t("swarm.queueTitle")}
      description={t("swarm.queueDescription")}
      emptyMessage={t("swarm.queueEmpty")}
      rowCount={role.queue.length}
      testId={`swarm-queue-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.eff")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.nest")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.project")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.queuedAt")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.blockedSince")}</th>
        </tr>
      </thead>
      <tbody>
        {role.queue.map((item) => (
          <tr key={item.issueId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">
              <span className="font-mono text-muted-foreground">{queueItemLabel(item)}</span>{" "}
              <span>{item.title}</span>
            </td>
            <td className="px-3 py-2">
              <PriorityIcon priority={item.priority} showLabel />
            </td>
            <td className="px-3 py-2 tabular-nums" data-testid={`swarm-queue-eff-${item.issueId}`}>
              {formatNumber(item.eff)}
            </td>
            <td
              className="px-3 py-2 font-mono text-muted-foreground"
              data-testid={`swarm-queue-nest-${item.issueId}`}
            >
              {item.nestAgentId ?? "—"}
            </td>
            <td className="px-3 py-2 font-mono text-muted-foreground">{item.projectId ?? "—"}</td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(item.createdAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {item.blockedTransitionAt ? formatDateTime(item.blockedTransitionAt) : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

interface ClaimsTableProps {
  role: SwarmSupervisorRole;
  onRelease: (claimId: string) => void;
  releasingClaimId: string | null;
}

function ClaimsTable({ role, onRelease, releasingClaimId }: ClaimsTableProps) {
  const { t } = useTranslation();
  return (
    <TableShell
      title={t("swarm.claimsTitle")}
      description={t("swarm.claimsDescription")}
      emptyMessage={t("swarm.claimsEmpty")}
      rowCount={role.claims.length}
      testId={`swarm-claims-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.holder")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.claimedAt")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.heartbeat")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.expires")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.remaining")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.action")}</th>
        </tr>
      </thead>
      <tbody>
        {role.claims.map((claim) => (
          <tr key={claim.claimId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">
              <span className="font-mono text-muted-foreground">{claim.identifier ?? claim.issueId}</span>{" "}
              <span>{claim.title}</span>
            </td>
            <td className="px-3 py-2">
              <PriorityIcon priority={claim.priority} showLabel />
            </td>
            <td className="px-3 py-2">
              <span className="font-mono" data-testid={`swarm-claim-holder-${claim.claimId}`}>
                {claimHolderLabel(claim)}
              </span>
            </td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(claim.claimedAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {claim.heartbeatAt ? formatDateTime(claim.heartbeatAt) : "—"}
            </td>
            <td className="px-3 py-2 tabular-nums">{formatDateTime(claim.expiresAt)}</td>
            <td className="px-3 py-2 tabular-nums">
              {claim.expired ? (
                <span className="text-destructive" data-testid={`swarm-claim-expired-${claim.claimId}`}>
                  {t("swarm.expired")}
                </span>
              ) : (
                <span data-testid={`swarm-claim-countdown-${claim.claimId}`}>
                  {formatCountdown(claim.secondsToExpiry)}
                </span>
              )}
            </td>
            <td className="px-3 py-2">
              <Button
                variant="outline"
                size="xs"
                data-testid={`swarm-release-${claim.claimId}`}
                disabled={releasingClaimId === claim.claimId}
                onClick={() => onRelease(claim.claimId)}
              >
                {t("swarm.releaseLease")}
              </Button>
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

interface IdleAgentsTableProps {
  role: SwarmSupervisorRole;
  maxActiveTasksPerAgent: number | null;
}

function IdleAgentsTable({ role, maxActiveTasksPerAgent }: IdleAgentsTableProps) {
  const { t } = useTranslation();
  const cap = maxActiveTasksPerAgent;
  return (
    <TableShell
      title={t("swarm.idleTitle")}
      description={t("swarm.idleDescription")}
      emptyMessage={t("swarm.idleEmpty")}
      rowCount={role.idleAgents.length}
      testId={`swarm-idle-table-${role.role}`}
    >
      <thead>
        <tr className="border-b border-border bg-accent/20">
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.agent")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.agentId")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.activeLeases")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.loadVsCap")}</th>
          <th scope="col" className={HEAD_CELL}>{t("swarm.columns.limit")}</th>
        </tr>
      </thead>
      <tbody>
        {role.idleAgents.map((agent: SwarmSupervisorIdleAgent) => (
          <tr key={agent.agentId} className="border-b border-border last:border-b-0">
            <td className="px-3 py-2">{agent.name}</td>
            <td className="px-3 py-2 font-mono text-muted-foreground">{agent.agentId}</td>
            <td className="px-3 py-2 tabular-nums">{formatNumber(agent.activeClaims)}</td>
            <td className="px-3 py-2 tabular-nums">
              {cap === null ? "—" : `${agent.activeClaims} / ${cap}`}
            </td>
            <td className="px-3 py-2">
              {agent.atLimit ? <span className="text-destructive">{t("swarm.atLimit")}</span> : <span className="text-muted-foreground">—</span>}
            </td>
          </tr>
        ))}
      </tbody>
    </TableShell>
  );
}

function RoleSection({
  role,
  maxActiveTasksPerAgent,
  onRelease,
  releasingClaimId,
}: {
  role: SwarmSupervisorRole;
  maxActiveTasksPerAgent: number | null;
  onRelease: (claimId: string) => void;
  releasingClaimId: string | null;
}) {
  const { t } = useTranslation();
  return (
    <Card data-testid={`swarm-role-${role.role}`}>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{role.role}</CardTitle>
        <CardDescription>
          {t("swarm.roleSummary", {
            queued: formatNumber(role.queue.length),
            leases: formatNumber(role.claims.length),
            idle: formatNumber(role.idleAgents.length),
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 px-5 pb-5 pt-2">
        <QueueTable role={role} />
        <ClaimsTable role={role} onRelease={onRelease} releasingClaimId={releasingClaimId} />
        <IdleAgentsTable role={role} maxActiveTasksPerAgent={maxActiveTasksPerAgent} />
      </CardContent>
    </Card>
  );
}

interface ActivitySectionProps {
  overview: SwarmSupervisorOverview;
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): the activity tab — recent board→agent
 * matches, tasks cooling down and the warning list. All data comes from the
 * single overview query, so this section adds no query of its own.
 */
function ActivitySection({ overview }: ActivitySectionProps) {
  return (
    <div className="space-y-4">
      <WarningList warnings={overview.warnings} />
      <MatchesTable matched={overview.matched} />
      <CooldownTable cooldown={overview.cooldown} />
    </div>
  );
}

/**
 * myrmidon(1.6.5 SWARM-T4, design §5.3): the warning strip — one line per
 * warning the overview raised (a caste with tasks and no free agent, tasks
 * without a caste, runs without a task in the last 24h).
 */
function WarningList({ warnings }: { warnings: SwarmSupervisorWarning[] }) {
  const { t } = useTranslation();
  if (warnings.length === 0) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="swarm-warnings-empty">
        {t("swarm.warnings.empty")}
      </p>
    );
  }
  return (
    <ul className="space-y-1" data-testid="swarm-warnings">
      {warnings.map((warning, index) => (
        <li
          key={`${warning.kind}-${index}`}
          className="flex items-center gap-1.5 text-sm text-foreground"
        >
          <TriangleAlert className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span data-testid={`swarm-warning-${warning.kind}`}>{warning.message}</span>
        </li>
      ))}
    </ul>
  );
}

/** myrmidon(1.6.5 SWARM-T4, design §5.3): recent matches table. */
function MatchesTable({ matched }: { matched: SwarmSupervisorMatch[] }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="swarm-matched">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("swarm.matchedTitle")}</CardTitle>
        <CardDescription>{t("swarm.matchedDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {matched.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("swarm.matchedEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.agent")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.matchedAt")}</th>
                </tr>
              </thead>
              <tbody>
                {matched.map((row) => (
                  <tr key={`${row.issueId}-${row.at}`} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-muted-foreground">{row.identifier ?? row.issueId}</span>{" "}
                      <span>{row.title}</span>
                    </td>
                    <td className="px-3 py-2">{row.agentName}</td>
                    <td className="px-3 py-2 tabular-nums">{formatDateTime(row.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** myrmidon(1.6.5 SWARM-T4, design §5.3): tasks cooling down after a failed match. */
function CooldownTable({ cooldown }: { cooldown: SwarmSupervisorCooldown[] }) {
  const { t } = useTranslation();
  return (
    <Card data-testid="swarm-cooldown">
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">{t("swarm.cooldownTitle")}</CardTitle>
        <CardDescription>{t("swarm.cooldownDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-2">
        {cooldown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("swarm.cooldownEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border bg-accent/20">
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.queuedAt")}</th>
                  <th scope="col" className={HEAD_CELL}>{t("swarm.columns.coolsDownAt")}</th>
                </tr>
              </thead>
              <tbody>
                {cooldown.map((row) => (
                  <tr key={row.issueId} className="border-b border-border last:border-b-0">
                    <td className="px-3 py-2">
                      <span className="font-mono text-muted-foreground">{row.identifier ?? row.issueId}</span>{" "}
                      <span>{row.title}</span>
                    </td>
                    <td className="px-3 py-2">
                      <PriorityIcon priority={row.priority} showLabel />
                    </td>
                    <td className="px-3 py-2 tabular-nums">{formatDateTime(row.createdAt)}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {row.coolsDownAt ? formatDateTime(row.coolsDownAt) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export interface SwarmSupervisorProps {
  /** Render inside another surface without a second page-level title or breadcrumb. */
  embedded?: boolean;
}

export function SwarmSupervisor({ embedded = false }: SwarmSupervisorProps = {}) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? NO_COMPANY;

  const [section, setSection] = useState<SwarmSection>("roles");

  useEffect(() => {
    if (!embedded) setBreadcrumbs([{ label: t("swarm.title") }]);
  }, [embedded, setBreadcrumbs]);

  const { data, isLoading, error } = useQuery({
    queryKey: swarmSupervisorOverviewKey(companyId),
    queryFn: () => swarmSupervisorApi.overview(companyId),
    enabled: !!selectedCompanyId,
    staleTime: 15_000,
  });

  const releaseMutation = useMutation({
    mutationFn: (claimId: string) => swarmSupervisorApi.releaseLease(companyId, { claimId }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: swarmSupervisorOverviewKey(companyId) });
    },
  });

  if (!selectedCompanyId) {
    return <EmptyState icon={Users} message={t("swarm.selectOrganization")} />;
  }

  const releasingClaimId = releaseMutation.isPending
    ? (releaseMutation.variables ?? null)
    : null;

  return (
    <div className="space-y-6">
      <div className="space-y-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            {embedded ? (
              <h2 className="text-lg font-semibold text-foreground">{t("swarm.title")}</h2>
            ) : (
              <h1 className="text-3xl font-semibold tracking-tight">{t("swarm.title")}</h1>
            )}
            <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
              {t("swarm.intro")}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2" data-testid="swarm-section-switch">
            <Button
              variant={section === "roles" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("roles")}
              aria-pressed={section === "roles"}
            >
              {t("swarm.sections.roles")}
            </Button>
            <Button
              variant={section === "activity" ? "secondary" : "ghost"}
              size="sm"
              onClick={() => setSection("activity")}
              aria-pressed={section === "activity"}
            >
              {t("swarm.sections.activity")}
            </Button>
          </div>
        </div>

        {data ? (
          <div
            className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground"
            data-testid="swarm-overview-meta"
          >
            <span className="flex items-center gap-1.5">
              <Clock className="h-4 w-4" />
              {t("swarm.generated", { time: formatDateTime(data.generatedAt) })}
            </span>
            <span className="flex items-center gap-1.5">
              <RotateCw className="h-4 w-4" />
              {data.leaseTtlSec === null ? "—" : t("swarm.leaseTtl", { seconds: `${formatNumber(data.leaseTtlSec)} s` })}
              {/* myrmidon(1.6.1 SWARM-SETTINGS-UI): where the value came from */}
              <span
                className="text-muted-foreground/80"
                data-testid="swarm-supervisor-source-leaseTtlSec"
              >
                ({swarmSourceLabel(data.settingSources?.leaseTtlSec)})
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              {t("swarm.maxActive")}{" "}
              {data.maxActiveTasksPerAgent === null ? "—" : formatNumber(data.maxActiveTasksPerAgent)}
              <span
                className="text-muted-foreground/80"
                data-testid="swarm-supervisor-source-maxActiveTasks"
              >
                ({swarmSourceLabel(data.settingSources?.maxActiveTasks)})
              </span>
            </span>
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="h-4 w-4" />
              {t("swarm.claimSwitch")}{" "}
              <span data-testid="swarm-supervisor-source-enabled">
                {swarmSourceLabel(data.settingSources?.enabled)}
              </span>
            </span>
          </div>
        ) : null}
      </div>

      {isLoading ? (
        <PageSkeleton variant="costs" />
      ) : error ? (
        <p className="text-sm text-destructive" data-testid="swarm-error">
          {(error as Error).message}
        </p>
      ) : !data ? (
        <EmptyState
          icon={Users}
          title={t("swarm.noOverview")}
          message={t("swarm.noOverviewMessage")}
        />
      ) : !data.enabled ? (
        <EmptyState
          icon={ShieldCheck}
          title={t("swarm.disabled")}
          message={t("swarm.disabledMessage")}
          description={t("swarm.disabledDescription")}
        />
      ) : (
        <>
          <TotalsStrip overview={data} />

          {releaseMutation.isError ? (
            <p className="text-sm text-destructive" data-testid="swarm-release-error">
              {t("swarm.releaseFailed", { message: (releaseMutation.error as Error).message })}
            </p>
          ) : null}

          {section === "roles" ? (
            <div className="space-y-4">
              {data.roles.length === 0 ? (
                <EmptyState
                  icon={ListChecks}
                  title={t("swarm.noRoles")}
                  message={t("swarm.noRolesMessage")}
                />
              ) : (
                data.roles.map((role) => (
                  <RoleSection
                    key={role.role}
                    role={role}
                    maxActiveTasksPerAgent={data.maxActiveTasksPerAgent}
                    onRelease={(claimId) => releaseMutation.mutate(claimId)}
                    releasingClaimId={releasingClaimId}
                  />
                ))
              )}

              {data.topQueue.length > 0 ? (
                <Card data-testid="swarm-top-queue">
                  <CardHeader className="px-5 pt-5 pb-2">
                    <CardTitle className="text-base flex items-center gap-1.5">
                      <TriangleAlert className="h-4 w-4 text-muted-foreground" />
                      {t("swarm.topQueue")}
                    </CardTitle>
                    <CardDescription>{t("swarm.topQueueDescription")}</CardDescription>
                  </CardHeader>
                  <CardContent className="px-5 pb-5 pt-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="border-b border-border bg-accent/20">
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.task")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.role")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.priority")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.project")}</th>
                            <th scope="col" className={HEAD_CELL}>{t("swarm.columns.queuedAt")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.topQueue.map((item) => (
                            <tr key={item.issueId} className="border-b border-border last:border-b-0">
                              <td className="px-3 py-2">
                                <span className="font-mono text-muted-foreground">
                                  {item.identifier ?? item.issueId}
                                </span>{" "}
                                <span>{item.title}</span>
                              </td>
                              <td className="px-3 py-2">{item.role}</td>
                              <td className="px-3 py-2">
                                <PriorityIcon priority={item.priority} showLabel />
                              </td>
                              <td className="px-3 py-2 font-mono text-muted-foreground">{item.projectId ?? "—"}</td>
                              <td className="px-3 py-2 tabular-nums">{formatDateTime(item.createdAt)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              ) : null}
            </div>
          ) : (
            <ActivitySection overview={data} />
          )}
        </>
      )}
    </div>
  );
}