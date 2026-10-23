// Team liveness settings (myrmidon TEAM-LIVENESS-SETTINGS): the knobs of the
// three automatic behaviours, editable while the server runs.
//
// Saving writes only the keys the operator actually changed. A field nobody
// touched keeps resolving from the server environment or the default, so
// removing an environment variable later still takes effect — the panel never
// freezes an environment value into the settings row. Each field shows which
// layer its current value comes from.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import type {
  TeamLivenessBooleanKey,
  TeamLivenessNumberKey,
  TeamLivenessSettings,
  TeamLivenessSettingsPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import {
  describeTeamLivenessSource,
  teamLivenessApi,
  teamLivenessQueryKey,
  type TeamLivenessView,
} from "./teamLivenessApi";

/** Labels are resolved at call time, not at import, so a language switch applies. */
const switches = (): Array<{ key: TeamLivenessBooleanKey; label: string; hint: string }> => [
  {
    key: "autoResumeEnabled",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.autoResumeEnabled.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.autoResumeEnabled.hint"),
  },
  {
    key: "runStallEnabled",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.runStallEnabled.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.runStallEnabled.hint"),
  },
  {
    key: "idlePickupEnabled",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupEnabled.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupEnabled.hint"),
  },
];

const numbers = (): Array<{ key: TeamLivenessNumberKey; label: string; hint: string }> => [
  {
    key: "runStallThresholdSec",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.runStallThresholdSec.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.runStallThresholdSec.hint"),
  },
  {
    key: "idlePickupIntervalSec",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupIntervalSec.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupIntervalSec.hint"),
  },
  {
    key: "idlePickupWakeBudgetPerMin",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupWakeBudgetPerMin.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupWakeBudgetPerMin.hint"),
  },
  {
    key: "idlePickupWakeBatch",
    label: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupWakeBatch.label"),
    hint: i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.idlePickupWakeBatch.hint"),
  },
];

export interface TeamLivenessDraft {
  switches: Partial<Record<TeamLivenessBooleanKey, boolean>>;
  numbers: Partial<Record<TeamLivenessNumberKey, string>>;
}

export interface TeamLivenessDraftParse {
  patch: TeamLivenessSettingsPatch | null;
  errors: Partial<Record<TeamLivenessNumberKey, string>>;
}

/**
 * The patch a save sends: only the keys this draft touched. An empty draft is
 * a patch with nothing in it — the button is disabled in that case.
 */
export function parseTeamLivenessDraft(draft: TeamLivenessDraft): TeamLivenessDraftParse {
  const errors: Partial<Record<TeamLivenessNumberKey, string>> = {};
  const patch: TeamLivenessSettingsPatch = {};
  for (const { key } of switches()) {
    const value = draft.switches[key];
    if (value !== undefined) patch[key] = value;
  }
  for (const { key } of numbers()) {
    const raw = draft.numbers[key];
    if (raw === undefined) continue;
    const trimmed = raw.trim();
    const value = trimmed === "" ? Number.NaN : Number(trimmed);
    if (!Number.isInteger(value) || value <= 0) {
      errors[key] = i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.wholeNumberError");
      continue;
    }
    patch[key] = value;
  }
  return { patch: Object.keys(errors).length > 0 ? null : patch, errors };
}

function formatSeconds(value: number): string {
  return i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.seconds", { value });
}

export function TeamLivenessSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: TeamLivenessView | null | undefined;
  onSave: (patch: TeamLivenessSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TeamLivenessDraft>({ switches: {}, numbers: {} });
  const { patch, errors } = parseTeamLivenessDraft(draft);
  const dirty =
    Object.keys(draft.switches).length > 0 || Object.keys(draft.numbers).length > 0;

  const switchValue = (settings: TeamLivenessSettings, key: TeamLivenessBooleanKey): boolean =>
    draft.switches[key] ?? settings[key];
  const numberValue = (settings: TeamLivenessSettings, key: TeamLivenessNumberKey): string =>
    draft.numbers[key] ?? String(settings[key]);

  return (
    <section className="space-y-4" id="team-liveness-settings" data-testid="myrmidon-team-liveness">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.team-liveness-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-2.team-liveness-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-4">
          <div className="space-y-3">
            {switches().map(({ key, label, hint }) => (
              <label key={key} className="flex items-start gap-3" htmlFor={`team-liveness-${key}`}>
                <input
                  id={`team-liveness-${key}`}
                  type="checkbox"
                  className="mt-1 h-4 w-4"
                  checked={switchValue(view.settings, key)}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      switches: { ...previous.switches, [key]: event.target.checked },
                    }))
                  }
                />
                <span className="space-y-1">
                  <span className="block text-sm font-medium">{label}</span>
                  <span className="block text-xs text-muted-foreground">{hint}</span>
                  <span
                    className="block text-xs text-muted-foreground"
                    data-testid={`team-liveness-source-${key}`}
                  >
                    {describeTeamLivenessSource(view.sources[key])}
                  </span>
                </span>
              </label>
            ))}
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {numbers().map(({ key, label, hint }) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`team-liveness-${key}`}>{label}</Label>
                <Input
                  id={`team-liveness-${key}`}
                  inputMode="numeric"
                  value={numberValue(view.settings, key)}
                  onChange={(event) =>
                    setDraft((previous) => ({
                      ...previous,
                      numbers: { ...previous.numbers, [key]: event.target.value },
                    }))
                  }
                />
                <div className="text-xs text-muted-foreground">
                  <span data-testid={`team-liveness-source-${key}`}>
                    {describeTeamLivenessSource(view.sources[key])}
                  </span>
                  <span className="ml-2" data-testid={`team-liveness-current-${key}`}>
                    {t("area.settings-models-runtime-2.team-liveness-settings-panel.now", { value: formatSeconds(view.settings[key]) })}
                  </span>
                  {errors[key] ? (
                    <span data-testid={`team-liveness-error-${key}`} className="ml-2 text-destructive">
                      {errors[key]}
                    </span>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </div>
            ))}
          </div>

          <Button
            type="button"
            size="sm"
            data-testid="team-liveness-save"
            disabled={pending || patch === null || !dirty}
            onClick={() => {
              if (patch) onSave(patch);
            }}
          >
            {pending ? t("area.settings-models-runtime-2.team-liveness-settings-panel.saving") : t("area.settings-models-runtime-2.team-liveness-settings-panel.save")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-2.team-liveness-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function TeamLivenessSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: teamLivenessQueryKey,
    queryFn: () => teamLivenessApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: teamLivenessApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : i18n.t("area.settings-models-runtime-2.team-liveness-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: teamLivenessQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : t("area.settings-models-runtime-2.team-liveness-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <TeamLivenessSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}