// Data retention (myrmidon 1.6.5-DB-RETENTION): the retention windows of the
// three grown tables — heartbeat runs, the activity log and the access audit
// log — editable while the server runs, plus the readout of the last cleanup
// sweep. Saving applies at once: the sweep re-reads the windows on every run,
// no restart.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Database } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Trans } from "react-i18next";
import { i18n, useTranslation } from "@/i18n";
import {
  dataRetentionApi,
  dataRetentionQueryKey,
  type DataRetentionSettings,
  type DataRetentionTableGroup,
  type DataRetentionView,
} from "./dataRetentionApi";

/** myrmidon(1.6.5-DB-RETENTION): the three windows the panel edits, in the
 *  order they appear, with the label of the table group each one covers. */
const FIELDS: ReadonlyArray<{
  key: keyof DataRetentionSettings;
  label: () => string;
  table: DataRetentionTableGroup;
}> = [
  { key: "heartbeatRunsDays", label: () => i18n.t("area.settings-bots-host-1.data-retention-settings-panel.fieldRuns"), table: "runs" },
  { key: "activityLogDays", label: () => i18n.t("area.settings-bots-host-1.data-retention-settings-panel.fieldActivity"), table: "activity" },
  { key: "accessAuditDays", label: () => i18n.t("area.settings-bots-host-1.data-retention-settings-panel.fieldAccess"), table: "access" },
];

/** A whole number of days, or null when the draft is not one. `0` is valid and
 *  means "keep forever". */
function parseDays(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}

type Drafts = Record<keyof DataRetentionSettings, string>;

