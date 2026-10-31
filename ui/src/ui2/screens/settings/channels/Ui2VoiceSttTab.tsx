// ui/src/ui2/screens/settings/channels/Ui2VoiceSttTab.tsx
//
// myrmidon(UI2-CHANNELS): Voice STT tab in Settings → Channels (OPE-10136).
// Driven by existing GET/PATCH /myrmidon/companies/:companyId/voice-stt.
// Secret names only, values never sent or displayed.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/context/CompanyContext";
import {
  voiceSttApi,
  voiceSttQueryKey,
  VOICE_STT_BACKENDS,
  VOICE_STT_LANGUAGES,
  type VoiceSttSettings,
  type VoiceSttUpdateInput,
} from "@/components/myrmidon/voice-stt/voiceSttApi";
import { useUi2I18n } from "../../../i18n/Ui2I18n";
import { Ui2Section } from "../../../components/ui2Primitives";
import { Ui2ErrorState, Ui2SkeletonRows } from "../../../components/ui2StateViews";

export interface Ui2VoiceSttFormState {
  enabled: boolean;
  backend: VoiceSttSettings["backend"];
  model: string;
  language: VoiceSttSettings["language"];
  diarization: boolean;
  maxDurationSec: string;
}

export function formFromSettings(settings: VoiceSttSettings): Ui2VoiceSttFormState {
  return {
    enabled: settings.enabled,
    backend: settings.backend,
    model: settings.model ?? "",
    language: settings.language,
    diarization: settings.diarization,
    maxDurationSec: String(settings.maxDurationSec),
  };
}

export function diffFromSettings(
  form: Ui2VoiceSttFormState,
  settings: VoiceSttSettings,
): VoiceSttUpdateInput {
  const diff: VoiceSttUpdateInput = {};
  if (form.enabled !== settings.enabled) diff.enabled = form.enabled;
  if (form.backend !== settings.backend) diff.backend = form.backend;
  if (form.language !== settings.language) diff.language = form.language;
  const trimmed = form.model.trim();
  if (trimmed !== (settings.model ?? "")) diff.model = trimmed || null;
  if (form.diarization !== settings.diarization) diff.diarization = form.diarization;
  const duration = Number.parseInt(form.maxDurationSec.trim(), 10);
  if (Number.isFinite(duration) && duration !== settings.maxDurationSec) {
    diff.maxDurationSec = duration;
  }
  return diff;
}

