import { useState } from "react";
import { UserMinus, UserPlus } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import type { AccessBinding } from "./accessHubApi";
import type { AccessAgentOption } from "./AccessList";

export interface GrantRevokeControlsProps {
  agents: AccessAgentOption[];
  granted: AccessBinding[];
  busy?: boolean;
  onGrant: (targetAgentId: string) => void;
  onRevoke: (targetAgentId: string) => void;
}

/**
 * Grant/revoke controls of the secret card. Only agent names travel through
 * here — the grant is a reference, never a copy of the value.
 */
export function GrantRevokeControls({
  agents,
  granted,
  busy = false,
  onGrant,
  onRevoke,
}: GrantRevokeControlsProps) {
  const { t } = useTranslation();
  const [pendingAgentId, setPendingAgentId] = useState("");
  const grantedIds = new Set(granted.map((binding) => binding.targetId));
  const selectable = agents.filter((agent) => !grantedIds.has(agent.id));

  return (
    <div className="flex flex-col gap-2" data-testid="access-hub-grant-controls">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={pendingAgentId}
          aria-label={t("area.access-hub.grant-revoke-controls.agentToGrant")}
          disabled={busy || selectable.length === 0}
          onChange={(event) => setPendingAgentId(event.target.value)}
          className="h-8 min-w-40 rounded-md border border-border bg-background px-2 text-sm text-foreground"
        >
          <option value="">{t("area.access-hub.grant-revoke-controls.selectAgent")}</option>
          {selectable.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agent.name}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !pendingAgentId}
          onClick={() => {
            onGrant(pendingAgentId);
            setPendingAgentId("");
          }}
        >
          <UserPlus className="mr-1 h-3.5 w-3.5" /> {t("area.access-hub.grant-revoke-controls.grantAccess")}
        </Button>
      </div>

      {granted.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("area.access-hub.grant-revoke-controls.noneHold")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {granted.map((binding) => (
            <li key={binding.targetId} className="flex items-center justify-between gap-2 text-sm">
              <span className="min-w-0 truncate" title={binding.configPath ?? undefined}>
                {binding.targetName}
              </span>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onRevoke(binding.targetId)}
                aria-label={t("area.access-hub.grant-revoke-controls.revokeLabel", { name: binding.targetName })}
              >
                <UserMinus className="mr-1 h-3.5 w-3.5" /> {t("area.access-hub.grant-revoke-controls.revoke")}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}