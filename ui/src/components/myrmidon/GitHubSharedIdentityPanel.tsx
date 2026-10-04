// Shared GitHub authorization (myrmidon GITHUB-SHARED-IDENTITY): "authorize
// once for the whole server". Lists the company's shared GitHub connections
// and edits, per connection, which agents may use it (roles and/or agents)
// and for which repositories (owner/repo patterns). The broker picks the
// identity by the repository of each git/gh operation; a repository matched
// by two connections is refused. Saving applies at the next operation —
// no restart. The commit author stays the agent.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import type { Agent } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { agentsApi } from "@/api/agents";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  githubSharedIdentityApi,
  githubSharedIdentityQueryKey,
  splitList,
  type GitHubSharedIdentityPut,
  type GitHubSharedIdentityView,
} from "./githubSharedIdentityApi";

type RuleDraft = {
  enabled: boolean;
  roles: string;
  agentIds: string[];
  allowedRepos: string;
};

type Draft = {
  enabled: boolean;
  commitEmailDomain: string;
  rules: Record<string, RuleDraft>;
};

function draftFrom(view: GitHubSharedIdentityView): Draft {
  const rules: Record<string, RuleDraft> = {};
  for (const connection of view.connections) {
    const rule = view.settings.connections.find((candidate) => candidate.connectionId === connection.id);
    rules[connection.id] = {
      enabled: Boolean(rule),
      roles: (rule?.roles ?? []).join(", "),
      agentIds: rule?.agentIds ?? [],
      allowedRepos: (rule?.allowedRepos ?? []).join("\n"),
    };
  }
  return {
    enabled: view.settings.enabled,
    commitEmailDomain: view.settings.commitEmailDomain ?? "",
    rules,
  };
}

/** The PUT body for a draft: only connections with a rule turned on. */
export function bodyFromDraft(draft: Draft): GitHubSharedIdentityPut {
  return {
    enabled: draft.enabled,
    commitEmailDomain: draft.commitEmailDomain.trim() || null,
    connections: Object.entries(draft.rules)
      .filter(([, rule]) => rule.enabled)
      .map(([connectionId, rule]) => ({
        connectionId,
        roles: splitList(rule.roles),
        agentIds: rule.agentIds,
        allowedRepos: splitList(rule.allowedRepos),
      })),
  };
}

