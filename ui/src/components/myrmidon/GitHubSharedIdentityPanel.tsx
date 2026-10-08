// Self-hosted GitHub App identities (myrmidon GITHUB-SHARED-IDENTITY):
// "authorize once for the whole server". One entry per GitHub App
// installation: the App id, the company secret holding its private key, the
// optional installation id, the agents (roles and/or agents), the
// repositories it serves and the permission list (contents, pull requests,
// workflows, issues…; default contents + pull requests write) the broker
// requests verbatim on every token. The board mints single-repository
// installation tokens itself; a repository matched by two entries is refused.
// Commits stay authored by the agent. Saving applies at the next operation —
// no restart.
//
// myrmidon(GITHUB-APP-MANIFEST): the one-click creation path. "Create GitHub
// App" asks the server for a manifest, then POSTs it to github.com (the
// official manifest flow); GitHub redirects back to the server callback,
// which lands here with ?github_app_created=1 or ?github_app_error=<message>.
// The manual path (App id + key secret) is untouched.
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
import { useTranslation } from "@/i18n";
import { queryKeys } from "@/lib/queryKeys";
import {
  githubSharedIdentityApi,
  githubSharedIdentityQueryKey,
  splitList,
  type BeginAppManifestBody,
  GITHUB_APP_PERMISSION_KEYS,
  DEFAULT_GITHUB_APP_PERMISSIONS,
  githubAppPermissionLabel,
  githubAppPermissionLevelsFor,
  type GitHubAppPermissionLevel,
  type GitHubAppPermissions,
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
  permissions: GitHubAppPermissions;
  /** myrmidon(GITHUB-APP-MANIFEST): slug of a manifest-created App; not part
   * of the PUT body (the server owns it), kept in the draft only for render. */
  slug?: string | null;
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
      permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS, ...(app.permissions ?? {}) },
      slug: app.slug ?? null,
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
      permissions: { ...app.permissions },
    })),
  };
}

function newEntryId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : "00000000-0000-4000-8000-000000000000".replace(/0/g, () => Math.floor(Math.random() * 16).toString(16));
}

// myrmidon(GITHUB-APP-MANIFEST): outcome of the server callback, read once
// from the page query string (?github_app_created=1 / ?github_app_error=...).
// The parameters are removed from the URL afterwards so a reload does not
// repeat the notice.
export type ManifestCallbackNotice = { kind: "created" } | { kind: "error"; message: string } | null;

export function readManifestCallbackNotice(search: string): ManifestCallbackNotice {
  const params = new URLSearchParams(search);
  if (params.has("github_app_created")) return { kind: "created" };
  const message = params.get("github_app_error");
  if (message) return { kind: "error", message };
  return null;
}

export function clearManifestCallbackQuery(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("github_app_created") && !url.searchParams.has("github_app_error")) return;
  url.searchParams.delete("github_app_created");
  url.searchParams.delete("github_app_error");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

/** myrmidon(GITHUB-APP-MANIFEST): POST the manifest to github.com — the
 * official way GitHub accepts a manifest (a POST form, not a JSON call).
 * The anti-CSRF `state` travels as its own form field; GitHub echoes it back
 * on the callback redirect, where the server validates it. */
export function submitManifestForm(
  manifestUrl: string,
  manifest: Record<string, unknown>,
  state: string,
): void {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = manifestUrl;
  const input = document.createElement("input");
  input.type = "hidden";
  input.name = "manifest";
  input.value = JSON.stringify(manifest);
  form.appendChild(input);
  const stateInput = document.createElement("input");
  stateInput.type = "hidden";
  stateInput.name = "state";
  stateInput.value = state;
  form.appendChild(stateInput);
  document.body.appendChild(form);
  form.submit();
}

type ManifestDialogState =
  | { open: false }
  | { open: true; ownerKind: "user" | "org"; orgLogin: string; name: string; description: string };

