import { PhotonConnectStep } from "./PhotonConnectStep";
import { EmailEndpointSetup } from "./EmailEndpointSetup";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react";
import { AgentSelect } from "@/components/AgentMultiSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToast } from "@/context/ToastContext";
import { agentsApi } from "@/api/agents";
import { instanceSettingsApi } from "@/api/instanceSettings";
import {
  chatEndpointsApi,
  type ChatEndpoint,
  type ChatProvider,
  type ChatEndpointSetupAction,
} from "@/api/chatEndpoints";
import { useNavigate, useSearchParams } from "@/lib/router";
import { queryKeys } from "@/lib/queryKeys";
import { copyTextToClipboard } from "@/lib/clipboard";
import { isAgentStatusInvokable } from "@paperclipai/shared";
import { sanitizedSetupErrorMessage } from "./chat-setup-error";
import {
  createGitHubPrivateKeyReadGuard,
  readGitHubPrivateKeyFile,
} from "./github-private-key-file";
import { Trans } from "react-i18next";
import { i18n, useTranslation } from "@/i18n";

// Component list for <Trans>: <0> is bold text, <1> is inline code.
const strongCode = [<strong key="strong" />, <code key="code" />];

const providerNames: Record<ChatProvider, string> = {
  agentmail: "AgentMail",
  slack: "Slack",
  github: "GitHub",
  discord: "Discord",
  "microsoft-teams": "Microsoft Teams",
  telegram: "Telegram",
  "imessage-photon": "iMessage Photon",
};

const knownProviders = new Set(Object.keys(providerNames));

function isProvider(value: string | null): value is ChatProvider {
  return value !== null && knownProviders.has(value);
}

function slackBotNameForAgent(agentName: string): string {
  const safeName = agentName
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return safeName || "paperclip-agent";
}

function publicOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isChatEndpointRepairing(
  endpoint: Pick<
    ChatEndpoint,
    "provider" | "status" | "providerAccountId" | "botExternalId"
  > | null,
  resumeEndpointId: string | null,
  reconnectRequested: boolean,
): boolean {
  if (!resumeEndpointId || !endpoint) return false;
  const recoveringStatus =
    endpoint.status === "attention" || endpoint.status === "revoked";
  // A secret-only GitHub draft affected by setup trouble has no App identity
  // or reusable App credentials. It must remain first-time setup, where App ID
  // and private key are required, rather than offering a misleading reconnect.
  if (
    endpoint.provider === "github" &&
    recoveringStatus &&
    !endpoint.providerAccountId &&
    !endpoint.botExternalId
  ) {
    return false;
  }
  return (
    recoveringStatus ||
    (reconnectRequested &&
      (endpoint.status === "active" || endpoint.status === "paused"))
  );
}

