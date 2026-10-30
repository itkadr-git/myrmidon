import { ManagedAiConnectionRow } from "@/components/ai-connections/ManagedAiConnectionDetails";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardPaste,
  Clock3,
  Link2,
  Loader2,
  MoreHorizontal,
  PauseCircle,
  Search,
  ServerCog,
  Trash2,
} from "lucide-react";
import type { ToolApplication, ToolConnection } from "@myrmidon/shared";
import {
  getAppDefinitionForUrl,
  getAppStoreDefinition,
  isToolConnectionAttentionHealth,
  aiSubscriptionNeedsIsolatedLogin,
} from "@myrmidon/shared";
import { useNavigate } from "@/lib/router";
import { useChatConnectorsEnabled } from "@/hooks/useChatConnectorsEnabled";
import { appCopyFor } from "@/lib/app-gallery-copy";
import { useCompany } from "@/context/CompanyContext";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { queryKeys } from "@/lib/queryKeys";
import { toolsApi } from "@/api/tools";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { accessApi } from "@/api/access";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import { AppLogo } from "./AppLogo";
import {
  appApplicationSourceSlug,
  appDefinitionDarkLogoUrl,
  appDefinitionDescription,
  appDefinitionLogoUrl,
  appDefinitionName,
  appDefinitionSlug,
  type AppGalleryDisplayEntry,
} from "./app-definition-display";
import {
  appSourceConnectHref,
  appSourceResumeHref,
  appSupportsToolCatalogSetup,
} from "./app-connect-policy";
import { composioChildParentConnectionId } from "./composio-services";
import {
  ConnectionOwnerIdentity,
  connectionDisplayNameForOwner,
  connectionOwnerProfile,
  type ConnectionOwnerProfile,
} from "./connection-owner";
import { i18n, useTranslation } from "@/i18n";

type ConnectorRowModel = {
  key: string;
  slug: string;
  name: string;
  description: string;
  brandKey: string;
  logoUrl?: string | null;
  darkLogoUrl?: string | null;
  entry: AppGalleryDisplayEntry | null;
  applications: ToolApplication[];
  connections: ToolConnection[];
  chatEndpoints: ChatEndpoint[];
};

type ConnectionState = {
  kind: "connected" | "attention" | "paused" | "draft";
  label: string;
  message: string | null;
};

type ConnectionRemovalTarget = {
  id: string;
  accountName: string;
  providerName: string;
  remainingConnectionCount: number;
  childConnectionCount: number;
};

function chatProviderForSlug(slug: string): ChatProvider | null {
  const method = getAppStoreDefinition(slug)?.methods.find(
    (candidate) =>
      candidate.purpose === "channel" &&
      candidate.provider,
  );
  return method?.provider ?? null;
}

function chatConnectHref(
  slug: string,
  toolHref: string | null,
  agentId?: string | null,
): string | null {
  const definition = getAppStoreDefinition(slug);
  const provider = chatProviderForSlug(slug);
  if (!definition || !provider) return null;
  const params = new URLSearchParams({ provider });
  const hasToolMethod = definition.methods.some(
    (method) => method.purpose === "tool" && method.transport !== "chat_sdk",
  );
  const effectiveToolHref = hasToolMethod
    ? (toolHref ?? `/apps/connect?source=${slug}`)
    : null;
  if (effectiveToolHref) params.set("toolHref", effectiveToolHref);
  else params.set("purpose", "chat");
  if (agentId) params.set("agentId", agentId);
  return `/apps/chat/connect?${params.toString()}`;
}

function connectHrefFor(entry: AppGalleryDisplayEntry): string | null {
  const slug = appDefinitionSlug(entry);
  const definition = getAppStoreDefinition(slug);
  return appSupportsToolCatalogSetup(definition)
    ? appSourceConnectHref(slug)
    : null;
}

function additionalConnectionHref(
  entry: AppGalleryDisplayEntry,
  applicationId: string,
): string | null {
  const baseHref = connectHrefFor(entry);
  if (!baseHref) return null;
  const [path, rawQuery = ""] = baseHref.split("?");
  const params = new URLSearchParams(rawQuery);
  params.set("applicationId", applicationId);
  params.set("name", appDefinitionName(entry));
  params.set("new", "1");
  return `${path}?${params.toString()}`;
}

