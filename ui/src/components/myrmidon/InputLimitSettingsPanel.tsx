import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { behaviorSettingsApi, behaviorSettingsQueryKey, sourceLabel } from "./behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useTranslation } from "@/i18n";

const prefix = "area.settings-guardrails.input-limit-settings-panel";

export function InputLimitSettingsPanel() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const query = useQuery({ queryKey: behaviorSettingsQueryKey, queryFn: behaviorSettingsApi.get });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (patch: Record<string, boolean | number>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => { setDraft({}); await client.invalidateQueries({ queryKey: behaviorSettingsQueryKey }); },
  });
  const keys = [
    { key: "input_limit_chars_per_token", label: t(`${prefix}.charsPerToken`), min: 1, max: 10 },
    { key: "input_limit_safety", label: t(`${prefix}.safety`), min: 0.01, max: 1 },
  ];
  const title = <h2 className="text-sm font-semibold">{t(`${prefix}.title`)}</h2>;
  if (query.isLoading) return <section>{title}<p>{t(`${prefix}.loading`)}</p></section>;
  if (query.error || !query.data) return <section>{title}<p role="alert">{t(`${prefix}.loadFailed`)}</p></section>;
  const { settings, sources } = query.data;
  const source = (key: string) => t(`${prefix}.source`, { source: sourceLabel(sources[key], {
    env: t(`${prefix}.env`), ui: t(`${prefix}.ui`), default: t(`${prefix}.default`),
  }) });
  const enabledKey = "input_limit_precheck";
  return <section className="space-y-4" data-testid="input-limit-settings">
    {title}
    <div className="grid gap-4 md:grid-cols-3">
      <div className="space-y-1.5"><Label htmlFor={enabledKey}>{t(`${prefix}.precheck`)}</Label>
        <select id={enabledKey} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={draft[enabledKey] ?? String(Boolean(settings[enabledKey]))} onChange={(e) => setDraft((prev) => ({ ...prev, [enabledKey]: e.target.value }))}>
          <option value="true">{t(`${prefix}.on`)}</option><option value="false">{t(`${prefix}.off`)}</option>
        </select><p className="text-xs text-muted-foreground">{source(enabledKey)}</p></div>
      {keys.map(({ key, label, min, max }) => <div key={key} className="space-y-1.5"><Label htmlFor={key}>{label}</Label>
        <Input id={key} type="number" min={min} max={max} step="any" value={draft[key] ?? String(settings[key])} onChange={(e) => setDraft((prev) => ({ ...prev, [key]: e.target.value }))} />
        <p className="text-xs text-muted-foreground">{source(key)}</p></div>)}
    </div>
    <Button disabled={mutation.isPending || !Object.keys(draft).length} onClick={() => {
      const patch: Record<string, boolean | number> = {};
      if (enabledKey in draft) patch[enabledKey] = draft[enabledKey] === "true";
      for (const { key } of keys) if (key in draft) patch[key] = Number(draft[key]);
      mutation.mutate(patch);
    }}>{mutation.isPending ? t(`${prefix}.saving`) : t(`${prefix}.save`)}</Button>
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : t(`${prefix}.saveFailed`)}</p>}
  </section>;
}
