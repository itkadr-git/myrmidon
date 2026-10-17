// Run queue priority (myrmidon 1.6.5 RUN-PRIORITY part B): which queued runs
// start first when the admission ceiling is closed — review, release and
// current-release work ahead of the rest. Editable while the server runs:
// saving applies on the next admission sweep, no restart (the runtime-limits
// pattern the core follows). The contract is the core's
// GET/PATCH /api/myrmidon/run-priority.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import {
  RUN_PRIORITY_ROLES,
  runPriorityQueryKey,
  runQueueApi,
  viewSource,
  type RunPriorityPatch,
  type RunPriorityRole,
  type RunPrioritySettings,
  type RunPriorityView,
} from "./runQueueApi";

/** The numeric settings besides the per-role weights, with the server's bounds. */
const NUMBER_FIELDS = [
  { key: "defaultRoleWeight", max: 1000 },
  { key: "releaseBonus", max: 1000 },
  { key: "agingStepMinutes", max: 24 * 60 },
  { key: "agingStepWeight", max: 1000 },
  { key: "agingMaxBonus", max: 10_000 },
  { key: "starvationLimitMinutes", max: 7 * 24 * 60 },
] as const;
type NumberFieldKey = (typeof NUMBER_FIELDS)[number]["key"];

/** Draft values are strings; role weights and numbers are integers, the release is free text. */
type DraftKey = RunPriorityRole | NumberFieldKey | "currentRelease";
export type RunPriorityDraft = Record<DraftKey, string>;
const ROLE_WEIGHT_MAX = 10_000;

type ErrorToken = "whole-number" | "range";
const ERROR_KEYS: Record<ErrorToken, string> = {
  "whole-number": "runQueue.error.wholeNumber",
  range: "runQueue.error.range",
};

interface DraftParse {
  patch: RunPriorityPatch | null;
  errors: Partial<Record<DraftKey, ErrorToken>>;
}