export function GitHubSharedIdentityPanelView({
  view,
  agents,
  onSave,
  pending,
  error,
}: {
  view: GitHubSharedIdentityView | null | undefined;
  agents: readonly Pick<Agent, "id" | "name" | "role">[];
  onSave: (body: GitHubSharedIdentityPut) => void;
  pending: boolean;
  error: string | null;
}) {
  // The draft follows a new server view (after load or save) without an
  // effect: derived state, reset during render when the view object changes.
  const [state, setState] = useState<{ view: GitHubSharedIdentityView | null | undefined; draft: Draft | null }>(
    () => ({ view, draft: view ? draftFrom(view) : null }),
  );
  if (state.view !== view) setState({ view, draft: view ? draftFrom(view) : null });
  const draft = state.view === view ? state.draft : view ? draftFrom(view) : null;
  const setDraft = (next: Draft | ((current: Draft | null) => Draft | null)) =>
    setState((current) => ({
      ...current,
      draft: typeof next === "function" ? next(current.draft) : next,
    }));
  const dirty = useMemo(
    () => Boolean(view && draft && JSON.stringify(bodyFromDraft(draft)) !== JSON.stringify(bodyFromDraft(draftFrom(view)))),
    [view, draft],
  );

  const updateRule = (connectionId: string, patch: Partial<RuleDraft>) =>
    setDraft((current) =>
      current
        ? { ...current, rules: { ...current.rules, [connectionId]: { ...current.rules[connectionId]!, ...patch } } }
        : current,
    );

  return (
    <section className="space-y-4" data-testid="myrmidon-github-shared-identity">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Shared GitHub authorization</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Authorize GitHub once for the whole server: create a GitHub connection under Apps with the “Shared company
          GitHub account” identity, then choose here which agents may use it and for which repositories. Each git or gh
          operation gets the connection whose repositories match its target; a repository matched by two connections is
          refused. Commits stay authored by the agent. Saving applies to the next operation — no restart.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!view || !draft ? (
        <p className="text-sm text-muted-foreground">Loading the shared GitHub authorization...</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Use shared GitHub authorizations"
              checked={draft.enabled}
              onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
            />
            Use shared GitHub authorizations
          </label>

          {view.connections.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="github-shared-no-connections">
              No shared GitHub connection yet. Connect GitHub under Apps and choose “Shared company GitHub account”.
            </p>
          ) : (
            view.connections.map((connection) => {
              const rule = draft.rules[connection.id]!;
              return (
                <div
                  key={connection.id}
                  className="space-y-3 rounded-md border border-border p-4"
                  data-testid={`github-shared-connection-${connection.id}`}
                >
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-medium">{connection.name}</span>
                    <span className="text-muted-foreground">
                      {connection.grant?.login ? `as ${connection.grant.login}` : "not authorized yet"}
                      {connection.grant?.repositoryCount != null ? ` · ${connection.grant.repositoryCount} repositories` : ""}
                      {connection.installedForCompany ? "" : " · not installed for the company"}
                      {connection.grant && connection.grant.status !== "active" ? ` · ${connection.grant.status}` : ""}
                    </span>
                  </div>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={`Allow agents to use ${connection.name}`}
                      checked={rule.enabled}
                      onChange={(event) => updateRule(connection.id, { enabled: event.target.checked })}
                    />
                    Allow agents to use this connection
                  </label>
                  {rule.enabled ? (
                    <div className="grid gap-3">
                      <label className="grid gap-1 text-sm">
                        Allowed repositories (owner/repo or owner/*, one per line)
                        <Textarea
                          aria-label={`Allowed repositories for ${connection.name}`}
                          value={rule.allowedRepos}
                          onChange={(event) => updateRule(connection.id, { allowedRepos: event.target.value })}
                          rows={3}
                        />
                      </label>
                      <label className="grid gap-1 text-sm">
                        Roles (comma-separated, e.g. engineer)
                        <Input
                          aria-label={`Roles for ${connection.name}`}
                          value={rule.roles}
                          onChange={(event) => updateRule(connection.id, { roles: event.target.value })}
                        />
                      </label>
                      <fieldset className="grid gap-1 text-sm">
                        <legend>Agents (in addition to the roles)</legend>
                        <div className="flex max-h-48 flex-col gap-1 overflow-auto">
                          {agents.map((agent) => (
                            <label key={agent.id} className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                aria-label={`${agent.name} may use ${connection.name}`}
                                checked={rule.agentIds.includes(agent.id)}
                                onChange={(event) =>
                                  updateRule(connection.id, {
                                    agentIds: event.target.checked
                                      ? [...rule.agentIds, agent.id]
                                      : rule.agentIds.filter((id) => id !== agent.id),
                                  })
                                }
                              />
                              <span>{agent.name}</span>
                              <span className="text-xs text-muted-foreground">{agent.role}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>
                    </div>
                  ) : null}
                </div>
              );
            })
          )}

          <label className="grid max-w-md gap-1 text-sm">
            Commit email domain of the agents (empty: a reserved placeholder domain)
            <Input
              aria-label="Commit email domain"
              placeholder="example.com"
              value={draft.commitEmailDomain}
              onChange={(event) => setDraft({ ...draft, commitEmailDomain: event.target.value })}
            />
          </label>

          <Button type="button" size="sm" disabled={pending || !dirty} onClick={() => onSave(bodyFromDraft(draft))}>
            {pending ? "Saving..." : "Save GitHub access"}
          </Button>
        </div>
      )}
    </section>
  );
}

export function GitHubSharedIdentityPanel() {
  const { selectedCompanyId } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: githubSharedIdentityQueryKey(companyId),
    queryFn: () => githubSharedIdentityApi.get(companyId),
    enabled: Boolean(companyId),
    retry: false,
  });
  const agentsQuery = useQuery({
    queryKey: queryKeys.agents.list(companyId),
    queryFn: () => agentsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const save = useMutation({
    mutationFn: (body: GitHubSharedIdentityPut) => githubSharedIdentityApi.save(companyId, body),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the GitHub access rules failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: githubSharedIdentityQueryKey(companyId) });
    },
  });

  if (!companyId) return null;
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the shared GitHub authorization."}
      </div>
    );
  }
  return (
    <GitHubSharedIdentityPanelView
      view={query.data}
      agents={agentsQuery.data ?? []}
      onSave={(body) => save.mutate(body)}
      pending={save.isPending}
      error={error}
    />
  );
}
