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
  label: string;
  table: DataRetentionTableGroup;
}> = [
  { key: "heartbeatRunsDays", label: "Run history", table: "runs" },
  { key: "activityLogDays", label: "Activity log", table: "activity" },
  { key: "accessAuditDays", label: "Access audit logs", table: "access" },
];

const INVALID_DAYS = "Enter a whole number of days (0 or more)";

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
  if (!value) return "never";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function DataRetentionSettingsPanel() {
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
    onError: () => setSaveError("Could not save the retention windows. Try again."),
  });

  const submit = () => {
    if (!drafts) return;
    const parsed: Partial<DataRetentionSettings> = {};
    const nextErrors: Partial<Record<keyof DataRetentionSettings, string>> = {};
    for (const field of FIELDS) {
      const value = parseDays(drafts[field.key]);
      if (value === null) nextErrors[field.key] = INVALID_DAYS;
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
        <h3 className="text-sm font-medium">Data retention</h3>
      </div>

      <p className="text-xs text-muted-foreground">
        How long the grown tables keep their rows. The cleanup sweep re-reads
        these windows on every run, so a saved value applies without a restart.
        <code className="ml-1">0</code> keeps the rows forever.
      </p>

      <div className="space-y-3">
        {FIELDS.map((field) => (
          <div key={field.key} className="space-y-1">
            <Label htmlFor={`data-retention-${field.key}`}>{field.label}, days</Label>
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
                <span className="text-xs text-muted-foreground">Default</span>
              )}
            </div>
            {errors[field.key] && (
              <p className="text-xs text-red-600" data-testid={`data-retention-${field.key}-error`}>
                {errors[field.key]}
              </p>
            )}
          </div>
        ))}

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={submit}
            disabled={save.isPending || drafts === null}
            data-testid="data-retention-save"
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
          {saveError && <p className="text-xs text-red-600">{saveError}</p>}
          {save.isSuccess && !saveError && <p className="text-xs text-green-600">Saved</p>}
        </div>
      </div>

      {status && (
        <div className="space-y-2 text-sm" data-testid="data-retention-status">
          <div className="space-y-1">
            <p>
              <span className="font-medium">Last cleanup:</span> {formatTimestamp(status.lastRunAt)}
            </p>
            {status.backupCheckedAt && (
              <p className="text-muted-foreground">
                Last backup check: {formatTimestamp(status.backupCheckedAt)}
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
              Cleanup is waiting for a fresh backup — it starts once a backup
              younger than 24 hours exists.
            </p>
          )}

          <div>
            <p className="font-medium">Rows deleted and space freed</p>
            <ul className="list-disc pl-4 text-muted-foreground">
              {FIELDS.map((field) => {
                const table = status.perTable[field.table];
                return (
                  <li key={field.table}>
                    {field.label} — {table.deletedTotal} rows deleted in total,{" "}
                    {table.lastDeleted} in the last sweep, {formatBytes(table.lastFreedBytes)}{" "}
                    freed
                  </li>
                );
              })}
            </ul>
            <p className="text-muted-foreground">
              Total freed: {formatBytes(status.freedBytesTotal)}
            </p>
          </div>
        </div>
      )}
    </section>
  );
}

export type { DataRetentionSettings, DataRetentionView };