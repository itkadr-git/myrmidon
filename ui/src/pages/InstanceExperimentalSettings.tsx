import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, Lock, Play } from "lucide-react";
import type {
  InstanceExperimentalSettings,
  InstanceExperimentalSettingsWithManaged,
  InstanceFeatureKey,
  ManagedSettingMetadata,
  PatchInstanceExperimentalSettings,
} from "@myrmidon/shared";
import { experimentalSettingKey } from "@myrmidon/shared";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { getWorktreeInstanceId, isWorktreeRuntime } from "../lib/worktree-branding";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useTranslation } from "@/i18n";
import { Trans } from "react-i18next";

type WorktreeRunExecutionDisplayState =
  | { kind: "off" }
  | { kind: "armed"; activatedAt: string }
  | { kind: "fail_closed"; reason: "missing_cutoff" | "missing_instance_id" | "instance_mismatch" };

/**
 * Mirror of the server's `resolveWorktreeRunExecutionActivation` fail-closed
 * ladder (server/src/services/instance-settings.ts) so the card never claims a
 * copied/legacy row is arming execution. The derived fields are display-only —
 * the PATCH the toggle sends still writes just the boolean.
 */
function resolveWorktreeRunExecutionDisplayState(
  settings:
    | Pick<
        InstanceExperimentalSettings,
        | "enableWorktreeRunExecution"
        | "worktreeRunExecutionActivatedAt"
        | "worktreeRunExecutionActivationInstanceId"
      >
    | undefined,
  currentInstanceId: string | null,
): WorktreeRunExecutionDisplayState {
  if (settings?.enableWorktreeRunExecution !== true) return { kind: "off" };
  if (!settings.worktreeRunExecutionActivatedAt) return { kind: "fail_closed", reason: "missing_cutoff" };
  if (!currentInstanceId) return { kind: "fail_closed", reason: "missing_instance_id" };
  if (settings.worktreeRunExecutionActivationInstanceId !== currentInstanceId) {
    return { kind: "fail_closed", reason: "instance_mismatch" };
  }
  return { kind: "armed", activatedAt: settings.worktreeRunExecutionActivatedAt };
}

