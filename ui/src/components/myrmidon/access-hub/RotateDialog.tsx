import { useState } from "react";
import { Trans } from "react-i18next";
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
import type { AccessRecord, RotateInput } from "./accessHubApi";

export type RotateMode = "new-value" | "external";

export interface RotateDialogBodyProps {
  record: AccessRecord;
  busy?: boolean;
  error?: string | null;
  onSubmit: (input: RotateInput) => Promise<unknown> | unknown;
  onCancel: () => void;
}

/**
 * Rotation of one access. Rotating either writes a new value or re-reads the
 * value from the external source; either way the operator decides whether the
 * containers that use the secret are restarted now.
 */
export function RotateDialogBody({ record, busy = false, error = null, onSubmit, onCancel }: RotateDialogBodyProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<RotateMode>("external");
  const [value, setValue] = useState("");
  const [restartContainers, setRestartContainers] = useState(true);
  const [validationError, setValidationError] = useState<string | null>(null);

  async function submit() {
    if (mode === "new-value" && !value) {
      setValidationError(t("area.access-hub.rotate-dialog.enterNewValue"));
      return;
    }
    setValidationError(null);
    try {
      await onSubmit(
        mode === "new-value" ? { value, restartContainers } : { external: true, restartContainers },
      );
      setValue("");
    } catch {
      // Reported through `error`; the field keeps what was typed for a retry.
    }
  }

  return (
    <form
      data-testid="access-hub-rotate-form"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-sm text-muted-foreground">
        <Trans
          i18nKey="area.access-hub.rotate-dialog.rotating"
          values={{ name: record.name, version: record.latestVersion + 1 }}
          components={[<span key="name" className="font-medium text-foreground" />]}
        />
      </p>

      <fieldset className="flex flex-col gap-1">
        <legend className="text-sm text-muted-foreground">{t("area.access-hub.rotate-dialog.sourceLegend")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="access-hub-rotate-source"
            checked={mode === "external"}
            onChange={() => setMode("external")}
            aria-label={t("area.access-hub.rotate-dialog.externalSourceLabel")}
          />
          {t("area.access-hub.rotate-dialog.externalSource")}
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="access-hub-rotate-source"
            checked={mode === "new-value"}
            onChange={() => setMode("new-value")}
            aria-label={t("area.access-hub.rotate-dialog.typedHereLabel")}
          />
          {t("area.access-hub.rotate-dialog.typedHere")}
        </label>
      </fieldset>

      {mode === "new-value" ? (
        <label className="flex flex-col gap-1 text-sm">
          {t("area.access-hub.rotate-dialog.newValue")}
          <Input
            type="password"
            autoComplete="new-password"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            aria-label={t("area.access-hub.rotate-dialog.newValue")}
            data-testid="access-hub-rotate-value-input"
          />
        </label>
      ) : null}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={restartContainers}
          onChange={(event) => setRestartContainers(event.target.checked)}
          aria-label={t("area.access-hub.rotate-dialog.restartLabel")}
          className="mt-1"
        />
        <span>
          {t("area.access-hub.rotate-dialog.restartTitle")}
          <span className="block text-xs text-muted-foreground">
            {t("area.access-hub.rotate-dialog.restartHint")}
          </span>
        </span>
      </label>

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
          {t("area.access-hub.rotate-dialog.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface RotateDialogProps extends RotateDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RotateDialog({ open, onOpenChange, ...body }: RotateDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("area.access-hub.rotate-dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("area.access-hub.rotate-dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <RotateDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}