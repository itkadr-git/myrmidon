// Live progress steps in the bridged Telegram DM (myrmidon DM-PROGRESS): while
// a bot works, its one status message in the DM shows what it is doing now and
// is edited in place. Saving applies at the next status sweep — no restart.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessageSquareMore } from "lucide-react";
import {
  TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC,
  TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC,
  type TelegramDmProgressPatch,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  describeTelegramDmProgressSource,
  telegramDmProgressApi,
  telegramDmProgressQueryKey,
  type TelegramDmProgressView,
} from "./telegramDmProgressApi";

export function TelegramDmProgressSettingsPanelView({
  view,
  onSave,
  pending,
  error,
}: {
  view: TelegramDmProgressView | null | undefined;
  onSave: (patch: TelegramDmProgressPatch) => void;
  pending: boolean;
  error: string | null;
}) {
  const [enabledDraft, setEnabledDraft] = useState<boolean | null>(null);
  const [intervalDraft, setIntervalDraft] = useState<string | null>(null);

  const enabled = enabledDraft ?? view?.enabled ?? false;
  const intervalText = intervalDraft ?? String(view?.intervalSec ?? "");
  const parsedInterval = /^\d+$/.test(intervalText.trim()) ? Number(intervalText.trim()) : null;
  const intervalValid =
    parsedInterval !== null &&
    parsedInterval >= TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC &&
    parsedInterval <= TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC;
  const enabledDirty = view != null && enabledDraft !== null && enabledDraft !== view.enabled;
  const intervalDirty = view != null && intervalDraft !== null && parsedInterval !== view.intervalSec;
  const dirty = enabledDirty || intervalDirty;

  const save = () => {
    const patch: TelegramDmProgressPatch = {};
    if (enabledDirty) patch.enabled = enabled;
    if (intervalDirty && parsedInterval !== null) patch.intervalSec = parsedInterval;
    onSave(patch);
  };

  return (
    <section className="space-y-4" data-testid="myrmidon-telegram-dm-progress">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <MessageSquareMore className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Telegram DM: live progress</h2>
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">
          While a bot works on a message in a bridged Telegram DM, one status message shows what it is doing now
          (reading a file, editing slides, checking the result) and is edited in place until the answer replaces it.
          Saving takes effect at the next status update — no server restart.
        </p>
      </div>

      {error ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      ) : null}

      {view ? (
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <ToggleSwitch
              checked={enabled}
              onCheckedChange={setEnabledDraft}
              aria-label="Show live progress in Telegram DM"
              data-testid="telegram-dm-progress-enabled"
              disabled={view.enabledSource === "env"}
            />
            <span className="text-sm">Show live progress steps</span>
            <span className="text-xs text-muted-foreground" data-testid="telegram-dm-progress-enabled-source">
              {describeTelegramDmProgressSource(view.enabledSource)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <label className="text-sm" htmlFor="telegram-dm-progress-interval">
              Minimum seconds between edits
            </label>
            <Input
              id="telegram-dm-progress-interval"
              data-testid="telegram-dm-progress-interval"
              className="w-24"
              inputMode="numeric"
              value={intervalText}
              disabled={view.intervalSource === "env"}
              aria-invalid={!intervalValid}
              onChange={(event) => setIntervalDraft(event.target.value)}
            />
            <span className="text-xs text-muted-foreground" data-testid="telegram-dm-progress-interval-source">
              {describeTelegramDmProgressSource(view.intervalSource)} ({TELEGRAM_DM_PROGRESS_MIN_INTERVAL_SEC}–
              {TELEGRAM_DM_PROGRESS_MAX_INTERVAL_SEC})
            </span>
          </div>
          <Button type="button" size="sm" disabled={pending || !dirty || !intervalValid} onClick={save}>
            {pending ? "Saving..." : "Save live progress"}
          </Button>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">Loading the live progress settings...</p>
      )}
    </section>
  );
}

export function TelegramDmProgressSettingsPanel() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const query = useQuery({
    queryKey: telegramDmProgressQueryKey,
    queryFn: () => telegramDmProgressApi.get(),
    retry: false,
  });
  const save = useMutation({
    mutationFn: telegramDmProgressApi.update,
    onMutate: () => setError(null),
    onError: (err) => setError(err instanceof Error ? err.message : "Saving the live progress settings failed."),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: telegramDmProgressQueryKey });
    },
  });

  if (query.error) {
    return (
      <div className="text-sm text-destructive">
        {query.error instanceof Error ? query.error.message : "Failed to load the live progress settings."}
      </div>
    );
  }

  return (
    <TelegramDmProgressSettingsPanelView
      view={query.data}
      onSave={(patch) => save.mutate(patch)}
      pending={save.isPending}
      error={error}
    />
  );
}
