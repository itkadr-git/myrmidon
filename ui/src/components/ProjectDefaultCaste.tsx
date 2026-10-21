import { useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@myrmidon/shared";
import { projectsApi } from "@/api/projects";
import { castesApi, castesQueryKey } from "@/components/myrmidon/castes/castesApi";
import { queryKeys } from "@/lib/queryKeys";

// Optional until the backend defaultCasteKey contract lands in shared types.
type ProjectWithDefaultCaste = Project & { defaultCasteKey?: string | null };

export function ProjectDefaultCaste({ project, editable }: { project: ProjectWithDefaultCaste; editable: boolean }) {
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
      <label htmlFor={id} className="text-sm text-muted-foreground">Default caste</label>
      <select
        id={id}
        value={value ?? ""}
        disabled={!editable || directory.isPending || directory.isError || state === "saving"}
        aria-describedby={`${id}-status`}
        aria-busy={state === "saving" || directory.isPending}
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
        onChange={(event) => { void save(event.target.value); }}
      >
        <option value="">Company default</option>
        {value && !castes.some((caste) => caste.key === value) && <option value={value} disabled>{value} (unavailable)</option>}
        {castes.map((caste) => <option key={caste.key} value={caste.key}>{caste.nameRu || caste.nameEn || caste.key}</option>)}
      </select>
      <p id={`${id}-status`} role={directory.isError || state === "error" ? "alert" : "status"} className="text-xs text-muted-foreground">
        {directory.isPending ? "Loading castes..." : directory.isError ? "Could not load castes." : state === "saving" ? "Saving..." : state === "saved" ? "Default caste saved." : state === "error" ? "Could not save default caste. Select again to retry." : "Used for new tasks without an explicit caste."}
      </p>
      {directory.isError && <button type="button" className="text-sm underline" onClick={() => { void directory.refetch(); }}>Retry loading castes</button>}
    </div>
  );
}
