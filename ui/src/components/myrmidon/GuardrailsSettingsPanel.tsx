import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { behaviorSettingsApi, behaviorSettingsQueryKey, type BehaviorSettingValue } from "@/components/myrmidon/behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FIELDS = [
  { key: "bot_egress_mode", label: "Bot egress mode", kind: "select", options: ["off", "log"] },
  { key: "tool_breaker_failures", label: "Tool failures before pause", kind: "number" },
  { key: "tool_breaker_cooldown_ms", label: "Tool breaker pause (ms)", kind: "number" },
  { key: "tool_breaker_window_ms", label: "Tool breaker window (ms)", kind: "number" },
  { key: "tool_timeout_max_ms", label: "Maximum tool timeout (ms)", kind: "number" },
  { key: "tool_timeout_slow_ms", label: "Slow tool timeout (ms)", kind: "number" },
] as const;

const LIST_FIELDS = [
  { key: "run_env_allow", label: "Allowed inherited environment names" },
] as const;

export function GuardrailsSettingsPanel() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: behaviorSettingsQueryKey, queryFn: behaviorSettingsApi.get });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => { setDrafts({}); await queryClient.invalidateQueries({ queryKey: behaviorSettingsQueryKey }); },
  });
  if (query.isLoading) return <section className="space-y-3"><h2 className="text-sm font-semibold">Guardrails</h2><p className="text-sm text-muted-foreground">Loading guardrail settings...</p></section>;
  if (query.error || !query.data) return <section className="space-y-3"><h2 className="text-sm font-semibold">Guardrails</h2><p role="alert" className="text-sm text-destructive">Unable to load guardrail settings.</p></section>;

  const { settings, sources } = query.data;
  return <section className="space-y-4">
    <div><h2 className="text-sm font-semibold">Guardrails</h2><p className="text-sm text-muted-foreground">Environment values take precedence over saved values.</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      {FIELDS.map((field) => {
        const value = settings[field.key];
        const source = sources[field.key];
        return <div key={field.key} className="space-y-1.5">
          <Label htmlFor={`guardrail-${field.key}`}>{field.label}</Label>
          {field.kind === "select" ? <select id={`guardrail-${field.key}`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={drafts[field.key] ?? String(value)} onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))}>
            {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
          </select> : <Input id={`guardrail-${field.key}`} type="number" min="0" step="1" value={drafts[field.key] ?? String(value)} onChange={(event) => setDrafts((current) => ({ ...current, [field.key]: event.target.value }))} />}
          <p className="text-xs text-muted-foreground">Source: {source === "env" ? "server environment (override)" : source === "ui" ? "saved setting" : "default"}</p>
        </div>;
      })}
      {LIST_FIELDS.map((field) => {
        const value = settings[field.key];
        const source = sources[field.key];
        const current = drafts[field.key] ?? (Array.isArray(value) ? value.join(", ") : String(value ?? ""));
        return <div key={field.key} className="space-y-1.5 md:col-span-2">
          <Label htmlFor={`guardrail-${field.key}`}>{field.label}</Label>
          <Input id={`guardrail-${field.key}`} value={current} placeholder="PATH, HOME, LANG" onChange={(event) => setDrafts((state) => ({ ...state, [field.key]: event.target.value }))} />
          <p className="text-xs text-muted-foreground">Comma-separated names. Source: {source === "env" ? "server environment (override)" : source === "ui" ? "saved setting" : "default"}</p>
        </div>;
      })}
    </div>
    <Button disabled={mutation.isPending || Object.keys(drafts).length === 0} onClick={() => {
      const patch: Record<string, BehaviorSettingValue> = {};
      for (const field of FIELDS) {
        if (!(field.key in drafts)) continue;
        patch[field.key] = field.kind === "number" ? Number(drafts[field.key]) : drafts[field.key];
      }
      for (const field of LIST_FIELDS) {
        if (field.key in drafts) patch[field.key] = drafts[field.key].split(",").map((item) => item.trim()).filter(Boolean);
      }
      mutation.mutate(patch);
    }}>{mutation.isPending ? "Saving..." : "Save guardrails"}</Button>
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : "Unable to save guardrail settings."}</p>}
  </section>;
}