function connectionState(connection: ToolConnection): ConnectionState {
  if (connection.status === "draft") {
    return {
      kind: "draft",
      label: i18n.t("area.apps-connections-3.browse.stateDraft"),
      message: i18n.t("area.apps-connections-3.browse.stateDraftMsg"),
    };
  }
  if (connection.enabled === false || connection.status === "disabled") {
    return {
      kind: "paused",
      label: i18n.t("area.apps-connections-3.browse.statePaused"),
      message: i18n.t("area.apps-connections-3.browse.statePausedMsg"),
    };
  }
  if ((connection.connectionPurpose === "ai" && (connection.healthStatus !== "ok" || aiSubscriptionNeedsIsolatedLogin(connection.config))) || isToolConnectionAttentionHealth(connection.healthStatus)) {
    return {
      kind: "attention",
      label: i18n.t("area.apps-connections-3.browse.stateAttention"),
      message:
        connection.healthMessage ??
        connection.lastError ??
        (connection.authKind === "oauth"
          ? i18n.t("area.apps-connections-3.browse.stateSignInAgain")
          : i18n.t("area.apps-connections-3.browse.stateReplaceCredential")),
    };
  }
  return { kind: "connected", label: i18n.t("area.apps-connections-3.browse.stateConnected"), message: null };
}

function connectionRank(connection: ToolConnection): number {
  return connection.status === "draft" ? 0 : 1;
}

function rowRank(row: ConnectorRowModel): number {
  if (
    row.chatEndpoints.some((endpoint) => endpoint.status !== "draft") ||
    row.connections.some((connection) => connectionRank(connection) === 1)
  )
    return 2;
  return row.connections.length > 0 || row.chatEndpoints.length > 0 ? 1 : 0;
}

function connectorAction(
  row: ConnectorRowModel,
  chatConnectorsEnabled: boolean,
  agentId?: string | null,
): {
  label: string;
  href: string | null;
  title?: string;
} {
  const applicationId = row.applications[0]?.id ?? null;
  const chatHref = chatConnectorsEnabled
    ? chatConnectHref(
        row.slug,
        row.entry ? connectHrefFor(row.entry) : null,
        agentId,
      )
    : null;
  if (row.connections.length > 0 || row.chatEndpoints.length > 0) {
    if (chatHref) return { label: i18n.t("area.apps-connections-3.browse.actionAddConnection"), href: chatHref };
    if (row.entry && applicationId) {
      return {
        label: i18n.t("area.apps-connections-3.browse.actionAddAccount"),
        href: additionalConnectionHref(row.entry, applicationId),
      };
    }
    return {
      label: i18n.t("area.apps-connections-3.browse.actionAddAccount"),
      href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
    };
  }

  if (row.entry?.availability?.available === false) {
    return {
      label: i18n.t("area.apps-connections-3.browse.actionUnavailable"),
      href: null,
      title:
        row.entry.availability.reason ??
        i18n.t("area.apps-connections-3.browse.actionUnavailableReason"),
    };
  }
  if (chatHref) return { label: i18n.t("area.apps-connections-3.browse.actionConnect"), href: chatHref };
  if (row.entry) return { label: i18n.t("area.apps-connections-3.browse.actionConnect"), href: connectHrefFor(row.entry) };
  return {
    label: i18n.t("area.apps-connections-3.browse.actionConnect"),
    href: applicationId ? `/apps/app/${applicationId}/permissions` : null,
  };
}

function accountActionHref(
  row: ConnectorRowModel,
  connection: ToolConnection,
): string {
  if (connection.status === "draft" && row.entry) {
    return appSourceResumeHref(row.slug, connection.id);
  }
  return `/apps/${connection.id}/permissions`;
}

/**
 * The Apps landing page is the single connector catalog and account-management
 * surface. Connected providers sort first and expand in place to show every
 * account; unconnected providers retain the same catalog setup flows.
 */