function draftsFrom(settings: DataRetentionSettings): Drafts {
  return {
    heartbeatRunsDays: String(settings.heartbeatRunsDays),
    activityLogDays: String(settings.activityLogDays),
    accessAuditDays: String(settings.accessAuditDays),
  };
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${units[unit]}`;
}

function formatTimestamp(value: string | null): string {
  if (!value) return i18n.t("area.settings-bots-host-1.data-retention-settings-panel.never");
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function DataRetentionSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: view, isError } = useQuery({
    queryKey: dataRetentionQueryKey,
    queryFn: dataRetentionApi.get,
  });
  const [drafts, setDrafts] = useState<Drafts | null>(null);
  const [errors, setErrors] = useState<Partial<Record<keyof DataRetentionSettings, string>>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (view && drafts === null) setDrafts(draftsFrom(view.settings));
  }, [view, drafts]);

  const save = useMutation({
    mutationFn: (patch: DataRetentionSettings) => dataRetentionApi.update(patch),
    onSuccess: (saved) => {
      setErrors({});
      setSaveError(null);
      if (saved) setDrafts(draftsFrom(saved.settings));
      queryClient.invalidateQueries({ queryKey: dataRetentionQueryKey });
    },
    onError: () => setSaveError(t("area.settings-bots-host-1.data-retention-settings-panel.saveWindowsFailed")),
  });

  // myrmidon(1.6.5-F14B): the backup-gate mode saves on its own, at once; it
  // touches no window, so the drafts of the day fields stay as typed.
  const saveMode = useMutation({
    mutationFn: (externalMachineBackup: boolean) =>
      dataRetentionApi.update({ externalMachineBackup }),
    onSuccess: () => {
      setSaveError(null);
      queryClient.invalidateQueries({ queryKey: dataRetentionQueryKey });
    },
    onError: () => setSaveError(t("area.settings-bots-host-1.data-retention-settings-panel.saveModeFailed")),
  });

  const submit = () => {
    if (!drafts) return;
    const parsed: Partial<DataRetentionSettings> = {};
    const nextErrors: Partial<Record<keyof DataRetentionSettings, string>> = {};
    for (const field of FIELDS) {
      const value = parseDays(drafts[field.key]);
      if (value === null) nextErrors[field.key] = t("area.settings-bots-host-1.data-retention-settings-panel.invalidDays");
      else parsed[field.key] = value;
    }
    setErrors(nextErrors);
    // A draft that is not a whole number of days never reaches the API.
    if (Object.keys(nextErrors).length > 0) return;
    setSaveError(null);
    save.mutate(parsed as DataRetentionSettings);
  };

  // myrmidon(1.6.5-DB-RETENTION): the panel belongs to instances that serve the
  // data retention route. Until the view arrives — and on an instance that does
  // not serve that route yet — the section renders nothing, so the settings page
  // never shows an empty block of dead inputs.
  if (isError || !view) return null;

  const status = view.status;
  const sources = view.sources;

  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="data-retention-panel">
      <div className="flex items-center gap-2">
        <Database className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium">{t("area.settings-bots-host-1.data-retention-settings-panel.title")}</h3>
      </div>

      <p className="text-xs text-muted-foreground">
        <Trans i18nKey="area.settings-bots-host-1.data-retention-settings-panel.intro" components={[<code key="zero" className="ml-1" />]} />
      </p>

      <div className="space-y-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`data-retention-${field.key}`}>{t("area.settings-bots-host-1.data-retention-settings-panel.fieldDays", { label: field.label() })}</Label>
            <div className="flex items-center gap-2">
              <Input
                id={`data-retention-${field.key}`}
                inputMode="numeric"
                className="w-24"
                value={drafts?.[field.key] ?? ""}
                disabled={drafts === null}
                onChange={(event) => {
                  setDrafts((current) =>
                    current === null ? current : { ...current, [field.key]: event.target.value },
                  );
                  // Editing a field clears its inline error; the key is dropped,
                  // not set to undefined, so the submit stays live.
                  setErrors((current) => {
                    if (current[field.key] === undefined) return current;
                    const next = { ...current };
                    delete next[field.key];
                    return next;
                  });
                  setSaveError(null);
                }}
                data-testid={`data-retention-${field.key}-input`}
              />
              {sources[field.key] !== "settings" && (
                <span className="text-xs text-muted-foreground">{t("area.settings-bots-host-1.data-retention-settings-panel.default")}</span>
              )}
            </div>
            {errors[field.key] && (
              <p className="text-xs text-red-600" data-testid={`data-retention-${field.key}-error`}>
                {errors[field.key]}
              </p>
            )}
          </div>
        ))}

        {/* myrmidon(1.6.5-F14B): without a local dump the gate would wait
            forever; this mode tells it the whole machine is backed up on
            another host. It applies to both cleanups: the run-context
            compaction and the deletion of old rows. */}
        <div className="space-y-1">
          <label className="flex items-center gap-2 text-sm" htmlFor="data-retention-external-backup">
            <input
              id="data-retention-external-backup"
              type="checkbox"
              checked={view.externalMachineBackup === true}
              disabled={saveMode.isPending}
              onChange={(event) => saveMode.mutate(event.target.checked)}
              data-testid="data-retention-external-backup"
            />
            {t("area.settings-bots-host-1.data-retention-settings-panel.externalBackup")}
          </label>
          <p className="text-xs text-muted-foreground">
            {t("area.settings-bots-host-1.data-retention-settings-panel.externalBackupHelp")}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={submit}
            disabled={save.isPending || drafts === null}
            data-testid="data-retention-save"
          >
            {save.isPending ? t("area.settings-bots-host-1.data-retention-settings-panel.saving") : t("common.save")}
          </Button>
          {saveError && <p className="text-xs text-red-600">{saveError}</p>}
          {save.isSuccess && !saveError && <p className="text-xs text-green-600">{t("area.settings-bots-host-1.data-retention-settings-panel.saved")}</p>}
        </div>
      </div>

      {status && (
        <div className="space-y-2 text-sm" data-testid="data-retention-status">
          <div className="space-y-1">
            <p>
              <span className="font-medium">{t("area.settings-bots-host-1.data-retention-settings-panel.lastCleanup")}</span> {formatTimestamp(status.lastRunAt)}
            </p>
            {status.backupCheckedAt && (
              <p className="text-muted-foreground">
                {t("area.settings-bots-host-1.data-retention-settings-panel.lastBackupCheck", { when: formatTimestamp(status.backupCheckedAt) })}
              </p>
            )}
          </div>

          {/* myrmidon(1.6.5-DB-RETENTION): the sweep deletes nothing until a
              backup younger than 24 hours exists. */}
          {status.waitingForBackup && (
            <p
              className="rounded bg-orange-500/15 px-2 py-1 text-xs font-medium text-orange-600"
              data-testid="data-retention-waiting-backup"
            >
              {t("area.settings-bots-host-1.data-retention-settings-panel.waitingBackup")}
            </p>
          )}

          <div>
            <p className="font-medium">{t("area.settings-bots-host-1.data-retention-settings-panel.deletedHeading")}</p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {FIELDS.map((field) => {
                const table = status.perTable[field.table];
                return (
                  <li key={field.table}>
                    {t("area.settings-bots-host-1.data-retention-settings-panel.tableLine", { label: field.label(), count: table.deletedTotal, last: table.lastDeleted, freed: formatBytes(table.lastFreedBytes) })}
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground">
              {t("area.settings-bots-host-1.data-retention-settings-panel.totalFreed", { size: formatBytes(status.freedBytesTotal) })}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export type { DataRetentionSettings, DataRetentionView };