import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { behaviorSettingsApi, behaviorSettingsQueryKey, type BehaviorSettingValue } from "@/components/myrmidon/behaviorSettingsApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const LISTS = [
  ["bot_image_allowlist", "Container image allowlist"],
  ["bot_mount_sources", "Container mount source allowlist"],
  ["bot_container_github_env_allowlist", "Container GitHub environment allowlist"],
  ["bot_hindsight_allowed_banks", "Hindsight bank allowlist"],
  ["bot_mcp_servers", "MCP server definitions (JSON)"],
  ["browser_fleet", "Browser fleet registry (JSON)"],
] as const;
const NUMBERS = [
  ["bot_reconcile_interval_sec", "Container reconcile interval (seconds)"],
  ["browser_idle_timeout_min", "Browser idle timeout (minutes)"],
  ["browser_max_duration_min", "Browser maximum duration (minutes)"],
  ["stack_check_interval_sec", "Stack check interval (seconds; 0 disables)"],
] as const;
const FLAGS = [["bot_containers", "Enable bot container reconciliation"], ["bot_yolo", "Enable YOLO mode"]] as const;

export function FleetGuardrailsSettingsPanel() {
  const client = useQueryClient();
  const query = useQuery({ queryKey: behaviorSettingsQueryKey, queryFn: behaviorSettingsApi.get });
  const [draft, setDraft] = useState<Record<string, string>>({});
  const mutation = useMutation({
    mutationFn: (patch: Record<string, BehaviorSettingValue>) => behaviorSettingsApi.update(patch),
    onSuccess: async () => { setDraft({}); await client.invalidateQueries({ queryKey: behaviorSettingsQueryKey }); },
  });
  if (query.isLoading) return <section><h2 className="text-sm font-semibold">Fleet guardrails</h2><p>Loading settings...</p></section>;
  if (query.error || !query.data) return <section><h2 className="text-sm font-semibold">Fleet guardrails</h2><p role="alert">Unable to load fleet settings.</p></section>;
  const { settings, sources } = query.data;
  const sourceLabel = (key: string) => sources[key] === "env" ? "server environment (override)" : sources[key] === "ui" ? "saved setting" : "default";
  const bools = Object.fromEntries(FLAGS.map(([key]) => [key, draft[key] === undefined ? Boolean(settings[key]) : draft[key] === "true"]));
  return <section className="space-y-4" data-testid="fleet-guardrails-settings">
    <div><h2 className="text-sm font-semibold">Fleet guardrails</h2><p className="text-sm text-muted-foreground">Environment values remain authoritative overrides. Changes to allowlists and YOLO require confirmation.</p></div>
    <div className="grid gap-4 md:grid-cols-2">
      {LISTS.map(([key, label]) => {
        const value = settings[key];
        const initial = Array.isArray(value) ? (key === "browser_fleet" || key === "bot_mcp_servers" ? JSON.stringify(value, null, 2) : value.join(", ")) : "";
        const isJson = key === "browser_fleet" || key === "bot_mcp_servers";
        return <div key={key} className="space-y-1.5 md:col-span-2"><Label htmlFor={`fleet-${key}`}>{label}</Label>
          <textarea id={`fleet-${key}`} className="min-h-20 w-full rounded-md border border-input bg-background p-2 font-mono text-sm" value={draft[key] ?? initial} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} />
          <p className="text-xs text-muted-foreground">{isJson ? "JSON array" : "Comma-separated values"}. Source: {sourceLabel(key)}</p>
        </div>;
      })}
      {NUMBERS.map(([key, label]) => <div key={key} className="space-y-1.5"><Label htmlFor={`fleet-${key}`}>{label}</Label><Input id={`fleet-${key}`} type="number" min="0" step="1" value={draft[key] ?? String(settings[key] ?? 0)} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))} /><p className="text-xs text-muted-foreground">Source: {sourceLabel(key)}</p></div>)}
      {FLAGS.map(([key, label]) => <div key={key} className="space-y-1.5"><Label htmlFor={`fleet-${key}`}>{label}</Label><select id={`fleet-${key}`} className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm" value={String(bools[key])} onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}><option value="false">Off</option><option value="true">On</option></select><p className="text-xs text-muted-foreground">Source: {sourceLabel(key)}</p></div>)}
    </div>
    <Button disabled={mutation.isPending || !Object.keys(draft).length} onClick={() => {
      const risky = Object.keys(draft).some((key) => LISTS.some(([listKey]) => key === listKey) || key === "bot_yolo");
      if (risky && !window.confirm("Confirm changing fleet allowlists or YOLO mode? These settings affect security boundaries.")) return;
      const patch: Record<string, BehaviorSettingValue> = {};
      for (const [key] of LISTS) if (key in draft) {
        try { patch[key] = key === "browser_fleet" || key === "bot_mcp_servers" ? JSON.parse(draft[key]) : draft[key].split(",").map((v) => v.trim()).filter(Boolean); }
        catch { return; }
      }
      for (const [key] of NUMBERS) if (key in draft) patch[key] = Number(draft[key]);
      for (const [key] of FLAGS) if (key in draft) patch[key] = draft[key] === "true";
      mutation.mutate(patch);
    }}>{mutation.isPending ? "Saving..." : "Save fleet settings"}</Button>
    {mutation.error && <p role="alert" className="text-sm text-destructive">{mutation.error instanceof Error ? mutation.error.message : "Unable to save fleet settings."}</p>}
  </section>;
}