/** myrmidon(GITHUB-APP-MANIFEST): the description pre-filled in the create
 * dialog, in the exact English wording the GitHub App page should carry. The
 * Russian rendering sits next to the field (descriptionDefaultRu). */
export const DEFAULT_APP_DESCRIPTION =
  "Lets the agents of your Myrmidon server push branches and open pull requests in the repositories you choose. Tokens are issued by your own Myrmidon server; no third-party service is involved.";

export function GitHubSharedIdentityPanelView({
  view,
  agents,
  secrets,
  onSave,
  pending,
  error,
  newId = newEntryId,
  onBeginAppManifest,
  manifestPending = false,
  manifestError = null,
  onInstallApp,
  installPendingEntryId = null,
  companyName = null,
}: {
  view: GitHubSharedIdentityView | null | undefined;
  agents: readonly Pick<Agent, "id" | "name" | "role">[];
  secrets: readonly CompanySecret[];
  onSave: (body: GitHubSharedIdentityPut) => void;
  pending: boolean;
  error: string | null;
  newId?: () => string;
  // myrmidon(GITHUB-APP-MANIFEST): optional manifest-flow hooks. The view
  // renders the Create GitHub App dialog against these; the container wires
  // them to the server. Tests of the view inject spies directly.
  onBeginAppManifest?: (body: BeginAppManifestBody) => void;
  manifestPending?: boolean;
  manifestError?: string | null;
  onInstallApp?: (entryId: string) => void;
  installPendingEntryId?: string | null;
  companyName?: string | null;
}) {
  const { t } = useTranslation();
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

  const defaultAppName = companyName ? `Myrmidon — ${companyName}` : "Myrmidon";
  const [manifestDialog, setManifestDialog] = useState<ManifestDialogState>({ open: false });
  const openManifestDialog = () =>
    setManifestDialog({
      open: true,
      ownerKind: "user",
      orgLogin: "",
      name: defaultAppName,
      description: DEFAULT_APP_DESCRIPTION,
    });
  const submitManifestDialog = () => {
    if (!manifestDialog.open || !onBeginAppManifest) return;
    const body: BeginAppManifestBody = {
      ownerKind: manifestDialog.ownerKind,
      ...(manifestDialog.ownerKind === "org" && manifestDialog.orgLogin.trim()
        ? { orgLogin: manifestDialog.orgLogin.trim() }
        : {}),
      name: manifestDialog.name.trim(),
      ...(manifestDialog.description.trim() ? { description: manifestDialog.description.trim() } : {}),
    };
    onBeginAppManifest(body);
  };

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
          here. The board mints short-lived tokens for one repository at a time with exactly the permissions listed on
          the entry (by default contents and pull requests write; Workflows can be allowed where the App registration
          permits it). Each operation gets the App whose repositories match its target; a repository matched by two
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

      {manifestError ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="github-app-manifest-error"
        >
          {manifestError}
          <p className="mt-1 text-xs">{t("githubSharedIdentity.manifest.uniqueNameHint")}</p>
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
                <fieldset
                  className="grid gap-1 text-sm"
                  data-testid={`github-app-permissions-${index}`}
                >
                  <legend>Token permissions (the broker requests exactly these)</legend>
                  <p className="text-xs text-muted-foreground">
                    None: never requested; the token can only do what is set here. Workflows lets agents edit
                    .github/workflows/* where the App registration allows it.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                    {GITHUB_APP_PERMISSION_KEYS.map((key) => (
                      <label key={key} className="grid gap-1 text-sm">
                        {githubAppPermissionLabel(key)}
                        <select
                          aria-label={`Permissions of ${label}: ${key}`}
                          value={app.permissions[key]}
                          onChange={(event) =>
                            updateApp(app.id, {
                              permissions: { ...app.permissions, [key]: event.target.value as GitHubAppPermissionLevel },
                            })
                          }
                        >
                          {githubAppPermissionLevelsFor(key).map((level) => (
                            <option key={level} value={level}>
                              {level}
                            </option>
                          ))}
                        </select>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDraft((current) => ({ ...current, apps: current.apps.filter((candidate) => candidate.id !== app.id) }))}
                    >
                      <Trash2 className="mr-1 h-3.5 w-3.5" /> Remove {label}
                    </Button>
                    {app.slug && onInstallApp ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={installPendingEntryId === app.id}
                        onClick={() => onInstallApp(app.id)}
                      >
                        {installPendingEntryId === app.id
                          ? t("githubSharedIdentity.manifest.installing")
                          : t("githubSharedIdentity.manifest.installButton")}
                      </Button>
                    ) : null}
                  </div>
                  {app.slug && onInstallApp ? (
                    <p className="text-xs text-muted-foreground">{t("githubSharedIdentity.manifest.installHint")}</p>
                  ) : null}
                </div>
              </div>
            );
          })}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                setDraft((current) => ({
                  ...current,
                  apps: [
                    ...current.apps,
                    { id: newId(), name: "", appId: "", privateKeySecretId: "", installationId: "", roles: "", agentIds: [], allowedRepos: "", permissions: { ...DEFAULT_GITHUB_APP_PERMISSIONS } },
                  ],
                }))
              }
            >
              <Plus className="mr-1 h-3.5 w-3.5" /> Add GitHub App
            </Button>
            {onBeginAppManifest ? (
              <Button type="button" variant="outline" size="sm" onClick={openManifestDialog}>
                <Plus className="mr-1 h-3.5 w-3.5" /> {t("githubSharedIdentity.manifest.createButton")}
              </Button>
            ) : null}
          </div>

          {manifestDialog.open ? (
            <div className="space-y-3 rounded-md border border-border p-4" data-testid="github-app-manifest-dialog">
              <h3 className="text-sm font-semibold">{t("githubSharedIdentity.manifest.dialogTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("githubSharedIdentity.manifest.dialogHint")}</p>
              <fieldset className="grid gap-1 text-sm">
                <legend>{t("githubSharedIdentity.manifest.ownerLabel")}</legend>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="github-app-owner-kind"
                    aria-label={t("githubSharedIdentity.manifest.ownerUser")}
                    checked={manifestDialog.ownerKind === "user"}
                    onChange={() => setManifestDialog({ ...manifestDialog, ownerKind: "user" })}
                  />
                  {t("githubSharedIdentity.manifest.ownerUser")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="github-app-owner-kind"
                    aria-label={t("githubSharedIdentity.manifest.ownerOrg")}
                    checked={manifestDialog.ownerKind === "org"}
                    onChange={() => setManifestDialog({ ...manifestDialog, ownerKind: "org" })}
                  />
                  {t("githubSharedIdentity.manifest.ownerOrg")}
                </label>
                {manifestDialog.ownerKind === "org" ? (
                  <label className="grid gap-1">
                    {t("githubSharedIdentity.manifest.orgLoginLabel")}
                    <Input
                      aria-label={t("githubSharedIdentity.manifest.orgLoginLabel")}
                      value={manifestDialog.orgLogin}
                      onChange={(event) => setManifestDialog({ ...manifestDialog, orgLogin: event.target.value })}
                    />
                  </label>
                ) : null}
              </fieldset>
              <label className="grid gap-1 text-sm">
                {t("githubSharedIdentity.manifest.nameLabel")}
                <Input
                  aria-label={t("githubSharedIdentity.manifest.nameLabel")}
                  value={manifestDialog.name}
                  onChange={(event) => setManifestDialog({ ...manifestDialog, name: event.target.value })}
                />
              </label>
              <label className="grid gap-1 text-sm">
                {t("githubSharedIdentity.manifest.descriptionLabel")}
                <Textarea
                  aria-label={t("githubSharedIdentity.manifest.descriptionLabel")}
                  value={manifestDialog.description}
                  onChange={(event) => setManifestDialog({ ...manifestDialog, description: event.target.value })}
                  rows={3}
                />
                <span className="text-xs text-muted-foreground">{t("githubSharedIdentity.manifest.descriptionDefaultRu")}</span>
              </label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={manifestPending || !manifestDialog.name.trim()}
                  onClick={submitManifestDialog}
                >
                  {manifestPending
                    ? t("githubSharedIdentity.manifest.creating")
                    : t("githubSharedIdentity.manifest.submitButton")}
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setManifestDialog({ open: false })}>
                  {t("githubSharedIdentity.manifest.cancel")}
                </Button>
              </div>
            </div>
          ) : null}

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
  const { t } = useTranslation();
  const { selectedCompanyId, selectedCompany } = useCompany();
  const companyId = selectedCompanyId ?? "";
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [installPendingEntryId, setInstallPendingEntryId] = useState<string | null>(null);
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

  // myrmidon(GITHUB-APP-MANIFEST): outcome of the server callback, read once
  // from the page query string (?github_app_created=1 / ?github_app_error=...).
  // The parameters are removed from the URL afterwards so a reload does not
  // repeat the notice. Derived state pattern: process each unseen search
  // during render and remember the search we handled.
  const [callbackHandled, setCallbackHandled] = useState<{ search: string | null; success: boolean }>({
    search: null,
    success: false,
  });
  if (callbackHandled.search !== window.location.search) {
    const notice = readManifestCallbackNotice(window.location.search);
    clearManifestCallbackQuery();
    // Mark the cleaned search as handled: replaceState above changed
    // location.search, so the marker must be the post-clean value.
    const cleanedSearch = window.location.search;
    if (notice?.kind === "created") {
      void queryClient.invalidateQueries({ queryKey: githubSharedIdentityQueryKey(companyId) });
      setCallbackHandled({ search: cleanedSearch, success: true });
    } else {
      if (notice?.kind === "error") setManifestError(notice.message);
      setCallbackHandled({ search: cleanedSearch, success: false });
    }
  }
  const callbackSuccess = callbackHandled.success;

  const beginManifest = useMutation({
    mutationFn: (body: BeginAppManifestBody) => githubSharedIdentityApi.beginAppManifest(companyId, body),
    onMutate: () => setManifestError(null),
    onError: (err) =>
      setManifestError(
        err instanceof Error ? err.message : t("githubSharedIdentity.manifest.beginFailed"),
      ),
    onSuccess: (response) => {
      setManifestError(null);
      submitManifestForm(response.manifestUrl, response.manifest, response.state);
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
    <>
      {callbackSuccess ? (
        <div
          className="mb-4 rounded-md border border-border bg-muted/40 px-3 py-2 text-sm"
          data-testid="github-app-created-notice"
        >
          {t("githubSharedIdentity.manifest.createdNotice")}
        </div>
      ) : null}
      <GitHubSharedIdentityPanelView
        view={query.data}
        agents={agentsQuery.data ?? []}
        secrets={(secretsQuery.data ?? []).filter((secret) => secret.scope === "company")}
        onSave={(body) => save.mutate(body)}
        pending={save.isPending}
        error={error}
        companyName={selectedCompany?.name ?? null}
        onBeginAppManifest={(body) => beginManifest.mutate(body)}
        manifestPending={beginManifest.isPending}
        manifestError={manifestError}
        onInstallApp={(entryId) => {
          setInstallPendingEntryId(entryId);
          setManifestError(null);
          githubSharedIdentityApi
            .getAppInstallUrl(companyId, entryId)
            .then(({ installUrl }) => window.location.assign(installUrl))
            .catch((err: unknown) =>
              setManifestError(
                err instanceof Error ? err.message : t("githubSharedIdentity.manifest.installFailed"),
              ),
            )
            .finally(() => setInstallPendingEntryId(null));
        }}
        installPendingEntryId={installPendingEntryId}
      />
    </>
  );
}
