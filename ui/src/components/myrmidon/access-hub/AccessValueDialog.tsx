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
import { accessKindLabel } from "./accessKindLabel";
import {
  ACCESS_KIND_ORDER,
  type AccessKind,
  type AccessRecord,
} from "./accessHubApi";

export type AccessValueMode = "create" | "set-value";

export interface AccessValueSubmit {
  /** Absent when creating. */
  secretId?: string;
  name?: string;
  key?: string;
  kind?: AccessKind;
  /** Sent once; never echoed back and never kept in component state. */
  value: string;
}

export interface AccessValueDialogBodyProps {
  mode: AccessValueMode;
  record?: AccessRecord | null;
  busy?: boolean;
  error?: string | null;
  onSubmit: (payload: AccessValueSubmit) => Promise<unknown> | unknown;
  onCancel: () => void;
}

/**
 * Value entry for the access hub: one form for both jobs — creating an access
 * and replacing the value of an existing one.
 *
 * The value lives in this form's state only until the submit resolves, then
 * the field is cleared. It is never rendered as text, never stored in a
 * surrounding state, and never comes back from the API.
 */
export function AccessValueDialogBody({
  mode,
  record = null,
  busy = false,
  error = null,
  onSubmit,
  onCancel,
}: AccessValueDialogBodyProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [key, setKey] = useState("");
  const [kind, setKind] = useState<AccessKind>("token");
  const [value, setValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const creating = mode === "create";

  async function submit() {
    if (creating && !name.trim()) {
      setValidationError(t("area.access-hub.access-value-dialog.nameRequired"));
      return;
    }
    if (!value) {
      setValidationError(t("area.access-hub.access-value-dialog.valueRequired"));
      return;
    }
    setValidationError(null);
    try {
      await onSubmit(
        creating
          ? { name: name.trim(), key: key.trim() || undefined, kind, value }
          : { secretId: record?.secretId, value },
      );
      // The submitted value must not stay on screen (or in the DOM) after the
      // write — the operator gets a version bump and nothing else.
      setValue("");
      if (creating) {
        setName("");
        setKey("");
      }
    } catch {
      // The parent surfaces the failure; keep the field as typed so the
      // operator can retry without re-entering the value from scratch.
    }
  }

  return (
    <form
      data-testid="access-hub-value-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-3"
    >
      {creating ? (
        <>
          <label className="flex flex-col gap-1 text-sm">
            {t("area.access-hub.access-value-dialog.name")}
            <Input value={name} onChange={(event) => setName(event.target.value)} aria-label={t("area.access-hub.access-value-dialog.accessNameLabel")} />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("area.access-hub.access-value-dialog.key")}
            <Input
              value={key}
              onChange={(event) => setKey(event.target.value)}
              aria-label={t("area.access-hub.access-value-dialog.accessKeyLabel")}
              placeholder={t("area.access-hub.access-value-dialog.keyPlaceholder")}
            />
          </label>
          <label className="flex flex-col gap-1 text-sm">
            {t("area.access-hub.access-value-dialog.type")}
            <select
              value={kind}
              aria-label={t("area.access-hub.access-value-dialog.accessTypeLabel")}
              onChange={(event) => setKind(event.target.value as AccessKind)}
              className="h-8 rounded-md border border-border bg-background px-2 text-sm text-foreground"
            >
              {ACCESS_KIND_ORDER.map((option) => (
                <option key={option} value={option}>
                  {accessKindLabel(t, option)}
                </option>
              ))}
            </select>
          </label>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">
          <Trans
            i18nKey="area.access-hub.access-value-dialog.newValueFor"
            values={{ name: record?.name ?? "", key: record?.key ?? "" }}
            components={[<span key="name" className="font-medium text-foreground" />, <span key="key" className="font-mono text-xs" />]}
          />
        </p>
      )}

      <label className="flex flex-col gap-1 text-sm">
        {t("area.access-hub.access-value-dialog.value")}
        <Input
          type="password"
          autoComplete="new-password"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label={t("area.access-hub.access-value-dialog.secretValueLabel")}
          data-testid="access-hub-value-input"
        />
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
          {creating ? t("area.access-hub.access-value-dialog.createAccess") : t("area.access-hub.access-value-dialog.saveValue")}
        </Button>
      </DialogFooter>
    </form>
  );
}

export interface AccessValueDialogProps extends AccessValueDialogBodyProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AccessValueDialog({ open, onOpenChange, ...body }: AccessValueDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{body.mode === "create" ? t("area.access-hub.access-value-dialog.titleCreate") : t("area.access-hub.access-value-dialog.titleSetValue")}</DialogTitle>
          <DialogDescription>
            {t("area.access-hub.access-value-dialog.description")}
          </DialogDescription>
        </DialogHeader>
        <AccessValueDialogBody {...body} />
      </DialogContent>
    </Dialog>
  );
}