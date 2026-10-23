// Workspace hygiene quotas (myrmidon WORKSPACE-HYGIENE part C, SETTINGS-UI A):
// the "Workspace hygiene" section of Instance → General. The per-workspace and
// per-company-total disk ceilings (MB) that stop the work volume filling
// silently; saving writes `instance_settings.general.workspaceHygiene` and the
// sweep re-reads the row at the top of every tick, so a change applies without
// a restart. An empty field means "the cap is off" — the built-in default.
// The section also reports what the sweep last measured: the biggest workspaces
// and how many sit over the quota in force.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HardDrive } from "lucide-react";
import type { WorkspaceHygieneLimitsPatch } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import {
  describeWorkspaceHygieneSource,
  workspaceHygieneSettingsApi,
  workspaceHygieneSettingsQueryKey,
  type WorkspaceHygieneSettingsView,
} from "./workspaceHygieneSettingsApi";

// myrmidon(OPE-8950): visible strings live in area.settings-bots-host-2.workspace-hygiene-settings-panel.*
type Translate = (key: string, options?: Record<string, unknown>) => string;

interface DraftParse {
  patch: WorkspaceHygieneLimitsPatch | null;
  errors: Partial<Record<string, string>>;
}

/**
 * Parse the two quota drafts. An empty field is "the cap is off" (null);
 * anything else must be a whole positive number of megabytes.
 */
export function parseWorkspaceHygieneDraft(draft: {
  workspaceQuotaMb: string;
  totalQuotaMb: string;
}): Pick<DraftParse, "patch" | "errors"> {
  const errors: Partial<Record<string, string>> = {};

  const parseQuota = (raw: string): number | null | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value <= 0) return undefined;
    return value;
  };

  const workspaceQuotaMb = parseQuota(draft.workspaceQuotaMb);
  if (workspaceQuotaMb === undefined) {
    errors.workspaceQuotaMb = i18n.t("area.settings-bots-host-2.workspace-hygiene-settings-panel.quotaInvalid");
  }
  const totalQuotaMb = parseQuota(draft.totalQuotaMb);
  if (totalQuotaMb === undefined) {
    errors.totalQuotaMb = i18n.t("area.settings-bots-host-2.workspace-hygiene-settings-panel.quotaInvalid");
  }

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return { patch: { workspaceQuotaMb, totalQuotaMb }, errors };
}

function toDraft(quota: WorkspaceHygieneSettingsView["quota"]) {
  return {
    workspaceQuotaMb: quota.workspaceQuotaMb === null ? "" : String(quota.workspaceQuotaMb),
    totalQuotaMb: quota.totalQuotaMb === null ? "" : String(quota.totalQuotaMb),
  };
}

const QUOTA_FIELD_HINT_KEYS = {
  workspaceQuotaMb: "area.settings-bots-host-2.workspace-hygiene-settings-panel.workspaceQuotaHint",
  totalQuotaMb: "area.settings-bots-host-2.workspace-hygiene-settings-panel.totalQuotaHint",
} as const;

