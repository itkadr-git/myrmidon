import { Clock, RotateCcw, AlertCircle, Loader2, CheckCircle2 } from "lucide-react";
import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { cn, formatDateTime } from "@/lib/utils";
import { formatMonitorOffset } from "@/lib/issue-monitor";
import { formatRetryAttemptCounter, formatRetryClassification, formatRetryReason } from "@/lib/runRetryState";
import type { IssueScheduledRetry } from "@paperclipai/shared";
import { useRetryNowMutation, type RetryNowError } from "../hooks/useRetryNowMutation";
import { Badge } from "@/components/ui/badge";
import { InlineBanner } from "@/components/InlineBanner";
import { Trans } from "react-i18next";
import { useTranslation } from "@/i18n";

const MAX_TURN_CONTINUATION = "max_turns_continuation";

function isContinuationReason(reason: string | null | undefined) {
  return reason === MAX_TURN_CONTINUATION;
}

function shortRunId(runId: string | null | undefined) {
  return typeof runId === "string" && runId.length >= 8 ? runId.slice(0, 8) : runId ?? "";
}

interface IssueScheduledRetryCardProps {
  issueId: string | null | undefined;
  scheduledRetry: IssueScheduledRetry | null | undefined;
}

export function IssueScheduledRetryCard({
  issueId,
  scheduledRetry,
}: IssueScheduledRetryCardProps) {
  const { t } = useTranslation();
  const retryNow = useRetryNowMutation(issueId);

  if (!scheduledRetry || !issueId) return null;
  if (scheduledRetry.status !== "scheduled_retry") return null;

  if (scheduledRetry.scheduledRetryReason === "workspace_busy") {
    return (
      <InlineBanner tone="info" icon={Clock} title={t("area.issue-threads-runs-1.issue-scheduled-retry-card.waitingForWorkspace")} className="mb-3">
        {t("area.issue-threads-runs-1.issue-scheduled-retry-card.workspaceBusy")}
      </InlineBanner>
    );
  }

  const continuation = isContinuationReason(scheduledRetry.scheduledRetryReason);
  const dueAtIso = scheduledRetry.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const relative = dueAtIso ? formatMonitorOffset(dueAtIso) : null;
  const absolute = scheduledRetry.scheduledRetryAt
    ? formatDateTime(scheduledRetry.scheduledRetryAt)
    : null;
  const reason = formatRetryReason(scheduledRetry.scheduledRetryReason);
  const attemptLabel = formatRetryAttemptCounter(
    scheduledRetry.scheduledRetryAttempt,
    scheduledRetry.scheduledRetryMaxAttempts,
  );
  // myrmidon(1.6.6 RUN-RETRY-POLICY): the class of the failure behind the retry,
  // recorded by the scheduler with the schedule itself.
  const classificationLabel = formatRetryClassification(
    scheduledRetry.scheduledRetryClassification,
  );
  // The reason and the class often say the same thing ("transient_failure" is a
  // transient failure); show the class only when it adds something.
  const showClassificationLabel = classificationLabel !== null && classificationLabel !== reason;

  const badgeLabel = continuation ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.continuationScheduled") : t("area.issue-threads-runs-1.issue-scheduled-retry-card.retryScheduled");
  let titleSuffix: string;
  if (relative === "now") {
    titleSuffix = t("area.issue-threads-runs-1.issue-scheduled-retry-card.dueNow");
  } else if (relative) {
    titleSuffix = relative;
  } else {
    titleSuffix = t("area.issue-threads-runs-1.issue-scheduled-retry-card.pendingSchedule");
  }
  const title = continuation
    ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.titleContinuation", { when: titleSuffix })
    : t("area.issue-threads-runs-1.issue-scheduled-retry-card.titleRetry", { when: titleSuffix });

  const helperIdle = continuation
    ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.helperContinuation")
    : t("area.issue-threads-runs-1.issue-scheduled-retry-card.helperRetry");
  const isError = retryNow.isError || retryNow.lastError !== null;
  const isSuccessTransient = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");

  return (
    <div
      data-testid="issue-scheduled-retry-card"
      className="mb-3 rounded-lg border border-blue-500/30 bg-blue-500/5 px-3 py-3"
    >
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant="outline" className="border-blue-500/30 bg-blue-500/10 text-blue-700 dark:text-blue-300">
              <Clock className="h-3 w-3" aria-hidden="true" />
              {badgeLabel}
            </Badge>
            {attemptLabel !== null ? (
              <span className="text-muted-foreground">{attemptLabel}</span>
            ) : null}
            {showClassificationLabel ? (
              <span className="text-muted-foreground">{classificationLabel}</span>
            ) : null}
            {reason ? (
              <span className="text-muted-foreground">{reason}</span>
            ) : null}
          </div>
          <div className="mt-1 text-sm font-medium text-foreground">{title}</div>
          {(absolute || scheduledRetry.retryOfRunId) ? (
            <div className="mt-0.5 text-xs text-muted-foreground">
              {absolute ? <span>{absolute}</span> : null}
              {absolute && scheduledRetry.retryOfRunId ? <span>{" · "}</span> : null}
              {scheduledRetry.retryOfRunId ? (
                <span>
                  <Trans
                    i18nKey="area.issue-threads-runs-1.issue-scheduled-retry-card.replacesRun"
                    components={[
                      <Link
                        key="run"
                        to={`/agents/${scheduledRetry.agentId}/runs/${scheduledRetry.retryOfRunId}`}
                        className="font-mono text-foreground hover:underline"
                      />,
                    ]}
                    values={{ runId: shortRunId(scheduledRetry.retryOfRunId) }}
                  />
                </span>
              ) : null}
            </div>
          ) : null}
          {scheduledRetry.error ? (
            <div className="mt-1 text-xs text-muted-foreground">
              {t("area.issue-threads-runs-1.issue-scheduled-retry-card.lastAttemptFailed", { error: scheduledRetry.error })}
            </div>
          ) : null}
          {isError ? (
            <RetryErrorBand
              error={retryNow.lastError}
              onRetry={() => {
                retryNow.reset();
                retryNow.mutate();
              }}
            />
          ) : null}
        </div>
        <div className="flex flex-col items-stretch gap-1 sm:items-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="shrink-0 shadow-none"
            onClick={() => retryNow.mutate()}
            disabled={retryNow.isPending || isSuccessTransient}
            data-testid="issue-scheduled-retry-card-retry-now"
          >
            {retryNow.isPending ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                {t("common.retrying")}
              </span>
            ) : isSuccessTransient ? (
              <span className="inline-flex items-center gap-1.5">
                <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
                {retryNow.data?.outcome === "already_promoted" ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.alreadyPromoted") : t("area.issue-threads-runs-1.issue-scheduled-retry-card.promoted")}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                {t("area.issue-threads-runs-1.issue-scheduled-retry-card.retryNow")}
              </span>
            )}
          </Button>
          <span className="text-right text-xs text-muted-foreground sm:max-w-(--sz-12rem)">
            {retryNow.isPending
              ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.promotingScheduledRetry")
              : isSuccessTransient
                ? retryNow.data?.outcome === "already_promoted"
                  ? t("area.issue-threads-runs-1.issue-scheduled-retry-card.alreadyPromotedRunStarting")
                  : t("area.issue-threads-runs-1.issue-scheduled-retry-card.promotedRunStarting")
                : helperIdle}
          </span>
        </div>
      </div>
    </div>
  );
}

interface RetryErrorBandProps {
  error: RetryNowError | null;
  onRetry: () => void;
  className?: string;
}

export function RetryErrorBand({ error, onRetry, className }: RetryErrorBandProps) {
  const { t } = useTranslation();
  if (!error) return null;
  return (
    <div
      className={cn(
        "mt-2 flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/5 px-2 py-1.5 text-xs text-rose-700 dark:text-rose-300",
        className,
      )}
      role="alert"
      data-testid="issue-scheduled-retry-error-band"
    >
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{t("area.issue-threads-runs-1.issue-scheduled-retry-card.retryFailed")}</div>
        <div className="mt-0.5 text-muted-foreground">{error.message}</div>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="shrink-0 font-medium text-rose-700 hover:underline dark:text-rose-300"
      >
        {t("area.issue-threads-runs-1.issue-scheduled-retry-card.tryAgain")}
      </button>
    </div>
  );
}
