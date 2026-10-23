// myrmidon(CLOUD-CONNECTOR): Settings → Clouds page.
// The owner connects a cloud account once, keeps the folders inside it and
// hands each of them to an agent, a caste or everyone with a mode. The token
// stays in the connector; the panel only ever sees the account and its id.

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cloud } from "lucide-react";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ApiError } from "@/api/client";
import { i18n, useTranslation } from "@/i18n";
import type {
  CloudAccessMode,
  CloudAccount,
  CloudGrant,
  CloudGrantTargetKind,
  CloudJournalEntry,
  CloudProviderId,
  CloudRoot,
  CloudRootKind,
} from "@paperclipai/shared/myrmidon-cloud-connector";
import {
  CLOUD_PROVIDER_LABELS,
  cloudsAccountsQueryKey,
  cloudsApi,
  cloudsGrantsQueryKey,
  cloudsJournalQueryKey,
  cloudsRootsQueryKey,
  type NewGrantInput,
  type NewRootInput,
} from "./cloudsApi";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function readable(error: unknown): string {
  if (error instanceof ApiError) return error.message || i18n.t("area.settings-integrations.clouds-settings-page.requestFailed", { status: error.status });
  if (error instanceof Error) return error.message;
  return i18n.t("area.settings-integrations.clouds-settings-page.unexpectedError");
}

export interface CloudsSettingsPageViewProps {
  companyId: string;
  accounts: CloudAccount[];
  roots: CloudRoot[];
  grants: CloudGrant[];
  journal: CloudJournalEntry[];
  loading: boolean;
  error: string | null;
  notice: string | null;
  pending: boolean;
  onConnect: (providerId: CloudProviderId) => void;
  onDisconnect: (accountId: string) => void;
  onAddRoot: (input: NewRootInput) => void;
  onRemoveRoot: (rootId: string) => void;
  onSetGrant: (input: NewGrantInput) => void;
  onRemoveGrant: (grantId: string) => void;
}

