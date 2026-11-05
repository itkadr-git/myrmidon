import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentPermissions } from "@myrmidon/shared";
import type { AgentPermissionUpdate } from "@/api/agents";
import { Button } from "@/components/ui/button";

type AccessPolicy = NonNullable<AgentPermissions["authorizationPolicy"]>;

export function buildAgentAccessPolicyUpdate(
  permissions: AgentPermissions | null | undefined,
  patch: Partial<AccessPolicy>,
): AgentPermissionUpdate {
  return {
    canCreateAgents: Boolean(permissions?.canCreateAgents),
    canCreateSkills: permissions?.canCreateSkills !== false,
    canAssignTasks: Boolean(permissions?.canAssignTasks),
    trustPreset: permissions?.trustPreset,
    authorizationPolicy: { ...permissions?.authorizationPolicy, ...patch },
  };
}

export function AgentAccessPolicySection({ permissions, disabled, onChange }: {
  permissions: AgentPermissions | null | undefined;
  disabled: boolean;
  onChange: (update: AgentPermissionUpdate) => void;
}) {
  const { t } = useTranslation();
  const policy = permissions?.authorizationPolicy;
  const visibility = policy?.agentVisibility as { mode?: string; hiddenFromDefaultDirectory?: boolean } | undefined;
  const protectedAgent = policy?.protectedAgent;
  const [pendingBlock, setPendingBlock] = useState<boolean | null>(null);
  const blocked = protectedAgent?.blockAssignment === true;
  const assignmentMode = policy?.assignmentPolicy?.mode ?? "company_default";

  function update(patch: Partial<AccessPolicy>) {
    onChange(buildAgentAccessPolicyUpdate(permissions, patch));
  }

  return (
    <section className="space-y-3 rounded-lg border border-border p-4" aria-label={t("area.agents-3.agent-detail.configurationTab.agentAccessPolicy", "Agent access policy")}>
      <div>
        <h3 className="text-sm font-medium">{t("area.agents-3.agent-detail.configurationTab.agentAccessPolicy", "Agent access policy")}</h3>
        <p className="text-xs text-muted-foreground">{t("area.agents-3.agent-detail.configurationTab.agentAccessPolicyHint", "These controls restrict discovery and assignment. A blocked assignment does not open an approval request.")}</p>
      </div>
      <label className="block space-y-1 text-sm">
        <span>{t("area.agents-3.agent-detail.configurationTab.visibility", "Visibility")}</span>
        <select aria-label={t("area.agents-3.agent-detail.configurationTab.visibility", "Visibility")} className="w-full rounded-md border border-border bg-background px-3 py-2" disabled={disabled}
          value={visibility?.mode ?? "discoverable"}
          onChange={(event) => update({ agentVisibility: { ...visibility, mode: event.target.value } })}>
          <option value="discoverable">{t("area.agents-3.agent-detail.configurationTab.discoverable", "Discoverable")}</option>
          <option value="private">{t("area.agents-3.agent-detail.configurationTab.private", "Private")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={visibility?.hiddenFromDefaultDirectory === true} disabled={disabled}
          onChange={(event) => update({ agentVisibility: { ...visibility, hiddenFromDefaultDirectory: event.target.checked } })} />
        {t("area.agents-3.agent-detail.configurationTab.hideFromDirectory", "Hide from default directory")}
      </label>
      <label className="block space-y-1 text-sm">
        <span>{t("area.agents-3.agent-detail.configurationTab.assignmentPolicy", "Assignment policy")}</span>
        <select aria-label={t("area.agents-3.agent-detail.configurationTab.assignmentPolicy", "Assignment policy")} className="w-full rounded-md border border-border bg-background px-3 py-2" disabled={disabled}
          value={assignmentMode}
          onChange={(event) => update({ assignmentPolicy: { ...policy?.assignmentPolicy, mode: event.target.value as "company_default" | "protected" } })}>
          <option value="company_default">{t("area.agents-3.agent-detail.configurationTab.companyDefault", "Company default")}</option>
          <option value="protected">{t("area.agents-3.agent-detail.configurationTab.protected", "Protected")}</option>
        </select>
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={blocked} disabled={disabled || pendingBlock !== null}
          onChange={(event) => setPendingBlock(event.target.checked)} />
        {t("area.agents-3.agent-detail.configurationTab.blockAssignment", "Block assignment to this agent")}
      </label>
      {pendingBlock !== null ? (
        <div role="alert" className="space-y-2 rounded-md border border-border p-3 text-sm">
          <p>
            {pendingBlock
              ? t("area.agents-3.agent-detail.configurationTab.blockAssignmentConfirm", "Block all assignments to this agent?")
              : t("area.agents-3.agent-detail.configurationTab.allowAssignmentConfirm", "Allow assignments to this agent again?")}{" "}
            {t("area.agents-3.agent-detail.configurationTab.immediateEffect", "This change takes effect immediately.")}
          </p>
          <div className="flex gap-2">
            <Button disabled={disabled} onClick={() => {
              update({ protectedAgent: { ...protectedAgent, blockAssignment: pendingBlock } });
              setPendingBlock(null);
            }}>{t("area.agents-3.agent-detail.configurationTab.confirmChange", "Confirm change")}</Button>
            <Button variant="outline" onClick={() => setPendingBlock(null)}>{t("area.agents-3.agent-detail.configurationTab.cancel", "Cancel")}</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
