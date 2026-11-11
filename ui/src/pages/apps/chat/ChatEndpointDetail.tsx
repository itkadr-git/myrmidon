import { EmailEndpointSettings } from "./EmailEndpointSetup";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Unlink,
} from "lucide-react";
import {
  chatEndpointsApi,
  type ChatActivityItem,
  type ChatEndpoint,
  type ChatEndpointResource,
  type ChatProvider,
} from "@/api/chatEndpoints";
import { Button } from "@/components/ui/button";
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
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { PageTabBar } from "@/components/PageTabBar";
import { StatusBadge } from "@/components/StatusBadge";
import { Tabs } from "@/components/ui/tabs";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useToast } from "@/context/ToastContext";
import { formatDateTime } from "@/lib/utils";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link, Navigate, useNavigate, useParams } from "@/lib/router";
import { ApiError } from "@/api/client";
import { Trans } from "react-i18next";
import { i18n, useTranslation } from "@/i18n";

const tabs = ["settings", "access", "conversations", "activity"] as const;
type ChatTab = (typeof tabs)[number];
// Built on demand so the labels follow the active language.
const tabItems = () =>
  tabs.map((value) => ({
    value,
    label: {
      settings: i18n.t("area.apps-chat-email.chat-endpoint-detail.tabs.settings"),
      access: i18n.t("area.apps-chat-email.chat-endpoint-detail.tabs.access"),
      conversations: i18n.t("area.apps-chat-email.chat-endpoint-detail.tabs.conversations"),
      activity: i18n.t("area.apps-chat-email.chat-endpoint-detail.tabs.activity"),
    }[value],
  }));
const providerNames: Record<ChatProvider, string> = {
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
};

// Built on demand so the text follows the active language.
function providerLifecycleGuidance(provider: ChatProvider): {
  reconnect: string;
  remove: string;
} {
  const table: Record<ChatProvider, { reconnect: string; remove: string }> = {
    agentmail: {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.agentmail.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.agentmail.remove"),
    },
    slack: {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.slack.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.slack.remove"),
    },
    github: {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.github.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.github.remove"),
    },
    discord: {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.discord.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.discord.remove"),
    },
    "microsoft-teams": {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.teams.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.teams.remove"),
    },
    "imessage-photon": {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.photon.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.photon.remove"),
    },
    telegram: {
      reconnect: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.telegram.reconnect"),
      remove: i18n.t("area.apps-chat-email.chat-endpoint-detail.lifecycle.telegram.remove"),
    },
  };
  return table[provider];
}

function activityKindLabel(kind: ChatActivityItem["kind"]): string {
  const table: Record<ChatActivityItem["kind"], string> = {
    delivery: i18n.t("area.apps-chat-email.chat-endpoint-detail.activityKind.delivery"),
    publication: i18n.t("area.apps-chat-email.chat-endpoint-detail.activityKind.publication"),
    action: i18n.t("area.apps-chat-email.chat-endpoint-detail.activityKind.action"),
    health: i18n.t("area.apps-chat-email.chat-endpoint-detail.activityKind.health"),
    repair: i18n.t("area.apps-chat-email.chat-endpoint-detail.activityKind.repair"),
  };
  return table[kind];
}

const replayableFailureStates = new Set(["failed"]);
// Provider callbacks do not necessarily emit a Board activity event. Refresh
// only mounted operational views, and stop polling when the browser is hidden.
const liveChatQueryOptions = {
  staleTime: 0,
  refetchInterval: 5_000,
  refetchIntervalInBackground: false,
} as const;

export function isReplayEligible(item: ChatActivityItem): boolean {
  if (
    item.fileTransfer ||
    !item.replayable ||
    !replayableFailureStates.has(item.status)
  ) {
    return false;
  }
  if (item.kind === "delivery") return item.status === "failed";
  return item.kind === "publication";
}

export function activityResolutionActions(item: ChatActivityItem) {
  const offered = item.resolutionActions ?? [];
  if (!item.fileTransfer) return offered;
  if (
    item.kind !== "publication" ||
    !Number.isSafeInteger(item.fileTransfer.version) ||
    item.fileTransfer.version < 1
  )
    return [];
  if (
    ![
      "consent_unknown",
      "upload_unknown",
      "file_info_unknown",
      "conflict",
    ].includes(item.fileTransfer.phase)
  )
    return [];
  // Only the file-info stage can use ordinary visible-delivery resolution.
  // Earlier consent/upload evidence must not be fabricated by these buttons.
  return item.fileTransfer.phase === "file_info_unknown"
    ? offered
    : offered.filter((action) => action === "cancel");
}

