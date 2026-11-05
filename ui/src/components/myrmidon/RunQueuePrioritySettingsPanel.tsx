import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Scale } from "lucide-react";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";
import { useIsInstanceAdmin } from "./licensingApi";

const PRIORITIES = ["critical", "high", "medium", "low", "none"] as const;
const MAX_STARVATION_WEIGHT = 1_000_000;
const MAX_ROLE_WEIGHT = 1_000_000;

type Settings = {
  enabled: boolean;
  issuePriorityWeights: Record<string, number>;
  roleWeights: Record<string, number>;
  defaultRoleWeight: number;
  currentRelease: string | null;
  releaseBonus: number;
  agingStepMinutes: number;
  agingStepWeight: number;
  agingMaxBonus: number;
  starvationLimitMinutes: number;
  starvationTopWeight: number;
  pheromoneWeight: number;
};
type View = { settings: Settings; source: "settings" | "env" };
type EditableSettings = Pick<Settings, "issuePriorityWeights" | "roleWeights" | "starvationLimitMinutes" | "starvationTopWeight">;
type Draft = { issuePriorityWeights: Record<string, string>; roleWeights: Record<string, string>; starvationTopWeight: string };
type Errors = Record<string, string>;

export function toRunPriorityDraft(settings: EditableSettings): Draft {
  return {
    issuePriorityWeights: Object.fromEntries(Object.entries(settings.issuePriorityWeights).map(([key, value]) => [key, String(value)])),
    roleWeights: Object.fromEntries(Object.entries(settings.roleWeights).map(([key, value]) => [key, String(value)])),
    starvationTopWeight: String(settings.starvationTopWeight),
  };
}

export function parseRunPriorityDraft(draft: Draft): { patch: Pick<EditableSettings, "issuePriorityWeights" | "roleWeights" | "starvationTopWeight"> | null; errors: Errors } {
  const errors: Errors = {};
  const parse = (raw: string, key: string, max: number): number => {
    const value = Number(raw);
    if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value) || value > max) errors[key] = "invalidWeight";
    return value;
  };
  const issuePriorityWeights = Object.fromEntries(Object.entries(draft.issuePriorityWeights).map(([key, raw]) => [key, parse(raw, `issue-${key}`, MAX_ROLE_WEIGHT)]));
  const roleWeights = Object.fromEntries(Object.entries(draft.roleWeights).map(([key, raw]) => [key, parse(raw, `role-${key}`, MAX_ROLE_WEIGHT)]));
  const starvationTopWeight = parse(draft.starvationTopWeight, "starvation", MAX_STARVATION_WEIGHT);
  if (!PRIORITIES.every((key) => key in issuePriorityWeights)) errors.issuePriorityWeights = "missingPriority";
  if (!Object.keys(roleWeights).length) errors.roleWeights = "missingRole";
  return { patch: Object.keys(errors).length ? null : { issuePriorityWeights, roleWeights, starvationTopWeight }, errors };
}

export function RunQueuePrioritySettingsPanelView({ view, pending, onSave, canEdit, error }: {
  view: View;
  pending: boolean;
  canEdit: boolean;
  onSave: (patch: NonNullable<ReturnType<typeof parseRunPriorityDraft>["patch"]>) => void;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<Draft>(() => toRunPriorityDraft(view.settings));
  useEffect(() => setDraft(toRunPriorityDraft(view.settings)), [view]);
  const { patch, errors } = parseRunPriorityDraft(draft);
  const updateMap = (map: "roleWeights" | "issuePriorityWeights", key: string, value: string) =>
    setDraft((current) => ({ ...current, [map]: { ...current[map], [key]: value } }));
  const field = (id: string, label: string, value: string, update: (value: string) => void, errorKey: string) => (
    <div key={id} className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="numeric" value={value} disabled={!canEdit || pending} onChange={(event) => update(event.target.value)} />
      {errors[errorKey] ? <p role="alert" className="text-xs text-destructive">{t(`runQueue.error.${errors[errorKey]}`)}</p> : null}
    </div>
  );
  return (
    <section className="space-y-4" data-testid="myrmidon-run-queue-priority">
      <div className="flex items-center gap-2"><Scale className="h-4 w-4" /><h2 className="text-sm font-semibold">{t("runQueue.priorityTitle")}</h2></div>
      <p className="text-xs text-muted-foreground">{t(`runQueue.source.${view.source}`)}</p>
      <p className="text-sm text-muted-foreground">{t("runQueue.issueWeightsHint")}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {PRIORITIES.map((key) => field(`run-priority-issue-${key}`, t(`runQueue.issue.${key}`), draft.issuePriorityWeights[key] ?? "", (value) => updateMap("issuePriorityWeights", key, value), `issue-${key}`))}
      </div>
      <p className="text-sm text-muted-foreground">{t("runQueue.roleWeightsHint")}</p>
      <div className="grid gap-3 md:grid-cols-2">
        {Object.keys(draft.roleWeights).sort().map((key) => field(`run-priority-role-${key}`, key, draft.roleWeights[key], (value) => updateMap("roleWeights", key, value), `role-${key}`))}
      </div>
      {field("run-priority-starvation-top", t("runQueue.starvationTop"), draft.starvationTopWeight, (value) => setDraft((current) => ({ ...current, starvationTopWeight: value })), "starvation")}
      <p className="text-xs text-muted-foreground">{t("runQueue.starvationTopHint", { minutes: view.settings.starvationLimitMinutes })}</p>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {canEdit ? <Button type="button" disabled={pending || !patch} onClick={() => { if (patch) onSave(patch); }}>{pending ? t("runQueue.saving") : t("runQueue.save")}</Button> : <p className="text-sm text-muted-foreground">{t("runQueue.adminOnly")}</p>}
    </section>
  );
}

export function RunQueuePrioritySettingsPanel() {
  const { t } = useTranslation();
  const canEdit = useIsInstanceAdmin();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({ queryKey: ["myrmidon", "run-priority"], queryFn: () => api.get<View>("/myrmidon/run-priority"), retry: false });
  const save = useMutation({
    mutationFn: (patch: NonNullable<ReturnType<typeof parseRunPriorityDraft>["patch"]>) => api.patch<View>("/myrmidon/run-priority", patch),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("runQueue.saveFailed")),
    onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["myrmidon", "run-priority"] }); },
  });
  if (query.isLoading || canEdit === null) return <p>{t("runQueue.loading")}</p>;
  if (!query.data) return <p role="alert">{query.error instanceof Error ? query.error.message : t("runQueue.loadFailed")}</p>;
  return <RunQueuePrioritySettingsPanelView view={query.data} pending={save.isPending} canEdit={canEdit} onSave={(patch) => save.mutate(patch)} error={error} />;
}
