import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import type { AccessHost, AccessRecord } from "./accessHubApi";

export type HostDeployMode = "deploy" | "withdraw";

export interface HostDeployDialogBodyProps {
  mode: HostDeployMode;
  record: AccessRecord;
  hosts: AccessHost[];
  busy?: boolean;
  error?: string | null;
  onSubmit: (hostRefs: string[]) => Promise<unknown> | unknown;
  onCancel: () => void;
}

/**
 * Deploy an access to hosts from the registry, or withdraw it again. Both
 * actions write the record's host set in one call.
 */
export function HostDeployDialogBody({
  mode,
  record,
  hosts,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: HostDeployDialogBodyProps) {
  const { t } = useTranslation();
  const attached = record.hostRefs;
  const selectable = mode === "deploy" ? hosts.filter((host) => !attached.includes(host.hostId)) : [];
  // Both modes work from an empty selection: deploy adds the picked hosts,
  // withdraw removes them.
  const [selected, setSelected] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  function toggle(hostId: string) {
    setSelected((current) =>
      current.includes(hostId) ? current.filter((id) => id !== hostId) : [...current, hostId],
    );
  }

  async function submit() {
    if (selected.length === 0) {
      setValidationError(mode === "deploy" ? t("area.access-hub.host-deploy-dialog.pickAtLeastOne") : t("area.access-hub.host-deploy-dialog.pickToWithdraw"));
      return;
    }
    setValidationError(null);
    const nextHostRefs =
      mode === "deploy"
        ? [...attached, ...selected.filter((id) => !attached.includes(id))]
        : attached.filter((id) => !selected.includes(id));
    try {
      await onSubmit(nextHostRefs);
    } catch {
      // Reported through `error`; the selection stays as made.
    }
  }

  const listed = mode === "deploy" ? selectable : hosts.filter((host) => attached.includes(host.hostId));

  return (
    <form
      data-testid="access-hub-hosts-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        {mode === "deploy"
          ? t("area.access-hub.host-deploy-dialog.placeDescription", { name: record.name })
          : t("area.access-hub.host-deploy-dialog.removeDescription", { name: record.name })}
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-muted-foreground">{t("area.access-hub.host-deploy-dialog.hosts")}</legend>
        {listed.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {mode === "deploy" ? t("area.access-hub.host-deploy-dialog.allHaveIt") : t("area.access-hub.host-deploy-dialog.onNoHost")}
          </p>
        ) : (
          listed.map((host) => (
            <label key={host.hostId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selected.includes(host.hostId)}
                onChange={() => toggle(host.hostId)}
                aria-label={
                  mode === "deploy"
                    ? t("area.access-hub.host-deploy-dialog.deployToLabel", { name: host.name })
                    : t("area.access-hub.host-deploy-dialog.withdrawFromLabel", { name: host.name })
                }
              />
              {host.name}
            </label>
          ))
        )}
      </fieldset>

      {(validationError ?? error) ? (
        <p role="alert" className="text-sm text-destructive">
          {validationError ?? error}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {mode === "deploy" ? t("area.access-hub.host-deploy-dialog.deploy") : t("area.access-hub.host-deploy-dialog.withdraw")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface HostDeployDialogProps extends HostDeployDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function HostDeployDialog({ open, onOpenChange, ...body }: HostDeployDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{body.mode === "deploy" ? t("area.access-hub.host-deploy-dialog.titleDeploy") : t("area.access-hub.host-deploy-dialog.titleWithdraw")}</DialogTitle>
          <DialogDescription>
            {t("area.access-hub.host-deploy-dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <HostDeployDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}