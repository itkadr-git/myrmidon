// ui/src/ui2/screens/settings/system/Ui2DatastoreRetentionSettings.tsx
//
// myrmidon(OPE-12613): Settings → System → "Database storage" — the DB-SIZE
// panel over GET/PATCH /api/myrmidon/datastore-care. Shows the owner the size
// levers (run-context retention days — 0 turns compaction off, the batches
// ceiling per pass, the "machine is copied outside" backup-gate mode), the
// source of every resolved value (settings / env / default) and the outcome
// of the last compaction pass (when, how many runs compacted, bytes freed,
// whether it is waiting for a backup). Editing is instance-admin only
// (server-side assertInstanceAdmin); the panel mirrors that with
// GET /api/access/current-board-access — a non-admin gets disabled inputs
// and no Save/Reset buttons at all.
//
// The panel edits a local draft and sends ONE PATCH containing only the
// fields that actually changed (acceptance: a PATCH must not carry untouched
// fields). "Reset to defaults" sends explicit `null`s for every field — the
// endpoint clears them and resolution falls back to env, then default.
// 0 days renders a persistent "compaction is off" warning while the value is
// 0, so saving 0 never happens without the warning on screen. The panel
// never triggers a compaction pass and shows no "Compact now" button.

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DatastoreCareRetentionPatch } from "@myrmidon/shared";
import { accessApi } from "@/api/access";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { queryKeys } from "@/lib/queryKeys";
import { formatBytes } from "@/lib/issue-output";
import { formatDateTime } from "@/lib/utils";
import {
  datastoreCareApi,
  datastoreCareQueryKey,
} from "@/api/myrmidonDatastoreCare";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import {
  Ui2DeniedState,
  Ui2ErrorState,
  Ui2SkeletonRows,
} from "../../../components/ui2StateViews";
import { Ui2Section } from "../../../components/ui2Primitives";

const DAYS_MIN = 0;
const DAYS_MAX = 3650;
const BATCHES_MIN = 1;
const BATCHES_MAX = 1000;

type RetentionSource = "settings" | "env" | "default";

function parseIntegerField(text: string, min: number, max: number): number | null {
  if (text.trim() === "") return null;
  const parsed = Number(text);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null;
  return parsed;
}

