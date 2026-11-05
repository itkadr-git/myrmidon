import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useIsInstanceAdmin } from "./licensingApi";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { RunPrioritySettings, RunPriorityPatch } from "@myrmidon/shared";

const KEY = ["myrmidon", "run-priority"] as const;
const ISSUE_PRIORITIES = ["critical", "high", "medium", "low", "none"] as const;
const ROLES = ["review", "release", "lead", "engineer", "docs"] as const;
type View = { settings: RunPrioritySettings; source: "settings" | "env" };

export function parseRunPriorityNumber(raw: string, max: number): number | null {
  if (!/^\d+$/.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value <= max ? value : null;
}

export function RunPrioritySettingsPanel() {
  const admin = useIsInstanceAdmin();
  const cache = useQueryClient();
  const { data, isLoading, error: loadError } = useQuery({ queryKey: KEY, queryFn: () => api.get<View>("/myrmidon/run-priority") });
  const [draft, setDraft] = useState<Partial<Record<string, string>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const settings = data?.settings;
  const value = (key: string, initial: string | number | null | undefined) => draft?.[key] ?? String(initial ?? "");
  const change = (key: string, next: string) => { setDraft({ ...draft, [key]: next }); setError(null); };
  const save = useMutation({
    mutationFn: (patch: RunPriorityPatch) => api.patch<View>("/myrmidon/run-priority", patch),
    onSuccess: () => { setDraft(null); setError(null); cache.invalidateQueries({ queryKey: KEY }); },
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Save failed"),
  });
  const submit = () => {
    if (!admin || !settings || !draft) return;
    const patch: RunPriorityPatch = {};
    for (const [key, raw] of Object.entries(draft)) {
      if (typeof raw !== "string") continue;
      if (key === "currentRelease") {
        patch.currentRelease = raw.trim() || null;
        if (raw.length > 64) { setError("Release must be at most 64 characters."); return; }
        continue;
      }
      if (key === "enabled") { patch.enabled = raw === "true"; continue; }
      const max = key === "starvationTopWeight" ? 1_000_000 :
        key === "starvationLimitMinutes" ? 239 : key === "agingMaxBonus" ? 10_000 :
          key === "agingStepMinutes" ? 1440 : 1000;
      const numeric = parseRunPriorityNumber(raw, max);
      if (numeric === null) { setError(`${key}: enter an integer between 0 and ${max}.`); return; }
      if (key.startsWith("issue:")) patch.issuePriorityWeights = { ...patch.issuePriorityWeights, [key.slice(6)]: numeric };
      else if (key.startsWith("role:")) patch.roleWeights = { ...patch.roleWeights, [key.slice(5)]: numeric };
      else Object.assign(patch, { [key]: numeric });
    }
    save.mutate(patch);
  };
  return (
    <section className="space-y-4 rounded-lg border p-4" data-testid="run-priority-settings">
      <div><h2 className="text-sm font-semibold">Run queue priority</h2><p className="text-xs text-muted-foreground">Source: {data?.source ?? "loading"}. Changes apply to the live queue without restart.</p></div>
      {isLoading && <p>Loading priority settings...</p>}
      {loadError && <p role="alert" className="text-destructive">{String(loadError)}</p>}
      {settings && <>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={draft?.enabled !== undefined ? draft.enabled === "true" : settings.enabled} disabled={!admin} onChange={(event) => change("enabled", String(event.target.checked))} />Enabled</label>
        <div className="grid gap-3 md:grid-cols-2">
          {ROLES.map((role) => <div key={role}><Label htmlFor={`queue-role-${role}`}>{role} role weight</Label><Input id={`queue-role-${role}`} inputMode="numeric" disabled={!admin} value={value(`role:${role}`, settings.roleWeights[role])} onChange={(event) => change(`role:${role}`, event.target.value)} /></div>)}
          {ISSUE_PRIORITIES.map((priority) => <div key={priority}><Label htmlFor={`queue-issue-${priority}`}>{priority} issue weight</Label><Input id={`queue-issue-${priority}`} inputMode="numeric" disabled={!admin} value={value(`issue:${priority}`, settings.issuePriorityWeights[priority])} onChange={(event) => change(`issue:${priority}`, event.target.value)} /></div>)}
          {(["defaultRoleWeight", "releaseBonus", "agingStepMinutes", "agingStepWeight", "agingMaxBonus", "starvationLimitMinutes", "starvationTopWeight", "pheromoneWeight"] as const).map((key) => <div key={key}><Label htmlFor={`queue-${key}`}>{key}</Label><Input id={`queue-${key}`} inputMode="numeric" disabled={!admin} value={value(key, settings[key])} onChange={(event) => change(key, event.target.value)} /></div>)}
          <div><Label htmlFor="queue-current-release">Current release</Label><Input id="queue-current-release" disabled={!admin} value={value("currentRelease", settings.currentRelease)} onChange={(event) => change("currentRelease", event.target.value)} /></div>
        </div>
        {error && <p role="alert" className="text-destructive">{error}</p>}
        <Button size="sm" disabled={!admin || !draft || save.isPending} onClick={submit}>Save queue priority</Button>
      </>}
    </section>
  );
}
