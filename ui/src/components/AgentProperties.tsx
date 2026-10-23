import { useQuery } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { useTranslation } from "@/i18n";
import { AGENT_ROLE_LABELS, type Agent, type AgentRuntimeState } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { useCompany } from "../context/CompanyContext";
import { getAdapterLabel } from "../adapters/adapter-display-registry";
import { queryKeys } from "../lib/queryKeys";
import { AgentStatusBadge } from "./StatusBadge";
import { Identity } from "./Identity";
import { formatDate, agentUrl } from "../lib/utils";
import { Separator } from "@/components/ui/separator";
// myrmidon(1.6.1 CUSTOM-CASTES C): the role label prefers the caste directory
import { casteLabelFor, useCasteOptions } from "./myrmidon/castes/useCasteOptions";

interface AgentPropertiesProps {
  agent: Agent;
  runtimeState?: AgentRuntimeState;
}

const roleLabels = AGENT_ROLE_LABELS as Record<string, string>;

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20 mt-0.5">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0 flex-1 flex-wrap">{children}</div>
    </div>
  );
}

export function AgentProperties({ agent, runtimeState }: AgentPropertiesProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const lastErrorIsActive = agent.status === "error";
  // myrmidon(1.6.1 CUSTOM-CASTES C): the role label comes from the caste
  // directory; the built-in labels are the fallback when it is unavailable.
  const { options: casteOptions } = useCasteOptions();
  const roleLabel = casteLabelFor(agent.role, casteOptions) || roleLabels[agent.role] || agent.role;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && !!agent.reportsTo,
  });

  const reportsToAgent = agent.reportsTo ? agents?.find((a) => a.id === agent.reportsTo) : null;

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label={t("area.agents-1.agent-properties.status")}>
          <AgentStatusBadge status={agent.status} />
        </PropertyRow>
        {lastErrorIsActive && agent.errorReason && (
          <PropertyRow label={t("area.agents-1.agent-properties.errorReason")}>
            <span className="text-xs text-red-600 dark:text-red-400 break-words min-w-0">
              {agent.errorReason}
            </span>
          </PropertyRow>
        )}
        <PropertyRow label={t("area.agents-1.agent-properties.role")}>
          <span className="text-sm" data-testid="agent-role-label">{roleLabel}</span>
        </PropertyRow>
        {agent.title && (
          <PropertyRow label={t("area.agents-1.agent-properties.title")}>
            <span className="text-sm">{agent.title}</span>
          </PropertyRow>
        )}
        <PropertyRow label={t("area.agents-1.agent-properties.adapter")}>
          <span className="text-sm font-mono">{getAdapterLabel(agent.adapterType)}</span>
        </PropertyRow>
      </div>

      <Separator />

      <div className="space-y-1">
        {(runtimeState?.sessionDisplayId ?? runtimeState?.sessionId) && (
          <PropertyRow label={t("area.agents-1.agent-properties.session")}>
            <span className="text-xs font-mono">
              {String(runtimeState.sessionDisplayId ?? runtimeState.sessionId).slice(0, 12)}...
            </span>
          </PropertyRow>
        )}
        {runtimeState?.lastError && (
          <PropertyRow label={lastErrorIsActive ? t("area.agents-1.agent-properties.lastError") : t("area.agents-1.agent-properties.lastRunError")}>
            <span
              className={
                lastErrorIsActive
                  ? "text-xs text-red-600 dark:text-red-400 break-words min-w-0"
                  : "text-xs text-muted-foreground break-words min-w-0"
              }
            >
              {runtimeState.lastError}
            </span>
          </PropertyRow>
        )}
        {agent.lastHeartbeatAt && (
          <PropertyRow label={t("area.agents-1.agent-properties.lastHeartbeat")}>
            <span className="text-sm">{formatDate(agent.lastHeartbeatAt)}</span>
          </PropertyRow>
        )}
        {agent.reportsTo && (
          <PropertyRow label={t("area.agents-1.agent-properties.reportsTo")}>
            {reportsToAgent ? (
              <Link to={agentUrl(reportsToAgent)} className="hover:underline">
                <Identity name={reportsToAgent.name} size="sm" />
              </Link>
            ) : (
              <span className="text-sm font-mono">{agent.reportsTo.slice(0, 8)}</span>
            )}
          </PropertyRow>
        )}
        <PropertyRow label={t("area.agents-1.agent-properties.created")}>
          <span className="text-sm">{formatDate(agent.createdAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
