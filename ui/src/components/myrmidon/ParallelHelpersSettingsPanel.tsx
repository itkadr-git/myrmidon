// Parallel helpers (myrmidon PARALLEL-HELPERS): the company ceiling and default
// for the "Parallel helpers" block on agent cards, editable while the server
// runs. Saving writes the instance settings row; the profile compiler re-reads
// it on every reconcile tick, so every bot's config.yaml picks it up within a
// tick, no restart. The capacity hint is a warning, never a block. The ceiling
// has no built-in upper limit (HELPERS-NO-CAP): the owner's number is the
// limit, and a suspiciously high value shows a host-load warning here instead
// of being clamped.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Users } from "lucide-react";
import type { ParallelHelpersSettings } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { i18n, useTranslation } from "@/i18n";
import { parallelHelpersApi, parallelHelpersQueryKey, type ParallelHelpersView } from "./parallelHelpersApi";

interface DraftParse {
  patch: Partial<ParallelHelpersSettings> | null;
  errors: Partial<Record<keyof ParallelHelpersSettings, string>>;
}

type NumberKey = "maxPerAgent" | "defaultMaxPerAgent" | "buildSlots" | "hostMemoryMb";

/**
 * HELPERS-NO-CAP: above this draft value the settings form shows a host-load
 * warning instead of clamping. The threshold is a "you may have mistyped
 * something" signal, not a limit — the owner's number always wins.
 */
const HELPERS_HOST_LOAD_WARN_ABOVE = 50;

const NUMBER_KEYS: NumberKey[] = ["maxPerAgent", "defaultMaxPerAgent", "buildSlots", "hostMemoryMb"];

// A function, not a module constant: the texts follow the interface language.
const getNumberFields = (): Array<{ key: NumberKey; label: string; hint: string; optional: boolean }> => [
  {
    key: "maxPerAgent",
    label: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.maxPerAgent.label"),
    hint: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.maxPerAgent.hint"),
    optional: true,
  },
  {
    key: "defaultMaxPerAgent",
    label: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.defaultMaxPerAgent.label"),
    hint: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.defaultMaxPerAgent.hint"),
    optional: true,
  },
  {
    key: "buildSlots",
    label: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.buildSlots.label"),
    hint: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.buildSlots.hint"),
    optional: true,
  },
  {
    key: "hostMemoryMb",
    label: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.hostMemoryMb.label"),
    hint: i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.fields.hostMemoryMb.hint"),
    optional: true,
  },
];

/** An empty field means "unset"; anything else must be a positive integer. */
export function parseParallelHelpersDraft(draft: Record<NumberKey, string>): DraftParse {
  const errors: Partial<Record<keyof ParallelHelpersSettings, string>> = {};
  const parsed = {} as Record<NumberKey, number | null>;
  for (const key of NUMBER_KEYS) {
    const raw = draft[key].trim();
    const value = raw ? Number(raw) : null;
    if (raw && (value === null || !Number.isInteger(value) || value <= 0)) {
      errors[key] = i18n.t("area.settings-models-runtime-1.parallel-helpers-settings-panel.errors.number");
      continue;
    }
    parsed[key] = value;
  }
  if (Object.keys(errors).length > 0) return { patch: null, errors };
  const patch: Partial<ParallelHelpersSettings> = {};
  if (parsed.maxPerAgent !== null) patch.maxPerAgent = parsed.maxPerAgent;
  if (parsed.defaultMaxPerAgent !== null) patch.defaultMaxPerAgent = parsed.defaultMaxPerAgent;
  // Empty host-capacity inputs are explicit clears; optional helper defaults
  // still remain unchanged when their fields are blank.
  if (draft.buildSlots.trim() === "" || parsed.buildSlots !== null) {
    patch.buildSlots = parsed.buildSlots;
  }
  if (draft.hostMemoryMb.trim() === "" || parsed.hostMemoryMb !== null) {
    patch.hostMemoryMb = parsed.hostMemoryMb;
  }
  return { patch, errors };
}

function toDraft(settings: ParallelHelpersSettings): Record<NumberKey, string> {
  return {
    maxPerAgent: settings.maxPerAgent === undefined ? "" : String(settings.maxPerAgent),
    defaultMaxPerAgent: settings.defaultMaxPerAgent === undefined ? "" : String(settings.defaultMaxPerAgent),
    buildSlots: settings.buildSlots == null ? "" : String(settings.buildSlots),
    hostMemoryMb: settings.hostMemoryMb == null ? "" : String(settings.hostMemoryMb),
  };
}