function isWhole(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Parse the draft into a PATCH body. A role weight is a whole number >= 0 or
 * empty (= no entry: the role weighs the default role weight); every other
 * number is a whole number within the server's bounds; the current release is
 * free text (empty = off, no release bonus). `baseRoleWeights` carries the
 * roles the operator set through the API, so saving keeps them. Returns a null
 * patch when any field is malformed, with per-field errors.
 */
export function parseRunPriorityDraft(
  draft: RunPriorityDraft,
  baseRoleWeights: Record<string, number> = {},
  enabled = true,
): DraftParse {
  const errors: Partial<Record<DraftKey, ErrorToken>> = {};
  const roleWeights: Record<string, number> = { ...baseRoleWeights };
  for (const role of RUN_PRIORITY_ROLES) {
    const raw = draft[role].trim();
    if (!raw) {
      delete roleWeights[role];
      continue;
    }
    const value = isWhole(raw);
    if (value === null) errors[role] = "whole-number";
    else if (value > ROLE_WEIGHT_MAX) errors[role] = "range";
    else roleWeights[role] = value;
  }
  const numbers = {} as Record<NumberFieldKey, number>;
  for (const { key, max } of NUMBER_FIELDS) {
    const value = isWhole(draft[key].trim());
    if (value === null) errors[key] = "whole-number";
    else if (value > max) errors[key] = "range";
    else numbers[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return {
    patch: {
      enabled,
      roleWeights,
      ...numbers,
      currentRelease: draft.currentRelease.trim() || null,
    },
    errors,
  };
}

function toDraft(settings: RunPrioritySettings): RunPriorityDraft {
  const num = (value: number | undefined) => (value == null ? "" : String(value));
  return {
    review: num(settings.roleWeights.review),
    release: num(settings.roleWeights.release),
    lead: num(settings.roleWeights.lead),
    engineer: num(settings.roleWeights.engineer),
    docs: num(settings.roleWeights.docs),
    defaultRoleWeight: num(settings.defaultRoleWeight),
    releaseBonus: num(settings.releaseBonus),
    currentRelease: settings.currentRelease ?? "",
    agingStepMinutes: num(settings.agingStepMinutes),
    agingStepWeight: num(settings.agingStepWeight),
    agingMaxBonus: num(settings.agingMaxBonus),
    starvationLimitMinutes: num(settings.starvationLimitMinutes),
  };
}

const NUMBER_FIELD_LABELS: Record<NumberFieldKey, { label: string; hint: string }> = {
  defaultRoleWeight: { label: "runQueue.defaultRoleWeight", hint: "runQueue.defaultRoleWeightHint" },
  releaseBonus: { label: "runQueue.currentReleaseBonus", hint: "runQueue.currentReleaseBonusHint" },
  agingStepMinutes: { label: "runQueue.agingStepMinutes", hint: "runQueue.agingStepMinutesHint" },
  agingStepWeight: { label: "runQueue.agingStepWeight", hint: "runQueue.agingStepWeightHint" },
  agingMaxBonus: { label: "runQueue.agingMax", hint: "runQueue.agingMaxHint" },
  starvationLimitMinutes: { label: "runQueue.starvationLimit", hint: "runQueue.starvationLimitHint" },
};

export function RunQueuePrioritySettingsPanelView({
  view,
  loading,
  onSave,
  pending,
  error,
}: {
  view: RunPriorityView | null | undefined;
  loading: boolean;
  onSave: (patch: RunPriorityPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<RunPriorityDraft | null>(null);
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const current = draft ?? (view ? toDraft(view.settings) : null);
  const enabled = enabledDraft ?? view?.settings.enabled ?? true;
  const { patch, errors } = current && view
    ? parseRunPriorityDraft(current, view.settings.roleWeights, enabled)
    : { patch: null, errors: {} as Partial<Record<DraftKey, ErrorToken>> };

  if (loading) {
    return (
      <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
        <p className="text-sm text-muted-foreground">{t("runQueue.loading")}</p>
      </section>
    );
  }

  if (!view) {
    // The server does not serve the endpoint (older build): the settings it
    // would edit do nothing here, so the panel says so instead of pretending
    // to save.
    return (
      <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Scale className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("runQueue.priorityTitle")}</h2>
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("runQueue.notServed")}</p>
        </div>
      </section>
    );
  }

  const setField = (key: DraftKey, value: string) =>
    setDraft({ ...(current ?? toDraft(view.settings)), [key]: value });
  const errorLine = (key: DraftKey, max?: number) =>
    errors[key] ? (
      <span data-testid={`run-priority-error-${key}`} className="ml-2 text-destructive">
        {t(ERROR_KEYS[errors[key]!], { max: max ?? ROLE_WEIGHT_MAX })}
      </span>
    ) : null;

  return (
    <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("runQueue.priorityTitle")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("runQueue.priorityDescription")}</p>
        <p className="text-xs text-muted-foreground" data-testid="run-priority-source">
          {t(`runQueue.source.${viewSource(view)}`)}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        <div className="space-y-1 md:col-span-2">
          <label className="flex items-center gap-2 text-sm" htmlFor="run-priority-enabled">
            <input
              id="run-priority-enabled"
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabledDraft(event.target.checked)}
            />
            {t("runQueue.enabled")}
          </label>
          <p className="text-xs text-muted-foreground">{t("runQueue.enabledHint")}</p>
        </div>

        {RUN_PRIORITY_ROLES.map((role) => (
          <div key={role} className="space-y-1">
            <Label htmlFor={`run-priority-role-${role}`}>{t(`runQueue.role.${role}`)}</Label>
            <Input
              id={`run-priority-role-${role}`}
              inputMode="numeric"
              placeholder={t("runQueue.weightOff")}
              value={current ? current[role] : ""}
              onChange={(event) => setField(role, event.target.value)}
            />
            <div className="text-xs text-muted-foreground">{errorLine(role)}</div>
          </div>
        ))}

        <div className="space-y-1">
          <Label htmlFor="run-priority-current-release">{t("runQueue.currentRelease")}</Label>
          <Input
            id="run-priority-current-release"
            placeholder={t("runQueue.currentReleaseOff")}
            value={current ? current.currentRelease : ""}
            onChange={(event) => setField("currentRelease", event.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("runQueue.currentReleaseHint")}</p>
        </div>

        {NUMBER_FIELDS.map(({ key, max }) => (
          <div key={key} className="space-y-1">
            <Label htmlFor={`run-priority-${key}`}>{t(NUMBER_FIELD_LABELS[key].label)}</Label>
            <Input
              id={`run-priority-${key}`}
              inputMode="numeric"
              value={current ? current[key] : ""}
              onChange={(event) => setField(key, event.target.value)}
            />
            <div className="text-xs text-muted-foreground">{errorLine(key, max)}</div>
            <p className="text-xs text-muted-foreground">{t(NUMBER_FIELD_LABELS[key].hint)}</p>
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
            {pending ? t("runQueue.saving") : t("runQueue.save")}
          </Button>
        </div>
      </div>
    </section>
  );
}

export function RunQueuePrioritySettingsPanel() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: runPriorityQueryKey,
    queryFn: () => runQueueApi.priority(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: runQueueApi.updatePriority,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("runQueue.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: runPriorityQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("runQueue.loadFailed")}
      </div>
    );
  }

  return (
    <RunQueuePrioritySettingsPanelView
      view={query.data}
      loading={query.isLoading}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
