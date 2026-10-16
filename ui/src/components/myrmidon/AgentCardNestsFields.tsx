// myrmidon(1.6.5 F-26 T3 CASTES-AND-NESTS): the "Nests" section of an agent
// card — the multi-select of projects the agent is willing to work in.
//
// Empty = the whole company (the agent takes every task, including the ones
// that belong to no project). Saving is immediate, like the egress section: the
// matcher reads `agent_nests` fresh on its next pass, so a save needs no bot
// restart and no redeploy.
//
// The view half is pure so the suite renders it without a query client.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { projectsApi } from "../../api/projects";
import { CollapsibleSection, Field } from "../agent-config-primitives";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { agentNestsApi, agentNestsQueryKey } from "./agentNestsApi";

export interface AgentNestsProjectOption {
  id: string;
  name: string;
}

export interface AgentCardNestsFieldsViewProps {
  projects: AgentNestsProjectOption[];
  picked: string[];
  saving: boolean;
  error: string | null;
  savedNote: string | null;
  onToggle: (projectId: string) => void;
  onSave: () => void;
}

export function AgentCardNestsFieldsView({
  projects,
  picked,
  saving,
  error,
  savedNote,
  onToggle,
  onSave,
}: AgentCardNestsFieldsViewProps) {
  const { t } = useTranslation();
  return (
    <CollapsibleSection title={t("nests.title")} open onToggle={() => {}}>
      <div className="space-y-3" data-testid="myrmidon-agent-nests">
        <p className="text-xs text-muted-foreground">{t("nests.intro")}</p>

        <Field label={t("nests.label")} hint={t("nests.hint")}>
          {projects.length === 0 ? (
            <p className="text-xs text-muted-foreground" data-testid="myrmidon-agent-nests-no-projects">
              {t("nests.noProjects")}
            </p>
          ) : (
            <div className="space-y-1.5">
              {projects.map((project) => (
                <label key={project.id} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    aria-label={project.name}
                    data-testid={`myrmidon-agent-nests-${project.id}`}
                    checked={picked.includes(project.id)}
                    onChange={() => onToggle(project.id)}
                  />
                  <span className="truncate">{project.name}</span>
                </label>
              ))}
            </div>
          )}
        </Field>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onSave}
            disabled={saving}
            data-testid="myrmidon-agent-nests-save"
          >
            {saving ? t("nests.saving") : t("nests.save")}
          </Button>
          <span className="text-xs text-muted-foreground" data-testid="myrmidon-agent-nests-summary">
            {picked.length === 0 ? t("nests.allProjects") : t("nests.selected", { count: picked.length })}
          </span>
          {savedNote && (
            <span className="text-xs text-muted-foreground" data-testid="myrmidon-agent-nests-saved">
              {savedNote}
            </span>
          )}
        </div>
        {error && (
          <p className="text-xs text-destructive" data-testid="myrmidon-agent-nests-error">
            {error}
          </p>
        )}
      </div>
    </CollapsibleSection>
  );
}

/** The connected section: reads this agent's nests and the company's projects. */
export function AgentCardNestsFields({ agentId }: { agentId: string }) {
  const { selectedCompanyId } = useCompany();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);

  const nests = useQuery({
    queryKey: agentNestsQueryKey(selectedCompanyId ?? "none", agentId),
    queryFn: () => agentNestsApi.get(selectedCompanyId as string, agentId),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const projects = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId ?? "none"),
    queryFn: () => projectsApi.list(selectedCompanyId as string),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });

  const stored = nests.data?.projectIds ?? [];
  const storedKey = JSON.stringify(stored);
  // A fresh answer from the server clears the unsaved edit.
  useEffect(() => {
    setPicked(JSON.parse(storedKey) as string[]);
  }, [storedKey]);

  const save = useMutation({
    mutationFn: (projectIds: string[]) =>
      agentNestsApi.put(selectedCompanyId as string, agentId, projectIds),
    onSuccess: (view) => {
      setError(null);
      setSavedNote(t("nests.saved"));
      queryClient.setQueryData(agentNestsQueryKey(selectedCompanyId ?? "none", agentId), view);
    },
    onError: (err) => {
      setSavedNote(null);
      setError(err instanceof Error ? err.message : t("nests.saveFailed"));
    },
  });

  const value = picked ?? stored;

  return (
    <AgentCardNestsFieldsView
      projects={(projects.data ?? []).map((project) => ({ id: project.id, name: project.name }))}
      picked={value}
      saving={save.isPending}
      error={error}
      savedNote={savedNote}
      onToggle={(projectId) => {
        setSavedNote(null);
        setPicked((current) => {
          const base = current ?? stored;
          return base.includes(projectId)
            ? base.filter((id) => id !== projectId)
            : [...base, projectId];
        });
      }}
      onSave={() => {
        setError(null);
        setSavedNote(null);
        save.mutate(value);
      }}
    />
  );
}