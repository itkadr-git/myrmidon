// Run queue priority (myrmidon 1.6.5 RUN-PRIORITY part B): which queued runs
// start first when the admission ceiling is closed — review, release and
// current-release work ahead of the rest. Editable while the server runs:
// saving applies on the next admission sweep, no restart (the runtime-limits
// pattern the core part A follows).
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import {
  RUN_PRIORITY_ROLES,
  fieldSource,
  roleWeightSource,
  runPriorityQueryKey,
  runQueueApi,
  type RunPriorityPatch,
  type RunPriorityRole,
  type RunPrioritySettings,
  type RunPriorityView,
} from "./runQueueApi";

/** Draft values are strings; role weights and aging numbers are integers, the release is free text. */
type DraftKey = RunPriorityRole | "currentReleaseBonus" | "currentRelease" | "agingStepPerHour" | "agingMaxBonus";
const DRAFT_KEYS: DraftKey[] = [...RUN_PRIORITY_ROLES, "currentReleaseBonus", "currentRelease", "agingStepPerHour", "agingMaxBonus"];

interface DraftParse {
  patch: RunPriorityPatch | null;
  errors: Partial<Record<DraftKey, ErrorToken>>;
}

/**
 * Parse the draft into a PATCH body. Weight fields accept a whole number >= 0
 * or empty (= off: the role runs in plain FIFO order); the current release is
 * free text (empty = off — no release bonus at all). Returns null when any
 * field is malformed, with per-field errors.
 */