export function Browse({ renderAccountDetails = (connection) => connection.connectionPurpose === "ai" ? <ManagedAiConnectionRow connection={connection} /> : null }: { renderAccountDetails?: (connection: ToolConnection) => ReactNode } = {}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const preselectedChatAgentId =
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("chatAgentId");
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const { selectedCompanyId } = useCompany();
  const { enabled: chatConnectorsEnabled } = useChatConnectorsEnabled();
  const { setBreadcrumbs } = useBreadcrumbs();
  const [query, setQuery] = useState("");
  const [connectionToRemove, setConnectionToRemove] =
    useState<ConnectionRemovalTarget | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: t("area.apps-connections-3.browse.breadcrumbConnectors") }]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs, t]);

  const galleryQuery = useQuery({
    queryKey: queryKeys.apps.gallery(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listGallery(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const applicationsQuery = useQuery({
    queryKey: queryKeys.tools.applications(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listApplications(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const connectionsQuery = useQuery({
    queryKey: queryKeys.tools.connections(selectedCompanyId ?? "__none__"),
    queryFn: () => toolsApi.listConnections(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const chatEndpointsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.list(selectedCompanyId ?? "__none__"),
    queryFn: () => chatEndpointsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && chatConnectorsEnabled,
  });
  const userDirectoryQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(
      selectedCompanyId ?? "__none__",
    ),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const removeConnection = useMutation({
    mutationFn: (target: ConnectionRemovalTarget) =>
      toolsApi.archiveConnection(target.id, {
        confirmComposioChildren: target.childConnectionCount > 0,
      }),
    onSuccess: (_connection, target) => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.tools.connections(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.tools.applications(selectedCompanyId!),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.apps.attention(selectedCompanyId!),
      });
      pushToast({
        title: t("area.apps-connections-3.browse.removedTitle"),
        body:
          target.remainingConnectionCount > 0
            ? t("area.apps-connections-3.browse.removedStillHas", { app: target.providerName, count: target.remainingConnectionCount })
            : t("area.apps-connections-3.browse.removedNoLonger", { app: target.providerName }),
        tone: "success",
      });
      setConnectionToRemove(null);
    },
    onError: (error) =>
      pushToast({
        title: t("area.apps-connections-3.browse.removeFailed"),
        body: error instanceof Error ? error.message : t("area.apps-connections-3.browse.tryAgainShort"),
        tone: "error",
      }),
  });

  const gallery = (
    (galleryQuery.data?.apps ?? []) as AppGalleryDisplayEntry[]
  ).filter((entry) => {
    const definition = getAppStoreDefinition(appDefinitionSlug(entry));
    return (
      chatConnectorsEnabled ||
      !definition?.methods.some((method) => method.purpose === "channel") ||
      appSupportsToolCatalogSetup(definition)
    );
  });
  const userProfileById = useMemo(
    () => buildCompanyUserProfileMap(userDirectoryQuery.data?.users),
    [userDirectoryQuery.data],
  );

  const rows = useMemo<ConnectorRowModel[]>(() => {
    const activeConnections = (connectionsQuery.data?.connections ?? []).filter(
      (connection) =>
        connection.status !== "archived" &&
        connection.connectionPurpose !== "channel",
    );
    const activeApplications = (
      applicationsQuery.data?.applications ?? []
    ).filter(
      (application) =>
        application.status !== "archived" &&
        (chatConnectorsEnabled ||
          (application.type !== "chat" &&
            application.metadata?.purpose !== "channel")),
    );
    const connectionsByApplicationId = new Map<string, ToolConnection[]>();
    for (const connection of activeConnections) {
      connectionsByApplicationId.set(connection.applicationId, [
        ...(connectionsByApplicationId.get(connection.applicationId) ?? []),
        connection,
      ]);
    }

    const gallerySlugs = new Set(
      gallery.map((entry) => appDefinitionSlug(entry)),
    );
    const gallerySlugByName = new Map(
      gallery.map((entry) => [
        appDefinitionName(entry).trim().toLocaleLowerCase(),
        appDefinitionSlug(entry),
      ]),
    );
    const rowsBySlug = new Map<string, ConnectorRowModel>();
    for (const entry of gallery) {
      const slug = appDefinitionSlug(entry);
      rowsBySlug.set(slug, {
        key: `gallery:${slug}`,
        slug,
        name: appDefinitionName(entry),
        description:
          !chatConnectorsEnabled && chatProviderForSlug(slug)
            ? appCopyFor(slug).tagline
            : appDefinitionDescription(entry),
        brandKey: slug,
        logoUrl: appDefinitionLogoUrl(entry),
        darkLogoUrl: appDefinitionDarkLogoUrl(entry),
        entry,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }
    const nativeChatProviders = [
      { provider: "imessage-photon", name: "iMessage Photon", description: t("area.apps-connections-3.browse.descImessage") },
      {
        provider: "slack",
        name: "Slack",
        description:
          t("area.apps-connections-3.browse.descSlack"),
      },
      {
        provider: "github",
        name: "GitHub",
        description:
          t("area.apps-connections-3.browse.descGithub"),
      },
      {
        provider: "discord",
        name: "Discord",
        description:
          t("area.apps-connections-3.browse.descDiscord"),
      },
      {
        provider: "microsoft-teams",
        name: "Microsoft Teams",
        description: t("area.apps-connections-3.browse.descTeams"),
      },
      {
        provider: "telegram",
        name: "Telegram",
        description:
          t("area.apps-connections-3.browse.descTelegram"),
      },
    ] as const;
    for (const item of chatConnectorsEnabled ? nativeChatProviders : []) {
      if (
        [...rowsBySlug.values()].some(
          (row) => chatProviderForSlug(row.slug) === item.provider,
        )
      )
        continue;
      rowsBySlug.set(item.provider, {
        key: `native-chat:${item.provider}`,
        slug: item.provider,
        name: item.name,
        description: item.description,
        brandKey: item.provider,
        entry: null,
        applications: [],
        connections: [],
        chatEndpoints: [],
      });
    }

    const customRows: ConnectorRowModel[] = [];
    for (const application of activeApplications) {
      const appConnections =
        connectionsByApplicationId.get(application.id) ?? [];
      const configuredConnectionSlug = appConnections
        .map(
          (connection) =>
            connection.config?.sourceTemplateKey ??
            connection.transportConfig?.sourceTemplateKey,
        )
        .find(
          (value): value is string =>
            typeof value === "string" && gallerySlugs.has(value),
        );
      const endpointMatchedSlug = appConnections
        .flatMap((connection) => [
          connection.config?.url,
          connection.transportConfig?.url,
        ])
        .map((value) =>
          typeof value === "string"
            ? appDefinitionSlug(getAppDefinitionForUrl(value, gallery)) || null
            : null,
        )
        .find((value): value is string => Boolean(value));
      const applicationSlug = appApplicationSourceSlug(application);
      const resolvedSlug =
        applicationSlug &&
        applicationSlug !== "link" &&
        gallerySlugs.has(applicationSlug)
          ? applicationSlug
          : (configuredConnectionSlug ??
            endpointMatchedSlug ??
            gallerySlugByName.get(
              application.name.trim().toLocaleLowerCase(),
            ) ??
            null);
      const galleryRow = resolvedSlug ? rowsBySlug.get(resolvedSlug) : null;
      if (galleryRow) {
        galleryRow.applications.push(application);
        galleryRow.connections.push(...appConnections);
        continue;
      }

      customRows.push({
        key: `application:${application.id}`,
        slug: applicationSlug ?? application.id,
        name: application.name,
        description:
          application.description ??
          t("area.apps-connections-3.browse.descCustom"),
        brandKey: applicationSlug ?? application.name,
        entry: null,
        applications: [application],
        connections: appConnections,
        chatEndpoints: [],
      });
    }

    for (const endpoint of chatConnectorsEnabled
      ? (chatEndpointsQuery.data ?? [])
      : []) {
      let target = [...rowsBySlug.values()].find(
        (row) => chatProviderForSlug(row.slug) === endpoint.provider,
      );
      if (!target) {
        const names = {
          slack: "Slack",
          github: "GitHub",
          discord: "Discord",
          "microsoft-teams": "Microsoft Teams",
          telegram: "Telegram",
          "imessage-photon": "iMessage Photon",
  agentmail: "AgentMail",
        } as const;
        target = {
          key: `chat:${endpoint.provider}`,
          slug: endpoint.provider,
          name: names[endpoint.provider],
          description: t("area.apps-connections-3.browse.descChatThrough", { provider: names[endpoint.provider] }),
          brandKey: endpoint.provider,
          entry: null,
          applications: [],
          connections: [],
          chatEndpoints: [],
        };
        customRows.push(target);
      }
      target.chatEndpoints.push(endpoint);
    }

    return [...rowsBySlug.values(), ...customRows]
      .map((row) => ({
        ...row,
        connections: [...row.connections].sort(
          (left, right) =>
            connectionRank(right) - connectionRank(left) ||
            left.name.localeCompare(right.name, undefined, {
              sensitivity: "base",
            }),
        ),
      }))
      .sort(
        (left, right) =>
          rowRank(right) - rowRank(left) ||
          left.name.localeCompare(right.name, undefined, {
            sensitivity: "base",
          }) ||
          left.key.localeCompare(right.key),
      );
  }, [
    applicationsQuery.data,
    chatEndpointsQuery.data,
    chatConnectorsEnabled,
    connectionsQuery.data,
    gallery,
    t,
  ]);

  const trimmed = query.trim().toLocaleLowerCase();
  const visibleRows = useMemo(() => {
    if (!trimmed) return rows;
    return rows.filter(
      (row) =>
        row.name.toLocaleLowerCase().includes(trimmed) ||
        row.description.toLocaleLowerCase().includes(trimmed) ||
        row.connections.some((connection) =>
          connection.name.toLocaleLowerCase().includes(trimmed),
        ) ||
        row.chatEndpoints.some((endpoint) =>
          endpoint.assignedAgentName.toLocaleLowerCase().includes(trimmed),
        ),
    );
  }, [rows, trimmed]);
  const showCustomConnector =
    !trimmed || [
      t("area.apps-connections-3.browse.customTitle"),
      t("area.apps-connections-3.browse.customDescription"),
      "mcp",
    ].join(" ").toLocaleLowerCase().includes(trimmed);

  if (!selectedCompanyId) {
    return (
      <div className="p-6 text-sm text-muted-foreground">
        {t("area.apps-connections-3.browse.selectOrganization")}
      </div>
    );
  }

  const loading =
    galleryQuery.isLoading ||
    applicationsQuery.isLoading ||
    connectionsQuery.isLoading ||
    (chatConnectorsEnabled && chatEndpointsQuery.isLoading);
  const loadFailed =
    galleryQuery.isError ||
    applicationsQuery.isError ||
    connectionsQuery.isError ||
    (chatConnectorsEnabled && chatEndpointsQuery.isError);
  const nothingMatches = visibleRows.length === 0 && !showCustomConnector;

  return (
    <div className="max-w-5xl space-y-5 pb-12">
      <header className="flex justify-start">
        <div className="relative w-full max-w-md">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("area.apps-connections-3.browse.searchPlaceholder")}
            aria-label={t("area.apps-connections-3.browse.searchLabel")}
            className="pl-9"
          />
        </div>
      </header>

      {loadFailed ? (
        <div
          className="flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive"
          role="alert"
        >
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <p className="min-w-0 flex-1">
            {t("area.apps-connections-3.browse.loadFailed")}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              void galleryQuery.refetch();
              void applicationsQuery.refetch();
              void connectionsQuery.refetch();
              if (chatConnectorsEnabled) void chatEndpointsQuery.refetch();
            }}
          >
            {t("area.apps-connections-3.browse.tryAgainButton")}
          </Button>
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-3" aria-label={t("area.apps-connections-3.browse.loadingLabel")}>
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      ) : nothingMatches ? (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Link2 className="h-4 w-4" />
          {t("area.apps-connections-3.browse.noMatch", { query: query.trim() })}
        </p>
      ) : (
        <div className="space-y-3" role="list" aria-label={t("area.apps-connections-3.browse.listLabel")}>
          {visibleRows.map((row) => (
            <ConnectorCard
              renderAccountDetails={renderAccountDetails}
              key={row.key}
              row={row}
              allConnections={connectionsQuery.data?.connections ?? []}
              userProfileById={userProfileById}
              onNavigate={navigate}
              onRequestRemove={setConnectionToRemove}
              preselectedAgentId={preselectedChatAgentId}
              chatConnectorsEnabled={chatConnectorsEnabled}
            />
          ))}
          {showCustomConnector ? (
            <CustomConnectorCard onNavigate={navigate} />
          ) : null}
        </div>
      )}

      <AlertDialog
        open={connectionToRemove !== null}
        onOpenChange={(open) => {
          if (!open && !removeConnection.isPending) setConnectionToRemove(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {connectionToRemove
                ? t("area.apps-connections-3.browse.removeDialogTitle", { name: connectionToRemove.accountName })
                : t("area.apps-connections-3.browse.removeDialogTitleGeneric")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {connectionToRemove && connectionToRemove.childConnectionCount > 0
                ? t("area.apps-connections-3.browse.childServices", { count: connectionToRemove.childConnectionCount })
                : connectionToRemove &&
                    connectionToRemove.remainingConnectionCount > 0
                  ? t("area.apps-connections-3.browse.otherConnections", { app: connectionToRemove.providerName, count: connectionToRemove.remainingConnectionCount })
                  : t("area.apps-connections-3.browse.removeNoOthers")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={removeConnection.isPending}>
              {t("common.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={!connectionToRemove || removeConnection.isPending}
              onClick={(event) => {
                event.preventDefault();
                if (connectionToRemove)
                  removeConnection.mutate(connectionToRemove);
              }}
            >
              {removeConnection.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 />
              )}
              {removeConnection.isPending ? t("common.removing") : t("area.apps-connections-3.browse.removeConnection")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function ConnectorCard({
  renderAccountDetails,
  row,
  allConnections,
  userProfileById,
  onNavigate,
  onRequestRemove,
  preselectedAgentId,
  chatConnectorsEnabled,
}: {
  renderAccountDetails?: (connection: ToolConnection) => ReactNode;
  row: ConnectorRowModel;
  allConnections: ToolConnection[];
  userProfileById: ReadonlyMap<string, ConnectionOwnerProfile>;
  onNavigate: (href: string) => void;
  onRequestRemove: (target: ConnectionRemovalTarget) => void;
  preselectedAgentId?: string | null;
  chatConnectorsEnabled: boolean;
}) {
  const { t } = useTranslation();
  const action = connectorAction(
    row,
    chatConnectorsEnabled,
    preselectedAgentId,
  );
  return (
    <div
      role="listitem"
      data-app-slug={row.slug}
      data-connected={
        row.connections.length > 0 || row.chatEndpoints.length > 0
          ? "true"
          : "false"
      }
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        <AppLogo
          name={row.name}
          brandKey={row.brandKey}
          logoUrl={row.logoUrl}
          darkLogoUrl={row.darkLogoUrl}
          size={36}
        />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">{row.name}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {row.description}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!action.href}
          title={action.title}
          onClick={() => {
            if (action.href) onNavigate(action.href);
          }}
          aria-label={`${action.label} ${row.name}`}
        >
          {action.label}
        </Button>
      </div>

      {row.connections.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {row.connections.map((connection) => (
            <ConnectionAccountRow
              details={renderAccountDetails?.(connection)}
              key={connection.id}
              row={row}
              connection={connection}
              owner={connectionOwnerProfile(connection, userProfileById)}
              onNavigate={onNavigate}
              onRemove={() => {
                const accountName = connectionDisplayNameForOwner(
                  connection,
                  row.name,
                  connectionOwnerProfile(connection, userProfileById),
                );
                onRequestRemove({
                  id: connection.id,
                  accountName,
                  providerName: row.name,
                  remainingConnectionCount: row.connections.filter(
                    (candidate) =>
                      candidate.id !== connection.id &&
                      candidate.status === "active" &&
                      candidate.enabled,
                  ).length,
                  childConnectionCount: allConnections.filter(
                    (candidate) =>
                      composioChildParentConnectionId(candidate) ===
                      connection.id,
                  ).length,
                });
              }}
            />
          ))}
        </div>
      ) : null}
      {row.chatEndpoints.length > 0 ? (
        <div className="divide-y divide-border border-t border-border">
          {row.chatEndpoints.map((endpoint) => (
            <div
              key={endpoint.id}
              className="flex flex-wrap items-center gap-3 px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  className="truncate text-left text-sm font-medium hover:underline"
                  onClick={() =>
                    onNavigate(`/apps/chat/${endpoint.id}/settings`)
                  }
                >
                  {endpoint.assignedAgentName} · {endpoint.provider === "agentmail" ? t("area.apps-connections-3.browse.kindEmail") : t("area.apps-connections-3.browse.kindChat")}
                </button>
                <p className="truncate text-xs text-muted-foreground">
                  {endpoint.providerAccountLabel ??
                    endpoint.botLabel ??
                    t("area.apps-connections-3.browse.providerIdentity")}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {endpoint.status.replace(/_/g, " ")}
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  onNavigate(
                    endpoint.status === "draft"
                      ? `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`
                      : `/apps/chat/${endpoint.id}/settings`,
                  )
                }
              >
                {endpoint.status === "draft" ? t("area.apps-connections-3.browse.finishSetup") : t("area.apps-connections-3.browse.manage")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ConnectionAccountRow({
  details,
  row,
  connection,
  owner,
  onNavigate,
  onRemove,
}: {
  details?: ReactNode;
  row: ConnectorRowModel;
  connection: ToolConnection;
  owner: ConnectionOwnerProfile | null;
  onNavigate: (href: string) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const state = connectionState(connection);
  const actionHref = accountActionHref(row, connection);
  const accountName = connectionDisplayNameForOwner(
    connection,
    row.name,
    owner,
  );

  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <ConnectionStatusIcon state={state} />
        <div className="min-w-0">
          <button
            type="button"
            className="block max-w-full cursor-pointer truncate text-left text-sm font-medium text-foreground hover:underline focus-visible:underline"
            aria-label={t("area.apps-connections-3.browse.openPermissionsLabel", { name: accountName })}
            onClick={() => onNavigate(`/apps/${connection.id}/permissions`)}
          >
            {accountName}
          </button>
          {details}
          {state.message ? (
            <div
              className={
                state.kind === "attention"
                  ? "truncate text-xs text-destructive"
                  : "truncate text-xs text-muted-foreground"
              }
            >
              {state.message}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>{t("area.apps-connections-3.browse.connectedBy")}</span>
          <ConnectionOwnerIdentity owner={owner} />
        </div>
        {state.kind === "attention" || state.kind === "draft" ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => onNavigate(actionHref)}
          >
            {state.kind === "attention"
              ? connection.requiresReauthorization === false
                ? t("area.apps-connections-3.browse.retryAccess")
                : t("area.apps-connections-3.browse.reconnect")
              : t("area.apps-connections-3.browse.finishSetup")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={t("area.apps-connections-3.browse.manageConnectionLabel", { name: accountName })}
            >
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onSelect={() => onNavigate(`/apps/${connection.id}/permissions`)}
            >
              {t("area.apps-connections-3.browse.permissions")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onRemove}>
              <Trash2 />
              {t("area.apps-connections-3.browse.removeConnection")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function ConnectionStatusIcon({ state }: { state: ConnectionState }) {
  if (state.kind === "connected") {
    return (
      <span
        className="mt-0.5 text-emerald-600 dark:text-emerald-400"
        title={state.label}
      >
        <Check className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "attention") {
    return (
      <span className="mt-0.5 text-destructive" title={state.label}>
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  if (state.kind === "draft") {
    return (
      <span
        className="mt-0.5 text-amber-600 dark:text-amber-400"
        title={state.label}
      >
        <Clock3 className="h-4 w-4" aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
      </span>
    );
  }
  return (
    <span className="mt-0.5 text-muted-foreground" title={state.label}>
      <PauseCircle className="h-4 w-4" aria-hidden="true" />
      <span className="sr-only">{state.label}</span>
    </span>
  );
}

function CustomConnectorCard({
  onNavigate,
}: {
  onNavigate: (href: string) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  return (
    <div
      role="listitem"
      data-app-slug="custom-mcp"
      className="overflow-hidden rounded-xl border border-border"
    >
      <div className="flex flex-wrap items-center gap-3 px-4 py-4">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Link2 className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground">
            {t("area.apps-connections-3.browse.customTitle")}
          </h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("area.apps-connections-3.browse.customDescription")}
          </p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          aria-controls="custom-connector-options"
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? t("common.close") : t("area.apps-connections-3.browse.actionConnect")}
        </Button>
      </div>

      {expanded ? (
        <div
          id="custom-connector-options"
          className="grid gap-2 border-t border-border px-4 py-3 sm:grid-cols-2"
        >
          <CustomConnectorOption
            icon={ServerCog}
            title={t("area.apps-connections-3.browse.byoTitle")}
            description={t("area.apps-connections-3.browse.byoDescription")}
            onClick={() => onNavigate("/apps/byo")}
          />
          <CustomConnectorOption
            icon={ClipboardPaste}
            title={t("area.apps-connections-3.browse.pasteTitle")}
            description={t("area.apps-connections-3.browse.pasteDescription")}
            onClick={() => onNavigate("/apps/advanced/paste-config")}
          />
        </div>
      ) : null}
    </div>
  );
}

function CustomConnectorOption({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: typeof ServerCog;
  title: string;
  description: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-3 rounded-lg border border-border px-3 py-3 text-left transition-colors hover:border-foreground/30 hover:bg-accent/40"
      onClick={onClick}
    >
      <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground">
        <Icon className="h-4 w-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-foreground">
          {title}
        </span>
        <span className="block text-xs text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
    </button>
  );
}
