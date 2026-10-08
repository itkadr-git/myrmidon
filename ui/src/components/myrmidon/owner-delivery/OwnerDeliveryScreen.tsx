// myrmidon(1.6.5-OWNER-DM-FILTER): view tier of the "Owner Telegram delivery"
// settings screen — layout and the local draft only. The react-query wiring
// (the settings GET and the PATCH) lives in OwnerDeliveryScreenContainer.tsx so
// both tiers are testable separately, the split the WIP limit screen uses.
import { useState } from "react";
import { Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RadioCardGroup } from "@/components/ui/radio-card";
import { OWNER_DELIVERY_MODE_OPTIONS, ownerDeliveryModeTitle } from "./ownerDeliveryConfig";
import {
  OWNER_DELIVERY_DEFAULT_MODE,
  isOwnerDeliveryMode,
  type OwnerDeliveryMode,
  type OwnerDeliverySettings,
} from "./ownerDeliveryApi";

export function OwnerDeliveryScreenView({
  settings,
  onSave,
  pending,
  error,
}: {
  settings: OwnerDeliverySettings | null | undefined;
  onSave: (settings: OwnerDeliverySettings) => void;
  pending: boolean;
  error: string | null;
}) {
  const [draft, setDraft] = useState<OwnerDeliveryMode | null>(null);
  const stored = settings?.mode;
  const selected = draft ?? stored ?? OWNER_DELIVERY_DEFAULT_MODE;

  return (
    <section className="space-y-4" data-testid="myrmidon-owner-delivery">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Owner Telegram delivery</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Which cards a task owner receives in their Telegram direct messages. Saving applies to the
          whole instance at once.
        </p>
      </div>

      {error ? (
        <div
          className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          data-testid="myrmidon-owner-delivery-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}

      {settings ? (
        <>
          <RadioCardGroup
            ariaLabel="Owner Telegram delivery mode"
            value={selected}
            onValueChange={(value) => {
              if (isOwnerDeliveryMode(value)) setDraft(value);
            }}
            options={OWNER_DELIVERY_MODE_OPTIONS.map((option) => ({
              value: option.value,
              title: option.title,
              description: option.description,
            }))}
          />

          <p className="text-xs text-muted-foreground" data-testid="myrmidon-owner-delivery-current">
            Current mode: {ownerDeliveryModeTitle(stored ?? OWNER_DELIVERY_DEFAULT_MODE)}
          </p>

          <div>
            <Button
              type="button"
              size="sm"
              data-testid="myrmidon-owner-delivery-save"
              disabled={pending}
              onClick={() => onSave({ mode: selected })}
            >
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="myrmidon-owner-delivery-loading">
          Loading settings…
        </p>
      )}
    </section>
  );
}