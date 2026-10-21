// Owner active channel (myrmidon 1.7-ACTIVE-CHANNEL): reports and plan answers
// go to the channel the owner is actually using — the portal or Telegram. The
// threshold says how long a channel stays "active" after the owner's last
// touch. Saving applies at the next delivery decision — no server restart.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Radio } from "lucide-react";
import {
  MAX_OWNER_ACTIVE_THRESHOLD_MIN,
  MIN_OWNER_ACTIVE_THRESHOLD_MIN,
  type OwnerActiveChannelPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/i18n";
import { Input } from "@/components/ui/input";
import {
  ownerActiveChannelSettingsApi,
  ownerActiveChannelQueryKey,
} from "./ownerActiveChannelApi";

export function OwnerActiveChannelSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: Awaited<ReturnType<typeof ownerActiveChannelSettingsApi.get>> | null | undefined;
  onSave: (patch: OwnerActiveChannelPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  const [thresholdDraft, setThresholdDraft] = useState<string | null>(null);

  const thresholdText = thresholdDraft ?? String(view?.thresholdMin ?? "");
  const parsedThreshold = /^\d+$/.test(thresholdText.trim()) ? Number(thresholdText.trim()) : null;
  const thresholdValid =
    parsedThreshold !== null &&
    parsedThreshold >= MIN_OWNER_ACTIVE_THRESHOLD_MIN &&
    parsedThreshold <= MAX_OWNER_ACTIVE_THRESHOLD_MIN;
  const thresholdDirty = view != null && thresholdDraft !== null && parsedThreshold !== view.thresholdMin;

  const channelLabel =
    view?.channel === "telegram"
      ? t("ownerActiveChannel.channelTelegram")
      : view?.channel === "web"
        ? t("ownerActiveChannel.channelWeb")
        : t("ownerActiveChannel.channelNone");

  return (
    <section className="space-y-4" data-testid="myrmidon-owner-active-channel">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("ownerActiveChannel.title")}</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{t("ownerActiveChannel.description")}</p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-3">
          <div className="text-sm" data-testid="owner-active-channel-current">
            {t("ownerActiveChannel.currentLabel")}{" "}
            <span className="font-medium">{channelLabel}</span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm" htmlFor="owner-active-channel-threshold">
              {t("ownerActiveChannel.thresholdLabel")}
            </label>
            <Input
              id="owner-active-channel-threshold"
              data-testid="owner-active-channel-threshold"
              className="w-24"
              inputMode="numeric"
              value={thresholdText}
              disabled={view.thresholdSource === "env"}
              aria-invalid={!thresholdValid}
              onChange={(event) => setThresholdDraft(event.target.value)}
            />
            <span className="text-xs text-muted-foreground" data-testid="owner-active-channel-threshold-source">
              {view.thresholdSource === "settings"
                ? t("ownerActiveChannel.sourceSettings")
                : view.thresholdSource === "env"
                  ? t("ownerActiveChannel.sourceEnv")
                  : t("ownerActiveChannel.sourceDefault")}{" "}
              (
              {t("ownerActiveChannel.thresholdBounds", {
                min: MIN_OWNER_ACTIVE_THRESHOLD_MIN,
                max: MAX_OWNER_ACTIVE_THRESHOLD_MIN,
              })}
              )
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            disabled={pending || !thresholdDirty || !thresholdValid}
            onClick={() => {
              if (parsedThreshold !== null) onSave({ thresholdMin: parsedThreshold });
            }}
          >
            {pending ? t("ownerActiveChannel.saving") : t("ownerActiveChannel.save")}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("ownerActiveChannel.loading")}</p>
      )}
    </section>
  );
}

export function OwnerActiveChannelSettingsPanel() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ownerActiveChannelQueryKey,
    queryFn: () => ownerActiveChannelSettingsApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: ownerActiveChannelSettingsApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : t("ownerActiveChannel.saveFailed")),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ownerActiveChannelQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : t("ownerActiveChannel.loadFailed")}
      </div>
    );
  }

  return (
    <OwnerActiveChannelSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
