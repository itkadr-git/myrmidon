// Foraging settings (myrmidon 1.6.1, FORAGING-LIMITS-UI): the "Learning
// (foraging)" section of Instance → General. The master switch, the pass
// interval, the same-host pause, the per-pass budget, the daily/monthly
// company ceilings, the per-role and per-agent daily ceilings, the
// hard/soft enforcement mode and the cost-per-task auto-off threshold — each
// with its origin (saved here, environment override, default). Saving writes
// the instance settings row; the sweep re-resolves it on every pass, so a
// change applies with the next pass without a restart.
//
// Tokens only (DESIGN.md): Tailwind palette names, no raw values.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Leaf } from "lucide-react";
import type { ForagingSettingsPatch, ForagingSettingsSource } from "@myrmidon/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  describeForagingSource,
  foragingSettingsApi,
  foragingSettingsQueryKey,
  type ForagingSettingsView,
} from "./foragingSettingsApi";

interface DraftParse {
  patch: ForagingSettingsPatch | null;
  errors: Partial<Record<string, string>>;
}

/** The cents fields: an empty field means "no limit"; else a positive integer. */
const CENTS_FIELDS = [
  "passBudgetCents",
  "dailyBudgetCents",
  "monthlyBudgetCents",
  "roleBudgetCents",
  "agentBudgetCents",
  "autoOffCostPerTaskCents",
] as const;

type CentsKey = (typeof CENTS_FIELDS)[number];

// Functions, not module constants: the texts follow the interface language.
const fieldHints = (): Record<CentsKey, string> => ({
  passBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.passBudgetCents"),
  dailyBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.dailyBudgetCents"),
  monthlyBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.monthlyBudgetCents"),
  roleBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.roleBudgetCents"),
  agentBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.agentBudgetCents"),
  autoOffCostPerTaskCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.hints.autoOffCostPerTaskCents"),
});

const centsLabels = (): Record<CentsKey, string> => ({
  passBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.passBudgetCents"),
  dailyBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.dailyBudgetCents"),
  monthlyBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.monthlyBudgetCents"),
  roleBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.roleBudgetCents"),
  agentBudgetCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.agentBudgetCents"),
  autoOffCostPerTaskCents: i18n.t("area.settings-models-runtime-1.foraging-settings-panel.labels.autoOffCostPerTaskCents"),
});

/**
 * Parse the draft. Interval and host pause are required whole numbers in the
 * documented range; every cents field is "empty = no limit" or a positive
 * whole number of cents.
 */
export function parseForagingDraft(draft: {
  intervalSec: string;
  minHostIntervalSec: string;
} & Record<CentsKey, string>): DraftParse {
  const errors: Partial<Record<string, string>> = {};

  const intervalRaw = draft.intervalSec.trim();
  const interval = intervalRaw ? Number(intervalRaw) : Number.NaN;
  if (!intervalRaw || !Number.isInteger(interval) || interval < 60 || interval > 86400) {
    errors.intervalSec = i18n.t("area.settings-models-runtime-1.foraging-settings-panel.errors.interval");
  }

  const hostRaw = draft.minHostIntervalSec.trim();
  const host = hostRaw ? Number(hostRaw) : Number.NaN;
  if (!hostRaw || !Number.isInteger(host) || host < 5) {
    errors.minHostIntervalSec = i18n.t("area.settings-models-runtime-1.foraging-settings-panel.errors.hostInterval");
  }

  const cents: Partial<Record<CentsKey, number | null>> = {};
  for (const key of CENTS_FIELDS) {
    const raw = draft[key].trim();
    if (!raw) {
      cents[key] = null;
      continue;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value <= 0) {
      errors[key] = i18n.t("area.settings-models-runtime-1.foraging-settings-panel.errors.cents");
    } else {
      cents[key] = value;
    }
  }

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return {
    patch: {
      intervalSec: interval,
      minHostIntervalSec: host,
      passBudgetCents: cents.passBudgetCents ?? null,
      dailyBudgetCents: cents.dailyBudgetCents ?? null,
      monthlyBudgetCents: cents.monthlyBudgetCents ?? null,
      roleBudgetCents: cents.roleBudgetCents ?? null,
      agentBudgetCents: cents.agentBudgetCents ?? null,
      autoOffCostPerTaskCents: cents.autoOffCostPerTaskCents ?? null,
    },
    errors,
  };
}

function toDraft(settings: ForagingSettingsView["settings"]) {
  return {
    intervalSec: String(settings.intervalSec),
    minHostIntervalSec: String(settings.minHostIntervalSec),
    passBudgetCents: settings.passBudgetCents === null ? "" : String(settings.passBudgetCents),
    dailyBudgetCents: settings.dailyBudgetCents === null ? "" : String(settings.dailyBudgetCents),
    monthlyBudgetCents: settings.monthlyBudgetCents === null ? "" : String(settings.monthlyBudgetCents),
    roleBudgetCents: settings.roleBudgetCents === null ? "" : String(settings.roleBudgetCents),
    agentBudgetCents: settings.agentBudgetCents === null ? "" : String(settings.agentBudgetCents),
    autoOffCostPerTaskCents:
      settings.autoOffCostPerTaskCents === null ? "" : String(settings.autoOffCostPerTaskCents),
  };
}