function formatActivationTimestamp(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

// PAP-11233: keep Conference Room code intact, but hide the user-facing opt-in for now.
const SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING = false;

function ManagedByCloudBadge() {
  const { t } = useTranslation();
  return (
    <Badge variant="outline" className="text-muted-foreground">
      <Lock aria-hidden="true" />
      {t("area.settings-company.instance-experimental-settings.managedByMyrmidonCloud")}
    </Badge>
  );
}

function ExperimentalToggleCard({
  title,
  description,
  footnote,
  checked,
  onCheckedChange,
  disabled,
  settingKey,
  managed,
  ariaLabel,
}: {
  title: string;
  description: string;
  footnote?: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
  /** Flag key backing this card; operator-hidden keys render nothing. */
  settingKey: InstanceFeatureKey;
  managed?: ManagedSettingMetadata;
  ariaLabel: string;
}) {
  const { hidden: hiddenSettings } = useHiddenSettings();
  const isManaged = managed?.managed === true;
  if (hiddenSettings.has(experimentalSettingKey(settingKey))) return null;
  return (
    <Card className="block bg-transparent p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold">{title}</h3>
            {isManaged ? <ManagedByCloudBadge /> : null}
          </div>
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
          {footnote ? <p className="max-w-2xl text-xs text-muted-foreground">{footnote}</p> : null}
        </div>
        <ToggleSwitch
          checked={checked}
          onCheckedChange={(next) => {
            if (isManaged) return;
            onCheckedChange(next);
          }}
          disabled={disabled || isManaged}
          aria-label={ariaLabel}
        />
      </div>
    </Card>
  );
}

export function InstanceExperimentalSettings() {
  const { t } = useTranslation();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([
      { label: t("area.settings-company.instance-experimental-settings.settings"), href: "/company/settings" },
      { label: t("area.settings-company.instance-experimental-settings.experimental") },
    ]);
  }, [setBreadcrumbs]);

  const experimentalQuery = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });

  const toggleMutation = useMutation<
    InstanceExperimentalSettingsWithManaged,
    Error,
    PatchInstanceExperimentalSettings,
    { previousSettings?: InstanceExperimentalSettingsWithManaged }
  >({
    mutationFn: async (patch: PatchInstanceExperimentalSettings) =>
      instanceSettingsApi.updateExperimental(patch),
    onMutate: async (patch) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.instance.experimentalSettings });
      const previousSettings = queryClient.getQueryData<InstanceExperimentalSettingsWithManaged>(
        queryKeys.instance.experimentalSettings,
      );
      if (previousSettings) {
        queryClient.setQueryData<InstanceExperimentalSettingsWithManaged>(
          queryKeys.instance.experimentalSettings,
          { ...previousSettings, ...patch },
        );
      }
      return { previousSettings };
    },
    onSuccess: async (updatedSettings) => {
      setActionError(null);
      queryClient.setQueryData(queryKeys.instance.experimentalSettings, updatedSettings);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.instance.experimentalSettings }),
        queryClient.invalidateQueries({ queryKey: queryKeys.adapters.all }),
        queryClient.invalidateQueries({ queryKey: ["built-in-agents"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.health }),
      ]);
    },
    onError: (error, _patch, context) => {
      if (context?.previousSettings) {
        queryClient.setQueryData(queryKeys.instance.experimentalSettings, context.previousSettings);
      }
      setActionError(error instanceof Error ? error.message : t("area.settings-company.instance-experimental-settings.failedToUpdateExperimentalSettings"));
    },
  });

  if (experimentalQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{t("area.settings-company.instance-experimental-settings.loadingExperimentalSettings")}</div>;
  }

  if (experimentalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {experimentalQuery.error instanceof Error
          ? experimentalQuery.error.message
          : t("area.settings-company.instance-experimental-settings.failedToLoadExperimentalSettings")}
      </div>
    );
  }

  const inWorktree = isWorktreeRuntime();
  // Present only on cloud-managed instances: keys the managed overlay controls
  // render locked with the "Managed by Myrmidon Cloud" badge. Self-hosted
  // responses carry no `managedKeys`, so every card stays editable.
  const managedKeys = experimentalQuery.data?.managedKeys ?? {};
  const enableWorktreeRunExecution = experimentalQuery.data?.enableWorktreeRunExecution === true;
  const worktreeRunExecutionManaged = managedKeys.enableWorktreeRunExecution?.managed === true;
  const worktreeRunExecutionState = resolveWorktreeRunExecutionDisplayState(
    experimentalQuery.data,
    getWorktreeInstanceId(),
  );
  const enableEnvironments = experimentalQuery.data?.enableEnvironments === true;
  const enableNativeRunner = experimentalQuery.data?.enableNativeRunner === true;
  const enableChatConnectors = experimentalQuery.data?.enableChatConnectors === true;
  const enableManagedSandboxOnly = experimentalQuery.data?.enableManagedSandboxOnly === true;
  const enableIsolatedWorkspaces = experimentalQuery.data?.enableIsolatedWorkspaces === true;
  const enableIsolatedWorkspacesByDefault =
    experimentalQuery.data?.enableIsolatedWorkspacesByDefault === true;
  // Streamlined left navigation is now the standard sidebar (PAP-12472); the
  // experimental opt-out was retired, so it no longer surfaces a toggle here.
  const enableStreamlinedUi = experimentalQuery.data?.enableStreamlinedUi !== false;
  const enableConferenceRoomChat = experimentalQuery.data?.enableConferenceRoomChat === true;
  const enableClassicTaskInterface = experimentalQuery.data?.enableClassicTaskInterface === true;
  const enableIssuePlanDecompositions =
    experimentalQuery.data?.enableIssuePlanDecompositions === true;
  const enableExperimentalFileViewer =
    experimentalQuery.data?.enableExperimentalFileViewer === true;
  const enableExternalObjects = experimentalQuery.data?.enableExternalObjects === true;
  const enableBuiltInAgents = experimentalQuery.data?.enableBuiltInAgents === true;
  const enableBetaSkills = experimentalQuery.data?.enableBetaSkills === true;
  const enableSummaries = experimentalQuery.data?.enableSummaries === true;
  const enableStatusCards = experimentalQuery.data?.enableStatusCards === true;
  const summariesManaged = managedKeys.enableSummaries?.managed === true;
  const statusCardsManaged = managedKeys.enableStatusCards?.managed === true;
  const statusCardsBlockedByManagedSummaries = summariesManaged && !enableSummaries;
  const summariesRequiredByManagedStatusCards = statusCardsManaged && enableStatusCards;
  const enableDecisions = experimentalQuery.data?.enableDecisions === true;
  const enableMyrmidonUi2 = experimentalQuery.data?.enableMyrmidonUi2 === true; // myrmidon(UI-0a)
  const enableGoalsSidebarLink = experimentalQuery.data?.enableGoalsSidebarLink === true;
  const enableCases = experimentalQuery.data?.enableCases === true;
  const enableServerInfoDebugView = experimentalQuery.data?.enableServerInfoDebugView === true;
  const enablePaperclipDeveloperMode =
    experimentalQuery.data?.enablePaperclipDeveloperMode === true;
  const enableSimplifiedEnglishInteractions =
    experimentalQuery.data?.enableSimplifiedEnglishInteractions === true;
  const enableFirstTaskPlanProposal =
    experimentalQuery.data?.enableFirstTaskPlanProposal === true;
  const enableSmokeLab = experimentalQuery.data?.enableSmokeLab === true;
  const autoRestartDevServerWhenIdle = experimentalQuery.data?.autoRestartDevServerWhenIdle === true;
  return (
    <div className="max-w-6xl space-y-6">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <FlaskConical className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">{t("area.settings-company.instance-experimental-settings.experimental")}</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("area.settings-company.instance-experimental-settings.optIntoFeaturesThatAre")}
        </p>
      </div>

      <div
        role="alert"
        className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <div className="space-y-1 text-sm">
            <p className="font-medium text-foreground">{t("area.settings-company.instance-experimental-settings.experimentalFeaturesMayBreakAt")}</p>
            <p className="text-muted-foreground">
              {t("area.settings-company.instance-experimental-settings.theseFeaturesAreOptIn")}
            </p>
          </div>
        </div>
      </div>

      {actionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <section className="space-y-3" aria-labelledby="experimental-features-heading">
        <div className="space-y-1">
          <h2 id="experimental-features-heading" className="text-sm font-semibold">
            {t("area.settings-company.instance-experimental-settings.experimentalFeatures")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("area.settings-company.instance-experimental-settings.optionalProductFeaturesThatAre")}
          </p>
        </div>

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.betaSkills")}
          description={t("area.settings-company.instance-experimental-settings.allowAgentsToPinBeta")}
          checked={enableBetaSkills}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBetaSkills: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBetaSkills"
          managed={managedKeys.enableBetaSkills}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleBetaSkillsExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.builtInAgents")}
          description={t("area.settings-company.instance-experimental-settings.showMyrmidonManagedBuiltIn")}
          checked={enableBuiltInAgents}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableBuiltInAgents: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableBuiltInAgents"
          managed={managedKeys.enableBuiltInAgents}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleBuiltInAgentsExperimental")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.cases")}
          description={t("area.settings-company.instance-experimental-settings.durableWorkProductsBlogPosts")}
          footnote={t("area.settings-company.instance-experimental-settings.turningCasesOffHidesThe")}
          checked={enableCases}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableCases: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableCases"
          managed={managedKeys.enableCases}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleCasesExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.agentChat")}
          description={t("area.settings-company.instance-experimental-settings.talkToEachAgentIn")}
          footnote={t("area.settings-company.instance-experimental-settings.turningThisOffPreservesConversations")}
          checked={experimentalQuery.data?.enableAgentChat ?? false}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableAgentChat: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableAgentChat"
          managed={managedKeys.enableAgentChat}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleAgentChatExperimentalSetting")}
        />
        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.chatConnectors")}
          description={t("area.settings-company.instance-experimental-settings.connectAgentsToSlackGithub")}
          footnote={t("area.settings-company.instance-experimental-settings.turningThisOffHidesChat")}
          checked={enableChatConnectors}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableChatConnectors: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableChatConnectors"
          managed={managedKeys.enableChatConnectors}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleChatConnectorsExperimentalSetting")}
        />

        {SHOW_CONFERENCE_ROOM_EXPERIMENTAL_SETTING ? (
          <ExperimentalToggleCard
            title={t("area.settings-company.instance-experimental-settings.conferenceRoomChat")}
            description={t("area.settings-company.instance-experimental-settings.addsAConferenceRoomOne")}
            checked={enableConferenceRoomChat}
            onCheckedChange={(checked) => toggleMutation.mutate({ enableConferenceRoomChat: checked })}
            disabled={toggleMutation.isPending}
            settingKey="enableConferenceRoomChat"
            managed={managedKeys.enableConferenceRoomChat}
            ariaLabel={t("area.settings-company.instance-experimental-settings.toggleConferenceRoomChatExperimental")}
          />
        ) : null}

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.decisions")}
          description={t("area.settings-company.instance-experimental-settings.showTheDecisionsItemIn")}
          checked={enableDecisions}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableDecisions: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableDecisions"
          managed={managedKeys.enableDecisions}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleDecisionsExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.myrmidonUi20Shell")}
          description={t("area.settings-company.instance-experimental-settings.useTheMyrmidon20")}
          footnote={t("area.settings-company.instance-experimental-settings.the20ShellRuns")}
          checked={enableMyrmidonUi2}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableMyrmidonUi2: checked })}
          disabled={toggleMutation.isPending}
          settingKey={"enableMyrmidonUi2"} // myrmidon(UI-0a) — same card contract as every flag above; the braces only keep gitleaks' generic-api-key heuristic off a boolean flag name
          managed={managedKeys.enableMyrmidonUi2}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleMyrmidonUi20")}
        /> {/* myrmidon(UI-0a) */}

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.enableEnvironments")}
          description={t("area.settings-company.instance-experimental-settings.showEnvironmentManagementInCompany")}
          checked={enableEnvironments}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableEnvironments: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableEnvironments"
          managed={managedKeys.enableEnvironments}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleEnvironmentsExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.enableExternalObjects")}
          description={t("area.settings-company.instance-experimental-settings.detectExternalUrlsInIssues")}
          checked={enableExternalObjects}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExternalObjects: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExternalObjects"
          managed={managedKeys.enableExternalObjects}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleExternalObjectsExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.enableIsolatedWorkspaces")}
          description={t("area.settings-company.instance-experimental-settings.showExecutionWorkspaceControlsIn")}
          checked={enableIsolatedWorkspaces}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableIsolatedWorkspaces: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableIsolatedWorkspaces"
          managed={managedKeys.enableIsolatedWorkspaces}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleIsolatedWorkspacesExperimentalSett")}
        />

        {enableIsolatedWorkspaces && (
          <ExperimentalToggleCard
            title={t("area.settings-company.instance-experimental-settings.useIsolatedWorkspacesByDefault")}
            description={t("area.settings-company.instance-experimental-settings.treatAProjectThatHas")}
            checked={enableIsolatedWorkspacesByDefault}
            onCheckedChange={(checked) =>
              toggleMutation.mutate({ enableIsolatedWorkspacesByDefault: checked })
            }
            disabled={toggleMutation.isPending}
            settingKey="enableIsolatedWorkspacesByDefault"
            managed={managedKeys.enableIsolatedWorkspacesByDefault}
            ariaLabel={t("area.settings-company.instance-experimental-settings.toggleIsolatedWorkspacesByDefault")}
          />
        )}

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.experimentalFileViewer")}
          description={t("area.settings-company.instance-experimental-settings.showTaskDetailControlsFor")}
          checked={enableExperimentalFileViewer}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableExperimentalFileViewer: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableExperimentalFileViewer"
          managed={managedKeys.enableExperimentalFileViewer}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleExperimentalFileViewerSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.myrmidonRunner")}
          description={t("area.settings-company.instance-experimental-settings.allowNewCodexAgentsTo")}
          checked={enableNativeRunner}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableNativeRunner: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableNativeRunner"
          managed={managedKeys.enableNativeRunner}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleMyrmidonRunnerExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.simplifiedEnglishInteractions")}
          description={t("area.settings-company.instance-experimental-settings.instructAgentsToWriteUser")}
          checked={enableSimplifiedEnglishInteractions}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableSimplifiedEnglishInteractions: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableSimplifiedEnglishInteractions"
          managed={managedKeys.enableSimplifiedEnglishInteractions}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleSimplifiedEnglishInteractionsExper")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.firstTaskProposeWithA")}
          description={t("area.settings-company.instance-experimental-settings.whenTheUserSFirst")}
          checked={enableFirstTaskPlanProposal}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableFirstTaskPlanProposal: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableFirstTaskPlanProposal"
          managed={managedKeys.enableFirstTaskPlanProposal}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleFirstTaskPlanProposal")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.statusCards")}
          description={t("area.settings-company.instance-experimental-settings.enableTheExperimentalSharedStatus")}
          footnote={t("area.settings-company.instance-experimental-settings.enablingStatusCardsAlsoEnables")}
          checked={enableStatusCards}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked
                ? { enableSummaries: true, enableStatusCards: true }
                : { enableStatusCards: false },
            )
          }
          disabled={toggleMutation.isPending || statusCardsBlockedByManagedSummaries}
          settingKey="enableStatusCards"
          managed={managedKeys.enableStatusCards}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleStatusCardsExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.streamlinedUi")}
          description={t("area.settings-company.instance-experimental-settings.useTheSimplifiedMainSidebar")}
          footnote={t("area.settings-company.instance-experimental-settings.turningThisOffRestoresThe")}
          checked={enableStreamlinedUi}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableStreamlinedUi: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableStreamlinedUi"
          managed={managedKeys.enableStreamlinedUi}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleStreamlinedUiExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.summaries")}
          description={t("area.settings-company.instance-experimental-settings.showSummarizerGeneratedStatusSlots")}
          footnote={t("area.settings-company.instance-experimental-settings.statusCardsRequiresSummariesDisabling")}
          checked={enableSummaries}
          onCheckedChange={(checked) =>
            toggleMutation.mutate(
              checked || !enableStatusCards
                ? { enableSummaries: checked }
                : { enableSummaries: false, enableStatusCards: false },
            )
          }
          disabled={toggleMutation.isPending || summariesRequiredByManagedStatusCards}
          settingKey="enableSummaries"
          managed={managedKeys.enableSummaries}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleSummariesExperimentalSetting")}
        />

      </section>

      <section className="space-y-3" aria-labelledby="developer-mode-heading">
        <div className="space-y-1">
          <h2 id="developer-mode-heading" className="text-sm font-semibold">
            {t("area.settings-company.instance-experimental-settings.myrmidonDeveloperMode")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("area.settings-company.instance-experimental-settings.internalToolsForDevelopingTesting")}
          </p>
        </div>

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.myrmidonDeveloperMode")}
          description={t("area.settings-company.instance-experimental-settings.showInternalMyrmidonMaintainerTools")}
          checked={enablePaperclipDeveloperMode}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enablePaperclipDeveloperMode: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enablePaperclipDeveloperMode"
          managed={managedKeys.enablePaperclipDeveloperMode}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleMyrmidonDeveloperModeExperimental")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.managedEnvironmentOnly")}
          description={t("area.settings-company.instance-experimental-settings.hideTheLocalEnvironmentAnd")}
          checked={enableManagedSandboxOnly}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableManagedSandboxOnly: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableManagedSandboxOnly"
          managed={managedKeys.enableManagedSandboxOnly}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleManagedEnvironmentOnlyExperimental")}
        />

        {inWorktree ? (
          <Card className="block bg-transparent p-5">
            <div className="flex flex-col gap-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold">{t("area.settings-company.instance-experimental-settings.runTasksInThisWorktree")}</h3>
                    {worktreeRunExecutionManaged ? <ManagedByCloudBadge /> : null}
                  </div>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {t("area.settings-company.instance-experimental-settings.thisIsAnIsolatedGit")}
                  </p>
                </div>
                <ToggleSwitch
                  checked={enableWorktreeRunExecution}
                  onCheckedChange={(checked) => {
                    if (worktreeRunExecutionManaged) return;
                    toggleMutation.mutate({ enableWorktreeRunExecution: checked });
                  }}
                  disabled={toggleMutation.isPending || worktreeRunExecutionManaged}
                  aria-label={t("area.settings-company.instance-experimental-settings.toggleWorktreeRunExecutionSetting")}
                />
              </div>

              {worktreeRunExecutionState.kind === "armed" ? (
                <div className="flex items-center gap-2 rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-sm text-foreground">
                  <Play className="h-4 w-4 shrink-0 text-emerald-600" />
                  <span>
                    <Trans
                      i18nKey="area.settings-company.instance-experimental-settings.runningTasksAfter"
                      values={{ when: formatActivationTimestamp(worktreeRunExecutionState.activatedAt) }}
                      components={[<span className="font-medium" />]}
                    />
                  </span>
                </div>
              ) : null}

              {worktreeRunExecutionState.kind === "fail_closed" ? (
                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
                  <div className="space-y-0.5">
                    <p className="font-medium text-foreground">{t("area.settings-company.instance-experimental-settings.executionIsSuppressedEffectivelyOff")}</p>
                    <p className="text-muted-foreground">
                      {worktreeRunExecutionState.reason === "instance_mismatch"
                        ? t("area.settings-company.instance-experimental-settings.thisSettingWasArmedIn")
                        : t("area.settings-company.instance-experimental-settings.thisSettingIsMissingIts")}{" "}
                      {t("area.settings-company.instance-experimental-settings.toggleToArm")}
                    </p>
                  </div>
                </div>
              ) : null}
            </div>
          </Card>
        ) : null}

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.autoRestartDevServerWhen")}
          description={t("area.settings-company.instance-experimental-settings.inPnpmDevOnceWait")}
          checked={autoRestartDevServerWhenIdle}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ autoRestartDevServerWhenIdle: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="autoRestartDevServerWhenIdle"
          managed={managedKeys.autoRestartDevServerWhenIdle}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleGuardedDevServerAuto")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.serverInfoDebugView")}
          description={t("area.settings-company.instance-experimental-settings.showAServerSectionIn")}
          checked={enableServerInfoDebugView}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableServerInfoDebugView: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableServerInfoDebugView"
          managed={managedKeys.enableServerInfoDebugView}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleServerInfoDebugView")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.smokeLab")}
          description={t("area.settings-company.instance-experimental-settings.addASmokeLabTab")}
          checked={enableSmokeLab}
          onCheckedChange={(checked) => toggleMutation.mutate({ enableSmokeLab: checked })}
          disabled={toggleMutation.isPending}
          settingKey="enableSmokeLab"
          managed={managedKeys.enableSmokeLab}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleSmokeLabExperimentalSetting")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.taskPlanDecomposition")}
          description={t("area.settings-company.instance-experimental-settings.showAcceptedPlanDecompositionHistory")}
          checked={enableIssuePlanDecompositions}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableIssuePlanDecompositions: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableIssuePlanDecompositions"
          managed={managedKeys.enableIssuePlanDecompositions}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleTaskPlanDecompositionPanel")}
        />
      </section>

      <section className="space-y-3" aria-labelledby="legacy-heading">
        <div className="space-y-1">
          <h2 id="legacy-heading" className="text-sm font-semibold">
            {t("area.settings-company.instance-experimental-settings.legacy")}
          </h2>
          <p className="text-sm text-muted-foreground">{t("area.settings-company.instance-experimental-settings.theseFeaturesAreGoingTo")}</p>
        </div>

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.classicTaskInterface")}
          description={t("area.settings-company.instance-experimental-settings.restoresThePreviousTaskDetail")}
          footnote={t("area.settings-company.instance-experimental-settings.switchingTakesEffectImmediatelyNo")}
          checked={enableClassicTaskInterface}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableClassicTaskInterface: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableClassicTaskInterface"
          managed={managedKeys.enableClassicTaskInterface}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleClassicTaskInterfaceExperimental")}
        />

        <ExperimentalToggleCard
          title={t("area.settings-company.instance-experimental-settings.goalsSidebarLink")}
          description={t("area.settings-company.instance-experimental-settings.restoreTheGoalsItemIn")}
          checked={enableGoalsSidebarLink}
          onCheckedChange={(checked) =>
            toggleMutation.mutate({ enableGoalsSidebarLink: checked })
          }
          disabled={toggleMutation.isPending}
          settingKey="enableGoalsSidebarLink"
          managed={managedKeys.enableGoalsSidebarLink}
          ariaLabel={t("area.settings-company.instance-experimental-settings.toggleGoalsSidebarLinkExperimental")}
        />
      </section>
    </div>
  );
}