export function Ui2VoiceSttTab() {
  const { t } = useUi2I18n();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryKey = voiceSttQueryKey(companyId);

  const settingsQuery = useQuery({
    queryKey,
    queryFn: () => voiceSttApi.view(companyId),
    enabled: companyId.length > 0,
  });

  const [form, setForm] = useState<Ui2VoiceSttFormState | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (settingsQuery.data) {
      setForm(formFromSettings(settingsQuery.data));
    }
  }, [settingsQuery.data]);

  const updateMutation = useMutation({
    mutationFn: (diff: VoiceSttUpdateInput) => voiceSttApi.update(companyId, diff),
    onSuccess: (updated) => {
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey });
      setForm(formFromSettings(updated));
    },
    onError: (err: unknown) => {
      setSaveError(err instanceof Error ? err.message : t("ui2.settings.channels.voice.saveError"));
    },
  });

  if (settingsQuery.isLoading) {
    return (
      <div data-testid="ui2-voice-stt-loading" className="space-y-4">
        <Ui2SkeletonRows count={4} />
      </div>
    );
  }

  if (settingsQuery.isError || !settingsQuery.data) {
    return (
      <div data-testid="ui2-voice-stt-load-error">
        <Ui2ErrorState
          error={settingsQuery.error instanceof Error ? settingsQuery.error.message : t("ui2.settings.channels.voice.loadError")}
          onRetry={() => void settingsQuery.refetch()}
        />
      </div>
    );
  }

  const currentSettings = settingsQuery.data;
  const currentForm = form ?? formFromSettings(currentSettings);

  const diff = diffFromSettings(currentForm, currentSettings);
  const isDirty = Object.keys(diff).length > 0;
  const durationInt = Number.parseInt(currentForm.maxDurationSec.trim(), 10);
  const durationInvalid =
    !/^\d+$/.test(currentForm.maxDurationSec.trim()) || !Number.isFinite(durationInt) || durationInt < 1;

  const handleSave = () => {
    if (!isDirty || durationInvalid) return;
    setSaveError(null);
    updateMutation.mutate(diff);
  };

  return (
    <div className="ui2-voice-stt-tab max-w-3xl space-y-6" data-testid="ui2-voice-stt-tab">
      <Ui2Section
        title={t("ui2.settings.channels.voice.title")}
        subtitle={t("ui2.settings.channels.voice.subtitle")}
      >
        {saveError ? (
          <div
            className="mb-4 rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive"
            data-testid="ui2-voice-stt-error"
          >
            {saveError}
          </div>
        ) : null}

        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={currentForm.enabled}
              onChange={(e) => setForm({ ...currentForm, enabled: e.target.checked })}
              data-testid="ui2-voice-stt-enabled"
              className="h-4 w-4 rounded border-input"
            />
            <span>{t("ui2.settings.channels.voice.enabled")}</span>
          </label>
          <p className="text-xs text-muted-foreground">
            {t("ui2.settings.channels.voice.enabledDesc")}
          </p>

          <div className="space-y-1">
            <label htmlFor="ui2-voice-stt-backend" className="text-sm font-medium">
              {t("ui2.settings.channels.voice.backend")}
            </label>
            <select
              id="ui2-voice-stt-backend"
              value={currentForm.backend}
              onChange={(e) =>
                setForm({
                  ...currentForm,
                  backend: e.target.value as VoiceSttSettings["backend"],
                })
              }
              data-testid="ui2-voice-stt-backend"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {VOICE_STT_BACKENDS.map((backend) => (
                <option key={backend} value={backend}>
                  {backend}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("ui2.settings.channels.voice.backendDesc")}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="ui2-voice-stt-language" className="text-sm font-medium">
              {t("ui2.settings.channels.voice.language")}
            </label>
            <select
              id="ui2-voice-stt-language"
              value={currentForm.language}
              onChange={(e) =>
                setForm({
                  ...currentForm,
                  language: e.target.value as VoiceSttSettings["language"],
                })
              }
              data-testid="ui2-voice-stt-language"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            >
              {VOICE_STT_LANGUAGES.map((lang) => (
                <option key={lang} value={lang}>
                  {lang === "auto"
                    ? t("ui2.settings.channels.voice.languageAuto")
                    : t("ui2.settings.channels.voice.languageRu")}
                </option>
              ))}
            </select>
            <p className="text-xs text-muted-foreground">
              {t("ui2.settings.channels.voice.languageDesc")}
            </p>
          </div>

          <div className="space-y-1">
            <label htmlFor="ui2-voice-stt-model" className="text-sm font-medium">
              {t("ui2.settings.channels.voice.model")}
            </label>
            <input
              id="ui2-voice-stt-model"
              type="text"
              value={currentForm.model}
              placeholder={t("ui2.settings.channels.voice.modelPlaceholder")}
              onChange={(e) => setForm({ ...currentForm, model: e.target.value })}
              data-testid="ui2-voice-stt-model"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("ui2.settings.channels.voice.modelDesc")}
            </p>
          </div>

          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              checked={currentForm.diarization}
              onChange={(e) => setForm({ ...currentForm, diarization: e.target.checked })}
              data-testid="ui2-voice-stt-diarization"
              className="h-4 w-4 rounded border-input"
            />
            <span>{t("ui2.settings.channels.voice.diarization")}</span>
          </label>
          <p className="text-xs text-muted-foreground">
            {t("ui2.settings.channels.voice.diarizationDesc")}
          </p>

          <div className="space-y-1">
            <label htmlFor="ui2-voice-stt-max-duration" className="text-sm font-medium">
              {t("ui2.settings.channels.voice.maxDuration")}
            </label>
            <input
              id="ui2-voice-stt-max-duration"
              type="text"
              inputMode="numeric"
              value={currentForm.maxDurationSec}
              onChange={(e) => setForm({ ...currentForm, maxDurationSec: e.target.value })}
              data-testid="ui2-voice-stt-max-duration"
              className="w-full rounded-md border border-input bg-background px-3 py-1.5 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              {t("ui2.settings.channels.voice.maxDurationDesc")}
            </p>
          </div>

          <div className="pt-2">
            <button
              type="button"
              disabled={updateMutation.isPending || !isDirty || durationInvalid}
              onClick={handleSave}
              data-testid="ui2-voice-stt-save"
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {updateMutation.isPending
                ? t("ui2.settings.channels.voice.saving")
                : t("ui2.settings.channels.voice.save")}
            </button>
          </div>
        </div>
      </Ui2Section>
    </div>
  );
}