export function activityResolutionDescription(item: ChatActivityItem): string {
  const phase = item.fileTransfer?.phase;
  if (phase === "file_info_unknown") return i18n.t("area.apps-chat-email.chat-endpoint-detail.resolution.fileInfoUnknown");
  if (phase === "consent_unknown") return i18n.t("area.apps-chat-email.chat-endpoint-detail.resolution.consentUnknown");
  if (phase) return i18n.t("area.apps-chat-email.chat-endpoint-detail.resolution.uploadUnknown");
  return i18n.t("area.apps-chat-email.chat-endpoint-detail.resolution.default");
}

export function isResolutionEligible(item: ChatActivityItem): boolean {
  return (
    (item.kind === "publication" || item.kind === "action") &&
    item.status === "delivery_unknown" &&
    activityResolutionActions(item).length > 0
  );
}

export function isIndividuallyToggleableResource(
  provider: ChatProvider,
  resourceType: string,
): boolean {
  return !(
    provider === "microsoft-teams" &&
    (resourceType === "direct_message" || resourceType === "group_chat")
  );
}

function activityDetailLabel(item: ChatActivityItem): string {
  return replayableFailureStates.has(item.status)
    ? i18n.t("area.apps-chat-email.chat-endpoint-detail.reason")
    : i18n.t("area.apps-chat-email.chat-endpoint-detail.details");
}

export function connectionHealthPresentation(
  endpoint: Pick<ChatEndpoint, "status" | "healthMessage" | "lastError">,
) {
  // Health events outlive pause/removal. They are history, not lifecycle state.
  const lifecycleMessages = {
    draft: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.draft"),
    verifying: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.verifying"),
    paused: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.paused"),
    attention: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.attention"),
    revoked: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.revoked"),
    archived: i18n.t("area.apps-chat-email.chat-endpoint-detail.health.archived"),
  };
  const lifecycleMessage =
    endpoint.status === "active" ? null : lifecycleMessages[endpoint.status];
  return {
    message: lifecycleMessage ?? endpoint.healthMessage ?? null,
    previousHealth: lifecycleMessage ? (endpoint.healthMessage ?? null) : null,
    error: endpoint.lastError ?? null,
    errorLabel: ["active", "attention", "revoked"].includes(endpoint.status)
      ? i18n.t("area.apps-chat-email.chat-endpoint-detail.reason")
      : i18n.t("area.apps-chat-email.chat-endpoint-detail.lastReportedError"),
  };
}

