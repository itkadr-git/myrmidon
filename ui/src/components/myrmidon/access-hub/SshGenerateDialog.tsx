import { useState } from "react";
import { Copy } from "lucide-react";
import { useTranslation } from "@/i18n";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { AccessHost, GenerateSshInput, SshKeyMaterial } from "./accessHubApi";

export interface SshGenerateDialogBodyProps {
  hosts: AccessHost[];
  material?: SshKeyMaterial | null;
  busy?: boolean;
  error?: string | null;
  onGenerate: (input: GenerateSshInput) => Promise<unknown> | unknown;
  onCopyPublicKey: (publicKey: string) => void;
  onClose: () => void;
}

/**
 * SSH key generation. The public half and its fingerprint are shown once, in
 * this dialog; only the fingerprint survives on the card afterwards.
 *
 * Generating and deploying are one step: the selected hosts receive the new
 * public key with the same call.
 */
export function SshGenerateDialogBody({
  hosts,
  material = null,
  busy = false,
  error = null,
  onGenerate,
  onCopyPublicKey,
  onClose,
}: SshGenerateDialogBodyProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [validationError, setValidationError] = useState<string | null>(null);

  function toggleHost(hostId: string) {
    setSelectedHosts((current) =>
      current.includes(hostId) ? current.filter((id) => id !== hostId) : [...current, hostId],
    );
  }

  async function submit() {
    if (!name.trim()) {
      setValidationError(t("area.access-hub.ssh-generate-dialog.nameRequired"));
      return;
    }
    setValidationError(null);
    try {
      await onGenerate({ name: name.trim(), hostRefs: selectedHosts });
    } catch {
      // Failure is reported through the `error` prop; the form stays as typed.
    }
  }

  if (material) {
    return (
      <div className="flex flex-col gap-3" data-testid="access-hub-ssh-material">
        <p className="text-sm text-muted-foreground">
          {t("area.access-hub.ssh-generate-dialog.publicKeyNotice")}
        </p>
        <span className="break-all font-mono text-xs text-foreground">{material.publicKey}</span>
        <span className="font-mono text-xs text-muted-foreground">{t("area.access-hub.ssh-generate-dialog.fingerprint", { value: material.fingerprint })}</span>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onCopyPublicKey(material.publicKey)}>
            <Copy className="mr-1 h-3.5 w-3.5" /> {t("area.access-hub.ssh-generate-dialog.copyPublicKey")}
          </Button>
          <Button type="button" onClick={onClose}>
            {t("area.access-hub.ssh-generate-dialog.done")}
          </Button>
        </DialogFooter>
      </div>
    );
  }

  return (
    <form
      data-testid="access-hub-ssh-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        {t("area.access-hub.ssh-generate-dialog.name")}
        <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("area.access-hub.ssh-generate-dialog.keyNameLabel")} />
      </label>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-muted-foreground">{t("area.access-hub.ssh-generate-dialog.deployLegend")}</legend>
        {hosts.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("area.access-hub.ssh-generate-dialog.noHosts")}</p>
        ) : (
          hosts.map((host) => (
            <label key={host.hostId} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selectedHosts.includes(host.hostId)}
                onChange={() => toggleHost(host.hostId)}
                aria-label={t("area.access-hub.ssh-generate-dialog.deployToLabel", { name: host.name })}
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
        <Button type="button" variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button type="submit" disabled={busy}>
          {t("area.access-hub.ssh-generate-dialog.generateKey")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface SshGenerateDialogProps extends SshGenerateDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function SshGenerateDialog({ open, onOpenChange, ...body }: SshGenerateDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("area.access-hub.ssh-generate-dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("area.access-hub.ssh-generate-dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <SshGenerateDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}