// Model fallback signal (myrmidon BOT-RUNTIME-TUNING D2, SETTINGS-UI A): the
// "Model fallback signal" section of Instance → General. When an agent keeps
// landing on a fallback model the sweep signals it; here an instance admin
// arms the signal and tunes its numbers. Saving writes
// `instance_settings.general.modelFallbackSignal` and the sweep re-reads the
// row on its next tick, so the change applies without a restart. Each field
// shows where the value in force came from (saved here, environment override,
// default) — an `MYRMIDON_MODEL_FALLBACK_*` variable stays a forced override
// above the saved value.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import {
  MAX_FALLBACK_SIGNAL_INTERVAL_SEC,
  MAX_FALLBACK_SIGNAL_THRESHOLD_PCT,
  MIN_FALLBACK_SIGNAL_INTERVAL_SEC,
  MIN_FALLBACK_SIGNAL_MIN_CALLS,
  MIN_FALLBACK_SIGNAL_THRESHOLD_PCT,
  MIN_FALLBACK_SIGNAL_WINDOW_SEC,
  MAX_FALLBACK_SIGNAL_WINDOW_SEC,
  type FallbackSignalSettingKey,
  type FallbackSignalSettingsPatch,
} from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { i18n, useTranslation } from "@/i18n";
import {
  describeFallbackSignalSource,
  modelFallbackSignalSettingsApi,
  modelFallbackSignalSettingsQueryKey,
  type ResolvedFallbackSignalSettingsView,
} from "./modelFallbackSignalSettingsApi";

type NumericKey = Exclude<FallbackSignalSettingKey, "enabled">;

const NUMERIC_KEYS: NumericKey[] = ["thresholdPct", "minCalls", "windowSec", "intervalSec"];

const BOUNDS: Record<NumericKey, { min: number; max: number | null }> = {
  thresholdPct: { min: MIN_FALLBACK_SIGNAL_THRESHOLD_PCT, max: MAX_FALLBACK_SIGNAL_THRESHOLD_PCT },
  minCalls: { min: MIN_FALLBACK_SIGNAL_MIN_CALLS, max: null },
  windowSec: { min: MIN_FALLBACK_SIGNAL_WINDOW_SEC, max: MAX_FALLBACK_SIGNAL_WINDOW_SEC },
  intervalSec: { min: MIN_FALLBACK_SIGNAL_INTERVAL_SEC, max: MAX_FALLBACK_SIGNAL_INTERVAL_SEC },
};

// Functions, not module constants: the texts follow the interface language.
const getLabels = (): Record<FallbackSignalSettingKey, string> => ({
  enabled: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.labels.enabled"),
  thresholdPct: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.labels.thresholdPct"),
  minCalls: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.labels.minCalls"),
  windowSec: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.labels.windowSec"),
  intervalSec: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.labels.intervalSec"),
});

const getHints = (): Record<FallbackSignalSettingKey, string> => ({
  enabled: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.hints.enabled"),
  thresholdPct: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.hints.thresholdPct"),
  minCalls: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.hints.minCalls"),
  windowSec: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.hints.windowSec"),
  intervalSec: i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.hints.intervalSec"),
});

interface DraftParse {
  patch: FallbackSignalSettingsPatch | null;
  errors: Partial<Record<string, string>>;
}

/**
 * Parse the draft: the switch is always carried; an empty numeric field keeps
 * the value in force (the PATCH is a partial patch). Anything else must be a
 * whole number inside the shared bounds — the same window the server validates.
 */
export function parseFallbackSignalDraft(draft: {
  enabled: boolean;
  thresholdPct: string;
  minCalls: string;
  windowSec: string;
  intervalSec: string;
}): DraftParse {
  const errors: Partial<Record<string, string>> = {};
  const patch: FallbackSignalSettingsPatch = { enabled: draft.enabled };

  for (const key of NUMERIC_KEYS) {
    const trimmed = draft[key].trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    const { min, max } = BOUNDS[key];
    if (!Number.isSafeInteger(value) || value < min || (max !== null && value > max)) {
      errors[key] =
        max === null
          ? i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.errors.minOnly", { min })
          : i18n.t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.errors.range", { min, max });
      continue;
    }
    patch[key] = value;
  }

  return { patch: Object.keys(errors).length > 0 ? null : patch, errors };
}

function toDraft(settings: ResolvedFallbackSignalSettingsView["settings"]) {
  return {
    enabled: settings.enabled,
    thresholdPct: String(settings.thresholdPct),
    minCalls: String(settings.minCalls),
    windowSec: String(settings.windowSec),
    intervalSec: String(settings.intervalSec),
  };
}

export function ModelFallbackSignalSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ResolvedFallbackSignalSettingsView | null | undefined;
  onSave: (patch: FallbackSignalSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const LABELS = getLabels();
  const HINTS = getHints();
  const [draft, setDraft] = useState<ReturnType<typeof toDraft> | null>(null);

  const fields = draft ?? (view ? toDraft(view.settings) : null);
  const parsed = fields ? parseFallbackSignalDraft(fields) : null;

  return (
    <section className="space-y-4" data-testid="myrmidon-model-fallback-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view && fields && parsed ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="flex items-center justify-between gap-4 md:col-span-2">
            <div className="space-y-1">
              <Label htmlFor="model-fallback-enabled">{LABELS.enabled}</Label>
              <p className="text-xs text-muted-foreground">
                <span data-testid="model-fallback-source-enabled">
                  {describeFallbackSignalSource(view.sources.enabled)}
                </span>
              </p>
              <p className="text-xs text-muted-foreground">{HINTS.enabled}</p>
            </div>
            <ToggleSwitch
              id="model-fallback-enabled"
              checked={fields.enabled}
              onCheckedChange={(enabled) => setDraft({ ...fields, enabled })}
              data-testid="model-fallback-enabled-toggle"
            />
          </div>

          {NUMERIC_KEYS.map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`model-fallback-${key}`}>{LABELS[key]}</Label>
              <Input
                id={`model-fallback-${key}`}
                inputMode="numeric"
                value={fields[key]}
                onChange={(event) => setDraft({ ...fields, [key]: event.target.value })}
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`model-fallback-source-${key}`}>
                  {describeFallbackSignalSource(view.sources[key])}
                </span>
                {parsed.errors[key] ? (
                  <span data-testid={`model-fallback-error-${key}`} className="ml-2 text-destructive">
                    {parsed.errors[key]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{HINTS[key]}</p>
            </div>
          ))}

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || parsed.patch === null}
              onClick={() => {
                if (parsed.patch) onSave(parsed.patch);
              }}
            >
              {pending ? t("area.settings-models-runtime-1.shared.saving") : t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.saveButton")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function ModelFallbackSignalSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: modelFallbackSignalSettingsQueryKey,
    queryFn: () => modelFallbackSignalSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: modelFallbackSignalSettingsApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(
        err instanceof Error ? err.message : t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.saveFailed"),
      ),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: modelFallbackSignalSettingsQueryKey,
      });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error
          ? query.error.message
          : t("area.settings-models-runtime-1.model-fallback-signal-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <ModelFallbackSignalSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