export function parseRunPriorityDraft(draft: Record<DraftKey, string>): DraftParse {
  const errors: Partial<Record<DraftKey, ErrorToken>> = {};
  const parsed = {} as Record<DraftKey, number | string | null>;
  for (const key of DRAFT_KEYS) {
    const raw = draft[key].trim();
    if (key === "currentRelease") {
      parsed[key] = raw;
      continue;
    }
    const value = raw ? Number(raw) : null;
    if (raw && (value === null || !Number.isInteger(value) || value < 0)) {
      errors[key] = "whole-number";
      continue;
    }
    parsed[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  const roleWeights: Partial<Record<RunPriorityRole, number | null>> = {};
  for (const role of RUN_PRIORITY_ROLES) {
    roleWeights[role] = parsed[role] as number | null;
  }
  return {
    patch: {
      roleWeights,
      currentReleaseBonus: parsed.currentReleaseBonus as number | null,
      currentRelease: parsed.currentRelease as string | null,
      agingStepPerHour: parsed.agingStepPerHour as number | null,
      agingMaxBonus: parsed.agingMaxBonus as number | null,
    },
    errors,
  };
}

function toDraft(settings: RunPrioritySettings): Record<DraftKey, string> {
  return {
    review: settings.roleWeights.review == null ? "" : String(settings.roleWeights.review),
    release: settings.roleWeights.release == null ? "" : String(settings.roleWeights.release),
    lead: settings.roleWeights.lead == null ? "" : String(settings.roleWeights.lead),
    engineer: settings.roleWeights.engineer == null ? "" : String(settings.roleWeights.engineer),
    docs: settings.roleWeights.docs == null ? "" : String(settings.roleWeights.docs),
    currentReleaseBonus: settings.currentReleaseBonus == null ? "" : String(settings.currentReleaseBonus),
    currentRelease: settings.currentRelease ?? "",
    agingStepPerHour: settings.agingStepPerHour == null ? "" : String(settings.agingStepPerHour),
    agingMaxBonus: settings.agingMaxBonus == null ? "" : String(settings.agingMaxBonus),
  };
}

const ERROR_TOKENS = ["whole-number"] as const;
type ErrorToken = (typeof ERROR_TOKENS)[number];
const ERROR_KEYS: Record<ErrorToken, string> = {
  "whole-number": "runQueue.error.wholeNumber",
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
  const [draft, setDraft] = useState<Record<DraftKey, string> | null>(null);
  const current = draft ?? (view ? toDraft(view.settings) : null);
  const { patch, errors } = current
    ? parseRunPriorityDraft(current)
    : { patch: null, errors: {} as Partial<Record<DraftKey, ErrorToken>> };

  if (loading) {
    return (
      <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
        <p className="text-sm text-muted-foreground">{t("runQueue.loading")}</p>
      </section>
    );
  }

  if (!view) {
    // The server does not serve the endpoint yet (queue priority is not
    // deployed): the settings it would edit do nothing here, so the panel
    // says so instead of pretending to save.
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

  return (
    <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Scale className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("runQueue.priorityTitle")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("runQueue.priorityDescription")}</p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2">
        {RUN_PRIORITY_ROLES.map((role) => (
          <div key={role} className="space-y-1">
            <Label htmlFor={`run-priority-role-${role}`}>{t(`runQueue.role.${role}`)}</Label>
            <Input
              id={`run-priority-role-${role}`}
              inputMode="numeric"
              placeholder={t("runQueue.weightOff")}
              value={current ? current[role] : ""}
              onChange={(event) =>
                setDraft({ ...(current ?? toDraft(view.settings)), [role]: event.target.value })
              }
            />
            <div className="text-xs text-muted-foreground">
              <span data-testid={`run-priority-source-${role}`}>
                {t(`runQueue.source.${roleWeightSource(view, role)}`)}
              </span>
              {errors[role] ? (
                <span data-testid={`run-priority-error-${role}`} className="ml-2 text-destructive">
                  {t(ERROR_KEYS[errors[role]!])}
                </span>
              ) : null}
            </div>
          </div>
        ))}

        <div className="space-y-1">
          <Label htmlFor="run-priority-current-release">{t("runQueue.currentRelease")}</Label>
          <Input
            id="run-priority-current-release"
            placeholder={t("runQueue.currentReleaseOff")}
            value={current ? current.currentRelease : ""}
            onChange={(event) =>
              setDraft({ ...(current ?? toDraft(view.settings)), currentRelease: event.target.value })
            }
          />
          <p className="text-xs text-muted-foreground">{t("runQueue.currentReleaseHint")}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="run-priority-current-release-bonus">{t("runQueue.currentReleaseBonus")}</Label>
          <Input
            id="run-priority-current-release-bonus"
            inputMode="numeric"
            placeholder={t("runQueue.weightOff")}
            value={current ? current.currentReleaseBonus : ""}
            onChange={(event) =>
              setDraft({ ...(current ?? toDraft(view.settings)), currentReleaseBonus: event.target.value })
            }
          />
          <div className="text-xs text-muted-foreground">
            <span data-testid="run-priority-source-currentReleaseBonus">
              {t(`runQueue.source.${fieldSource(view, "currentReleaseBonus")}`)}
            </span>
            {errors.currentReleaseBonus ? (
              <span data-testid="run-priority-error-currentReleaseBonus" className="ml-2 text-destructive">
                {t(ERROR_KEYS[errors.currentReleaseBonus!])}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("runQueue.currentReleaseBonusHint")}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="run-priority-aging-step">{t("runQueue.agingStep")}</Label>
          <Input
            id="run-priority-aging-step"
            inputMode="numeric"
            placeholder={t("runQueue.weightOff")}
            value={current ? current.agingStepPerHour : ""}
            onChange={(event) =>
              setDraft({ ...(current ?? toDraft(view.settings)), agingStepPerHour: event.target.value })
            }
          />
          <div className="text-xs text-muted-foreground">
            <span data-testid="run-priority-source-agingStepPerHour">
              {t(`runQueue.source.${fieldSource(view, "agingStepPerHour")}`)}
            </span>
            {errors.agingStepPerHour ? (
              <span data-testid="run-priority-error-agingStepPerHour" className="ml-2 text-destructive">
                {t(ERROR_KEYS[errors.agingStepPerHour!])}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("runQueue.agingStepHint")}</p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="run-priority-aging-max">{t("runQueue.agingMax")}</Label>
          <Input
            id="run-priority-aging-max"
            inputMode="numeric"
            placeholder={t("runQueue.weightOff")}
            value={current ? current.agingMaxBonus : ""}
            onChange={(event) =>
              setDraft({ ...(current ?? toDraft(view.settings)), agingMaxBonus: event.target.value })
            }
          />
          <div className="text-xs text-muted-foreground">
            <span data-testid="run-priority-source-agingMaxBonus">
              {t(`runQueue.source.${fieldSource(view, "agingMaxBonus")}`)}
            </span>
            {errors.agingMaxBonus ? (
              <span data-testid="run-priority-error-agingMaxBonus" className="ml-2 text-destructive">
                {t(ERROR_KEYS[errors.agingMaxBonus!])}
              </span>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">{t("runQueue.agingMaxHint")}</p>
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