export function ForagingSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ForagingSettingsView | null | undefined;
  onSave: (patch: ForagingSettingsPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const hints = fieldHints();
  const labels = centsLabels();
  const [draftNumbers, setDraftNumbers] = useState<ReturnType<typeof toDraft> | null>(null);
  const [draftEnabled, setDraftEnabled] = useState<boolean | null>(null);
  const [draftSoft, setDraftSoft] = useState<boolean | null>(null);

  const numbers = draftNumbers ?? (view ? toDraft(view.settings) : null);
  const enabled = draftEnabled ?? (view ? view.settings.enabled : false);
  const soft = draftSoft ?? (view ? view.settings.enforcement === "soft" : false);

  const { patch: numberPatch, errors } = numbers
    ? parseForagingDraft(numbers)
    : { patch: null, errors: {} as Partial<Record<string, string>> };

  const patch: ForagingSettingsPatch | null = numberPatch
    ? {
        ...numberPatch,
        enabled,
        enforcement: soft ? "soft" : "hard",
      }
    : null;

  const source = (key: string) =>
    view
      ? describeForagingSource(
          (view.sources as Record<string, string | undefined>)[key] as
            | ForagingSettingsSource
            | undefined,
        )
      : "";

  return (
    <section className="space-y-4" data-testid="myrmidon-foraging-settings">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Leaf className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-1.foraging-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-1.foraging-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="foraging-enabled">{t("area.settings-models-runtime-1.foraging-settings-panel.enableLabel")}</Label>
                <p className="text-xs text-muted-foreground">
                  <span data-testid="foraging-source-enabled">{source("enabled")}</span>
                </p>
              </div>
              <ToggleSwitch
                id="foraging-enabled"
                checked={enabled}
                onCheckedChange={setDraftEnabled}
                data-testid="foraging-enabled-toggle"
              />
            </div>
          </div>

          <div className="space-y-1">
            <Label htmlFor="foraging-intervalSec">{t("area.settings-models-runtime-1.foraging-settings-panel.intervalLabel")}</Label>
            <Input
              id="foraging-intervalSec"
              inputMode="numeric"
              value={numbers ? numbers.intervalSec : ""}
              onChange={(event) =>
                setDraftNumbers({ ...(numbers ?? toDraft(view.settings)), intervalSec: event.target.value })
              }
            />
            {errors.intervalSec ? (
              <div className="text-xs text-destructive" data-testid="foraging-error-intervalSec">
                {errors.intervalSec}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("area.settings-models-runtime-1.foraging-settings-panel.intervalHint")}{" "}
              <span data-testid="foraging-source-intervalSec">{source("intervalSec")}</span>
            </p>
          </div>

          <div className="space-y-1">
            <Label htmlFor="foraging-minHostIntervalSec">{t("area.settings-models-runtime-1.foraging-settings-panel.hostPauseLabel")}</Label>
            <Input
              id="foraging-minHostIntervalSec"
              inputMode="numeric"
              value={numbers ? numbers.minHostIntervalSec : ""}
              onChange={(event) =>
                setDraftNumbers({
                  ...(numbers ?? toDraft(view.settings)),
                  minHostIntervalSec: event.target.value,
                })
              }
            />
            {errors.minHostIntervalSec ? (
              <div className="text-xs text-destructive" data-testid="foraging-error-minHostIntervalSec">
                {errors.minHostIntervalSec}
              </div>
            ) : null}
            <p className="text-xs text-muted-foreground">
              {t("area.settings-models-runtime-1.foraging-settings-panel.hostPauseHint")}{" "}
              <span data-testid="foraging-source-minHostIntervalSec">
                {source("minHostIntervalSec")}
              </span>
            </p>
          </div>

          {CENTS_FIELDS.map((key) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`foraging-${key}`}>{labels[key]}</Label>
              <Input
                id={`foraging-${key}`}
                inputMode="numeric"
                placeholder={t("area.settings-models-runtime-1.foraging-settings-panel.noLimitPlaceholder")}
                value={numbers ? numbers[key] : ""}
                onChange={(event) =>
                  setDraftNumbers({ ...(numbers ?? toDraft(view.settings)), [key]: event.target.value })
                }
              />
              {errors[key] ? (
                <div className="text-xs text-destructive" data-testid={`foraging-error-${key}`}>
                  {errors[key]}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">
                {hints[key]} <span data-testid={`foraging-source-${key}`}>{source(key)}</span>
              </p>
            </div>
          ))}

          <div className="space-y-2 md:col-span-2">
            <div className="flex items-center justify-between gap-4">
              <div className="space-y-1">
                <Label htmlFor="foraging-soft">{t("area.settings-models-runtime-1.foraging-settings-panel.softLabel")}</Label>
                <p className="text-xs text-muted-foreground">
                  {t("area.settings-models-runtime-1.foraging-settings-panel.softHint")}{" "}
                  <span data-testid="foraging-source-enforcement">{source("enforcement")}</span>
                </p>
              </div>
              <ToggleSwitch
                id="foraging-soft"
                checked={soft}
                onCheckedChange={setDraftSoft}
                data-testid="foraging-soft-toggle"
              />
            </div>
          </div>

          <div className="md:col-span-2">
            <Button
              type="button"
              size="sm"
              disabled={pending || patch === null}
              onClick={() => {
                if (patch) onSave(patch);
              }}
            >
              {pending ? t("area.settings-models-runtime-1.shared.saving") : t("area.settings-models-runtime-1.foraging-settings-panel.saveButton")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-1.foraging-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function ForagingSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: foragingSettingsQueryKey,
    queryFn: () => foragingSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: foragingSettingsApi.update,
    onMutate: () => setError(null),
    onError: (err) =>
      setError(err instanceof Error ? err.message : t("area.settings-models-runtime-1.foraging-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: foragingSettingsQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.settings-models-runtime-1.foraging-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <ForagingSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
