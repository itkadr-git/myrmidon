// Self-hosted GitHub App identities (myrmidon GITHUB-SHARED-IDENTITY):
// "authorize once for the whole server". One entry per GitHub App
// installation: the App id, the company secret holding its private key, the
// optional installation id, the agents (roles and/or agents) and the
// repositories it serves. The board mints single-repository installation
// tokens itself; a repository matched by two entries is refused. Commits stay
// authored by the agent. Saving applies at the next operation — no restart.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import type { Agent, CompanySecret } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { SecretPicker } from "@/components/environment-variables-editor/SecretPicker";
import { agentsApi } from "@/api/agents";
import { secretsApi } from "@/api/secrets";
import { useCompany } from "@/context/CompanyContext";
import { queryKeys } from "@/lib/queryKeys";
import {
  githubSharedIdentityApi,
  githubSharedIdentityQueryKey,
  splitList,
  type GitHubSharedIdentityPut,
  type GitHubSharedIdentityView,
} from "./githubSharedIdentityApi";

type AppDraft = {
  id: string;
  name: string;
  appId: string;
  privateKeySecretId: string;
  installationId: string;
  roles: string;
  agentIds: string[];
  allowedRepos: string;
};

type Draft = { enabled: boolean; commitEmailDomain: string; apps: AppDraft[] };

function draftFrom(view: GitHubSharedIdentityView): Draft {
  return {
    enabled: view.settings.enabled,
    commitEmailDomain: view.settings.commitEmailDomain ?? "",
    apps: view.settings.apps.map((app) => ({
      id: app.id,
      name: app.name,
      appId: app.appId,
      privateKeySecretId: app.privateKeySecretId,
      installationId: app.installationId ?? "",
      roles: app.roles.join(", "),
      agentIds: app.agentIds,
      allowedRepos: app.allowedRepos.join("\n"),
    })),
  };
}

/** The PUT body for a draft. */
export function bodyFromDraft(draft: Draft): GitHubSharedIdentityPut {
  return {
    enabled: draft.enabled,
    commitEmailDomain: draft.commitEmailDomain.trim() || null,
    apps: draft.apps.map((app) => ({
      id: app.id,
      name: app.name.trim(),
      appId: app.appId.trim(),
      privateKeySecretId: app.privateKeySecretId,
      installationId: app.installationId.trim() || null,
      roles: splitList(app.roles),
      agentIds: app.agentIds,
      allowedRepos: splitList(app.allowedRepos),
    })),
  };
}

function newEntryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16));
}

