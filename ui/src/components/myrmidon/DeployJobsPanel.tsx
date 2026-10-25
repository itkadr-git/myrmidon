// Board self-deploy (myrmidon R5-A): the update screen of the instance
// settings. The flow is deliberately the script's flow: paste a digest →
// preview (verify it is a CI image) → deploy → the job walks
// maintenance → switch → health, with the abort available until the switch
// starts. Only instance admins can start or abort; everyone sees the state.
// myrmidon(R5-C): a failed health check no longer waits for the operator —
// the executor rolls the image back to the locally remembered previous one
// and the job ends auto_rolled_back (or failed_rollback when even the
// rollback fails, which keeps the maintenance window on for a human).
// Auto-update without a confirmation stays off (MYRMIDON_DEPLOY_AUTO_UPDATE,
// off until the release scenario has run on the staging stand).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trans } from "react-i18next";
import { i18n, useTranslation } from "@/i18n";
import {
  deployJobsApi,
  deployJobsQueryKey,
  describeDeployStatus,
  digestProblemClient,
  type DeployImagePreview,
  type DeployJobState,
  type DeployJobView,
} from "./deployJobsApi";

export function DeployJobsPanelView({
  state,
  preview,
  onPreview,
  onStart,
  onAbort,
  pending,
  error,
  filterValues,
  onFilterChange,
}: {
  state: DeployJobState | null | undefined;
  preview: DeployImagePreview | null;
  onPreview: (reference: string) => void;
  onStart: (reference: string) => void;
  onAbort: (job: DeployJobView) => void;
  pending: boolean;
  error: string | null;
  filterValues?: { mode?: string; status?: string; outcome?: string };
  onFilterChange?: (filters: { mode?: string; status?: string; outcome?: string }) => void;
}) {
  const { t } = useTranslation();
  const [reference, setReference] = useState("");
  const [localFilters, setLocalFilters] = useState({ mode: "", status: "", outcome: "" });
  const modeFilter = filterValues?.mode ?? localFilters.mode;
  const statusFilter = filterValues?.status ?? localFilters.status;
  const outcomeFilter = filterValues?.outcome ?? localFilters.outcome;
  const setFilter = (name: "mode" | "status" | "outcome", value: string) => {
    const next = { ...localFilters, [name]: value };
    setLocalFilters(next);
    onFilterChange?.({ mode: next.mode || undefined, status: next.status || undefined, outcome: next.outcome || undefined });
  };
  const [confirmStart, setConfirmStart] = useState(false);
  const problem = digestProblemClient(reference);
  const job = state?.job ?? null;
  const canStart = !pending && reference.trim().length > 0 && problem === null && !(job?.active ?? false);

  return (
    <section className="space-y-4" data-testid="myrmidon-deploy-jobs">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Rocket className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-bots-host-1.deploy-jobs-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-bots-host-1.deploy-jobs-panel.intro")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive" data-testid="myrmidon-deploy-error">
          {error}
        </div>
      ) : null}

      {job ? <DeployJobCard job={job} onAbort={onAbort} pending={pending} /> : <p className="text-sm text-muted-foreground">{t("area.settings-bots-host-1.deploy-jobs-panel.noDeploy")}</p>}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1 md:col-span-2">
          <Label htmlFor="myrmidon-deploy-digest">{t("area.settings-bots-host-1.deploy-jobs-panel.digestLabel")}</Label>
          <Input
            id="myrmidon-deploy-digest"
            placeholder={t("area.settings-bots-host-1.deploy-jobs-panel.digestPlaceholder")}
            value={reference}
            onChange={(event) => {
              setReference(event.target.value);
              setConfirmStart(false);
            }}
          />
          {problem && reference.trim() ? <p className="text-sm text-destructive">{problem}</p> : null}
        </div>
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button size="sm" variant="outline" disabled={!canStart} onClick={() => onPreview(reference.trim())}>
            {t("area.settings-bots-host-1.deploy-jobs-panel.verify")}
          </Button>
          {confirmStart ? (
            <Button size="sm" variant="destructive" disabled={!canStart} onClick={() => { setConfirmStart(false); onStart(reference.trim()); }}>
              {t("area.settings-bots-host-1.deploy-jobs-panel.confirmDeploy")}
            </Button>
          ) : (
            <Button size="sm" disabled={!canStart} onClick={() => setConfirmStart(true)}>
              {t("area.settings-bots-host-1.deploy-jobs-panel.deploy")}
            </Button>
          )}
          {confirmStart ? (
            <Button size="sm" variant="outline" onClick={() => setConfirmStart(false)}>
              {t("common.cancel")}
            </Button>
          ) : null}
        </div>
        {preview ? <PreviewCard preview={preview} /> : null}
      </div>

      {state?.history ? (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">{t("area.settings-bots-host-1.deploy-jobs-panel.previous", { count: state.history.length })}</summary>
          <div className="mt-2 flex flex-wrap gap-2">
            <select aria-label={t("area.settings-bots-host-1.deploy-jobs-panel.modeAria")} value={modeFilter} onChange={(event) => setFilter("mode", event.target.value)}>
              <option value="">{t("area.settings-bots-host-1.deploy-jobs-panel.allModes")}</option>
              <option value="manual">{t("area.settings-bots-host-1.deploy-jobs-panel.modeManual")}</option>
              <option value="auto">{t("area.settings-bots-host-1.deploy-jobs-panel.modeAuto")}</option>
              <option value="canary">{t("area.settings-bots-host-1.deploy-jobs-panel.modeCanary")}</option>
            </select>
            <select aria-label={t("area.settings-bots-host-1.deploy-jobs-panel.statusAria")} value={statusFilter} onChange={(event) => setFilter("status", event.target.value)}>
              <option value="">{t("area.settings-bots-host-1.deploy-jobs-panel.allStatuses")}</option>
              <option value="succeeded">{t("area.settings-bots-host-1.deploy-jobs-panel.statusSucceeded")}</option>
              <option value="auto_rolled_back">{t("area.settings-bots-host-1.deploy-jobs-panel.statusAutoRolledBack")}</option>
              <option value="failed_rollback">{t("area.settings-bots-host-1.deploy-jobs-panel.statusFailedRollback")}</option>
              <option value="failed_health">{t("area.settings-bots-host-1.deploy-jobs-panel.statusFailedHealth")}</option>
              <option value="aborted">{t("area.settings-bots-host-1.deploy-jobs-panel.statusAborted")}</option>
              <option value="failed_verification">{t("area.settings-bots-host-1.deploy-jobs-panel.statusFailedVerification")}</option>
              <option value="maintenance_failed">{t("area.settings-bots-host-1.deploy-jobs-panel.statusMaintenanceFailed")}</option>
            </select>
            <select aria-label={t("area.settings-bots-host-1.deploy-jobs-panel.outcomeAria")} value={outcomeFilter} onChange={(event) => setFilter("outcome", event.target.value)}>
              <option value="">{t("area.settings-bots-host-1.deploy-jobs-panel.allOutcomes")}</option>
              <option value="succeeded">{t("area.settings-bots-host-1.deploy-jobs-panel.outcomeSucceeded")}</option>
              <option value="rollback">{t("area.settings-bots-host-1.deploy-jobs-panel.outcomeRollback")}</option>
              <option value="aborted">{t("area.settings-bots-host-1.deploy-jobs-panel.outcomeAborted")}</option>
            </select>
          </div>
          <ul className="mt-2 space-y-1">
            {state.history.filter((entry) => (!modeFilter || entry.mode === modeFilter) && (!statusFilter || entry.status === statusFilter) && (!outcomeFilter || (outcomeFilter === "rollback" ? entry.status.includes("rollback") : entry.status === outcomeFilter))).map((entry) => (
              <li key={entry.id} className="text-muted-foreground">
                {[
                  new Date(entry.createdAt).toLocaleString(i18n.language),
                  entry.mode,
                  describeDeployStatus(entry.status),
                  `${entry.digest.slice(0, 19)}…`,
                  entry.version ? t("area.settings-bots-host-1.deploy-jobs-panel.historyVersion", { version: entry.version }) : null,
                  entry.commit ? t("area.settings-bots-host-1.deploy-jobs-panel.historyCommit", { commit: entry.commit.slice(0, 12) }) : null,
                  entry.window || null,
                  entry.failureReason || null,
                ]
                  .filter((part) => part !== null)
                  .join(" — ")}
              </li>
            ))}
            {!state.history.length ? <li className="text-muted-foreground">{t("area.settings-bots-host-1.deploy-jobs-panel.noHistory")}</li> : null}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function PreviewCard({ preview }: { preview: DeployImagePreview }) {
  const { t } = useTranslation();
  return (
    <div
      className="rounded-md border border-border px-3 py-2 text-sm md:col-span-2"
      data-testid={preview.ok ? "myrmidon-deploy-preview-ok" : "myrmidon-deploy-preview-failed"}
    >
      {preview.ok ? (
        <div>
          <Trans
            i18nKey="area.settings-bots-host-1.deploy-jobs-panel.previewOk"
            values={{ commit: preview.commit?.slice(0, 12), version: preview.version ?? t("area.settings-bots-host-1.deploy-jobs-panel.previewNoVersion") }}
            components={[<code key="commit" />]}
          />
        </div>
      ) : (
        <div className="text-destructive">{t("area.settings-bots-host-1.deploy-jobs-panel.previewRefused", { reason: preview.reason })}</div>
      )}
    </div>
  );
}

function DeployJobCard({ job, onAbort, pending }: { job: DeployJobView; onAbort: (job: DeployJobView) => void; pending: boolean }) {
  const { t } = useTranslation();
  const [confirmAbort, setConfirmAbort] = useState(false);
  return (
    <div className="space-y-2 rounded-md border border-border px-3 py-2 text-sm" data-testid="myrmidon-deploy-job">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
        <div className="min-w-0">
          <div className="font-medium">
            {describeDeployStatus(job.status)} — <code>{job.digest.slice(0, 19)}</code>…
            {job.version ? ` (${job.version})` : ""}
          </div>
          <div className="text-muted-foreground">
            {[job.reason, t("area.settings-bots-host-1.deploy-jobs-panel.started", { date: new Date(job.createdAt).toLocaleString(i18n.language) }), t("area.settings-bots-host-1.deploy-jobs-panel.steps", { count: job.steps.length })].join(" · ")}
          </div>
        </div>
        {job.abortable ? (
          confirmAbort ? (
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  setConfirmAbort(false);
                  onAbort(job);
                }}
              >
                {t("area.settings-bots-host-1.deploy-jobs-panel.confirmAbort")}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setConfirmAbort(false)}>
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmAbort(true)}>
              {t("area.settings-bots-host-1.deploy-jobs-panel.abort")}
            </Button>
          )
        ) : null}
      </div>
      {job.failureReason ? <div className="text-destructive">{job.failureReason}</div> : null}
      {job.steps.length ? (
        <ol className="space-y-1 text-muted-foreground">
          {job.steps.slice(-8).map((step, index) => (
            <li key={`${step.at}-${index}`}>
              {t("area.settings-bots-host-1.deploy-jobs-panel.stepLine", { time: new Date(step.at).toLocaleTimeString(i18n.language), status: describeDeployStatus(step.status), detail: step.detail })}
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

export function DeployJobsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeployImagePreview | null>(null);
  const [filters, setFilters] = useState<{ mode?: string; status?: string; outcome?: string }>({});
  const { data } = useQuery({
    queryKey: [...deployJobsQueryKey, filters],
    queryFn: () => deployJobsApi.get(filters),
    refetchInterval: 10_000,
    retry: false,
  });
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: deployJobsQueryKey });
  };
  const onError = (err: unknown) => {
    const message = err instanceof Error ? err.message : t("area.settings-bots-host-1.deploy-jobs-panel.requestFailed");
    setError(message.includes("not enabled") ? t("area.settings-bots-host-1.deploy-jobs-panel.notEnabled") : message);
  };
  const previewMutation = useMutation({
    mutationFn: deployJobsApi.preview,
    onMutate: () => setError(null),
    onSuccess: (result) => setPreview(result),
    onError,
    onSettled: refresh,
  });
  const create = useMutation({
    mutationFn: (reference: string) => deployJobsApi.create(reference),
    onMutate: () => {
      setError(null);
      setPreview(null);
    },
    onError,
    onSettled: refresh,
  });
  const abort = useMutation({
    mutationFn: (id: string) => deployJobsApi.abort(id),
    onMutate: () => setError(null),
    onError,
    onSettled: refresh,
  });
  const pending = previewMutation.isPending || create.isPending || abort.isPending;
  return (
    <DeployJobsPanelView
      state={data}
      preview={preview}
      onPreview={(reference) => previewMutation.mutate(reference)}
      onStart={(reference) => create.mutate(reference)}
      onAbort={(job) => abort.mutate(job.id)}
      pending={pending}
      error={error}
      filterValues={filters}
      onFilterChange={setFilters}
    />
  );
}