export function WorkspaceHygieneSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: WorkspaceHygieneSettingsView | null | undefined;
  onSave: (patch: WorkspaceHygieneLimitsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation() as { t: Translate };
  const [draft, setDraft] = useState<ReturnType<typeof toDraft> | null>(null);

  const numbers = draft ?? (view ? toDraft(view.quota) : null);
  const { patch, errors } = numbers
    ? parseWorkspaceHygieneDraft(numbers)
    : { patch: null, errors: {} as Partial<Record<string, string>> };
  const canSave = patch !== null && view !== null && view !== undefined;

  const source = (key: "workspaceQuotaMb" | "totalQuotaMb") =>
    view ? describeWorkspaceHygieneSource(view.quota.sources[key]) : "";

  return (
    <section className="space-y-4" data-testid="myrmidon-workspace-hygiene-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <HardDrive className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-bots-host-2.workspace-hygiene-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          {(["workspaceQuotaMb", "totalQuotaMb"] as const).map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`workspace-hygiene-${key}`}>
                {key === "workspaceQuotaMb"
                  ? t("area.settings-bots-host-2.workspace-hygiene-settings-panel.workspaceQuotaLabel")
                  : t("area.settings-bots-host-2.workspace-hygiene-settings-panel.totalQuotaLabel")}
              </Label>
              <Input
                id={`workspace-hygiene-${key}`}
                inputMode="numeric"
                placeholder={t("area.settings-bots-host-2.workspace-hygiene-settings-panel.noCap")}
                value={numbers ? numbers[key] : ""}
                onChange={(event) =>
                  setDraft({ ...(numbers ?? toDraft(view.quota)), [key]: event.target.value })
                }
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`workspace-hygiene-source-${key}`}>{source(key)}</span>
                {errors[key] ? (
                  <span
                    data-testid={`workspace-hygiene-error-${key}`}
                    className="ml-2 text-destructive"
                  >
                    {errors[key]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{t(QUOTA_FIELD_HINT_KEYS[key])}</p>
            </div>
          ))}

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || !canSave}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? t("area.settings-bots-host-2.workspace-hygiene-settings-panel.saving") : t("area.settings-bots-host-2.workspace-hygiene-settings-panel.saveButton")}
            </Button>
          </div>

          <div
            className="space-y-1 md:col-span-2 text-sm text-muted-foreground"
            data-testid="workspace-hygiene-status"
          >
            <p>
              {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.measured")}{" "}
              <span data-testid="workspace-hygiene-measured" className="font-mono">
                {view.status.measuredWorkspaces}
              </span>
              {" — "}
              {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.overQuotaCount")}{" "}
              <span data-testid="workspace-hygiene-over-quota" className="font-mono">
                {view.status.overQuotaCount}
              </span>
              {" — "}
              {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.totalSize")}{" "}
              <span data-testid="workspace-hygiene-total-mb" className="font-mono">
                {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.sizeMb", { size: view.status.totalSizeMb })}
              </span>
              {" — "}
              {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.lastSweep")}{" "}
              <span data-testid="workspace-hygiene-last-sweep" className="font-mono">
                {view.status.lastSweepAt ? new Date(view.status.lastSweepAt).toLocaleString() : t("area.settings-bots-host-2.workspace-hygiene-settings-panel.lastSweepNever")}
              </span>
            </p>
          </div>

          {view.workspaces.length > 0 ? (
            <div className="md:col-span-2 space-y-1" data-testid="workspace-hygiene-workspaces">
              <h3 className="text-sm font-medium">{t("area.settings-bots-host-2.workspace-hygiene-settings-panel.largest")}</h3>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {view.workspaces.slice(0, 10).map((row) => (
                  <li key={row.id} data-testid="workspace-hygiene-workspace-row">
                    <span className="font-mono">{t("area.settings-bots-host-2.workspace-hygiene-settings-panel.sizeMb", { size: row.sizeMb })}</span>
                    {" — "}
                    {row.name}
                    <span className="font-mono"> ({row.status})</span>
                    {row.overQuota ? (
                      <span data-testid="workspace-hygiene-workspace-over" className="ml-2 text-destructive">
                        {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.overQuota")}
                      </span>
                    ) : null}
                    {row.truncated ? <span className="ml-2">{t("area.settings-bots-host-2.workspace-hygiene-settings-panel.lowerBound")}</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground md:col-span-2">
              {t("area.settings-bots-host-2.workspace-hygiene-settings-panel.nothingMeasured")}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-bots-host-2.workspace-hygiene-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function WorkspaceHygieneSettingsPanel() {
  const { t } = useTranslation() as { t: Translate };
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: workspaceHygieneSettingsQueryKey,
    queryFn: () => workspaceHygieneSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: workspaceHygieneSettingsApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : i18n.t("area.settings-bots-host-2.workspace-hygiene-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: workspaceHygieneSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : t("area.settings-bots-host-2.workspace-hygiene-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <WorkspaceHygieneSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