export function GitHubSharedIdentityPanelView({
  view,
  agents,
  secrets,
  onSave,
  pending,
  error,
  newId = newEntryId,
}: {
  view: GitHubSharedIdentityView | null | undefined;
  agents: readonly Pick<Agent, "id" | "name" | "role">[];
  secrets: readonly CompanySecret[];
  onSave: (body: GitHubSharedIdentityPut) => void;
  pending: boolean;
  error: string | null;
  newId?: () => string;
}) {
  // The draft follows a new server view (after load or save): derived state,
  // reset during render when the view object changes.
  const [state, setState] = useState<{ view: GitHubSharedIdentityView | null | undefined; draft: Draft | null }>(
    () => ({ view, draft: view ? draftFrom(view) : null }),
  );
  if (state.view !== view) setState({ view, draft: view ? draftFrom(view) : null });
  const draft = state.view === view ? state.draft : view ? draftFrom(view) : null;
  const setDraft = (next: (current: Draft) => Draft) =>
    setState((current) => ({ ...current, draft: current.draft ? next(current.draft) : current.draft }));
  const dirty = useMemo(
    () => Boolean(view && draft && JSON.stringify(bodyFromDraft(draft)) !== JSON.stringify(bodyFromDraft(draftFrom(view)))),
    [view, draft],
  );
  const updateApp = (id: string, patch: Partial<AppDraft>) =>
    setDraft((current) => ({ ...current, apps: current.apps.map((app) => (app.id === id ? { ...app, ...patch } : app)) }));

  return (
    <section className="space-y-4" data-testid="myrmidon-github-shared-identity">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <KeyRound className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Shared GitHub authorization (self-hosted GitHub Apps)</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Authorize GitHub once for the whole server with your own GitHub App: register one App per account or
          organization, install it on that product’s repositories, store its private key as a company secret and add it
          here. The board mints short-lived tokens for one repository at a time (contents and pull requests read/write,
          metadata read). Each operation gets the App whose repositories match its target; a repository matched by two
          Apps is refused. Commits stay authored by the agent. Saving applies to the next operation — no restart.
        </p>
        {view ? (
          <p className="text-xs text-muted-foreground" data-testid="github-vendor-connector-state">
            {view.vendorConnectorEnabled
              ? "The vendor cloud GitHub connector is enabled on this instance."
              : "The vendor cloud GitHub connector is disabled on this instance."}
          </p>
        ) : null}
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {!view || !draft ? (
        <p className="text-sm text-muted-foreground">Loading the GitHub App identities...</p>
      ) : (
        <div className="space-y-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Use GitHub App identities"
              checked={draft.enabled}
              onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))}
            />
            Use GitHub App identities
          </label>

          {draft.apps.map((app, index) => {
            const label = app.name.trim() || `App ${index + 1}`;
            return (
              <div key={app.id} className="space-y-3 rounded-md border border-border p-4" data-testid={`github-app-${index}`}>
                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="grid gap-1 text-sm">
                    Name
                    <Input aria-label={`Name of ${label}`} value={app.name} onChange={(event) => updateApp(app.id, { name: event.target.value })} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    GitHub App id
                    <Input aria-label={`App id of ${label}`} value={app.appId} onChange={(event) => updateApp(app.id, { appId: event.target.value })} />
                  </label>
                  <label className="grid gap-1 text-sm">
                    Installation id (empty: found per repository)
                    <Input
                      aria-label={`Installation id of ${label}`}
                      value={app.installationId}
                      onChange={(event) => updateApp(app.id, { installationId: event.target.value })}
                    />
                  </label>
                </div>
                <div className="grid gap-1 text-sm">
                  Private key (company secret, PEM)
                  <SecretPicker
                    secretId={app.privateKeySecretId}
                    secrets={secrets}
                    onSelect={(secretId) => updateApp(app.id, { privateKeySecretId: secretId })}
                  />
                </div>
                <label className="grid gap-1 text-sm">
                  Allowed repositories (owner/repo or owner/*, one per line)
                  <Textarea
                    aria-label={`Allowed repositories of ${label}`}
                    value={app.allowedRepos}
                    onChange={(event) => updateApp(app.id, { allowedRepos: event.target.value })}
                    rows={3}
                  />
                </label>
                <label className="grid gap-1 text-sm">
                  Roles (comma-separated, e.g. engineer)
                  <Input aria-label={`Roles of ${label}`} value={app.roles} onChange={(event) => updateApp(app.id, { roles: event.target.value })} />
                </label>
                <fieldset className="grid gap-1 text-sm">
                  <legend>Agents (in addition to the roles)</legend>
                  <div className="flex max-h-48 flex-col gap-1 overflow-auto">
                    {agents.map((agent) => (
                      <label key={agent.id} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          aria-label={`${agent.name} may use ${label}`}
                          checked={app.agentIds.includes(agent.id)}
                          onChange={(event) =>
                            updateApp(app.id, {
                              agentIds: event.target.checked
                                ? [...app.agentIds, agent.id]
                                : app.agentIds.filter((id) => id !== agent.id),
                            })
                          }
                        />
                        <span>{agent.name}</span>
                        <span className="text-xs text-muted-foreground">{agent.role}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setDraft((current) => ({ ...current, apps: current.apps.filter((candidate) => candidate.id !== app.id) }))}
                >
                  <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove {label}
                </Button>
              </div>
            );
          })}

          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              setDraft((current) => ({
                ...current,
                apps: [
                  ...current.apps,
                  { id: newId(), name: "", appId: "", privateKeySecretId: "", installationId: "", roles: "", agentIds: [], allowedRepos: "" },
                ],
              }))
            }
          >
            <Plus className="mr-1 h-3.5 w-3.5" /> Add GitHub App
          </Button>

          <label className="grid max-w-md gap-1 text-sm">
            Commit email domain of the agents (empty: a reserved placeholder domain)
            <Input
              aria-label="Commit email domain"
              placeholder="example.com"
              value={draft.commitEmailDomain}
              onChange={(event) => setDraft((current) => ({ ...current, commitEmailDomain: event.target.value }))}
            />
          </label>

          <div>
            <Button type="button" size="sm" disabled={pending || !dirty} onClick={() => onSave(bodyFromDraft(draft))}>
              {pending ? "Saving..." : "Save GitHub access"}
            </Button>
          </div>
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
  const secretsQuery = useQuery({
    queryKey: queryKeys.secrets.list(companyId),
    queryFn: () => secretsApi.list(companyId),
    enabled: Boolean(companyId),
  });
  const save = useMutation({
    mutationFn: (body: GitHubSharedIdentityPut) => githubSharedIdentityApi.save(companyId, body),
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the GitHub App identities failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: githubSharedIdentityQueryKey(companyId) });
    },
  });

  if (!companyId) return null;
  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the GitHub App identities."}
      </div>
    );
  }
  return (
    <GitHubSharedIdentityPanelView
      view={query.data}
      agents={agentsQuery.data ?? []}
      secrets={(secretsQuery.data ?? []).filter((secret) => secret.scope === "company")}
      onSave={(body) => save.mutate(body)}
      pending={save.isPending}
      error={error}
    />
  );
}