function SetupRail({ step }: { step: number }) {
  const { t } = useTranslation();
  return (
    <ol className="space-y-2 text-sm" aria-label={t("area.apps-chat-email.chat-endpoint-setup.rail.ariaLabel")}>
      {[
        t("area.apps-chat-email.chat-endpoint-setup.rail.chooseAgent"),
        t("area.apps-chat-email.chat-endpoint-setup.rail.connectProvider"),
        t("area.apps-chat-email.chat-endpoint-setup.rail.tryIt"),
      ].map((label, index) => (
        <li key={label} className="flex items-center gap-2">
          <span
            className={`flex h-6 w-6 items-center justify-center rounded-full border ${index < step ? "border-primary bg-primary text-primary-foreground" : index === step ? "border-foreground text-foreground" : "border-border text-muted-foreground"}`}
          >
            {index < step ? <Check className="h-3.5 w-3.5" /> : index + 1}
          </span>
          <span
            className={
              index === step
                ? "font-medium text-foreground"
                : "text-muted-foreground"
            }
          >
            {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function ChatEndpointSetup() {
  const [params] = useSearchParams();
  return params.get("provider") === "agentmail" ? <EmailEndpointSetup /> : <ChatSdkEndpointSetup />;
}
function ChatSdkEndpointSetup() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToast();
  const provider = isProvider(params.get("provider"))
    ? (params.get("provider") as ChatProvider)
    : null;
  const toolHref = params.get("toolHref") || "/apps";
  const preselectedAgent = params.get("agentId") ?? "";
  const resumeEndpointId = params.get("resume") ?? "";
  const reconnectRequested = params.get("reconnect") === "1";
  const [purpose, setPurpose] = useState<"choice" | "chat">(
    params.get("purpose") === "chat" ? "chat" : "choice",
  );
  const [agentId, setAgentId] = useState(preselectedAgent);
  const [endpoint, setEndpoint] = useState<ChatEndpoint | null>(null);
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [generatedWebhookSecret, setGeneratedWebhookSecret] = useState("");
  const [setupError, setSetupError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: i18n.t("area.apps-chat-email.chat-endpoint-setup.breadcrumbs.connectors"), href: "/apps" },
      { label: i18n.t("area.apps-chat-email.chat-endpoint-setup.breadcrumbs.connectChat") },
    ]);
    return () => setBreadcrumbs([]);
  }, [setBreadcrumbs]);

  const agentsQuery = useQuery({
    queryKey: ["chat-endpoint-setup-agents", selectedCompanyId],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const resumeQuery = useQuery({
    queryKey: ["chat-endpoint-setup-resume", resumeEndpointId],
    queryFn: () => chatEndpointsApi.get(resumeEndpointId),
    enabled: Boolean(resumeEndpointId),
  });
  useEffect(() => {
    if (!resumeQuery.data) return;
    setEndpoint(resumeQuery.data);
    setAgentId(resumeQuery.data.assignedAgentId);
    setPurpose("chat");
  }, [resumeQuery.data]);
  const githubVerificationQuery = useQuery({
    queryKey: ["chat-endpoint-github-webhook-verification", endpoint?.id],
    queryFn: () => chatEndpointsApi.get(endpoint!.id),
    enabled: Boolean(
      provider === "github" &&
      endpoint?.id &&
      endpoint.setup?.step === "provider_setup" &&
      endpoint.setup?.webhookSecretConfigured &&
      !endpoint.setup.webhookVerifiedAt,
    ),
    refetchInterval: 1_500,
  });
  useEffect(() => {
    if (
      !githubVerificationQuery.data ||
      provider !== "github" ||
      !endpoint ||
      endpoint.id !== githubVerificationQuery.data.id ||
      endpoint.setup?.step !== "provider_setup" ||
      !endpoint.setup?.webhookSecretConfigured ||
      endpoint.setup.webhookVerifiedAt
    )
      return;
    setEndpoint(githubVerificationQuery.data);
  }, [endpoint, githubVerificationQuery.data, provider]);
  const experimentalSettingsQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: endpoint?.setup?.step === "test",
  });
  const activeAgents = useMemo(
    () =>
      (agentsQuery.data ?? []).filter((agent) =>
        isAgentStatusInvokable(agent.status),
      ),
    [agentsQuery.data],
  );
  const syncEndpointSnapshot = (
    next: ChatEndpoint,
    onlyIfStillVisible = false,
  ) => {
    setEndpoint((visible) =>
      onlyIfStillVisible && visible?.id !== next.id ? visible : next,
    );
    queryClient.setQueryData(["chat-endpoint-setup-resume", next.id], next);
    queryClient.setQueryData(queryKeys.chatEndpoints.detail(next.id), next);
    if (next.provider === "github") {
      queryClient.setQueryData(
        ["chat-endpoint-github-webhook-verification", next.id],
        next,
      );
    }
  };
  const createEndpoint = useMutation({
    mutationFn: () =>
      chatEndpointsApi.create(selectedCompanyId!, {
        provider: provider!,
        assignedAgentId: agentId,
      }),
    onSuccess: (next) => {
      syncEndpointSnapshot(next);
      if (next.provider === "imessage-photon") {
        const resumed = new URLSearchParams(params);
        resumed.set("resume", next.id);
        setParams(resumed, { replace: true });
      }
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-setup.createFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-setup.tryAgain"),
        tone: "error",
      }),
  });
  const setupAction = useMutation({
    mutationFn: ({
      action,
      values,
    }: {
      action: ChatEndpointSetupAction;
      values?: Record<string, string>;
    }) => chatEndpointsApi.setup(endpoint!.id, provider === "imessage-photon" ? {
      action,
      ...(values?.projectSecret ? { credentials: { projectSecret: values.projectSecret } } : {}),
      ...(values?.projectId && values.allocation === "shared" ? { photon: { allocation: "shared" as const, projectId: values.projectId } } : values?.projectId && values?.lineId ? { photon: { allocation: "dedicated" as const, projectId: values.projectId, lineId: values.lineId } } : {}),
    } : { action, credentials: values }),
    onMutate: () => setSetupError(null),
    onSuccess: (next) => {
      setSetupError(null);
      syncEndpointSnapshot(next);
      setCredentials({});
    },
    onError: (error, variables) =>
      setSetupError(sanitizedSetupErrorMessage(error, variables.values)),
  });
  const generateSetupSecret = useMutation({
    mutationFn: () => chatEndpointsApi.generateSetupSecret(endpoint!.id),
    onMutate: async () => {
      const endpointId = endpoint!.id;
      await Promise.all([
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: ["chat-endpoint-setup-resume", endpointId],
          exact: true,
        }),
        queryClient.cancelQueries({
          queryKey: queryKeys.chatEndpoints.detail(endpointId),
          exact: true,
        }),
      ]);
      return { endpointId };
    },
    onSuccess: async ({ webhookSecret }, _variables, context) => {
      const endpointId = context.endpointId;
      const markRotated = (current: ChatEndpoint) => ({
        ...current,
        setup: {
          ...current.setup,
          step: "provider_setup" as const,
          webhookSecretConfigured: true,
          webhookVerifiedAt: null,
        },
      });

      queryClient.removeQueries({
        queryKey: ["chat-endpoint-github-webhook-verification", endpointId],
        exact: true,
      });
      setGeneratedWebhookSecret(webhookSecret);
      setEndpoint((current) =>
        current && current.id === endpointId ? markRotated(current) : current,
      );
      queryClient.setQueryData<ChatEndpoint>(
        ["chat-endpoint-setup-resume", endpointId],
        (current) => (current ? markRotated(current) : current),
      );
      queryClient.setQueryData<ChatEndpoint>(
        queryKeys.chatEndpoints.detail(endpointId),
        (current) => (current ? markRotated(current) : current),
      );

      try {
        const current = await chatEndpointsApi.get(endpointId);
        syncEndpointSnapshot(current, true);
      } catch {
        // Keep the one-time secret copyable. Verification polling will retry the
        // canonical endpoint read without restoring a pre-rotation snapshot.
      }
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-setup.generateSecretFailed"),
        body: error instanceof Error ? error.message : i18n.t("area.apps-chat-email.chat-endpoint-setup.tryAgain"),
        tone: "error",
      }),
  });
  const testConnection = useMutation({
    mutationFn: () => chatEndpointsApi.test(endpoint!.id),
    onSuccess: (next) => {
      syncEndpointSnapshot(next);
      if (next.status === "active") navigate(`/apps/chat/${next.id}/settings`);
    },
    onError: (error) =>
      pushToast({
        title: i18n.t("area.apps-chat-email.chat-endpoint-setup.testIncomplete.title"),
        body:
          error instanceof Error
            ? error.message
            : i18n.t("area.apps-chat-email.chat-endpoint-setup.testIncomplete.body"),
        tone: "error",
      }),
  });

  if (!provider)
    return (
      <p className="text-sm text-destructive">
        {t("area.apps-chat-email.chat-endpoint-setup.unsupported")}
      </p>
    );
  if (!selectedCompanyId)
    return (
      <p className="text-sm text-muted-foreground">
        {t("area.apps-chat-email.chat-endpoint-setup.selectOrganization")}
      </p>
    );

  if (purpose === "choice") {
    return (
      <div className="max-w-2xl space-y-6">
        <div>
          <h1 className="text-xl font-bold">{t("area.apps-chat-email.chat-endpoint-setup.choice.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("area.apps-chat-email.chat-endpoint-setup.choice.question", { provider: providerNames[provider] })}
          </p>
        </div>
        <div className="grid gap-3">
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={() => setPurpose("chat")}
          >
            <span className="block text-sm font-semibold">
              {t("area.apps-chat-email.chat-endpoint-setup.choice.chatTitle")}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t("area.apps-chat-email.chat-endpoint-setup.choice.chatBody", { provider: providerNames[provider] })}
            </span>
          </button>
          <button
            type="button"
            className="rounded-xl border border-border p-4 text-left hover:bg-accent/40"
            onClick={() => navigate(toolHref)}
          >
            <span className="block text-sm font-semibold">
              {t("area.apps-chat-email.chat-endpoint-setup.choice.toolTitle")}
            </span>
            <span className="mt-1 block text-sm text-muted-foreground">
              {t("area.apps-chat-email.chat-endpoint-setup.choice.toolBody", { provider: providerNames[provider] })}
            </span>
          </button>
        </div>
      </div>
    );
  }

  const repairing = isChatEndpointRepairing(
    endpoint,
    resumeEndpointId,
    reconnectRequested,
  );
  const step = endpoint
    ? !repairing &&
      (endpoint.setup?.step === "test" || endpoint.setup?.step === "complete")
      ? 2
      : 1
    : 0;
  const selectedAgent = activeAgents.find((agent) => agent.id === agentId);
  return (
    <div className="grid max-w-4xl gap-8 md:grid-cols-(--gtc-11)">
      <SetupRail step={step} />
      <main className="min-w-0 space-y-6">
        {!endpoint ? (
          <>
            <div>
              <h1 className="text-xl font-bold">
                {t("area.apps-chat-email.chat-endpoint-setup.agent.title")}
              </h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {t("area.apps-chat-email.chat-endpoint-setup.agent.description")}
              </p>
            </div>
            <AgentSelect
              agents={activeAgents}
              value={agentId}
              onChange={setAgentId}
              placeholder={t("area.apps-chat-email.chat-endpoint-setup.agent.placeholder")}
              emptyMessage={t("area.apps-chat-email.chat-endpoint-setup.agent.empty")}
            />
            <div className="flex justify-end">
              <Button
                disabled={!agentId || createEndpoint.isPending}
                onClick={() => createEndpoint.mutate()}
              >
                {createEndpoint.isPending && (
                  <Loader2 className="h-4 w-4 animate-spin" />
                )}
                {t("area.apps-chat-email.chat-endpoint-setup.continue")}
              </Button>
            </div>
          </>
        ) : step === 1 ? (
          <>
            {setupError ? (
              <div
                role="alert"
                className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
              >
                <p className="font-medium">{t("area.apps-chat-email.chat-endpoint-setup.connectionFailed")}</p>
                <p className="mt-1">{setupError}</p>
              </div>
            ) : null}
            <ProviderConnectStep
              key={`${provider}:${endpoint.id}`}
              provider={provider}
              agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
              endpoint={endpoint}
              credentials={credentials}
              setCredentials={setCredentials}
              repairing={repairing}
              pending={setupAction.isPending}
              generatedWebhookSecret={generatedWebhookSecret}
              generatingSetupSecret={generateSetupSecret.isPending}
              onGenerateSetupSecret={() => generateSetupSecret.mutate()}
              onAction={(action, values) =>
                setupAction.mutate({ action, values })
              }
            />
          </>
        ) : (
          <TryStep
            endpointId={endpoint.id}
            provider={provider}
            agentName={selectedAgent?.name ?? endpoint.assignedAgentName}
            botLabel={endpoint.botLabel}
            botUsername={endpoint.botUsername}
            photonAllocation={endpoint.photonAllocation}
            providerUrl={endpoint.setup?.providerUrl}
            guestIsolationState={
              experimentalSettingsQuery.isPending
                ? "loading"
                : experimentalSettingsQuery.isError
                  ? "unknown"
                  : experimentalSettingsQuery.data?.enableIsolatedWorkspaces ===
                      true
                    ? "enabled"
                    : "disabled"
            }
            pending={testConnection.isPending}
            onOpenAccess={() => navigate(`/apps/chat/${endpoint.id}/access`)}
            onTest={() => testConnection.mutate()}
          />
        )}
        <div className="flex justify-start">
          <Button variant="ghost" onClick={() => navigate("/apps")}>
            {t("area.apps-chat-email.chat-endpoint-setup.saveAndExit")}
          </Button>
        </div>
      </main>
    </div>
  );
}