export function Ui2DatastoreRetentionSettings() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();

  const [daysText, setDaysText] = useState<string | null>(null);
  const [batchesText, setBatchesText] = useState<string | null>(null);
  const [externalDraft, setExternalDraft] = useState<boolean | undefined>(undefined);
  const [saveError, setSaveError] = useState<string | null>(null);

  const retentionQuery = useQuery({
    queryKey: datastoreCareQueryKey,
    queryFn: () => datastoreCareApi.get(),
    staleTime: 30_000,
  });

  // myrmidon(OPE-12613 review): the source of the "machine is copied
  // outside" mode. The retention endpoint does not echo a source for this
  // knob and it has no environment override, so the panel derives it from
  // the stored settings block (GET /instance/settings/general — readable by
  // any board member): stored true/false → "settings", absent → the
  // built-in default (false).
  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
    staleTime: 30_000,
  });
  const externalMachineBackupSource: RetentionSource = generalQuery.data?.datastoreCare
    ?.retention?.externalMachineBackup === undefined
    ? "default"
    : "settings";
  // The same gate the server applies (assertInstanceAdmin): an instance admin
  // or the local implicit actor may PATCH; everyone else gets read-only rows.
  const boardAccessQuery = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    staleTime: 30_000,
  });
  const canEdit =
    Boolean(boardAccessQuery.data?.isInstanceAdmin) ||
    boardAccessQuery.data?.source === "local_implicit";

  const retention = retentionQuery.data?.retention ?? null;
  const lastRun = retentionQuery.data?.lastRun ?? null;

  // The effective value: the draft override over the stored resolved value.
  const daysInvalid = daysText !== null && parseIntegerField(daysText, DAYS_MIN, DAYS_MAX) === null;
  const batchesInvalid =
    batchesText !== null && parseIntegerField(batchesText, BATCHES_MIN, BATCHES_MAX) === null;
  const effectiveDays = daysText !== null && !daysInvalid
    ? (parseIntegerField(daysText, DAYS_MIN, DAYS_MAX) as number)
    : (retention?.heartbeatRunContextDays ?? 0);
  const effectiveBatches = batchesText !== null && !batchesInvalid
    ? (parseIntegerField(batchesText, BATCHES_MIN, BATCHES_MAX) as number)
    : (retention?.contextCompactMaxBatches ?? 0);
  const effectiveExternal = externalDraft !== undefined ? externalDraft : (retention?.externalMachineBackup ?? false);

  /** One PATCH with only the fields that differ from the stored values. */
  function buildPatch(): DatastoreCareRetentionPatch | null {
    if (!retention) return null;
    const patch: DatastoreCareRetentionPatch = {};
    if (daysText !== null && !daysInvalid && parseIntegerField(daysText, DAYS_MIN, DAYS_MAX) !== retention.heartbeatRunContextDays) {
      patch.heartbeatRunContextDays = parseIntegerField(daysText, DAYS_MIN, DAYS_MAX) as number;
    }
    if (
      batchesText !== null &&
      !batchesInvalid &&
      parseIntegerField(batchesText, BATCHES_MIN, BATCHES_MAX) !== retention.contextCompactMaxBatches
    ) {
      patch.contextCompactMaxBatches = parseIntegerField(batchesText, BATCHES_MIN, BATCHES_MAX) as number;
    }
    if (externalDraft !== undefined && externalDraft !== retention.externalMachineBackup) {
      patch.externalMachineBackup = externalDraft;
    }
    return Object.keys(patch).length > 0 ? patch : null;
  }

  function clearDraft() {
    setDaysText(null);
    setBatchesText(null);
    setExternalDraft(undefined);
    setSaveError(null);
  }

  const saveMutation = useMutation({
    mutationFn: (patch: DatastoreCareRetentionPatch) => datastoreCareApi.update(patch),
    onSuccess: () => {
      clearDraft();
      // The PATCH may have created or cleared the stored retention block,
      // which is also what the derived backup-gate source reads — refetch
      // both views so the source pills follow the save immediately.
      void queryClient.invalidateQueries({ queryKey: datastoreCareQueryKey });
      void queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setSaveError(error instanceof Error ? error.message : String(error));
    },
  });

  if (retentionQuery.isLoading) {
    return (
      <Ui2Section title={t("ui2.settings.system.retention.title")}>
        <Ui2SkeletonRows rows={4} dense />
      </Ui2Section>
    );
  }

  const denied =
    retentionQuery.isError && (retentionQuery.error as { status?: number } | null)?.status === 403;

  if (retentionQuery.isError || !retention) {
    return (
      <Ui2Section title={t("ui2.settings.system.retention.title")}>
        {denied ? (
          <Ui2DeniedState
            message={t("ui2.settings.system.retention.denied")}
            hint={t("ui2.settings.system.retention.deniedHint")}
          />
        ) : (
          <Ui2ErrorState
            message={t("ui2.common.error")}
            detail={retentionQuery.error instanceof Error ? retentionQuery.error.message : null}
            retryLabel={t("ui2.common.retry")}
            onRetry={() => void retentionQuery.refetch()}
          />
        )}
      </Ui2Section>
    );
  }

  const pending = saveMutation.isPending;
  const patch = buildPatch();

  const sourceLabel = (source: RetentionSource) =>
    source === "settings"
      ? t("ui2.settings.system.retention.sourceSettings")
      : source === "env"
        ? t("ui2.settings.system.retention.sourceEnv")
        : t("ui2.settings.system.retention.sourceDefault");

  const sourcePill = (source: RetentionSource) => (
    <span className="ui2-retention-source text-xs text-muted-foreground" data-retention-source={source}>
      {t("ui2.settings.system.retention.source")}: {sourceLabel(source)}
    </span>
  );

  return (
    <Ui2Section
      title={t("ui2.settings.system.retention.title")}
      footer={t("ui2.settings.system.retention.subtitle")}
    >
      <div className="ui2-retention-fields flex flex-col gap-3">
        <label className="ui2-retention-field flex flex-col gap-1">
          <span className="ui2-retention-field-name text-sm">{t("ui2.settings.system.retention.days")}</span>
          <span className="ui2-retention-hint text-xs text-muted-foreground">
            {t("ui2.settings.system.retention.daysHint")}
          </span>
          <span className="flex items-center gap-3">
            <input
              id="ui2-retention-days"
              type="number"
              min={DAYS_MIN}
              max={DAYS_MAX}
              step={1}
              className="ui2-retention-days w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
              value={daysText ?? String(retention.heartbeatRunContextDays)}
              disabled={!canEdit}
              onChange={(event) => setDaysText(event.target.value)}
            />
            {sourcePill(retention.source)}
          </span>
          {/* myrmidon(OPE-12613): saving 0 never happens without this warning
              on screen — it renders while the effective value is 0. */}
          {effectiveDays === 0 ? (
            <span role="alert" className="ui2-retention-days-warning text-xs text-amber-600">
              {t("ui2.settings.system.retention.daysOffWarning")}
            </span>
          ) : null}
        </label>

        <label className="ui2-retention-field flex flex-col gap-1">
          <span className="ui2-retention-field-name text-sm">{t("ui2.settings.system.retention.batches")}</span>
          <span className="ui2-retention-hint text-xs text-muted-foreground">
            {t("ui2.settings.system.retention.batchesHint")}
          </span>
          <span className="flex items-center gap-3">
            <input
              id="ui2-retention-batches"
              type="number"
              min={BATCHES_MIN}
              max={BATCHES_MAX}
              step={1}
              className="ui2-retention-batches w-32 rounded-md border border-input bg-background px-2 py-1 text-right font-mono text-sm tabular-nums"
              value={batchesText ?? String(retention.contextCompactMaxBatches)}
              disabled={!canEdit}
              onChange={(event) => setBatchesText(event.target.value)}
            />
            {sourcePill(retention.contextCompactMaxBatchesSource)}
          </span>
        </label>

        <label className="ui2-retention-field flex flex-col gap-1">
          <span className="ui2-retention-field-name text-sm">{t("ui2.settings.system.retention.externalBackup")}</span>
          <span className="ui2-retention-hint text-xs text-muted-foreground">
            {t("ui2.settings.system.retention.externalBackupHint")}
          </span>
          <span className="flex items-center gap-3">
            <input
              id="ui2-retention-external"
              type="checkbox"
              className="ui2-retention-external-input h-4 w-4 accent-primary"
              checked={effectiveExternal}
              disabled={!canEdit}
              onChange={(event) => setExternalDraft(event.target.checked)}
            />
            {sourcePill(externalMachineBackupSource)}
          </span>
        </label>
      </div>

      <div className="ui2-retention-lastrun flex flex-col gap-1 rounded-md border border-border p-3">
        <span className="ui2-retention-lastrun-title text-sm font-medium">
          {t("ui2.settings.system.retention.lastRun")}
        </span>
        {lastRun === null || lastRun.lastRunAt === null ? (
          <span className="ui2-retention-lastrun-empty text-xs text-muted-foreground">
            {t("ui2.settings.system.retention.lastRunNever")}
          </span>
        ) : (
          <div className="ui2-retention-lastrun-facts flex flex-col gap-0.5 text-xs text-muted-foreground">
            <span className="ui2-retention-lastrun-at">
              {t("ui2.settings.system.retention.lastRunAt")}: {formatDateTime(lastRun.lastRunAt)}
            </span>
            <span className="ui2-retention-lastrun-compacted">
              {t("ui2.settings.system.retention.lastRunCompacted")}: {lastRun.lastCompacted}
            </span>
            <span className="ui2-retention-lastrun-freed">
              {t("ui2.settings.system.retention.lastRunFreed")}: {formatBytes(lastRun.lastFreedBytes)}
            </span>
            {lastRun.waitingForBackup ? (
              <span role="alert" className="ui2-retention-lastrun-waiting text-amber-600">
                {t("ui2.settings.system.retention.lastRunWaiting")}
              </span>
            ) : null}
          </div>
        )}
      </div>

      {canEdit ? (
        <div className="ui2-retention-actions flex items-center gap-3">
          <button
            type="button"
            className="ui2-retention-save rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
            disabled={patch === null || pending || daysInvalid || batchesInvalid}
            onClick={() => {
              if (patch !== null) saveMutation.mutate(patch);
            }}
          >
            {pending ? t("ui2.settings.system.retention.saving") : t("ui2.common.save")}
          </button>
          <button
            type="button"
            className="ui2-retention-reset rounded-md border border-border px-4 py-2 text-sm disabled:opacity-50"
            disabled={pending}
            onClick={() =>
              // Reset = explicit nulls: the endpoint clears the stored fields
              // and resolution falls back to env, then the default.
              saveMutation.mutate({
                heartbeatRunContextDays: null,
                contextCompactMaxBatches: null,
                externalMachineBackup: null,
              })
            }
          >
            {t("ui2.settings.system.retention.reset")}
          </button>
        </div>
      ) : (
        <p className="ui2-retention-readonly-note text-xs text-muted-foreground">
          {t("ui2.settings.system.retention.adminOnly")}
        </p>
      )}

      {saveError ? (
        <p role="alert" className="ui2-retention-save-error text-sm text-destructive">
          {t("ui2.settings.system.retention.saveFailed")}: {saveError}
        </p>
      ) : null}
    </Ui2Section>
  );
}
