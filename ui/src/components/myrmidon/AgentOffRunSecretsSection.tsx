// myrmidon(1.6.5-F-23): the "Secrets outside a run" toggle of the agent card
// Permissions section. The state comes from the agent detail API
// (`access.grants` row for `secrets:read_off_run`); the change goes through the
// same PATCH /agents/:id/permissions call as the other permission flags,
// echoing the base flags unchanged alongside `offRunSecretRead`.
import type { AgentPermissionUpdate } from "@/api/agents";
import { ToggleSwitch } from "@/components/ui/toggle-switch";

export const OFF_RUN_SECRETS_TOGGLE_TESTID = "off-run-secrets-toggle";

export function AgentOffRunSecretsSection({
  granted,
  expiresAt,
  pending,
  canManage,
  base,
  onSave,
}: {
  /** Current state from `access.grants` (the secrets:read_off_run row). */
  granted: boolean;
  /** ISO timestamp of the grant expiry, when present. */
  expiresAt?: string | null;
  pending: boolean;
  /** Availability of the toggle for the current operator (same rule as board admin). */
  canManage: boolean;
  /** The three flags the permissions endpoint requires, echoed unchanged. */
  base: Pick<AgentPermissionUpdate, "canCreateAgents" | "canCreateSkills" | "canAssignTasks">;
  onSave: (update: AgentPermissionUpdate) => void;
}) {
  if (!canManage) return null;
  return (
    <div className="space-y-1 text-sm" data-testid="off-run-secrets-section">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <div>Secrets outside a run</div>
          <p className="text-xs text-muted-foreground">
            Lets this agent read its own secret metadata without an active run.
            The grant expires automatically; every read is audited.
          </p>
          {granted && expiresAt ? (
            <p className="text-xs text-muted-foreground">
              Expires {new Date(expiresAt).toLocaleDateString()}
            </p>
          ) : null}
        </div>
        <ToggleSwitch
          data-testid={OFF_RUN_SECRETS_TOGGLE_TESTID}
          checked={granted}
          onCheckedChange={() => onSave({ ...base, offRunSecretRead: !granted })}
          disabled={pending}
        />
      </div>
    </div>
  );
}