function ProviderConnectStep({
  provider,
  agentName,
  endpoint,
  credentials,
  setCredentials,
  repairing,
  pending,
  generatedWebhookSecret,
  generatingSetupSecret,
  onGenerateSetupSecret,
  onAction,
}: {
  provider: ChatProvider;
  agentName: string;
  endpoint: ChatEndpoint;
  credentials: Record<string, string>;
  setCredentials: Dispatch<SetStateAction<Record<string, string>>>;
  repairing: boolean;
  pending: boolean;
  generatedWebhookSecret: string;
  generatingSetupSecret: boolean;
  onGenerateSetupSecret: () => void;
  onAction: (
    action: ChatEndpointSetupAction,
    values?: Record<string, string>,
  ) => void;
}) {
  const { t } = useTranslation();
  const { pushToast } = useToast();
  const reportCopyFailure = () =>
    pushToast({
      title: i18n.t("area.apps-chat-email.chat-endpoint-setup.copyFailed.title"),
      body: i18n.t("area.apps-chat-email.chat-endpoint-setup.copyFailed.body"),
      tone: "error",
    });
  const field = (key: string, label: string, type = "password") => (
    <label className="grid gap-2 text-sm font-medium">
      {label}
      <Input
        type={type}
        value={credentials[key] ?? ""}
        onChange={(event) =>
          setCredentials({ ...credentials, [key]: event.target.value })
        }
      />
    </label>
  );
  const openProviderSetup = (fallback: string) =>
    window.open(
      endpoint.setup?.authorizationUrl ??
        endpoint.setup?.providerUrl ??
        fallback,
      "_blank",
      "noopener,noreferrer",
    );
  const endpointValue = (label: string, value: string | null | undefined) => (
    <div className="grid gap-2">
      <p className="text-sm font-medium">{label}</p>
      <div className="rounded-lg border border-border bg-muted p-3 font-mono text-xs break-all">
        {value ??
          t("area.apps-chat-email.chat-endpoint-setup.endpointUnavailable")}
      </div>
    </div>
  );
  const [manifestCopied, setManifestCopied] = useState(false);
  const [privateKeyVisible, setPrivateKeyVisible] = useState(false);
  const [privateKeyFileError, setPrivateKeyFileError] = useState<string | null>(
    null,
  );
  const [privateKeyFileLoaded, setPrivateKeyFileLoaded] = useState(false);
  const [privateKeyFileLoading, setPrivateKeyFileLoading] = useState(false);
  const privateKeyFileInputRef = useRef<HTMLInputElement>(null);
  const privateKeyReadGuard = useRef(createGitHubPrivateKeyReadGuard()).current;
  useEffect(
    () => () => {
      privateKeyReadGuard.invalidate();
    },
    [privateKeyReadGuard],
  );
  const loadPrivateKeyFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    const readRevision = privateKeyReadGuard.start();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(true);
    try {
      const privateKey = await readGitHubPrivateKeyFile(file);
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setCredentials((current) => ({ ...current, privateKey }));
      setPrivateKeyVisible(false);
      setPrivateKeyFileLoaded(true);
    } catch (error) {
      if (!privateKeyReadGuard.isCurrent(readRevision)) return;
      setPrivateKeyFileError(
        error instanceof Error
          ? error.message
          : i18n.t("area.apps-chat-email.chat-endpoint-setup.github.readFailed"),
      );
    } finally {
      if (privateKeyReadGuard.isCurrent(readRevision)) {
        setPrivateKeyFileLoading(false);
      }
    }
  };
  const replacePrivateKey = (privateKey: string) => {
    privateKeyReadGuard.invalidate();
    setPrivateKeyFileError(null);
    setPrivateKeyFileLoaded(false);
    setPrivateKeyFileLoading(false);
    setCredentials((current) => ({ ...current, privateKey }));
  };
  const slackCommand =
    endpoint.setup?.command ??
    `/${
      agentName
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 24) || "paperclip"
    }`;
  const slackBotName = slackBotNameForAgent(agentName);
  const slackAppName = `${slackBotName.slice(0, 25)}-paperclip`;
  const slackWebhookUrl =
    endpoint.setup?.webhookUrl ?? "<paperclip-webhook-url>";
  const slackManifest = `display_information:
  name: ${JSON.stringify(slackAppName)}
features:
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  agent_view:
    agent_description: "Work with a Myrmidon agent in a task-backed conversation."
  bot_user:
    display_name: ${JSON.stringify(slackBotName)}
  slash_commands:
    - command: ${JSON.stringify(slackCommand)}
      description: Start or manage work with ${JSON.stringify(agentName)}
      usage_hint: ${JSON.stringify("status | new | close | <task>")}
      should_escape: false
      url: ${JSON.stringify(slackWebhookUrl)}
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - assistant:write
      - channels:history
      - channels:read
      - chat:write
      - commands
      - files:read
      - files:write
      - groups:history
      - groups:read
      - im:history
      - im:read
      - mpim:history
      - mpim:read
      - reactions:read
      - reactions:write
      - users:read
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
  event_subscriptions:
    request_url: ${JSON.stringify(slackWebhookUrl)}
    bot_events:
      - agent_session_stopped
      - app_mention
      - message.channels
      - message.groups
      - message.im
      - message.mpim
      - member_joined_channel
      - member_left_channel
      - channel_left
      - group_left
      - reaction_added
      - reaction_removed
      - channel_archive
      - group_archive
      - channel_unarchive
      - group_unarchive
      - channel_deleted
      - channel_rename
      - group_rename
      - app_uninstalled
      - tokens_revoked
  interactivity:
    is_enabled: true
    request_url: ${JSON.stringify(slackWebhookUrl)}`;
  const teamsClientId =
    credentials.clientId?.trim() || "<application-client-id>";
  const teamsManifestSettings = JSON.stringify(
    {
      bots: [
        {
          botId: teamsClientId,
          scopes: ["personal", "team", "groupChat"],
          supportsFiles: true,
          isNotificationOnly: false,
          commandLists: [
            {
              scopes: ["personal", "groupChat"],
              commands: [
                {
                  title: "/status",
                  description: "Show the active Myrmidon task status",
                },
                {
                  title: "/new",
                  description: "Start a new Myrmidon task in this chat",
                },
                {
                  title: "/close",
                  description: "Close the active chat conversation",
                },
              ],
            },
          ],
        },
      ],
      webApplicationInfo: {
        id: teamsClientId,
        resource: "https://paperclip.ing",
      },
      authorization: {
        permissions: {
          resourceSpecific: [
            { name: "ChannelMessage.Read.Group", type: "Application" },
            { name: "ChatMessage.Read.Chat", type: "Application" },
          ],
        },
      },
    },
    null,
    2,
  );
  if (provider === "imessage-photon") return <PhotonConnectStep endpoint={endpoint} agentName={agentName} repairing={repairing} pending={pending} onAction={onAction} />;
  if (provider === "discord") {
    const applicationId = credentials.applicationId?.trim() ?? "";
    const guildId = credentials.guildId?.trim() ?? "";
    const installUrl = applicationId
      ? `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&permissions=309237763136&scope=bot${guildId ? `&guild_id=${encodeURIComponent(guildId)}&disable_guild_select=true` : ""}`
      : null;
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("area.apps-chat-email.chat-endpoint-setup.discord.title", { agent: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("area.apps-chat-email.chat-endpoint-setup.discord.descriptionRepair")
              : t("area.apps-chat-email.chat-endpoint-setup.discord.descriptionNew")}
          </p>
        </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.discord.step1")}
          </li>
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.discord.step2")}
          </li>
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.discord.step3")}
          </li>
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.discord.step4")}
          </li>
        </ol>
        <Button
          variant="outline"
          onClick={() =>
            openProviderSetup("https://discord.com/developers/applications")
          }
        >
          {t("area.apps-chat-email.chat-endpoint-setup.discord.openPortal")} <ExternalLink />
        </Button>
        {field("applicationId", t("area.apps-chat-email.chat-endpoint-setup.discord.applicationId"), "text")}
        {field("guildId", t("area.apps-chat-email.chat-endpoint-setup.discord.serverId"), "text")}
        {field("botToken", t("area.apps-chat-email.chat-endpoint-setup.shared.botToken"))}
        {installUrl && (
          <Button asChild variant="outline">
            <a href={installUrl} target="_blank" rel="noreferrer">
              {t("area.apps-chat-email.chat-endpoint-setup.discord.install")} <ExternalLink />
            </a>
          </Button>
        )}
        <p className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.discord.permissions")}
        </p>
        <Button
          disabled={
            (!repairing &&
              (!credentials.applicationId ||
                !credentials.guildId ||
                !credentials.botToken)) ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("area.apps-chat-email.chat-endpoint-setup.discord.reconnect") : t("area.apps-chat-email.chat-endpoint-setup.discord.connect")}
        </Button>
      </div>
    );
  }
  if (provider === "telegram")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("area.apps-chat-email.chat-endpoint-setup.telegram.title", { agent: agentName })}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("area.apps-chat-email.chat-endpoint-setup.telegram.descriptionRepair")
              : t("area.apps-chat-email.chat-endpoint-setup.telegram.descriptionNew")}
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.telegram.step1" components={strongCode} />
          </li>
          <li>{t("area.apps-chat-email.chat-endpoint-setup.telegram.step2")}</li>
          <li>
            <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.telegram.step3" components={strongCode} />
          </li>
        </ol>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.telegram.privacyNote" values={{ usage: "/task@bot_username <request>" }} components={strongCode} />
        </p>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://t.me/BotFather")}
        >
          {t("area.apps-chat-email.chat-endpoint-setup.telegram.openBotFather")} <ExternalLink />
        </Button>
        {field("botToken", t("area.apps-chat-email.chat-endpoint-setup.shared.botToken"))}
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            {t("area.apps-chat-email.chat-endpoint-setup.shared.publicUrlRequired", { provider: providerNames[provider] })}
          </p>
        )}
        <Button
          disabled={
            (!repairing && !credentials.botToken) ||
            !endpoint.setup?.webhookUrl ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("area.apps-chat-email.chat-endpoint-setup.telegram.reconnect") : t("area.apps-chat-email.chat-endpoint-setup.telegram.connect")}
        </Button>
      </div>
    );
  if (provider === "microsoft-teams")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {t("area.apps-chat-email.chat-endpoint-setup.teams.title", { agent: agentName })}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("area.apps-chat-email.chat-endpoint-setup.teams.descriptionRepair")
              : t("area.apps-chat-email.chat-endpoint-setup.teams.descriptionNew")}
          </p>
        </div>
        <p className="rounded-md border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.teams.requirements")}
        </p>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.teams.step1")}
          </li>
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.teams.step2")}
          </li>
          <li>
            {t("area.apps-chat-email.chat-endpoint-setup.teams.step3")}
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button asChild variant="outline">
            <a
              href="https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade"
              target="_blank"
              rel="noreferrer"
            >
              {t("area.apps-chat-email.chat-endpoint-setup.teams.openEntra")} <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://portal.azure.com/#create/Microsoft.AzureBot"
              target="_blank"
              rel="noreferrer"
            >
              {t("area.apps-chat-email.chat-endpoint-setup.teams.createAzureBot")} <ExternalLink />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a
              href="https://dev.teams.microsoft.com/apps"
              target="_blank"
              rel="noreferrer"
            >
              {t("area.apps-chat-email.chat-endpoint-setup.teams.openPortal")} <ExternalLink />
            </a>
          </Button>
        </div>
        {endpointValue(
          t("area.apps-chat-email.chat-endpoint-setup.teams.messagingEndpoint"),
          endpoint.setup?.messagingEndpoint,
        )}
        {field("clientId", t("area.apps-chat-email.chat-endpoint-setup.teams.clientId"), "text")}
        {field("tenantId", t("area.apps-chat-email.chat-endpoint-setup.teams.tenantId"), "text")}
        {field("clientSecret", t("area.apps-chat-email.chat-endpoint-setup.teams.clientSecret"))}
        <section className="space-y-3 rounded-lg border border-border p-4">
          <div>
            <h2 className="text-sm font-semibold">
              {t("area.apps-chat-email.chat-endpoint-setup.teams.fieldMapTitle")}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("area.apps-chat-email.chat-endpoint-setup.teams.fieldMapIntro")}
            </p>
          </div>
          <ol className="list-decimal space-y-3 pl-5 text-sm">
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.fieldMap1" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.fieldMap2" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.fieldMap3" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.fieldMap4" components={strongCode} />
            </li>
          </ol>
        </section>
        <label className="grid gap-2 text-sm font-medium">
          {t("area.apps-chat-email.chat-endpoint-setup.teams.manifestBlock")}
          <Textarea
            className="min-h-80 font-mono text-xs"
            readOnly
            value={teamsManifestSettings}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            disabled={!credentials.clientId?.trim()}
            onClick={() => {
              void copyTextToClipboard(teamsManifestSettings).then(
                () => setManifestCopied(true),
                reportCopyFailure,
              );
            }}
          >
            {manifestCopied
              ? t("area.apps-chat-email.chat-endpoint-setup.teams.manifestCopied")
              : t("area.apps-chat-email.chat-endpoint-setup.teams.copyManifest")}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.teams.manifestNote")}
        </p>
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.ssoNote" components={strongCode} />
        </p>
        <p className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.teams.rscNote")}
        </p>
        <p className="text-sm text-muted-foreground">
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.teams.scopeNote" components={strongCode} />
        </p>
        {!endpoint.setup?.messagingEndpoint && (
          <p className="text-sm text-destructive">
            {t("area.apps-chat-email.chat-endpoint-setup.shared.publicUrlRequired", { provider: providerNames[provider] })}
          </p>
        )}
        <Button
          disabled={
            (!repairing &&
              (!credentials.clientId ||
                !credentials.tenantId ||
                !credentials.clientSecret)) ||
            !endpoint.setup?.messagingEndpoint ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing
            ? t("area.apps-chat-email.chat-endpoint-setup.teams.reconnect")
            : t("area.apps-chat-email.chat-endpoint-setup.teams.verify")}
        </Button>
      </div>
    );
  if (provider === "github")
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">
            {repairing
              ? t("area.apps-chat-email.chat-endpoint-setup.github.titleRepair")
              : t("area.apps-chat-email.chat-endpoint-setup.github.titleNew")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {repairing
              ? t("area.apps-chat-email.chat-endpoint-setup.github.descriptionRepair")
              : t("area.apps-chat-email.chat-endpoint-setup.github.descriptionNew")}
          </p>
        </div>
        {!repairing && (
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.github.step1" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.github.step2" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.github.step3" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.github.step4" components={strongCode} />
            </li>
            <li>
              <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.github.step5" components={strongCode} />
            </li>
          </ol>
        )}
        {endpointValue(
          t("area.apps-chat-email.chat-endpoint-setup.github.homepageUrl"),
          publicOrigin(endpoint.setup?.webhookUrl),
        )}
        {endpointValue(t("area.apps-chat-email.chat-endpoint-setup.shared.webhookUrl"), endpoint.setup?.webhookUrl)}
        <Button
          variant="outline"
          onClick={() =>
            window.open(
              repairing
                ? "https://github.com/settings/apps"
                : (endpoint.setup?.authorizationUrl ??
                    "https://github.com/settings/apps/new"),
              "_blank",
              "noopener,noreferrer",
            )
          }
        >
          {repairing ? t("area.apps-chat-email.chat-endpoint-setup.github.openSettings") : t("area.apps-chat-email.chat-endpoint-setup.github.openNewForm")}{" "}
          <ExternalLink />
        </Button>
        {field("appId", t("area.apps-chat-email.chat-endpoint-setup.github.appId"), "text")}
        <div className="grid gap-2 text-sm font-medium">
          <label htmlFor="github-private-key">{t("area.apps-chat-email.chat-endpoint-setup.github.privateKey")}</label>
          <div className="relative">
            {privateKeyVisible ? (
              <Textarea
                id="github-private-key"
                className="min-h-24 pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
              />
            ) : (
              <Input
                id="github-private-key"
                type="password"
                className="pr-11 font-mono text-xs"
                value={credentials.privateKey ?? ""}
                onChange={(event) => replacePrivateKey(event.target.value)}
                onPaste={(event) => {
                  event.preventDefault();
                  replacePrivateKey(event.clipboardData.getData("text"));
                }}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-1 top-1"
              aria-label={
                privateKeyVisible ? t("area.apps-chat-email.chat-endpoint-setup.github.hideKey") : t("area.apps-chat-email.chat-endpoint-setup.github.showKey")
              }
              onClick={() => setPrivateKeyVisible((visible) => !visible)}
            >
              {privateKeyVisible ? <EyeOff /> : <Eye />}
            </Button>
          </div>
          <input
            ref={privateKeyFileInputRef}
            type="file"
            accept=".pem,.key,application/x-pem-file,application/pkcs8,text/plain"
            className="hidden"
            aria-label={t("area.apps-chat-email.chat-endpoint-setup.github.keyFileAriaLabel")}
            onChange={loadPrivateKeyFile}
          />
          <div>
            <Button
              type="button"
              variant="outline"
              onClick={() => privateKeyFileInputRef.current?.click()}
            >
              {t("area.apps-chat-email.chat-endpoint-setup.github.chooseFile")}
            </Button>
          </div>
          {privateKeyFileError ? (
            <p role="alert" className="text-sm text-destructive">
              {privateKeyFileError}
            </p>
          ) : null}
          {privateKeyFileLoading ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {t("area.apps-chat-email.chat-endpoint-setup.github.readingFile")}
            </p>
          ) : privateKeyFileLoaded ? (
            <p
              role="status"
              aria-live="polite"
              className="text-sm text-muted-foreground"
            >
              {t("area.apps-chat-email.chat-endpoint-setup.github.keyLoaded")}
            </p>
          ) : null}
        </div>
        <div className="grid gap-2">
          <p className="text-sm font-medium">{t("area.apps-chat-email.chat-endpoint-setup.github.webhookSecret")}</p>
          {generatedWebhookSecret ? (
            <>
              <Input
                aria-label={t("area.apps-chat-email.chat-endpoint-setup.github.generatedSecretAriaLabel")}
                className="font-mono text-xs"
                readOnly
                value={generatedWebhookSecret}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void copyTextToClipboard(generatedWebhookSecret).catch(
                      reportCopyFailure,
                    );
                  }}
                >
                  {t("area.apps-chat-email.chat-endpoint-setup.github.copySecret")}
                </Button>
              </div>
              <p className="text-sm text-muted-foreground">
                {t("area.apps-chat-email.chat-endpoint-setup.github.copyNow")}
              </p>
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              {endpoint.setup?.webhookSecretConfigured
                ? t("area.apps-chat-email.chat-endpoint-setup.github.secretConfigured")
                : t("area.apps-chat-email.chat-endpoint-setup.github.secretGenerateHint")}
            </p>
          )}
          <div>
            <Button
              type="button"
              variant="outline"
              disabled={generatingSetupSecret}
              onClick={onGenerateSetupSecret}
            >
              {generatingSetupSecret && (
                <Loader2 className="h-4 w-4 animate-spin" />
              )}
              {endpoint.setup?.webhookSecretConfigured
                ? t("area.apps-chat-email.chat-endpoint-setup.github.regenerate")
                : t("area.apps-chat-email.chat-endpoint-setup.github.generate")}
            </Button>
          </div>
          {endpoint.setup?.webhookSecretConfigured && (
            <p className="text-sm text-muted-foreground">
              {endpoint.providerAccountId || endpoint.botExternalId
                ? t("area.apps-chat-email.chat-endpoint-setup.github.regenerateWarning")
                : t("area.apps-chat-email.chat-endpoint-setup.github.generateAgainWarning")}
            </p>
          )}
          {endpoint.setup?.webhookSecretConfigured && (
            <p
              className={`text-sm ${endpoint.setup.webhookVerifiedAt ? "text-foreground" : "text-muted-foreground"}`}
            >
              {endpoint.setup.webhookVerifiedAt
                ? t("area.apps-chat-email.chat-endpoint-setup.github.verified")
                : t("area.apps-chat-email.chat-endpoint-setup.github.waitingVerification")}
            </p>
          )}
        </div>
        {!endpoint.setup?.webhookUrl && (
          <p className="text-sm text-destructive">
            {t("area.apps-chat-email.chat-endpoint-setup.shared.publicUrlRequired", { provider: providerNames[provider] })}
          </p>
        )}
        <Button
          disabled={
            (!repairing && (!credentials.appId || !credentials.privateKey)) ||
            !endpoint.setup?.webhookSecretConfigured ||
            !endpoint.setup?.webhookVerifiedAt ||
            !endpoint.setup?.webhookUrl ||
            privateKeyFileLoading ||
            generatingSetupSecret ||
            pending
          }
          onClick={() =>
            onAction(repairing ? "reconnect" : "configure", credentials)
          }
        >
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {repairing ? t("area.apps-chat-email.chat-endpoint-setup.github.reconnect") : t("area.apps-chat-email.chat-endpoint-setup.github.connect")}
        </Button>
      </div>
    );
  if (endpoint.providerAccountId && !repairing)
    return (
      <div className="space-y-5">
        <div>
          <h1 className="text-xl font-bold">{t("area.apps-chat-email.chat-endpoint-setup.slackFinish.title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("area.apps-chat-email.chat-endpoint-setup.slackFinish.description")}
          </p>
        </div>
        {endpointValue(t("area.apps-chat-email.chat-endpoint-setup.shared.webhookUrl"), endpoint.setup?.webhookUrl)}
        {endpointValue(t("area.apps-chat-email.chat-endpoint-setup.slackFinish.command"), slackCommand)}
        <div className="rounded-lg border border-border p-3 text-sm">
          <p className="font-medium">{t("area.apps-chat-email.chat-endpoint-setup.slackFinish.useCommand")}</p>
          <p className="mt-1 text-muted-foreground">
            <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.slackFinish.commandHelp" values={{ command: slackCommand }} components={strongCode} />
          </p>
        </div>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.slackFinish.step1" components={strongCode} />
          </li>
        </ol>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => openProviderSetup("https://api.slack.com/apps")}
          >
            {t("area.apps-chat-email.chat-endpoint-setup.shared.openSlackSettings")} <ExternalLink />
          </Button>
          <Button disabled={pending} onClick={() => onAction("verify")}>
            {pending && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("area.apps-chat-email.chat-endpoint-setup.slackFinish.startTest")}
          </Button>
        </div>
      </div>
    );
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">{t("area.apps-chat-email.chat-endpoint-setup.slack.title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {repairing
            ? t("area.apps-chat-email.chat-endpoint-setup.slack.descriptionRepair")
            : t("area.apps-chat-email.chat-endpoint-setup.slack.descriptionNew")}
        </p>
      </div>
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        <li>
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.slack.step1" components={strongCode} />
        </li>
        <li>
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.slack.step2" components={strongCode} />
        </li>
        <li>
          <Trans i18nKey="area.apps-chat-email.chat-endpoint-setup.slack.step3" components={strongCode} />
        </li>
      </ol>
      <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t("area.apps-chat-email.chat-endpoint-setup.slack.appName")}</span>
          <code>{slackAppName}</code>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t("area.apps-chat-email.chat-endpoint-setup.slack.botName")}</span>
          <code>{slackBotName}</code>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">{t("area.apps-chat-email.chat-endpoint-setup.slack.slashCommand")}</span>
          <code>{slackCommand}</code>
        </div>
      </div>
      <label className="grid gap-2 text-sm font-medium">
        {t("area.apps-chat-email.chat-endpoint-setup.slack.manifest")}
        <Textarea
          className="min-h-56 font-mono text-xs"
          readOnly
          value={slackManifest}
        />
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void copyTextToClipboard(slackManifest).then(
              () => setManifestCopied(true),
              reportCopyFailure,
            );
          }}
        >
          {manifestCopied ? t("area.apps-chat-email.chat-endpoint-setup.slack.manifestCopied") : t("area.apps-chat-email.chat-endpoint-setup.slack.copyManifest")}
        </Button>
        <Button
          variant="outline"
          onClick={() => openProviderSetup("https://api.slack.com/apps")}
        >
          {t("area.apps-chat-email.chat-endpoint-setup.shared.openSlackSettings")} <ExternalLink />
        </Button>
      </div>
      {field("botToken", t("area.apps-chat-email.chat-endpoint-setup.slack.botToken"))}
      {field("signingSecret", t("area.apps-chat-email.chat-endpoint-setup.slack.signingSecret"))}
      {!endpoint.setup?.webhookUrl && (
        <p className="text-sm text-destructive">
          {t("area.apps-chat-email.chat-endpoint-setup.shared.publicUrlRequired", { provider: providerNames[provider] })}
        </p>
      )}
      <Button
        disabled={
          (!repairing &&
            (!credentials.botToken || !credentials.signingSecret)) ||
          !endpoint.setup?.webhookUrl ||
          pending
        }
        onClick={() =>
          onAction(repairing ? "reconnect" : "configure", credentials)
        }
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" />}
        {repairing ? t("area.apps-chat-email.chat-endpoint-setup.slack.reconnect") : t("area.apps-chat-email.chat-endpoint-setup.slack.connect")}
      </Button>
    </div>
  );
}

