import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { projectsApi } from "@/api/projects";
import { castesApi, castesQueryKey } from "@/components/myrmidon/castes/castesApi";
import { queryKeys } from "@/lib/queryKeys";
import { useTranslation } from "@/i18n";

// Optional until the backend defaultCasteKey contract lands in shared types.
type ProjectWithDefaultCaste = Project & { defaultCasteKey?: string | null };

export function ProjectDefaultCaste({ project, editable }: { project: ProjectWithDefaultCaste; editable: boolean }) {
  const { t } = useTranslation();
  const id = useId();
  const client = useQueryClient();
  const directory = useQuery({
    queryKey: castesQueryKey(project.companyId),
    queryFn: () => castesApi.view(project.companyId),
    retry: false,
  });
  const [saved, setSaved] = useState<{ projectId: string; value: string | null } | null>(null);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const value = saved?.projectId === project.id ? saved.value : project.defaultCasteKey ?? null;
  const castes = directory.data?.castes ?? [];
  async function save(next: string) {
    if (!editable || directory.isPending || directory.isError || state === "saving" || next === (value ?? "")) return;
    setState("saving");
    try {
      await projectsApi.update(project.id, { defaultCasteKey: next || null }, project.companyId);
      setSaved({ projectId: project.id, value: next || null });
      setState("saved");
      void client.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
      void client.invalidateQueries({ queryKey: queryKeys.projects.list(project.companyId) });
    } catch {
      setState("error");
    }
  }
  return (
    <div className="space-y-2 py-2">
      <label htmlFor={id} className="text-sm text-muted-foreground">{t("area.projects-goals-workspaces-1.project-default-caste.label")}</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={!editable || directory.isPending || directory.isError || state === "saving"}
        aria-describedby={`${id}-status`}
        aria-busy={state === "saving" || directory.isPending}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        onChange={(event) => { void save(event.target.value); }}
      >
        <option value="">{t("area.projects-goals-workspaces-1.project-default-caste.companyDefault")}</option>
        {value && !castes.some((caste) => caste.key === value) && <option value={value} disabled>{t("area.projects-goals-workspaces-1.project-default-caste.unavailable", { value })}</option>}
        {castes.map((caste) => <option key={caste.key} value={caste.key}>{caste.nameRu || caste.nameEn || caste.key}</option>)}
      </select>
      <p id={`${id}-status`} role={directory.isError || state === "error" ? "alert" : "status"} className="text-xs text-muted-foreground">
        {directory.isPending ? t("area.projects-goals-workspaces-1.project-default-caste.loading") : directory.isError ? t("area.projects-goals-workspaces-1.project-default-caste.loadFailed") : state === "saving" ? t("area.projects-goals-workspaces-1.project-default-caste.saving") : state === "saved" ? t("area.projects-goals-workspaces-1.project-default-caste.saved") : state === "error" ? t("area.projects-goals-workspaces-1.project-default-caste.saveFailed") : t("area.projects-goals-workspaces-1.project-default-caste.hint")}
      </p>
      {directory.isError && <button type="button" className="text-sm underline" onClick={() => { void directory.refetch(); }}>{t("area.projects-goals-workspaces-1.project-default-caste.retry")}</button>}
    </div>
  );
}