export function ChatEndpointDetail() {
  const { t } = useTranslation();
  const { endpointId = "", tab = "settings" } = useParams<{
    endpointId: string;
    tab?: string;
  }>();
  const activeTab = tabs.includes(tab as ChatTab) ? (tab as ChatTab) : null;
  const navigate = useNavigate();
  const { setBreadcrumbs } = useBreadcrumbs();
  const endpointQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.detail(endpointId),
    queryFn: () => chatEndpointsApi.get(endpointId),
    enabled: Boolean(endpointId && activeTab),
    ...liveChatQueryOptions,
    refetchInterval:
      activeTab === "activity" || activeTab === "conversations"
        ? liveChatQueryOptions.refetchInterval
        : false,
  });
  const endpoint = endpointQuery.data;
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const finishSetup = useMutation({
    mutationFn: () => chatEndpointsApi.test(endpoint!.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.detail(endpointId),
      });
    },
    onError: (error: unknown) => {
      const roundTripIncomplete =
        error instanceof ApiError &&
        error.status === 409 &&
        ((error.body as { code?: string } | null)?.code ===
          "chat_test_round_trip_incomplete" ||
          error.message.includes("round trip"));
      pushToast({
        title: roundTripIncomplete
          ? i18n.t("area.apps-chat-email.chat-endpoint-detail.finishSetupToast.incompleteTitle")
          : i18n.t("area.apps-chat-email.chat-endpoint-detail.finishSetupToast.failedTitle"),
        body: roundTripIncomplete
          ? i18n.t("area.apps-chat-email.chat-endpoint-detail.finishSetupToast.incompleteBody")
          : error instanceof Error
            ? error.message
            : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: roundTripIncomplete ? "warn" : "error",
      });
    },
  });

  useEffect(() => {
    if (!endpoint || !activeTab) return;
    setBreadcrumbs([
      { label: i18n.t("area.apps-chat-email.chat-endpoint-detail.breadcrumbConnectors"), href: "/apps" },
      {
        label: `${endpoint.assignedAgentName} · ${providerNames[endpoint.provider]}`,
        href: `/apps/chat/${endpoint.id}/settings`,
      },
      {
        label:
          tabItems().find((item) => item.value === activeTab)?.label ??
          i18n.t("area.apps-chat-email.chat-endpoint-detail.tabs.settings"),
      },
    ]);
    return () => setBreadcrumbs([]);
  }, [activeTab, endpoint, setBreadcrumbs]);

  if (!activeTab)
    return <Navigate replace to={`/apps/chat/${endpointId}/settings`} />;
  if (endpointQuery.isLoading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("area.apps-chat-email.chat-endpoint-detail.loading")}
      </div>
    );
  if (endpointQuery.isError || !endpoint)
    return (
      <div className="space-y-3">
        <p className="text-sm text-destructive">
          {t("area.apps-chat-email.chat-endpoint-detail.loadFailed")}
        </p>
        <Button variant="outline" onClick={() => endpointQuery.refetch()}>
          {t("area.apps-chat-email.chat-endpoint-detail.tryAgainButton")}
        </Button>
      </div>
    );
  if (endpoint.provider === "agentmail") return <EmailEndpointSettings endpointId={endpoint.id} companyId={endpoint.companyId} />;
  const setupIncomplete =
    endpoint.setup?.step !== "complete" &&
    ["draft", "verifying", "attention", "revoked"].includes(endpoint.status);
  // myrmidon(1.6.5-F10-B): when the wizard already reached its `test` stage the
  // operator can finish setup with one action here instead of re-walking the
  // wizard (server complete: POST /chat-endpoints/:id/test, same call the last
  // wizard step uses).
  const canFinishSetupHere =
    endpoint.status === "verifying" && endpoint.setup?.step === "test";

  return (
    <div className="max-w-5xl space-y-6 pb-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold">
            {t("area.apps-chat-email.chat-endpoint-detail.inProvider", {
              agent: endpoint.assignedAgentName,
              provider: providerNames[endpoint.provider],
            })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {endpoint.providerAccountLabel ?? t("area.apps-chat-email.chat-endpoint-detail.chatConnectionFallback")}
          </p>
          {endpoint.verifyingStale && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-900 dark:text-amber-100">
              <AlertTriangle className="h-3.5 w-3.5" />
              {t("area.apps-chat-email.chat-endpoint-detail.verifyingStale")}
            </p>
          )}
          {endpoint.provider === "imessage-photon" && endpoint.botExternalId && endpoint.photonAllocation !== "shared" && (
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <span>{endpoint.botExternalId}</span>
              <Button variant="ghost" size="sm" aria-label={t("area.apps-chat-email.chat-endpoint-detail.copyNumberAriaLabel")} onClick={async () => {
                try { await copyTextToClipboard(endpoint.botExternalId!); setCopyStatus(t("area.apps-chat-email.chat-endpoint-detail.numberCopied")); }
                catch { setCopyStatus(t("area.apps-chat-email.chat-endpoint-detail.numberCopyFailed")); }
              }}><Copy className="size-4" />{t("area.apps-chat-email.chat-endpoint-detail.copyNumber")}</Button>
              <span role="status" className="text-muted-foreground">{copyStatus}</span>
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          {canFinishSetupHere ? (
            <Button
              variant="outline"
              disabled={finishSetup.isPending}
              onClick={() => finishSetup.mutate()}
            >
              {finishSetup.isPending ? (
                <Loader2 className="animate-spin" />
              ) : (
                <Check />
              )}
              {t("area.apps-chat-email.chat-endpoint-detail.finishSetup")}
            </Button>
          ) : null}
          {setupIncomplete ? (
            <Button
              variant="outline"
              onClick={() =>
                navigate(
                  `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}`,
                )
              }
            >
              {t("area.apps-chat-email.chat-endpoint-detail.continueSetup")}
            </Button>
          ) : null}
          <StatusBadge status={endpoint.status} />
        </div>
      </header>
      <Tabs
        value={activeTab}
        onValueChange={(next) => navigate(`/apps/chat/${endpoint.id}/${next}`)}
      >
        <PageTabBar
          items={tabItems()}
          value={activeTab}
          onValueChange={(next) =>
            navigate(`/apps/chat/${endpoint.id}/${next}`)
          }
          align="start"
        />
      </Tabs>
      {activeTab === "settings" && (
        <Settings endpointId={endpoint.id} endpoint={endpoint} />
      )}
      {activeTab === "access" && (
        <Access
          endpointId={endpoint.id}
          allowUnlinked={endpoint.allowUnlinkedPeople}
        />
      )}
      {activeTab === "conversations" && (
        <Conversations endpointId={endpoint.id} provider={endpoint.provider} />
      )}
      {activeTab === "activity" && (
        <Activity endpointId={endpoint.id} endpoint={endpoint} />
      )}
    </div>
  );
}

function Settings({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const resourcesQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.resources(endpointId),
    queryFn: () => chatEndpointsApi.listResources(endpointId),
  });
  const saveResources = useMutation({
    mutationFn: (resource: Pick<ChatEndpointResource, "id" | "enabled">) =>
      chatEndpointsApi.updateResources(endpointId, [resource]),
    onSuccess: (resources) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.resources(endpointId),
        resources,
      ),
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.settings.destinationUpdateFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const updateEndpoint = useMutation({
    mutationFn: chatEndpointsApi.update.bind(null, endpointId),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.settings.updateFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const resources = resourcesQuery.data ?? [];
  const destinationResources = resources.filter((resource) =>
    isIndividuallyToggleableResource(endpoint.provider, resource.type),
  );
  const toggleResource = (resource: ChatEndpointResource, enabled: boolean) =>
    // A cached inventory must not overwrite another operator's unrelated edits.
    saveResources.mutate({ id: resource.id, enabled });
  return (
    <section className="max-w-3xl space-y-7">
      {endpoint.provider === "imessage-photon" && <p className="text-sm text-muted-foreground">{endpoint.photonAllocation === "shared" ? t("area.apps-chat-email.chat-endpoint-detail.settings.photonShared") : t("area.apps-chat-email.chat-endpoint-detail.settings.photonDedicated")}</p>}
      {endpoint.provider === "slack" && endpoint.setup?.command && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            {t("area.apps-chat-email.chat-endpoint-detail.settings.slackCommandTitle")}
          </h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>{endpoint.setup.command}</code>
            <p className="mt-2 text-muted-foreground">
              <Trans
                i18nKey="area.apps-chat-email.chat-endpoint-detail.settings.slackCommandHelp"
                values={{ command: endpoint.setup.command }}
                components={[<code key="code" />]}
              />
            </p>
          </div>
        </div>
      )}
      {endpoint.provider === "telegram" && (
        <div className="space-y-2">
          <h2 className="text-lg font-semibold">
            {t("area.apps-chat-email.chat-endpoint-detail.settings.telegramCommandTitle")}
          </h2>
          <div className="rounded-lg border border-border p-3 text-sm">
            <code>
              /task@
              {endpoint.botUsername?.replace(/^@/, "") ?? "bot_username"}{" "}
              &lt;request&gt;
            </code>
            <p className="mt-2 text-muted-foreground">
              {t("area.apps-chat-email.chat-endpoint-detail.settings.telegramCommandHelp")}
            </p>
          </div>
        </div>
      )}
      <div>
        <h2 className="text-lg font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.settings.whereTitle")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-detail.settings.whereHelp")}
        </p>
      </div>
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.settings.destinations")}
        </h3>
        {resourcesQuery.isLoading ? (
          <p className="text-sm text-muted-foreground">
            {t("area.apps-chat-email.chat-endpoint-detail.settings.destinationsLoading")}
          </p>
        ) : destinationResources.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("area.apps-chat-email.chat-endpoint-detail.settings.destinationsEmpty")}
          </p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {destinationResources.map((resource) => (
              <div key={resource.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {resource.label}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {resource.availability === "available"
                      ? (resource.detail ?? resource.type)
                      : t("area.apps-chat-email.chat-endpoint-detail.settings.unavailableAtProvider")}
                  </p>
                  {resource.participants?.length ? <p className="mt-1 break-words text-xs text-muted-foreground">{t("area.apps-chat-email.chat-endpoint-detail.settings.participants", { list: resource.participants.join(", ") })}</p> : null}
                </div>
                <ToggleSwitch
                  aria-label={t("area.apps-chat-email.chat-endpoint-detail.settings.enableResource", { label: resource.label })}
                  checked={resource.enabled}
                  disabled={
                    endpoint.photonAllocation === "shared" ||
                    resource.availability !== "available" ||
                    saveResources.isPending
                  }
                  onCheckedChange={(enabled) =>
                    toggleResource(resource, enabled)
                  }
                />
              </div>
            ))}
          </div>
        )}
      </div>
      {endpoint.provider !== "github" && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">
            {t("area.apps-chat-email.chat-endpoint-detail.settings.privateConversations")}
          </h3>
          <SettingToggle
            label={t("area.apps-chat-email.chat-endpoint-detail.settings.allowDirectMessages")}
            detail={
              endpoint.provider === "discord"
                ? t("area.apps-chat-email.chat-endpoint-detail.settings.directMessagesDiscord")
                : t("area.apps-chat-email.chat-endpoint-detail.settings.directMessagesDefault")
            }
            checked={endpoint.allowDirectMessages ?? false}
            pending={updateEndpoint.isPending}
            onChange={(allowDirectMessages) =>
              updateEndpoint.mutate({ allowDirectMessages })
            }
          />
          {endpoint.provider === "microsoft-teams" && (
            <SettingToggle
              label={t("area.apps-chat-email.chat-endpoint-detail.settings.allowGroupChats")}
              detail={t("area.apps-chat-email.chat-endpoint-detail.settings.groupChatsDetail")}
              checked={endpoint.allowGroupChats ?? false}
              pending={updateEndpoint.isPending}
              onChange={(allowGroupChats) =>
                updateEndpoint.mutate({ allowGroupChats })
              }
            />
          )}
        </div>
      )}
    </section>
  );
}

