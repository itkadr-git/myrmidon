import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/context/CompanyContext";
import { useTranslation } from "@/i18n";

type PilotView = { agentIds: string[]; source: "setting" | "env" };
const path = (companyId: string) => `/myrmidon/companies/${encodeURIComponent(companyId)}/skill-lifecycle/pilot-agents`;

export function SkillPilotSettingsPanelView({ view, onSave, pending, error }: {
  view: PilotView;
  onSave: (agentIds: string[]) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? view.agentIds.join(", ");
  const ids = value.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean);
  const valid = ids.length <= 500 && ids.every((id) => id.length <= 120) && new Set(ids).size === ids.length;
  const changed = JSON.stringify(ids) !== JSON.stringify(view.agentIds);
  return <section className="mb-4 space-y-3 rounded-lg border p-4" data-testid="skill-pilot-settings">
    <h2 className="text-sm font-semibold">{t("skillLifecycle.pilot.title")}</h2>
    <p className="text-xs text-muted-foreground">{t("skillLifecycle.pilot.description", { source: view.source })}</p>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    <Label htmlFor="skill-pilot-agent-ids">{t("skillLifecycle.pilot.agentIds")}</Label>
    <Input id="skill-pilot-agent-ids" value={value} onChange={(event) => setDraft(event.target.value)} />
    <Button size="sm" disabled={pending || !valid || !changed} onClick={() => onSave(ids)}>{t("skillLifecycle.pilot.save")}</Button>
  </section>;
}

export function SkillPilotSettingsPanel() {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const companyId = selectedCompanyId ?? "";
  const key = ["myrmidon", "skill-lifecycle", "pilot-agents", companyId];
  const query = useQuery({ queryKey: key, queryFn: () => api.get<PilotView>(path(companyId)), enabled: !!companyId, retry: false });
  const save = useMutation({
    mutationFn: (agentIds: string[]) => api.put<PilotView>(path(companyId), { agentIds }),
    onSuccess: async () => { setError(null); await queryClient.invalidateQueries({ queryKey: key }); },
    onError: (err) => setError(err instanceof Error ? err.message : t("skillLifecycle.pilot.saveFailed")),
  });
  if (!companyId) return null;
  if (query.isError) return <p role="alert" className="text-sm text-destructive">{String(query.error)}</p>;
  return query.data ? <SkillPilotSettingsPanelView key={JSON.stringify(query.data)} view={query.data} onSave={(agentIds) => save.mutate(agentIds)} pending={save.isPending} error={error} /> : null;
}
