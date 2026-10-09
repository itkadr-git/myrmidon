// myrmidon(1.6.6-LITELLM-WORKERS-UI): the "Gateway workers" tab of the Costs
// page — how many LiteLLM gateway processes run, their load, and where the
// operator sets the desired count.
//
// Reads GET /api/myrmidon/companies/:id/litellm/workers (state + metrics,
// refreshed every 30 s) and applies a new count through
// PUT …/workers { target } behind a confirm step. The two ceilings from the
// backend (CPU and memory) are shown as hints; input above maxByMemory is
// caught client-side, and a 400 from the server is shown with its own text.
// When the backend carries the optional `auto` field the tab also shows the
// auto-select toggle; without it the toggle is disabled with an explanation,
// because the threshold logic lives in the backend (part A), not here.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cpu } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  litellmWorkersApi,
  litellmWorkersKey,
  perWorkerCpuSeries,
  validateWorkerTarget,
  type LitellmWorkersState,
} from "./litellmWorkersApi";
import { isNotEnabledError } from "./litellmCostsApi";

/** The error text the operator sees from a failed PUT: server text first. */
export function applyErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "Applying the worker count failed.";
}

/** "current -> target" status line after the latest read. */
export function applyStatusLine(
  state: LitellmWorkersState | undefined,
  unknownLine = "Running now is unknown: the gateway did not report its pool size.",
): string | null {
  if (!state) return null;
  if (state.current === null) return unknownLine;
  if (state.current === state.target) return `${state.current} worker${state.current === 1 ? "" : "s"} running — applied.`;
  return `Applying: ${state.current} running -> ${state.target} requested.`;
}

function MetricLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border border-border px-4 py-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium tabular-nums">{value}</span>
    </div>
  );
}

function CpuBar({ percent }: { percent: number }) {
  const width = `${Math.round(percent)}%`;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-muted" role="presentation">
      <div
        className="h-full rounded-full bg-(--status-task-done)"
        style={{ width }}
        aria-hidden="true"
      />
    </div>
  );
}

