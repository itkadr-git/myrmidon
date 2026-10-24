// Run stall detection (myrmidon RUN-STALL-SETTINGS, 1.6.5): the
// progress-based run liveness sweep, editable while the server runs. Saving
// applies the values at once — the very next pass works with the new
// threshold and interval, no restart and no run in flight is dropped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlarmClock } from "lucide-react";
import type { RunStallKey, RunStallValues } from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { Trans } from "react-i18next";
import {
  describeRunStallSource,
  runStallApi,
  runStallQueryKey,
  type RunStallEditablePatch,
  type RunStallView,
} from "./runStallApi";

/** The team-liveness section of this page (same screen), where `enabled` and the threshold live. */
export const TEAM_LIVENESS_ANCHOR = "#team-liveness-settings";

type NumberKey = Extract<RunStallKey, "checkIntervalSec" | "pageSize">;

const NUMBER_KEYS: NumberKey[] = ["checkIntervalSec", "pageSize"];

/** Labels are resolved at render, not at import, so a language switch applies. */
function numberFields(): Array<{ key: NumberKey; label: string; hint: string }> {
  return [
    {
      key: "checkIntervalSec",
      label: i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.checkIntervalSec.label"),
      hint: i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.checkIntervalSec.hint"),
    },
    {
      key: "pageSize",
      label: i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.pageSize.label"),
      hint: i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.pageSize.hint"),
    },
  ];
}

interface DraftParse {
  patch: RunStallEditablePatch | null;
  errors: Partial<Record<NumberKey, string>>;
}

/** Every editable field must be a positive whole number. */
export function parseRunStallDraft(draft: Record<NumberKey, string>): DraftParse {
  const errors: Partial<Record<NumberKey, string>> = {};
  const parsed = {} as Record<NumberKey, number>;
  for (const key of NUMBER_KEYS) {
    const raw = draft[key].trim();
    const value = raw ? Number(raw) : NaN;
    if (!raw || !Number.isInteger(value) || value <= 0) {
      errors[key] = i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.wholeNumberError");
      continue;
    }
    parsed[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return {
    patch: {
      checkIntervalSec: parsed.checkIntervalSec,
      pageSize: parsed.pageSize,
    },
    errors,
  };
}

function toDraft(settings: RunStallValues): Record<NumberKey, string> {
  return {
    checkIntervalSec: String(settings.checkIntervalSec),
    pageSize: String(settings.pageSize),
  };
}

export function RunStallSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: RunStallView | null | undefined;
  onSave: (patch: RunStallEditablePatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Record<NumberKey, string> | null>(null);
  const current = draft ?? (view ? toDraft(view.settings) : null);
  const { patch, errors } = current
    ? parseRunStallDraft(current)
    : { patch: null, errors: {} as Partial<Record<NumberKey, string>> };

  return (
    <section className="space-y-4" data-testid="myrmidon-run-stall">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <AlarmClock className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-2.run-stall-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          <Trans
            i18nKey="area.settings-models-runtime-2.run-stall-settings-panel.description"
            components={{
              link: (
                <a href={TEAM_LIVENESS_ANCHOR} className="underline" data-testid="run-stall-team-liveness-link" />
              ),
            }}
          />
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1 md:col-span-2" data-testid="run-stall-managed">
            <div className="text-sm">
              <span className="text-muted-foreground">{t("area.settings-models-runtime-2.run-stall-settings-panel.interruptLabel")} </span>
              <span data-testid="run-stall-enabled-value">{view.settings.enabled ? t("area.settings-models-runtime-2.run-stall-settings-panel.on") : t("area.settings-models-runtime-2.run-stall-settings-panel.off")}</span>
              <span className="ml-2 text-xs text-muted-foreground" data-testid="run-stall-source-enabled">
                {describeRunStallSource(view.sources.enabled)}
              </span>
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">{t("area.settings-models-runtime-2.run-stall-settings-panel.thresholdLabel")} </span>
              <span data-testid="run-stall-threshold-value">{view.settings.thresholdSec} s</span>
              <span className="ml-2 text-xs text-muted-foreground" data-testid="run-stall-source-thresholdSec">
                {describeRunStallSource(view.sources.thresholdSec)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {t("area.settings-models-runtime-2.run-stall-settings-panel.readOnlyHint")}
            </p>
          </div>
          {numberFields().map(({ key, label, hint }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`run-stall-${key}`}>{label}</Label>
              <Input
                id={`run-stall-${key}`}
                inputMode="numeric"
                value={current ? current[key] : ""}
                onChange={(event) =>
                  setDraft({ ...(current ?? toDraft(view.settings)), [key]: event.target.value })
                }
              />
              <div className="text-xs text-muted-foreground">
                <span data-testid={`run-stall-source-${key}`}>
                  {describeRunStallSource(view.sources[key])}
                </span>
                {errors[key] ? (
                  <span data-testid={`run-stall-error-${key}`} className="ml-2 text-destructive">
                    {errors[key]}
                  </span>
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? t("area.settings-models-runtime-2.run-stall-settings-panel.saving") : t("area.settings-models-runtime-2.run-stall-settings-panel.save")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-2.run-stall-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function RunStallSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: runStallQueryKey,
    queryFn: () => runStallApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: runStallApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : i18n.t("area.settings-models-runtime-2.run-stall-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: runStallQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.settings-models-runtime-2.run-stall-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <RunStallSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
