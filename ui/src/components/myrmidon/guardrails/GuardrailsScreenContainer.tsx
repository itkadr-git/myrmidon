// myrmidon(1.7-GRD-MODES): wire tier of the "Guardrails" screen — the
// react-query state: the settings GET/PUT, the per-agent resolve GETs, the
// agents list and the journal with filters. Layout lives in
// GuardrailsScreen.tsx; the journal block is its own small view piece in
// GuardrailsJournal.tsx.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "@/i18n";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { agentsApi } from "@/api/agents";
import { ApiError } from "@/api/client";
import type { GuardrailModesSettings, ResolvedGuardrailMode } from "@paperclipai/shared";
import { GuardrailsScreenView, type GuardrailsAgentRow } from "./GuardrailsScreen";
import { GuardrailsJournal } from "./GuardrailsJournal";
import { guardrailsApi, guardrailsSettingsQueryKey, type GuardrailEventFilters } from "./guardrailsApi";

function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || `Request failed: ${error.status}`;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

/** One agent row's resolve query — a component so the hook rules hold. */
function useResolvedModes(companyId: string, agents: GuardrailsAgentRow[]) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [resolved, setResolved] = useState<Record<string, ResolvedGuardrailMode[]>>({});
  useEffect(() => {
    if (companyId.length === 0 || agents.length === 0) {
      setResolved({});
      return;
    }
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        agents.map(async (agent) => {
          try {
            const data = await guardrailsApi.resolveForAgent(companyId, agent.agentId);
            return [agent.agentId, data.rules] as const;
          } catch {
            return [agent.agentId, []] as const;
          }
        }),
      );
      if (!cancelled) setResolved(Object.fromEntries(entries));
    })();
    return () => {
      cancelled = true;
    };
  }, [companyId, agents]);
  return resolved;
}

export function GuardrailsScreen() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [error, setError] = useState<string | null>(null);
  const [journalFilters, setJournalFilters] = useState<GuardrailEventFilters>({});

  useEffect(() => {
    setBreadcrumbs([{ label: t("guardrails.breadcrumb") }]);
  }, [setBreadcrumbs, t]);

  const settingsQuery = useQuery({
    queryKey: guardrailsSettingsQueryKey(companyId),
    queryFn: () => guardrailsApi.getSettings(companyId),
    enabled: companyId.length > 0,
    retry: false,
  });

  const agentsQuery = useQuery({
    queryKey: ["agents", companyId],
    queryFn: () => agentsApi.list(companyId),
    enabled: companyId.length > 0,
    select: (agents): GuardrailsAgentRow[] =>
      agents
        .map((agent) => ({ agentId: agent.id, name: agent.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
  });

  const agentsKey = (agentsQuery.data ?? []).map((agent) => agent.agentId).join(",");
  const agents = agentsQuery.data ?? [];

  // The effective-mode column: resolved by the server per agent, so the
  // screen shows the true precedence chain (agent > caste > company >
  // default, plus env force) with its source, not a client-side guess.
  const resolvedByAgent = useResolvedModes(companyId, agents);

  const save = useMutation({
    mutationFn: (settings: GuardrailModesSettings) =>
      guardrailsApi.putSettings(companyId, settings),
    onMutate: () => setError(null),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: guardrailsSettingsQueryKey(companyId) });
      void agentsKey;
    },
    onError: (err) => setError(readable(err)),
  });

  if (companyId.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="myrmidon-guardrails-no-company">
        {t("guardrails.noCompany")}
      </p>
    );
  }

  if (settingsQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="myrmidon-guardrails-error">
        {readable(settingsQuery.error)}
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <GuardrailsScreenView
        settings={settingsQuery.data}
        agents={agents}
        resolved={resolvedByAgent}
        onSave={(next) => save.mutate(next)}
        pending={save.isPending}
        error={error}
      />
      <GuardrailsJournal
        companyId={companyId}
        filters={journalFilters}
        onFiltersChange={setJournalFilters}
      />
    </div>
  );
}
