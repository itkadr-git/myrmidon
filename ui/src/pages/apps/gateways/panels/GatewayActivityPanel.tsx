import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Trans } from "react-i18next";
import type { ToolMcpGatewayWithTokens, ToolRedactedValueSummary } from "@myrmidon/shared";
import { toolsApi, type ToolAuditOutcome, type ToolGatewayActivityEvent } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StatusBadge } from "@/components/StatusBadge";
import { i18n, useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import { ErrorState, RelativeTime } from "@/pages/tools/shared";

const PAGE_SIZE = 25;

const outcomeMeta = (): Record<ToolAuditOutcome, { label: string; status: string }> => ({
  allowed: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.allowed"), status: "allowed" },
  blocked: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.blocked"), status: "denied" },
  asked_first: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.askedFirst"), status: "require-approval" },
  waiting: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.waiting"), status: "deferred" },
  failed: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.failed"), status: "failed" },
  unknown: { label: i18n.t("area.apps-gateways-2.gateway-activity-panel.outcome.unknown"), status: "unchecked" },
});

function detailString(details: Record<string, unknown> | null, key: string): string | null {
  const value = details?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function formatSummary(summary: ToolRedactedValueSummary | null | undefined): string | null {
  if (!summary?.summary) return null;
  try {
    return JSON.stringify(JSON.parse(summary.summary), null, 2);
  } catch {
    return summary.summary;
  }
}

function summaryFromDetails(
  details: Record<string, unknown> | null,
  key: "argumentsSummary" | "resultSummary",
): ToolRedactedValueSummary | null {
  const value = details?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const summary = (value as Record<string, unknown>).summary;
  return typeof summary === "string" ? { summary } : null;
}

function durationLabel(event: ToolGatewayActivityEvent): string | null {
  const started = event.invocation?.startedAt ? new Date(event.invocation.startedAt).getTime() : Number.NaN;
  const completed = event.invocation?.completedAt ? new Date(event.invocation.completedAt).getTime() : Number.NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started) return null;
  return i18n.t("area.apps-gateways-2.gateway-activity-panel.durationMs", { value: completed - started });
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1">
      <dt className="w-28 shrink-0 text-muted-foreground">{label}</dt>
      <dd className={mono ? "min-w-0 break-all font-mono text-(length:--text-micro) text-foreground" : "min-w-0 text-foreground"}>
        {value}
      </dd>
    </div>
  );
}

function ActivityRow({ event }: { event: ToolGatewayActivityEvent }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const meta = outcomeMeta();
  const outcome = meta[event.normalizedOutcome] ?? meta.unknown;
  const actor = event.agentDisplayName ?? t("area.apps-gateways-2.gateway-activity-panel.activityRow.defaultActor");
  const app =
    event.appDisplayName ?? event.connectionDisplayName ?? event.applicationDisplayName ?? t("area.apps-gateways-2.gateway-activity-panel.activityRow.defaultApp");
  const tool = event.toolDisplayName ?? event.invocation?.toolName ?? t("area.apps-gateways-2.gateway-activity-panel.activityRow.defaultTool");
  const rawTool = event.invocation?.toolName ?? detailString(event.details, "tool") ?? detailString(event.details, "toolName");
  const reason = detailString(event.details, "reasonCode");
  const argumentsText = formatSummary(
    event.invocation?.argumentsSummary ?? summaryFromDetails(event.details, "argumentsSummary"),
  );
  const resultText = formatSummary(
    event.invocation?.resultSummary ?? summaryFromDetails(event.details, "resultSummary"),
  );
  const duration = durationLabel(event);

  return (
    <li className="text-sm">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-start gap-2.5 px-4 py-3 text-left hover:bg-accent/50"
        aria-expanded={open}
      >
        {open ? (
          <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1">
          <span className="block text-foreground">
            <Trans
              i18nKey="area.apps-gateways-2.gateway-activity-panel.activityRow.summary"
              values={{ actor, tool, app }}
              components={[<span className="font-medium" />, <span className="font-medium" />]}
            />
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2 whitespace-nowrap">
          <StatusBadge status={outcome.status} label={outcome.label} />
          <span className="text-xs text-muted-foreground">
            · <RelativeTime value={event.createdAt} />
          </span>
        </span>
      </button>

      {open ? (
        <div className="border-t border-border bg-muted/30 px-4 py-3 pl-10 text-xs">
          <dl>
            {rawTool ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factTool")} value={rawTool} mono /> : null}
            {event.invocation?.status ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factCallStatus")} value={event.invocation.status} /> : null}
            {event.invocation?.policyDecision ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factDecision")} value={event.invocation.policyDecision} /> : null}
            {reason ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factReason")} value={reason} mono /> : null}
            {duration ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factDuration")} value={duration} /> : null}
            {event.invocation?.id ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factInvocationId")} value={event.invocation.id} mono /> : null}
            {event.invocation?.errorCode ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factErrorCode")} value={event.invocation.errorCode} mono /> : null}
            {event.invocation?.errorMessage ? <Fact label={t("area.apps-gateways-2.gateway-activity-panel.activityRow.factError")} value={event.invocation.errorMessage} /> : null}
          </dl>
          {argumentsText ? (
            <div className="mt-2 space-y-1">
              <div className="text-muted-foreground">{t("area.apps-gateways-2.gateway-activity-panel.activityRow.argumentsRedacted")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                {argumentsText}
              </pre>
            </div>
          ) : null}
          {resultText ? (
            <div className="mt-3 space-y-1">
              <div className="text-muted-foreground">{t("area.apps-gateways-2.gateway-activity-panel.activityRow.resultRedacted")}</div>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 font-mono text-xs text-foreground">
                {resultText}
              </pre>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

export function GatewayActivityPanel({
  companyId,
  gateway,
}: {
  companyId: string;
  gateway: ToolMcpGatewayWithTokens;
}) {
  const { t } = useTranslation();
  const activityQuery = useInfiniteQuery({
    queryKey: queryKeys.tools.activity(companyId, { gateway: gateway.id, window: "30d" }),
    queryFn: ({ pageParam }) =>
      toolsApi.listActivity(companyId, {
        gateway: gateway.id,
        window: "30d",
        limit: PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const events = useMemo(
    () => activityQuery.data?.pages.flatMap((page) => page.events) ?? [],
    [activityQuery.data],
  );

  if (activityQuery.isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
      </div>
    );
  }
  if (activityQuery.isError) {
    return <ErrorState error={activityQuery.error} onRetry={() => activityQuery.refetch()} />;
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {t("area.apps-gateways-2.gateway-activity-panel.description")}
      </p>
      {events.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {t("area.apps-gateways-2.gateway-activity-panel.emptyTitle")}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {events.map((event) => <ActivityRow key={event.id} event={event} />)}
        </ul>
      )}
      {activityQuery.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            onClick={() => activityQuery.fetchNextPage()}
            disabled={activityQuery.isFetchingNextPage}
          >
            {activityQuery.isFetchingNextPage ? t("common.loading") : t("area.apps-gateways-2.gateway-activity-panel.loadMore")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