function SettingToggle({
  label,
  detail,
  checked,
  pending,
  onChange,
}: {
  label: string;
  detail: string;
  checked: boolean;
  pending: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-center gap-3 border-y border-border py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
      <ToggleSwitch
        aria-label={label}
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

function Access({
  endpointId,
  allowUnlinked,
}: {
  endpointId: string;
  allowUnlinked: boolean;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [confirmationUrl, setConfirmationUrl] = useState<string | null>(null);
  const linksQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
  });
  const updatePolicy = useMutation({
    mutationFn: (value: boolean) =>
      chatEndpointsApi.update(endpointId, { allowUnlinkedPeople: value }),
    onSuccess: (next) =>
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      ),
  });
  const createIntent = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.createLinkIntent(endpointId, principalId),
    onSuccess: ({ confirmationUrl }) => {
      setConfirmationUrl(
        new URL(confirmationUrl, window.location.origin).toString(),
      );
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCreatedTitle"),
        body: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCreatedBody"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCreateFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const revoke = useMutation({
    mutationFn: (principalId: string) =>
      chatEndpointsApi.revokeLink(endpointId, principalId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.principals(endpointId),
      }),
  });
  const links = linksQuery.data ?? [];
  return (
    <section className="max-w-3xl space-y-7">
      <div>
        <h2 className="text-lg font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.access.title")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-detail.access.description")}
        </p>
      </div>
      <SettingToggle
        label={t("area.apps-chat-email.chat-endpoint-detail.access.allowUnlinked")}
        detail={t("area.apps-chat-email.chat-endpoint-detail.access.unlinkedDetail")}
        checked={allowUnlinked}
        pending={updatePolicy.isPending}
        onChange={(value) => updatePolicy.mutate(value)}
      />
      {confirmationUrl && (
        <div className="space-y-2 border-y border-border py-3">
          <p className="text-sm font-medium">{t("area.apps-chat-email.chat-endpoint-detail.access.confirmationLink")}</p>
          <p className="break-all text-xs text-muted-foreground">
            {confirmationUrl}
          </p>
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              void copyTextToClipboard(confirmationUrl).then(
                () =>
                  pushToast({
                    title: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCopied"),
                    tone: "success",
                  }),
                () =>
                  pushToast({
                    title: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCopyFailedTitle"),
                    body: i18n.t("area.apps-chat-email.chat-endpoint-detail.access.linkCopyFailedBody"),
                    tone: "error",
                  }),
              );
            }}
          >
            <Copy />
            {t("area.apps-chat-email.chat-endpoint-detail.access.copyLink")}
          </Button>
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.access.identityLinks")}
        </h3>
        {links.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {t("area.apps-chat-email.chat-endpoint-detail.access.empty")}
          </p>
        ) : (
          <div className="divide-y divide-border border-y border-border">
            {links.map((link) => (
              <div
                key={link.id}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{link.externalLabel}</p>
                  <p className="text-xs text-muted-foreground">
                    {link.paperclipUserLabel
                      ? t("area.apps-chat-email.chat-endpoint-detail.access.linkedTo", {
                          user: link.paperclipUserLabel,
                        })
                      : (link.externalDetail ?? t("area.apps-chat-email.chat-endpoint-detail.access.notLinked"))}
                  </p>
                </div>
                {link.status === "linked" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={revoke.isPending}
                    onClick={() => revoke.mutate(link.principalId)}
                  >
                    <Unlink />
                    {t("area.apps-chat-email.chat-endpoint-detail.access.revoke")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={createIntent.isPending}
                    onClick={() => createIntent.mutate(link.principalId)}
                  >
                    {t("area.apps-chat-email.chat-endpoint-detail.access.createPrivateLink")}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function Conversations({
  endpointId,
  provider,
}: {
  endpointId: string;
  provider: ChatProvider;
}) {
  const { t } = useTranslation();
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.conversations(endpointId),
    queryFn: () => chatEndpointsApi.listConversations(endpointId),
    ...liveChatQueryOptions,
  });
  const rows = query.data ?? [];
  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.conversations.title")}
        </h2>
      </div>
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-detail.conversations.empty")}
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {rows.map((row) => (
            <div key={row.id} className="grid gap-3 py-4 md:grid-cols-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.externalLabel}
                </p>
                <p className="text-xs text-muted-foreground">
                  {providerNames[provider]}
                </p>
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {row.issueIdentifier ? `${row.issueIdentifier} · ` : ""}
                  {row.issueTitle ?? t("area.apps-chat-email.chat-endpoint-detail.conversations.waitingForTask")}
                </p>
                <StatusBadge status={row.state} />
              </div>
              <div className="flex flex-wrap items-center gap-2 md:justify-end">
                {row.externalUrl && (
                  <Button asChild size="sm" variant="outline">
                    <a href={row.externalUrl} target="_blank" rel="noreferrer">
                      {t("area.apps-chat-email.chat-endpoint-detail.conversations.openProvider", {
                        provider: providerNames[provider],
                      })}{" "}
                      <ExternalLink />
                    </a>
                  </Button>
                )}
                {row.issueId && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/issues/${row.issueId}`}>
                      {t("area.apps-chat-email.chat-endpoint-detail.conversations.openTask")}
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Activity({
  endpointId,
  endpoint,
}: {
  endpointId: string;
  endpoint: Awaited<ReturnType<typeof chatEndpointsApi.get>>;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const [removeOpen, setRemoveOpen] = useState(false);
  const [resolutionItem, setResolutionItem] = useState<ChatActivityItem | null>(
    null,
  );
  const query = useQuery({
    queryKey: queryKeys.chatEndpoints.activity(endpointId),
    queryFn: () => chatEndpointsApi.listActivity(endpointId),
    ...liveChatQueryOptions,
  });
  const replay = useMutation({
    mutationFn: (item: ChatActivityItem) =>
      item.kind === "publication"
        ? chatEndpointsApi.replayPublication(endpointId, item.id)
        : chatEndpointsApi.replayDelivery(endpointId, item.id),
    onSuccess: async (_result, item) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title:
          item.kind === "publication"
            ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.replayQueuedPublication")
            : i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.replayQueuedDelivery"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.replayFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const resolveActivity = useMutation({
    mutationFn: (input: {
      item: ChatActivityItem;
      action: "mark_delivered" | "retry_anyway" | "cancel";
    }) => {
      if (input.item.kind === "publication") {
        return chatEndpointsApi.resolvePublication(
          endpointId,
          input.item.id,
          input.action,
          input.item.fileTransfer
            ? {
                phase: input.item.fileTransfer.phase,
                version: input.item.fileTransfer.version,
              }
            : undefined,
        );
      }
      return chatEndpointsApi.resolveAction(
        endpointId,
        input.item.id,
        input.action,
      );
    },
    onSuccess: async (_result, input) => {
      setResolutionItem(null);
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.activity(endpointId),
      });
      pushToast({
        title:
          input.item.actionType === "slash_task_start" &&
          input.action === "retry_anyway"
            ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.taskStartRetried")
            : input.item.actionType === "slash_task_start"
              ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.taskStartCancelled")
              : input.item.actionType === "provider_effect" &&
                  input.action === "mark_delivered"
                ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.replyDelivered")
                : input.item.actionType === "provider_effect" &&
                    input.action === "retry_anyway"
                  ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.replyRetried")
                  : input.item.actionType === "provider_effect"
                    ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.replyCancelled")
                    : input.action === "mark_delivered"
                      ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.publicationDelivered")
                      : input.action === "retry_anyway"
                        ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.publicationRetried")
                        : i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolved.publicationCancelled"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resolveFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const lifecycle = useMutation({
    mutationFn: (action: "pause" | "resume" | "remove") =>
      chatEndpointsApi.setup(endpointId, { action }),
    onSuccess: async (next, action) => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.chatEndpoints.list(next.companyId),
      });
      if (action === "remove") {
        navigate("/apps");
        return;
      }
      queryClient.setQueryData(
        queryKeys.chatEndpoints.detail(endpointId),
        next,
      );
      pushToast({
        title:
          action === "pause"
            ? i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.paused")
            : i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.resumed"),
        tone: "success",
      });
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-detail.activity.connectionUpdateFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-detail.tryAgainSentence"),
        tone: "error",
      }),
  });
  const rows = query.data ?? [];
  const { status } = endpoint;
  const health = connectionHealthPresentation(endpoint);
  const lifecycleAction = lifecycle.variables;
  const callbackSurfaceRows = endpoint.setup?.callbackSurfaces
    ? ([
        [t("area.apps-chat-email.chat-endpoint-detail.activity.callbackEvents"), endpoint.setup.callbackSurfaces.events],
        [t("area.apps-chat-email.chat-endpoint-detail.activity.callbackInteractivity"), endpoint.setup.callbackSurfaces.interactivity],
        [t("area.apps-chat-email.chat-endpoint-detail.activity.callbackSlashCommand"), endpoint.setup.callbackSurfaces.slashCommands],
      ] as const)
    : [];
  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">
        {t("area.apps-chat-email.chat-endpoint-detail.activity.title")}
      </h2>
      {(health.message || health.error) && (
        <div
          className={`flex items-start gap-2 rounded-lg border p-3 text-sm ${status === "attention" || status === "revoked" ? "border-destructive/40 bg-destructive/5 text-destructive" : "border-border bg-muted/30 text-foreground"}`}
        >
          {(status === "attention" || status === "revoked") && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div>
            {health.message && <p>{health.message}</p>}
            {health.previousHealth && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">
                  {t("area.apps-chat-email.chat-endpoint-detail.activity.lastReportedHealth")}:
                </span>{" "}
                {health.previousHealth}
              </p>
            )}
            {health.error && (
              <p className="mt-1 text-xs opacity-80">
                <span className="font-medium">{health.errorLabel}:</span>{" "}
                {health.error}
              </p>
            )}
          </div>
        </div>
      )}
      {endpoint.provider === "slack" && callbackSurfaceRows.length > 0 && (
        <div
          className={`rounded-lg border p-3 text-sm ${endpoint.setup?.callbacksNeedUpdate ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/30"}`}
        >
          <p className="font-medium">{t("area.apps-chat-email.chat-endpoint-detail.activity.callbackHealth")}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {endpoint.setup?.callbacksNeedUpdate
              ? t("area.apps-chat-email.chat-endpoint-detail.activity.callbacksNeedUpdate")
              : t("area.apps-chat-email.chat-endpoint-detail.activity.callbacksNote")}
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-3">
            {callbackSurfaceRows.map(([label, surface]) => (
              <div key={label} className="rounded-md border border-border p-2">
                <p className="text-xs font-medium">{label}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {surface.status === "current"
                    ? t("area.apps-chat-email.chat-endpoint-detail.activity.surfaceCurrent")
                    : surface.status === "stale"
                      ? t("area.apps-chat-email.chat-endpoint-detail.activity.surfaceStale")
                      : t("area.apps-chat-email.chat-endpoint-detail.activity.surfaceNotObserved")}
                </p>
                {surface.observedAt && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t("area.apps-chat-email.chat-endpoint-detail.activity.lastObserved")}{" "}
                    <time
                      dateTime={surface.observedAt}
                      title={surface.observedAt}
                      className="font-mono"
                    >
                      {formatDateTime(surface.observedAt, {
                        includeSeconds: true,
                      })}
                    </time>
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
      {status !== "archived" && (
        <div className="space-y-2 border-y border-border py-3">
          <div className="flex flex-wrap items-center gap-2">
            {status === "active" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("pause")}
              >
                {lifecycle.isPending && lifecycleAction === "pause" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Pause />
                )}
                {t("area.apps-chat-email.chat-endpoint-detail.activity.pause")}
              </Button>
            )}
            {status === "paused" && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() => lifecycle.mutate("resume")}
              >
                {lifecycle.isPending && lifecycleAction === "resume" ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <Play />
                )}
                {t("area.apps-chat-email.chat-endpoint-detail.activity.resume")}
              </Button>
            )}
            {[
              "active",
              "paused",
              "attention",
              "revoked",
              "draft",
              "verifying",
            ].includes(status) && (
              <Button
                variant="outline"
                disabled={lifecycle.isPending}
                onClick={() =>
                  navigate(
                    `/apps/chat/connect?provider=${endpoint.provider}&purpose=chat&resume=${endpoint.id}${status === "draft" || status === "verifying" ? "" : "&reconnect=1"}`,
                  )
                }
              >
                <RefreshCw />
                {status === "draft" || status === "verifying"
                  ? t("area.apps-chat-email.chat-endpoint-detail.finishSetup")
                  : t("area.apps-chat-email.chat-endpoint-detail.activity.reconnect")}
              </Button>
            )}
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              disabled={lifecycle.isPending}
              onClick={() => setRemoveOpen(true)}
            >
              <Trash2 />
              {t("area.apps-chat-email.chat-endpoint-detail.activity.removeConnection")}
            </Button>
          </div>
          {status !== "draft" && status !== "verifying" && (
            <p className="text-xs text-muted-foreground">
              {providerLifecycleGuidance(endpoint.provider).reconnect}
            </p>
          )}
        </div>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">
          {t("area.apps-chat-email.chat-endpoint-detail.activity.historyTitle")}
        </h3>
        <div className="divide-y divide-border border-y border-border">
          {query.isLoading && (
            <div className="flex items-center gap-2 py-5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("area.apps-chat-email.chat-endpoint-detail.activity.loading")}
            </div>
          )}
          {query.isError && (
            <div className="flex flex-wrap items-center justify-between gap-3 py-4">
              <p className="text-sm text-destructive" role="alert">
                {t("area.apps-chat-email.chat-endpoint-detail.activity.loadFailed")}
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => query.refetch()}
              >
                {t("area.apps-chat-email.chat-endpoint-detail.tryAgainButton")}
              </Button>
            </div>
          )}
          {!query.isLoading &&
            !query.isError &&
            rows.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-start gap-3 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-muted-foreground">
                      {activityKindLabel(item.kind)}
                    </span>
                    <StatusBadge status={item.status} />
                    <time
                      dateTime={item.createdAt}
                      title={item.createdAt}
                      className="font-mono text-xs text-muted-foreground"
                    >
                      {formatDateTime(item.createdAt, { includeSeconds: true })}
                    </time>
                  </div>
                  <p className="mt-2 text-sm font-medium">{item.summary}</p>
                  {item.fileTransfer && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.fileTransfer.filename} —{" "}
                      {item.fileTransfer.phase.replaceAll("_", " ")}
                    </p>
                  )}
                  {item.detail && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">
                        {activityDetailLabel(item)}:
                      </span>{" "}
                      {item.detail}
                    </p>
                  )}
                </div>
                {isReplayEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={t("area.apps-chat-email.chat-endpoint-detail.activity.replayAriaLabel", {
                      kind: activityKindLabel(item.kind),
                    })}
                    disabled={replay.isPending}
                    onClick={() => replay.mutate(item)}
                  >
                    {replay.isPending && replay.variables?.id === item.id ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <RefreshCw />
                    )}
                    {t("area.apps-chat-email.chat-endpoint-detail.activity.replay")}
                  </Button>
                )}
                {isResolutionEligible(item) && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setResolutionItem(item)}
                  >
                    {t("area.apps-chat-email.chat-endpoint-detail.activity.resolve")}
                  </Button>
                )}
              </div>
            ))}
          {!query.isLoading && !query.isError && rows.length === 0 && (
            <p className="py-5 text-sm text-muted-foreground">
              {t("area.apps-chat-email.chat-endpoint-detail.activity.empty")}
            </p>
          )}
        </div>
      </div>
      <AlertDialog
        open={resolutionItem !== null}
        onOpenChange={(open) => !open && setResolutionItem(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.titleTaskStart")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.titleReply")
                  : t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.titleDelivery")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {resolutionItem?.actionType === "slash_task_start"
                ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.bodyTaskStart")
                : resolutionItem?.actionType === "provider_effect"
                  ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.bodyReply")
                  : resolutionItem
                    ? activityResolutionDescription(resolutionItem)
                    : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter className="sm:flex-wrap">
            <AlertDialogCancel disabled={resolveActivity.isPending}>
              {t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.keep")}
            </AlertDialogCancel>
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes("cancel") && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "cancel",
                    })
                  }
                >
                  {resolutionItem.actionType === "slash_task_start"
                    ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.cancelTaskStart")
                    : resolutionItem.actionType === "provider_effect"
                      ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.cancelReply")
                      : resolutionItem.fileTransfer
                        ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.cancelFileTransfer")
                        : t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.cancelPublication")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "retry_anyway",
              ) && (
                <Button
                  variant="outline"
                  disabled={resolveActivity.isPending}
                  onClick={() =>
                    resolutionItem &&
                    resolveActivity.mutate({
                      item: resolutionItem,
                      action: "retry_anyway",
                    })
                  }
                >
                  {resolutionItem.fileTransfer
                    ? t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.retryFileNotification")
                    : t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.retryAnyway")}
                </Button>
              )}
            {resolutionItem &&
              activityResolutionActions(resolutionItem).includes(
                "mark_delivered",
              ) && (
                <AlertDialogAction
                  disabled={resolveActivity.isPending}
                  onClick={(event) => {
                    event.preventDefault();
                    if (resolutionItem) {
                      resolveActivity.mutate({
                        item: resolutionItem,
                        action: "mark_delivered",
                      });
                    }
                  }}
                >
                  {t("area.apps-chat-email.chat-endpoint-detail.activity.resolveDialog.markDelivered")}
                </AlertDialogAction>
              )}
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("area.apps-chat-email.chat-endpoint-detail.activity.removeDialog.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("area.apps-chat-email.chat-endpoint-detail.activity.removeDialog.body", {
                agent: endpoint.assignedAgentName,
                provider: providerNames[endpoint.provider],
              })}{" "}
              {providerLifecycleGuidance(endpoint.provider).remove}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={lifecycle.isPending}
              onClick={() => lifecycle.mutate("remove")}
            >
              {lifecycle.isPending && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {t("area.apps-chat-email.chat-endpoint-detail.activity.removeConnection")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