function AccountsSection({ accounts, pending, onConnect, onDisconnect }: Pick<CloudsSettingsPageViewProps, "accounts" | "pending" | "onConnect" | "onDisconnect">) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t("area.settings-integrations.clouds-settings-page.accountsTitle")}</h2>
      <p className="text-xs text-muted-foreground">
        {t("area.settings-integrations.clouds-settings-page.accountsHint")}
      </p>
      <ul className="space-y-2" data-testid="myrmidon-clouds-accounts">
        {CLOUD_PROVIDER_LABELS.map(({ id, label }) => {
          const account = accounts.find((entry) => entry.providerId === id);
          return (
            <li
              key={id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              data-testid={`myrmidon-clouds-provider-${id}`}
            >
              <div className="space-y-0.5">
                <p className="text-sm">{label}</p>
                <p className="text-xs text-muted-foreground" data-testid={`myrmidon-clouds-provider-state-${id}`}>
                  {account
                    ? t("area.settings-integrations.clouds-settings-page.connectedAs", {
                        name: account.displayName,
                        date: new Date(account.connectedAt).toLocaleDateString(i18n.language),
                      })
                    : t("area.settings-integrations.clouds-settings-page.notConnected")}
                </p>
              </div>
              {account ? (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => onDisconnect(account.id)}
                  data-testid={`myrmidon-clouds-disconnect-${id}`}
                >
                  {t("area.settings-integrations.clouds-settings-page.disconnect")}
                </Button>
              ) : (
                <Button
                  size="sm"
                  disabled={pending}
                  onClick={() => onConnect(id)}
                  data-testid={`myrmidon-clouds-connect-${id}`}
                >
                  {t("area.settings-integrations.clouds-settings-page.connect")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AddFolderForm({ pending, onAddRoot }: Pick<CloudsSettingsPageViewProps, "pending" | "onAddRoot">) {
  const { t } = useTranslation();
  const [providerId, setProviderId] = useState<CloudProviderId>("onedrive");
  const [name, setName] = useState("");
  const [kind, setKind] = useState<CloudRootKind>("own");
  const [folder, setFolder] = useState("");
  const [driveId, setDriveId] = useState("");
  const [itemId, setItemId] = useState("");

  const canSubmit = name.trim().length > 0 && (kind === "own" ? folder.trim().length > 0 : driveId.trim().length > 0 && itemId.trim().length > 0);

  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-clouds-add-folder">
      <div className="grid gap-2 sm:grid-cols-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.cloud")}
          <select
            className={SELECT_CLASS}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value as CloudProviderId)}
            aria-label={t("area.settings-integrations.clouds-settings-page.cloudProviderAria")}
            data-testid="myrmidon-clouds-new-folder-provider"
          >
            {CLOUD_PROVIDER_LABELS.map(({ id, label }) => (
              <option key={id} value={id}>{label}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.folderName")}
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t("area.settings-integrations.clouds-settings-page.folderNamePlaceholder")}
            aria-label={t("area.settings-integrations.clouds-settings-page.folderName")}
            data-testid="myrmidon-clouds-new-folder-name"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.whereItLives")}
          <select
            className={SELECT_CLASS}
            value={kind}
            onChange={(event) => setKind(event.target.value as CloudRootKind)}
            aria-label={t("area.settings-integrations.clouds-settings-page.folderKindAria")}
            data-testid="myrmidon-clouds-new-folder-kind"
          >
            <option value="own">{t("area.settings-integrations.clouds-settings-page.kindOwn")}</option>
            <option value="shared">{t("area.settings-integrations.clouds-settings-page.kindShared")}</option>
          </select>
        </label>
      </div>
      {kind === "own" ? (
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.pathLabel")}
          <Input
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
            placeholder={t("area.settings-integrations.clouds-settings-page.pathPlaceholder")}
            aria-label={t("area.settings-integrations.clouds-settings-page.folderPathAria")}
            data-testid="myrmidon-clouds-new-folder-path"
          />
        </label>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("area.settings-integrations.clouds-settings-page.driveId")}
            <Input
              value={driveId}
              onChange={(event) => setDriveId(event.target.value)}
              aria-label={t("area.settings-integrations.clouds-settings-page.driveId")}
              data-testid="myrmidon-clouds-new-folder-drive"
            />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("area.settings-integrations.clouds-settings-page.itemId")}
            <Input
              value={itemId}
              onChange={(event) => setItemId(event.target.value)}
              aria-label={t("area.settings-integrations.clouds-settings-page.itemId")}
              data-testid="myrmidon-clouds-new-folder-item"
            />
          </label>
        </div>
      )}
      <Button
        size="sm"
        disabled={pending || !canSubmit}
        onClick={() => {
          onAddRoot(
            kind === "own"
              ? { providerId, name: name.trim(), kind, folder: folder.trim() }
              : { providerId, name: name.trim(), kind, driveId: driveId.trim(), itemId: itemId.trim() },
          );
          setName("");
          setFolder("");
          setDriveId("");
          setItemId("");
        }}
        data-testid="myrmidon-clouds-add-folder-button"
      >
        {t("area.settings-integrations.clouds-settings-page.addFolder")}
      </Button>
    </div>
  );
}

function GrantsSection({
  roots,
  grants,
  pending,
  onSetGrant,
  onRemoveGrant,
}: Pick<CloudsSettingsPageViewProps, "roots" | "grants" | "pending" | "onSetGrant" | "onRemoveGrant">) {
  const { t } = useTranslation();
  const grantTargetLabel = (grant: CloudGrant): string => {
    switch (grant.targetKind) {
      case "agent":
        return t("area.settings-integrations.clouds-settings-page.targetLabelAgent", { id: grant.agentId ?? "?" });
      case "caste":
        return t("area.settings-integrations.clouds-settings-page.targetLabelCaste", { name: grant.caste ?? "?" });
      case "all":
        return t("area.settings-integrations.clouds-settings-page.targetLabelAll");
    }
  };
  const [rootId, setRootId] = useState("");
  const [targetKind, setTargetKind] = useState<CloudGrantTargetKind>("all");
  const [agentId, setAgentId] = useState("");
  const [caste, setCaste] = useState("");
  const [mode, setMode] = useState<CloudAccessMode>("ro");

  const selectedRoot = roots.find((root) => root.id === rootId) ?? roots[0];
  const canSubmit =
    roots.length > 0
    && (targetKind !== "agent" || agentId.trim().length > 0)
    && (targetKind !== "caste" || caste.trim().length > 0);

  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t("area.settings-integrations.clouds-settings-page.accessTitle")}</h2>
      <p className="text-xs text-muted-foreground">
        {t("area.settings-integrations.clouds-settings-page.accessHint")}
      </p>
      <div className="space-y-2 rounded-md border border-border p-3" data-testid="myrmidon-clouds-add-grant">
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("area.settings-integrations.clouds-settings-page.folder")}
            <select
              className={SELECT_CLASS}
              value={selectedRoot?.id ?? ""}
              onChange={(event) => setRootId(event.target.value)}
              aria-label={t("area.settings-integrations.clouds-settings-page.folder")}
              data-testid="myrmidon-clouds-grant-root"
            >
              {roots.map((root) => (
                <option key={root.id} value={root.id}>{root.name}</option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("area.settings-integrations.clouds-settings-page.giveTo")}
            <select
              className={SELECT_CLASS}
              value={targetKind}
              onChange={(event) => setTargetKind(event.target.value as CloudGrantTargetKind)}
              aria-label={t("area.settings-integrations.clouds-settings-page.grantTargetAria")}
              data-testid="myrmidon-clouds-grant-target"
            >
              <option value="all">{t("area.settings-integrations.clouds-settings-page.targetAll")}</option>
              <option value="agent">{t("area.settings-integrations.clouds-settings-page.targetAgent")}</option>
              <option value="caste">{t("area.settings-integrations.clouds-settings-page.targetCaste")}</option>
            </select>
          </label>
          {targetKind === "agent" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              {t("area.settings-integrations.clouds-settings-page.agentId")}
              <Input
                value={agentId}
                onChange={(event) => setAgentId(event.target.value)}
                aria-label={t("area.settings-integrations.clouds-settings-page.agentId")}
                data-testid="myrmidon-clouds-grant-agent"
              />
            </label>
          )}
          {targetKind === "caste" && (
            <label className="space-y-1 text-xs text-muted-foreground">
              {t("area.settings-integrations.clouds-settings-page.caste")}
              <Input
                value={caste}
                onChange={(event) => setCaste(event.target.value)}
                aria-label={t("area.settings-integrations.clouds-settings-page.caste")}
                data-testid="myrmidon-clouds-grant-caste"
              />
            </label>
          )}
          <label className="space-y-1 text-xs text-muted-foreground">
            {t("area.settings-integrations.clouds-settings-page.mode")}
            <select
              className={SELECT_CLASS}
              value={mode}
              onChange={(event) => setMode(event.target.value as CloudAccessMode)}
              aria-label={t("area.settings-integrations.clouds-settings-page.grantModeAria")}
              data-testid="myrmidon-clouds-grant-mode"
            >
              <option value="ro">{t("area.settings-integrations.clouds-settings-page.modeRo")}</option>
              <option value="rw">{t("area.settings-integrations.clouds-settings-page.modeRw")}</option>
            </select>
          </label>
        </div>
        <Button
          size="sm"
          disabled={pending || !canSubmit || !selectedRoot}
          onClick={() => {
            if (!selectedRoot) return;
            onSetGrant(
              targetKind === "agent"
                ? { rootId: selectedRoot.id, targetKind, agentId: agentId.trim(), mode }
                : targetKind === "caste"
                  ? { rootId: selectedRoot.id, targetKind, caste: caste.trim(), mode }
                  : { rootId: selectedRoot.id, targetKind, mode },
            );
            setAgentId("");
            setCaste("");
          }}
          data-testid="myrmidon-clouds-add-grant-button"
        >
          {t("area.settings-integrations.clouds-settings-page.grantAccess")}
        </Button>
      </div>
      {grants.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-grants-empty">
          {t("area.settings-integrations.clouds-settings-page.noGrants")}
        </p>
      ) : (
        <ul className="space-y-1" data-testid="myrmidon-clouds-grants">
          {grants.map((grant) => (
            <li
              key={grant.id}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
              data-testid="myrmidon-clouds-grant-row"
            >
              <span>
                {roots.find((root) => root.id === grant.rootId)?.name ?? grant.rootId} · {grantTargetLabel(grant)} ·{" "}
                {grant.mode === "rw" ? t("area.settings-integrations.clouds-settings-page.rowModeRw") : t("area.settings-integrations.clouds-settings-page.rowModeRo")}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={() => onRemoveGrant(grant.id)}
                data-testid={`myrmidon-clouds-remove-grant-${grant.id}`}
              >
                {t("area.settings-integrations.clouds-settings-page.remove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function JournalSection({ journal }: Pick<CloudsSettingsPageViewProps, "journal">) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-semibold">{t("area.settings-integrations.clouds-settings-page.journalTitle")}</h2>
      {journal.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-journal-empty">
          {t("area.settings-integrations.clouds-settings-page.journalEmpty")}
        </p>
      ) : (
        <ul className="space-y-1 text-xs text-muted-foreground" data-testid="myrmidon-clouds-journal">
          {journal.map((entry) => (
            <li key={entry.id} data-testid="myrmidon-clouds-journal-entry">
              {new Date(entry.at).toLocaleString()} · {entry.actor} · {entry.tool} · {entry.rootName ?? "—"} ·{" "}
              {entry.ok ? t("area.settings-integrations.clouds-settings-page.journalOk") : t("area.settings-integrations.clouds-settings-page.journalRefused")}
              {entry.detail ? ` · ${entry.detail}` : ""}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CloudsSettingsPageView(props: CloudsSettingsPageViewProps) {
  const { t } = useTranslation();
  const rootKindLabel = (root: CloudRoot) =>
    root.kind === "shared" ? t("area.settings-integrations.clouds-settings-page.rootKindShared") : t("area.settings-integrations.clouds-settings-page.rootKindOwn");
  return (
    <div className="space-y-6" data-testid="myrmidon-clouds-page">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("area.settings-integrations.clouds-settings-page.title")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.description")}
        </p>
      </div>

      {props.error && (
        <p className="text-xs text-destructive" data-testid="myrmidon-clouds-error">{props.error}</p>
      )}
      {props.notice && (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-notice">{props.notice}</p>
      )}
      {props.loading && (
        <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-loading">{t("area.settings-integrations.clouds-settings-page.loading")}</p>
      )}

      <AccountsSection
        accounts={props.accounts}
        pending={props.pending}
        onConnect={props.onConnect}
        onDisconnect={props.onDisconnect}
      />

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">{t("area.settings-integrations.clouds-settings-page.foldersTitle")}</h2>
        <p className="text-xs text-muted-foreground">
          {t("area.settings-integrations.clouds-settings-page.foldersHint")}
        </p>
        <AddFolderForm pending={props.pending} onAddRoot={props.onAddRoot} />
        {props.roots.length === 0 ? (
          <p className="text-xs text-muted-foreground" data-testid="myrmidon-clouds-roots-empty">
            {t("area.settings-integrations.clouds-settings-page.noFolders")}
          </p>
        ) : (
          <ul className="space-y-1" data-testid="myrmidon-clouds-roots">
            {props.roots.map((root) => (
              <li
                key={root.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm"
                data-testid="myrmidon-clouds-root-row"
              >
                <span>
                  {root.name} · {rootKindLabel(root)} · {root.kind === "shared" ? `${root.driveId ?? "?"}/${root.itemId ?? "?"}` : root.folder ?? "—"}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={props.pending}
                  onClick={() => props.onRemoveRoot(root.id)}
                  data-testid={`myrmidon-clouds-remove-root-${root.id}`}
                >
                  {t("area.settings-integrations.clouds-settings-page.remove")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <GrantsSection
        roots={props.roots}
        grants={props.grants}
        pending={props.pending}
        onSetGrant={props.onSetGrant}
        onRemoveGrant={props.onRemoveGrant}
      />

      <JournalSection journal={props.journal} />
    </div>
  );
}

export function CloudsSettingsPage() {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const companyId = selectedCompanyId ?? "";
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.settings-integrations.clouds-settings-page.breadcrumbSettings"), href: "/company/settings" },
      { label: t("area.settings-integrations.clouds-settings-page.breadcrumbClouds") },
    ]);
  }, [setBreadcrumbs, t]);

  const accountsQuery = useQuery({
    queryKey: [...cloudsAccountsQueryKey, companyId],
    queryFn: () => cloudsApi.accounts(companyId),
    enabled: companyId.length > 0,
  });
  const rootsQuery = useQuery({
    queryKey: [...cloudsRootsQueryKey, companyId],
    queryFn: () => cloudsApi.roots(companyId),
    enabled: companyId.length > 0,
  });
  const grantsQuery = useQuery({
    queryKey: [...cloudsGrantsQueryKey, companyId],
    queryFn: () => cloudsApi.grants(companyId),
    enabled: companyId.length > 0,
  });
  const journalQuery = useQuery({
    queryKey: [...cloudsJournalQueryKey, companyId],
    queryFn: () => cloudsApi.journal(companyId),
    enabled: companyId.length > 0,
  });

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: cloudsAccountsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsRootsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsGrantsQueryKey }),
      queryClient.invalidateQueries({ queryKey: cloudsJournalQueryKey }),
    ]);
  };

  const connectMutation = useMutation({
    mutationFn: (providerId: CloudProviderId) => cloudsApi.startConnect(providerId, companyId),
    onSuccess: (started) => {
      // The cloud signs the owner in on its own page and sends the browser back
      // to the callback, which records the account.
      window.open(started.authorizeUrl, "_blank", "noopener");
      setNotice(t("area.settings-integrations.clouds-settings-page.finishSignIn", { provider: started.providerId }));
    },
    onError: (error) => setNotice(readable(error)),
  });
  const disconnectMutation = useMutation({
    mutationFn: (accountId: string) => cloudsApi.disconnectAccount(accountId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const addRootMutation = useMutation({
    mutationFn: (input: NewRootInput) => cloudsApi.addRoot(companyId, input),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const removeRootMutation = useMutation({
    mutationFn: (rootId: string) => cloudsApi.removeRoot(rootId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const setGrantMutation = useMutation({
    mutationFn: (input: NewGrantInput) => cloudsApi.setGrant(companyId, input),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });
  const removeGrantMutation = useMutation({
    mutationFn: (grantId: string) => cloudsApi.removeGrant(grantId, companyId),
    onSuccess: () => void refresh(),
    onError: (error) => setNotice(readable(error)),
  });

  const pending =
    connectMutation.isPending
    || disconnectMutation.isPending
    || addRootMutation.isPending
    || removeRootMutation.isPending
    || setGrantMutation.isPending
    || removeGrantMutation.isPending;

  const errorSource = accountsQuery.error ?? rootsQuery.error ?? grantsQuery.error ?? journalQuery.error;

  return (
    <CloudsSettingsPageView
      companyId={companyId}
      accounts={accountsQuery.data?.accounts ?? []}
      roots={rootsQuery.data?.roots ?? []}
      grants={grantsQuery.data?.grants ?? []}
      journal={journalQuery.data?.entries ?? []}
      loading={accountsQuery.isLoading || rootsQuery.isLoading || grantsQuery.isLoading}
      error={errorSource ? readable(errorSource) : null}
      notice={notice}
      pending={pending}
      onConnect={(providerId) => connectMutation.mutate(providerId)}
      onDisconnect={(accountId) => disconnectMutation.mutate(accountId)}
      onAddRoot={(input) => addRootMutation.mutate(input)}
      onRemoveRoot={(rootId) => removeRootMutation.mutate(rootId)}
      onSetGrant={(input) => setGrantMutation.mutate(input)}
      onRemoveGrant={(grantId) => removeGrantMutation.mutate(grantId)}
    />
  );
}