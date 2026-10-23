import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Clock,
  Loader2,
  Plug,
  RotateCcw,
  XCircle,
} from "lucide-react";
import type { ConnectionIntentInteraction } from "@paperclipai/shared";
import { useTranslation } from "@/i18n";
import { connectionIntentsApi } from "@/api/connection-intents";
import { AiConnectionCredentialStep } from "@/components/ai-connections/AiConnectionCredentialStep";
import { AI_PROVIDERS } from "@/components/ai-connections/model";
import { AppLogo } from "@/pages/apps/AppLogo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  ConnectionSetupFlow,
  type ConnectionSetupCompletion,
  type ConnectionSetupFlowProps,
} from "./ConnectionSetupFlow";

export interface ConnectionIntentInteractionBodyProps {
  interaction: ConnectionIntentInteraction;
  currentUserId?: string | null;
  addresseeLabel: string;
  renderSetup?: (props: ConnectionSetupFlowProps) => ReactNode;
}

export function ConnectionIntentInteractionBody({
  interaction,
  currentUserId,
  addresseeLabel,
  renderSetup,
}: ConnectionIntentInteractionBodyProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const focusTargetRef = useRef<HTMLDivElement>(null);
  const setupGeneration = useRef(0);
  const generation = setupGeneration.current;
  const closeSetup = () => {
    setupGeneration.current += 1;
    setOpen(false);
  };
  const queryClient = useQueryClient();
  const isAddressee = Boolean(
    currentUserId && interaction.addresseeUserId === currentUserId,
  );
  const isPending = interaction.status === "pending";
  const isAi = interaction.payload.purpose === "ai";
  const focusTargetId = `connection-intent-focus-target-${interaction.id}`;

  const invalidateTask = async (
    updatedInteraction?: ConnectionIntentInteraction,
  ) => {
    if (updatedInteraction) {
      queryClient.setQueriesData<ConnectionIntentInteraction[]>(
        { queryKey: ["issues", "interactions"] },
        (current) =>
          current?.map((candidate) =>
            candidate.id === updatedInteraction.id
              ? updatedInteraction
              : candidate,
          ),
      );
    }
    await Promise.all([
      // Task routes may key these caches by either UUID or human identifier.
      // Prefix invalidation reaches the mounted task without requiring that
      // routing identity to leak into the reusable interaction card.
      queryClient.invalidateQueries({ queryKey: ["issues", "interactions"] }),
      queryClient.invalidateQueries({ queryKey: ["issues", "detail"] }),
    ]);
  };
  const returnFocusToCard = () => {
    // Completing an intent can move it from the composer takeover to the
    // durable timeline. That replaces this component instance, so its ref can
    // be cleared before focus restoration runs. Retry for a few paint frames
    // and resolve the stable interaction-specific target from the new host.
    const focusCurrentTarget = (remainingAttempts: number) => {
      window.requestAnimationFrame(() => {
        const target =
          document.getElementById(focusTargetId) ?? focusTargetRef.current;
        target?.focus();
        if (remainingAttempts > 1) {
          focusCurrentTarget(remainingAttempts - 1);
        }
      });
    };
    focusCurrentTarget(3);
  };

  const setupQuery = useQuery({
    queryKey: ["connection-intent", interaction.id, "setup-options"],
    queryFn: () => connectionIntentsApi.setupOptions(interaction.id),
    enabled: isAddressee && isPending,
    refetchInterval: isPending && (open || interaction.payload.phase === "authorizing") ? 2_000 : false,
  });

  useEffect(() => {
    const current = setupQuery.data?.interaction;
    if (current && current.status !== "pending" && isPending) {
      void invalidateTask(current);
      setOpen(false);
      returnFocusToCard();
    }
  }, [setupQuery.data?.interaction, isPending]);

  const completeMutation = useMutation({
    mutationFn: (connectionId: string) =>
      connectionIntentsApi.complete(interaction.id, connectionId),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const declineMutation = useMutation({
    mutationFn: () => connectionIntentsApi.decline(interaction.id),
    onSuccess: async (updatedInteraction) => {
      await invalidateTask(updatedInteraction);
      setOpen(false);
      returnFocusToCard();
    },
  });
  const phaseMutation = useMutation({
    mutationFn: (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      connectionIntentsApi.setPhase(interaction.id, phase),
    onSuccess: invalidateTask,
  });
  const mutatePhase = phaseMutation.mutate;
  const handlePhaseChange = useCallback(
    (phase: ConnectionIntentInteraction["payload"]["phase"]) =>
      mutatePhase(phase),
    [mutatePhase],
  );

  const finishNewConnection = async (completion: ConnectionSetupCompletion) => {
    // A completed credential save survives cancellation, but an abandoned form
    // must not accept the task request (even if a new form has since opened).
    if (isAi && generation !== setupGeneration.current) {
      await setupQuery.refetch();
      return;
    }
    if (completion.resolvedByCallback) {
      // A browser message cannot establish authorization. Read the durable result.
      const verified = await setupQuery.refetch();
      if (verified.data?.interaction.status !== "accepted") return;
      await invalidateTask(verified.data.interaction);
      setOpen(false);
      returnFocusToCard();
      return;
    }
    completeMutation.mutate(completion.connectionId);
  };

  const setupProps: ConnectionSetupFlowProps | null = setupQuery.data ? {
    host: "dialog",
    serviceSlug: interaction.payload.serviceSlug.startsWith("connection:") ? undefined : interaction.payload.serviceSlug,
    configuredConnection: interaction.payload.serviceSlug.startsWith("connection:") ? setupQuery.data.existingConnections[0] : undefined,
    requestedAgentId: setupQuery.data.requestedAgentId,
    aiConnection: setupQuery.data.aiConnection,
    interactionId: interaction.id,
    existingConnections: setupQuery.data.existingConnections,
    onUseExisting: async (connectionId) => { await completeMutation.mutateAsync(connectionId); },
    onComplete: (completion) => { void finishNewConnection(completion); },
    onOAuthDeclined: () => declineMutation.mutate(),
    onPhaseChange: handlePhaseChange,
    onCancel: () => { closeSetup(); returnFocusToCard(); },
  } : null;

  const resultOutcome = interaction.result?.outcome;
  const status =
    interaction.status === "accepted"
      ? {
          icon: CheckCircle2,
          title: t("area.apps-connections-2.connection-intent-interaction-body.connected", { service: interaction.payload.serviceName }),
          body: isAi ? t("area.apps-connections-2.connection-intent-interaction-body.connectedAi") : t("area.apps-connections-2.connection-intent-interaction-body.connectedService", { agent: interaction.payload.requestingAgentName }),
        }
      : interaction.status === "rejected"
        ? {
            icon: XCircle,
            title: t("area.apps-connections-2.connection-intent-interaction-body.declinedTitle"),
            body: isAi ? t("area.apps-connections-2.connection-intent-interaction-body.declinedAi") : t("area.apps-connections-2.connection-intent-interaction-body.declinedService", { agent: interaction.payload.requestingAgentName }),
          }
        : interaction.status === "expired"
          ? {
              icon: Clock,
              title:
                resultOutcome === "superseded"
                  ? t("area.apps-connections-2.connection-intent-interaction-body.supersededTitle")
                  : t("area.apps-connections-2.connection-intent-interaction-body.expiredTitle"),
              body:
                resultOutcome === "superseded"
                  ? t("area.apps-connections-2.connection-intent-interaction-body.supersededBody")
                  : t("area.apps-connections-2.connection-intent-interaction-body.expiredBody"),
            }
          : null;
  const StatusIcon = status?.icon;

  if (status && StatusIcon) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-terminal"
        >
          <StatusIcon className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">{status.title}</p>
            <p className="mt-1 text-sm text-muted-foreground">{status.body}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!isAddressee) {
    return (
      <div
        id={focusTargetId}
        ref={focusTargetRef}
        tabIndex={-1}
        data-testid="connection-intent-focus-target"
      >
        <div
          className="flex items-start gap-3"
          data-testid="connection-intent-waiting"
        >
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
          <div>
            <p className="font-medium text-foreground">
              {t("area.apps-connections-2.connection-intent-interaction-body.waitingTitle", { name: addresseeLabel })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("area.apps-connections-2.connection-intent-interaction-body.waitingBody")}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const needsRetry = interaction.payload.phase === "needs_retry";
  const authorizing = interaction.payload.phase === "authorizing";

  const repair = setupQuery.data?.aiRepair;
  const selectedReady = repair && setupQuery.data?.existingConnections.some((connection) => connection.id === repair.connection.id);
  const setupContent = setupQuery.isLoading ? (
                <div className="flex min-h-48 items-center justify-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> {t("area.apps-connections-2.connection-intent-interaction-body.loadingOptions")}
                </div>
              ) : setupQuery.isError ? (
                <div className="py-8 text-center">
                  <p className="font-medium text-foreground">
                    {t("area.apps-connections-2.connection-intent-interaction-body.loadError")}
                  </p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {setupQuery.error instanceof Error
                      ? setupQuery.error.message
                      : t("area.apps-connections-2.connection-intent-interaction-body.tryAgainHint")}
                  </p>
                  <Button
                    className="mt-4"
                    variant="outline"
                    onClick={() => setupQuery.refetch()}
                  >
                    {t("area.apps-connections-2.connection-intent-interaction-body.tryAgain")}
                  </Button>
                </div>
              ) : setupProps ? (
                renderSetup ? renderSetup(setupProps) : <ConnectionSetupFlow {...setupProps} />
              ) : null;
  const inlineContent = setupQuery.isLoading || setupQuery.isError ? setupContent
    : selectedReady ? <div className="space-y-3">
        <p className="text-sm">{t("area.apps-connections-2.connection-intent-interaction-body.ready", { name: repair.connection.name })}</p>
        <Button disabled={completeMutation.isPending} onClick={() => completeMutation.mutate(repair.connection.id)}>
          {completeMutation.isPending ? t("area.apps-connections-2.connection-intent-interaction-body.continuing") : t("area.apps-connections-2.connection-intent-interaction-body.continueTask")}
        </Button>
      </div>
    : repair ? repair.canReconnect ? <AiConnectionCredentialStep
        companyId={interaction.companyId}
        provider={repair.connection.provider}
        initialMethod={repair.connection.method}
        fixedMethod
        connectionId={repair.connection.id}
        name={repair.connection.name}
        ownership={repair.connection.ownership}
        agentIds={[interaction.payload.requestingAgentId]}
        allAgents={false}
        onComplete={(result) => { void finishNewConnection(result); }}
        onCancel={() => { closeSetup(); returnFocusToCard(); }}
      /> : <p role="status" className="text-sm text-muted-foreground">
        {repair.connection.ownership === "personal" ? t("area.apps-connections-2.connection-intent-interaction-body.mustReconnectPersonal", { owner: repair.connection.ownerName ?? t("area.apps-connections-2.connection-intent-interaction-body.accountOwner"), name: repair.connection.name }) : t("area.apps-connections-2.connection-intent-interaction-body.mustReconnectShared", { name: repair.connection.name })}
        {" "}{t("area.apps-connections-2.connection-intent-interaction-body.restoreNote")}
      </p>
    : setupQuery.data?.aiConnection && setupQuery.data.aiConnection.mode !== "responsible_user"
      ? <p role="status" className="text-sm text-muted-foreground">{t("area.apps-connections-2.connection-intent-interaction-body.accountUnavailable")}</p>
      : setupQuery.data?.aiConnection ? <AiConnectionCredentialStep
          companyId={interaction.companyId}
          provider={setupQuery.data.aiConnection.provider}
          name={t("area.apps-connections-2.connection-intent-interaction-body.defaultAccountName", { provider: AI_PROVIDERS[setupQuery.data.aiConnection.provider].name })}
          ownership="personal"
          agentIds={[interaction.payload.requestingAgentId]}
          allAgents={false}
          onComplete={(result) => { void finishNewConnection(result); }}
          onCancel={() => { closeSetup(); returnFocusToCard(); }}
        /> : setupContent;

  return (
    <div
      id={focusTargetId}
      ref={focusTargetRef}
      tabIndex={-1}
      data-testid="connection-intent-focus-target"
    >
      <div data-testid="connection-intent-actions">
        <div className="flex items-start gap-3">
          <AppLogo
            name={interaction.payload.serviceName}
            logoUrl={interaction.payload.serviceLogoUrl}
            darkLogoUrl={interaction.payload.serviceDarkLogoUrl}
            size={40}
          />
          <div>
            <p className="font-medium text-foreground">
              {isAi ? t("area.apps-connections-2.connection-intent-interaction-body.aiNeedsAttention") : t("area.apps-connections-2.connection-intent-interaction-body.serviceNeeds", { agent: interaction.payload.requestingAgentName, service: interaction.payload.serviceName })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {interaction.payload.purpose === "ai"
                ? t("area.apps-connections-2.connection-intent-interaction-body.aiBody")
                : t("area.apps-connections-2.connection-intent-interaction-body.serviceBody")}
            </p>
          </div>
        </div>

        {needsRetry ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-destructive">
            <RotateCcw className="h-4 w-4" />
            {t("area.apps-connections-2.connection-intent-interaction-body.needsRetry")}
          </p>
        ) : null}

        <div className="mt-4 flex flex-wrap justify-end gap-2">
          {!isAi && <Button
            type="button"
            variant="ghost"
            disabled={declineMutation.isPending || completeMutation.isPending || authorizing}
            onClick={() => declineMutation.mutate()}
          >
            {t("area.apps-connections-2.connection-intent-interaction-body.notNow")}
          </Button>}
          {isAi ? <Button type="button" disabled={completeMutation.isPending} onClick={() => open ? closeSetup() : setOpen(true)}>
            <Plug className="h-4 w-4" />{open ? t("area.apps-connections-2.connection-intent-interaction-body.closeSetup") : t("area.apps-connections-2.connection-intent-interaction-body.fixConnection")}
          </Button> : <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button type="button">
                {authorizing ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Plug className="h-4 w-4" />
                )}
                {authorizing
                  ? t("area.apps-connections-2.connection-intent-interaction-body.continueSetup")
                  : needsRetry
                    ? t("area.apps-connections-2.connection-intent-interaction-body.tryAgain")
                    : setupQuery.data?.existingConnections.length ? t("area.apps-connections-2.connection-intent-interaction-body.connectOrUseExisting") : t("area.apps-connections-2.connection-intent-interaction-body.connect")}
              </Button>
            </DialogTrigger>
            <DialogContent
              className="!max-w-(--pct-90) max-h-(--sz-85vh) w-full overflow-y-auto sm:max-w-5xl"
              onCloseAutoFocus={(event) => {
                event.preventDefault();
                focusTargetRef.current?.focus();
              }}
            >
              <DialogHeader className="sr-only">
                <DialogTitle>
                  {t("area.apps-connections-2.connection-intent-interaction-body.dialogTitle", { service: interaction.payload.serviceName })}
                </DialogTitle>
                <DialogDescription>
                  {t("area.apps-connections-2.connection-intent-interaction-body.dialogDescription")}
                </DialogDescription>
              </DialogHeader>
              {setupContent}
            </DialogContent>
          </Dialog>}
        </div>
        {isAi && open ? <div className="mt-4 border-t border-border pt-4" data-testid="ai-connection-inline-repair">{inlineContent}</div> : null}

        {completeMutation.isError ||
        declineMutation.isError ||
        phaseMutation.isError ? (
          <p className="mt-3 text-sm text-destructive" role="alert">
            {(completeMutation.error ??
              declineMutation.error ??
              phaseMutation.error) instanceof Error
              ? (
                  completeMutation.error ??
                  declineMutation.error ??
                  phaseMutation.error
                )?.message
              : t("area.apps-connections-2.connection-intent-interaction-body.updateFailed")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