export function ParallelHelpersSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: ParallelHelpersView | null | undefined;
  onSave: (patch: Partial<ParallelHelpersSettings>) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Record<NumberKey, string> | null>(null);
  const current = draft ?? (view ? toDraft(view.settings) : null);
  const { patch, errors } = current
    ? parseParallelHelpersDraft(current)
    : { patch: null, errors: {} as Partial<Record<keyof ParallelHelpersSettings, string>> };
  // HELPERS-NO-CAP: a ceiling above the warn threshold shows a host-load note,
  // it is never clamped or blocked — the limit is the owner's number alone.
  const draftCeiling = patch && patch.maxPerAgent !== undefined ? patch.maxPerAgent : null;
  const effectiveCeiling = view?.effective.ceiling ?? null;
  const ceilingToWarn =
    draftCeiling !== null ? draftCeiling : (effectiveCeiling ?? null);
  const hostLoadWarning =
    ceilingToWarn !== null && ceilingToWarn > HELPERS_HOST_LOAD_WARN_ABOVE
      ? t("area.settings-models-runtime-1.parallel-helpers-settings-panel.hostLoadWarning", { ceiling: ceilingToWarn })
      : null;

  return (
    <section className="space-y-4" data-testid="myrmidon-parallel-helpers">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("area.settings-models-runtime-1.parallel-helpers-settings-panel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          {t("area.settings-models-runtime-1.parallel-helpers-settings-panel.description")}
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="grid gap-3 md:grid-cols-2">
          {getNumberFields().map(({ key, label, hint }) => (
            <div key={key} className="space-y-1">
              <Label htmlFor={`parallel-helpers-${key}`}>{label}</Label>
              <Input
                id={`parallel-helpers-${key}`}
                inputMode="numeric"
                placeholder={t("area.settings-models-runtime-1.parallel-helpers-settings-panel.defaultPlaceholder")}
                value={current ? current[key] : ""}
                onChange={(event) =>
                  setDraft({ ...(current ?? toDraft(view.settings)), [key]: event.target.value })
                }
              />
              {errors[key] ? (
                <div className="text-xs text-destructive" data-testid={`parallel-helpers-error-${key}`}>
                  {errors[key]}
                </div>
              ) : null}
              <p className="text-xs text-muted-foreground">{hint}</p>
            </div>
          ))}
          <div className="md:col-span-2 space-y-1">
            <div className="text-xs text-muted-foreground" data-testid="parallel-helpers-effective">
              {t("area.settings-models-runtime-1.parallel-helpers-settings-panel.inForce", { ceiling: view.effective.ceiling, default: view.effective.defaultPerAgent })}
            </div>
            {hostLoadWarning ? (
              <div
                className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                data-testid="parallel-helpers-host-load-warning"
              >
                {hostLoadWarning}
              </div>
            ) : null}
            {view.capacity.warning ? (
              <div
                className="rounded-md border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-800 dark:text-amber-200"
                data-testid="parallel-helpers-capacity-warning"
              >
                {view.capacity.warning}
              </div>
            ) : (
              <div className="text-xs text-muted-foreground" data-testid="parallel-helpers-capacity-ok">
                {t("area.settings-models-runtime-1.parallel-helpers-settings-panel.usage", { slots: view.capacity.requestedTotal, agents: view.capacity.enabledAgents })}
              </div>
            )}
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
              {pending ? t("area.settings-models-runtime-1.shared.saving") : t("area.settings-models-runtime-1.parallel-helpers-settings-panel.saveButton")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("area.settings-models-runtime-1.parallel-helpers-settings-panel.loading")}</p>
      )}
    </section>
  );
}

export function ParallelHelpersSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: parallelHelpersQueryKey,
    queryFn: () => parallelHelpersApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: parallelHelpersApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("area.settings-models-runtime-1.parallel-helpers-settings-panel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: parallelHelpersQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("area.settings-models-runtime-1.parallel-helpers-settings-panel.loadFailed")}
      </div>
    );
  }

  return (
    <ParallelHelpersSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
