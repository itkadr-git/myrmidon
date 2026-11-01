import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { instanceSettingsApi, taskDrainQueryKey, type TaskDrainStatus } from "../../../../api/instanceSettings";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import {
  Ui2ErrorNote,
  Ui2Loading,
  Ui2Section,
  Ui2StatusDot,
} from "../../../components/ui2Primitives";

const DURATION_OPTIONS = [
  { value: 15 * 60 * 1000, labelKey: "ui2.settings.runs.drain.duration.d15m" as const },
  { value: 60 * 60 * 1000, labelKey: "ui2.settings.runs.drain.duration.d1h" as const },
  { value: 4 * 60 * 60 * 1000, labelKey: "ui2.settings.runs.drain.duration.d4h" as const },
  { value: 24 * 60 * 60 * 1000, labelKey: "ui2.settings.runs.drain.duration.d24h" as const },
];

function formatExpiresAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19) + " UTC";
}

export function Ui2TaskDrainBlock() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const [selectedDurationMs, setSelectedDurationMs] = useState<number>(60 * 60 * 1000);
  const [confirmingStart, setConfirmingStart] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const {
    data: status,
    isLoading,
    isError,
    error,
    refetch,
  } = useQuery<TaskDrainStatus>({
    queryKey: taskDrainQueryKey,
    queryFn: () => instanceSettingsApi.getTaskDrain(),
    refetchInterval: 10_000,
  });

  const startMutation = useMutation({
    mutationFn: (ttlMs: number) => instanceSettingsApi.startTaskDrain({ ttlMs }),
    onSuccess: () => {
      setActionError(null);
      setConfirmingStart(false);
      void queryClient.invalidateQueries({ queryKey: taskDrainQueryKey });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : t("ui2.settings.runs.drain.error.actionFailed"));
    },
  });

  const stopMutation = useMutation({
    mutationFn: () => instanceSettingsApi.stopTaskDrain(),
    onSuccess: () => {
      setActionError(null);
      setConfirmingStart(false);
      void queryClient.invalidateQueries({ queryKey: taskDrainQueryKey });
    },
    onError: (err) => {
      setActionError(err instanceof Error ? err.message : t("ui2.settings.runs.drain.error.actionFailed"));
    },
  });

  if (isLoading) {
    return (
      <Ui2Section title={t("ui2.settings.runs.drain.title")} footer={t("ui2.settings.runs.drain.subtitle")}>
        <div data-testid="ui2-task-drain-loading" className="py-2">
          <Ui2Loading label={t("ui2.common.loading")} />
        </div>
      </Ui2Section>
    );
  }

  if (isError) {
    const isDenied =
      error instanceof Error &&
      (error.message.includes("403") || error.message.toLowerCase().includes("forbidden") || error.message.toLowerCase().includes("denied"));
    return (
      <Ui2Section title={t("ui2.settings.runs.drain.title")} footer={t("ui2.settings.runs.drain.subtitle")}>
        <div data-testid="ui2-task-drain-error" className="py-2">
          <Ui2ErrorNote
            message={isDenied ? t("ui2.settings.runs.drain.error.denied") : t("ui2.settings.runs.drain.error.generic")}
            retryLabel={t("ui2.common.retry")}
            onRetry={() => void refetch()}
          />
        </div>
      </Ui2Section>
    );
  }

  const isDraining = Boolean(status?.draining);
  const selectedOption = DURATION_OPTIONS.find((opt) => opt.value === selectedDurationMs);
  const durationLabel = selectedOption ? t(selectedOption.labelKey) : `${selectedDurationMs}ms`;

  return (
    <Ui2Section title={t("ui2.settings.runs.drain.title")} footer={t("ui2.settings.runs.drain.subtitle")}>
      <div className="flex flex-col gap-3 py-1">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Ui2StatusDot tone={isDraining ? "warning" : "ok"} />
            <span data-testid="ui2-task-drain-status" className="text-sm font-medium">
              {isDraining ? t("ui2.settings.runs.drain.status.draining") : t("ui2.settings.runs.drain.status.idle")}
            </span>
            {isDraining && (
              <span data-testid="ui2-task-drain-expiry" className="text-sm text-muted-foreground">
                {status?.expiresAt
                  ? t("ui2.settings.runs.drain.status.until", { time: formatExpiresAt(status.expiresAt) })
                  : t("ui2.settings.runs.drain.status.noExpiry")}
              </span>
            )}
            {isDraining && typeof status?.activeRuns === "number" && (
              <span data-testid="ui2-task-drain-active-runs" className="text-xs text-muted-foreground">
                {t("ui2.settings.runs.drain.status.activeRuns", { count: status.activeRuns })}
              </span>
            )}
          </div>

          {isDraining ? (
            <button
              type="button"
              data-testid="ui2-task-drain-stop-btn"
              className="rounded-md border border-border bg-destructive text-destructive-foreground px-3 py-1.5 text-sm font-medium hover:bg-destructive/90 disabled:opacity-50"
              disabled={stopMutation.isPending}
              onClick={() => stopMutation.mutate()}
            >
              {t("ui2.settings.runs.drain.action.stop")}
            </button>
          ) : (
            !confirmingStart && (
              <div className="flex flex-wrap items-center gap-2">
                <label htmlFor="ui2-task-drain-ttl-select" className="text-sm text-muted-foreground">
                  {t("ui2.settings.runs.drain.duration.label")}
                </label>
                <select
                  id="ui2-task-drain-ttl-select"
                  data-testid="ui2-task-drain-ttl-select"
                  className="rounded-md border border-border bg-background px-2.5 py-1 text-sm text-foreground"
                  value={selectedDurationMs}
                  onChange={(e) => setSelectedDurationMs(Number(e.target.value))}
                >
                  {DURATION_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {t(opt.labelKey)}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  data-testid="ui2-task-drain-start-btn"
                  className="rounded-md border border-border bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
                  disabled={startMutation.isPending}
                  onClick={() => setConfirmingStart(true)}
                >
                  {t("ui2.settings.runs.drain.action.start")}
                </button>
              </div>
            )
          )}
        </div>

        {!isDraining && confirmingStart && (
          <div data-testid="ui2-task-drain-confirm-dialog" className="flex flex-col gap-2 rounded-md border border-border bg-card p-3">
            <p data-testid="ui2-task-drain-confirm-prompt" className="text-sm text-foreground">
              {t("ui2.settings.runs.drain.confirm.prompt", { duration: durationLabel })}
            </p>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="ui2-task-drain-confirm-btn"
                className="rounded-md border border-border bg-destructive text-destructive-foreground px-3 py-1 text-sm font-medium hover:bg-destructive/90 disabled:opacity-50"
                disabled={startMutation.isPending}
                onClick={() => startMutation.mutate(selectedDurationMs)}
              >
                {t("ui2.settings.runs.drain.confirm.confirm")}
              </button>
              <button
                type="button"
                data-testid="ui2-task-drain-cancel-btn"
                className="rounded-md border border-border px-3 py-1 text-sm font-medium hover:bg-accent disabled:opacity-50"
                disabled={startMutation.isPending}
                onClick={() => setConfirmingStart(false)}
              >
                {t("ui2.settings.runs.drain.confirm.cancel")}
              </button>
            </div>
          </div>
        )}

        {actionError && (
          <div data-testid="ui2-task-drain-action-error" className="text-xs text-destructive">
            {actionError}
          </div>
        )}
      </div>
    </Ui2Section>
  );
}
