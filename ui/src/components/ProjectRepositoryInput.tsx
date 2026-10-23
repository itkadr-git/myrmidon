import { useQuery } from "@tanstack/react-query";
import type { ProjectRepository } from "@myrmidon/shared";
import { projectsApi } from "@/api/projects";
import { RepositoryEditor } from "./RepositoryEditor";
import { Button } from "./ui/button";
import { useTranslation } from "@/i18n";

export const repositoryOptionsKey = (companyId: string) => ["project-repositories", companyId] as const;

export function ProjectRepositoryInput({ companyId, selected, onChange, onConnect, disabled }: {
  companyId: string;
  selected: ProjectRepository[];
  onChange: (repos: ProjectRepository[]) => void;
  onConnect: () => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: repositoryOptionsKey(companyId), queryFn: () => projectsApi.repositoryOptions(companyId), staleTime: 30_000 });
  const state = query.isPending ? "loading" : query.isError ? "error"
    : !query.data.connectionCount ? "disconnected"
    : query.data.failedConnectionCount && !query.data.repositories.length ? "error"
    : !query.data.repositories.length ? "empty" : "ready";
  return <div className="flex min-w-0 flex-col gap-3">
    <RepositoryEditor selected={selected.map((repo) => query.data?.repositories.find((available) => available.id === repo.id) ?? repo)} onChange={onChange} available={query.data?.repositories} state={state}
      onRetry={() => void query.refetch()} onConnect={onConnect} disabled={disabled} />
    {!!query.data?.failedConnectionCount && query.data.repositories.length > 0 && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
      {t("area.projects-goals-workspaces-1.project-repository-input.someFailed")}
      <Button type="button" variant="ghost" size="sm" disabled={query.isFetching} onClick={() => void query.refetch()}>{t("area.projects-goals-workspaces-1.project-repository-input.tryAgain")}</Button>
    </div>}
  </div>;
}