function WorkersControlCard({ companyId }: { companyId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data, error } = useQuery({
    queryKey: litellmWorkersKey(companyId),
    queryFn: () => litellmWorkersApi.state(companyId),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? String(data?.target ?? "");
  const maxByMemory = data?.maxByMemory ?? Number.POSITIVE_INFINITY;
  const problem = data ? validateWorkerTarget(shown, maxByMemory) : null;
  const statusLine = applyStatusLine(data, t("litellmWorkers.statusUnknown"));

  const mutation = useMutation({
    mutationFn: (target: number) =>
      litellmWorkersApi.apply(companyId, target, data?.auto ? data.auto.enabled : null),
    onSuccess: (next) => {
      queryClient.setQueryData(litellmWorkersKey(companyId), next);
      setDraft(null);
    },
  });

  const [confirmApply, setConfirmApply] = useState(false);

  useEffect(() => {
    if (draft === null && data) setConfirmApply(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  if (error) {
    return (
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Worker processes</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <p className="text-sm text-destructive">
            {isNotEnabledError(error)
              ? "LiteLLM worker control is not enabled on this instance."
              : (error as Error).message}
          </p>
        </CardContent>
      </Card>
    );
  }
  if (!data) {
    return (
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Worker processes</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <p className="text-sm text-muted-foreground">Loading gateway worker state…</p>
        </CardContent>
      </Card>
    );
  }

  const target = Number(shown);
  const canApply = problem === null && Number.isInteger(target) && !mutation.isPending && target > 0;

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Worker processes</CardTitle>
        <CardDescription>
          How many LiteLLM gateway processes handle requests. Changing the count is done without a restart
          (the master signals its workers), so the gateway keeps serving while it applies.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 px-5 pb-5 pt-2">
        <div className="space-y-1">
          <Label htmlFor="myrmidon-workers-target">Number of processes</Label>
          <Input
            id="myrmidon-workers-target"
            inputMode="numeric"
            value={shown}
            disabled={mutation.isPending}
            onChange={(event) => {
              setDraft(event.target.value);
              mutation.reset();
            }}
          />
          <p className="text-xs text-muted-foreground">
            Max by CPU: {data.maxByCpu} · Max by memory: {data.maxByMemory} · {t("litellmWorkers.runningNow", { value: data.current ?? t("litellmWorkers.unknown") })}
          </p>
          {problem && shown.trim() !== "" ? <p className="text-sm text-destructive">{problem}</p> : null}
        </div>

        <div className="flex flex-wrap gap-2">
          {(data.current ?? data.target) !== target && canApply ? (
            confirmApply ? (
              <>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!canApply}
                  onClick={() => {
                    setConfirmApply(false);
                    mutation.mutate(target);
                  }}
                >
                  Confirm: set {target} worker{target === 1 ? "" : "s"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setConfirmApply(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={!canApply} onClick={() => setConfirmApply(true)}>
                Apply {target} worker{target === 1 ? "" : "s"}
              </Button>
            )
          ) : null}
          {mutation.isPending ? <p className="text-sm text-muted-foreground">Applying…</p> : null}
        </div>

        {statusLine ? <p className="text-sm text-muted-foreground">{statusLine}</p> : null}

        {mutation.isError ? (
          <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="myrmidon-workers-error">
            {applyErrorMessage(mutation.error)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function MetricsCard({ companyId }: { companyId: string }) {
  const { data } = useQuery({
    queryKey: litellmWorkersKey(companyId),
    queryFn: () => litellmWorkersApi.state(companyId),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const cpu = useMemo(() => perWorkerCpuSeries(data?.metrics?.perWorkerCpu), [data]);

  if (!data) {
    return (
      <Card>
        <CardHeader className="px-5 pt-5 pb-2">
          <CardTitle className="text-base">Gateway metrics</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-5 pt-2">
          <p className="text-sm text-muted-foreground">Waiting for the first metrics read…</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Gateway metrics</CardTitle>
        <CardDescription>Read from the gateway every 30 seconds.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        {cpu.length === 0 ? (
          <MetricLine label="CPU per worker" value="-" />
        ) : (
          cpu.map((percent, index) => (
            <div key={index} className="flex items-center gap-3 border border-border px-4 py-2">
              <Cpu className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="w-24 shrink-0 text-sm text-muted-foreground">Worker {index + 1}</span>
              <div className="min-w-0 flex-1">
                <CpuBar percent={percent} />
              </div>
              <span className="w-16 shrink-0 text-right text-sm font-medium tabular-nums">
                {Math.round(percent)}%
              </span>
            </div>
          ))
        )}
        <MetricLine
          label="Median response time"
          value={data.metrics.medianLatencyMs == null ? "-" : `${Math.round(data.metrics.medianLatencyMs)} ms`}
        />
        <MetricLine
          label="Request queue"
          value={data.metrics.queueDepth == null ? "-" : String(data.metrics.queueDepth)}
        />
      </CardContent>
    </Card>
  );
}

function AutoSelectCard({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: litellmWorkersKey(companyId),
    queryFn: () => litellmWorkersApi.state(companyId),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });

  const supported = data?.auto != null;
  const enabled = data?.auto?.enabled ?? false;

  const mutation = useMutation({
    mutationFn: (next: boolean) =>
      litellmWorkersApi.apply(companyId, data?.target ?? data?.current ?? 1, next),
    onSuccess: (state) => queryClient.setQueryData(litellmWorkersKey(companyId), state),
  });

  return (
    <Card>
      <CardHeader className="px-5 pt-5 pb-2">
        <CardTitle className="text-base">Auto-select</CardTitle>
        <CardDescription>
          When on, the backend adds a worker while load stays above 80% and removes one below 30%, with
          hysteresis and the ceilings above. The rule itself runs on the server; this switch only turns it
          on or off.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 px-5 pb-5 pt-2">
        <div className="flex items-center gap-3">
          <ToggleSwitch
            checked={enabled}
            disabled={!supported || mutation.isPending}
            onCheckedChange={(next) => mutation.mutate(next)}
            aria-label="Auto-select worker count"
          />
          <span className="text-sm">
            {supported ? (enabled ? "Auto-select is on" : "Auto-select is off") : "Not supported by this backend"}
          </span>
        </div>
        {!supported && data ? (
          <p className="text-xs text-muted-foreground">
            The server does not expose the auto-select setting yet, so the switch is disabled. Manual
            worker control above still works.
          </p>
        ) : null}
        {mutation.isError ? (
          <div className="border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="myrmidon-workers-auto-error">
            {applyErrorMessage(mutation.error)}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/** The whole "Gateway workers" tab. */
export function GatewayWorkersTab({ companyId }: { companyId: string }) {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <WorkersControlCard companyId={companyId} />
      <MetricsCard companyId={companyId} />
      <AutoSelectCard companyId={companyId} />
    </div>
  );
}