function TryStep({
  endpointId,
  provider,
  agentName,
  botLabel,
  botUsername,
  photonAllocation,
  providerUrl,
  guestIsolationState,
  pending,
  onOpenAccess,
  onTest,
}: {
  endpointId: string;
  provider: ChatProvider;
  agentName: string;
  botLabel?: string | null;
  botUsername?: string | null;
  photonAllocation?: "dedicated" | "shared";
  providerUrl?: string | null;
  guestIsolationState: "loading" | "enabled" | "disabled" | "unknown";
  pending: boolean;
  onOpenAccess: () => void;
  onTest: () => void;
}) {
  const { t } = useTranslation();
  const principalsQuery = useQuery({
    queryKey: queryKeys.chatEndpoints.principals(endpointId),
    queryFn: () => chatEndpointsApi.listPrincipals(endpointId),
    refetchInterval: 1_500,
  });
  const [numberCopied, setNumberCopied] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  const identities = principalsQuery.data ?? [];
  const unlinkedIdentities = identities.filter(
    (identity) => identity.status !== "linked",
  );
  const freshConversationInstruction =
    provider === "imessage-photon"
      ? t("area.apps-chat-email.chat-endpoint-setup.try.fresh.photon")
      : provider === "telegram"
        ? t("area.apps-chat-email.chat-endpoint-setup.try.fresh.telegram")
        : provider === "github"
          ? t("area.apps-chat-email.chat-endpoint-setup.try.fresh.github")
          : provider === "microsoft-teams"
            ? t("area.apps-chat-email.chat-endpoint-setup.try.fresh.teams")
            : t("area.apps-chat-email.chat-endpoint-setup.try.fresh.default");
  const identityGuidance =
    provider === "imessage-photon" &&
    principalsQuery.isSuccess &&
    (identities.length === 0 || unlinkedIdentities.length > 0)
      ? {
          tone: "info" as const,
          title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.photonLinkTitle"),
          body: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.photonLinkBody"),
        }
      : principalsQuery.isError
        ? {
            tone: "warning" as const,
            title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.checkFailedTitle"),
            body: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.checkFailedBody", { action: freshConversationInstruction }),
          }
        : !principalsQuery.isSuccess || guestIsolationState === "loading"
          ? null
          : identities.length === 0
            ? guestIsolationState === "disabled"
              ? {
                  tone: "warning" as const,
                  title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.linkTitle"),
                  body:
                    provider === "telegram"
                      ? t("area.apps-chat-email.chat-endpoint-setup.try.guidance.telegramGuestOff")
                      : t("area.apps-chat-email.chat-endpoint-setup.try.guidance.guestOff", {
                            provider: providerNames[provider],
                            agent: agentName,
                            action: freshConversationInstruction,
                          }),
                }
              : {
                  tone: "info" as const,
                  title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.firstMessageTitle"),
                  body:
                    provider === "telegram"
                      ? t("area.apps-chat-email.chat-endpoint-setup.try.guidance.telegramGuestOn")
                      : t("area.apps-chat-email.chat-endpoint-setup.try.guidance.guestOn", { action: freshConversationInstruction }),
                }
            : unlinkedIdentities.length > 0
              ? guestIsolationState === "disabled"
                ? {
                    tone: "warning" as const,
                    title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.linkTitle"),
                    body: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.unlinkedGuestOff", { agent: agentName, action: freshConversationInstruction }),
                  }
                : {
                    tone: "info" as const,
                    title: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.unlinkedTitle"),
                    body: t("area.apps-chat-email.chat-endpoint-setup.try.guidance.unlinkedGuestOn", { action: freshConversationInstruction }),
                  }
              : null;
  const providerBotUsername = botUsername?.replace(/^@/, "");
  const normalizedBotUsername =
    provider === "github"
      ? providerBotUsername?.replace(/\[bot\]$/i, "")
      : providerBotUsername;
  const botMention = normalizedBotUsername
    ? `@${normalizedBotUsername}`
    : (botLabel ?? agentName);
  const instructions =
    provider === "imessage-photon"
      ? [
          photonAllocation === "shared"
            ? t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonShared")
            : t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonDedicated", { target: botUsername ?? botLabel ?? t("area.apps-chat-email.chat-endpoint-setup.try.steps.dedicatedNumber") }),
          t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonLink"),
          t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonWait"),
          ...(photonAllocation === "shared"
            ? [t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonSharedNote")]
            : [t("area.apps-chat-email.chat-endpoint-setup.try.steps.photonGroupNote")]),
        ]
      : provider === "discord"
        ? [
            t("area.apps-chat-email.chat-endpoint-setup.try.steps.discord1"),
            t("area.apps-chat-email.chat-endpoint-setup.try.steps.discord2", { bot: botMention }),
            t("area.apps-chat-email.chat-endpoint-setup.try.steps.discord3", { agent: agentName }),
          ]
        : provider === "telegram"
          ? [t("area.apps-chat-email.chat-endpoint-setup.try.steps.telegram1"), t("area.apps-chat-email.chat-endpoint-setup.try.steps.telegram2"), t("area.apps-chat-email.chat-endpoint-setup.try.steps.telegram3")]
          : provider === "github"
            ? [
                t("area.apps-chat-email.chat-endpoint-setup.try.steps.github1"),
                t("area.apps-chat-email.chat-endpoint-setup.try.steps.github2", { bot: botMention }),
                t("area.apps-chat-email.chat-endpoint-setup.try.steps.github3"),
              ]
            : provider === "microsoft-teams"
              ? [
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.teams1"),
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.teams2", { bot: botMention }),
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.teams3"),
                ]
              : [
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.default1"),
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.default2", { bot: botMention }),
                  t("area.apps-chat-email.chat-endpoint-setup.try.steps.default3", { agent: agentName }),
                ];
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-bold">
          {t("area.apps-chat-email.chat-endpoint-setup.try.title", { agent: agentName, provider: providerNames[provider] })}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.try.description")}
        </p>
      </div>
      {(!principalsQuery.isSuccess || guestIsolationState === "loading") &&
      !principalsQuery.isError ? (
        <p role="status" className="text-sm text-muted-foreground">
          {t("area.apps-chat-email.chat-endpoint-setup.try.checking")}
        </p>
      ) : null}
      {identityGuidance ? (
        <div
          role={identityGuidance.tone === "warning" ? "alert" : "status"}
          className={
            identityGuidance.tone === "warning"
              ? "rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm"
              : "rounded-lg border border-border bg-muted/30 p-4 text-sm"
          }
        >
          <h2 className="font-medium">{identityGuidance.title}</h2>
          <p className="mt-1 text-muted-foreground">{identityGuidance.body}</p>
          <Button
            className="mt-3"
            size="sm"
            variant="outline"
            onClick={onOpenAccess}
          >
            {t("area.apps-chat-email.chat-endpoint-setup.try.reviewAccess")}
          </Button>
        </div>
      ) : null}
      {provider === "imessage-photon" && botUsername && (
        <div className="space-y-2">
          <Button
            variant="outline"
            onClick={() => {
              void copyTextToClipboard(botUsername).then(
                () => {
                  setNumberCopied(true);
                  setCopyError(null);
                },
                () => setCopyError(t("area.apps-chat-email.chat-endpoint-setup.try.copyNumberFailed")),
              );
            }}
          >
            {numberCopied ? t("area.apps-chat-email.chat-endpoint-setup.try.numberCopied") : t("area.apps-chat-email.chat-endpoint-setup.try.copyNumber", { number: botUsername })}
          </Button>
          {copyError && (
            <p role="alert" className="text-sm text-destructive">
              {copyError}
            </p>
          )}
        </div>
      )}
      <ol className="list-decimal space-y-2 pl-5 text-sm">
        {instructions.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ol>
      <div className="flex flex-wrap gap-2">
        {providerUrl && (
          <Button asChild variant="outline">
            <a href={providerUrl} target="_blank" rel="noopener noreferrer">
              {t("area.apps-chat-email.chat-endpoint-setup.try.openProvider", { provider: providerNames[provider] })} <ExternalLink />
            </a>
          </Button>
        )}
        <Button disabled={pending} onClick={onTest}>
          {pending && <Loader2 className="h-4 w-4 animate-spin" />}
          {t("area.apps-chat-email.chat-endpoint-setup.try.sentTest")}
        </Button>
      </div>
    </div>
  );
}
